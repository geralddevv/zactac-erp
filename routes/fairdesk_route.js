import { editLocationRows } from "../utils/userLocations.js";
import { verificationUpdate } from "../utils/verification.js";
import express, { json } from "express";
import crypto from "crypto";
import multer from "multer";
import path from "path";
import mongoose from "mongoose";
// import asyncHandler from "express-async-handler";
import Client from "../models/users/client.js";
import Username from "../models/users/username.js";
import Vendor from "../models/users/vendor.js";
import VendorUser from "../models/users/vendorUser.js";
import Employee from "../models/hr/employee_model.js";
import Label from "../models/inventory/labels.js";
import Tape from "../models/inventory/tape.js";
import TapeBinding from "../models/inventory/tapeBinding.js";
import LabelStockBinding from "../models/sachiko/labelStockBinding.js";
import SachikoLabelStock from "../models/sachiko/sachikoLabelStock.js";
import TapeSalesOrder from "../models/inventory/TapeSalesOrder.js";
import PurchaseOrder from "../models/inventory/PurchaseOrder.js";
import SystemId from "../models/system/systemId.js";
import Calculator from "../models/utilities/calculator.js";
import Task from "../models/miscellaneous/task_model.js";
import DaybookEntry from "../models/miscellaneous/daybook_model.js";
import Machine from "../models/system/machine.js";
import TapeStock from "../models/inventory/TapeStock.js";
import TapeStockLog from "../models/inventory/TapeStockLog.js";
import SalesOrderLog from "../models/inventory/SalesOrderLog.js";
import PurchaseOrderLog from "../models/inventory/PurchaseOrderLog.js";
import VendorTapeBinding from "../models/inventory/vendorTapeBinding.js";
import Location from "../models/system/location.js";
import Counter from "../models/system/counter.js";
import { generateVendorId, getNextVendorIdPreview } from "../utils/vendorId.js";
import AuditLog from "../models/system/auditLog.js";
import Sample from "../models/inventory/sample.js";
import PendingProduction from "../models/inventory/pendingProduction.js";
import MaterialStock from "../models/inventory/materialStock.js";
import MachineJobCard from "../models/inventory/machineJobCard.js";
import LotNoBaseline from "../models/system/lotNoBaseline.js";
import FacestockMaster from "../models/inventory/facestockMaster.js";
import AdhesiveMaster from "../models/inventory/adhesiveMaster.js";
import ReleaseMaster from "../models/inventory/releaseMaster.js";
import CoreMaster from "../models/inventory/coreMaster.js";
import FacestockStock from "../models/inventory/facestockStock.js";
import AdhesiveStock from "../models/inventory/adhesiveStock.js";
import ReleaseLinerStock from "../models/inventory/releaseLinerStock.js";
import CoreStock from "../models/inventory/coreStock.js";
import { escapeRegex } from "../utils/security.js";
import { getUserLocationNames, normalizeLocationName } from "../utils/locations.js";
import { generateMaterialRollId } from "../utils/materialRollId.js";
import { financialYearLabel, financialYearLetter, deckleBaseCode } from "../utils/rollId.js";
import {
  reconcileUserBindingLocations,
  syncLabelBindingIdentity,
} from "../utils/reconcileBindingLocations.js";
import { upsertPendingProduction, removePendingProduction, advanceShareByBatch } from "../utils/pendingProduction.js";
// "Is an operator running this right now" -- the same freshness rule the
// operator app itself applies to PendingProduction.runningOn.
import { activeClaim, JOB_CLAIM_STALE_MS } from "./api/operatorApi.js";
import { produceDeckle, dissolveDeckle, requiredLayersFor, trackAllottedCombinations, suggestDeckleSize, DECKLE_EDGE_TRIM_MM, LAYER_META, POOL_MODELS, pickStockIds } from "../utils/labelStockProduction.js";
import { CUT_SLOTS, cutsSignature } from "./system/slitting.js";
import SlittingJobCard from "../models/inventory/slittingJobCard.js";
import {
  planDeckleLayouts,
  isDeckleAutoEnabled,
  DEFAULT_DECKLE_RUNNING_METERS,
  OVERRUN_DEFAULTS,
} from "../utils/deckleOptimizer/index.js";
import { requireAuth } from "../middleware/auth.js";
import { createLimiter, updateLimiter, deleteLimiter } from "../utils/limiters.js";
import { notify } from "../utils/notify.js";
import { sessionEmployeeId, sessionDisplayName } from "../utils/sessionUser.js";
import { notifyOperatorQueue } from "../utils/operatorEvents.js";
import { computeRawMaterialNeed } from "../utils/rawMaterialNeed.js";
import { deckleTotalRunningMetres, deckleRunningMetersText } from "../utils/deckleTotals.js";
import { buildRunPlan } from "../utils/productionEta.js";

const router = express.Router();

function hashSignature(rawSignature) {
  return `sha256:${crypto.createHash("sha256").update(String(rawSignature ?? "")).digest("hex")}`;
}

function duplicateMasterMessage(item, productId) {
  return `${item} already exist with id: ${productId || "unknown"}`;
}

// Pending value = remaining (undispatched) balance * order rate, summed over
// PENDING + CONFIRMED orders (an order can be partially dispatched while
// staying CONFIRMED). Shared by the sales-pending header totals across the
// Tape/TTR, Plain Label, and Color Label pending pages.
function remainingOrderValuePipeline(extraMatch = {}, statuses = ["PENDING", "CONFIRMED"]) {
  return [
    { $match: { status: { $in: statuses }, ...extraMatch } },
    {
      $project: {
        balance: { $max: [{ $subtract: ["$quantity", { $ifNull: ["$dispatchedQuantity", 0] }] }, 0] },
        orderRate: { $ifNull: ["$orderRate", 0] },
      },
    },
    { $group: { _id: null, total: { $sum: { $multiply: ["$balance", "$orderRate"] } } } },
  ];
}

function canonicalizeLocationName(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ")
    .replace(/^[.,]+|[.,]+$/g, "");
}

function toNumber(value) {
  return Number(value || 0);
}

function buildSalesOrderSignature({
  itemType,
  itemId,
  userId,
  quantity,
  estimatedDate,
  poNumber,
  sourceLocation,
  orderRate,
  createdBy,
  lineIndex,
}) {
  return hashSignature(
    [
      itemType || "",
      itemId || "",
      userId || "",
      String(quantity ?? ""),
      String(estimatedDate || ""),
      canonicalizeLocationName(sourceLocation || ""),
      String(poNumber || "").trim(),
      String(orderRate ?? ""),
      String(createdBy || ""),
      // Distinguishes two lines of the same multi-item PO that are otherwise
      // spec-identical (same product, qty, rate, location) -- without it the
      // unique orderSignature index would drop the second as a duplicate.
      // Omitted (empty) for plain single-item orders so their signatures are
      // unchanged.
      lineIndex == null ? "" : `L${lineIndex}`,
    ].join("|"),
  );
}

// Same duplicate-prevention scheme as routes/sachiko/labelStockBinding.js'
// buildBindingSignature -- reproduced here since a Label Stock order for a
// product with no existing binding auto-creates one (see the LABEL_STOCK
// branch of POST /sales/order) and must land on the identical signature a
// manually-created binding for the same labelStock+user+paperSize+RM would,
// so it's found instead of duplicated on a second such order.
function buildLabelStockBindingSignature({ labelStock, userId, paperSize, runningMeters }) {
  return hashSignature(
    [
      String(labelStock || ""),
      String(userId || ""),
      String(paperSize || "").trim().toUpperCase().replace(/\s+/g, " "),
      String(Number(runningMeters ?? "")),
    ].join("||"),
  );
}

// Resolves the LabelStockBinding for labelStock+userId+paperSize+runningMeters,
// reusing one whose bindingSignature already matches, otherwise creating it
// from what the order form collected for Rate/Location -- the same inputs a
// manually-created binding would need (see POST /form/label-stock-binding in
// routes/sachiko/labelStockBinding.js). Used by the LABEL_STOCK branch of
// POST /sales/order both when the picked product has no binding at all yet,
// and when an existing binding was picked but the order's own Paper Size/
// Running Meters don't match it -- the same labelStock+client pair can have
// several bindings, one per paperSize+RM combo (that's the whole point of
// bindingSignature excluding nothing but location), so a mismatch there
// means a *different* binding is being asked for, not an edit of the one
// that was picked.
async function resolveLabelStockBinding({ labelStock, userId, paperSize, runningMeters, itemRate, sourceLocation, locationRadio, userLocation }) {
  const bindingRate = Number(itemRate);
  if (!Number.isFinite(bindingRate) || bindingRate <= 0) {
    return { error: "Rate is required to bind this product to the client." };
  }
  const bindingLocation = canonicalizeLocationName(sourceLocation || locationRadio || userLocation);
  if (!bindingLocation || bindingLocation === "ALL") {
    return { error: "Select a location for this product." };
  }

  const bindingSignature = buildLabelStockBindingSignature({ labelStock, userId, paperSize, runningMeters });
  let binding = await LabelStockBinding.findOne({ bindingSignature });
  if (!binding) {
    binding = await LabelStockBinding.create({
      labelStock,
      userId,
      location: bindingLocation,
      paperSize,
      runningMeters: Number(runningMeters),
      rate: bindingRate,
      bindingSignature,
    });
    // Same linkage step the manual Label Stock Binding form does -- without
    // it the binding exists but is invisible on /label-stock-binding/view/:id
    // and to /sales/items, which both resolve a user's bindings via
    // Username.labelStock rather than by querying LabelStockBinding directly.
    await Username.updateOne({ _id: userId }, { $addToSet: { labelStock: binding._id } });
  }
  return { binding };
}

// Resolves (or auto-creates) the LabelStockBinding for ONE line of a
// multi-item Label Stock PO -- same rules as the single-item LABEL_STOCK
// branch of POST /sales/order, factored out so the multi-item loop can
// validate every line up front and create nothing if any line is bad.
// Shared Paper Size / RM bounds for a Label Stock order line.
function validateLabelStockDims(paperSize, runningMeters) {
  const ps = Number(paperSize);
  if (!(ps > 0) || ps >= 1000) return "Paper Size must be a number less than 1000.";
  if (Number(runningMeters) > 2000) return "RM cannot exceed 2000.";
  return null;
}

async function resolveLabelStockLineBinding({ line, userId, sourceLocation, locationRadio, userLocation }) {
  const paperSize = String(line.paperSize || "").trim();
  const runningMeters = line.runningMeters;
  const noOfRolls = line.noOfRolls;
  const itemRate = line.itemRate;

  if (!paperSize || !(Number(runningMeters) > 0) || !(Number(noOfRolls) > 0)) {
    return { error: "Every item needs a Paper Size, and RM / No of Rolls greater than zero." };
  }
  const dimErr = validateLabelStockDims(paperSize, runningMeters);
  if (dimErr) return { error: dimErr };

  let binding = line.itemId ? await LabelStockBinding.findById(line.itemId) : null;
  const bindingMatchesOrder =
    binding &&
    String(binding.paperSize || "").trim() === paperSize &&
    Number(binding.runningMeters) === Number(runningMeters);

  if (!binding || !bindingMatchesOrder) {
    let masterId;
    if (binding) {
      masterId = String(binding.labelStock);
    } else {
      masterId = String(line.labelStockMasterId || "").trim();
      if (!masterId) return { error: "Select a Product Code for every item." };
      const master = await SachikoLabelStock.findById(masterId).select("_id").lean();
      if (!master) return { error: "Invalid product selected." };
    }

    const resolvedBinding = await resolveLabelStockBinding({
      labelStock: masterId,
      userId,
      paperSize,
      runningMeters,
      itemRate,
      sourceLocation,
      locationRadio,
      userLocation,
    });
    if (resolvedBinding.error) return { error: resolvedBinding.error };
    binding = resolvedBinding.binding;
  }

  if (binding.status === "INACTIVE") {
    return { error: "One of the selected products is disabled for this client and cannot be ordered." };
  }

  return { binding, paperSize, runningMeters, noOfRolls, itemRate };
}

// Creates the TapeSalesOrder lines of one multi-item Label Stock PO: every
// line becomes its own order document (one product = one production unit
// downstream), all sharing this PO's header fields and a common poGroupId.
//
// Shared by the Sales Order form's multi-item branch and by the paper
// re-order import on the Pending Orders page -- an imported PO is the same
// PO, just typed by FAIRTECH's export instead of by hand, and it must land on
// exactly the same bindings, signatures and PendingProduction rows.
//
// Every line is resolved up front and nothing is created if any of them is
// bad, so a rejected PO leaves no half-entered orders behind.
async function createLabelStockPoLines({
  poLines,
  userId,
  poNumber,
  poDate,
  estimatedDate,
  remarks,
  deckleOption,
  sourceLocation,
  locationRadio,
  userLocation,
  createdByUser,
  submissionToken,
}) {
  const poNo = String(poNumber || "").trim();
  if (!userId) return { error: "Select a client and user." };
  if (!poNo) return { error: "PO Number is required." };
  if (!estimatedDate) return { error: "Est Delivery Date is required." };

  // 1. Resolve every line's binding first -- fail the whole submit (create
  //    nothing) if any line is invalid.
  const resolvedLines = [];
  for (const line of poLines) {
    const resolved = await resolveLabelStockLineBinding({
      line,
      userId,
      sourceLocation,
      locationRadio,
      userLocation,
    });
    if (resolved.error) return { error: resolved.error };
    resolvedLines.push(resolved);
  }

  // 2. Rate write-back -- once per distinct binding (a later manual edit
  //    via the binding form works the same way).
  const rateApplied = new Set();
  for (const r of resolvedLines) {
    const key = String(r.binding._id);
    const submitted = Number(r.itemRate);
    if (
      !rateApplied.has(key) &&
      Number.isFinite(submitted) &&
      submitted > 0 &&
      submitted !== Number(r.binding.rate)
    ) {
      r.binding.rate = submitted;
      await r.binding.save();
    }
    rateApplied.add(key);
  }

  // 3. One order + PendingProduction + CREATED log per line.
  const poGroupId = new mongoose.Types.ObjectId();
  const token = String(submissionToken || "").trim();
  const createdOrders = [];
  for (let i = 0; i < resolvedLines.length; i++) {
    const { binding, paperSize: lPaperSize, runningMeters: lRunningMeters, noOfRolls: lNoOfRolls } = resolvedLines[i];
    const qty = Number(lNoOfRolls);
    const rate = Number(binding.rate) || 0;
    const lineSourceLocation = canonicalizeLocationName(binding.location);

    const data = {
      tapeBinding: binding._id,
      userId: binding.userId,
      tapeId: binding.labelStock,
      sourceLocation: lineSourceLocation,
      poDate: poDate ? new Date(poDate) : undefined,
      poNumber: poNo,
      poGroupId,
      deckleOption,
      orderRate: rate,
      quantity: qty,
      estimatedDate: new Date(estimatedDate),
      remarks,
      paperSize: lPaperSize,
      runningMeters: Number(lRunningMeters),
      noOfRolls: qty,
      status: "PENDING",
      onModel: "SachikoLabelStock",
      onBindingModel: "LabelStockBinding",
      createdBy: createdByUser,
      orderSignature: buildSalesOrderSignature({
        itemType: "LABEL_STOCK",
        itemId: String(binding._id),
        userId: binding.userId,
        quantity: qty,
        estimatedDate,
        poNumber: poNo,
        sourceLocation: lineSourceLocation,
        orderRate: rate,
        createdBy: createdByUser,
        lineIndex: i,
      }),
      submissionToken: token ? `${token}-${i}` : undefined,
    };

    const dup = await TapeSalesOrder.findOne({ orderSignature: data.orderSignature }).select("_id").lean();
    if (dup) continue;

    let newOrder;
    try {
      newOrder = await TapeSalesOrder.create(data);
    } catch (e) {
      // Re-submit of the same form (same suffixed token / signature) -- the
      // line already exists, skip it rather than failing the PO.
      if (e?.code === 11000) continue;
      throw e;
    }

    await upsertPendingProduction(newOrder);
    await SalesOrderLog.create({
      orderId: newOrder._id,
      action: "CREATED",
      quantity: qty,
      performedBy: createdByUser,
    });
    createdOrders.push(newOrder);
  }

  return {
    createdOrders,
    poNumber: poNo,
    totalQty: createdOrders.reduce((sum, o) => sum + (o.quantity || 0), 0),
  };
}

function isTemplateOnlyInvoice(invoiceNumber) {
  const value = String(invoiceNumber || "").trim();
  if (!value) return true;
  return /^TECH\|IN\|\d{2}-\d{2}\|[A-Z_]+\|$/i.test(value);
}

router.use((req, res, next) => {
  const authUser = req.session?.authUser;
  const role = String(authUser?.role || "").toLowerCase();
  const permissions = authUser?.permissions || {};
  const hasSalesAccess = role === "sales" || Boolean(permissions.sales);
  const hasHrAccess = role === "hr" || Boolean(permissions.hr);

  if (!role) return res.redirect("/app/login");

  if (role === "proprietor" || role === "admin" || role === "hod") return next();

  if (req.path === "/api/motivational") return next();

  // Company Tasks is open to every role that reaches this router (sales, hr —
  // not gated behind the narrower per-role allowlists below).
  if (req.path === "/tasks" || req.path.startsWith("/tasks/") || req.path.startsWith("/api/tasks/")) return next();

  // Daybook is a personal view onto the same Tasks data, so it gets the same
  // open access as Tasks above.
  if (req.path === "/daybook" || req.path.startsWith("/daybook/") || req.path.startsWith("/api/daybook/")) return next();

  if (hasSalesAccess) {
    const path = req.path || "";

    if (path.startsWith("/sales/")) return next();
    if (path === "/stocks/view" || path === "/pettycash/view" || path === "/pettycash/create") return next();

    // Explicitly allowed GET routes for Sales
    const allowedGetRoutes = [
      "/welcome",
      "/master/view",
      "/client/view",
      "/form/client",
      "/stocks/view",
      "/pettycash/view",
      "/labels/view",
    ];

    const allowedGetPatterns = [
      /^\/form\/client\/[^/]+$/,
      /^\/client\/details\/[^/]+$/,
      /^\/api\/motivational$/,
      /^\/form\/labels\/.*$/,
      /^\/api\/locations$/,
      /^\/labels\/profile\/[^/]+$/,
      /^\/labels\/file\/[^/]+\/[^/]+$/,
      /^\/labels\/view\/[^/]+$/,
      /^\/labels\/edit\/[^/]+$/,
    ];

    const allowedPostRoutes = [
      /^\/form\/client$/,
      /^\/form\/user$/,
      /^\/pettycash\/create$/,
      /^\/labels\/edit\/[^/]+$/,
    ];

    if (req.method === "GET") {
      const normalizedPath = path.toLowerCase().replace(/\/$/, "");

      // Explicit keyword matches for resilience
      const keywords = ["master/view", "compare", "binding", "welcome", "api/motivational", "client", "vendor", "user", "stocks", "pettycash"];
      if (keywords.some(k => normalizedPath.includes(k))) return next();

      if (allowedGetRoutes.includes(normalizedPath) || allowedGetPatterns.some((re) => re.test(path))) {
        return next();
      }
    }

    if (req.method === "POST" && (path.includes("binding") || path.includes("user") || allowedPostRoutes.some((re) => re.test(path)))) {
      return next();
    }

    return res.status(403).send(`Forbidden (FR-Sales): ${path} | Role: ${role}`);
  }

  if (hasHrAccess) {
    const path = req.path || "";
    if (path === "/welcome" || path === "/api/motivational") return next();
    return res.status(403).send(`Forbidden (FR-HR): ${path} | Role: ${role}`);
  }

  return res.status(403).send(`Forbidden (FR-Final): ${req.path} | Role: ${role}`);
});

router.get("/form/ratecalculator", async (req, res) => {
  let clients = await Username.distinct("clientName");
  res.render("utilities/rateCalculator.ejs", {
    clients,
    title: "Rate Calculator",
    JS: "rateCalculator.js",
    CSS: false,
    notification: req.flash("notification"),
  });
});

// Route to handle rate calculator form submission
router.post("/form/ratecalculator", requireAuth, createLimiter, async (req, res) => {
  try {
    await Calculator.create(req.body);
    res.send("Order created successfully!");
  } catch (err) {
    console.error("RATE CALCULATOR CREATE ERROR:", err);
    res.status(400).send("Failed to save: " + err.message);
  }
});

// ----------------------------------Client---------------------------------->
// route for client form.
// The standalone Create Client / Create User page is now two dialogs: New
// Client on /client/view (views/users/_clientDialog.ejs) and New User on
// /master/view (views/users/_userDialog.ejs). Old links and bookmarks land here
// and are forwarded, opening the right dialog.
router.get("/form/client", (req, res) => {
  const params = new URLSearchParams();
  const isUser = req.query.tab === "user";
  params.set("new", isUser ? "user" : "client");
  if (isUser && req.query.clientName) params.set("clientName", String(req.query.clientName));
  res.redirect(`${isUser ? "/app/master/view" : "/app/client/view"}?${params.toString()}`);
});

function normalizeClientPart(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function duplicateClientMessage(clientId) {
  return `client already exist: "${clientId || "unknown"}"`;
}

function duplicateUserMessage(userName, clientName) {
  return `"${userName || "unknown"}" already exist for this "${clientName || "unknown"}"`;
}

function buildClientSignature(source) {
  return [
    normalizeClientPart(source.clientName),
    normalizeClientPart(source.clientType),
    normalizeClientPart(source.clientStatus),
    normalizeClientPart(source.hoLocation),
    normalizeClientPart(source.accountHead),
    normalizeClientPart(source.clientGst),
    normalizeClientPart(source.clientMsme),
    normalizeClientPart(source.clientGumasta),
    normalizeClientPart(source.clientPan),
  ].join("||");
}

function normalizeUserPart(value) {
  return String(value ?? "").trim();
}

function normalizeUserName(value) {
  return normalizeUserPart(value).toUpperCase();
}

function normalizeUserEmail(value) {
  return normalizeUserPart(value).toLowerCase();
}

function normalizeUserContact(value) {
  return normalizeUserPart(value).replace(/\D/g, "");
}

function normalizeLocationDetails(rawLocationDetails, fallbackLocation, fallbackAddress) {
  const source = Array.isArray(rawLocationDetails)
    ? rawLocationDetails
    : rawLocationDetails && typeof rawLocationDetails === "object"
      ? Object.values(rawLocationDetails)
      : [];

  const locations = source
    .map((entry) => {
      // Normalized the same way as item bindings (utils/locations.js), so a
      // stray trailing comma/dot (e.g. pasted from "Tarapur, Maharashtra")
      // can't desync a client's location from their bindings' location field
      // — see the /master/view and /labels/view "binding not showing" bug.
      const userLocation = normalizeLocationName(entry?.userLocation ?? entry?.location);
      const dispatchAddress = String(entry?.dispatchAddress ?? entry?.address ?? "").trim().toUpperCase();

      if (!userLocation && !dispatchAddress) return null;

      const out = { userLocation, dispatchAddress };

      // Per-location dispatch details — only stored when they carry a value.
      // A self-dispatch entry keeps just selfDispatch; transport fields are
      // omitted. For transport entries, empty fields are dropped too.
      if (String(entry?.selfDispatch ?? "").trim()) {
        out.selfDispatch = "Self Dispatch";
      } else {
        const set = (key, value) => { if (value) out[key] = value; };
        set("transportName", String(entry?.transportName ?? "").trim().toUpperCase());
        set("transportContact", String(entry?.transportContact ?? "").trim());
        set("dropLocation", String(entry?.dropLocation ?? "").trim().toUpperCase());
        set("dropLocation1", String(entry?.dropLocation1 ?? "").trim().toUpperCase());
        set("deliveryMode", String(entry?.deliveryMode ?? "").trim());
        set("deliveryLocation", String(entry?.deliveryLocation ?? "").trim().toUpperCase());
        set("deliveryLocation1", String(entry?.deliveryLocation1 ?? "").trim().toUpperCase());
        set("clientPayment", String(entry?.clientPayment ?? "").trim());
        set("vendorPayment", String(entry?.vendorPayment ?? "").trim());
      }

      return out;
    })
    .filter(Boolean);

  if (!locations.length) {
    const userLocation = normalizeLocationName(fallbackLocation);
    const dispatchAddress = String(fallbackAddress || "").trim().toUpperCase();
    if (userLocation || dispatchAddress) {
      locations.push({ userLocation, dispatchAddress });
    }
  }

  return locations;
}

function buildUserSignature(source, userId) {
  return [
    normalizeClientPart(userId),
    normalizeUserName(source.userName),
    normalizeUserEmail(source.userEmail),
    normalizeUserContact(source.userContact),
  ].join("||");
}

// Route to handle CLIENT form submission
router.post("/form/client", requireAuth, createLimiter, async (req, res) => {
  try {
    const generateClientId = async () => {
      const maxAttempts = 10000;
      for (let i = 0; i < maxAttempts; i++) {
        const counter = await Counter.findOneAndUpdate(
          { key: "clientId" },
          { $inc: { seq: 1 } },
          { new: true, upsert: true, setDefaultsOnInsert: true },
        ).lean();

        const candidateId = `FS | CLIENT | ${counter.seq}`;
        const exists = await Client.exists({ clientId: candidateId });
        if (!exists) return candidateId;
      }
      throw new Error("Unable to generate unique client id");
    };

    const clientName = String(req.body.clientName || "").trim();
    const clientType = String(req.body.clientType || "").trim();
    const clientStatus = String(req.body.clientStatus || "").trim();
    const hoLocation = String(req.body.hoLocation || "").trim();
    const accountHead = String(req.body.accountHead || "").trim();
    // "Unregistered" checkbox: no real GST/PAN to validate or store -- the
    // sentinel satisfies the model's required fields without pretending to be
    // a real (format-checked) number.
    const isGstUnregistered = req.body.gstUnregistered === "true" || req.body.gstUnregistered === true;
    const clientGst = isGstUnregistered ? "UNREGISTERED" : String(req.body.clientGst || "").trim().toUpperCase();
    const clientMsme = String(req.body.clientMsme || "").trim();
    const clientGumasta = String(req.body.clientGumasta || "").trim();
    const clientPan = isGstUnregistered ? "UNREGISTERED" : String(req.body.clientPan || "").trim().toUpperCase();
    const vendorCode = String(req.body.vendorCode || "").trim();
    const verticals = String(req.body.verticals || "").trim();

    // GST and PAN Validation
    const gstRegex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
    const panRegex = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;

    if (!isGstUnregistered) {
      if (clientGst && !gstRegex.test(clientGst)) {
        return res.status(400).json({ success: false, message: "Invalid GST number format" });
      }
      if (clientPan && !panRegex.test(clientPan)) {
        return res.status(400).json({ success: false, message: "Invalid PAN number format" });
      }
      if (clientGst && clientPan && clientGst.substring(2, 12) !== clientPan) {
        return res.status(400).json({ success: false, message: "PAN does not match GST number" });
      }
    }

    // Signed off the sanitized fields (not raw req.body) so an "Unregistered"
    // submission signs the sentinel actually being stored.
    const clientSignature = hashSignature(
      buildClientSignature({ clientName, clientType, clientStatus, hoLocation, accountHead, clientGst, clientMsme, clientGumasta, clientPan }),
    );

    // Prevent duplicates only when the full logical client entity matches.
    // clientId is auto-generated, so it is intentionally excluded from this match.
    const existingSameEntity = await Client.findOne({
      $or: [
        { clientSignature },
        {
          clientName: new RegExp(`^${escapeRegex(clientName)}$`, "i"),
          clientType: new RegExp(`^${escapeRegex(clientType)}$`, "i"),
          clientStatus: new RegExp(`^${escapeRegex(clientStatus)}$`, "i"),
          hoLocation: new RegExp(`^${escapeRegex(hoLocation)}$`, "i"),
          accountHead: new RegExp(`^${escapeRegex(accountHead)}$`, "i"),
          clientGst: new RegExp(`^${escapeRegex(clientGst)}$`, "i"),
          clientMsme: new RegExp(`^${escapeRegex(clientMsme)}$`, "i"),
          clientGumasta: new RegExp(`^${escapeRegex(clientGumasta)}$`, "i"),
          clientPan: new RegExp(`^${escapeRegex(clientPan)}$`, "i"),
        },
      ],
    })
      .select("clientId")
      .lean();

    if (existingSameEntity) {
      return res.status(400).json({
        success: false,
        message: duplicateClientMessage(existingSameEntity.clientId),
      });
    }

    const formData = {
      clientId: await generateClientId(),
      clientName,
      clientType,
      clientStatus,
      hoLocation,
      accountHead,
      clientGst,
      clientMsme,
      clientGumasta,
      clientPan,
      vendorCode,
      verticals,
      clientSignature,
      ...verificationUpdate(req).set,
    };

    await Client.create(formData);
    res.locals.auditDescription = `Created client "${clientName}"`;
    req.flash("notification", "Client created successfully!");
    res.json({ success: true, redirect: "/app/client/view" });
  } catch (err) {
    console.error(err);
    if (err?.code === 11000) {
      const existingClient = await Client.findOne({ clientSignature })
        .select("clientId")
        .lean();
      return res.status(409).json({
        success: false,
        message: duplicateClientMessage(existingClient?.clientId),
      });
    }
    res.status(400).json({ success: false, message: err.message });
  }
});

router.get("/form/client/:name", async (req, res) => {
  let clientData = await Client.findOne({ clientName: req.params.name });
  let clientName = clientData;
  res.status(200).json(clientName);
});

// ----------------------------------Username---------------------------------->
// Route to handle USER form submission
router.post("/form/user", requireAuth, createLimiter, async (req, res) => {
  try {
    const { objectId } = req.body;
    let client = null;
    if (objectId) {
      client = await Client.findOne({ _id: objectId });
    }
    if (!client) {
      const clientIdFallback = String(req.body.clientId || "").trim();
      const clientNameFallback = String(req.body.clientName || "").trim();
      if (clientIdFallback) {
        client = await Client.findOne({ clientId: clientIdFallback });
      }
      if (!client && clientNameFallback) {
        client = await Client.findOne({ clientName: new RegExp(`^${escapeRegex(clientNameFallback)}$`, "i") });
      }
    }
    if (!client) {
      return res.status(400).json({ success: false, message: "Invalid client selected" });
    }

    const clientId = String(client.clientId || "").trim();
    const userName = String(req.body.userName || "").trim();
    const userContact = String(req.body.userContact || "").trim();
    const userEmail = String(req.body.userEmail || "")
      .trim()
      .toLowerCase();
    const locationDetails = normalizeLocationDetails(
      req.body.locationDetails,
      req.body.userLocation,
      req.body.dispatchAddress,
    );

    if (!locationDetails.length) {
      return res.status(400).json({
        success: false,
        message: "Please add at least one location and address",
      });
    }

    const primaryLocation = locationDetails[0];
    const userSignature = hashSignature(buildUserSignature(req.body, clientId));

    // Prevent duplicates only on full identity tuple within the same client.
    const duplicateUser = await Username.findOne({
      $or: [
        { userSignature },
        {
          clientId,
          userName: new RegExp(`^${escapeRegex(userName)}$`, "i"),
          userEmail: new RegExp(`^${escapeRegex(userEmail)}$`, "i"),
          userContact: new RegExp(`^${escapeRegex(userContact)}$`, "i"),
        },
      ],
    })
      .select("userName clientName")
      .lean();

    if (duplicateUser) {
      return res.status(400).json({
        success: false,
        message: duplicateUserMessage(duplicateUser.userName, duplicateUser.clientName || client.clientName),
      });
    }

    const newUser = await Username.create({
      ...req.body,
      clientId,
      clientName: client.clientName,
      clientType: client.clientType,
      hoLocation: client.hoLocation,
      accountHead: client.accountHead,
      userLocation: primaryLocation.userLocation,
      dispatchAddress: primaryLocation.dispatchAddress,
      // Top-level dispatch fields mirror the primary (first) location so
      // existing consumers (sales orders, displays) keep working unchanged.
      SelfDispatch: primaryLocation.selfDispatch || "",
      transportName: primaryLocation.transportName || "",
      transportContact: primaryLocation.transportContact || "",
      dropLocation: primaryLocation.dropLocation || "",
      deliveryMode: primaryLocation.deliveryMode || "",
      deliveryLocation: primaryLocation.deliveryLocation || "",
      clientPayment: primaryLocation.clientPayment || "",
      locationsCount: locationDetails.length,
      locationDetails,
      userName,
      userContact,
      userEmail,
      userSignature,
      ...verificationUpdate(req).set,
    });

    client.users.push(newUser);
    await client.save();

    res.locals.auditDescription = `Created user "${userName}" under client "${client.clientName}"`;
    req.flash("notification", "User created successfully!");
    res.json({ success: true, redirect: "/app/master/view" });
  } catch (err) {
    console.error(err);
    if (err?.code === 11000) {
      const clientId = String(req.body.clientId || "").trim();
      const userName = String(req.body.userName || "").trim();
      const userEmail = String(req.body.userEmail || "")
        .trim()
        .toLowerCase();
      const userContact = String(req.body.userContact || "").trim();
      const fallbackUserSignature = hashSignature(buildUserSignature(req.body, clientId));
      const existingUser = await Username.findOne({
        $or: [
          { userSignature: fallbackUserSignature },
          {
            clientId,
            userName: new RegExp(`^${escapeRegex(userName)}$`, "i"),
            userEmail: new RegExp(`^${escapeRegex(userEmail)}$`, "i"),
            userContact: new RegExp(`^${escapeRegex(userContact)}$`, "i"),
          },
        ],
      })
        .select("userName clientName")
        .lean();
      return res.status(409).json({
        success: false,
        message: duplicateUserMessage(existingUser?.userName || userName, existingUser?.clientName),
      });
    }
    console.error("CREATE CLIENT USER ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to create user." });
  }
});

// ----------------------------------Company Tasks---------------------------------->

/* A task is work one person hands another: it carries an assignee, that person
   finds it under "Assigned to me", and the header bell tells them it arrived.
   So "whose task is this" has three answers, and the server decides each one
   — hiding a tab in the page is not a permission:

     mine      assignedTo = my Employee._id   (the default view)
     created   createdBy  = my empId code     (what this page used to show)
     all       every task                     (proprietor / admin / hod only)

   Ownership is still keyed on the individual, never on role. The dev backdoor
   logins (PROPRIETOR_USER etc.) have no employee record at all, so they have
   no empId and no Employee._id: they cannot be assigned work and cannot see
   anyone's bucket — which is what kept this data private before and still does.

   Who may change what (enforced in the PUT/DELETE handlers):
     creator    everything, delete included, and marking it done
     assignee   nothing — the work is theirs to do, not to sign off
     anyone else  nothing, and the task is answered as "not found"

   A TASK IS PRIVATE TO TWO PEOPLE: the person who set it and the person it
   was given to. Nobody else sees it, reads it or touches it — not another
   employee, and NOT an administrator either. Task text can be commercially or
   personally confidential, so there is deliberately no role, anywhere, that
   can read the whole collection through this app; an earlier revision gave
   proprietor/admin/hod exactly that and it has been removed.

   The rule is one function (taskVisibilityFilter) used by EVERY read, so there
   is a single place to audit. If an oversight view is ever genuinely needed,
   add it as its own route with its own audit trail rather than widening this
   filter -- and expect to tell people their tasks are readable. */
const TASK_STATUS_LABELS = { PENDING: "Pending", IN_PROGRESS: "In Progress", COMPLETED: "Completed" };

// The creator's own handle: their empId code. Unchanged — the Daybook keys its
// rows on the same string, so this stays the "created by me" identity.
function sessionOwnerKey(req) {
  return req.session?.authUser?.empId || null;
}

// Everything the current user is party to, and the ONLY set any task read in
// this file is allowed to draw on: tasks they created, plus tasks assigned to
// them. An assignee can put their own work in their Daybook; before
// assignment existed this was "created by me" alone.
function taskVisibilityFilter({ ownerKey, employeeId }) {
  const or = [];
  if (ownerKey) or.push({ createdBy: ownerKey });
  if (employeeId) or.push({ assignedTo: employeeId });
  // No identity at all (dev backdoor): match nothing rather than everything.
  if (!or.length) return { _id: null };
  return or.length === 1 ? or[0] : { $or: or };
}

// What the row's buttons are allowed to do. Sent to the page so it can hide
// what this user can't use; the POST/PUT/DELETE handlers check the same facts
// again, because the page is only a convenience.
function taskPermissions(task, { ownerKey, employeeId }) {
  const isCreator = Boolean(ownerKey) && String(task.createdBy || "") === String(ownerKey);
  const assigneeId = task.assignedTo?._id ?? task.assignedTo;
  const isAssignee = Boolean(employeeId) && String(assigneeId || "") === String(employeeId);
  return {
    isCreator,
    isAssignee,
    canEdit: isCreator,
    canDelete: isCreator,
    // Closing a task off is the business of whoever handed it out: if you
    // assigned work to somebody, you are the one who decides it is done, and
    // the assignee is given no Mark Complete / Reopen at all. Same test as
    // canEdit on purpose, kept as its own name because it gates its own
    // button -- so that if the two ever need to differ again, the place to
    // change is obvious.
    canSetStatus: isCreator,
  };
}

// "Others" resolution for the task Assigned Employee / Client fields.
async function resolveTaskAssignee(assignedToId, assignedToManualName) {
  if (assignedToId === "OTHERS") {
    const name = String(assignedToManualName || "").trim();
    if (!name) throw new Error("Please enter the employee name.");
    return { assignedTo: null, assignedToIsOthers: true, assignedToOthers: name, empName: name };
  }
  if (!assignedToId || !mongoose.isValidObjectId(assignedToId)) {
    throw new Error("Please select an employee to assign this task to.");
  }
  // The id has to exist — an assignee nobody can resolve is a task nobody
  // will ever see in their list.
  const employee = await Employee.findById(assignedToId).select("empName").lean();
  if (!employee) throw new Error("Selected employee was not found.");
  return { assignedTo: assignedToId, assignedToIsOthers: false, assignedToOthers: undefined, empName: employee.empName };
}

/* The optional "who is this reminder about" pick, used when a task is kept
   rather than sent. Same shape as resolveTaskAssignee, with two differences
   that matter: it is OPTIONAL (a reminder need not be about anybody), and it
   is display context only — nothing in this file reads aboutEmployee when
   deciding who may see a task or who gets notified, so recording somebody
   here can never hand them the task or ring their bell. */
async function resolveTaskAbout(aboutId, manualName) {
  const typed = String(manualName || "").trim();
  if (aboutId === "OTHERS") {
    if (!typed) throw new Error("Please enter the name this task is about.");
    return { aboutEmployee: null, aboutEmployeeName: typed };
  }
  if (!aboutId) return { aboutEmployee: null, aboutEmployeeName: "" };
  if (!mongoose.isValidObjectId(aboutId)) throw new Error("Invalid employee selected.");
  const employee = await Employee.findById(aboutId).select("empName").lean();
  if (!employee) throw new Error("Selected employee was not found.");
  return { aboutEmployee: aboutId, aboutEmployeeName: employee.empName };
}

// Who to tell when a task is completed. Tasks created before createdById
// existed carry only the creator's empId code, so fall back to resolving it —
// one lookup, and only for those older rows (scripts/backfill-task-assignee.js
// fills them in for good).
async function taskCreatorRecipientId(task) {
  if (task.createdById) return String(task.createdById);
  if (!task.createdBy) return null;
  const employee = await Employee.findOne({ empId: task.createdBy }).select("_id").lean();
  return employee ? String(employee._id) : null;
}

const TASK_LINK = (id) => `/app/tasks?open=${id}`;

async function resolveTaskClient(clientId, clientManualName) {
  if (!clientId) return { client: null, clientIsOthers: false, clientOthers: undefined };
  if (clientId === "OTHERS") {
    const name = String(clientManualName || "").trim();
    if (!name) throw new Error("Please enter the company / client name.");
    return { client: null, clientIsOthers: true, clientOthers: name };
  }
  if (!mongoose.isValidObjectId(clientId)) throw new Error("Invalid client selected.");
  const clientDoc = await Client.findById(clientId).select("_id").lean();
  if (!clientDoc) throw new Error("Selected client was not found.");
  return { client: clientId, clientIsOthers: false, clientOthers: undefined };
}

router.get("/tasks", async (req, res) => {
  const ownerKey = sessionOwnerKey(req);
  const employeeId = await sessionEmployeeId(req);

  // One list of everything this person is party to, and nothing else:
  // assigned to them or created by them. Which of the two a row is -- assigned
  // to me / created by me / both -- is a column the table sorts and filters
  // on, so a bell link (?open=<taskId>) always lands on a list that holds the
  // task. No role widens this filter; see the note above taskVisibilityFilter.
  const openId = mongoose.isValidObjectId(req.query.open) ? String(req.query.open) : "";
  const filter = { deletedAt: null, ...taskVisibilityFilter({ ownerKey, employeeId }) };

  const [tasks, employees, clients, daybookEntries] = await Promise.all([
    Task.find(filter)
      // Task lives on an isolated database connection (config/tasksDb.js), so
      // Mongoose can't resolve these refs by name — pass the actual models.
      .populate({ path: "assignedTo", select: "empName empNickName empId", model: Employee })
      // Read live so a renamed employee reads correctly; aboutEmployeeName is
      // the fallback for a free-text name or a since-deleted employee.
      .populate({ path: "aboutEmployee", select: "empName empNickName", model: Employee })
      .populate({ path: "client", select: "clientName clientId", model: Client })
      .sort({ createdAt: -1 })
      .lean(),
    Employee.find({ isActive: true }, "empName empNickName empId").sort({ empName: 1 }).lean(),
    Client.find().select("clientName clientId").sort({ clientName: 1 }).lean(),
    ownerKey ? DaybookEntry.find({ createdBy: ownerKey }).select("task").lean() : [],
  ]);

  const daybookTaskIds = daybookEntries.map((e) => String(e.task));
  const rows = tasks.map((task) => ({ ...task, perms: taskPermissions(task, { ownerKey, employeeId }) }));

  res.render("miscellaneous/tasks.ejs", {
    title: "Company Tasks",
    CSS: "tableDisp.css",
    JS: false,
    tasks: rows,
    daybookTaskIds,
    employees,
    clients,
    hasEmployeeIdentity: Boolean(employeeId),
    openTaskId: openId,
    notification: req.flash("notification"),
  });
});

/* My Tasks: everything assigned to me, split the three ways that actually
   matter on a worklist. JSON so the page can show live counts without a
   reload, and so anything else that wants "what is on this person's plate"
   (a dashboard tile, the mobile app) has one answer to read. Always scoped to
   the session — there is no way to ask for someone else's. */
router.get("/tasks/mine", async (req, res) => {
  const employeeId = await sessionEmployeeId(req);
  const empty = { open: [], overdue: [], done: [], counts: { open: 0, overdue: 0, done: 0 } };
  if (!employeeId) return res.json(empty);

  try {
    const tasks = await Task.find({ deletedAt: null, assignedTo: employeeId })
      .select("title label status dueDate createdByName createdBy client clientIsOthers clientOthers aboutEmployeeName completedAt createdAt")
      .populate({ path: "client", select: "clientName", model: Client })
      .sort({ dueDate: 1, createdAt: -1 })
      .lean();

    // Overdue is measured against the start of today, so a task due today is
    // still open, not already late.
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const result = { open: [], overdue: [], done: [] };
    for (const task of tasks) {
      if (task.status === "COMPLETED") result.done.push(task);
      else if (task.dueDate && new Date(task.dueDate) < startOfToday) result.overdue.push(task);
      else result.open.push(task);
    }

    res.json({
      ...result,
      counts: { open: result.open.length, overdue: result.overdue.length, done: result.done.length },
    });
  } catch (err) {
    console.error("MY TASKS ERROR:", err);
    res.status(500).json(empty);
  }
});

// POST: Create a task
router.post("/tasks", requireAuth, createLimiter, async (req, res) => {
  try {
    const ownerKey = sessionOwnerKey(req);
    if (!ownerKey) {
      return res.status(400).json({
        success: false,
        message: "Tasks are tied to your personal employee login. Please sign in with your employee profile code to create tasks.",
      });
    }

    const title = String(req.body.title || "").trim();
    const label = String(req.body.label || "").trim();
    const { assignedTo, assignedToManualName, client, clientManualName, dueDate, status } = req.body;

    if (!title) {
      return res.status(400).json({ success: false, message: "Task title is required." });
    }

    const myEmployeeId = await sessionEmployeeId(req);
    const myName = sessionDisplayName(req);

    /* Two kinds of new task, chosen in the dialog (TASK_ASSIGN_MODES):
         "send"  hand it to an employee — it lands in their "Assigned to me"
                 and rings their bell;
         "self"  keep it as my own reminder — it is MY task, so nobody else
                 sees it and nobody is notified. Due reminders ring my own
                 bell, which is the point of a reminder.
       In self mode the posted assignedTo is ignored outright rather than
       trusted: whatever the dialog last had selected, a reminder can only
       ever be assigned to the person creating it. */
    const assignMode = req.body.assignMode === "self" ? "self" : "send";

    let assignee, clientInfo, about;
    try {
      if (assignMode === "self") {
        if (!myEmployeeId) {
          return res.status(400).json({
            success: false,
            message: "Your login isn't linked to an employee record, so a task can't be kept for you. Pick an employee to send it to instead.",
          });
        }
        assignee = { assignedTo: myEmployeeId, assignedToIsOthers: false, assignedToOthers: undefined, empName: myName };
      } else {
        assignee = await resolveTaskAssignee(assignedTo, assignedToManualName);
      }
      // Noted whenever it is given, whatever the mode. The dialog only offers
      // it on a kept reminder (where the employee picker has no assignee to
      // name), and it changes nothing about who owns or sees the task.
      about = await resolveTaskAbout(req.body.aboutEmployee, req.body.aboutManualName);
      clientInfo = await resolveTaskClient(client, clientManualName);
    } catch (err) {
      return res.status(400).json({ success: false, message: err.message });
    }

    const validStatuses = ["PENDING", "IN_PROGRESS", "COMPLETED"];
    const taskStatus = validStatuses.includes(status) ? status : "PENDING";

    const task = await Task.create({
      title,
      label: label || undefined,
      assignedTo: assignee.assignedTo,
      assignedToIsOthers: assignee.assignedToIsOthers,
      assignedToOthers: assignee.assignedToOthers,
      assignedToName: assignee.empName,
      aboutEmployee: about.aboutEmployee,
      aboutEmployeeName: about.aboutEmployeeName,
      client: clientInfo.client,
      clientIsOthers: clientInfo.clientIsOthers,
      clientOthers: clientInfo.clientOthers,
      dueDate: dueDate || undefined,
      status: taskStatus,
      completedAt: taskStatus === "COMPLETED" ? new Date() : null,
      createdBy: ownerKey,
      createdById: myEmployeeId || undefined,
      createdByName: myName,
    });

    // Save first, then tell the assignee — and only after the write has
    // succeeded. A kept reminder notifies nobody at all; the actorId guard in
    // notify() would drop it anyway (I am the assignee), but not sending it is
    // the intent rather than a side effect.
    if (assignMode === "send" && assignee.assignedTo) {
      await notify({
        userIds: [assignee.assignedTo],
        actorId: myEmployeeId,
        actorName: myName,
        type: "task.assigned",
        title: `${myName} assigned you: ${task.title}`,
        body: task.dueDate ? `Due ${new Date(task.dueDate).toLocaleDateString("en-GB")}` : "",
        link: TASK_LINK(task._id),
        refModel: "Task",
        refId: task._id,
      });
    }

    /* Deliberately WITHOUT the task's title or the people on it. The audit log
       is readable by proprietor/admin/hod (GET /audit/view), and task text is
       private to the two people on the task -- writing it here would hand every
       confidential task title to exactly the roles the visibility rule excludes.
       The id is enough for accountability: who acted, when, on which record --
       and it discloses nothing, because reading that record still goes through
       taskVisibilityFilter. */
    res.locals.auditDescription =
      assignMode === "self" ? `Created a personal reminder (${task._id})` : `Created and assigned a task (${task._id})`;
    req.flash("notification", assignMode === "self" ? "Reminder saved for you." : "Task created successfully!");
    // Land on the new task rather than on a fixed view: the default view is
    // "Assigned to me", so a task just handed to somebody else would not be
    // in it and the save would look as though it had failed. ?open= lets the
    // page pick the view that holds it and flash the row.
    res.json({ success: true, redirect: `/app/tasks?open=${task._id}` });
  } catch (err) {
    console.error("TASK CREATE ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to create task." });
  }
});

// PUT: Update a task (full edit or a quick status change)
router.put("/api/tasks/:id", requireAuth, updateLimiter, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid task id." });
    }

    const update = {};
    if (req.body.title !== undefined) {
      const title = String(req.body.title).trim();
      if (!title) return res.status(400).json({ success: false, message: "Task title is required." });
      update.title = title;
    }
    if (req.body.dueDate !== undefined) {
      update.dueDate = req.body.dueDate || null;
    }
    if (req.body.label !== undefined) {
      update.label = String(req.body.label || "").trim();
    }
    if (req.body.status !== undefined) {
      const validStatuses = ["PENDING", "IN_PROGRESS", "COMPLETED"];
      if (!validStatuses.includes(req.body.status)) {
        return res.status(400).json({ success: false, message: "Invalid status." });
      }
      update.status = req.body.status;
    }
    if (req.body.assignedTo !== undefined) {
      let assignee;
      try {
        assignee = await resolveTaskAssignee(req.body.assignedTo, req.body.assignedToManualName);
      } catch (err) {
        return res.status(400).json({ success: false, message: err.message });
      }
      update.assignedTo = assignee.assignedTo;
      update.assignedToIsOthers = assignee.assignedToIsOthers;
      update.assignedToOthers = assignee.assignedToOthers ?? null;
      update.assignedToName = assignee.empName;
    }
    if (req.body.aboutEmployee !== undefined) {
      let about;
      try {
        about = await resolveTaskAbout(req.body.aboutEmployee, req.body.aboutManualName);
      } catch (err) {
        return res.status(400).json({ success: false, message: err.message });
      }
      // An empty pick clears it — that is how a reminder stops being about
      // anybody. Display context only, so it is treated as an ordinary edit:
      // it notifies nobody and changes nothing about who sees the task.
      update.aboutEmployee = about.aboutEmployee;
      update.aboutEmployeeName = about.aboutEmployeeName;
    }
    if (req.body.client !== undefined) {
      let clientInfo;
      try {
        clientInfo = await resolveTaskClient(req.body.client, req.body.clientManualName);
      } catch (err) {
        return res.status(400).json({ success: false, message: err.message });
      }
      update.client = clientInfo.client;
      update.clientIsOthers = clientInfo.clientIsOthers;
      update.clientOthers = clientInfo.clientOthers ?? null;
    }

    const ownerKey = sessionOwnerKey(req);
    const employeeId = await sessionEmployeeId(req);
    if (!ownerKey && !employeeId) {
      return res.status(404).json({ success: false, message: "Task not found." });
    }

    // Read it first: the old assignee and the old status are what decide who
    // gets told, and they're gone once the update lands.
    const existing = await Task.findOne({ _id: req.params.id, deletedAt: null }).lean();
    if (!existing) {
      return res.status(404).json({ success: false, message: "Task not found." });
    }

    const perms = taskPermissions(existing, { ownerKey, employeeId });
    if (!perms.canEdit) {
      // A task that is neither yours nor given to you reads as missing, so an
      // id guessed or kept from an old link tells the holder nothing. An
      // assignee can plainly see the task, so telling them it does not exist
      // would only confuse -- they are told whose call it is instead.
      if (!perms.isAssignee) {
        return res.status(404).json({ success: false, message: "Task not found." });
      }
      const whose = existing.createdByName ? ` Ask ${existing.createdByName} to close it off.` : "";
      return res.status(403).json({
        success: false,
        message: `This task was assigned to you — only the person who assigned it can change or complete it.${whose}`,
      });
    }

    const statusChanged = update.status !== undefined && update.status !== existing.status;
    if (statusChanged) {
      update.completedAt = update.status === "COMPLETED" ? new Date() : null;
    }

    const updated = await Task.findOneAndUpdate(
      { _id: req.params.id, deletedAt: null },
      update,
      { new: true, runValidators: true },
    );
    if (!updated) {
      return res.status(404).json({ success: false, message: "Task not found." });
    }

    /* Notifications, after the save and never for your own doing. Editing
       other fields — title, label, due date, client — notifies nobody. */
    const myName = sessionDisplayName(req);
    const oldAssignee = existing.assignedTo ? String(existing.assignedTo) : "";
    const newAssignee = updated.assignedTo ? String(updated.assignedTo) : "";
    const assigneeChanged = update.assignedTo !== undefined && oldAssignee !== newAssignee;

    if (assigneeChanged && newAssignee) {
      await notify({
        userIds: [newAssignee],
        actorId: employeeId,
        actorName: myName,
        type: "task.assigned",
        title: `${myName} assigned you: ${updated.title}`,
        body: updated.dueDate ? `Due ${new Date(updated.dueDate).toLocaleDateString("en-GB")}` : "",
        link: TASK_LINK(updated._id),
        refModel: "Task",
        refId: updated._id,
      });
    }
    // The person it was taken off is told too — otherwise they keep working on
    // something that is no longer theirs.
    if (assigneeChanged && oldAssignee) {
      await notify({
        userIds: [oldAssignee],
        actorId: employeeId,
        actorName: myName,
        type: "task.unassigned",
        title: `${myName} moved this task off you: ${updated.title}`,
        body: updated.assignedToName ? `Now with ${updated.assignedToName}` : "",
        link: TASK_LINK(updated._id),
        refModel: "Task",
        refId: updated._id,
      });
    }

    if (statusChanged && updated.status === "COMPLETED") {
      const creatorId = await taskCreatorRecipientId(existing);
      if (creatorId) {
        await notify({
          userIds: [creatorId],
          actorId: employeeId,
          actorName: myName,
          type: "task.done",
          title: `${myName} completed: ${updated.title}`,
          link: TASK_LINK(updated._id),
          refModel: "Task",
          refId: updated._id,
        });
      }
    }
    // Someone else moving your task along is news to you as well. Not sent
    // when the assignee is the one doing it (notify() drops the actor), and
    // not sent for an assignee who was just told they were given the task.
    if (statusChanged && newAssignee && !assigneeChanged) {
      await notify({
        userIds: [newAssignee],
        actorId: employeeId,
        actorName: myName,
        type: "task.updated",
        title: `${myName} marked your task ${TASK_STATUS_LABELS[updated.status] || updated.status}: ${updated.title}`,
        link: TASK_LINK(updated._id),
        refModel: "Task",
        refId: updated._id,
      });
    }

    /* Deliberately WITHOUT the task's title or the people on it. The audit log
       is readable by proprietor/admin/hod (GET /audit/view), and task text is
       private to the two people on the task -- writing it here would hand every
       confidential task title to exactly the roles the visibility rule excludes.
       The id is enough for accountability: who acted, when, on which record --
       and it discloses nothing, because reading that record still goes through
       taskVisibilityFilter. */
    res.locals.auditDescription = `Updated a task (${updated._id})`;
    res.json({ success: true });
  } catch (err) {
    console.error("TASK UPDATE ERROR:", err);
    res.status(400).json({ success: false, message: err.message });
  }
});

// DELETE: Soft-delete a task (hidden from listings, not removed from the database)
router.delete("/api/tasks/:id", requireAuth, deleteLimiter, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid task id." });
    }
    const ownerKey = sessionOwnerKey(req);
    const employeeId = await sessionEmployeeId(req);
    if (!ownerKey && !employeeId) {
      return res.status(404).json({ success: false, message: "Task not found." });
    }

    const existing = await Task.findOne({ _id: req.params.id, deletedAt: null }).select("title createdBy assignedTo").lean();
    // Deleting is the creator's call (or an all-scope role's). An assignee
    // can finish a task or hand it back, not make it disappear.
    if (!existing || !taskPermissions(existing, { ownerKey, employeeId }).canDelete) {
      return res.status(404).json({ success: false, message: "Task not found." });
    }

    const deleted = await Task.findOneAndUpdate(
      { _id: req.params.id, deletedAt: null },
      { deletedAt: new Date() },
      { new: true },
    ).select("_id").lean();
    if (!deleted) {
      return res.status(404).json({ success: false, message: "Task not found." });
    }
    /* Deliberately WITHOUT the task's title or the people on it. The audit log
       is readable by proprietor/admin/hod (GET /audit/view), and task text is
       private to the two people on the task -- writing it here would hand every
       confidential task title to exactly the roles the visibility rule excludes.
       The id is enough for accountability: who acted, when, on which record --
       and it discloses nothing, because reading that record still goes through
       taskVisibilityFilter. */
    res.locals.auditDescription = `Deleted a task (${req.params.id})`;
    res.json({ success: true });
  } catch (err) {
    console.error("TASK DELETE ERROR:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ----------------------------------Daybook---------------------------------->

// Local calendar day, not UTC.
function todayDayKey() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

router.get("/daybook", async (req, res) => {
  const ownerKey = sessionOwnerKey(req);
  // The Daybook is "what I am working on today", so it draws on everything
  // this person is party to: tasks they created AND tasks assigned to them.
  // Before tasks could be delegated these were the same set.
  const employeeId = await sessionEmployeeId(req);
  const mineFilter = taskVisibilityFilter({ ownerKey, employeeId });
  const hasIdentity = Boolean(ownerKey || employeeId);

  const [entries, availableTasks, completedTasks] = await Promise.all([
    ownerKey
      ? DaybookEntry.find({ createdBy: ownerKey })
          .populate({
            path: "task",
            match: { deletedAt: null },
            populate: [
              { path: "assignedTo", select: "empName empId", model: Employee },
              { path: "client", select: "clientName clientId", model: Client },
            ],
          })
          .sort({ createdAt: 1 })
          .lean()
      : [],
    hasIdentity
      ? Task.find({ deletedAt: null, ...mineFilter, status: { $ne: "COMPLETED" } })
          // createdBy / createdByName are what taskPermissions below reads to
          // decide whose task it is -- without them every row would look like
          // somebody else's and lose its buttons.
          .select("title label status dueDate assignedTo assignedToIsOthers assignedToOthers client clientIsOthers clientOthers createdBy createdByName")
          .populate({ path: "assignedTo", select: "empName", model: Employee })
          .populate({ path: "client", select: "clientName", model: Client })
          .sort({ createdAt: -1 })
          .lean()
      : [],
    hasIdentity
      ? Task.find({ deletedAt: null, ...mineFilter, status: "COMPLETED" })
          .select("title label status dueDate assignedTo assignedToIsOthers assignedToOthers client clientIsOthers clientOthers createdBy createdByName")
          .populate({ path: "assignedTo", select: "empName empId", model: Employee })
          .populate({ path: "client", select: "clientName clientId", model: Client })
          .sort({ createdAt: -1 })
          .lean()
      : [],
  ]);

  const validEntries = entries.filter((e) => e.task);

  // The Daybook lists work assigned to this person as well as work they set
  // themselves, and only the person who handed a task out may close it off --
  // so each row carries what its buttons are allowed to do, exactly as the
  // Tasks page does. PUT /api/tasks/:id checks the same facts again.
  const permsCtx = { ownerKey, employeeId };
  const withPerms = (task) => ({ ...task, perms: taskPermissions(task, permsCtx) });
  for (const entry of validEntries) entry.task = withPerms(entry.task);

  const pickedTaskIds = new Set(validEntries.map((e) => String(e.task._id)));
  const pickableTasks = availableTasks.filter((t) => !pickedTaskIds.has(String(t._id))).map(withPerms);

  res.render("miscellaneous/daybook.ejs", {
    title: "Daybook",
    CSS: "tableDisp.css",
    JS: false,
    entries: validEntries,
    pickableTasks,
    completedTasks: completedTasks.map(withPerms),
    notification: req.flash("notification"),
  });
});

// POST: Pick one or more tasks into today's daybook
router.post("/daybook", requireAuth, createLimiter, async (req, res) => {
  try {
    const ownerKey = sessionOwnerKey(req);
    if (!ownerKey) {
      return res.status(400).json({
        success: false,
        message: "Daybook is tied to your personal employee login. Please sign in with your employee profile code.",
      });
    }

    const taskIds = Array.isArray(req.body.taskIds) ? req.body.taskIds : [];
    const validIds = taskIds.filter((id) => mongoose.isValidObjectId(id));
    if (!validIds.length) {
      return res.status(400).json({ success: false, message: "Please select at least one task." });
    }

    // Pickable = mine to see (created by me or assigned to me), the same set
    // GET /daybook lists. Anything else is silently not picked.
    const employeeId = await sessionEmployeeId(req);
    const ownedTasks = await Task.find({
      _id: { $in: validIds },
      deletedAt: null,
      ...taskVisibilityFilter({ ownerKey, employeeId }),
    }).select("_id").lean();
    const ownedIds = new Set(ownedTasks.map((t) => String(t._id)));
    if (!ownedIds.size) {
      return res.status(400).json({ success: false, message: "No valid tasks selected." });
    }

    const dayKey = todayDayKey();
    const ops = [...ownedIds].map((task) => ({
      updateOne: {
        filter: { dayKey, createdBy: ownerKey, task },
        update: { $setOnInsert: { dayKey, createdBy: ownerKey, task } },
        upsert: true,
      },
    }));
    await DaybookEntry.bulkWrite(ops);

    if (!req.body.silent) req.flash("notification", "Added to Daybook.");
    res.json({ success: true, redirect: "/app/daybook" });
  } catch (err) {
    console.error("DAYBOOK ADD ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to add to Daybook." });
  }
});

// DELETE: Roll a task back out of the daybook by *task* id rather than entry id.
router.delete("/api/daybook/task/:taskId", requireAuth, deleteLimiter, async (req, res) => {
  try {
    const ownerKey = sessionOwnerKey(req);
    if (!ownerKey) {
      return res.status(404).json({ success: false, message: "Daybook entry not found." });
    }
    if (!mongoose.isValidObjectId(req.params.taskId)) {
      return res.status(400).json({ success: false, message: "Invalid task id." });
    }

    const { deletedCount } = await DaybookEntry.deleteMany({ task: req.params.taskId, createdBy: ownerKey });
    if (!deletedCount) {
      return res.status(404).json({ success: false, message: "Task is not in your Daybook." });
    }
    res.json({ success: true });
  } catch (err) {
    console.error("DAYBOOK REMOVE BY TASK ERROR:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE: Roll a task back out of today's daybook (the Task itself is untouched)
router.delete("/api/daybook/:id", requireAuth, deleteLimiter, async (req, res) => {
  try {
    const ownerKey = sessionOwnerKey(req);
    if (!ownerKey) {
      return res.status(404).json({ success: false, message: "Daybook entry not found." });
    }
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid daybook entry id." });
    }

    const deleted = await DaybookEntry.findOneAndDelete({ _id: req.params.id, createdBy: ownerKey });
    if (!deleted) {
      return res.status(404).json({ success: false, message: "Daybook entry not found." });
    }
    res.json({ success: true });
  } catch (err) {
    console.error("DAYBOOK REMOVE ERROR:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ----------------------------------Labels (client binding)---------------------------------->
// Client + user lookup by client name -- still used by the Sales Order form's
// client picker (views/inventory/orders/salesOrderForm.ejs), even though the
// label-creation page that originally used it has been removed.
router.get("/form/labels/:name", async (req, res) => {
  try {
    const rawName = String(req.params.name || "");
    const normalizedName = rawName.trim().replace(/\s+/g, " ");
    // Match any run of whitespace loosely, so stored names that contain
    // stray double spaces (e.g. "KAMAL  ENTERPRISES") still match the
    // whitespace-collapsed value coming from the client dropdown.
    const nameRegex = new RegExp(`^${escapeRegex(normalizedName).replace(/ /g, "\\s+")}$`, "i");

    // 1. Find the Client document
    const clientData = await Client.findOne({ clientName: nameRegex }).lean();

    if (!clientData) {
      return res.status(404).json({ success: false, message: "Client not found" });
    }

    // 2. Fetch all usernames associated with this client name directly from Username model
    // This is more robust than relying on the Client.users array being perfectly in sync.
    const users = await Username.find({ clientName: nameRegex }).lean();

    // 3. Attach users to clientData and return
    clientData.users = users;

    res.status(200).json(clientData);
  } catch (err) {
    console.error("FORM LABELS LOOKUP ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to load client data" });
  }
});

// ----------------------------------Samples---------------------------------->
// Helper: build the counter key and format the sample code
function getMaterialAbbreviation(material) {
  const mat = String(material || "UNKNOWN").trim().toUpperCase();
  if (mat === "FACE PAPER") return "FP";
  if (mat === "ADHESIVE") return "ADH";
  if (mat === "RELEASE PAPER") return "RP";
  if (mat === "SL (PAPER)") return "SL";
  if (mat === "POS ROLL") return "POS";
  return mat.replace(/\s+/g, "-");
}

function formatSampleCode(material, category, seq) {
  const mat = getMaterialAbbreviation(material);
  const cat = category === "client" ? "CSMP" : "VSMP";
  return `FS | ${mat} | ${cat} | ${String(seq).padStart(6, "0")}`;
}

function sampleCounterKey(material, category) {
  const mat = getMaterialAbbreviation(material);
  const cat = category === "client" ? "CSMP" : "VSMP";
  return `sampleCode_${mat}_${cat}`;
}

// GET: preview next sample code (called by client-side JS on radio change)
router.get("/form/samples/next-code", async (req, res) => {
  try {
    const material = String(req.query.material || "").trim();
    const category = String(req.query.category || "vendor").trim().toLowerCase();
    if (!material) return res.json({ code: "" });

    const key = sampleCounterKey(material, category);
    const counterDoc = await Counter.findOne({ key }).select("seq").lean();
    let nextSeq = Number(counterDoc?.seq || 0) + 1;

    while (await Sample.exists({ sampleCode: formatSampleCode(material, category, nextSeq) })) {
      nextSeq += 1;
    }

    return res.json({ code: formatSampleCode(material, category, nextSeq) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ code: "" });
  }
});

router.get("/form/samples", async (req, res) => {
  res.render("inventory/samples.ejs", {
    title: "Samples",
    CSS: false,
    JS: false,
    notification: req.flash("notification"),
  });
});

router.post("/form/samples", requireAuth, createLimiter, async (req, res) => {
  try {
    const activeTab = String(req.body.sampleCategory || "").trim().toLowerCase() === "client" ? "client" : "vendor";

    const material = String(req.body.sampleMaterial || "").trim();
    const key = sampleCounterKey(material, activeTab);

    const generateSampleCode = async () => {
      const maxAttempts = 10000;
      for (let i = 0; i < maxAttempts; i++) {
        const counter = await Counter.findOneAndUpdate(
          { key },
          { $inc: { seq: 1 } },
          { new: true, upsert: true, setDefaultsOnInsert: true },
        ).lean();

        const candidateCode = formatSampleCode(material, activeTab, counter.seq);
        const exists = await Sample.exists({ sampleCode: candidateCode });
        if (!exists) return candidateCode;
      }
      throw new Error("Unable to generate unique sample code");
    };

    const sampleCode = material ? await generateSampleCode() : String(req.body.sampleCode || "").trim();

    await Sample.create({ ...req.body, sampleCode, sampleCategory: activeTab, sampleMaterial: material });

    res.locals.auditDescription = `Created ${activeTab} sample "${sampleCode}" (${material})`;
    req.flash("notification", `${activeTab === "client" ? "Client" : "Vendor"} sample submitted successfully!`);
    res.json({ success: true, redirect: `/app/form/samples?tab=${activeTab}` });
  } catch (err) {
    console.error(err);
    res.status(400).json({ success: false, message: err.message });
  }
});

// Route to render Edit USER form
router.get("/form/edit/user/:userId", async (req, res) => {
  try {
    let { userId } = req.params;
    let user = await Username.findById(userId);

    if (!user) {
      req.flash("error", "User not found.");
      return res.redirect("/app/users/master");
    }

    const stored = editLocationRows(user);

    res.render("users/editUser", {
      CSS: "tabOpt.css",
      title: "Edit User",
      JS: false,
      user,
      initialLocationDetails: stored,
      notification: req.flash("notification"),
      error: req.flash("error"),
    });
  } catch (err) {
    console.error(err);
    req.flash("error", "Error loading user data.");
    res.redirect("back");
  }
});

// Route to handle Edit USER submission
router.post("/form/edit/user/:userId", requireAuth, updateLimiter, async (req, res) => {
  try {
    let { userId } = req.params;
    const wantsJson = String(req.get("accept") || "").includes("application/json");
    const currentUser = await Username.findById(userId);
    if (!currentUser) {
      if (wantsJson) return res.status(404).json({ success: false, message: "User not found." });
      req.flash("error", "User not found.");
      return res.redirect("/app/users/master");
    }

    const updateData = {
      userName: String(req.body.userName || "").trim(),
      userDepartment: String(req.body.userDepartment || "").trim(),
      userContact: String(req.body.userContact || "").trim(),
      userEmail: String(req.body.userEmail || "")
        .trim()
        .toLowerCase(),
    };

    // Helper returns fully-parsed, uppercased entries with per-location dispatch
    // details (and per-entry self-dispatch cleanup) — use them as-is.
    const locationDetails = normalizeLocationDetails(
      req.body.locationDetails,
      req.body.userLocation,
      req.body.dispatchAddress,
    );

    if (!locationDetails.length) {
      return res.status(400).json({ success: false, message: "Please add at least one location and address" });
    }

    const primaryLocation = locationDetails[0];
    updateData.userLocation = primaryLocation.userLocation;
    updateData.dispatchAddress = primaryLocation.dispatchAddress;
    // Top-level dispatch fields mirror the primary (first) location so existing
    // consumers (sales orders, displays) keep working unchanged.
    updateData.SelfDispatch = primaryLocation.selfDispatch || "";
    updateData.transportName = primaryLocation.transportName || "";
    updateData.transportContact = primaryLocation.transportContact || "";
    updateData.dropLocation = primaryLocation.dropLocation || "";
    updateData.deliveryMode = primaryLocation.deliveryMode || "";
    updateData.deliveryLocation = primaryLocation.deliveryLocation || "";
    updateData.clientPayment = primaryLocation.clientPayment || "";
    updateData.locationsCount = locationDetails.length;
    updateData.locationDetails = locationDetails;

    updateData.userSignature = hashSignature(buildUserSignature(updateData, currentUser.clientId));

    // Prevent duplicate full-entity user data within the same client.
    const duplicateUser = await Username.findOne({
      _id: { $ne: userId },
      clientId: currentUser.clientId,
      userName: new RegExp(`^${escapeRegex(updateData.userName)}$`, "i"),
      userLocation: new RegExp(`^${escapeRegex(updateData.userLocation)}$`, "i"),
      userDepartment: new RegExp(`^${escapeRegex(updateData.userDepartment)}$`, "i"),
      userContact: new RegExp(`^${escapeRegex(updateData.userContact)}$`, "i"),
      userEmail: new RegExp(`^${escapeRegex(updateData.userEmail)}$`, "i"),
      dispatchAddress: new RegExp(`^${escapeRegex(updateData.dispatchAddress)}$`, "i"),
      locationDetails: {
        $elemMatch: {
          userLocation: new RegExp(`^${escapeRegex(primaryLocation.userLocation)}$`, "i"),
          dispatchAddress: new RegExp(`^${escapeRegex(primaryLocation.dispatchAddress)}$`, "i"),
        },
      },
      transportName: new RegExp(`^${escapeRegex(updateData.transportName)}$`, "i"),
      transportContact: new RegExp(`^${escapeRegex(updateData.transportContact)}$`, "i"),
      dropLocation: new RegExp(`^${escapeRegex(updateData.dropLocation)}$`, "i"),
      deliveryMode: new RegExp(`^${escapeRegex(updateData.deliveryMode)}$`, "i"),
      deliveryLocation: new RegExp(`^${escapeRegex(updateData.deliveryLocation)}$`, "i"),
      clientPayment: new RegExp(`^${escapeRegex(updateData.clientPayment)}$`, "i"),
      SelfDispatch: new RegExp(`^${escapeRegex(updateData.SelfDispatch)}$`, "i"),
    }).lean();

    if (duplicateUser) {
      if (wantsJson) return res.status(400).json({ success: false, message: "User already exists (same full details)." });
      req.flash("error", "User already exists (same full details).");
      return res.redirect("back");
    }

    const vf = verificationUpdate(req, currentUser);
    await Username.findByIdAndUpdate(
      userId,
      { $set: { ...updateData, ...vf.set }, ...(Object.keys(vf.unset).length ? { $unset: vf.unset } : {}) },
      { new: true, runValidators: true },
    );

    res.locals.auditDescription = `Updated user "${updateData.userName}"`;
    let notification = "User details updated successfully!";
    try {
      const { fixed, ambiguous } = await reconcileUserBindingLocations(userId);
      if (fixed.length) {
        notification += ` Re-pointed ${fixed.length} item location(s) to match.`;
      }
      if (ambiguous.length) {
        notification += ` ${ambiguous.length} item(s) still reference a location that no longer matches — review manually.`;
      }
    } catch (err) {
      console.error("BINDING LOCATION RECONCILE ERROR:", err);
    }
    try {
      const { fixed: identityFixed } = await syncLabelBindingIdentity(userId);
      if (identityFixed.length) {
        notification += ` Synced name/contact on ${identityFixed.length} label binding(s).`;
      }
    } catch (err) {
      console.error("BINDING IDENTITY SYNC ERROR:", err);
    }
    req.flash("notification", notification);
    if (wantsJson) return res.json({ success: true, redirect: `/app/client/details/${userId}` });
    res.redirect(`/app/client/details/${userId}`);
  } catch (err) {
    console.error(err);
    if (String(req.get("accept") || "").includes("application/json")) {
      return res.status(400).json({ success: false, message: "Error updating user details." });
    }
    req.flash("error", "Error updating user details.");
    res.redirect("back");
  }
});

// ----------------------------------Location Master---------------------------------->

// GET: Location Master form
router.get("/form/location", async (req, res) => {
  const locations = await Location.find().sort({ locationName: 1 }).lean();

  res.render("inventory/masters/locationMaster.ejs", {
    JS: false,
    CSS: "tableDisp.css",
    title: "Location Master",
    locations,
    notification: req.flash("notification"),
  });
});

// POST: Location Master submission
router.post("/form/location", requireAuth, createLimiter, async (req, res) => {
  try {
    const locationName = String(req.body.locationName || "")
      .trim()
      .toUpperCase();

    const alreadyExists = await Location.exists({ locationName });
    if (alreadyExists) {
      return res.status(400).json({ success: false, message: "location already exist" });
    }

    await Location.create({ locationName, ...verificationUpdate(req).set });
    res.locals.auditDescription = `Created location "${locationName}"`;
    req.flash("notification", "Location created successfully!");
    res.json({ success: true, redirect: "/app/form/location" });
  } catch (err) {
    console.error(err);
    const msg = err.code === 11000 ? "location already exist" : err.message;
    res.status(400).json({ success: false, message: msg });
  }
});

// API: Get all locations as JSON
router.get("/api/locations", async (req, res) => {
  const locations = await Location.distinct("locationName");
  const normalizedLocations = [...new Set(
    locations
      .map((location) => canonicalizeLocationName(location))
      .filter(Boolean)
  )].sort();
  res.json(normalizedLocations);
});

// PUT: Update a location name
router.put("/api/locations/:id", requireAuth, updateLimiter, async (req, res) => {
  try {
    const locationName = String(req.body.locationName || "")
      .trim()
      .toUpperCase();

    if (!locationName) {
      return res.status(400).json({ success: false, message: "Location name is required." });
    }

    const alreadyExists = await Location.exists({ locationName, _id: { $ne: req.params.id } });
    if (alreadyExists) {
      return res.status(400).json({ success: false, message: "Location already exists." });
    }

    const existing = await Location.findById(req.params.id).select("verified verifiedBy").lean();
    const vf = verificationUpdate(req, existing);

    const updated = await Location.findByIdAndUpdate(
      req.params.id,
      { $set: { locationName, ...vf.set }, ...(Object.keys(vf.unset).length ? { $unset: vf.unset } : {}) },
      { new: true, runValidators: true },
    );

    if (!updated) {
      return res.status(404).json({ success: false, message: "Location not found." });
    }

    res.locals.auditDescription = `Updated location "${locationName}"`;
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    const msg = err.code === 11000 ? "Location already exists." : err.message;
    res.status(400).json({ success: false, message: msg });
  }
});

// DELETE: Remove a location
router.delete("/api/locations/:id", requireAuth, deleteLimiter, async (req, res) => {
  try {
    const existing = await Location.findById(req.params.id).select("locationName").lean();
    await Location.findByIdAndDelete(req.params.id);
    res.locals.auditDescription = `Deleted location "${existing?.locationName || req.params.id}"`;
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(400).json({ success: false, message: err.message });
  }
});

// Machine Master CRUD (/form/machine, /api/machines) moved to
// routes/system/machine.js, alongside the machine queue / job card pipeline
// it now feeds -- see server.js for why that router is mounted ahead of this
// one.

function normalizePosPart(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function normalizePosCoreId(value) {
  const raw = normalizePosPart(value);
  if (!raw) return "";
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? String(numeric) : raw;
}

function buildPosSignature(source) {
  return [
    normalizePosPart(source.posPaperCode),
    normalizePosPart(source.posPaperType),
    normalizePosPart(source.posColor),
    normalizePosPart(source.posGsm),
    normalizePosPart(source.posWidth),
    normalizePosPart(source.posMtrs),
    normalizePosCoreId(source.posCoreId),
  ].join("||");
}

function flexPosValue(val) {
  if (val === undefined || val === null) return val;
  const arr = [val];
  if (typeof val === "string") {
    const t = val.trim();
    if (t !== val) arr.push(t);
    const n = Number(t);
    if (t !== "" && !Number.isNaN(n)) arr.push(n);
  } else {
    arr.push(String(val));
  }
  return { $in: arr };
}

// The standalone Create Vendor / Create Vendor Coordinator page is now two
// dialogs: New Vendor on /vendor/view (views/users/_vendorDialog.ejs) and New
// Coordinator on /vendor/coordinator/view (views/users/_vendorUserDialog.ejs).
// Old links and bookmarks land here and are forwarded, opening the right dialog.
router.get("/form/vendor", (req, res) => {
  const params = new URLSearchParams();
  const isUser = req.query.tab === "user";
  params.set("new", isUser ? "coordinator" : "vendor");
  if (isUser && req.query.vendorName) params.set("vendorName", String(req.query.vendorName));
  res.redirect(`${isUser ? "/app/vendor/coordinator/view" : "/app/vendor/view"}?${params.toString()}`);
});

function normalizeVendorPart(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function buildVendorSignature(source) {
  return [
    normalizeVendorPart(source.vendorName),
    normalizeVendorPart(source.vendorStatus),
    normalizeVendorPart(source.hoLocation),
    normalizeVendorPart(source.warehouseLocation),
    normalizeVendorPart(source.vendorGst),
    normalizeVendorPart(source.vendorMsme),
    normalizeVendorPart(source.vendorGumasta),
    normalizeVendorPart(source.vendorPan),
    Array.isArray(source.commodities)
      ? source.commodities.map((c) => normalizeVendorPart(c)).filter(Boolean).join(",")
      : normalizeVendorPart(source.commodities),
  ].join("||");
}

function normalizeVendorUserPart(value) {
  return String(value ?? "").trim();
}

function normalizeVendorUserName(value) {
  return normalizeVendorUserPart(value).toUpperCase();
}

function normalizeVendorUserEmail(value) {
  return normalizeVendorUserPart(value).toLowerCase();
}

function normalizeVendorUserContact(value) {
  return normalizeVendorUserPart(value).replace(/\D/g, "");
}

function buildVendorUserSignature(source, vendorId) {
  const locationDetails = normalizeLocationDetails(
    source.locationDetails,
    source.userLocation,
    source.dispatchAddress,
  );

  // Pick up details are per-location now, so fold each location's own
  // dispatch fields into its slice of the signature instead of relying on
  // top-level source fields (which only hold the primary location's mirror).
  return [
    normalizeVendorPart(vendorId),
    normalizeVendorUserName(source.userName),
    normalizeVendorUserEmail(source.userEmail),
    normalizeVendorUserContact(source.userContact),
    locationDetails
      .map((entry) =>
        [
          entry.userLocation,
          entry.dispatchAddress,
          entry.selfDispatch,
          entry.transportName,
          entry.transportContact,
          entry.dropLocation,
          entry.dropLocation1,
          entry.deliveryMode,
          entry.deliveryLocation,
          entry.deliveryLocation1,
          entry.vendorPayment,
        ]
          .map((value) => normalizeVendorPart(value))
          .join("::"),
      )
      .join("||"),
  ].join("||");
}

function getVendorSnapshot(vendor, fallback = {}) {
  return {
    vendorId: String(vendor?.vendorId ?? fallback.vendorId ?? "").trim(),
    vendorName: String(vendor?.vendorName ?? fallback.vendorName ?? "").trim(),
    vendorStatus: String(vendor?.vendorStatus ?? fallback.vendorStatus ?? "").trim(),
    hoLocation: String(vendor?.hoLocation ?? fallback.hoLocation ?? "").trim(),
    warehouseLocation: String(vendor?.warehouseLocation ?? fallback.warehouseLocation ?? "").trim(),
    vendorGst: String(vendor?.vendorGst ?? fallback.vendorGst ?? "").trim(),
    vendorMsme: String(vendor?.vendorMsme ?? fallback.vendorMsme ?? "").trim(),
    commodities: vendor?.commodities || fallback.commodities || [],
  };
}

// Route to handle VENDOR form submission
router.post("/form/vendor", requireAuth, createLimiter, async (req, res) => {
  try {
    const vendorName = String(req.body.vendorName || "").trim();
    const vendorGst = String(req.body.vendorGst || "").trim().toUpperCase();
    const vendorPan = String(req.body.vendorPan || "").trim().toUpperCase();

    // GST and PAN Validation
    const gstRegex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
    const panRegex = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;

    if (vendorGst && !gstRegex.test(vendorGst)) {
      return res.status(400).json({ success: false, message: "Invalid GST number format" });
    }
    if (vendorPan && !panRegex.test(vendorPan)) {
      return res.status(400).json({ success: false, message: "Invalid PAN number format" });
    }
    if (vendorGst && vendorPan && vendorGst.substring(2, 12) !== vendorPan) {
      return res.status(400).json({ success: false, message: "PAN does not match GST number" });
    }

    const vendorSignature = hashSignature(buildVendorSignature(req.body));

    // Prevent duplicates only by full vendor signature.
    const alreadyExists = await Vendor.exists({
      vendorSignature,
    });
    if (alreadyExists) {
      return res.status(400).json({ success: false, message: "vendor already exist" });
    }

    const formData = {
      vendorId: await generateVendorId(),
      vendorName,
      vendorStatus: req.body.vendorStatus === "OTHERS" && req.body.otherStatus
        ? `OTHERS - ${String(req.body.otherStatus).trim().toUpperCase().replace(/^(OTHERS - )+/, "")}`
        : String(req.body.vendorStatus || "").trim(),
      hoLocation: String(req.body.hoLocation || "").trim(),
      warehouseLocation: String(req.body.warehouseLocation || "").trim(),
      commodities: (() => {
        let comms = Array.isArray(req.body.commodities)
          ? req.body.commodities.map((c) => String(c).trim().toUpperCase()).filter(Boolean)
          : req.body.commodities
            ? [String(req.body.commodities).trim().toUpperCase()].filter(Boolean)
            : [];
        
        const othersIndex = comms.indexOf("OTHERS");
        if (othersIndex !== -1) {
          const predefined = ["FACE PAPER", "ADHESIVE", "RELEASE PAPER", "SL (PAPER)", "PACKAGING", "TTR", "TAPE", "POS ROLL", "TAFFETA", "PRINTERS", "SCANNERS", "SPARES", "CORE", "FOIL", "IT", "DIE", "BLOCK", "COLOR", "OTHERS"];
          const otherVal = comms.find(c => c !== "OTHERS" && !predefined.includes(c));
          if (otherVal) {
            comms = comms.filter(c => c !== "OTHERS" && c !== otherVal);
            const cleanOtherVal = otherVal.replace(/^(OTHERS - )+/, "");
            comms.push(`OTHERS - ${cleanOtherVal}`);
          }
        }
        return comms;
      })(),
      vendorGst,
      vendorMsme: String(req.body.vendorMsme || "").trim(),
      vendorGumasta: String(req.body.vendorGumasta || "").trim(),
      vendorPan,
      vendorSignature,
      ...verificationUpdate(req).set,
    };

    await Vendor.create(formData);
    res.locals.auditDescription = `Created vendor "${vendorName}"`;
    req.flash("notification", "Vendor created successfully!");
    res.json({ success: true, redirect: "/app/vendor/view" });
  } catch (err) {
    console.error(err);
    if (err?.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "vendor already exist",
      });
    }
    res.status(400).json({ success: false, message: err.message });
  }
});

router.get("/form/vendor/:name", async (req, res) => {
  const vendorData = await Vendor.findOne({ vendorName: req.params.name }).lean();
  if (!vendorData) {
    return res.status(404).json({ message: "Vendor not found" });
  }

  vendorData.userCount = await VendorUser.countDocuments({ vendorId: vendorData.vendorId });
  res.status(200).json(vendorData);
});

// Edit Vendor is a dialog on the vendor's profile page
// (views/users/_editVendorDialog.ejs); old links forward there and open it.
router.get("/vendor/edit/:id", (req, res) => {
  res.redirect(`/app/vendor/profile/${encodeURIComponent(req.params.id)}?edit=1`);
});

router.post("/vendor/edit/:id", requireAuth, updateLimiter, async (req, res) => {
  try {
    const vendor = await Vendor.findById(req.params.id);
    if (!vendor) {
      return res.status(404).json({ success: false, message: "Vendor not found" });
    }

    const linkedVendorUsers = await VendorUser.find({ vendorId: vendor.vendorId })
      .select("_id userName userEmail userContact locationDetails")
      .lean();

    const vendorGst = String(req.body.vendorGst || "").trim().toUpperCase();
    const vendorPan = String(req.body.vendorPan || "").trim().toUpperCase();

    // GST and PAN Validation
    const gstRegex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
    const panRegex = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;

    if (vendorGst && !gstRegex.test(vendorGst)) {
      return res.status(400).json({ success: false, message: "Invalid GST number format" });
    }
    if (vendorPan && !panRegex.test(vendorPan)) {
      return res.status(400).json({ success: false, message: "Invalid PAN number format" });
    }
    if (vendorGst && vendorPan && vendorGst.substring(2, 12) !== vendorPan) {
      return res.status(400).json({ success: false, message: "PAN does not match GST number" });
    }

    const updatedData = {
      vendorId: vendor.vendorId,
      vendorName: String(req.body.vendorName || "").trim(),
      vendorStatus: req.body.vendorStatus === "OTHERS" && req.body.otherStatus
        ? `OTHERS - ${String(req.body.otherStatus).trim().toUpperCase().replace(/^(OTHERS - )+/, "")}`
        : String(req.body.vendorStatus || "").trim(),
      hoLocation: String(req.body.hoLocation || "").trim(),
      warehouseLocation: String(req.body.warehouseLocation || "").trim(),
      commodities: (() => {
        let comms = Array.isArray(req.body.commodities)
          ? req.body.commodities.map((c) => String(c).trim().toUpperCase()).filter(Boolean)
          : req.body.commodities
            ? [String(req.body.commodities).trim().toUpperCase()].filter(Boolean)
            : [];
        
        const othersIndex = comms.indexOf("OTHERS");
        if (othersIndex !== -1) {
          const predefined = ["FACE PAPER", "ADHESIVE", "RELEASE PAPER", "SL (PAPER)", "PACKAGING", "TTR", "TAPE", "POS ROLL", "TAFFETA", "PRINTERS", "SCANNERS", "SPARES", "CORE", "FOIL", "IT", "DIE", "BLOCK", "COLOR", "OTHERS"];
          const otherVal = comms.find(c => c !== "OTHERS" && !predefined.includes(c));
          if (otherVal) {
            comms = comms.filter(c => c !== "OTHERS" && c !== otherVal);
            const cleanOtherVal = otherVal.replace(/^(OTHERS - )+/, "");
            comms.push(`OTHERS - ${cleanOtherVal}`);
          }
        }
        return comms;
      })(),
      vendorGst,
      vendorMsme: String(req.body.vendorMsme || "").trim(),
      vendorGumasta: String(req.body.vendorGumasta || "").trim(),
      vendorPan,
    };

    updatedData.vendorSignature = hashSignature(buildVendorSignature(updatedData));

    const duplicate = await Vendor.findOne({
      _id: { $ne: req.params.id },
      vendorSignature: updatedData.vendorSignature,
    }).lean();

    if (duplicate) {
      return res.status(400).json({ success: false, message: "vendor already exist" });
    }

    const vf = verificationUpdate(req, vendor);
    await Vendor.findByIdAndUpdate(
      req.params.id,
      {
        $set: { ...updatedData, ...vf.set },
        ...(Object.keys(vf.unset).length ? { $unset: vf.unset } : {}),
      },
      { runValidators: true },
    );

    const vendorSnapshot = getVendorSnapshot(updatedData, updatedData);
    if (linkedVendorUsers.length) {
      const bulkOps = linkedVendorUsers.map((vendorUser) => ({
        updateOne: {
          filter: { _id: vendorUser._id },
          update: {
            $set: {
              ...vendorSnapshot,
              vendorUserSignature: hashSignature(buildVendorUserSignature(vendorUser, vendorSnapshot.vendorId)),
            },
          },
        },
      }));

      await VendorUser.bulkWrite(bulkOps);
    }

    res.locals.auditDescription = `Updated vendor "${updatedData.vendorName}"`;
    req.flash("notification", "Vendor updated successfully!");
    res.json({ success: true, redirect: `/app/vendor/profile/${req.params.id}` });
  } catch (err) {
    console.error("VENDOR EDIT POST ERROR:", err);
    if (err?.code === 11000) {
      return res.status(409).json({ success: false, message: "vendor already exist" });
    }
    res.status(400).json({ success: false, message: err.message });
  }
});

// Route to handle VENDOR USER form submission
router.post("/form/vendor-user", requireAuth, createLimiter, async (req, res) => {
  try {
    const { objectId } = req.body;
    const vendor = await Vendor.findOne({ _id: objectId }).lean();
    if (!vendor) {
      return res.status(400).json({ success: false, message: "Invalid vendor selected" });
    }

    const vendorSnapshot = getVendorSnapshot(vendor);
    const vendorId = vendorSnapshot.vendorId;
    const userName = String(req.body.userName || "").trim();
    const userContact = String(req.body.userContact || "").trim();
    const userEmail = String(req.body.userEmail || "")
      .trim()
      .toLowerCase();
    // Helper returns fully-parsed, uppercased entries with per-location dispatch
    // details (and per-entry self-dispatch cleanup) — use them as-is.
    const locationDetails = normalizeLocationDetails(
      req.body.locationDetails,
      req.body.userLocation,
      req.body.dispatchAddress,
    );
    if (!locationDetails.length) {
      return res.status(400).json({
        success: false,
        message: "Please add at least one location and address",
      });
    }
    const primaryLocation = locationDetails[0];
    const vendorUserSignature = hashSignature(buildVendorUserSignature(req.body, vendorId));

    // Prevent duplicates only on full identity tuple within the same vendor.
    const duplicateVendorUser = await VendorUser.findOne({
      $or: [
        { vendorUserSignature },
        {
          vendorId,
          userName: new RegExp(`^${escapeRegex(userName)}$`, "i"),
          userEmail: new RegExp(`^${escapeRegex(userEmail)}$`, "i"),
          userContact: new RegExp(`^${escapeRegex(userContact)}$`, "i"),
        },
      ],
    }).lean();

    if (duplicateVendorUser) {
      return res.status(400).json({
        success: false,
        message: "vendor user already exist (same vendor + name + email + contact)",
      });
    }

    const newUser = await VendorUser.create({
      ...req.body,
      ...vendorSnapshot,
      vendorId,
      userName,
      userContact,
      userEmail,
      locationsCount: locationDetails.length,
      locationDetails,
      userLocation: primaryLocation.userLocation,
      dispatchAddress: primaryLocation.dispatchAddress,
      // Top-level dispatch fields mirror the primary (first) location so
      // existing consumers (vendor coordinator view/details) keep working.
      SelfDispatch: primaryLocation.selfDispatch || "",
      transportName: primaryLocation.transportName || "",
      transportContact: primaryLocation.transportContact || "",
      dropLocation: primaryLocation.dropLocation || "",
      dropLocation1: primaryLocation.dropLocation1 || "",
      deliveryMode: primaryLocation.deliveryMode || "",
      deliveryLocation: primaryLocation.deliveryLocation || "",
      deliveryLocation1: primaryLocation.deliveryLocation1 || "",
      vendorPayment: primaryLocation.vendorPayment || "",
      vendorUserSignature,
      // After ...req.body: the raw "verified=on" there isn't a Boolean.
      ...verificationUpdate(req).set,
    });

    await Vendor.updateOne({ _id: vendor._id }, { $push: { users: newUser._id } });

    res.locals.auditDescription = `Created vendor coordinator "${userName}" for vendor "${vendor.vendorName}"`;
    req.flash("notification", "Vendor user created successfully!");
    res.json({ success: true, redirect: "/app/vendor/coordinator/view" });
  } catch (err) {
    console.error(err);
    if (err?.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "vendor user already exist (same vendor + name + email + contact)",
      });
    }
    res.status(400).json({ success: false, message: err.message });
  }
});

// ================= TTR EDIT =================
// ----------------------------------Sales Order---------------------------------->
// Centralized Sales Order Form
router.get("/sales/order", async (req, res) => {
  if (req.session?.authUser?.role === "sales") return res.status(403).send("Forbidden");
  const { orderId } = req.query;
  // ?embed=1 -- the same form with no nav and no side nav, for the New Sales
  // Order dialog on /sales/pending (views/layout/embed.ejs). It is a render
  // flag and nothing else: same query, same locals, same POST /sales/order on
  // submit, so the dialog can never drift from the standalone page.
  const embed = String(req.query.embed || "") === "1";
  const clientsPromise = Client.distinct("clientName");
  const locationsPromise = Location.distinct("locationName");
  // Full Label Stock master catalog (see /sachiko/label-stock/view) -- the
  // Product Code picker lists every master product, not just ones already
  // bound to the selected client (see onLabelStockProductChange / the
  // labelStockMasterId fallback in POST /sales/order below). "-A"/"-B"/...
  // variant rows (utils/labelStockVariant.js) are an internal production-time
  // split of a base recipe, never something a sales order is placed against,
  // so they're excluded from the picker in the query itself.
  const labelStocksPromise = SachikoLabelStock.find(
    { productCode: { $not: /-[A-Z]+$/ } },
    { skuCode: 1, productCode: 1, rollOrSheet: 1 },
  ).sort({ productCode: 1 }).lean();
  const submissionToken = crypto.randomUUID();

  const orderPromise = orderId
    ? TapeSalesOrder.findById(orderId).populate("userId").populate("tapeId").populate("tapeBinding").lean()
    : Promise.resolve(null);

  const logsPromise = orderId
    ? SalesOrderLog.find({ orderId, action: "DELIVERED" }).sort({ performedAt: -1 }).lean()
    : Promise.resolve([]);

  const [clients, locations, labelStocks, orderToEdit, logs] = await Promise.all([
    clientsPromise,
    locationsPromise,
    labelStocksPromise,
    orderPromise,
    logsPromise,
  ]);

  res.render("inventory/orders/salesOrderForm.ejs", {
    clients,
    locations: (locations || []).filter(Boolean).sort(),
    labelStocks,
    orderToEdit,
    logs,
    submissionToken,
    embed,
    CSS: "salesOrderForm.css?v=9",
    JS: false,
    title: orderToEdit ? "Edit Sales Order" : "Sales Order",
    notification: req.flash("notification"),
  });
});

// API: Get items by type and user
// API: Get clients filtered by item type (for smart filter)
router.get("/sales/clients/:itemType", async (req, res) => {
  try {
    // Every client is listed, not just ones with an existing LabelStockBinding:
    // the Product Code picker on this form lists the full master catalog and
    // POST /sales/order auto-creates the binding on submit when one doesn't
    // exist yet (the labelStockMasterId fallback), so a first-time client must
    // still be selectable.
    const clients = await Client.distinct("clientName");
    res.json(clients.sort());
  } catch (err) {
    console.error("Sales clients filter error:", err);
    res.status(500).json([]);
  }
});

router.get("/sales/items/:type/:userId", async (req, res) => {
  try {
    const { type, userId } = req.params;
    let items = [];

    // Optional location filter: bindings are now tied to a user AND a location,
    // so only surface items bound at the requested location (when provided).
    const normLoc = (v) => String(v || "").trim().toUpperCase().replace(/\s+/g, " ");
    const locationFilter = normLoc(req.query.location);
    const matchesLocation = (loc) => !locationFilter || normLoc(loc) === locationFilter;

    const user = await Username.findById(userId)
      .populate({
        path: "labelStock",
        populate: { path: "labelStock", model: "SachikoLabelStock" },
      })
      .lean();

    if (!user) return res.json([]);

    if (type === "LABEL_STOCK") {
      const bindings = (user.labelStock || []).filter((b) => matchesLocation(b.location));
      items = bindings.map((binding) => {
        if (!binding.labelStock) return null;
        if (binding.status === "INACTIVE") return null; // disabled binding: not orderable
        const s = binding.labelStock;
        return {
          _id: binding._id,
          location: binding.location || "",
          displayName: s.productCode || "",
          minOrderQty: 0,
          rate: binding.rate ?? 0,
          stock: null,
          paperSize: binding.paperSize || "",
          runningMeters: binding.runningMeters ?? null,
          details: {
            type: "LABEL_STOCK",
            skuCode: s.skuCode || "",
            productCode: s.productCode || "",
            rollType: s.rollType || "NORMAL",
            fsFamily: s.facestock?.facestockFamily || "",
            fsType: s.facestock?.facestockType || "",
            fsGsm: s.facestock?.facestockGsm ?? "",
            fsMicron: s.facestock?.facestockMicron ?? "",
            adType: s.adhesive?.adhesiveType || "",
            adGsm: s.adhesive?.adhesiveGsm ?? "",
            rlType: s.releaseLiner?.releaseLinerType || "",
            rlColor: s.releaseLiner?.releaseLinerColor || "",
            rlGsm: s.releaseLiner?.releaseLinerGsm ?? "",
            fs2Family: s.facestock2?.facestockFamily || "",
            fs2Type: s.facestock2?.facestockType || "",
            fs2Gsm: s.facestock2?.facestockGsm ?? "",
            fs2Micron: s.facestock2?.facestockMicron ?? "",
            ad2Type: s.adhesive2?.adhesiveType || "",
            ad2Gsm: s.adhesive2?.adhesiveGsm ?? "",
            rl2Type: s.releaseLiner2?.releaseLinerType || "",
            rl2Color: s.releaseLiner2?.releaseLinerColor || "",
            rl2Gsm: s.releaseLiner2?.releaseLinerGsm ?? "",
          },
        };
      });
    }

    res.json(items.filter(Boolean));
  } catch (err) {
    console.error("ITEMS API ERROR:", err);
    res.json([]);
  }
});

// Builds a rich audit description for a sales order create/update, naming the
// client, item type, quantity, and PO number (no internal item code).
async function describeSalesOrder({ itemTypeLabel, userId, quantity, poNumber, isUpdate }) {
  const user = await Username.findById(userId).select("clientName userName").lean();
  const client = user?.clientName || "Unknown Client";
  const verb = isUpdate ? "Updated" : "Created";
  const poSuffix = poNumber ? ` (PO ${poNumber})` : "";
  return `${verb} ${itemTypeLabel} sales order for "${client}" x${quantity}${poSuffix}`;
}

// Submit Sales Order (Create or Update)
router.post("/sales/order", async (req, res) => {
  if (req.session?.authUser?.role === "sales") return res.status(403).json({ success: false, message: "Forbidden" });
  try {
    const { orderId, itemType, userId, itemId, quantity, estimatedDate, remarks, sourceLocation, locationRadio, userLocation, poNumber, poDate, orderRate, submissionToken, paperSize, runningMeters, noOfRolls, labelStockMasterId, itemRate, deckleOption } = req.body;
    const createdByUser = req.user?.username || "SYSTEM";
    const normalizedDeckleOption = String(deckleOption || "").trim().toUpperCase() || undefined;

    // Est Delivery Date can never be earlier than the PO Date -- applies to
    // every path below (multi-item PO, single-item create, and edit).
    if (poDate && estimatedDate) {
      const pd = new Date(poDate);
      const ed = new Date(estimatedDate);
      if (!Number.isNaN(pd.getTime()) && !Number.isNaN(ed.getTime()) && ed < pd) {
        return res.status(400).json({ success: false, message: "Est Delivery Date cannot be earlier than the PO Date." });
      }
    }

    // ================= MULTI-ITEM PO =================
    // The Sales Order form submits `lines[i][...]` when several Label Stock
    // product lines are placed under one PO. Each line becomes its own
    // TapeSalesOrder document (one product = one production unit downstream),
    // all sharing this PO's header fields + a common poGroupId. Only for new
    // orders -- editing stays single-line (handled further below).
    const rawLines = req.body.lines;
    const poLines = Array.isArray(rawLines)
      ? rawLines
      : rawLines && typeof rawLines === "object"
      ? Object.values(rawLines)
      : null;

    if (!orderId && poLines && poLines.length) {
      const result = await createLabelStockPoLines({
        poLines,
        userId,
        poNumber,
        poDate,
        estimatedDate,
        remarks,
        deckleOption: normalizedDeckleOption,
        sourceLocation,
        locationRadio,
        userLocation,
        createdByUser,
        submissionToken,
      });
      if (result.error) return res.status(400).json({ success: false, message: result.error });

      const { createdOrders, totalQty } = result;
      const user = await Username.findById(userId).select("clientName").lean();
      res.locals.auditDescription = `Created Label Stock sales order for "${user?.clientName || "Unknown Client"}" -- ${createdOrders.length} item line(s), total x${totalQty} (PO ${result.poNumber})`;
      req.flash(
        "notification",
        createdOrders.length
          ? `Sales order created with ${createdOrders.length} item line(s)!`
          : "This sales order was already created.",
      );
      return res.json({ success: true, redirect: "/app/sales/pending" });
    }

    let normalizedSourceLocation = canonicalizeLocationName(sourceLocation || locationRadio || userLocation);
    // "ALL" is not a valid storage location.
    if (normalizedSourceLocation === "ALL") normalizedSourceLocation = "";

    // Fallback 1: derive from selected user.
    if (!normalizedSourceLocation && userId) {
      const userDoc = await Username.findById(userId).select("userLocation").lean();
      normalizedSourceLocation = canonicalizeLocationName(userDoc?.userLocation);
    }

    const sourceLocationForSave = normalizedSourceLocation || undefined;

    if (itemType === "LABEL_STOCK") {
      // Validated up front (rather than after binding resolution) so an
      // auto-created binding (below) never gets a blank paperSize/runningMeters.
      const trimmedPaperSize = String(paperSize || "").trim();
      if (!trimmedPaperSize || !runningMeters || !noOfRolls) {
        return res.status(400).json({ success: false, message: "Paper Size, Running Meters, and No of Rolls are required for Label Stock orders." });
      }
      const dimErr = validateLabelStockDims(trimmedPaperSize, runningMeters);
      if (dimErr) return res.status(400).json({ success: false, message: dimErr });

      let binding = itemId ? await LabelStockBinding.findById(itemId) : null;

      // A picked binding whose own Paper Size/Running Meters don't match
      // what's actually on this order isn't the right binding to save
      // against -- the Paper Size/RM inputs stay editable after picking an
      // item (they're only auto-filled from it, not locked to it), so a
      // client with one binding at e.g. 500mm/1000m can still be ordered
      // 600mm/1500m of the same product, which is a *different* binding
      // (see LabelStockBinding.bindingSignature). Route that the same way
      // as "no binding was picked at all" -- resolve/create the one that
      // actually matches, rather than silently saving the order under the
      // mismatched binding it was picked from.
      const bindingMatchesOrder = binding
        && String(binding.paperSize || "").trim() === trimmedPaperSize
        && Number(binding.runningMeters) === Number(runningMeters);

      if (!binding || !bindingMatchesOrder) {
        // The Product Code picker lists every Label Stock master product
        // (see /sachiko/label-stock/view), not just ones already bound to
        // this client -- so itemId can come back empty when the picked
        // product has no binding yet. A mismatched existing binding already
        // has a known-valid labelStock master id; a missing one needs it
        // resolved (and validated) from labelStockMasterId instead.
        let masterId;
        if (binding) {
          masterId = String(binding.labelStock);
        } else {
          masterId = String(labelStockMasterId || "").trim();
          if (!masterId) {
            return res.status(400).json({ success: false, message: "Invalid item selected" });
          }
          const master = await SachikoLabelStock.findById(masterId).select("_id").lean();
          if (!master) {
            return res.status(400).json({ success: false, message: "Invalid item selected" });
          }
        }

        const resolved = await resolveLabelStockBinding({
          labelStock: masterId,
          userId,
          paperSize: trimmedPaperSize,
          runningMeters,
          itemRate,
          sourceLocation,
          locationRadio,
          userLocation,
        });
        if (resolved.error) {
          return res.status(400).json({ success: false, message: resolved.error });
        }
        binding = resolved.binding;
      }

      if (!orderId && binding.status === "INACTIVE") {
        return res.status(400).json({ success: false, message: "This item is disabled for the selected client and cannot be ordered." });
      }

      // Rate is editable on the order form even for an already-bound product
      // (see rateDisplayInput in salesOrderForm.ejs) -- a change here is a
      // rate revision for this client+product going forward, not just a
      // one-off for this order, so it's written back onto the binding itself
      // and every future order picks it up the same way a manual edit via
      // /sachiko/label-stock-binding/edit/:id would.
      const submittedRate = Number(itemRate);
      if (Number.isFinite(submittedRate) && submittedRate > 0 && submittedRate !== Number(binding.rate)) {
        binding.rate = submittedRate;
        await binding.save();
      }
      const labelStockRate = Number(binding.rate) || 0;

      const data = {
        tapeBinding: binding._id,
        userId: binding.userId,
        tapeId: binding.labelStock,
        sourceLocation: canonicalizeLocationName(binding.location),
        poDate: poDate ? new Date(poDate) : undefined,
        poNumber,
        deckleOption: normalizedDeckleOption,
        orderRate: labelStockRate,
        quantity: Number(quantity),
        estimatedDate: new Date(estimatedDate),
        remarks,
        paperSize: trimmedPaperSize,
        runningMeters: Number(runningMeters),
        noOfRolls: Number(noOfRolls),
        status: "PENDING",
        onModel: "SachikoLabelStock",
        onBindingModel: "LabelStockBinding",
      };

      if (orderId) {
        // UPDATE existing order
        await TapeSalesOrder.findByIdAndUpdate(orderId, data);
        await upsertPendingProduction({ _id: orderId, ...data });
        res.locals.auditDescription = await describeSalesOrder({
          itemTypeLabel: "Label Stock", userId: binding.userId,
          quantity: data.quantity, poNumber: data.poNumber, isUpdate: true,
        });
        req.flash("notification", "Sales order updated successfully!");
        res.json({ success: true, redirect: "/app/sales/pending" });
      } else {
        // CREATE new order
        data.createdBy = createdByUser;
        data.orderSignature = buildSalesOrderSignature({
          itemType,
          itemId: String(binding._id),
          userId: binding.userId,
          quantity: data.quantity,
          estimatedDate,
          poNumber,
          sourceLocation: data.sourceLocation,
          orderRate: labelStockRate,
          createdBy: createdByUser,
        });
        data.submissionToken = String(submissionToken || "").trim() || undefined;
        const existingOrder = await TapeSalesOrder.findOne({ orderSignature: data.orderSignature }).select("_id").lean();
        if (existingOrder) {
          return res.json({ success: true, redirect: "/app/sales/pending", duplicate: true });
        }
        const newOrder = await TapeSalesOrder.create(data);
        await upsertPendingProduction(newOrder);

        await SalesOrderLog.create({
          orderId: newOrder._id,
          action: "CREATED",
          quantity: Number(quantity),
          performedBy: createdByUser,
        });

        res.locals.auditDescription = await describeSalesOrder({
          itemTypeLabel: "Label Stock", userId: binding.userId,
          quantity: data.quantity, poNumber: data.poNumber, isUpdate: false,
        });
        req.flash("notification", "Sales order created successfully!");
        res.json({ success: true, redirect: "/app/sales/pending" });
      }
    } else {
      return res.status(400).json({ success: false, message: "Unsupported item type" });
    }
  } catch (err) {
    console.error("ORDER SUBMIT ERROR:", err);
    const duplicateSubmissionToken =
      err?.code === 11000 &&
      ((err?.keyPattern &&
        (Object.prototype.hasOwnProperty.call(err.keyPattern, "submissionToken") ||
          Object.prototype.hasOwnProperty.call(err.keyPattern, "orderSignature"))) ||
        (err?.keyValue &&
          (Object.prototype.hasOwnProperty.call(err.keyValue, "submissionToken") ||
            Object.prototype.hasOwnProperty.call(err.keyValue, "orderSignature"))) ||
        String(err?.message || "").includes("submissionToken") ||
        String(err?.message || "").includes("orderSignature"));

    if (duplicateSubmissionToken) {
      return res.json({ success: true, redirect: "/app/sales/pending", duplicate: true });
    }
    // Race between two near-simultaneous submits for the same new-client
    // Label Stock binding: both pass the findOne(bindingSignature) check
    // above before either creates, so the second create() hits the unique
    // index instead (see buildLabelStockBindingSignature / LabelStockBinding
    // schema). Same friendly message the manual binding form gives.
    const duplicateBindingSignature =
      err?.code === 11000 &&
      ((err?.keyPattern && Object.prototype.hasOwnProperty.call(err.keyPattern, "bindingSignature")) ||
        (err?.keyValue && Object.prototype.hasOwnProperty.call(err.keyValue, "bindingSignature")) ||
        String(err?.message || "").includes("bindingSignature"));
    if (duplicateBindingSignature) {
      return res.status(400).json({
        success: false,
        message: "This Label Stock binding already exists (same SKU Code, Paper Size, RM, Client and User).",
      });
    }
    const sourceLocError = err?.errors?.sourceLocation;
    if (sourceLocError) {
      return res.status(400).json({ success: false, message: "no location is selected" });
    }
    res.status(400).json({ success: false, message: "Failed to submit order" });
  }
});

// View Pending Orders
router.get("/sales/pending", async (req, res) => {
  try {
    const pendingOrders = await TapeSalesOrder.find({ status: "PENDING" })
      .select(
        "tapeId tapeBinding userId quantity dispatchedQuantity estimatedDate poDate createdAt sourceLocation poNumber poGroupId deckleOption orderRate remarks status onModel onBindingModel paperSize runningMeters noOfRolls",
      )
      .populate({ path: "userId", select: "clientName userName" })
      .populate({
        path: "tapeId",
        select: "productCode skuCode rollOrSheet facestock adhesive releaseLiner",
      })
      .populate({
        path: "tapeBinding",
        select: "status location",
      })
      .sort({ createdAt: 1 })
      .lean();

    // Label Stock rows have no stock model or purchase order of their own.
    pendingOrders.forEach((o) => {
      o.totalStock = 0;
      o.hasPendingPo = false;
    });

    res.render("inventory/orders/pendingOrders.ejs", {
      orders: pendingOrders,
      title: "Pending Orders",
      CSS: "tableDisp.css",
      JS: false,
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("PENDING ORDERS ERROR:", err);
    res.redirect("back");
  }
});

/* ============ PAPER RE-ORDER IMPORT (from the FAIRTECH ERP export) ============ */

// The file FAIRTECH's /fairtech/inventory/paper-reorder page produces. The two
// apps share no database, so the only thing tying a paper spec there to a
// Label Stock product here is the Prod Code / Product Code string they already
// have in common (C001WB, P002WB, ...) -- resolved per line below.
const PAPER_REORDER_IMPORT_FORMAT = "fairtech.paper-reorder.sachiko-sales-order";
const PAPER_REORDER_IMPORT_VERSION = 1;

const paperReorderImportUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() !== ".json") {
      return cb(new Error("Upload the .json file the FAIRTECH Paper Re-Order page produced."), false);
    }
    cb(null, true);
  },
}).single("file");

// "-A"/"-B"/... rows are an internal production-time split of a base recipe
// (utils/labelStockVariant.js), never something an order is placed against --
// same exclusion GET /sales/order applies to its own Product Code picker.
const LABEL_STOCK_VARIANT_SUFFIX = /-[A-Z]+$/;

// Resolves one exported line against this database: which Label Stock master
// the Prod Code names, whether a binding for that client + size + RM already
// exists (and so what rate to pre-fill), and whether this PO already brought
// the same line in. Returns a row for the preview dialog; `error` set means
// the line can't be ordered as it stands.
async function resolvePaperReorderLine(line, { userId, poNumber }) {
  const productCode = String(line?.productCode || "").trim();
  const paperSize = String(line?.paperSize ?? "").trim();
  const runningMeters = Number(line?.runningMeters);
  const noOfRolls = Number(line?.noOfRolls);

  const row = {
    productCode,
    family: String(line?.family || "").trim(),
    paperSize,
    runningMeters,
    noOfRolls,
    shortfallMtrs: Number(line?.shortfallMtrs) || 0,
    skuCode: "",
    labelStockMasterId: "",
    bindingExists: false,
    rate: "",
    rateSource: "",
    duplicate: false,
    error: "",
  };

  if (!productCode) return { ...row, error: "No Product Code on this line." };
  if (!(noOfRolls > 0)) return { ...row, error: "No of Rolls must be greater than zero." };

  const dimError = validateLabelStockDims(paperSize, runningMeters);
  if (dimError) return { ...row, error: dimError };

  const masters = await SachikoLabelStock.find({
    productCode: new RegExp(`^${escapeRegex(productCode)}$`, "i"),
  })
    .select("_id skuCode productCode family")
    .lean();
  const base = masters.filter((m) => !LABEL_STOCK_VARIANT_SUFFIX.test(String(m.productCode || "")));

  if (!base.length) {
    return { ...row, error: `No Label Stock product with code "${productCode}".` };
  }
  if (base.length > 1) {
    return {
      ...row,
      error: `"${productCode}" matches ${base.length} Label Stock products (${base.map((m) => m.skuCode).join(", ")}).`,
    };
  }

  const master = base[0];
  row.skuCode = master.skuCode || "";
  row.labelStockMasterId = String(master._id);
  row.family = row.family || master.family || "";

  // The binding this line will land on if one already exists -- looked up by
  // the same signature resolveLabelStockBinding() would, so the rate shown in
  // the preview is the rate the order will actually be placed at.
  const binding = await LabelStockBinding.findOne({
    bindingSignature: buildLabelStockBindingSignature({
      labelStock: master._id,
      userId,
      paperSize,
      runningMeters,
    }),
  })
    .select("rate status location")
    .lean();

  if (binding) {
    if (binding.status === "INACTIVE") {
      return { ...row, error: `"${productCode}" is disabled for this client and cannot be ordered.` };
    }
    row.bindingExists = true;
    row.rate = Number(binding.rate) || "";
    row.rateSource = `binding (size ${paperSize}, RM ${runningMeters})`;
  } else {
    // No binding for this exact size + RM yet -- one will be created on
    // confirm. Pre-fill its rate from the client's most recent binding for
    // the same product so a new size doesn't have to be priced from scratch,
    // but leave it clearly marked as a guess rather than a looked-up rate.
    const nearest = await LabelStockBinding.findOne({ labelStock: master._id, userId })
      .sort({ updatedAt: -1 })
      .select("rate paperSize runningMeters")
      .lean();
    if (nearest) {
      row.rate = Number(nearest.rate) || "";
      row.rateSource = `last rate for this product (size ${nearest.paperSize}, RM ${nearest.runningMeters})`;
    } else {
      row.rateSource = "no binding yet — enter a rate";
    }
  }

  // Same PO, same product, same size and RM already on the books: the file
  // has most likely been uploaded twice. Not an error (a genuine top-up under
  // one PO number is legitimate), but it starts unticked in the preview.
  const dupe = await TapeSalesOrder.findOne({
    onModel: "SachikoLabelStock",
    userId,
    tapeId: master._id,
    poNumber: String(poNumber || "").trim(),
    paperSize,
    runningMeters,
    status: { $ne: "CANCELLED" },
  })
    .select("_id")
    .lean();
  row.duplicate = Boolean(dupe);

  return row;
}

// Step 1 of the upload: read the file, resolve every line, and hand the result
// back for review. Writes nothing -- the resolved lines are parked on the
// session so the confirm below works from what was actually shown, not from
// whatever the browser posts back.
router.post("/sales/pending/import/preview", requireAuth, createLimiter, (req, res) => {
  paperReorderImportUpload(req, res, async (uploadErr) => {
    try {
      if (uploadErr) return res.status(400).json({ success: false, message: uploadErr.message });
      if (!req.file) return res.status(400).json({ success: false, message: "Choose a file to upload." });

      let payload;
      try {
        payload = JSON.parse(req.file.buffer.toString("utf8"));
      } catch {
        return res.status(400).json({ success: false, message: "That file isn't valid JSON." });
      }

      if (payload?.format !== PAPER_REORDER_IMPORT_FORMAT) {
        return res.status(400).json({
          success: false,
          message: "That file isn't a FAIRTECH paper re-order export.",
        });
      }
      if (Number(payload.version) !== PAPER_REORDER_IMPORT_VERSION) {
        return res.status(400).json({
          success: false,
          message: `This file is version ${payload.version}; this page reads version ${PAPER_REORDER_IMPORT_VERSION}.`,
        });
      }

      const order = payload.order || {};
      const lines = Array.isArray(payload.lines) ? payload.lines : [];
      if (!lines.length) return res.status(400).json({ success: false, message: "That file has no order lines." });

      const clientName = String(order.clientName || "").trim();
      if (!clientName) return res.status(400).json({ success: false, message: "That file names no client." });

      const users = await Username.find({ clientName: new RegExp(`^${escapeRegex(clientName)}$`, "i") })
        .select("_id userName clientName userLocation")
        .sort({ userName: 1 })
        .lean();
      if (!users.length) {
        return res.status(400).json({
          success: false,
          message: `No client user on file for "${clientName}" — add one under Clients before importing.`,
        });
      }
      // More than one user under the client is legitimate; the first by name
      // is used and named in the preview so it's visible before confirming.
      const user = users[0];

      const poNumber = String(order.poNumber || "").trim();
      if (!poNumber) return res.status(400).json({ success: false, message: "That file carries no PO Number." });

      const rows = [];
      for (const line of lines) {
        rows.push(await resolvePaperReorderLine(line, { userId: user._id, poNumber }));
      }

      // Location is never asked for on the import. It decides one thing only:
      // where a *newly created* binding is filed -- and a client's paper
      // belongs wherever that client's existing bindings already sit, so
      // there is nothing for anyone to choose. It still has to be resolved
      // rather than skipped: resolveLabelStockBinding() demands a location
      // for every line, including lines whose binding already exists.
      //
      // The client's own bindings win over the Location master, which may
      // have been renamed or pruned since those bindings were made -- filing
      // a new one somewhere else would split one client's paper across two
      // locations.
      const [masterLocations, bindingLocations] = await Promise.all([
        Location.distinct("locationName"),
        LabelStockBinding.distinct("location", { userId: user._id }),
      ]);
      const resolvedLocation =
        [...bindingLocations, user.userLocation]
          .map((l) => normalizeLocationName(l))
          .find((l) => l && l !== "ALL") ||
        // Nothing bound yet: a single-location setup has only one answer.
        (masterLocations.length === 1 ? normalizeLocationName(masterLocations[0]) : "");

      if (!resolvedLocation) {
        return res.status(400).json({
          success: false,
          message:
            `No location on file for "${user.clientName}" — bind a product to this client, ` +
            `or set the user's location, before importing.`,
        });
      }
      const token = crypto.randomUUID();
      req.session.paperReorderImport = {
        token,
        userId: String(user._id),
        location: resolvedLocation,
        order: {
          clientName: user.clientName,
          userName: user.userName,
          poNumber,
          poDate: order.poDate || "",
          estimatedDate: order.estimatedDate || "",
          deckleOption: String(order.deckleOption || "").trim().toUpperCase(),
          remarks: String(order.remarks || "").trim(),
          vendorName: String(order.vendorName || "").trim(),
          exportedBy: String(payload.source?.exportedBy || "").trim(),
          generatedAt: payload.generatedAt || "",
        },
        rows,
      };

      res.json({
        success: true,
        token,
        order: req.session.paperReorderImport.order,
        userCount: users.length,
        rows,
      });
    } catch (err) {
      console.error("PAPER REORDER IMPORT PREVIEW ERROR:", err);
      res.status(500).json({ success: false, message: "Failed to read that file." });
    }
  });
});

// Step 2: create the orders the user ticked. Lines come from the session copy
// of the preview; the browser only says which ones to include and at what
// rate, so a doctored post can't smuggle in a product or a quantity that was
// never shown.
router.post("/sales/pending/import/commit", requireAuth, createLimiter, async (req, res) => {
  try {
    const staged = req.session.paperReorderImport;
    if (!staged || staged.token !== String(req.body.token || "")) {
      return res.status(400).json({
        success: false,
        message: "That upload has expired — upload the file again.",
      });
    }

    const selections = Array.isArray(req.body.lines) ? req.body.lines : [];
    const byIndex = new Map(selections.map((s) => [Number(s.index), s]));

    const poLines = [];
    for (let i = 0; i < staged.rows.length; i++) {
      const sel = byIndex.get(i);
      if (!sel || !sel.include) continue;
      const row = staged.rows[i];
      if (row.error) {
        return res.status(400).json({ success: false, message: `${row.productCode}: ${row.error}` });
      }
      const rate = Number(sel.rate);
      if (!Number.isFinite(rate) || rate <= 0) {
        return res.status(400).json({
          success: false,
          message: `${row.productCode} (size ${row.paperSize}): a rate greater than zero is required.`,
        });
      }
      poLines.push({
        labelStockMasterId: row.labelStockMasterId,
        paperSize: row.paperSize,
        runningMeters: row.runningMeters,
        noOfRolls: row.noOfRolls,
        itemRate: rate,
      });
    }

    if (!poLines.length) {
      return res.status(400).json({ success: false, message: "Tick at least one line to import." });
    }

    // Resolved at preview time (see above) and carried on the session -- the
    // browser never sends it, so it can't be pointed somewhere else.
    const location = normalizeLocationName(staged.location || "");
    if (!location || location === "ALL") {
      return res.status(400).json({
        success: false,
        message: "That upload has no usable location — upload the file again.",
      });
    }

    const result = await createLabelStockPoLines({
      poLines,
      userId: staged.userId,
      poNumber: staged.order.poNumber,
      poDate: staged.order.poDate,
      estimatedDate: staged.order.estimatedDate,
      remarks: staged.order.remarks,
      deckleOption: staged.order.deckleOption || undefined,
      sourceLocation: location,
      createdByUser: req.user?.username || "SYSTEM",
      // Ties every line of this import to the one upload it came from, so
      // re-confirming the same staged preview can't double-create.
      submissionToken: `import-${staged.token}`,
    });
    if (result.error) return res.status(400).json({ success: false, message: result.error });

    delete req.session.paperReorderImport;

    const created = result.createdOrders.length;
    res.locals.auditDescription =
      `Imported paper re-order from FAIRTECH for "${staged.order.clientName}" -- ` +
      `${created} item line(s), total x${result.totalQty} (PO ${result.poNumber})`;
    req.flash(
      "notification",
      created
        ? `Imported ${created} line${created === 1 ? "" : "s"} as PO ${result.poNumber}.`
        : "Every line in that file was already imported.",
    );
    res.json({ success: true, created, redirect: "/app/sales/pending" });
  } catch (err) {
    console.error("PAPER REORDER IMPORT COMMIT ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to create the orders." });
  }
});

// View Pending Purchase Orders
// Facestock/Adhesive/Release Master have no VendorUser/binding concept the
// way Tape does (see PurchaseOrder model) -- this is the one shared lookup
// table for those three, used to name the item on the Pending/Receive PO
// pages and to know which stock model a received PO creates a reel in.
const MATERIAL_PO_TYPES = {
  FacestockMaster: {
    label: "Facestock",
    name: (item) => (item ? `${item.skuId || ""} — ${item.family || ""} ${item.type || ""}`.trim() : "N/A"),
  },
  AdhesiveMaster: {
    label: "Adhesive",
    name: (item) => (item ? `${item.skuId || ""} — ${item.type || ""}`.trim() : "N/A"),
  },
  ReleaseMaster: {
    label: "Release Liner",
    name: (item) => (item ? `${item.skuId || ""} — ${item.type || ""}`.trim() : "N/A"),
  },
};

router.get("/purchase/pending", async (req, res) => {
  try {
    const pendingPOs = await PurchaseOrder.find({
      status: { $in: ["PENDING", "CONFIRMED", "PARTIALLY_RECEIVED"] },
      $or: [
        { vendorUserId: { $ne: null }, vendorBinding: { $ne: null } },
        { onModel: { $in: Object.keys(MATERIAL_PO_TYPES) } },
      ],
    })
      .populate("vendorUserId", "vendorName userName")
      .populate({
        path: "itemId",
        select: "skuId family type size gsm micron make vendorSkuCode color msq",
      })
      .sort({ createdAt: -1 })
      .lean();

    const orders = pendingPOs.map((order) => ({
      ...order,
      vendorDisplayName: order.vendorUserId?.vendorName || order.vendorName || "Vendor not binded",
      coordinatorDisplayName: order.vendorUserId?.userName || order.coordinatorName || "Coordinator not binded",
    }));

    res.render("inventory/orders/pendingPurchaseOrders.ejs", {
      title: "Pending Purchase Orders",
      orders,
      notification: req.flash("notification"),
      CSS: "tableDisp.css",
      JS: false,
    });
  } catch (err) {
    console.error("PENDING PO ERROR:", err);
    res.status(500).send("Internal Server Error");
  }
});

function getItemName(item, type) {
  if (!item) return "N/A";
  if (MATERIAL_PO_TYPES[type]) return MATERIAL_PO_TYPES[type].name(item);
  return "N/A";
}

router.get("/purchase/receive", async (req, res) => {
  try {
    const { orderId } = req.query;
    if (!orderId) {
      req.flash("notification", "No order ID provided.");
      return res.redirect("/app/purchase/pending");
    }

    const order = await PurchaseOrder.findById(orderId)
      .populate("vendorUserId")
      .populate("itemId")
      .lean();

    if (!order) {
      req.flash("notification", "Purchase Order not found.");
      return res.redirect("/app/purchase/pending");
    }

    const [logs, locations] = await Promise.all([
      PurchaseOrderLog.find({ orderId: orderId, action: { $ne: "CREATED" } })
        .sort({ createdAt: -1 })
        .lean(),
      Location.distinct("locationName")
    ]);

    res.render("inventory/orders/receivePO.ejs", {
      title: "Receive Purchase Order",
      order,
      logs: logs || [],
      locations: (locations || []).filter(Boolean).sort(),
      itemName: getItemName(order.itemId, order.onModel),
      notification: req.flash("notification"),
      CSS: false,
      JS: false
    });
  } catch (err) {
    console.error("RECEIVE PO GET ERROR:", err);
    res.status(500).send("Internal Server Error");
  }
});

router.post("/purchase/receive", async (req, res) => {
  try {
    const { orderId, location, receivedQuantity, remarks } = req.body;
    
    const po = await PurchaseOrder.findById(orderId).populate("itemId");
    if (!po) {
      req.flash("notification", "Purchase Order not found.");
      return res.redirect("/app/purchase/pending");
    }

    if (po.status === "RECEIVED") {
      req.flash("notification", "This order has already been received.");
      return res.redirect("/app/purchase/pending");
    }

    const qty = Number(receivedQuantity) || po.quantity;

    // Create Stock Entry based on item type
    if (po.onModel === "FacestockMaster") {
      const item = po.itemId;
      const rollId = await generateMaterialRollId("FACESTOCK", FacestockStock);
      await FacestockStock.create({
        family: item.family,
        type: item.type,
        size: item.size,
        gsm: item.gsm,
        micron: item.micron,
        vendorId: item.vendorId,
        vendorName: item.vendorName,
        make: item.make,
        vendorSkuCode: item.vendorSkuCode,
        location,
        quantity: 1,
        reelMtrs: qty,
        rollId,
        invoiceNo: `PO:${po.poNumber}`,
        remarks: remarks || `From PO: ${po.poNumber}`,
      });
    } else if (po.onModel === "AdhesiveMaster") {
      const item = po.itemId;
      const rollId = await generateMaterialRollId("ADHESIVE", AdhesiveStock);
      await AdhesiveStock.create({
        type: item.type,
        vendorId: item.vendorId,
        vendorName: item.vendorName,
        make: item.make,
        vendorSkuCode: item.vendorSkuCode,
        viscosity: item.viscosity,
        cohesion: item.cohesion,
        shear: item.shear,
        density: item.density,
        location,
        quantity: 1,
        reelMtrs: qty,
        rollId,
        invoiceNo: `PO:${po.poNumber}`,
        remarks: remarks || `From PO: ${po.poNumber}`,
      });
    } else if (po.onModel === "ReleaseMaster") {
      const item = po.itemId;
      const rollId = await generateMaterialRollId("RELEASE", ReleaseLinerStock);
      await ReleaseLinerStock.create({
        type: item.type,
        color: item.color,
        size: item.size,
        gsm: item.gsm,
        vendorId: item.vendorId,
        vendorName: item.vendorName,
        make: item.make,
        vendorSkuCode: item.vendorSkuCode,
        location,
        quantity: 1,
        reelMtrs: qty,
        rollId,
        invoiceNo: `PO:${po.poNumber}`,
        remarks: remarks || `From PO: ${po.poNumber}`,
      });
    }

    // Update PO Status & Quantities
    const newlyReceived = qty;
    po.receivedQuantity = (po.receivedQuantity || 0) + newlyReceived;
    
    if (po.receivedQuantity >= po.quantity) {
      po.status = "RECEIVED";
    } else {
      po.status = "PARTIALLY_RECEIVED";
    }

    po.remarks = (po.remarks ? po.remarks + " | " : "") + (remarks || `Received ${newlyReceived}`);
    await po.save();

    // Log Action
    await PurchaseOrderLog.create({
      orderId: po._id,
      action: po.status === "RECEIVED" ? "RECEIVED" : "PARTIALLY_RECEIVED",
      poNumber: po.poNumber,
      quantity: newlyReceived,
      location: location,
      remarks: `Inward to ${location}. ` + (remarks || ""),
      performedBy: req.session?.authUser?.username || "SYSTEM"
    });

    res.locals.auditDescription = `Received ${newlyReceived} units into stock at "${location}" for PO "${po.poNumber}"`;
    req.flash("notification", "Purchase Order received and stock updated successfully.");
    res.redirect("/app/purchase/pending");
  } catch (err) {
    console.error("RECEIVE PO POST ERROR:", err);
    req.flash("notification", "Error processing receipt: " + err.message);
    res.redirect("back");
  }
});

// GET: Confirm Order Page (prefilled sales order form + extra fields)
router.get("/sales/order/confirm", async (req, res) => {
  try {
    const { orderId } = req.query;
    if (!orderId) {
      req.flash("notification", "No order specified");
      return res.redirect("/app/sales/pending");
    }

    let order = await TapeSalesOrder.findById(orderId)
      .populate({ path: "userId", select: "clientName userName userLocation" })
      .populate({
        path: "tapeId",
        select:
          "tapeProductId tapePaperCode tapeGsm tapeFinish tapePaperType tapeAdhesiveGsm tapeWidth tapeMtrs tapeCoreId ttrProductId ttrType ttrColor ttrMaterialCode ttrWidth ttrMtrs ttrInkFace ttrCoreId ttrCoreLength ttrNotch ttrWinding labelWidth labelHeight productCode skuCode rollType facestock adhesive releaseLiner facestock2 adhesive2 releaseLiner2",
      })
      .populate({
        path: "tapeBinding",
        select:
          "tapeRatePerRoll tapeOdrQty tapeMinQty tapeClientMaterialCode clientTapeGsm ttrRatePerRoll ttrOdrQty ttrMinQty ttrClientMaterialCode clientTtrType location status",
      })
      .lean();

    if (!order) {
      req.flash("notification", "Order not found");
      return res.redirect("/app/sales/pending");
    }

    const logs = await SalesOrderLog.find({ orderId, action: "DELIVERED" }).sort({ performedAt: -1 }).lean();
    const locations = await Location.distinct("locationName");

    // ========== STOCK PRE-CALCULATION FOR CONFIRM PAGE ==========
    let stockInfo = { totalStock: 0, locations: [], booked: 0, balance: 0 };
    if (order.tapeId) {
      try {
        stockInfo = await getItemStockSummary(order.onModel, order.tapeId._id);
      } catch (err) {
        console.error("CONFIRM STOCK SUMMARY ERROR:", err);
      }
    }

    const clients = await Client.distinct("clientName");

    res.render("inventory/orders/salesOrderForm.ejs", {
      clients,
      locations: (locations || []).filter(Boolean).sort(),
      orderToEdit: order,
      stockInfo, // Pass pre-calculated stock
      logs,
      confirmMode: true,
      CSS: "salesOrderForm.css?v=9",
      JS: false,
      title: "Confirm & Create Order",
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("CONFIRM ORDER PAGE ERROR:", err);
    req.flash("notification", "Failed to load confirm page");
    res.redirect("/app/sales/pending");
  }
});

// GET: Order Logs
router.get("/sales/order/logs", async (req, res) => {
  try {
    // Step 1: Fetch all logs (without nested populate for now)
    const rawLogs = await SalesOrderLog.find()
      .sort({ performedAt: -1 })
      .lean();

    // Step 2: Collect all orderId values that need to be resolved
    const allOrderIds = [...new Set(rawLogs.map((l) => String(l.orderId)).filter(Boolean))];

    const ITEM_SELECT = "tapeProductId tapePaperCode tapeGsm tapeFinish clientSkuCode productCode skuCode";
    const USER_SELECT = "clientName userName";

    // Step 3: Query the order collection
    const tapeOrders = await TapeSalesOrder.find({ _id: { $in: allOrderIds } })
      .populate({ path: "userId", select: USER_SELECT })
      .populate({ path: "tapeId", select: ITEM_SELECT })
      .lean();

    // Step 4: Build a map of orderId -> populated order doc
    const orderMap = new Map();
    for (const o of tapeOrders) {
      orderMap.set(String(o._id), o);
    }

    // Step 5: Attach the resolved order to each log
    const logs = rawLogs.map((log) => ({
      ...log,
      orderId: orderMap.get(String(log.orderId)) || null,
    }));

    res.render("inventory/orders/orderLogs.ejs", {
      logs,
      title: "Order Action Logs",
      CSS: "tableDisp.css",
      JS: false,
      notification: req.flash("notification"),
    });

  } catch (err) {
    console.error("ORDER LOGS ERROR:", err);
    req.flash("notification", "Failed to load logs");
    res.redirect("/app/sales/pending");
  }
});

// ========== EDIT a Purchase Receipt Log (JSON API) ==========
router.put("/purchase/log/:logId", requireAuth, updateLimiter, async (req, res) => {
  try {
    const { logId } = req.params;
    const { quantity: newQty, remarks: newRemarks } = req.body;

    const log = await PurchaseOrderLog.findById(logId);
    if (!log) return res.json({ success: false, message: "Receipt log not found" });

    const po = await PurchaseOrder.findById(log.orderId).populate("itemId");
    if (!po) return res.json({ success: false, message: "Purchase Order not found" });

    const oldQty = log.quantity || 0;
    const qtyDiff = Number(newQty) - oldQty;
    const location = log.location;

    // Item-specific stock models
    let StockModel = TapeStock;
    let StockLogModel = TapeStockLog;
    let matchField = "tape";

    if (location && po.itemId && qtyDiff !== 0) {
      // Get current stock at location
      const bal = await StockModel.aggregate([
        { $match: { [matchField]: po.itemId._id, location: location } },
        { $group: { _id: null, qty: { $sum: "$quantity" } } },
      ]);
      const currentStock = bal[0]?.qty || 0;

      if (qtyDiff < 0) {
        // Need to reverse (outward) some stock because new quantity is lower
        const deduction = Math.abs(qtyDiff);
        if (currentStock < deduction) {
          return res.json({ success: false, message: `Insufficient stock at ${location} to reduce receipt. Available: ${currentStock}, adjustment needed: ${deduction}` });
        }

        const stockData = {
          [matchField]: po.itemId._id,
          location,
          quantity: -deduction,
          remarks: `Receipt Log Edited (reduced): ${po.poNumber}`,
        };
        await StockModel.create(stockData);

        await StockLogModel.create({
          [matchField]: po.itemId._id,
          location,
          openingStock: currentStock,
          quantity: deduction,
          closingStock: currentStock - deduction,
          type: "OUTWARD",
          source: "SYSTEM",
          remarks: `Receipt Log Edited: ${po.poNumber}`,
          createdBy: req.session?.authUser?.username || "SYSTEM"
        });
      } else {
        // Need to inward MORE stock because new quantity is higher
        const addition = qtyDiff;
        const stockData = {
          [matchField]: po.itemId._id,
          location,
          quantity: addition,
          remarks: `Receipt Log Edited (increased): ${po.poNumber}`,
        };
        await StockModel.create(stockData);

        await StockLogModel.create({
          [matchField]: po.itemId._id,
          location,
          openingStock: currentStock,
          quantity: addition,
          closingStock: currentStock + addition,
          type: "INWARD",
          source: "SYSTEM",
          remarks: `Receipt Log Edited: ${po.poNumber}`,
          createdBy: req.session?.authUser?.username || "SYSTEM"
        });
      }
    }

    // Update PO totals
    po.receivedQuantity = (po.receivedQuantity || 0) + qtyDiff;
    if (po.receivedQuantity >= po.quantity) {
      po.status = "RECEIVED";
    } else if (po.receivedQuantity > 0) {
      po.status = "PARTIALLY_RECEIVED";
    } else {
      po.status = "CONFIRMED"; 
    }
    await po.save();

    // Update Log Record
    log.quantity = Number(newQty);
    if (newRemarks) log.remarks = newRemarks;
    await log.save();

    res.locals.auditDescription = `Edited purchase receipt log for PO "${po.poNumber}" (qty ${oldQty} -> ${newQty})`;
    res.json({ success: true, message: "Receipt log updated successfully" });
  } catch (err) {
    console.error("EDIT PURCHASE LOG ERROR:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ========== DELETE a Purchase Receipt Log (JSON API) ==========
router.delete("/purchase/log/:logId", requireAuth, deleteLimiter, async (req, res) => {
  try {
    const { logId } = req.params;
    const log = await PurchaseOrderLog.findById(logId);
    if (!log) return res.json({ success: false, message: "Log not found" });

    const po = await PurchaseOrder.findById(log.orderId).populate("itemId");
    if (!po) return res.json({ success: false, message: "Order not found" });

    const qtyToRemove = log.quantity || 0;
    const location = log.location;

    // Item-specific stock models
    let StockModel = TapeStock;
    let StockLogModel = TapeStockLog;
    let matchField = "tape";

    if (location && po.itemId && qtyToRemove > 0) {
      // Reverse stock (outward)
      const bal = await StockModel.aggregate([
        { $match: { [matchField]: po.itemId._id, location: location } },
        { $group: { _id: null, qty: { $sum: "$quantity" } } },
      ]);
      const currentStock = bal[0]?.qty || 0;

      if (currentStock < qtyToRemove) {
          return res.json({ success: false, message: `Insufficient stock at ${location} to reverse receipt. Available: ${currentStock}` });
      }

      const stockData = {
        [matchField]: po.itemId._id,
        location,
        quantity: -qtyToRemove,
        remarks: `Receipt Log Deleted (reversed): ${po.poNumber}`,
      };
      await StockModel.create(stockData);

      await StockLogModel.create({
        [matchField]: po.itemId._id,
        location,
        openingStock: currentStock,
        quantity: qtyToRemove,
        closingStock: currentStock - qtyToRemove,
        type: "OUTWARD",
        source: "SYSTEM",
        remarks: `Receipt Log Deleted: ${po.poNumber}`,
        createdBy: req.session?.authUser?.username || "SYSTEM"
      });
    }

    // Update PO totals
    po.receivedQuantity = Math.max((po.receivedQuantity || 0) - qtyToRemove, 0);
    if (po.receivedQuantity === 0) {
      po.status = "CONFIRMED";
    } else if (po.receivedQuantity < po.quantity) {
      po.status = "PARTIALLY_RECEIVED";
    }
    await po.save();

    // Remove the Log Entry
    await PurchaseOrderLog.findByIdAndDelete(logId);

    res.locals.auditDescription = `Deleted purchase receipt log for PO "${po.poNumber}" (qty ${qtyToRemove})`;
    res.json({ success: true, message: "Receipt deleted successfully and stock reversed" });
  } catch (err) {
    console.error("DELETE PURCHASE LOG ERROR:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET: Purchase Order Logs
router.get("/purchase/order/logs", async (req, res) => {
  try {
    const logs = await PurchaseOrderLog.find()
      .populate({
        path: "orderId",
        populate: [
          { path: "vendorUserId", select: "vendorName userName" },
          {
            path: "itemId",
            select:
              "tapeProductId tapePaperCode tapeGsm ttrProductId ttrType ttrWidth ttrMtrs",
          },
        ],
      })
      .sort({ performedAt: -1 })
      .lean();

    res.render("inventory/orders/purchaseLogs.ejs", {
      logs,
      title: "Purchase Action Logs",
      CSS: "tableDisp.css",
      JS: false,
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("PURCHASE LOGS ERROR:", err);
    req.flash("notification", "Failed to load purchase logs");
    res.redirect("/app/purchase/pending");
  }
});

// Update Order Status (with stock deduction / reversal + action logging)
router.post("/sales/order/status", requireAuth, updateLimiter, async (req, res) => {
  try {
    const accepts = req.headers.accept || "";
    const wantsJson = req.xhr || accepts.includes("application/json") || accepts.includes("text/json");
    const { orderId, status, cancelReason, invoiceNumber, confirmDate, confirmQuantity, poNumber, sourceLocation } = req.body;
    const confirmRedirectUrl = orderId ? `/app/sales/order/confirm?orderId=${encodeURIComponent(orderId)}` : "/app/sales/pending";
    let order = await TapeSalesOrder.findById(orderId)
      .populate({ path: "tapeId", select: "tapeFinish tapePaperCode tapeGsm" })
      .lean();

    let ActiveOrderModel = TapeSalesOrder;
    let pendingRedirectUrl = "/app/sales/pending";

    if (!order) {
      const message = "Order not found";
      if (wantsJson) return res.status(404).json({ success: false, message });
      req.flash("notification", message);
      return res.redirect(confirmRedirectUrl);
    }

    const previousStatus = order.status;
    console.log(`[DEBUG] Order ${orderId}: Status change ${previousStatus} -> ${status}`);

    if (status === "CONFIRMED") {
      const incomingPo = String(poNumber || "").trim();
      const existingPo = String(order.poNumber || "").trim();
      if (!incomingPo && !existingPo) {
        const message = "PO Number is required before confirming this order.";
        if (wantsJson) return res.status(400).json({ success: false, message });
        req.flash("notification", message);
        return res.redirect(confirmRedirectUrl);
      }

      const incomingInvoice = String(invoiceNumber || "").trim();
      if (isTemplateOnlyInvoice(incomingInvoice)) {
        const message = "Please enter Invoice Number before submitting the form.";
        if (wantsJson) return res.status(400).json({ success: false, message });
        req.flash("notification", message);
        return res.redirect(confirmRedirectUrl);
      }
    }

    // ========== CONFIRM: Deduct stock ==========
    let finalStatus = status;

    if (status === "CONFIRMED" && previousStatus === "PENDING") {
      const qty = Number(confirmQuantity) || order.quantity;
      const dispatchedSoFar = order.dispatchedQuantity || 0;
      const remaining = order.quantity - dispatchedSoFar;

      if (qty > remaining) {
        const message = `Cannot dispatch ${qty}. Only ${remaining} remaining.`;
        if (wantsJson) {
          return res.status(400).json({ success: false, message });
        }
        req.flash("notification", message);
        return res.redirect(confirmRedirectUrl);
      }

      // Label Stock has no stock concept at all -- confirming just logs
      // delivery and updates the dispatched quantity below, skipping every
      // stock read/write.
      if (order.onModel !== "SachikoLabelStock") {
        const tapeObjectId = new mongoose.Types.ObjectId(order.tapeId._id);
        const location = canonicalizeLocationName(sourceLocation || order.sourceLocation);

        let StockModel = TapeStock;
        let StockLogModel = TapeStockLog;
        let matchField = "tape";

        if (!location) {
          const message = "Cannot confirm: Source location missing on order";
          if (wantsJson) {
            return res.status(400).json({ success: false, message });
          }
          req.flash("notification", message);
          return res.redirect(confirmRedirectUrl);
        }

        const tape = order.tapeId;

        // Match the confirm-page balance: physical stock minus other pending bookings at this location.
        const [bal, bookedAgg] = await Promise.all([
          StockModel.aggregate([
            { $match: { [matchField]: tapeObjectId, location } },
            { $group: { _id: null, qty: { $sum: "$quantity" } } },
          ]),
          TapeSalesOrder.aggregate([
            {
              $match: {
                tapeId: tapeObjectId,
                status: "PENDING",
                sourceLocation: location,
                _id: { $ne: new mongoose.Types.ObjectId(orderId) },
              },
            },
            {
              $group: {
                _id: null,
                bookedQty: {
                  $sum: { $subtract: ["$quantity", { $ifNull: ["$dispatchedQuantity", 0] }] },
                },
              },
            },
          ]),
        ]);
        const currentStock = bal[0]?.qty || 0;
        const bookedQty = bookedAgg[0]?.bookedQty || 0;

        // Validate sufficient stock against physical quantity
        if (currentStock < qty) {
          const message = currentStock <= 0
            ? "cannot dispatch, not enough stocks"
            : `Cannot dispatch ${qty}. Only ${currentStock} available at ${location}.`;
          if (wantsJson) {
            return res.status(400).json({ success: false, message });
          }
          req.flash("notification", message);
          return res.redirect(confirmRedirectUrl);
        }

        // Insert negative stock entry (outward)
        const stockData = {
          [matchField]: tapeObjectId,
          location,
          quantity: -qty,
          remarks: `Sales Order Confirmed: ${orderId}`,
        };

        await StockModel.create(stockData);

        // Stock Log entry
        const logData = {
          [matchField]: tapeObjectId,
          location,
          openingStock: currentStock,
          quantity: qty,
          closingStock: currentStock - qty,
          type: "OUTWARD",
          source: "SYSTEM",
          remarks: `Sales Order Confirmed: ${orderId}`,
          createdBy: req.user?.username || "SYSTEM",
        };
        await StockLogModel.create(logData);
      }

      // Calculate action time: Use Confirm Date (for date) + Current Time (for time)
      const now = new Date();
      let actionTime = now;
      if (confirmDate) {
        const [y, m, d] = confirmDate.split("-").map(Number);
        actionTime = new Date(y, m - 1, d, now.getHours(), now.getMinutes(), now.getSeconds());
      }

      // Action Log entry
      await SalesOrderLog.create({
        orderId,
        action: "DELIVERED",
        invoiceNumber: invoiceNumber || "",
        quantity: qty,
        performedBy: req.user?.username || "SYSTEM",
        performedAt: actionTime,
      });

      // Calculate new dispatched quantity
      const newDispatched = dispatchedSoFar + qty;

      // Determine if fully dispatched
      if (newDispatched >= order.quantity) {
        finalStatus = "CONFIRMED";
      } else {
        finalStatus = "PENDING";
      }

      // Update dispatched quantity immediately to be safe, status will be updated below
      await ActiveOrderModel.findByIdAndUpdate(orderId, { dispatchedQuantity: newDispatched });

      console.log(
        `[DEBUG] Stock deduction + action log successful. Dispatched: ${qty}, Total: ${newDispatched}/${order.quantity}, New Status: ${finalStatus}`,
      );
    } else if (status === "CONFIRMED") {
      console.log(`[DEBUG] Skipping deduction. Status: ${status}, Previous: ${previousStatus}`);
    }

    // ========== CANCEL: Log with reason ==========
    if (status === "CANCELLED" && previousStatus === "PENDING") {
      // Action Log entry for cancel from PENDING
      await SalesOrderLog.create({
        orderId,
        action: "CANCELLED",
        cancelReason: cancelReason || "No reason provided",
        quantity: order.quantity,
        performedBy: req.user?.username || "SYSTEM",
      });
    }

    // ========== CANCEL a CONFIRMED order: Reverse stock ==========
    if (status === "CANCELLED" && previousStatus === "CONFIRMED") {
      // TODO: Should this be dispatchedQuantity? For now assume cancelling full order if it was fully confirmed. Or partial?
      // If partial dispatch was supported, we really need to know *what* to reverse.
      // But assuming CONFIRMED means *fully* dispatched for now (or at least that's the only state we reverse from).
      // If it's PENDING but partially dispatched, and we cancel... we should reverse dispatchedQuantity.
      const qtyToReverse = order.dispatchedQuantity > 0 ? order.dispatchedQuantity : order.quantity;

      // Label Stock has no stock to reverse -- just log the cancellation and
      // reset dispatched qty below, skipping every stock read/write.
      if (order.onModel !== "SachikoLabelStock") {
        const tapeObjectId = new mongoose.Types.ObjectId(order.tapeId._id);
        const location = order.sourceLocation;
        const tape = order.tapeId;

        let StockModel = TapeStock;
        let StockLogModel = TapeStockLog;
        let matchField = "tape";

        // Get current stock at this location
        const bal = await StockModel.aggregate([
          { $match: { [matchField]: tapeObjectId, location } },
          { $group: { _id: null, qty: { $sum: "$quantity" } } },
        ]);
        const currentStock = bal[0]?.qty || 0;

        // Re-add stock (positive entry)
        const stockData = {
          [matchField]: tapeObjectId,
          location,
          quantity: qtyToReverse,
          remarks: `Sales Order Cancelled (reversed): ${orderId}`,
        };

        await StockModel.create(stockData);

        // Stock Log entry
        const logData = {
          [matchField]: tapeObjectId,
          location,
          openingStock: currentStock,
          quantity: qtyToReverse,
          closingStock: currentStock + qtyToReverse,
          type: "INWARD",
          source: "SYSTEM",
          remarks: `Sales Order Cancelled (reversed): ${orderId}`,
          createdBy: req.user?.username || "SYSTEM",
        };
        await StockLogModel.create(logData);
      }

      // Action Log entry for cancel from CONFIRMED
      await SalesOrderLog.create({
        orderId,
        action: "CANCELLED",
        cancelReason: cancelReason || "No reason provided",
        quantity: qtyToReverse,
        performedBy: req.user?.username || "SYSTEM",
      });

      // Reset dispatched qty
      await ActiveOrderModel.findByIdAndUpdate(orderId, { dispatchedQuantity: 0 });
    }

    // Update order status and PO number (if submitted on confirm page)
    const updateData = { status: finalStatus };
    if (typeof poNumber !== "undefined") {
      const incomingPo = String(poNumber || "").trim();
      if (incomingPo) updateData.poNumber = incomingPo;
    }
    await ActiveOrderModel.findByIdAndUpdate(orderId, updateData);

    // Keep the Production queue in sync: a Label Stock order re-entering
    // PENDING (partial dispatch) gets upserted back in; anything else
    // (fully confirmed/dispatched, or cancelled) comes off the queue. Plain
    // Tape orders are untouched -- upsertPendingProduction/removePendingProduction
    // no-op for anything that isn't onModel "SachikoLabelStock".
    if (order.onModel === "SachikoLabelStock") {
      if (finalStatus === "PENDING") {
        const freshOrder = await TapeSalesOrder.findById(orderId).lean();
        await upsertPendingProduction(freshOrder);
      } else {
        await removePendingProduction(orderId);
      }
    }

    const orderUser = await Username.findById(order.userId).select("clientName").lean();
    res.locals.auditDescription = `Updated ${order.onModel} sales order to "${finalStatus}" for "${orderUser?.clientName || "Unknown Client"}" (order ${orderId})`;

    if (finalStatus === "PENDING" && status === "CONFIRMED") {
      req.flash("notification", `Partially dispatched. remaining is pending.`);
    } else if (status === "CANCELLED") {
      req.flash("notification", "order deleted");
    } else {
      req.flash("notification", `Order status updated to ${finalStatus}`);
    }
    if (wantsJson) {
      res.json({ success: true, redirect: pendingRedirectUrl });
    } else {
      res.redirect(pendingRedirectUrl);
    }
  } catch (err) {
    console.error("STATUS UPDATE ERROR:", err);
    const accepts = req.headers.accept || "";
    const wantsJson = req.xhr || accepts.includes("application/json") || accepts.includes("text/json");
    if (wantsJson) {
      res.status(400).json({ success: false, message: "Failed to update status" });
    } else {
      req.flash("notification", "Failed to update status");
      res.redirect("back");
    }
  }
});

// ========== EDIT a Dispatch Log (JSON API) ==========
router.put("/sales/order/log/:logId", requireAuth, updateLimiter, async (req, res) => {
  try {
    const { logId } = req.params;
    const { quantity: newQty, invoiceNumber, date } = req.body;

    const log = await SalesOrderLog.findById(logId).lean();
    if (!log) return res.json({ success: false, message: "Log not found" });

    const order = await TapeSalesOrder.findById(log.orderId).populate({ path: "tapeId", select: "tapeFinish" }).lean();
    if (!order) return res.json({ success: false, message: "Order not found" });

    const oldQty = log.quantity;
    const qtyDiff = Number(newQty) - oldQty;
    const tapeObjectId = new mongoose.Types.ObjectId(order.tapeId._id);
    const location = order.sourceLocation;
    const tape = order.tapeId;

    let StockModel = TapeStock;
    let StockLogModel = TapeStockLog;
    let matchField = "tape";

    if (location && tape && qtyDiff !== 0) {
      // Get current stock at location
      const bal = await StockModel.aggregate([
        { $match: { [matchField]: tapeObjectId, location } },
        { $group: { _id: null, qty: { $sum: "$quantity" } } },
      ]);
      const currentStock = bal[0]?.qty || 0;

      if (qtyDiff > 0) {
        // Need to deduct MORE stock
        if (currentStock < qtyDiff) {
          return res.json({
            success: false,
            message: `Insufficient stock at ${location}. Available: ${currentStock}, Additional needed: ${qtyDiff}`,
          });
        }

        const stockData = {
          [matchField]: tapeObjectId,
          location,
          quantity: -qtyDiff,
          remarks: `Log Edit (additional deduction): ${log.orderId}`,
        };

        await StockModel.create(stockData);

        const logData = {
          [matchField]: tapeObjectId,
          location,
          openingStock: currentStock,
          quantity: qtyDiff,
          closingStock: currentStock - qtyDiff,
          type: "OUTWARD",
          source: "SYSTEM",
          remarks: `Log Edit (additional deduction): ${log.orderId}`,
          createdBy: req.user?.username || "SYSTEM",
        };
        await StockLogModel.create(logData);
      } else {
        // Reverse some stock (qtyDiff is negative, so -qtyDiff is positive)
        const reverseQty = -qtyDiff;

        const stockData = {
          [matchField]: tapeObjectId,
          location,
          quantity: reverseQty,
          remarks: `Log Edit (partial reversal): ${log.orderId}`,
        };

        await StockModel.create(stockData);

        const logData = {
          [matchField]: tapeObjectId,
          location,
          openingStock: currentStock,
          quantity: reverseQty,
          closingStock: currentStock + reverseQty,
          type: "INWARD",
          source: "SYSTEM",
          remarks: `Log Edit (partial reversal): ${log.orderId}`,
          createdBy: req.user?.username || "SYSTEM",
        };
        await StockLogModel.create(logData);
      }
    }

    // Update dispatched quantity on the order
    const newDispatched = (order.dispatchedQuantity || 0) + qtyDiff;
    const newStatus = newDispatched >= order.quantity ? "CONFIRMED" : "PENDING";

    await TapeSalesOrder.findByIdAndUpdate(order._id, {
      dispatchedQuantity: newDispatched,
      status: newStatus,
    });

    // Calculate action time using the provided date + current time
    const now = new Date();
    let actionTime = now;
    if (date) {
      const [y, m, d] = date.split("-").map(Number);
      actionTime = new Date(y, m - 1, d, now.getHours(), now.getMinutes(), now.getSeconds());
    }

    // Update the log entry
    await SalesOrderLog.findByIdAndUpdate(logId, {
      quantity: Number(newQty),
      invoiceNumber: invoiceNumber || "",
      performedAt: actionTime,
    });

    const orderUser = await Username.findById(order.userId).select("clientName").lean();
    res.locals.auditDescription = `Edited dispatch log for "${orderUser?.clientName || "Unknown Client"}" (qty ${oldQty} -> ${newQty}, invoice ${invoiceNumber || "-"})`;
    return res.json({ success: true });
  } catch (err) {
    console.error("EDIT LOG ERROR:", err);
    return res.json({ success: false, message: "Server error" });
  }
});

// ========== DELETE a Dispatch Log (JSON API) ==========
router.delete("/sales/order/log/:logId", requireAuth, deleteLimiter, async (req, res) => {
  try {
    const { logId } = req.params;

    const log = await SalesOrderLog.findById(logId).lean();
    if (!log) return res.json({ success: false, message: "Log not found" });

    const order = await TapeSalesOrder.findById(log.orderId).populate({ path: "tapeId", select: "tapeFinish" }).lean();
    if (!order) return res.json({ success: false, message: "Order not found" });

    const tapeObjectId = new mongoose.Types.ObjectId(order.tapeId._id);
    const location = order.sourceLocation;
    const tape = order.tapeId;
    const qty = log.quantity;

    let StockModel = TapeStock;
    let StockLogModel = TapeStockLog;
    let matchField = "tape";

    // Reverse stock deduction (add stock back)
    if (location && tape && qty > 0) {
      const bal = await StockModel.aggregate([
        { $match: { [matchField]: tapeObjectId, location } },
        { $group: { _id: null, qty: { $sum: "$quantity" } } },
      ]);
      const currentStock = bal[0]?.qty || 0;

      const stockData = {
        [matchField]: tapeObjectId,
        location,
        quantity: qty,
        remarks: `Log Deleted (reversed): ${log.orderId}`,
      };

      await StockModel.create(stockData);

      const logData = {
        [matchField]: tapeObjectId,
        location,
        openingStock: currentStock,
        quantity: qty,
        closingStock: currentStock + qty,
        type: "INWARD",
        source: "SYSTEM",
        remarks: `Log Deleted (reversed): ${log.orderId}`,
        createdBy: req.user?.username || "SYSTEM",
      };
      await StockLogModel.create(logData);
    }

    // Update dispatched quantity on the order
    const newDispatched = Math.max(0, (order.dispatchedQuantity || 0) - qty);
    const newStatus = newDispatched >= order.quantity ? "CONFIRMED" : "PENDING";

    await TapeSalesOrder.findByIdAndUpdate(order._id, {
      dispatchedQuantity: newDispatched,
      status: newStatus,
    });

    // Delete the log entry
    await SalesOrderLog.findByIdAndDelete(logId);

    const orderUser = await Username.findById(order.userId).select("clientName").lean();
    res.locals.auditDescription = `Deleted dispatch log for "${orderUser?.clientName || "Unknown Client"}" (qty ${qty})`;
    return res.json({ success: true });
  } catch (err) {
    console.error("DELETE LOG ERROR:", err);
    return res.json({ success: false, message: "Server error" });
  }
});

// Legacy route redirect
router.get("/form/salesorder", (req, res) => {
  res.redirect("/app/sales/order");
});

// ----------------------------------Sales Calculator---------------------------------->
// route for salescalc form.
router.get("/form/salescalc", async (req, res) => {
  let clients = await Client.distinct("clientName");
  res.render("utilities/salesCalc.ejs", {
    clients,
    title: "Sales Calculator",
    JS: "salesCalc.js",
    CSS: false,
    notification: req.flash("notification"),
  });
});

// Route to handle salescalc form submission.
router.post("/form/salescalc", requireAuth, createLimiter, async (req, res) => {
  let formData = req.body;

  await Calculator.create(formData);
  res.send("Sales Calculation created successfully!");
});

// ----------------------------------Production Calculator---------------------------------->
router.get("/form/prodcalc", async (req, res) => {
  let clients = await Client.distinct("clientName");
  res.render("utilities/prodCalc.ejs", {
    title: "Production Calculator",
    CSS: false,
    JS: "prodCalc.js",
    clients,
    notification: req.flash("notification"),
  });
});

router.get("/form/prodcalc/data", async (req, res) => {
  let { w, h, client } = req.query;
  let clients = await Calculator.findOne({ companyName: client, labelWidth: w, labelHeight: h });
  res.status(200).json(clients);
});

router.post("/form/prodcalc", requireAuth, createLimiter, async (req, res) => {
  let formData = req.body;

  await Calculator.create(formData);
  res.send("Production Calculation created successfully!");
});

// ----------------------------------Production Binding View---------------------------------->
// "Prod Bind View" -- a read-only browse of what's been saved via Prod
// Binding above. FAIRTECH split a dedicated ProductionBinding entity (with
// die/block/vendor-paper matching) out of this same calculator collection;
// that entity models FAIRTECH's die-cut label production and has no
// equivalent here (Sachiko's Label Stock orders carry their own material
// spec already -- see CLAUDE.md's Assign Production section), so this stays
// a plain list/detail view over the schemaless Calculator collection instead.
router.get("/prodcalc/view", async (req, res) => {
  const entries = await Calculator.find({}).sort({ _id: -1 }).lean();
  const jsonData = entries.map((e) => ({
    ...e,
    _id: String(e._id),
    createdAt: e._id.getTimestamp(),
  }));

  res.render("utilities/prodCalcView.ejs", {
    title: "Production Binding View",
    CSS: "tableDisp.css",
    JS: false,
    jsonData,
    notification: req.flash("notification"),
  });
});

router.get("/prodcalc/details/:id", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    req.flash("notification", "Invalid production binding id.");
    return res.redirect("/app/prodcalc/view");
  }

  const doc = await Calculator.findById(req.params.id).lean();
  if (!doc) {
    req.flash("notification", "Production binding not found.");
    return res.redirect("/app/prodcalc/view");
  }

  const binding = { ...doc, _id: String(doc._id), createdAt: doc._id.getTimestamp() };

  res.render("utilities/prodCalcDetail.ejs", {
    title: "Production Binding Details",
    CSS: "tableDisp.css",
    JS: false,
    binding,
    notification: req.flash("notification"),
  });
});

// ----------------------------------Pending / WIP Production---------------------------------->
// Live-synced off Label Stock orders by utils/pendingProduction.js -- see
// CLAUDE.md's "Production pipeline" section for the full order -> assign ->
// job card lifecycle.

// What the WIP tab's "Live Status" is drawn from -- see GET
// /labels/production/wip-progress, which polls it.
//
// A MachineJobCard is written ONCE, by Save Production Entry, at the END of
// the job. Reading only cards is what made this column wrong for the whole
// time it matters: a job could be hours in, with reels mounted and Deckles
// already inwarded to Semi Finished Stock, and still read "Not started"
// until the operator finally saved. Three things the shop floor writes as it
// goes fill that in, all of them already there to be read
// (routes/system/machine.js, routes/api/operatorApi.js):
//
//   - a Deckle per Production Log row the moment its Stop is punched
//     (MaterialStock.producedFor + producedVia "jobcard") -- real metres;
//   - PendingProduction.runningOn, claimed at the first Job Setting Start and
//     heartbeated by that device -- an operator is on it right now;
//   - PendingProduction.liveMaterialInUse, the reels scanned onto the machine;
//   - PendingProduction.liveRun, the deckle row whose Start was punched and
//     whose Stop hasn't been -- the one on the machine now, and since when.
//     It is what the Live column's ETA counts from (utils/productionEta.js);
//   - PendingProduction.liveSetting / liveStartedAt, the Job Setting row
//     running now and when the job was first played -- the Live column's
//     JOB SETTING and STARTED phases;
//   - PendingProduction.livePause / livePauseLog, the hold the operator app
//     has the job on now, and every hold it has come out of -- the Live
//     column's PAUSED phase, and the time taken out of the job's clock.
//
// A Deckle that a filed card already accounts for is counted ONCE: the card's
// own Production Log row carries the same rowToken (and deckleId) the Deckle
// was minted with, so it is matched and skipped rather than added again.
export async function buildJobCardProgressMap(pendingIds) {
  if (!pendingIds.length) return new Map();
  // Oldest first, so an order run across more than one Job Card (a mid-order
  // job switch -- see routes/system/machine.js's producedRolls accumulation)
  // has its rows concatenated in the order they were produced.
  const [cards, liveDeckles, liveOrders] = await Promise.all([
    MachineJobCard.find({ pendingProductionId: { $in: pendingIds } })
      .select("pendingProductionId jobCardId date jobSetting productionLog createdAt updatedAt")
      .sort({ updatedAt: 1 })
      .lean(),
    // producedVia "jobcard" only: a Deckle laminated at Assign & Continue
    // ("assign") is the order's raw material being made ready, not a metre it
    // has run -- counting those would show every freshly assigned order as
    // part-produced before anyone touched the machine.
    MaterialStock.find({ producedFor: { $in: pendingIds }, producedVia: "jobcard" })
      .select("producedFor rollId reelMtrs productionRowToken productionTime productionJoints joints createdAt")
      .sort({ createdAt: 1 })
      .lean(),
    PendingProduction.find({ _id: { $in: pendingIds } })
      .select("runningOn liveMaterialInUse liveRun liveSetting liveStartedAt livePause livePauseLog overtimeLog")
      .lean(),
  ]);
  const numberOrNull = (value) => (
    value !== undefined && value !== null && value !== "" && Number.isFinite(Number(value))
      ? Number(value)
      : null
  );
  const map = new Map();
  // Only orders with something to say get an entry -- an order nobody has
  // touched must stay absent, so the column still reads "Not started".
  const blank = () => ({
    jobCardId: "", settings: [], production: [], totalMeters: 0, updatedAt: null,
    // set below: whether any figure here is still un-filed, whether a device
    // is on the job now, and how many reels are mounted.
    // `started`: an operator has begun this job -- a Start punched, reels
    // scanned, a Deckle made, or a card filed. It is what the WIP tab lists
    // on, so a row there is always a job that is actually running.
    started: true, live: false, running: false, runningOn: null, mounted: 0,
    // When the last deckle came off (the Finished column's "@ time"), and
    // the deckle on the machine now ({ startedAt, startTime, startMtrs }).
    lastDoneAt: null, currentRun: null,
    // The Job Setting row running now ({ startedAt, startTime, startMtrs }),
    // and when the job was first played.
    setting: null, jobStartedAt: null,
    // The hold the job is on now ({ since, reason, deviceLabel }), and the
    // holds this run has already come out of ([{ from, to, reason }]).
    paused: null, pauses: [],
    // The operator's "why was it late?" remarks ([{ deckleIndex, runStartedAt, remark, at, byName }]).
    overtimeRemarks: [],
  });
  const laterOf = (a, b) => (!a ? b : !b ? a : new Date(a) > new Date(b) ? a : b);
  // When each order's last deckle was finished. A Deckle's createdAt is its
  // Stop punch (it is inwarded right then), so the Deckles answer this whether
  // or not a card has filed them yet. Only an order with filed rows and no
  // Deckle at all (the save couldn't make them) falls back to the card's save.
  const lastDeckleAt = new Map();
  const lastCardAt = new Map();
  // Deckles a filed card already accounts for, per order -- by rowToken (the
  // idempotency key both the card row and the Deckle carry) and by Deckle id.
  const claimedDeckles = new Map();
  const deckleKeys = (key) => {
    let set = claimedDeckles.get(key);
    if (!set) { set = new Set(); claimedDeckles.set(key, set); }
    return set;
  };
  const normDeckleId = (value) => String(value ?? "").trim().toUpperCase();
  // When each Deckle came off -- its createdAt is the Stop punch -- by the
  // two keys a card row names it by, so a filed row can be dated exactly too
  // (the dialog's Production Log Date column). A row whose Deckle was never
  // made falls back to its card's own date.
  const deckleMadeAt = new Map();
  liveDeckles.forEach((deckle) => {
    if (!deckle.createdAt) return;
    const key = String(deckle.producedFor);
    if (deckle.productionRowToken) deckleMadeAt.set(`${key}|t:${String(deckle.productionRowToken).trim()}`, deckle.createdAt);
    if (deckle.rollId) deckleMadeAt.set(`${key}|d:${normDeckleId(deckle.rollId)}`, deckle.createdAt);
  });

  cards.forEach((card) => {
    const key = String(card.pendingProductionId);
    const acc = map.get(key) || blank();
    // Every row of the card, not just the ones that survive the filter below:
    // a row saved with no metres still names the Deckle it made, and that
    // Deckle must not then be added a second time as "live".
    (card.productionLog || []).forEach((row) => {
      if (row?.rowToken) deckleKeys(key).add(`t:${String(row.rowToken).trim()}`);
      if (row?.deckleId) deckleKeys(key).add(`d:${normDeckleId(row.deckleId)}`);
    });

    (card.jobSetting || [])
      .filter((row) => row?.rollId || row?.mtrs1 != null || row?.mtrs2 != null || row?.startTime || row?.stopTime)
      .forEach((row) => {
        acc.settings.push({
          index: acc.settings.length + 1,
          rollId: row.rollId || "",
          startMtrs: numberOrNull(row.mtrs1),
          stopMtrs: numberOrNull(row.mtrs2),
          startTime: row.startTime || "",
          stopTime: row.stopTime || "",
          completed: Boolean(row.stopTime),
        });
      });

    (card.productionLog || [])
      .filter((row) => Number.isFinite(Number(row?.meters)) && Number(row.meters) > 0)
      .forEach((row) => {
        acc.production.push({
          index: acc.production.length + 1,
          deckleId: row.deckleId || "",
          meters: Number(row.meters),
          startTime: row.time?.startTime || "",
          endTime: row.time?.endTime || "",
          faceJoint: row.face?.joint || "",
          faceMtrs: numberOrNull(row.face?.mtr),
          releaseJoint: row.release?.joint || "",
          releaseMtrs: numberOrNull(row.release?.mtr),
          producedAt: (row.rowToken && deckleMadeAt.get(`${key}|t:${String(row.rowToken).trim()}`))
            || (row.deckleId && deckleMadeAt.get(`${key}|d:${normDeckleId(row.deckleId)}`))
            || null,
          cardDate: card.date || null,
        });
      });

    acc.totalMeters = acc.production.reduce((sum, row) => sum + row.meters, 0);
    if ((card.productionLog || []).some((row) => Number(row?.meters) > 0)) {
      lastCardAt.set(key, laterOf(lastCardAt.get(key) || null, card.createdAt || card.updatedAt || null));
    }
    // Latest card wins for the header id/timestamp (cards are oldest-first).
    acc.jobCardId = card.jobCardId;
    acc.updatedAt = card.updatedAt;
    map.set(key, acc);
  });

  // ---- Deckles made since (or without) a card: the metres actually run ----
  liveDeckles.forEach((deckle) => {
    const key = String(deckle.producedFor);
    // Every Deckle, filed on a card or not, is a finished deckle.
    lastDeckleAt.set(key, laterOf(lastDeckleAt.get(key) || null, deckle.createdAt || null));
    const seen = deckleKeys(key);
    const token = deckle.productionRowToken ? `t:${String(deckle.productionRowToken).trim()}` : null;
    const rollKey = deckle.rollId ? `d:${normDeckleId(deckle.rollId)}` : null;
    if ((token && seen.has(token)) || (rollKey && seen.has(rollKey))) return;   // already on a card
    if (token) seen.add(token);
    if (rollKey) seen.add(rollKey);

    const acc = map.get(key) || blank();
    acc.production.push({
      index: acc.production.length + 1,
      deckleId: deckle.rollId || "",
      meters: Number(deckle.reelMtrs) || 0,
      // Punched on the card row and stored on the Deckle at Stop. A Deckle
      // made before the times were stored has neither; the dialog then falls
      // back to producedAt (the Stop punch itself) for the END time only.
      startTime: deckle.productionTime?.startTime || "",
      endTime: deckle.productionTime?.endTime || "",
      // Joint / Wrinkle per web, stored on the Deckle at Stop
      // (productionJoints) because the card that holds them isn't written
      // yet. A Deckle made before that has only `joints`, one label merging
      // both webs: absent, the run was clean on both (every jobcard Deckle
      // has been minted with it -- it is omitted only for a clean run);
      // present, it can't say which web, so it travels as jointsUnattributed
      // rather than being filed under one of them.
      faceJoint: deckle.productionJoints?.face?.joint || "",
      faceMtrs: numberOrNull(deckle.productionJoints?.face?.mtr),
      releaseJoint: deckle.productionJoints?.release?.joint || "",
      releaseMtrs: numberOrNull(deckle.productionJoints?.release?.mtr),
      jointsUnattributed: !deckle.productionJoints && deckle.joints ? deckle.joints : "",
      producedAt: deckle.createdAt || null,
      live: true,
    });
    acc.totalMeters = acc.production.reduce((sum, row) => sum + row.meters, 0);
    acc.updatedAt = laterOf(acc.updatedAt, deckle.createdAt);
    acc.live = true;
    map.set(key, acc);
  });

  // ---- and who is on the job right now, with nothing produced yet ----
  // `runningOn` is claimed at the first Job Setting Start and cleared only
  // when the card saves, so its mere PRESENCE is "this job has been started".
  // Its freshness is a different question -- a tablet that dies stops
  // heartbeating, and the job is still started, just not being punched at
  // this moment. Membership uses the first, the "Running" badge the second.
  liveOrders.forEach((order) => {
    const key = String(order._id);
    const claimed = Boolean(order.runningOn?.deviceId);
    const held = activeClaim(order.runningOn);
    const mounted = Object.values(order.liveMaterialInUse || {})
      .reduce((n, reels) => n + (Array.isArray(reels) ? reels.filter(Boolean).length : 0), 0);
    // A run whose row already has a Deckle (on a card or in stock) is over,
    // even if the Stop that made it failed to clear it -- never show a deckle
    // as running once it is made.
    const run = order.liveRun;
    const runToken = String(run?.rowToken || "").trim();
    const currentRun = runToken && run.startedAt && !deckleKeys(key).has(`t:${runToken}`)
      ? { startedAt: run.startedAt, startTime: run.startTime || "", startMtrs: run.startMtrs ?? null }
      : null;
    const setting = order.liveSetting?.startedAt
      ? { startedAt: order.liveSetting.startedAt, startTime: order.liveSetting.startTime || "", startMtrs: order.liveSetting.startMtrs ?? null }
      : null;
    // When the job was played: its first punch. A job punched before that was
    // recorded falls back to the app's running claim -- which a re-claim
    // moves, so it is only the best that is known for those.
    const jobStartedAt = order.liveStartedAt || order.runningOn?.claimedAt || null;
    const paused = order.livePause?.since
      ? { since: order.livePause.since, reason: order.livePause.reason || "", deviceLabel: order.livePause.deviceLabel || "" }
      : null;
    const pauses = (Array.isArray(order.livePauseLog) ? order.livePauseLog : [])
      .filter((p) => p?.from && p?.to)
      .map((p) => ({ from: p.from, to: p.to, reason: p.reason || "" }));
    if (!claimed && !mounted && !currentRun && !setting && !order.liveStartedAt && !paused) return;

    const acc = map.get(key) || blank();
    acc.currentRun = currentRun;
    acc.setting = setting;
    acc.jobStartedAt = jobStartedAt;
    acc.paused = paused;
    acc.pauses = pauses;
    acc.overtimeRemarks = (Array.isArray(order.overtimeLog) ? order.overtimeLog : [])
      .filter((e) => String(e?.remark || "").trim())
      .map((e) => ({
        deckleIndex: e.deckleIndex ?? null,
        runStartedAt: e.runStartedAt ? new Date(e.runStartedAt).getTime() : null,
        remark: e.remark,
        at: e.at ? new Date(e.at).getTime() : null,
        byName: e.byName || "",
      }));
    acc.started = true;
    acc.running = Boolean(held);
    acc.runningOn = claimed
      ? {
          deviceLabel: order.runningOn.deviceLabel || "",
          claimedAt: order.runningOn.claimedAt || null,
          lastSeenAt: order.runningOn.lastSeenAt || null,
          stale: !held,
        }
      : null;
    acc.mounted = mounted;
    // A live job with nothing on a card yet still has a "when": the last
    // heartbeat is the most recent thing known about it.
    acc.updatedAt = laterOf(acc.updatedAt, order.runningOn?.lastSeenAt || null);
    acc.updatedAt = laterOf(acc.updatedAt, currentRun?.startedAt || null);
    acc.updatedAt = laterOf(acc.updatedAt, setting?.startedAt || null);
    acc.updatedAt = laterOf(acc.updatedAt, paused?.since || null);
    map.set(key, acc);
  });

  map.forEach((acc, key) => {
    acc.lastDoneAt = lastDeckleAt.get(key) || lastCardAt.get(key) || null;
  });

  return map;
}

// ---- Deckle Set shared helpers (used by the list page, the per-group Set
// Deckle planning page, and the batch-forming POST below) --------------------
const dsNum = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
// Sq. metres for one order = paper width (mm) x running length (m) / 1000 x qty.
const dsSqM = (width, lengthM, qty) =>
  Math.round((dsNum(width) * dsNum(lengthM) / 1000 * dsNum(qty)) * 100) / 100;

// One member order, shaped for the Deckle Set table's child rows and the
// planning page's order picker.
const dsFmtChild = (r) => ({
  _id: String(r._id),
  isGroup: false,
  clientName: r.userId?.clientName || r.userId?.userName || (r.isAdvance ? "ADVANCE ORDER" : "—"),
  poNumber: r.poNumber || "—",
  paperSize: r.paperSize || "—",
  quantity: r.quantity ?? "—",
  runningMeters: r.runningMeters != null && r.runningMeters !== "" ? Number(r.runningMeters) : null,
  sqMtr: dsSqM(r.paperSize, r.runningMeters, r.quantity),
  noOfRolls: r.noOfRolls ?? "—",
  estimatedDate: r.estimatedDate || null,
  remarks: r.remarks || "",
  isAdvance: !!r.isAdvance,
});

// One Product-Code group of loose orders: the sums shown on the list row plus
// everything the size picker needs (suggestDeckleSize sizes the web to the
// widest single member -- orders are slit off the one web, not laid side by
// side). `item` is the populated itemId (SachikoLabelStock w/ .facestock).
async function buildLooseDeckleRow(item, members) {
  const sumRolls = members.reduce((s, m) => s + dsNum(m.noOfRolls), 0);
  const maxOrderWidth = members.reduce(
    (w, m) => Math.max(w, dsNum(m.paperSize) * (dsNum(m.noOfRolls) || 1)),
    0,
  );
  const { neededWidth, rollsWidth, edgeTrim, sizes, suggestedSize, short } = await suggestDeckleSize({
    labelStock: item,
    paperSize: maxOrderWidth || undefined,
    noOfRolls: 1,
  });
  return {
    _id: `grp:${String(item._id || "none")}`,
    isGroup: true,
    isBatch: false,
    itemId: String(item._id || ""),
    productCode: item.productCode || item.skuCode || "—",
    paperSize: "",
    rollType: item.rollType || "—",
    orderCount: members.length,
    advanceCount: members.filter((m) => m.isAdvance).length,
    sumQuantity: members.reduce((s, m) => s + dsNum(m.quantity), 0),
    sumRunningMeters: members.reduce((s, m) => s + dsNum(m.runningMeters), 0),
    sumSqMtr: Math.round(members.reduce((s, m) => s + dsSqM(m.paperSize, m.runningMeters, m.quantity), 0) * 100) / 100,
    sumRolls,
    neededWidth,
    rollsWidth,
    edgeTrim,
    candidateSizes: sizes,
    suggestedSize,
    short,
    _children: members
      .map(dsFmtChild)
      .sort((a, b) => new Date(a.estimatedDate || 0) - new Date(b.estimatedDate || 0)),
  };
}

// Every facestock width actually on the shelf, with what is behind it.
// suggestDeckleSize() does the same roll-up for the Set Deckle page but
// narrows it to the reels matching that order's recipe -- the calculator has
// no recipe to narrow by, so it offers every width the store holds and says
// how many reels and how much weight sit behind each, which is the bit that
// decides whether a width is really an option.
async function facestockSizesInStock() {
  const reels = await POOL_MODELS.facestock.Model.find({ quantity: { $gt: 0 }, reelMtrs: { $gt: 0 } })
    .select("size reelMtrs")
    .lean();
  const bySize = new Map();
  for (const r of reels) {
    const size = Number(r.size);
    if (!Number.isFinite(size) || size <= 0) continue;
    const e = bySize.get(size) || { size, reelCount: 0, totalKg: 0 };
    e.reelCount += 1;
    // FacestockStock.reelMtrs is Kg despite its name -- see the note in
    // suggestDeckleSize() (utils/labelStockProduction.js).
    e.totalKg = Math.round((e.totalKg + (Number(r.reelMtrs) || 0)) * 100) / 100;
    bySize.set(size, e);
  }
  return [...bySize.values()].sort((a, b) => a.size - b.size);
}

// Deckle Calculator -- the Set Deckle planner with nothing behind it. Same
// web view, same layout dialog, same grace panel, same AI Deckle Set and the
// same figures as /labels/production/deckle-set/plan/:itemId, but the
// requirements are typed rather than read off loose orders, and there is no
// end to it: the page creates no batch, touches no order and writes nothing.
// It is for answering "what would this job cost me in trim" before there is an
// order to plan.
//
// The one thing it does read is the store: Available Sizes opens on the
// facestock widths actually in stock, so a plan starts from reels that exist
// rather than from a blank list. They are only a starting point -- the pencil
// adds and removes sizes exactly as it does on the Set Deckle page.
router.get("/labels/production/deckle-calculator", async (req, res) => {
  res.render("utilities/deckleCalculator.ejs", {
    title: "Deckle Calculator",
    CSS: "deckleCalculator.css",
    JS: "deckleCalculator.js",
    cutSlots: CUT_SLOTS,
    edgeTrimPerSide: DECKLE_EDGE_TRIM_MM,
    defaultRunningMeters: DEFAULT_DECKLE_RUNNING_METERS,
    stockSizes: await facestockSizesInStock(),
    // Same kill switch as the Set Deckle page's own panel -- with
    // DECKLE_AUTO_ENABLED=false the calculator renders with no AI Deckle Set
    // panel and no client code for it, and the endpoint below returns 503.
    autoDeckle: isDeckleAutoEnabled()
      ? {
          enabled: true,
          defaultRunningMeters: DEFAULT_DECKLE_RUNNING_METERS,
          overrun: OVERRUN_DEFAULTS,
        }
      : { enabled: false },
    notification: req.flash("notification"),
  });
});

// AI Deckle Set for the calculator -- the same utils/deckleOptimizer the Set
// Deckle page uses, over requirements that were typed rather than ordered.
//
// The sister endpoint (/deckle-set/plan/:itemId/auto) re-reads its orders from
// the database on purpose: there the client picks WHICH orders to plan, never
// what they say. Here there is nothing to re-read -- the requirements only
// exist on the page -- and nothing to protect either: this handler owns no
// data, looks nothing up and writes nothing, so a doctored request can only
// produce a wrong answer in the asker's own browser. planDeckleLayouts()
// range-checks every figure it is given and runs under its own node and time
// budgets, which is what keeps a silly request from being an expensive one.
router.post(
  "/labels/production/deckle-calculator/auto",
  requireAuth,
  updateLimiter,
  async (req, res) => {
    if (!isDeckleAutoEnabled()) {
      return res.status(503).json({
        ok: false,
        disabled: true,
        error: "AI Deckle Set is switched off on this server.",
      });
    }

    // A ceiling on how much can be asked for in one go. The optimizer is
    // bounded in time, but pattern enumeration grows with the number of
    // DISTINCT widths, and a page a person typed will never come near this.
    const MAX_LINES = 100;
    const lines = (Array.isArray(req.body?.orders) ? req.body.orders : []).slice(0, MAX_LINES);
    if (!lines.length) {
      return res.status(400).json({ ok: false, error: "Enter at least one requirement to plan." });
    }

    const result = planDeckleLayouts({
      orders: lines.map((o, i) => ({
        id: String(i),
        width: Number(o?.width),
        qty: Number(o?.qty),
        rm: Number(o?.rm),
      })),
      sizes: Array.isArray(req.body?.sizes) ? req.body.sizes.slice(0, 40) : [],
      edgeTrimTotal: req.body?.trim,
      deckleRunningMeters: req.body?.drm,
      // How many knives a layout uses is decided BY the layout; the only
      // ceiling is how many positions the system can record -- CUT_SLOTS
      // (A..L), the same twelve columns every deckle in this app carries.
      maxSlots: CUT_SLOTS.length,
      // Each layout comes off whatever width suits it, which is how this page
      // works throughout: a layout's web is picked in that layout's own table.
      mixedSizes: true,
      // Two ceilings on spare rolls; the tighter binds (see OVERRUN_DEFAULTS).
      overrun: {
        pct: Number(req.body?.overrunPct),
        maxExtraRolls: Number(req.body?.overrunRolls),
      },
    });

    if (lines.length < (Array.isArray(req.body?.orders) ? req.body.orders.length : 0)) {
      result.notes.push(`Only the first ${MAX_LINES} requirements were planned.`);
    }

    return res.status(result.ok ? 200 : 422).json(result);
  },
);

// Deckle Set -- deckle setting is per-SKU + paper size, not per order. Every
// still-loose PendingProduction order (unassigned, no deckle size, not yet in
// a batch) is grouped by its Product Code + paper size. The planner opens a
// group, ticks the orders to bundle, and picks one deckle size -- that creates
// a "batch" PendingProduction (isDeckleBatch) covering them all as a single
// production job, which then flows through the Deckle Queue -> Assign
// Production -> Machine Queue exactly like one order. Once that batch exists it
// leaves this page entirely -- it (and its members) are listed on the Deckle
// Queue, which is also where it can be dissolved back to loose. So this page
// only ever answers "what still needs a deckle set". suggestDeckleSize feeds
// each loose group's size picker, sized to the widest single member (orders are
// slit off the one web, not laid side by side).
router.get("/labels/production/deckle-set", async (req, res) => {
  // Only still-loose orders belong here -- once a batch is formed it IS the
  // deckle to make, and it lives on the Deckle Queue (where it can also be
  // dissolved back to loose). This page stays "what still needs a deckle set".
  const loose = await PendingProduction.find({
    assignedMachineId: null,
    deckleSize: null,
    deckleBatchId: null,
    isDeckleBatch: { $ne: true },
  })
    .populate("userId", "clientName userName clientType")
    .populate("itemId", "productCode skuCode rollType facestock")
    .sort({ createdAt: 1 })
    .lean();

  // ---- loose orders, grouped by Product Code (itemId) only -- paper size can
  // vary within a batch: each order is slit off the one deckle web separately,
  // so the web just has to be wide enough for the widest single order. ----
  const groupMap = new Map();
  for (const r of loose) {
    const key = String(r.itemId?._id || "none");
    let g = groupMap.get(key);
    if (!g) g = groupMap.set(key, { key, item: r.itemId || {}, members: [] }).get(key);
    g.members.push(r);
  }

  const looseRows = await Promise.all(
    [...groupMap.values()].map((g) => buildLooseDeckleRow(g.item || {}, g.members)),
  );

  res.render("inventory/orders/deckleSet.ejs", {
    title: "Deckle Sorting",
    CSS: "tableDisp.css",
    JS: false,
    rows: looseRows,
    notification: req.flash("notification"),
  });
});

// The per-Product-Code "Set Deckle" planning page -- opened from the Set Deckle
// button on the Deckle Set list (replaces the old in-page dialog). Shows the
// loose member orders to bundle, the in-stock Facestock sizes for this recipe,
// and a multi-bar web view: the planner draws one A..L roll-width layout and
// compares its trim against every candidate size, picks the least-waste web,
// then POSTs to /labels/production/deckle-set (same handler as the old dialog).
router.get("/labels/production/deckle-set/plan/:itemId", async (req, res) => {
  const backTo = "/app/labels/production/deckle-set";
  const { itemId } = req.params;
  if (!mongoose.isValidObjectId(itemId)) {
    req.flash("notification", "Invalid Product Code.");
    return res.redirect(backTo);
  }

  const members = await PendingProduction.find({
    itemId,
    assignedMachineId: null,
    deckleSize: null,
    deckleBatchId: null,
    // Advance lines are transient planner input; they are created only when
    // the deckle batch is submitted, so they must not reappear after refresh.
    isAdvance: { $ne: true },
    isDeckleBatch: { $ne: true },
  })
    .populate("userId", "clientName userName clientType")
    .populate("itemId", "productCode skuCode rollType facestock")
    .sort({ createdAt: 1 })
    .lean();

  if (!members.length) {
    req.flash("notification", "No loose orders left for that Product Code — refresh Deckle Sorting.");
    return res.redirect(backTo);
  }

  const group = await buildLooseDeckleRow(members[0].itemId || { _id: itemId }, members);

  res.render("inventory/orders/deckleSetForm.ejs", {
    title: "Set Deckle",
    CSS: false,
    JS: false,
    group,
    advanceMode: false,
    labelStocks: [],
    cutSlots: CUT_SLOTS,
    edgeTrimPerSide: DECKLE_EDGE_TRIM_MM,
    // Auto Deckle (utils/deckleOptimizer) is a separate, newer module behind
    // its own kill switch -- when it is off the page renders exactly as it did
    // before, with no Auto Set panel and no reference to it.
    autoDeckle: isDeckleAutoEnabled()
      ? {
          enabled: true,
          defaultRunningMeters: DEFAULT_DECKLE_RUNNING_METERS,
          overrun: OVERRUN_DEFAULTS,
        }
      : { enabled: false },
    notification: req.flash("notification"),
  });
});

// Advance orders -- a loose order the planner types in ahead of the real one,
// so its rolls are cut into today's deckle instead of waiting for the sales
// order to land. A bare PendingProduction row (isAdvance: true, no userId, no
// TapeSalesOrder behind it -- same "synthetic, order-sync never touches it"
// pattern as isDeckleBatch/parentOrderId rows). It is highlighted as ADVANCE on
// every page it travels through, and when the real order for the same Product
// Code + Paper Size + Running Mtrs is placed, that order takes its place --
// batch and all -- and the flag clears (absorbAdvanceOrders in
// utils/pendingProduction.js).
//
// Two ways in:
//   - Advance Order on Deckle Sorting opens GET /labels/production/deckle-set/
//     plan (no Product Code in the path) -- the Set Deckle page in "advance
//     mode": pick the Product Code, type the order lines, plan and Create
//     Deckle Batch. The lines only become rows when the batch is created
//     (advanceJson on POST /labels/production/deckle-set), so a page walked
//     away from leaves nothing behind.
//   - Add Advance on a Product Code's own Set Deckle page, which keeps the
//     line in the current plan and only saves it when the batch is created.

// One typed advance line, checked -- { line } or { error }. Shared by both
// ways in, and by the AI planner, so all three accept exactly the same input.
function parseAdvanceLine(body) {
  const paperSize = Number(body?.paperSize);
  const runningMeters = Number(body?.runningMeters);
  const quantity = Number(body?.quantity);
  if (!Number.isFinite(paperSize) || paperSize <= 0 || paperSize > 20000) {
    return { error: "Enter a valid Paper Size for the advance order." };
  }
  if (!Number.isFinite(runningMeters) || runningMeters <= 0 || runningMeters > 1000000) {
    return { error: "Enter a valid Running Meters for the advance order." };
  }
  if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 100000) {
    return { error: "Enter a valid Roll Qty (a whole number) for the advance order." };
  }
  const remarks = String(body?.remarks || "").trim().slice(0, 200);
  return { line: { paperSize, runningMeters, quantity, remarks } };
}

const advanceRowDoc = (itemId, line, performedBy) => ({
  onModel: "SachikoLabelStock",
  itemId,
  isAdvance: true,
  paperSize: String(line.paperSize),
  runningMeters: line.runningMeters,
  quantity: line.quantity,
  remarks: line.remarks || undefined,
  advanceBy: performedBy || undefined,
});

// Returns an error message, or null once created.
async function createAdvanceOrder(itemId, body, performedBy) {
  if (!mongoose.isValidObjectId(itemId)) return "Pick a Product Code for the advance order.";
  if (!(await SachikoLabelStock.exists({ _id: itemId }))) return "That Product Code no longer exists.";
  const { line, error } = parseAdvanceLine(body);
  if (error) return error;
  await PendingProduction.create(advanceRowDoc(itemId, line, performedBy));
  return null;
}

// The typed lines posted by advance mode (advanceJson / advanceLines), checked.
// Returns { lines } or { error }; an empty or missing list is { lines: [] }.
const MAX_ADVANCE_LINES = 50;
function parseAdvanceLines(raw) {
  let list = raw;
  if (typeof raw === "string") {
    try { list = JSON.parse(raw || "[]"); } catch { return { error: "The advance order lines could not be read — reload and try again." }; }
  }
  if (list == null) return { lines: [] };
  if (!Array.isArray(list)) return { error: "The advance order lines could not be read — reload and try again." };
  if (list.length > MAX_ADVANCE_LINES) return { error: `At most ${MAX_ADVANCE_LINES} advance order lines per deckle.` };
  const lines = [];
  for (const [i, entry] of list.entries()) {
    const { line, error } = parseAdvanceLine(entry);
    if (error) return { error: `Advance line ${i + 1}: ${error}` };
    lines.push(line);
  }
  return { lines };
}

// Set Deckle in ADVANCE MODE -- opened by Advance Order on Deckle Sorting.
// Same page as /plan/:itemId (same layouts, grace, AI Deckle Set, figures and
// the same Create Deckle Batch POST); the differences are that the Product Code
// is picked here (?itemId=, a reload, because the recipe decides which deckle
// sizes are offered), the orders are TYPED in as advance lines, and the
// Product Code's loose real orders are listed unticked, so they can be cut on
// the same deckle if wanted.
router.get("/labels/production/deckle-set/plan", async (req, res) => {
  const base = "/app/labels/production/deckle-set/plan";
  const labelStocks = await SachikoLabelStock.find(
    { productCode: { $not: /-[A-Z]+$/ } },
    { productCode: 1, skuCode: 1 },
  ).sort({ productCode: 1 }).lean();

  // An empty group until a code is picked, so the page renders exactly as the
  // Set Deckle page does -- only with nothing in it yet.
  let group = {
    itemId: "", productCode: "", rollType: "", candidateSizes: [], _children: [],
  };
  const itemId = String(req.query.itemId || "");
  if (itemId) {
    const item = mongoose.isValidObjectId(itemId)
      ? await SachikoLabelStock.findById(itemId).select("productCode skuCode rollType facestock").lean()
      : null;
    if (!item) {
      req.flash("notification", "That Product Code no longer exists — pick another.");
      return res.redirect(base);
    }
    const members = await PendingProduction.find({
      itemId,
      assignedMachineId: null,
      deckleSize: null,
      deckleBatchId: null,
      isAdvance: { $ne: true },
      isDeckleBatch: { $ne: true },
    })
      .populate("userId", "clientName userName clientType")
      .sort({ createdAt: 1 })
      .lean();
    group = await buildLooseDeckleRow(item, members);
    // With nothing loose there is no width to size against, and
    // suggestDeckleSize() then offers no sizes at all. The width only moves
    // the (unused here) wastage figure -- which sizes are offered is the
    // recipe's matching reels either way.
    if (!group.candidateSizes.length) {
      group.candidateSizes = (await suggestDeckleSize({ labelStock: item, paperSize: 1, noOfRolls: 1 })).sizes;
    }
  }

  res.render("inventory/orders/deckleSetForm.ejs", {
    title: "Advance Order — Set Deckle",
    CSS: false,
    JS: false,
    group,
    advanceMode: true,
    labelStocks: labelStocks.map((l) => ({ _id: String(l._id), code: l.productCode || l.skuCode || "—" })),
    cutSlots: CUT_SLOTS,
    edgeTrimPerSide: DECKLE_EDGE_TRIM_MM,
    autoDeckle: isDeckleAutoEnabled()
      ? {
          enabled: true,
          defaultRunningMeters: DEFAULT_DECKLE_RUNNING_METERS,
          overrun: OVERRUN_DEFAULTS,
        }
      : { enabled: false },
    notification: req.flash("notification"),
  });
});

router.post(
  "/labels/production/deckle-set/plan/:itemId/advance",
  requireAuth,
  createLimiter,
  async (req, res) => {
    const { itemId } = req.params;
    const backTo = mongoose.isValidObjectId(itemId)
      ? `/app/labels/production/deckle-set/plan/${itemId}`
      : "/app/labels/production/deckle-set";
    const err = await createAdvanceOrder(itemId, req.body, req.session?.authUser?.username);
    if (err) {
      req.flash("notification", err);
      return res.redirect(backTo);
    }
    res.locals.auditDescription = `Added advance order: ${req.body.quantity} roll(s) of ${req.body.paperSize} mm`
      + ` x ${req.body.runningMeters} m`;
    req.flash("notification", "Advance order added — tick it in when you plan the deckle.");
    return res.redirect(backTo);
  },
);

// Spreadsheet-style edits on the Advance Orders table.  These rows have no
// source sales order, so only loose advance rows may be changed here; once one
// has entered a deckle batch it is production data and must not be resized.
router.post(
  "/labels/production/deckle-set/advance/:id/update",
  requireAuth,
  updateLimiter,
  async (req, res) => {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "Invalid advance order." });
    }
    const { line, error } = parseAdvanceLine(req.body);
    if (error) return res.status(400).json({ message: error });

    const row = await PendingProduction.findOneAndUpdate(
      {
        _id: id,
        isAdvance: true,
        deckleBatchId: null,
        assignedMachineId: null,
        isDeckleBatch: { $ne: true },
      },
      {
        $set: {
          paperSize: String(line.paperSize),
          runningMeters: line.runningMeters,
          quantity: line.quantity,
        },
      },
      { new: true },
    ).lean();
    if (!row) {
      return res.status(409).json({ message: "This advance order is already in production — refresh the page." });
    }
    res.locals.auditDescription = `Updated advance order: ${row.quantity} roll(s) of ${row.paperSize} mm x ${row.runningMeters} m`;
    return res.json({
      message: "Advance order updated.",
      order: { paperSize: row.paperSize, runningMeters: row.runningMeters, quantity: row.quantity },
    });
  },
);

// Take back an advance order nobody has set a deckle for yet -- a forecast that
// is not going to happen. Only a LOOSE advance row: one already in a batch is
// part of a deckle being made, and comes back out through Dissolve first.
router.post("/labels/production/deckle-set/advance/:id/delete", requireAuth, deleteLimiter, async (req, res) => {
  const backTo = "/app/labels/production/deckle-set";
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    req.flash("notification", "Invalid advance order.");
    return res.redirect(backTo);
  }
  const gone = await PendingProduction.findOneAndDelete({
    _id: id,
    isAdvance: true,
    deckleBatchId: null,
    assignedMachineId: null,
    isDeckleBatch: { $ne: true },
  }).lean();
  if (!gone) {
    req.flash("notification", "That advance order is already in a deckle batch (or gone) — refresh Deckle Sorting.");
    return res.redirect(backTo);
  }
  res.locals.auditDescription = `Removed advance order: ${gone.quantity} roll(s) of ${gone.paperSize} mm`
    + ` x ${gone.runningMeters} m`;
  req.flash("notification", "Advance order removed.");
  return res.redirect(backTo);
});

// Auto Deckle -- hand the ticked orders to utils/deckleOptimizer and return the
// layouts it works out, as JSON. Deliberately READ-ONLY: it creates nothing and
// changes nothing, it only answers "here is the least-waste way to cut these".
// The planner reviews the layouts it drops into the form and still has to press
// Create Deckle Batch, which goes through the same POST handler and the same
// validation as a hand-drawn plan. That is what makes it safe to run on a
// production server -- a wrong answer is discarded by not saving it.
//
// Switched off wholesale by DECKLE_AUTO_ENABLED=false in .env (see
// isDeckleAutoEnabled) -- the manual planner is untouched either way.
//
// Order widths, roll quantities and roll lengths are re-read from the database
// rather than taken from the request: the client may choose WHICH orders to
// plan, never what they say. Deckle sizes, edge trim and Deckle R.M. do come
// from the request -- they are the planner's own editable inputs on the page --
// and are range-checked by the optimizer before use.
router.post(
  "/labels/production/deckle-set/plan/:itemId/auto",
  requireAuth,
  updateLimiter,
  async (req, res) => {
    if (!isDeckleAutoEnabled()) {
      return res.status(503).json({
        ok: false,
        disabled: true,
        error: "Auto Deckle is switched off on this server.",
      });
    }

    const { itemId } = req.params;
    if (!mongoose.isValidObjectId(itemId)) {
      return res.status(400).json({ ok: false, error: "Invalid Product Code." });
    }

    const wanted = [
      ...new Set(
        (Array.isArray(req.body?.orderIds) ? req.body.orderIds : [])
          .filter((x) => mongoose.isValidObjectId(x))
          .map(String),
      ),
    ];
    // Advance lines typed on the page (advance mode) -- not rows yet, so they
    // are planned as sent. Checked by the same rules the batch POST will
    // apply when it creates them.
    const advance = parseAdvanceLines(req.body?.advanceLines);
    if (advance.error) return res.status(400).json({ ok: false, error: advance.error });
    if (!wanted.length && !advance.lines.length) {
      return res.status(400).json({ ok: false, error: "Tick at least one order to plan." });
    }

    // Same gate as the batch POST: only orders still loose under this Product
    // Code can be planned, so a stale page cannot plan something already batched.
    const members = wanted.length
      ? await PendingProduction.find({
          _id: { $in: wanted },
          itemId,
          assignedMachineId: null,
          deckleSize: null,
          deckleBatchId: null,
          isDeckleBatch: { $ne: true },
        })
          .select("paperSize quantity runningMeters")
          .lean()
      : [];

    if (!members.length && !advance.lines.length) {
      return res.status(409).json({
        ok: false,
        error: "Those orders are no longer available to plan — refresh the page.",
      });
    }

    const result = planDeckleLayouts({
      orders: [
        ...members.map((m) => ({
          id: String(m._id),
          width: Number(m.paperSize),
          qty: Number(m.quantity),
          rm: Number(m.runningMeters),
        })),
        ...advance.lines.map((l, i) => ({
          id: `advance:${i}`,
          width: l.paperSize,
          qty: l.quantity,
          rm: l.runningMeters,
        })),
      ],
      sizes: Array.isArray(req.body?.sizes) ? req.body.sizes : [],
      edgeTrimTotal: req.body?.trim,
      deckleRunningMeters: req.body?.drm,
      // Not a planner setting: how many knives a layout uses is decided BY the
      // layout. The only ceiling is how many positions the system can record --
      // CUT_SLOTS (A..L), the same twelve columns the manual form and the
      // slitting job card carry. The slitter itself is not even chosen yet at
      // this point; that happens later, at Slitting Allocation.
      maxSlots: CUT_SLOTS.length,
      // Let each layout come off whatever deckle width suits it. Off unless
      // the planner ticks it -- see the module header's "Mixed webs".
      mixedSizes: req.body?.mixedSizes === true,
      // Two ceilings on spare rolls; the tighter binds (see OVERRUN_DEFAULTS).
      overrun: {
        pct: Number(req.body?.overrunPct),
        maxExtraRolls: Number(req.body?.overrunRolls),
      },
    });

    if (members.length !== wanted.length) {
      result.notes.push(
        `${wanted.length - members.length} ticked order(s) are no longer loose and were left out of the plan.`,
      );
    }

    return res.status(result.ok ? 200 : 422).json(result);
  },
);

// Bundle the ticked orders of one Product Code into deckle batches -- ONE PER
// DECKLE SIZE the plan cuts. A single-width plan makes the one batch it always
// did; a mixed-web plan (660 x 8 + 635 x 15 + 510 x 3) makes three, because
// they are three different things to make: three reels off the shelf, three
// runs through the laminator, three rows in the Deckle Queue, three Lot Nos.
// See the "one batch per DECKLE SIZE" block below for how an order that is cut
// on more than one of them is divided.
//
// Body: deckleSize (the headline width, used for layouts that carry none of
// their own), deckleRunningMeters (length of one deckle web -- optional),
// deckleTrim, layoutsJson (the drawn layouts), orderIds[] (the ticked
// members). `runningMeters` and `noOfRolls` are no longer read: both belong to
// a width, and are derived per batch.
router.post("/labels/production/deckle-set", requireAuth, updateLimiter, async (req, res) => {
  // Advance mode (GET /labels/production/deckle-set/plan) posts here too, with
  // its typed lines in advanceJson -- a failure goes back to that page.
  const advanceMode = req.body.advanceMode === "1";
  const postedItemId = mongoose.isValidObjectId(req.body.itemId) ? String(req.body.itemId) : "";
  const backTo = advanceMode
    ? `/app/labels/production/deckle-set/plan${postedItemId ? `?itemId=${postedItemId}` : ""}`
    : "/app/labels/production/deckle-set";
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

  const deckleSize = Number(req.body.deckleSize);
  if (!Number.isFinite(deckleSize) || deckleSize <= 0 || deckleSize > 20000) {
    req.flash("notification", "Enter a valid deckle size.");
    return res.redirect(backTo);
  }
  const orderIds = [
    ...new Set(
      (Array.isArray(req.body.orderIds) ? req.body.orderIds : req.body.orderIds ? [req.body.orderIds] : [])
        .filter((x) => mongoose.isValidObjectId(x))
        .map(String),
    ),
  ];
  const advance = parseAdvanceLines(req.body.advanceJson);
  if (advance.error) {
    req.flash("notification", advance.error);
    return res.redirect(backTo);
  }
  if (advance.lines.length && !(postedItemId && (await SachikoLabelStock.exists({ _id: postedItemId })))) {
    req.flash("notification", "Pick a Product Code for the advance order.");
    return res.redirect(backTo);
  }
  if (orderIds.length === 0 && advance.lines.length === 0) {
    req.flash("notification", "Select at least one order for the deckle batch.");
    return res.redirect(backTo);
  }

  // The typed advance lines become loose advance rows now, just before they
  // are batched, so everything below treats them exactly like a ticked order.
  // If anything below refuses the batch they are removed again -- a refused
  // plan must not leave stray advance rows on Deckle Sorting.
  let createdAdvanceIds = [];
  if (advance.lines.length) {
    const made = await PendingProduction.insertMany(
      advance.lines.map((l) => advanceRowDoc(postedItemId, l, req.session?.authUser?.username)),
    );
    createdAdvanceIds = made.map((d) => d._id);
    orderIds.push(...createdAdvanceIds.map(String));
  }
  const undoAdvance = async () => {
    if (createdAdvanceIds.length) {
      await PendingProduction.deleteMany({ _id: { $in: createdAdvanceIds }, deckleBatchId: null });
      createdAdvanceIds = [];
    }
  };
  try {
    return await createDeckleBatches(req, res, { backTo, deckleSize, orderIds, num, undoAdvance });
  } catch (err) {
    await undoAdvance();
    throw err;
  }
});

// Deckle Only -- a deckle made for stock: the web alone, for one Product Code,
// with NO orders and no slitting layout. Opened by its own button on Deckle
// Sorting (beside Advance Order). Deckle Size, Deckle R.M. and Deckle Count
// are the whole plan -- no Edge Trim field here (removed from the form; see
// deckleOnlyForm.ejs), since there's no slitting layout for a trim figure to
// describe. deckleTrim is simply left unset on the batch this creates.
//
// The batch it makes has no members (batchOrderIds: []) and no finished rolls
// ordered (quantity: 0). It runs Deckle Queue -> Assign Production -> machine
// like any batch, budgeted off size x R.M. x count, and its webs land in
// Semi-Finished Stock. The Slitting Queue lists no plan for it
// (buildPlannedDeckleGroups skips deckleOnly); the webs show there as free
// Deckles, to be slit when an order needs them.
router.get("/labels/production/deckle-set/deckle-only", async (req, res) => {
  const base = "/app/labels/production/deckle-set/deckle-only";
  // Same list the Advance Order picker offers: base codes, no "-A" variants.
  const labelStocks = await SachikoLabelStock.find(
    { productCode: { $not: /-[A-Z]+$/ } },
    { productCode: 1, skuCode: 1 },
  ).sort({ productCode: 1 }).lean();

  let item = null;
  const itemId = String(req.query.itemId || "");
  if (itemId) {
    item = mongoose.isValidObjectId(itemId)
      ? await SachikoLabelStock.findById(itemId).select("productCode skuCode rollType").lean()
      : null;
    if (!item) {
      req.flash("notification", "That Product Code no longer exists — pick another.");
      return res.redirect(base);
    }
  }

  res.render("inventory/orders/deckleOnlyForm.ejs", {
    title: "Deckle Only",
    CSS: false,
    JS: false,
    item: item
      ? { _id: String(item._id), productCode: item.productCode || item.skuCode || "", rollType: item.rollType || "" }
      : null,
    labelStocks: labelStocks.map((l) => ({ _id: String(l._id), code: l.productCode || l.skuCode || "—" })),
    notification: req.flash("notification"),
  });
});

router.post("/labels/production/deckle-set/deckle-only", requireAuth, createLimiter, async (req, res) => {
  const itemId = mongoose.isValidObjectId(req.body.itemId) ? String(req.body.itemId) : "";
  const backTo = `/app/labels/production/deckle-set/deckle-only${itemId ? `?itemId=${itemId}` : ""}`;
  const fail = (msg) => {
    req.flash("notification", msg);
    return res.redirect(backTo);
  };

  const item = itemId
    ? await SachikoLabelStock.findById(itemId).select("productCode skuCode").lean()
    : null;
  if (!item) return fail("Pick the Product Code for the deckle.");

  const deckleSize = Number(req.body.deckleSize);
  if (!Number.isFinite(deckleSize) || deckleSize <= 0 || deckleSize > 20000) {
    return fail("Enter a valid Deckle Size.");
  }
  const drm = Number(req.body.deckleRunningMeters);
  if (!Number.isFinite(drm) || drm <= 0 || drm > 1000000) {
    return fail("Enter the Deckle R.M. — the length of one deckle web.");
  }
  const count = Number(req.body.deckleCount);
  if (!Number.isInteger(count) || count < 1 || count > 10000) {
    return fail("Enter the Deckle Count — how many webs to laminate (a whole number from 1 to 10,000).");
  }

  const totalRM = deckleTotalRunningMetres({ deckleRunningMeters: drm, noOfRolls: count });
  const batch = await PendingProduction.create({
    onModel: "SachikoLabelStock",
    isDeckleBatch: true,
    deckleOnly: true,
    itemId: item._id,
    // A batch is characterised by the web it lays down -- see createDeckleBatches.
    paperSize: String(deckleSize),
    quantity: 0,
    // On a batch, noOfRolls is the Deckle Qty -- how many webs to laminate.
    noOfRolls: count,
    runningMeters: totalRM,
    runningMetersText: deckleRunningMetersText({
      deckleRunningMeters: drm, noOfRolls: count, runningMeters: totalRM,
    }) || undefined,
    deckleRunningMeters: drm,
    deckleSize,
    // No Edge Trim field on this form (a Deckle Only batch is a plain web for
    // stock, not a slitting plan) -- deckleTrim stays unset, same as any
    // other batch that never had one (see slitting.js's reads: absent shows
    // no edge rather than inventing one).
    batchOrderIds: [],
  });

  const code = item.productCode || item.skuCode || "";
  res.locals.auditDescription = `Created deckle-only batch ${batch._id} for ${code}: `
    + `${deckleSize} mm × ${count} web(s) of ${drm} m, no orders, no slitting layout`;
  req.flash(
    "notification",
    `Deckle Only batch created — ${code} at ${deckleSize} mm × ${count} web(s) of ${drm} m, for stock (no orders). `
      + "Now in the Deckle Queue.",
  );
  res.redirect("/app/labels/production/deckle-queue");
});

// The body of POST /labels/production/deckle-set once the ticked orders (and
// any typed advance lines, already saved as rows) are known. `undoAdvance`
// removes those advance rows; every refusal below calls it via fail().
async function createDeckleBatches(req, res, { backTo, deckleSize, orderIds, num, undoAdvance }) {
  const fail = async (msg) => {
    await undoAdvance();
    req.flash("notification", msg);
    return res.redirect(backTo);
  };

  // Every ticked order must still be loose and share one Product Code (itemId)
  // -- paper size is NOT part of the batch key (mixed sizes slit off one web).
  const members = await PendingProduction.find({
    _id: { $in: orderIds },
    assignedMachineId: null,
    deckleSize: null,
    deckleBatchId: null,
    isDeckleBatch: { $ne: true },
  }).lean();
  if (members.length !== orderIds.length) {
    return fail("Some selected orders are no longer available to batch — refresh and try again.");
  }
  if (new Set(members.map((m) => String(m.itemId))).size !== 1) {
    return fail("A deckle batch must be a single Product Code.");
  }

  // Total Running Metres is NOT the member sum, and is not taken from the form
  // either. A member order's `runningMeters` is the length of ONE finished
  // roll (1,000 m), the same figure on every line of the order, so adding them
  // up counted ORDERS, not metres: four 1,000 m orders read "4,000 M TOTAL"
  // whatever the deckle actually ran. The real total is the web a batch
  // laminates -- one web's length x how many webs of that width -- and since a
  // mixed-web plan becomes one batch per width, it is worked out per batch
  // below (deckleTotalRunningMetres, utils/deckleTotals.js).

  // The deckle layouts the planner drew on the Set Deckle page -- one entry per
  // cut pattern (all cut from the one chosen deckleSize), each with its own
  // A..L roll widths, per-roll R. Meter and `count` = how many deckle webs use
  // it. Optional (absent from the no-facestock manual path / an older client);
  // stored on the batch to pre-fill Slitting Allocation, never blocks creation.
  //
  // `width` is the width the knife is set to. `orderedWidth` rides alongside it
  // when the planner applied "grace" -- spare web shared out over the rolls so
  // it is cut instead of scrapped -- and is the width the client is billed at.
  // It is kept only when it is a real width no LARGER than the cut: grace adds
  // web to a roll, it never takes any away, so anything else is a doctored post
  // and is dropped rather than trusted (billing a client for more than was
  // made). Equal to the cut width means no grace, so it is not stored at all
  // and the row stays the shape every batch before this one has.
  const normCuts = (arr) =>
    CUT_SLOTS
      .map((slot) => {
        const hit = Array.isArray(arr) ? arr.find((c) => c && c.slot === slot) : null;
        const width = Number(hit?.width);
        const ordered = Number(hit?.orderedWidth);
        // A hair of grace is no grace -- and the same test rejects an ordered
        // width at or above the cut, which is the doctored case.
        const graced = Number.isFinite(ordered) && ordered > 0
          && Number.isFinite(width) && width - ordered > 0.005;
        return graced ? { slot, width, orderedWidth: ordered } : { slot, width };
      })
      .filter((c) => Number.isFinite(c.width) && c.width > 0);

  let parsedLayouts = [];
  try {
    const j = JSON.parse(req.body.layoutsJson || "[]");
    if (Array.isArray(j)) parsedLayouts = j;
  } catch { parsedLayouts = []; }

  // Fallback: the old single-layout form fields (cuts[A..L] + layoutRunningMeter).
  if (!parsedLayouts.length && req.body.cuts && typeof req.body.cuts === "object") {
    parsedLayouts = [{
      cuts: CUT_SLOTS.map((slot) => ({ slot, width: req.body.cuts[slot] })),
      rm: req.body.layoutRunningMeter,
      webs: req.body.noOfRolls,
    }];
  }

  // Edge trim as posted, used only to check each layout's cuts fit its own web.
  // Falls back to 0 when it is missing or nonsense, so a bad trim value can
  // never reject an otherwise-valid layout; the real deckleTrim is validated
  // against the batch's deckleSize further down.
  const rawTrim = Number(req.body.deckleTrim);
  const fitTrim = Number.isFinite(rawTrim) && rawTrim >= 0 ? rawTrim : 0;

  const deckleLayout = parsedLayouts
    .map((L) => {
      const cuts = normCuts(L.cuts);
      const rm = Number(L.rm);
      const drm = Number(L.drm);
      const count = Math.max(1, Math.floor(Number(L.webs) || 1));
      // The web width THIS layout is cut from -- present when the planner let
      // layouts use different widths ("mixed webs"). Kept only when it is a
      // sane width whose cuts actually fit inside it once the edge trim is
      // taken off, the same bound the form enforces client-side. Anything else
      // falls back to the batch's single deckleSize rather than persisting a
      // width the slitter could not run.
      const size = Number(L.size);
      const cutSum = cuts.reduce((n, c) => n + c.width, 0);
      const sizeOk = Number.isFinite(size)
        && size > 0
        && size <= 20000
        && cutSum <= size - fitTrim;
      return cuts.length
        ? {
            cuts,
            deckleSize: sizeOk ? size : undefined,
            deckleRunningMeter: Number.isFinite(drm) && drm > 0 ? drm : undefined,
            plannedRunningMeter: Number.isFinite(rm) && rm > 0 ? rm : undefined,
            count,
          }
        : null;
    })
    .filter(Boolean);
  const layoutWebs = deckleLayout.reduce((n, L) => n + L.count, 0);
  // The batch's own "one web length" -- from the layouts, else the legacy form
  // field. Downstream reads pending.deckleRunningMeters.
  const enteredDeckleRM = Number(req.body.deckleRunningMeters);
  const deckleRunningMeters = deckleLayout.find((L) => L.deckleRunningMeter > 0)?.deckleRunningMeter
    ?? (Number.isFinite(enteredDeckleRM) && enteredDeckleRM > 0 ? enteredDeckleRM : undefined);

  // Total edge trim (both edges) the planner set on the Set Deckle page while
  // fitting the layouts. Pre-fills Slitting Allocation's own Trim field. Edge
  // trim is netted out of every web width, so it must leave something to cut
  // -- checked against each batch's OWN width further down, since a plan on
  // mixed webs becomes one batch per width and the narrowest is the one a big
  // trim would eat.
  const enteredTrim = Number(req.body.deckleTrim);

  // Deckle Qty and both running-metre figures are no longer worked out here:
  // they belong to a width, not to the posted plan as a whole, and are derived
  // per batch below from that width's own layouts. A total typed into the
  // dialog can't be divided between widths and is not used -- the derived
  // "one web's length x how many webs of THIS width" is the only figure that
  // has a physical meaning once the plan is split.

  // ---- one batch per DECKLE SIZE ------------------------------------------
  // A mixed-web plan cuts several widths (660 x 8 + 635 x 15 + 510 x 3), and
  // they are three different things to make: three reels off the shelf, three
  // runs through the laminator. Bundling them into one PendingProduction made
  // the Deckle Queue show one row at whichever width carried the most webs,
  // and Assign Production then had to allot raw material for a job whose own
  // card admitted to only one of its widths -- reels for the other two read as
  // "too narrow" against it.
  //
  // So the layouts are grouped by the width they are cut from and each group
  // becomes its own batch: its own queue row, its own Lot No, its own machine
  // and its own reels. A single-width plan has exactly one group and so lands
  // as the one batch it always did -- nothing changes for it.
  const layoutGroups = [];
  for (const L of deckleLayout) {
    const size = L.deckleSize > 0 ? L.deckleSize : deckleSize;
    let g = layoutGroups.find((x) => x.size === size);
    if (!g) { g = { size, layouts: [], webs: 0, rollsByWidth: new Map() }; layoutGroups.push(g); }
    // Stored WITHOUT the per-layout deckleSize: inside a single-width batch it
    // is the batch's own size, and leaving it on would have every reader fall
    // back to the same number twice over.
    const { deckleSize: _dropped, ...rest } = L;
    g.layouts.push(rest);
    g.webs += L.count || 1;
    const rpw = L.deckleRunningMeter > 0 && L.plannedRunningMeter > 0
      ? Math.max(1, Math.floor(L.deckleRunningMeter / L.plannedRunningMeter))
      : 1;
    for (const c of L.cuts) {
      // Keyed on the ORDERED width, not the knife width. Where the planner
      // applied grace the knife is set wider than the order (157.5 mm for a
      // 150 mm roll) so spare web is cut instead of scrapped -- but the roll
      // that comes off is still that 150 mm order's roll, and it is billed at
      // 150. Keying on the knife width left those rolls belonging to nobody:
      // the order they were cut for read as short and had its balance carved
      // off to Deckle Sorting while the rolls were sitting on the machine.
      const w = c.orderedWidth > 0 ? c.orderedWidth : c.width;
      g.rollsByWidth.set(w, (g.rollsByWidth.get(w) || 0) + (L.count || 1) * rpw);
    }
  }
  // Widest first, so the queue reads the way the plan does and the group that
  // needs the widest reel is the one created first.
  layoutGroups.sort((a, b) => b.size - a.size);

  // ---- how much of each ticked order each GROUP actually covers ------------
  // The layouts produce a fixed number of finished rolls per roll width; an
  // order wanting more than that is only PARTLY set. Mirrors exactly what the
  // Set Deckle page shows in "Rolls Set" / "Balance" (recalcAll()), so what the
  // planner reviewed is what gets saved: rolls of a width are handed to the
  // orders of that width in listed (oldest-first) order, and the last one
  // absorbs any overflow. The only difference from before is that this is now
  // done group by group, so it also records WHICH width makes which rolls.
  const ordered = members.slice().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const byWidth = new Map();
  for (const m of ordered) {
    const w = num(m.paperSize);
    if (!byWidth.has(w)) byWidth.set(w, []);
    byWidth.get(w).push(m);
  }
  // takes[groupIndex].get(orderId) = finished rolls of that order this group's
  // layouts make.
  const takes = layoutGroups.map(() => new Map());
  for (const [w, list] of byWidth) {
    const left = list.map((m) => num(m.quantity));                 // still to be set, per order
    const pools = layoutGroups
      .map((g, gi) => ({ gi, pool: g.rollsByWidth.get(w) || 0 }))
      .filter((x) => x.pool > 0);
    pools.forEach(({ gi, pool }, k) => {
      const lastPool = k === pools.length - 1;
      let spare = pool;
      list.forEach((m, idx) => {
        if (spare <= 0) return;
        // Overflow lands on the last order of the width, and only out of the
        // last group that cuts it -- exactly where it landed when there was
        // one group. It empties the pool but is NOT recorded against the
        // order beyond what was ordered: rolls made over the order are spare
        // production, and writing them onto the member row would have the
        // batch claim to be filling more of an order than the order asked
        // for.
        const take = lastPool && idx === list.length - 1 ? spare : Math.min(spare, left[idx]);
        if (take <= 0) return;
        const against = Math.min(take, left[idx]);
        spare -= take;
        left[idx] = Math.max(0, left[idx] - take);
        if (against <= 0) return;
        takes[gi].set(String(m._id), (takes[gi].get(String(m._id)) || 0) + against);
      });
    });
  }

  // covered[orderId] = finished rolls of that order the whole plan makes.
  const covered = new Map();
  for (const m of ordered) {
    const total = takes.reduce((n, t) => n + (t.get(String(m._id)) || 0), 0);
    covered.set(String(m._id), Math.min(total, num(m.quantity)));
  }

  // An order the layouts don't touch at all is simply not batched -- it stays
  // loose on Deckle Sorting, exactly as if it had never been ticked.
  const batched = ordered.filter((m) => covered.get(String(m._id)) > 0);
  if (!batched.length) {
    return fail("These layouts don't cut any of the ticked orders' roll widths — nothing to batch.");
  }

  const oldest = batched[0];
  const dueDates = batched.map((m) => m.estimatedDate).filter(Boolean).sort((a, b) => new Date(a) - new Date(b));
  // Rolls track quantity on these orders; scale rather than assume they match.
  const rollsFor = (m, part) => {
    const qty = num(m.quantity);
    return num(m.noOfRolls) > 0 && qty > 0 ? Math.max(1, Math.round((num(m.noOfRolls) * part) / qty)) : undefined;
  };

  // The member row that carries an order's share of a group. The order's OWN
  // row is used for the first group it appears in; a further group gets a
  // clone (parentOrderId = the order it came from), the same device the
  // shortfall rows below have always used -- which is also why Dissolve
  // already folds them back correctly, one batch at a time.
  const usedOriginal = new Set();
  const createdBatches = [];
  const clonesToInsert = [];

  for (let gi = 0; gi < layoutGroups.length; gi += 1) {
    const g = layoutGroups[gi];
    const groupMembers = ordered.filter((m) => (takes[gi].get(String(m._id)) || 0) > 0);
    if (!groupMembers.length) continue;                 // a width that cuts none of these orders

    const groupWebs = g.webs;
    const groupDrm = g.layouts.find((L) => L.deckleRunningMeter > 0)?.deckleRunningMeter ?? deckleRunningMeters;
    const groupTotalRM = deckleTotalRunningMetres({ deckleRunningMeters: groupDrm, noOfRolls: groupWebs })
      ?? groupMembers.reduce((s, m) => s + num(m.runningMeters), 0);
    const groupDueDates = groupMembers.map((m) => m.estimatedDate).filter(Boolean).sort((a, b) => new Date(a) - new Date(b));
    // Edge trim is netted out of THIS group's width, so re-check it against
    // that rather than against the headline size.
    const groupTrim = Number.isFinite(enteredTrim) && enteredTrim >= 0 && enteredTrim < g.size ? enteredTrim : undefined;

    const batch = await PendingProduction.create({
      onModel: oldest.onModel || "SachikoLabelStock",
      isDeckleBatch: true,
      itemId: oldest.itemId,
      // An advance member has no client -- take the first real order's, if any.
      userId: (groupMembers.find((m) => m.userId) || groupMembers[0]).userId,
      // Members can have different per-roll paper sizes -- this batch produces
      // one web at its own deckle width, so that's the size that characterises it.
      paperSize: String(g.size),
      quantity: groupMembers.reduce((s, m) => s + takes[gi].get(String(m._id)), 0),
      noOfRolls: groupWebs,
      runningMeters: groupTotalRM,
      runningMetersText: deckleRunningMetersText({
        deckleRunningMeters: groupDrm, noOfRolls: groupWebs, runningMeters: groupTotalRM,
      }) || undefined,
      deckleRunningMeters: groupDrm,
      deckleSize: g.size,
      deckleLayout: g.layouts.length ? g.layouts : undefined,
      deckleTrim: groupTrim,
      deckleOption: oldest.deckleOption,
      estimatedDate: groupDueDates[0] || dueDates[0] || undefined,
      poNumber: groupMembers.map((m) => m.poNumber).filter(Boolean).join(", ").slice(0, 200) || undefined,
      batchOrderIds: [],                                 // filled in once the member rows exist
    });
    createdBatches.push({ batch, group: g, gi, memberIds: [] });

    for (const m of groupMembers) {
      const take = takes[gi].get(String(m._id));
      if (!usedOriginal.has(String(m._id))) {
        usedOriginal.add(String(m._id));
        await PendingProduction.updateOne(
          { _id: m._id },
          {
            $set: {
              quantity: take,
              ...(rollsFor(m, take) != null ? { noOfRolls: rollsFor(m, take) } : {}),
              deckleBatchId: batch._id,
              deckleSize: g.size,
            },
          },
        );
        createdBatches[createdBatches.length - 1].memberIds.push(m._id);
      } else {
        clonesToInsert.push({
          doc: {
            onModel: m.onModel || "SachikoLabelStock",
            parentOrderId: m._id,
            // Part of an advance order is still advance -- it must stay
            // flagged, and stay matchable when the real order lands.
            isAdvance: !!m.isAdvance,
            itemId: m.itemId,
            userId: m.userId,
            quantity: take,
            dispatchedQuantity: 0,
            poNumber: m.poNumber,
            deckleOption: m.deckleOption,
            orderRate: m.orderRate,
            estimatedDate: m.estimatedDate,
            remarks: m.remarks,
            paperSize: m.paperSize,
            runningMeters: m.runningMeters,      // per-roll length -- the same rolls, fewer of them
            noOfRolls: rollsFor(m, take),
            deckleBatchId: batch._id,
            deckleSize: g.size,
          },
          batchIndex: createdBatches.length - 1,
        });
      }
    }
  }

  if (clonesToInsert.length) {
    const inserted = await PendingProduction.insertMany(clonesToInsert.map((c) => c.doc));
    inserted.forEach((doc, i) => {
      createdBatches[clonesToInsert[i].batchIndex].memberIds.push(doc._id);
    });
  }
  for (const b of createdBatches) {
    await PendingProduction.updateOne({ _id: b.batch._id }, { $set: { batchOrderIds: b.memberIds } });
  }

  // ---- the shortfall goes back to Deckle Sorting ---------------------------
  // A member the plan covers only partly keeps just the rolls it makes; the
  // balance is carved off into a fresh loose row (parentOrderId = the order it
  // came from) so it reappears on Deckle Sorting and can be set on a later
  // deckle. Nothing is lost: parent + clones + remainders still add up to the
  // order.
  const remainders = [];
  for (const m of batched) {
    const qty = num(m.quantity);
    const short = Math.round((qty - covered.get(String(m._id))) * 100) / 100;
    if (short <= 0) continue;
    remainders.push({
      onModel: m.onModel || "SachikoLabelStock",
      parentOrderId: m._id,
      isAdvance: !!m.isAdvance,
      itemId: m.itemId,
      userId: m.userId,
      quantity: short,
      dispatchedQuantity: 0,
      poNumber: m.poNumber,
      deckleOption: m.deckleOption,
      orderRate: m.orderRate,
      estimatedDate: m.estimatedDate,
      remarks: m.remarks,
      paperSize: m.paperSize,
      // Per-roll length -- the same rolls, just fewer of them.
      runningMeters: m.runningMeters,
      noOfRolls: rollsFor(m, short),
    });
  }
  if (remainders.length) await PendingProduction.insertMany(remainders);

  // Rolls handed back: the shortfall rows above, plus any ticked order these
  // layouts never cut at all (left loose, untouched).
  const untouched = ordered.length - batched.length;
  const backRolls = remainders.reduce((n, r) => n + num(r.quantity), 0);
  const leftBehind = [
    remainders.length ? `${Math.round(backRolls * 100) / 100} roll(s) from ${remainders.length} part-set order(s)` : "",
    untouched ? `${untouched} untouched order(s)` : "",
  ].filter(Boolean).join(" + ");

  // One line per batch made -- the widths are the point of the message now, so
  // they are named rather than folded into a single "mixed webs" aside.
  const madeText = createdBatches
    .map((b) => `${b.group.size} mm × ${b.group.webs}`)
    .join(" + ");
  const split = createdBatches.length > 1;

  res.locals.auditDescription = `Created ${createdBatches.length} deckle batch(es) `
    + `${createdBatches.map((b) => b.batch._id).join(", ")} covering ${batched.length} order(s)`
    + (deckleLayout.length ? ` (${deckleLayout.length} layout${deckleLayout.length === 1 ? "" : "s"}, ${layoutWebs} webs)` : "")
    + (split ? ` split by deckle size: ${madeText}` : ` at ${madeText}`)
    + (leftBehind ? `; ${leftBehind} back to Deckle Sorting` : "");
  req.flash(
    "notification",
    (split
      ? `${createdBatches.length} deckle batches created — one per deckle size (${madeText}) from ${batched.length} order(s).`
        + ` Each is its own row in the Deckle Queue, with its own Lot No and its own raw material.`
      : `Deckle batch created — ${batched.length} order(s) bundled at deckle size ${createdBatches[0].group.size}. Now in the Deckle Queue.`)
    + (leftBehind ? ` ${leftBehind.charAt(0).toUpperCase()}${leftBehind.slice(1)} stayed on Deckle Sorting.` : ""),
  );
  res.redirect("/app/labels/production/deckle-queue");
}

// Un-bundle a batch that hasn't been assigned to a machine yet -- its member
// orders drop back to loose on Deckle Set.
router.post("/labels/production/deckle-batch/:id/dissolve", requireAuth, updateLimiter, async (req, res) => {
  // Batches live on the Deckle Queue, so that is where Dissolve is pressed --
  // but the old Deckle Sorting entry point still works. Whitelisted, never a
  // raw redirect target from the body.
  const backTo = req.body.from === "queue"
    ? "/app/labels/production/deckle-queue"
    : "/app/labels/production/deckle-set";
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    req.flash("notification", "Invalid batch id.");
    return res.redirect(backTo);
  }
  const batch = await PendingProduction.findOne({ _id: id, isDeckleBatch: true }).lean();
  if (!batch) {
    req.flash("notification", "Deckle batch not found.");
    return res.redirect(backTo);
  }
  if (batch.assignedMachineId) {
    req.flash("notification", "This batch is already assigned to a machine — send it back from WIP first.");
    return res.redirect(backTo);
  }
  const memberIds = await PendingProduction.find({ deckleBatchId: batch._id })
    .select("_id quantity noOfRolls")
    .lean();
  await PendingProduction.updateMany(
    { deckleBatchId: batch._id },
    { $unset: { deckleBatchId: "", deckleSize: "" } },
  );
  await PendingProduction.deleteOne({ _id: batch._id });

  // Un-split what forming this batch split: a member only partly covered by it
  // had its balance carved off into a loose remainder row. With the batch gone
  // the member is whole again, so fold each still-loose remainder back in
  // rather than leaving one order sitting on Deckle Sorting as two rows. A
  // remainder already set on a LATER deckle is left alone -- it is spoken for.
  let remerged = 0;
  for (const m of memberIds) {
    const spare = await PendingProduction.find({
      parentOrderId: m._id,
      deckleBatchId: null,
      assignedMachineId: null,
    }).select("_id quantity noOfRolls").lean();
    if (!spare.length) continue;
    const qty = spare.reduce((n, r) => n + (Number(r.quantity) || 0), 0);
    const rolls = spare.reduce((n, r) => n + (Number(r.noOfRolls) || 0), 0);
    await PendingProduction.updateOne(
      { _id: m._id },
      { $inc: { quantity: qty, ...(rolls ? { noOfRolls: rolls } : {}) } },
    );
    await PendingProduction.deleteMany({ _id: { $in: spare.map((r) => r._id) } });
    remerged += spare.length;
  }

  res.locals.auditDescription = `Dissolved ${batch.deckleOnly ? "deckle-only " : ""}deckle batch ${id}`
    + (remerged ? ` (folded ${remerged} remainder row(s) back into their orders)` : "");
  req.flash("notification", batch.deckleOnly
    ? "Deckle Only batch removed — it carried no orders."
    : "Deckle batch dissolved — its orders are back on Deckle Set.");
  res.redirect(backTo);
});

// Deckle Queue -- deckle batches (and any legacy per-order rows) that HAVE a
// deckle size but aren't yet assigned to a machine. Just the spec needed to
// make the deckle -- Product Code, the two running lengths, deckle qty and
// deckle size -- plus a Play button
// straight into Assign Production (/labels/production/assign/:id). Batched
// member orders (deckleBatchId set) are excluded -- only the batch itself
// shows. A size change goes back through Deckle Set (dissolve + re-batch).
router.get("/labels/production/deckle-queue", async (req, res) => {
  const pending = await PendingProduction.find({
    assignedMachineId: null,
    deckleSize: { $ne: null },
    deckleBatchId: null,
  })
    .populate("itemId", "productCode skuCode")
    .sort({ createdAt: 1 })
    .lean();
  // Advance rolls in each batch -- flagged until their real orders land.
  const advance = await advanceShareByBatch(pending.filter((r) => r.isDeckleBatch).map((r) => r._id));

  const rows = pending.map((r) => {
    const item = r.itemId || {};
    return {
      _id: String(r._id),
      productCode: item.productCode || item.skuCode || "—",
      advance: advance.get(String(r._id)) || null,
      isBatch: !!r.isDeckleBatch,
      deckleOnly: !!r.deckleOnly,
      orderCount: r.isDeckleBatch ? (r.batchOrderIds || []).length : 1,
      // Dissolve lives here now -- Deckle Sorting only lists orders that still
      // need a deckle set, so a formed batch is un-made from this page.
      canDissolve: !!r.isDeckleBatch,
      deckleSize: r.deckleSize ?? null,
      // The two lengths the shopfloor needs, as separate numbers rather than
      // the one "1,000 M/DECKLE · 4,000 M TOTAL" line: one deckle web's length,
      // and the whole job across every roll slit off it.
      runningMeters:
        r.deckleRunningMeters != null && r.deckleRunningMeters !== ""
          ? Number(r.deckleRunningMeters)
          : null,
      // Derived, not `r.runningMeters` -- see utils/deckleTotals.js for why
      // that field cannot be trusted as a total on a batch.
      totalRunningMeters: deckleTotalRunningMetres(r),
      // Deckle Qty -- how many deckle webs to laminate (set on Deckle Set from
      // the layouts' Webs counts), not the order's roll quantity.
      deckleQty: r.noOfRolls != null ? Number(r.noOfRolls) : null,
      createdAt: r.createdAt,
    };
  });

  res.render("inventory/orders/deckleQueue.ejs", {
    title: "Deckle Queue",
    CSS: "tableDisp.css",
    JS: false,
    rows,
    notification: req.flash("notification"),
  });
});

// One PendingProduction row as this page shows it. Module scope, and taken
// by BOTH the page render and the WIP poll below: the poll now decides which
// rows exist (a job appears the moment it is started and leaves when it is
// produced), so a second copy of this shaping is how the polled row and the
// rendered row would drift apart.
function mapPendingProductionRow(r, jobCardProgress, advance = new Map()) {
  const item = r.itemId || {};
  // Same rollsStatus classification as routes/system/machine.js's
  // buildQueueRows -- lets the WIP tab flag an order that was assigned to
  // a machine without (or without enough) raw material allocated, since
  // Assign Production no longer blocks on short stock.
  const rollsRequired = r.noOfRolls != null ? Number(r.noOfRolls) : null;
  const rollsAllotted = r.allottedRolls != null ? Number(r.allottedRolls) : null;
  const rollsStatus =
    rollsAllotted == null || rollsRequired == null
      ? null
      : rollsAllotted === rollsRequired
      ? "match"
      : rollsAllotted < rollsRequired
      ? "short"
      : "over";

  // "Not allocated" should mean the raw materials (Facestock/Adhesive/
  // Release Liner, ...) aren't allotted -- not "fewer Deckle reels have
  // been laminated than rolls were ordered" (rollsStatus above). A single
  // Assign & Continue only ever produces one Deckle, so an order needing
  // 2+ rolls reads "short" on rollsStatus right after its very first,
  // fully-allocated run -- material allocation is the real ready/not-ready
  // signal (see routes/system/machine.js's buildQueueRows for the same
  // split, used by the machine queue this WIP tab links out to).
  const requiredLayers = requiredLayersFor(item.rollType);
  const materialStatus = requiredLayers.length === 0
    ? null
    : requiredLayers.every((key) => !!r.allottedLayers?.[key])
    ? "match"
    : "short";

  // Same allotment facts as materialStatus above, split per raw-material
  // pool (Facestock/Adhesive/Release Liner) instead of collapsed into one
  // yes/no -- DOUBLE FACESTOCK/DOUBLE RELEASE rollTypes call for 2 layers
  // out of the same pool (facestock+facestock2, or adhesive+adhesive2 /
  // releaseLiner+releaseLiner2), so "one of two allotted" needs its own
  // "partial" state distinct from "none" and "full".
  const poolStatus = (pool) => {
    const keys = requiredLayers.filter((key) => LAYER_META[key].pool === pool);
    if (keys.length === 0) return null;
    const allottedCount = keys.filter((key) => !!r.allottedLayers?.[key]).length;
    if (allottedCount === 0) return "none";
    if (allottedCount === keys.length) return "full";
    return "partial";
  };
  const facestockStatus = poolStatus("facestock");
  const adhesiveStatus = poolStatus("adhesive");
  const releaseStatus = poolStatus("release");

  const progress = jobCardProgress.get(String(r._id)) || null;
  return {
    _id: String(r._id),
    productCode: item.productCode || item.skuCode || "—",
    clientName: r.userId?.clientName || r.userId?.userName || "—",
    userName: r.userId?.userName || "—",
    clientType: r.userId?.clientType || "",
    paperSize: r.paperSize || "—",
    deckleSize: r.deckleSize ?? null,
    runningMeters: r.runningMeters != null && r.runningMeters !== "" ? Number(r.runningMeters) : null,
    // The whole job's web metres -- what the WIP tab's "Total Mtrs Required"
    // shows. Derived (utils/deckleTotals.js), the same figure the machine
    // queue shows: a batch's stored runningMeters is not a total.
    totalRunningMeters: deckleTotalRunningMetres(r),
    noOfRolls: r.noOfRolls ?? "—",
    allottedRolls: rollsAllotted,
    rollsStatus,
    materialStatus,
    facestockStatus,
    adhesiveStatus,
    releaseStatus,
    quantity: r.quantity,
    balance: Math.max((Number(r.quantity) || 0) - (Number(r.dispatchedQuantity) || 0), 0),
    machineName: r.assignedMachineId?.machineName || "",
    assignedMachineId: r.assignedMachineId ? { _id: String(r.assignedMachineId._id) } : null,
    operatorName: r.operatorId?.empNickName || r.operatorId?.empName || "",
    helperName: r.helperId?.empName || "",
    poNumber: r.poNumber || "—",
    estimatedDate: r.estimatedDate,
    remarks: r.remarks || "",
    producedAt: r.producedAt || null,
    createdAt: r.createdAt,
    assignedAt: r.assignedAt || null,
    liveUpdate: progress,
    // The WIP tab's Live column: the deckle running now, its metres and ETA
    // at the machine's speed (Machine Master; 15 mtrs/min if none set), and when the whole job should be done.
    runPlan: progress ? buildRunPlan(r, progress, r.assignedMachineId?.speedMpm > 0 ? r.assignedMachineId.speedMpm : undefined) : null,
    // Whether "Send Back to Pending" can work, decided by the same facts the
    // POST refuses on (see /labels/production/unassign/:id): anything already
    // produced, or a reel reconciled mid-job, can't be reversed from here.
    // Being merely STARTED doesn't block it -- a job punched Start by mistake,
    // with nothing made yet, is exactly the one worth sending back, and the
    // server allows it. The button used to go dead on any Job Card activity
    // at all, which disagreed with what the server would actually do.
    canSendBack: !(
      r.producedAt
      || Number(r.producedRolls) > 0
      || (progress?.production?.length || 0) > 0
      || (r.materialSwapLog || []).length > 0
    ),
    isDeckleBatch: !!r.isDeckleBatch,
    batchOrderCount: (r.batchOrderIds || []).length,
    deckleBatchId: r.deckleBatchId ? String(r.deckleBatchId) : null,
    // Advance rolls in this batch (advanceShareByBatch) -- or the row IS an
    // advance order. Flags it until the real order takes it over.
    advance: advance.get(String(r._id)) || (r.isAdvance ? { rolls: Number(r.quantity) || 0, orders: 1 } : null),
  };
}

router.get("/labels/production/pending", async (req, res) => {
  const initialTab = req.query.tab === "wip" ? "wip" : "pending";

  // The "Pending" tab is superseded by Deckle Set -- that page now lists
  // every not-yet-assigned order (whether its deckle size is set or not),
  // with a Play button straight into Assign Production once it is. Only the
  // WIP tab still renders from here.
  if (initialTab !== "wip") {
    return res.redirect("/app/labels/production/deckle-set");
  }

  const all = await PendingProduction.find({})
    .populate("userId", "clientName userName clientType")
    .populate("itemId", "productCode skuCode rollType")
    .populate("assignedMachineId", "machineName machineType speedMpm")
    .populate("operatorId", "empName empNickName")
    .populate("helperId", "empName")
    .sort({ createdAt: -1 })
    .lean();

  let jobCardProgress = new Map();
  if (initialTab === "wip") {
    // Same "currently in the machine" definition the machine queue itself
    // uses (buildQueueRows in routes/system/machine.js): assignedMachineId
    // set AND producedAt still unset. Once producedAt is stamped the order
    // is fully produced and off every machine queue -- it belongs in the Job
    // Card log (GET /machine/jobcard/view), not this WIP list.
    const wipIds = all.filter((r) => r.assignedMachineId && !r.producedAt).map((r) => r._id);
    jobCardProgress = await buildJobCardProgressMap(wipIds);
  }

  const advance = await advanceShareByBatch(all.filter((r) => r.isDeckleBatch).map((r) => r._id));
  const mapped = all.map((r) => mapPendingProductionRow(r, jobCardProgress, advance));

  // A row only reaches this "Pending" tab once it's been through Deckle Set
  // (deckleSize set) -- an order still awaiting that shows on the Deckle Set
  // page instead (see GET /labels/production/deckle-set). It then leaves
  // Pending the moment assignedMachineId is set (Assign Production), and
  // only leaves this page entirely once removePendingProduction deletes it
  // after confirm/dispatch/cancel.
  // A batched member order (deckleBatchId set) is in production as part of its
  // batch -- it must not show here as a loose pending row; only the batch does.
  const orders = mapped.filter((r) => !r.assignedMachineId && r.deckleSize != null && !r.deckleBatchId);
  // Same producedAt condition as jobCardProgress above -- a fully produced
  // order is no longer "in the machine", just waiting on Sales to
  // confirm/dispatch it off this queue entirely.
  // WIP is work IN PROGRESS: only jobs an operator has actually started.
  // Being assigned to a machine is not started -- an order can sit on a
  // machine queue for days before anyone picks it up, and listing those here
  // buried the handful of jobs genuinely running. `liveUpdate` is exactly
  // that test (see buildJobCardProgressMap): a Start punched, reels scanned,
  // a Deckle made, or a card filed. An assigned-but-untouched order is on its
  // machine's queue, which every row here links straight out to.
  const wipOrders = mapped
    .filter((r) => r.assignedMachineId && !r.producedAt && r.liveUpdate)
    .sort((a, b) => new Date(b.estimatedDate || 0) - new Date(a.estimatedDate || 0));

  res.render("inventory/orders/pendingProduction.ejs", {
    title: initialTab === "wip" ? "WIP" : "Pending Production",
    CSS: "tableDisp.css",
    JS: false,
    orders,
    wipOrders,
    initialTab,
    notification: req.flash("notification"),
  });
});

// Polled by the WIP table. It answers with the whole list, not just the
// progress figures: a job now JOINS this tab when its operator starts it and
// LEAVES when it is produced, so the poll has to be able to add and drop rows
// as well as update them. Same query, same mapper and same filter as the page
// render above -- the two must not be able to disagree about what is running.
async function loadWipRows() {
  const assigned = await PendingProduction.find({ assignedMachineId: { $ne: null }, producedAt: null })
    .populate("userId", "clientName userName clientType")
    .populate("itemId", "productCode skuCode rollType")
    .populate("assignedMachineId", "machineName machineType speedMpm")
    .populate("operatorId", "empName empNickName")
    .populate("helperId", "empName")
    .lean();
  const progress = await buildJobCardProgressMap(assigned.map((r) => r._id));
  const advance = await advanceShareByBatch(assigned.filter((r) => r.isDeckleBatch).map((r) => r._id));
  return assigned
    .map((r) => mapPendingProductionRow(r, progress, advance))
    .filter((r) => r.liveUpdate)
    .sort((a, b) => new Date(b.estimatedDate || 0) - new Date(a.estimatedDate || 0));
}

router.get("/labels/production/wip-progress", async (req, res) => {
  try {
    res.json(await loadWipRows());
  } catch (err) {
    console.error("WIP PROGRESS ERROR:", err);
    res.status(500).json([]);
  }
});

// ---------------------------------------------------------------------------
// Lot No -- PRODUCTCODE / FY / <year-letter><serial>, e.g. "C001WB / 26-27 /
// G001". The serial is scoped to one product code within one financial
// year: it starts at 1 for a product code's first lot of the year and
// climbs from there, resetting (with the year-letter) on the next financial
// year -- it answers "how many lots has THIS product had THIS year", not a
// company-wide total.
//
// Deliberately NOT a Counter document. The field stays manually editable at
// Assign Production (see the GET/POST handlers below), and "the series
// continues from whatever was last entered, including by hand" falls out
// for free if the next auto lot no is always read off the highest serial
// already saved -- there is no separate counter to fall behind a manual
// edit or to resync. The cost is an extra couple of indexed-field queries
// per assignment, which this action is far too infrequent to notice.
// ---------------------------------------------------------------------------

const formatStructuredLotNo = (itemCode, fy, yearLetter, serial) =>
  `${itemCode} / ${fy} / ${yearLetter}${String(serial).padStart(3, "0")}`;

const normalizeLotItemCode = (value) => String(value ?? "").trim().toUpperCase();

// Matches a structured Lot No for one product code + financial year +
// year-letter, capturing the trailing serial. Tolerant of extra/missing
// whitespace around the slashes, since a hand-typed Lot No won't necessarily
// match the auto-generated spacing exactly.
function lotNoSerialPattern(itemCode, fy, yearLetter) {
  return new RegExp(
    `^${escapeRegex(itemCode)}\\s*\\/\\s*${escapeRegex(fy)}\\s*\\/\\s*${escapeRegex(yearLetter)}(\\d+)\\s*$`,
    "i",
  );
}

// The highest serial already in use for this product code + financial year
// -- across both the live order (PendingProduction) and the permanent
// production record (MachineJobCard), the same two places the old global
// counter checked for collisions. This IS "the last no" the series
// continues from: a Lot No typed by hand at Assign Production becomes the
// new baseline the moment it's saved, because the very next lookup sees it.
async function highestLotNoSerial(itemCode, fy, yearLetter, { includeBaseline = true } = {}) {
  const pattern = lotNoSerialPattern(itemCode, fy, yearLetter);
  const [orders, cards, baseline] = await Promise.all([
    PendingProduction.find({ lotNo: pattern }).select("lotNo createdAt").lean(),
    MachineJobCard.find({ lotNo: pattern }).select("lotNo createdAt").lean(),
    // Lots made before this system tracked them (Lot No Setup page).
    includeBaseline ? LotNoBaseline.findOne({ productCode: itemCode, fy }).select("lastSerial forcedAt").lean() : null,
  ]);
  let max = Number(baseline?.lastSerial) || 0;
  for (const doc of [...orders, ...cards]) {
    // A forced override: lots filed before it no longer count.
    if (baseline?.forcedAt && doc.createdAt && new Date(doc.createdAt) < baseline.forcedAt) continue;
    const match = pattern.exec(String(doc.lotNo || "").trim());
    const n = match ? Number(match[1]) : 0;
    if (n > max) max = n;
  }
  return max;
}

// True when `value` is already a structured Lot No for this product code --
// i.e. it was minted under (or hand-typed to match) the current scheme.
// Anything else -- most notably an order assigned before this scheme existed
// (the old flat "SP | LOT | 0042") -- reads as false, which is what lets the
// Assign Production page offer a fresh, correctly-structured suggestion
// instead of echoing the stale value back at the user forever (see
// previewLotNo in the GET handler below). It does NOT check the financial
// year or year-letter -- an order assigned last year and only now being
// re-opened (via Undo) should keep showing its own real lot no, not get a
// new one suggested just because the calendar moved on.
function isStructuredLotNo(value, itemCodeRaw) {
  const itemCode = normalizeLotItemCode(itemCodeRaw);
  if (!value || !itemCode) return false;
  return new RegExp(`^${escapeRegex(itemCode)}\\s*\\/\\s*\\d{2}-\\d{2}\\s*\\/\\s*[A-Z]+\\d+\\s*$`, "i").test(String(value).trim());
}

// Read-only preview of the next lot no for this product code -- shown on the
// Assign Production page before anything is submitted. Does not claim a
// serial. Empty product code (nothing to key the series off) previews as "".
async function previewNextLotNo(itemCodeRaw, date = new Date()) {
  const itemCode = normalizeLotItemCode(itemCodeRaw);
  if (!itemCode) return "";
  const fy = financialYearLabel(date);
  const yearLetter = financialYearLetter(date);
  const next = (await highestLotNoSerial(itemCode, fy, yearLetter)) + 1;
  return formatStructuredLotNo(itemCode, fy, yearLetter, next);
}

// Claims the next lot no for real. Retries against a live uniqueness check
// (PendingProduction.lotNo is unique) in case of a race -- two assignments
// for the same product code at once, or a manually-typed Lot No that has
// already claimed the very number this attempt computed.
async function generateLotNo(itemCodeRaw, date = new Date()) {
  const itemCode = normalizeLotItemCode(itemCodeRaw);
  if (!itemCode) throw new Error("A product code is required to generate a lot no");
  const fy = financialYearLabel(date);
  const yearLetter = financialYearLetter(date);
  const base = await highestLotNoSerial(itemCode, fy, yearLetter);

  for (let attempt = 1; attempt <= 10000; attempt++) {
    const candidate = formatStructuredLotNo(itemCode, fy, yearLetter, base + attempt);
    const [heldByOrder, onJobCard] = await Promise.all([
      PendingProduction.exists({ lotNo: candidate }),
      MachineJobCard.exists({ lotNo: candidate }),
    ]);
    if (!heldByOrder && !onJobCard) return candidate;
  }
  throw new Error("Unable to generate a unique lot no");
}

// ----------------------------------Assign Production---------------------------------->
// No ProductionBinding/die gate here (see the Prod Bind View comment above) --
// this goes straight from Pending Production to machine/operator/roll
// assignment, budgeted against the order's own paperSize/runningMeters/
// noOfRolls (collected at Sales Order entry for Label Stock orders).
router.get("/labels/production/assign/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      req.flash("notification", "Invalid order id.");
      return res.redirect("/app/labels/production/deckle-set");
    }

    const pendingProduction = await PendingProduction.findById(id)
      .populate("userId", "clientName userName userContact")
      .populate("itemId", "labelStockId skuCode productCode rollType facestock adhesive releaseLiner facestock2 adhesive2 releaseLiner2")
      .lean();

    if (!pendingProduction) {
      req.flash("notification", "Order not found.");
      return res.redirect("/app/labels/production/deckle-set");
    }

    const [allMachines, operatorEmployees, helperEmployees] = await Promise.all([
      Machine.find().populate("location").sort({ machineName: 1 }).lean(),
      Employee.find({ isActive: true, empProfile: "OPERATOR" }, "empName empProfileCode").sort({ empName: 1 }).lean(),
      Employee.find({ isActive: true, empProfile: "HELPER" }, "empName empProfileCode").sort({ empName: 1 }).lean(),
    ]);

    // An order carrying an old-scheme Lot No ("SP | LOT | 0042", from before
    // this product-code-structured format existed) gets a fresh, correctly
    // structured suggestion here instead -- it's only ever a SUGGESTION
    // (the input stays editable, and nothing is saved until the page is
    // submitted), so revisiting this page can't silently change an order
    // that already has a proper one.
    const lotItemCode = pendingProduction.itemId?.productCode;
    const previewLotNo = (pendingProduction.lotNo && (isStructuredLotNo(pendingProduction.lotNo, lotItemCode) || !lotItemCode))
      ? pendingProduction.lotNo
      : await previewNextLotNo(lotItemCode);
    // Rolls in this batch set ahead of their sales order -- flagged here too.
    const advance = pendingProduction.isDeckleBatch
      ? (await advanceShareByBatch([pendingProduction._id])).get(String(pendingProduction._id)) || null
      : null;

    // How much facestock/adhesive/release liner this deckle will eat -- the
    // formulas from "raw material formula.xlsx" (see utils/rawMaterialNeed.js).
    // null when the deckle has no size/web length yet to weigh from.
    const rawNeed = computeRawMaterialNeed(pendingProduction, pendingProduction.itemId || {});

    res.render("inventory/orders/assignProduction.ejs", {
      title: "Assign Production",
      CSS: "tableDisp.css",
      // The Auto Allot planner -- which raw-material reels this job should run
      // off, FIFO, and how much of it the shortest layer allows. Kept out of
      // the page so the arithmetic can be tested on its own (see
      // scripts/raw-auto-allot-bench.js); the page measures the reels and
      // renders the result.
      JS: "rawAutoAllot.js",
      pp: pendingProduction,
      // Whether the Deckle Qty can be edited here: a deckle batch not yet
      // produced and not being run on a device right now. Same test the POST
      // makes (see deckle-count below), so the button and the save agree.
      deckleQtyEditable: !!pendingProduction.isDeckleBatch && !pendingProduction.producedAt && !activeClaim(pendingProduction.runningOn),
      advance,
      rawNeed,
      // One web's length x how many webs. Derived here rather than read off
      // pp.runningMeters, which on a batch is a sum of the member orders'
      // per-roll lengths -- see utils/deckleTotals.js.
      totalRunningMeters: deckleTotalRunningMetres(pendingProduction),
      allMachines,
      operatorEmployees,
      helperEmployees,
      previewLotNo,
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("ASSIGN PRODUCTION LOAD ERROR:", err);
    req.flash("notification", "Failed to load Assign Production.");
    res.redirect("/app/labels/production/deckle-set");
  }
});

// Changes a deckle batch's Deckle Qty (noOfRolls) from its Assign Production
// page. The webs are split across the batch's layouts (deckleLayout[].count,
// which sum to the Deckle Qty), so the layouts move with it: extra webs go on
// the last layout, and webs taken away come off the last layout first. A
// layout never drops below the webs already slit on it, nor below one.
//
// Refused once the job has been produced or has started on a device, and when
// the new count would fall under the webs already made or already on a
// slitting card -- those are real stock and real cuts, not plan.
router.post("/labels/production/assign/:id/deckle-count", requireAuth, updateLimiter, async (req, res) => {
  const back = `/app/labels/production/assign/${req.params.id}`;
  const refuse = (message) => {
    req.flash("notification", message);
    return res.redirect(back);
  };
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) return refuse("Invalid order id.");
    const next = Number(String(req.body.noOfRolls ?? "").trim());
    if (!Number.isInteger(next) || next < 1 || next > 9999) {
      return refuse("Deckle Qty must be a whole number from 1 to 9999.");
    }

    const pp = await PendingProduction.findById(id)
      .select("isDeckleBatch noOfRolls producedAt producedRolls runningOn lotNo deckleLayout")
      .lean();
    if (!pp) return refuse("Order not found.");
    if (!pp.isDeckleBatch) return refuse("Only a deckle batch has a Deckle Qty to change.");
    if (pp.producedAt) return refuse("This job has already been produced, so its Deckle Qty is fixed.");
    // A fresh device claim means it is being run right now. A stale one (the
    // tablet went away) no longer blocks: the job is still started, so the
    // webs it has already made are counted below.
    if (activeClaim(pp.runningOn)) {
      return refuse("A device is running this job right now. Save its job card before changing the Deckle Qty.");
    }
    // Filed on the job card (producedRolls) or already stamped by a Stop punch
    // that is not yet filed -- both are real stock from this job.
    const stamped = await MaterialStock.countDocuments({ producedFor: pp._id, producedVia: "jobcard" });
    const made = Math.max(Number(pp.producedRolls) || 0, stamped);
    if (next < made) {
      return refuse(`${made} deckle(s) are already made from this job, so the Deckle Qty can't go below ${made}.`);
    }

    // Every web of this batch that is already on a slitting card, by layout.
    const cards = await SlittingJobCard.find({ pendingProductionId: pp._id }).select("slittingLog.cuts").lean();
    const slitRows = cards.flatMap((c) => c.slittingLog || []);
    if (next < slitRows.length) {
      return refuse(`${slitRows.length} web(s) are already on slitting cards for this job, so the Deckle Qty can't go below ${slitRows.length}.`);
    }
    const slitSigs = slitRows.map((r) => cutsSignature(r.cuts)).filter(Boolean);

    const layouts = Array.isArray(pp.deckleLayout) ? pp.deckleLayout : [];
    const $set = { noOfRolls: next };
    if (layouts.length) {
      const counts = layouts.map((L) => Math.max(1, Number(L.count) || 1));
      const floors = layouts.map((L) => {
        const sig = cutsSignature(L.cuts);
        const onSlit = sig ? slitSigs.filter((s) => s === sig).length : 0;
        return Math.max(1, onSlit);
      });
      const out = counts.slice();
      const delta = next - counts.reduce((a, b) => a + b, 0);
      if (delta > 0) {
        out[out.length - 1] += delta;
      } else if (delta < 0) {
        let take = -delta;
        for (let i = out.length - 1; i >= 0 && take > 0; i--) {
          const cut = Math.min(Math.max(0, out[i] - floors[i]), take);
          out[i] -= cut;
          take -= cut;
        }
        if (take > 0) {
          return refuse(`The layouts can't give up ${-delta} web(s) without going below the webs already slit on them. Re-plan this batch on Deckle Set instead.`);
        }
      }
      layouts.forEach((_, i) => {
        $set[`deckleLayout.${i}.count`] = out[i];
      });
    }

    // Guarded on the same facts the checks above read, so a job that starts
    // or is produced between the read and the write is refused, not changed.
    const staleBefore = new Date(Date.now() - JOB_CLAIM_STALE_MS);
    const result = await PendingProduction.updateOne(
      {
        _id: pp._id,
        producedAt: null,
        $or: [
          { runningOn: null },
          { "runningOn.lastSeenAt": { $lt: staleBefore } },
          { "runningOn.lastSeenAt": null, "runningOn.claimedAt": { $lt: staleBefore } },
        ],
        producedRolls: { $lte: next },
      },
      { $set },
    );
    if (!result.matchedCount) {
      return refuse("This job changed while you were editing it. Reload the page and try again.");
    }

    res.locals.auditDescription = `Changed Deckle Qty of "${pp.lotNo || id}" from ${pp.noOfRolls ?? "—"} to ${next}`;
    req.flash("notification", `Deckle Qty changed from ${pp.noOfRolls ?? "—"} to ${next}.`);
    return res.redirect(back);
  } catch (err) {
    console.error("DECKLE QTY EDIT ERROR:", err);
    return refuse("Failed to change the Deckle Qty.");
  }
});

// ---------------------------------------------------------------------------
// TEMPORARY: Lot No Setup. Production was already running before this system
// kept lot numbers, so the series for each product code has to be told where
// it stands: "the last Lot No used was G014" makes the next one G015. One row
// per product code for the current financial year; Save writes that row only.
//
// It is a dialog on Assign Production (the gear beside Lot No), which loads
// its rows from the GET below and saves one row at a time with the POST --
// both answer JSON. There is no page of its own: reloading Assign Production
// to refresh would throw away reels the planner has already ticked.
// ---------------------------------------------------------------------------
const LOT_SETUP_ROLES = ["proprietor", "admin", "hod"];
const lotSetupAllowed = (req) => LOT_SETUP_ROLES.includes(req.session?.authUser?.role);

// Highest serial already recorded per product code (orders + job cards) for
// one financial year, in two queries rather than three per product. Reads a
// Lot No the same tolerant way lotNoSerialPattern does.
async function recordedLotSerialsByCode(fy, yearLetter) {
  const any = new RegExp(
    `^(.+?)\\s*\\/\\s*${escapeRegex(fy)}\\s*\\/\\s*${escapeRegex(yearLetter)}(\\d+)\\s*$`,
    "i",
  );
  const [orders, cards] = await Promise.all([
    PendingProduction.find({ lotNo: any }).select("lotNo").lean(),
    MachineJobCard.find({ lotNo: any }).select("lotNo").lean(),
  ]);
  const byCode = new Map();
  for (const doc of [...orders, ...cards]) {
    const m = any.exec(String(doc.lotNo || "").trim());
    if (!m) continue;
    const code = normalizeLotItemCode(m[1]);
    const n = Number(m[2]);
    if (n > (byCode.get(code) || 0)) byCode.set(code, n);
  }
  return byCode;
}

router.get("/labels/production/lot-no-setup", async (req, res) => {
  try {
    if (!lotSetupAllowed(req)) return res.status(403).json({ error: "You can't change the Lot No series." });
    const fy = financialYearLabel();
    const yearLetter = financialYearLetter();
    const [codesRaw, recorded, baselines] = await Promise.all([
      SachikoLabelStock.distinct("productCode"),
      recordedLotSerialsByCode(fy, yearLetter),
      LotNoBaseline.find({ fy }).select("productCode lastSerial forcedAt").lean(),
    ]);
    const baseByCode = new Map(baselines.map((b) => [normalizeLotItemCode(b.productCode), b.lastSerial]));
    // A forced series ignores the lots filed before the override.
    const forcedCodes = baselines.filter((b) => b.forcedAt).map((b) => normalizeLotItemCode(b.productCode));
    for (const fc of forcedCodes) recorded.set(fc, await highestLotNoSerial(fc, fy, yearLetter, { includeBaseline: false }));
    // A "-A"/"-B" variant is never something an order is placed against and is
    // not listed: only masters are (a variant whose master isn't a product at
    // all stands in for it).
    const all = [...new Set(codesRaw.map(normalizeLotItemCode).filter(Boolean))].sort();
    const known = new Set(all);
    const codes = all.filter((c) => deckleBaseCode(c) === c || !known.has(deckleBaseCode(c)));
    const rows = codes.map((code) => {
      const highest = forcedCodes.includes(code) ? baseByCode.get(code) || 0 : Math.max(recorded.get(code) || 0, baseByCode.get(code) || 0);
      return {
        code,
        // true once a starting number was typed for it here
        isSet: baseByCode.has(code),
        forced: forcedCodes.includes(code),
        highest,
        last: highest ? formatStructuredLotNo(code, fy, yearLetter, highest) : "",
        next: formatStructuredLotNo(code, fy, yearLetter, highest + 1),
      };
    });
    return res.json({ fy, yearLetter, rows });
  } catch (err) {
    console.error("LOT NO SETUP LOAD ERROR:", err);
    return res.status(500).json({ error: "Failed to load the Lot No series." });
  }
});

router.post("/labels/production/lot-no-setup", requireAuth, updateLimiter, async (req, res) => {
  const refuse = (message, status = 400) => res.status(status).json({ error: message });
  try {
    if (!lotSetupAllowed(req)) return refuse("You can't change the Lot No series.", 403);
    const code = normalizeLotItemCode(req.body.productCode);
    const raw = String(req.body.lastSerial ?? "").trim();
    if (!code) return refuse("Product Code is required.");
    if (!/^\d{1,6}$/.test(raw)) return refuse("Last Lot No must be a whole number, e.g. 14 for G014.");
    if (!(await SachikoLabelStock.exists({ productCode: code }))) return refuse(`Unknown Product Code "${code}".`);

    const fy = financialYearLabel();
    const yearLetter = financialYearLetter();
    const serial = Number(raw);

    // Lots already recorded in the system can't be un-used: the series may be
    // moved forward to match the paper records, never behind what exists.
    // `force` overrides that: the series is set exactly as typed, and only
    // lots filed from now on count toward it (forcedAt).
    const force = ["1", "true", "on"].includes(String(req.body.force ?? "").toLowerCase());
    const recorded = await highestLotNoSerial(code, fy, yearLetter, { includeBaseline: false });
    if (serial < recorded && !force) {
      return refuse(
        `${code}: ${formatStructuredLotNo(code, fy, yearLetter, recorded)} is already recorded in the system, so the last Lot No can't be set below ${recorded}. Tick "Force override" to set it anyway.`,
      );
    }
    const forcedBelow = force && serial < recorded;

    await LotNoBaseline.updateOne(
      { productCode: code, fy },
      { $set: { lastSerial: serial, updatedBy: req.session?.authUser?.name || req.session?.authUser?.role || "", ...(forcedBelow ? { forcedAt: new Date() } : {}) } },
      { upsert: true },
    );
    const last = formatStructuredLotNo(code, fy, yearLetter, serial);
    const next = formatStructuredLotNo(code, fy, yearLetter, serial + 1);
    res.locals.auditDescription = `Set last Lot No of "${code}" (${fy}) to ${last}${forcedBelow ? ` (FORCED below recorded ${formatStructuredLotNo(code, fy, yearLetter, recorded)})` : ""}`;
    return res.json({
      ok: true,
      message: `${code}: last Lot No set to ${last}. Next will be ${next}.`,
      row: { code, isSet: true, forced: forcedBelow, highest: serial, last, next },
    });
  } catch (err) {
    console.error("LOT NO SETUP ERROR:", err);
    return refuse("Failed to save the last Lot No.", 500);
  }
});

router.post("/labels/production/assign/:id/lot-no", requireAuth, updateLimiter, async (req, res) => {
  const back = `/app/labels/production/assign/${req.params.id}`;
  const refuse = (message) => {
    req.flash("notification", message);
    return res.redirect(back);
  };
  // Switched off for now: the last Lot No used is set once per product on
  // the Lot No Setup page instead (/labels/production/lot-no-setup). Remove
  // this line (and re-enable the pencil in assignProduction.ejs) to restore.
  return refuse("Editing the Lot No here is switched off. Set the last Lot No used on the Lot No Setup page.");
  // eslint-disable-next-line no-unreachable
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) return refuse("Invalid order id.");
    const next = String(req.body.lotNo ?? "").trim();
    if (!next) {
      return refuse("Lot No cannot be empty.");
    }

    const pp = await PendingProduction.findById(id)
      .select("lotNo producedAt runningOn")
      .lean();
    if (!pp) return refuse("Order not found.");
    if (pp.producedAt) return refuse("This job has already been produced, so its Lot No is fixed.");
    if (activeClaim(pp.runningOn)) {
      return refuse("A device is running this job right now. Save its job card before changing the Lot No.");
    }

    // Check if this lot no collides with another order
    const existing = await PendingProduction.findOne({
      _id: { $ne: pp._id },
      lotNo: next,
    }).select("_id").lean();
    if (existing) {
      return refuse("This Lot No is already in use by another order. Please choose a different one.");
    }

    await PendingProduction.updateOne({ _id: pp._id }, { $set: { lotNo: next } });

    res.locals.auditDescription = `Changed Lot No of order "${id}" from "${pp.lotNo || "—"}" to "${next}"`;
    req.flash("notification", `Lot No changed from "${pp.lotNo || "—"}" to "${next}".`);
    return res.redirect(back);
  } catch (err) {
    console.error("LOT NO EDIT ERROR:", err);
    return refuse("Failed to change the Lot No.");
  }
});

router.post("/labels/production/assign/:id", requireAuth, updateLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      req.flash("notification", "Invalid order id.");
      return res.redirect("/app/labels/production/deckle-set");
    }

    const pendingProduction = await PendingProduction.findById(id);
    if (!pendingProduction) {
      req.flash("notification", "Order not found.");
      return res.redirect("/app/labels/production/deckle-set");
    }

    const { machineId, operatorId, helperId, selectedRolls, rawLayers } = req.body;
    const rawProduceMtrs = Number(req.body.rawProduceMtrs);

    if (!machineId || !mongoose.isValidObjectId(machineId)) {
      req.flash("notification", "Please select a valid machine.");
      return res.redirect(`/app/labels/production/assign/${id}`);
    }
    const machine = await Machine.findById(machineId).populate("location").lean();
    if (!machine) {
      req.flash("notification", "Please select a valid machine.");
      return res.redirect(`/app/labels/production/assign/${id}`);
    }

    let operator = null;
    if (operatorId) {
      if (!mongoose.isValidObjectId(operatorId) || !(operator = await Employee.findById(operatorId).select("_id").lean())) {
        req.flash("notification", "Please select a valid operator.");
        return res.redirect(`/app/labels/production/assign/${id}`);
      }
    }
    let helper = null;
    if (helperId) {
      if (!mongoose.isValidObjectId(helperId) || !(helper = await Employee.findById(helperId).select("_id").lean())) {
        req.flash("notification", "Please select a valid helper.");
        return res.redirect(`/app/labels/production/assign/${id}`);
      }
    }

    // Re-verify each ticked roll is real, in-stock, and not already claimed by
    // another machine-assigned order (race-guard against stale page state).
    const submittedRollIds = (Array.isArray(selectedRolls) ? selectedRolls : selectedRolls ? [selectedRolls] : [])
      .filter((rid) => mongoose.isValidObjectId(rid));
    const validRollIds = submittedRollIds.length
      ? await MaterialStock.find({ _id: { $in: submittedRollIds }, quantity: { $gt: 0 } }).distinct("_id")
      : [];
    const takenAgg = validRollIds.length
      ? await PendingProduction.find({
          allottedRollIds: { $in: validRollIds },
          assignedMachineId: { $ne: null },
          _id: { $ne: pendingProduction._id },
        }).select("allottedRollIds").lean()
      : [];
    const takenSet = new Set(takenAgg.flatMap((p) => (p.allottedRollIds || []).map(String)));
    const allottedRollIds = validRollIds.filter((rid) => !takenSet.has(String(rid)));

    // Facestock/Adhesive/Release Liner columns on the assign form let the
    // operator pick raw-material reels straight from this page (see
    // assignProduction.ejs) -- if any were picked, laminate them into a new
    // Deckle now, at the machine's own location, for exactly the mtrs
    // submitted, then fold that new reel in with whatever existing Deckle
    // stock was ticked above.
    //
    // Raw material being short (missing reels, a reel too small, no location
    // on the machine, ...) must NOT block the assignment itself -- the order
    // still needs to land on the machine's queue (as a "short allotted" row,
    // see routes/system/machine.js's buildQueueRows/rollsStatus) so it's
    // visible and can be topped up later by re-opening this same page once
    // material is available. Only a genuinely bad submission (invalid
    // machine/operator/helper, checked above) rejects outright.
    const location = machine.location?.locationName;
    const labelStock = await SachikoLabelStock.findById(pendingProduction.itemId).lean();
    const required = labelStock ? requiredLayersFor(labelStock.rollType) : [];

    // Reels already claimed by another still-open WIP order's own raw-
    // material picks -- a physical reel/drum can only be mounted on one
    // machine at a time. Picking one of these for THIS order is a swap, not
    // a free pick: mandatory once submitted checked (see assignProduction.ejs,
    // which shows it as a badge before the operator ever gets here) -- it's
    // pulled off the other order's allottedLayers below, right after this
    // order's own save succeeds. Same "race-guard against stale page state"
    // the selectedRolls/takenSet check above already does for finished
    // Deckle rolls; this is its counterpart for raw facestock/adhesive/
    // release liner reels. Scoped to producedAt: null, same as
    // loadAllottedByKey (routes/stock/facestockStock.js etc.) -- once an
    // order has actually finished drawing from a reel, whatever is
    // physically left on it goes back to being free stock, not locked to
    // that (now complete) order forever.
    const otherPendingLayers = await PendingProduction.find({
      assignedMachineId: { $ne: null },
      producedAt: null,
      _id: { $ne: pendingProduction._id },
    }).select("allottedLayers liveMaterialInUse lotNo").lean();
    const claimedByKey = new Map();
    // Reels another still-open order has already started physically drawing
    // on (liveMaterialInUse, set the instant an operator scans it and
    // punches Start on a Job Setting/Production Log row -- see POST
    // /sachiko/machine/jobcard/mark-in-use). Unlike claimedByKey above (a
    // paper allotment, swappable via `swaps` below), a reel actually running
    // on another machine right now can never be accepted onto this order --
    // dropped outright further down, same as a stale/nonexistent id. This is
    // the server-side backstop for the disabled checkboxes assignProduction.ejs
    // already renders for these rows.
    const liveByKey = new Map();
    for (const p of otherPendingLayers) {
      for (const [layerKey, pick] of Object.entries(p.allottedLayers || {})) {
        if (!pick?.pool) continue;
        for (const sid of pickStockIds(pick)) {
          claimedByKey.set(`${pick.pool}|${sid}`, { orderId: String(p._id), layerKey, lotNo: p.lotNo || "" });
        }
      }
      for (const [pool, ids] of Object.entries(p.liveMaterialInUse || {})) {
        for (const sid of ids || []) {
          liveByKey.set(`${pool}|${sid}`, { orderId: String(p._id), lotNo: p.lotNo || "" });
        }
      }
    }

    // Record whichever raw-material layer reels were picked on the assign
    // form, independent of whether every layer got picked -- lets the
    // machine queue show allocation per material (Facestock/Adhesive/
    // Release Liner, ...) rather than only the all-or-nothing Deckle count
    // further down. A layer's checkboxes (assignProduction.ejs) can submit
    // more than one reel now -- e.g. combining two undersized drums onto one
    // order -- so `rawLayers[key]` may be a single id or an array of them.
    // Existence-checked against the right pool model so a stale/tampered id
    // can't leave a broken reference on the order. A reel already claimed by
    // another order is still accepted (not dropped) -- it's queued in
    // `swaps` below and pulled off that order once this one's own save
    // succeeds.
    let allottedLayers = {};
    const pickedForThisOrder = new Set();
    const swaps = [];
    let droppedInUseCount = 0;
    for (const key of required) {
      const meta = LAYER_META[key];
      const submitted = rawLayers?.[key];
      const candidateIds = [...new Set((Array.isArray(submitted) ? submitted : submitted ? [submitted] : [])
        .filter((sid) => mongoose.isValidObjectId(sid)))];
      if (!candidateIds.length) continue;
      const { Model } = POOL_MODELS[meta.pool];
      const existingIds = new Set((await Model.find({ _id: { $in: candidateIds } }).distinct("_id")).map(String));
      // Dropped silently, same as a stale/nonexistent id -- a reel currently
      // running on another order's machine can't be accepted here no matter
      // what the client submitted (see liveByKey above); droppedInUseCount
      // just lets the user know afterwards, via variantNote-style messaging.
      const validIds = candidateIds.filter((sid) => existingIds.has(String(sid)) && !liveByKey.has(`${meta.pool}|${sid}`));
      droppedInUseCount += candidateIds.filter((sid) => existingIds.has(String(sid)) && liveByKey.has(`${meta.pool}|${sid}`)).length;
      // One reel or drum MAY serve more than one layer.
      //
      // DOUBLE RELEASE is made in two passes -- facestock + adhesive + liner
      // as normal, then a second adhesive and a second liner on top -- so both
      // coats can come off one drum and both liners off one reel: the second
      // pass unwinds it again, it does not need a second physical reel running
      // beside the first. Refusing that is what made these jobs unassignable:
      // the picker offers one bound drum (and often the one liner of that
      // spec), the operator ticks it on both layers because there is nothing
      // else to tick, and Assign & Continue bounced back here having allotted
      // nothing at all.
      //
      // What keeps the stock honest is not this check but the arithmetic in
      // utils/labelStockProduction.js's produceDeckle: a reel serving several
      // layers is measured ONCE against the sum of what those layers draw, and
      // deducted once for that sum. Checking per layer would pass a reel that
      // holds enough for one pass and not for two.
      validIds.forEach((sid) => {
        pickedForThisOrder.add(`${meta.pool}|${sid}`);
        const claim = claimedByKey.get(`${meta.pool}|${sid}`);
        if (claim) swaps.push({ ...claim, pool: meta.pool, stockId: sid });
      });
      if (validIds.length) allottedLayers[key] = { pool: meta.pool, stockIds: validIds.map(String) };
    }

    // A layer can hold several reels at once, and the operator can laminate
    // any one of them against any one of another layer's -- so two facestock
    // + two adhesive + two release liner reels aren't one recipe, they're
    // eight possible ones. Each combination that differs from this SKU's own
    // stored recipe (a substituted vendor, a different Size, ... -- the
    // fields POOL_MATCH_FIELDS deliberately doesn't pin down) is materially a
    // different label stock, so it's registered now as its own "-A"/"-B"/...
    // Product Code variant, instead of being discovered one at a time later
    // as Deckles get laminated. See trackAllottedCombinations.
    //
    // Never blocks the assignment: same rule as raw material being short
    // below -- the order still has to land on the machine's queue.
    let trackedVariants = null;
    let variantWarning = null;
    try {
      trackedVariants = await trackAllottedCombinations({ labelStock, allottedLayers });
    } catch (variantErr) {
      console.error("LABEL STOCK COMBINATION TRACKING ERROR:", variantErr);
      variantWarning = variantErr.userMessage || variantErr.message || "failed to check material combinations";
    }
    const newVariantCodes = trackedVariants?.created || [];

    let deckleId = null;
    let variantProductCode = null;
    let stockWarning = null;
    // Lot No is manually editable on this page (assignProduction.ejs),
    // pre-filled with the current/previewed value -- whatever is submitted
    // is what's saved, changed or not. This is also what makes "it should
    // follow the previous one entered" true for free: the next AUTO lot no
    // for this product+year is read straight off whatever's already saved
    // (see highestLotNoSerial above), so a hand-typed one becomes the new
    // baseline the instant this request saves it. Only checked for a
    // collision when it actually changed from what's on file -- an
    // unchanged resubmit (the normal case on a re-assignment after Undo)
    // can never collide with itself. A blank submission (no JS, or a bare
    // API call) falls back to the existing/auto value exactly as before.
    const typedLotNo = String(req.body.lotNo || "").trim().toUpperCase();
    let lotNo;
    if (typedLotNo) {
      if (typedLotNo !== pendingProduction.lotNo) {
        const [takenByOrder, takenByCard] = await Promise.all([
          PendingProduction.exists({ lotNo: typedLotNo, _id: { $ne: pendingProduction._id } }),
          MachineJobCard.exists({ lotNo: typedLotNo }),
        ]);
        if (takenByOrder || takenByCard) {
          req.flash("notification", `Lot No "${typedLotNo}" is already in use -- pick a different one.`);
          return res.redirect(`/app/labels/production/assign/${id}`);
        }
      }
      lotNo = typedLotNo;
    } else {
      lotNo = pendingProduction.lotNo || (await generateLotNo(labelStock?.productCode));
    }
    if (rawProduceMtrs > 0) {
      const layersPicked = required.length > 0 && required.every((key) => rawLayers && rawLayers[key]);

      if (!location) {
        stockWarning = "the selected machine has no location set";
      } else if (!layersPicked) {
        stockWarning = "not every raw-material layer has a reel selected";
      } else {
        try {
          const produced = await produceDeckle({
            labelStock,
            location,
            reelMtrs: rawProduceMtrs,
            lotNo,
            size: pendingProduction.paperSize,
            layers: rawLayers,
            createdBy: req.user?.username || "SYSTEM",
            // Stamps the reel as this order's own work, so sending the order
            // back to Pending can un-make it (dissolveDeckle) and leave any
            // Deckle merely ticked on from existing stock alone.
            producedFor: id,
          });
          deckleId = produced.deckleId;
          variantProductCode = produced.variantProductCode;
          allottedRollIds.push(new mongoose.Types.ObjectId(produced.stockId));
        } catch (produceErr) {
          stockWarning = produceErr.message || "failed to produce label stock";
        }
      }
    }

    await PendingProduction.findByIdAndUpdate(id, {
      $set: {
        assignedMachineId: machineId,
        operatorId: operator ? operatorId : null,
        helperId: helper ? helperId : null,
        allottedRolls: allottedRollIds.length,
        allottedRollIds,
        allottedLayers,
        lotNo,
        assignedAt: new Date(),
      },
    });
    // The tablets of whoever now has this order -- and of whoever had it before
    // a re-assignment -- reload their queues.
    notifyOperatorQueue(operator ? operatorId : null, pendingProduction.operatorId);

    // Complete the swap for every claimed reel that was just accepted onto
    // this order (see `swaps`/claimedByKey above): pull it out of whichever
    // layer the other order had it under, dropping that layer entirely if
    // it held nothing else. Done only now, after this order's own save
    // succeeded, so a failure earlier in this request can't strand a reel
    // pulled from another order without it actually landing here. Grouped by
    // order so an order that lost more than one reel to this submit (e.g.
    // both its facestock and adhesive picks) only gets touched once.
    const swappedFromLots = [];
    if (swaps.length) {
      const byOrder = new Map();
      for (const s of swaps) {
        if (!byOrder.has(s.orderId)) byOrder.set(s.orderId, []);
        byOrder.get(s.orderId).push(s);
      }
      for (const [otherOrderId, entries] of byOrder) {
        const other = await PendingProduction.findById(otherOrderId).select("allottedLayers lotNo").lean();
        if (!other) continue;
        const updatedLayers = { ...(other.allottedLayers || {}) };
        for (const { layerKey, stockId } of entries) {
          const pick = updatedLayers[layerKey];
          if (!pick) continue;
          const remaining = pickStockIds(pick).filter((sid) => String(sid) !== String(stockId));
          if (remaining.length) updatedLayers[layerKey] = { pool: pick.pool, stockIds: remaining.map(String) };
          else delete updatedLayers[layerKey];
        }
        await PendingProduction.updateOne({ _id: otherOrderId }, { $set: { allottedLayers: updatedLayers } });
        swappedFromLots.push(other.lotNo || otherOrderId);
      }
    }

    // Reported alongside whatever the assignment itself did, not instead of
    // it -- minting these variants is a side effect of the reels picked, and
    // whoever assigned the order is the one who needs to know it happened.
    const swapNote = swappedFromLots.length
      ? ` Note: ${swaps.length === 1 ? "one reel/drum" : `${swaps.length} reels/drums`} moved here off`
        + ` ${swappedFromLots.length === 1 ? "order" : "orders"} ${[...new Set(swappedFromLots)].map((l) => `"${l}"`).join(", ")}.`
      : "";
    const inUseNote = droppedInUseCount
      ? ` Note: ${droppedInUseCount === 1 ? "one reel/drum was" : `${droppedInUseCount} reels/drums were`} skipped -- currently in use on another job and can't be allotted here.`
      : "";
    const variantNote = variantWarning
      ? ` Note: the allotted material combinations couldn't be checked against Label Stock (${variantWarning}).`
      : newVariantCodes.length
        ? ` Note: ${newVariantCodes.length === 1 ? "one combination" : `${newVariantCodes.length} combinations`} of the allotted reels`
          + ` don't match this SKU's own spec (e.g. a different vendor) -- added to Label Stock as`
          + ` ${newVariantCodes.length === 1 ? "variant" : "variants"} ${newVariantCodes.map((c) => `"${c}"`).join(", ")}.`
          + (trackedVariants?.truncated ? " Some further combinations were left untracked (too many to enumerate)." : "")
        : "";

    res.locals.auditDescription = `Assigned production order ${id} to machine ${machineId}`
      + (deckleId ? ` (produced Deckle ${deckleId}${variantProductCode ? `, tracked as variant ${variantProductCode}` : ""})` : stockWarning ? " (stock not fully allocated)" : "")
      + (newVariantCodes.length ? ` (label stock variants added: ${newVariantCodes.join(", ")})` : "")
      + (swappedFromLots.length ? ` (swapped ${swaps.length} reel(s)/drum(s) off ${[...new Set(swappedFromLots)].join(", ")})` : "")
      + (droppedInUseCount ? ` (${droppedInUseCount} reel(s)/drum(s) skipped -- in use on another job)` : "");
    req.flash("notification", (deckleId
      ? `Machine assigned — Deckle ${deckleId} produced.`
        + (variantProductCode ? ` Note: the raw material picked doesn't exactly match this SKU's own spec (e.g. a different vendor) -- tracked as variant "${variantProductCode}" instead of plain ${labelStock?.productCode || "this SKU"}.` : "")
      : stockWarning
        ? `Machine assigned, but stock wasn't allocated (${stockWarning}) — this order is on the queue as short-allotted. Re-open it to produce a Deckle once material is available.`
        : "Machine assigned successfully.") + variantNote + swapNote + inUseNote);
    res.redirect("/app/machine/queue");
  } catch (err) {
    console.error("ASSIGN PRODUCTION SAVE ERROR:", err);
    req.flash("notification", "Failed to assign production.");
    res.redirect(`/app/labels/production/assign/${req.params.id}`);
  }
});

// Where an undo returns to. The WIP tab has always been the default; pressed
// from a machine queue it comes back to that queue instead -- taking one job
// off a machine shouldn't move you off the machine you were reading. Only this
// app's own queue paths are honoured, never an arbitrary URL from the form.
function unassignReturnTo(req) {
  const from = String(req.body?.from || "");
  return /^\/(app|[a-z0-9]+)\/machine\/[a-f0-9]{24}\/queue(\?|$)/.test(from)
    ? from
    : "/app/labels/production/pending?tab=wip";
}

router.post("/labels/production/unassign/:id", requireAuth, updateLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      req.flash("notification", "Invalid order id.");
      return res.redirect(unassignReturnTo(req));
    }

    const pendingProduction = await PendingProduction.findById(id).lean();
    if (!pendingProduction) {
      req.flash("notification", "Order not found.");
      return res.redirect(unassignReturnTo(req));
    }
    if (!pendingProduction.assignedMachineId) {
      req.flash("notification", "This order isn't assigned to a machine.");
      return res.redirect(unassignReturnTo(req));
    }
    // The Deckle's own mtrs only leave when a Job Card is filed, so a filed
    // card can't be undone from here -- including a partial one (producedAt
    // still unset, but producedRolls already counts rolls a Job Card put
    // into stock).
    if (pendingProduction.producedAt || Number(pendingProduction.producedRolls) > 0) {
      req.flash("notification", "A Job Card has already been filed for this order — it can't be sent back to Pending. Cancel it instead if it needs to stop.");
      return res.redirect(unassignReturnTo(req));
    }

    // A machine Job Card that's mid-entry: its operator has already punched
    // Stop on one or more Production Log rows (each inwarded a Deckle to Semi
    // Finished Stock the moment Stop was hit -- producedVia "jobcard"), or has
    // reconciled a swapped-out reel (materialSwapLog -- raw already drawn
    // down). Neither has a clean reversal here: the raw material a job-card
    // Deckle consumed is only settled when the whole card is Saved, and
    // dissolveDeckle has no lamination ledger to reverse for it. Block the
    // send-back -- the operator must open the Job Card and Save it to close
    // the order out properly (or cancel the order if it must stop).
    const jobCardDeckle = await MaterialStock.exists({ producedFor: id, producedVia: "jobcard" });
    if (jobCardDeckle || (pendingProduction.materialSwapLog || []).length) {
      req.flash("notification", "This order's Job Card has already moved stock (a Deckle produced, or a reel reconciled) — it can't be sent back to Pending. Open the Job Card and Save Production Entry to close it out.");
      return res.redirect(unassignReturnTo(req));
    }

    // Raw material, though, left stock the moment Assign & Continue laminated
    // it (produceDeckle, producedVia "assign"). Unassigning gives the order's
    // material back, so those Deckles are un-made and their facestock/adhesive/
    // release liner returned to the reels they came off -- otherwise the raw
    // stock stays spent and an orphan Deckle nobody ordered is left sitting in
    // Finished stock. Job-card Deckles are excluded (blocked above); a Deckle
    // merely ticked onto the order from existing stock is simply released below.
    const producedHere = await MaterialStock.find({ producedFor: id, producedVia: { $ne: "jobcard" } }).select("_id rollId").lean();
    const dissolved = [];
    const kept = [];
    for (const reel of producedHere) {
      try {
        const result = await dissolveDeckle({
          stockId: reel._id,
          createdBy: req.session?.authUser?.username || req.session?.authUser?.empName || "SYSTEM",
        });
        dissolved.push(result);
      } catch (dissolveErr) {
        // A Deckle that's already been drawn from can't be returned. Say so
        // and leave it standing rather than failing the whole unassign -- the
        // order still needs to come off the machine.
        kept.push(`${reel.rollId} (${dissolveErr.message})`);
      }
    }

    // lotNo is deliberately kept -- it's tied to the order's life, not the
    // assignment, so a re-assignment reuses it. liveMaterialInUse is cleared
    // too: a job that only scanned/Started reels (no Deckle, no swap -- those
    // are blocked above) can still have left the reel reservation set, and it
    // must not follow the order back to Pending and keep those reels locked
    // against every other job. producedRolls is forced back to 0 for the same
    // reason -- defensive, it is already 0 to reach here.
    // `runningOn` goes with it, for the same reason liveMaterialInUse does: a
    // job that had Start punched carries a device claim, and it is cleared
    // only by the job card's own save. Left behind, it follows the order back
    // to Pending and then blocks the next device to pick the job up until it
    // goes stale (JOB_CLAIM_STALE_MS, 15 minutes). `liveRun` (a deckle row
    // whose Start was punched) likewise: the job is off the machine -- and
    // so is any hold it was on (livePause / livePauseLog).
    await PendingProduction.findByIdAndUpdate(id, {
      $set: { assignedMachineId: null, operatorId: null, helperId: null, allottedRollIds: [], producedRolls: 0 },
      $unset: {
        allottedRolls: "", assignedAt: "", allottedLayers: "", liveMaterialInUse: "", runningOn: "",
        liveRun: "", liveSetting: "", liveStartedAt: "", livePause: "", livePauseLog: "", overtimeLog: "",
      },
    });

    notifyOperatorQueue(pendingProduction.operatorId);
    res.locals.auditDescription = `Sent production order ${id} back to Pending`;
    let message = "Order sent back to Pending Production.";
    if (dissolved.length) {
      const mtrs = dissolved.reduce((sum, d) => sum + d.mtrs, 0);
      message += ` ${dissolved.length} Deckle${dissolved.length === 1 ? "" : "s"} un-made — ${mtrs} mtrs returned to raw stock.`;
      const missing = [...new Set(dissolved.flatMap((d) => d.missing))];
      if (missing.length) message += ` Note: reel${missing.length === 1 ? "" : "s"} ${missing.join(", ")} no longer exist, so that material couldn't be returned.`;
    }
    if (kept.length) message += ` Note: could not return ${kept.join("; ")}.`;
    req.flash("notification", message);
    // Undo pressed on a machine queue comes back to that queue -- taking one
    // job off a machine shouldn't move you off the machine you were reading.
    // Only our own paths are honoured, never an arbitrary URL from the form.
    // Deckle Set is where a job goes when it is sent back, so that is the
    // default landing; an undo pressed on a queue returns to that queue.
    const from = String(req.body.from || "");
    const backToQueue = /^\/(app|[a-z0-9]+)\/machine\/[a-f0-9]{24}\/queue(\?|$)/.test(from);
    res.redirect(backToQueue ? from : "/app/labels/production/deckle-set");
  } catch (err) {
    console.error("UNASSIGN PRODUCTION ERROR:", err);
    req.flash("notification", "Failed to send order back to Pending.");
    res.redirect("/app/labels/production/pending?tab=wip");
  }
});

// One audit row's `geo` as { geoText, geoUrl }: coordinates to 6 decimal places
// (~11 cm, past which the numbers are noise) with the fix's own margin of
// error beside them, or the plain reason the device gave for having none. Both
// are "" for the vast majority of entries, which carry no geo at all.
const GEO_ERROR_TEXT = {
  denied: "Location denied",
  timeout: "Location timed out",
  unavailable: "Location unavailable",
};

function describeGeo(geo) {
  if (!geo) return { geoText: "", geoUrl: "" };
  if (typeof geo.lat !== "number" || typeof geo.lng !== "number") {
    return { geoText: GEO_ERROR_TEXT[geo.error] || "", geoUrl: "" };
  }
  const coords = `${geo.lat.toFixed(6)}, ${geo.lng.toFixed(6)}`;
  return {
    geoText: typeof geo.accuracy === "number" ? `${coords} (±${Math.round(geo.accuracy)} m)` : coords,
    geoUrl: `https://www.google.com/maps/search/?api=1&query=${geo.lat},${geo.lng}`,
  };
}

// Admin/HOD only — records of every mutating action + login/logout across the app.
router.get("/audit/view", async (req, res) => {
  const role = req.session?.authUser?.role;
  if (role !== "proprietor" && role !== "admin" && role !== "hod") {
    req.flash("notification", "Access denied");
    return res.redirect("/app/welcome");
  }

  // No real limit -- AuditLog rows are small (a handful of short strings) and
  // the table loads them all client-side (Tabulator virtualDom) same as every
  // other list page in this app. AUDIT_LOG_SAFETY_CAP exists only so a single
  // request can never try to pull an unbounded collection into memory; it is
  // not meant to bind in normal use, so the view is told when it does, rather
  // than silently dropping older history with no indication.
  const AUDIT_LOG_SAFETY_CAP = 50000;
  const logs = await AuditLog.find().sort({ createdAt: -1 }).limit(AUDIT_LOG_SAFETY_CAP).lean();

  res.render("system/auditLog.ejs", {
    title: "Audit Log",
    CSS: "tableDisp.css",
    JS: false,
    // The device position (mobile-app logins only) is flattened to a plain
    // string here rather than formatted in the browser, so the table's header
    // filter searches it and the PDF/Excel downloads carry it -- both of which
    // work off the column's own value, not off its formatter.
    jsonData: logs.map((log) => ({ ...log, ...describeGeo(log.geo) })),
    truncated: logs.length >= AUDIT_LOG_SAFETY_CAP,
    notification: req.flash("notification"),
  });
});

// ---------------------------------------------------------------------------------------------------->>>>>

// ----------------------------------client display---------------------------------->
// route for client display page.
router.get("/edit/client", async (req, res) => {
  let clients = await Client.find();
  res.render("edit/clientDisp.ejs", {
    CSS: false,
    title: "Client Display",
    JS: false,
    clients,
    notification: req.flash("notification"),
  });
});

// ----------------------------------user display---------------------------------->
// route for user display page.
router.get("/edit/user/:id", async (req, res) => {
  let { id } = req.params;
  let clientData = await Client.findOne({ _id: id }).populate("users");
  let users = clientData.users;
  console.log(users);
  // res.send(users);
  res.render("edit/userDisp.ejs", {
    CSS: false,
    title: "Username Display",
    JS: false,
    users,
    notification: req.flash("notification"),
  });
});


// ----------------------------------Master display---------------------------------->
// route for details page.
router.get("/master/view", async (req, res) => {
  const clients = await Client.distinct("clientName");
  clients.sort((a, b) => String(a).localeCompare(String(b)));
  let jsonData = await Username.find()
    .select("clientName clientType accountHead userName userLocation userDepartment locationDetails label labelStock verified verifiedBy verifiedAt")
    .populate({ path: "label", select: "location" })
    .populate({ path: "labelStock", select: "location" })
    .sort({ clientName: 1, userName: 1 })
    .lean();

  // console.log(jsonData);
  res.render("users/masterDisp.ejs", {
    jsonData,
    clients,
    CSS: "tableDisp.css",
    JS: false,
    title: "Client Details",
    notification: req.flash("notification"),
  });
});

// ----------------------------------Vendor display----------------------------------
router.get("/vendor/view", async (req, res) => {
  try {
    const [jsonData, userCounts, previewVendorId] = await Promise.all([
      Vendor.find()
        .select("vendorId vendorName vendorStatus hoLocation warehouseLocation commodities vendorGst vendorMsme vendorGumasta vendorPan users verified verifiedBy verifiedAt")
        .populate({ path: "users", select: "_id" })
        .sort({ vendorName: 1 })
        .lean(),
      VendorUser.aggregate([{ $group: { _id: "$vendorId", count: { $sum: 1 } } }]),
      // For the New Vendor dialog (views/users/_vendorDialog.ejs).
      getNextVendorIdPreview(),
    ]);

    const userCountByVendorId = new Map(
      userCounts.map((entry) => [String(entry._id || ""), Number(entry.count || 0)]),
    );

    jsonData.forEach((vendor) => {
      vendor.userCount = userCountByVendorId.get(String(vendor.vendorId || "")) || 0;
    });

    res.render("users/vendorsView.ejs", {
      jsonData,
      previewVendorId,
      CSS: "tableDisp.css",
      JS: false,
      title: "Vendor Details",
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("VENDOR VIEW ERROR:", err);
    req.flash("notification", "Failed to load vendor details");
    res.redirect("back");
  }
});

// The four raw-material masters (Facestock/Adhesive/Release/Core) each carry
// the vendorId of the vendor that supplies that spec, so "what do we buy from
// this vendor" is just those four collections filtered by the vendor's _id.
// Each entry declares the columns the profile page renders, so adding a
// column is a one-line change here rather than another table in the view.
//
// `stockModel`/`specKey` add the price history: the rate on the profile is
// the rate keyed in at inward on /sachiko/facestockstock (and the adhesive/
// release-liner/core equivalents), so Last/Lowest/Highest come from that
// pool's own stock rows. Each specKey is copied verbatim from the matching
// stock route (facestockSpecKey in routes/stock/facestockStock.js, etc.) --
// the same grouping the Stock pages use to file a reel under a master, so a
// master row here shows the rates of exactly the reels it owns. Consumed
// reels stay in the collection with quantity 0, so an emptied reel still
// counts towards the price history, which is what you want for "lowest we
// ever paid".
const canonSpec = (value) => String(value || "").trim().toUpperCase().replace(/\s+/g, " ");
const numSpec = (value) => (value === undefined || value === null || value === "" ? "" : String(Number(value)));

const VENDOR_SUPPLY_CATEGORIES = [
  {
    key: "facestock",
    label: "Facestock",
    icon: "fa-layer-group",
    model: () => FacestockMaster,
    stockModel: () => FacestockStock,
    specKey: (o) => [String(o.vendorId || ""), canonSpec(o.family), canonSpec(o.make), canonSpec(o.vendorSkuCode), canonSpec(o.type), canonSpec(o.size), numSpec(o.gsm), numSpec(o.micron)].join("||"),
    columns: [
      { title: "Vendor SKU Code", field: "vendorSkuCode", primary: true },
      { title: "Family", field: "family" },
      { title: "Make", field: "make" },
      { title: "Type", field: "type" },
      { title: "Size", field: "size" },
      { title: "GSM", field: "gsm" },
      { title: "Micron", field: "micron" },
      { title: "MSQ", field: "msq" },
      { title: "Last Rate", field: "lastRate", money: true, rateGroupStart: true },
      { title: "Lowest", field: "lowestRate", money: true },
      { title: "Highest", field: "highestRate", money: true },
    ],
  },
  {
    key: "adhesive",
    label: "Adhesive",
    icon: "fa-droplet",
    model: () => AdhesiveMaster,
    stockModel: () => AdhesiveStock,
    specKey: (o) => [String(o.vendorId || ""), canonSpec(o.type), canonSpec(o.make), canonSpec(o.vendorSkuCode)].join("||"),
    columns: [
      { title: "Vendor SKU Code", field: "vendorSkuCode", primary: true },
      { title: "Type", field: "type" },
      { title: "Make", field: "make" },
      { title: "Viscosity", field: "viscosity" },
      { title: "Cohesion", field: "cohesion" },
      { title: "Shear", field: "shear" },
      { title: "Density", field: "density" },
      { title: "MSQ", field: "msq" },
      { title: "Last Rate", field: "lastRate", money: true, rateGroupStart: true },
      { title: "Lowest", field: "lowestRate", money: true },
      { title: "Highest", field: "highestRate", money: true },
    ],
  },
  {
    key: "release",
    label: "Release Liner",
    icon: "fa-scroll",
    model: () => ReleaseMaster,
    stockModel: () => ReleaseLinerStock,
    specKey: (o) => [String(o.vendorId || ""), canonSpec(o.type), canonSpec(o.make), canonSpec(o.vendorSkuCode), canonSpec(o.color), canonSpec(o.size), numSpec(o.gsm)].join("||"),
    columns: [
      { title: "Vendor SKU Code", field: "vendorSkuCode", primary: true },
      { title: "Type", field: "type" },
      { title: "Make", field: "make" },
      { title: "Sensing", field: "sensing" },
      { title: "Color", field: "color" },
      { title: "Size", field: "size" },
      { title: "GSM", field: "gsm" },
      { title: "MSQ", field: "msq" },
      { title: "Last Rate", field: "lastRate", money: true, rateGroupStart: true },
      { title: "Lowest", field: "lowestRate", money: true },
      { title: "Highest", field: "highestRate", money: true },
    ],
  },
  {
    key: "core",
    label: "Core",
    icon: "fa-circle-notch",
    model: () => CoreMaster,
    stockModel: () => CoreStock,
    specKey: (o) => [String(o.vendorId || ""), canonSpec(o.type), canonSpec(o.make), canonSpec(o.printType), numSpec(o.thickness), numSpec(o.od), numSpec(o.length)].join("||"),
    columns: [
      { title: "Type", field: "type", primary: true },
      { title: "Make", field: "make" },
      { title: "Print Type", field: "printType" },
      { title: "Thickness", field: "thickness" },
      { title: "OD", field: "od" },
      { title: "Length", field: "length" },
      { title: "MSQ", field: "msq" },
      { title: "Last Rate", field: "lastRate", money: true, rateGroupStart: true },
      { title: "Lowest", field: "lowestRate", money: true },
      { title: "Highest", field: "highestRate", money: true },
    ],
  },
];

// Last/Lowest/Highest paid per spec, from the rate keyed in at inward on the
// Stock pages. A blank or zero rate means "never priced" rather than "free",
// so those rows sit the history out entirely -- counting a 0 would peg
// Lowest at zero for good. "Last" is by inwardDate where the pool records
// one and createdAt otherwise (CoreStock has no inwardDate field), with the
// rows walked oldest-first so the newest inward is simply the one left
// standing.
function buildRateStatsByKey(stockRows, specKey) {
  const priced = stockRows
    .map((row) => ({ row, rate: Number(row.rate), at: new Date(row.inwardDate || row.createdAt || 0).getTime() }))
    .filter((entry) => Number.isFinite(entry.rate) && entry.rate > 0)
    .sort((a, b) => a.at - b.at);

  const stats = new Map();
  for (const { row, rate } of priced) {
    const key = specKey(row);
    const current = stats.get(key);
    if (!current) {
      stats.set(key, { lastRate: rate, lowestRate: rate, highestRate: rate });
      continue;
    }
    current.lastRate = rate;
    current.lowestRate = Math.min(current.lowestRate, rate);
    current.highestRate = Math.max(current.highestRate, rate);
  }
  return stats;
}

router.get("/vendor/profile/:id", async (req, res) => {
  try {
    const vendor = await Vendor.findById(req.params.id).populate({
      path: "users",
      populate: [
        { path: "label" },
        { path: "tape", populate: { path: "tapeId" } },
      ],
    });

    if (!vendor) {
      req.flash("notification", "Vendor not found");
      return res.redirect("/app/vendor/view");
    }

    const [supplyRows, supplyStock] = await Promise.all([
      Promise.all(
        VENDOR_SUPPLY_CATEGORIES.map((category) =>
          category
            .model()
            .find({ vendorId: vendor._id })
            .sort({ skuId: 1 })
            .lean(),
        ),
      ),
      // Every reel/drum/lot ever inwarded from this vendor, emptied ones
      // included -- the price history is about what was paid, not what's
      // still on the floor.
      Promise.all(
        VENDOR_SUPPLY_CATEGORIES.map((category) =>
          category.stockModel().find({ vendorId: vendor._id }).lean(),
        ),
      ),
    ]);

    const supplyCategories = VENDOR_SUPPLY_CATEGORIES.map((category, index) => {
      const rates = buildRateStatsByKey(supplyStock[index], category.specKey);
      return {
        key: category.key,
        label: category.label,
        icon: category.icon,
        columns: category.columns,
        items: supplyRows[index].map((item) => ({
          ...item,
          ...(rates.get(category.specKey(item)) || {}),
        })),
      };
    });

    res.render("users/vendorProfile.ejs", {
      title: "Vendor Profile",
      vendor,
      supplyCategories,
      supplyTotal: supplyRows.reduce((sum, rows) => sum + rows.length, 0),
      CSS: false,
      JS: false,
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("VENDOR PROFILE ERROR:", err);
    req.flash("notification", "Invalid vendor link");
    res.redirect("/app/vendor/view");
  }
});

// Backward-compatible redirect for the old vendor coordinator URL.
router.get("/vendor/user/view", async (req, res) => {
  return res.redirect("/app/vendor/coordinator/view");
});

// ----------------------------------Vendor coordinator display----------------------------------
router.get("/vendor/coordinator/view", async (req, res) => {
  try {
    const jsonData = await VendorUser.aggregate([
      {
        $lookup: {
          from: "vendors",
          localField: "vendorId",
          foreignField: "vendorId",
          as: "vendorInfo",
        },
      },
      {
        $addFields: {
          commodities: { $ifNull: [{ $arrayElemAt: ["$vendorInfo.commodities", 0] }, []] },
        },
      },
      {
        $project: {
          vendorInfo: 0, // Remove the lookup array
        },
      },
      { $sort: { vendorName: 1, userName: 1 } },
    ]);

    jsonData.forEach((row) => {
      row.dispatchType = row.SelfDispatch ? "Self Dispatch" : "Transport";
      row.tapeCount = row.tape?.length || 0;
    });

    // For the New Coordinator dialog (views/users/_vendorUserDialog.ejs).
    const vendors = await Vendor.distinct("vendorName");

    res.render("users/vendorUserView.ejs", {
      jsonData,
      vendors: vendors.filter(Boolean).sort(),
      CSS: "tableDisp.css",
      JS: false,
      title: "Vendor Coordinator View",
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("VENDOR COORDINATOR VIEW ERROR:", err);
    req.flash("notification", "Failed to load vendor coordinator view");
    res.redirect("back");
  }
});

// ----------------------------------Vendor coordinator details----------------------------------
// The location rows the Edit Coordinator dialog starts from. Pick up details
// are per-location; for legacy coordinators whose stored locationDetails
// predate that, backfill the primary (first) location's pick up details from
// the top-level fields so editing doesn't wipe the existing pick up info.
function vendorUserEditRows(user) {
  const stored = Array.isArray(user.locationDetails) && user.locationDetails.length
    ? user.locationDetails.map((row) => ({ ...row }))
    : [{ userLocation: user.userLocation || "", dispatchAddress: user.dispatchAddress || "" }];

  const hasPrimaryDispatch = stored[0] && (
    stored[0].selfDispatch || stored[0].transportName || stored[0].transportContact ||
    stored[0].dropLocation || stored[0].dropLocation1 || stored[0].deliveryMode ||
    stored[0].deliveryLocation || stored[0].deliveryLocation1 || stored[0].vendorPayment
  );
  if (stored[0] && !hasPrimaryDispatch) {
    stored[0] = {
      ...stored[0],
      selfDispatch: user.SelfDispatch || "",
      transportName: user.transportName || "",
      transportContact: user.transportContact || "",
      dropLocation: user.dropLocation || "",
      dropLocation1: user.dropLocation1 || "",
      deliveryMode: user.deliveryMode || "",
      deliveryLocation: user.deliveryLocation || "",
      deliveryLocation1: user.deliveryLocation1 || "",
      vendorPayment: user.vendorPayment || "",
    };
  }
  return stored;
}

router.get("/vendor/coordinator/details/:userId", async (req, res) => {
  try {
    const vendorUser = await VendorUser.findById(req.params.userId).lean();

    if (!vendorUser) {
      req.flash("notification", "Vendor coordinator not found");
      return res.redirect("/app/vendor/coordinator/view");
    }

    const vendor = await Vendor.findOne({ vendorId: vendorUser.vendorId }).lean();

    res.render("users/vendorUserDetails.ejs", {
      title: "Vendor Coordinator Details",
      CSS: false,
      JS: false,
      vendorUser,
      vendor,
      initialLocationDetails: vendorUserEditRows(vendorUser),
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("VENDOR COORDINATOR DETAILS ERROR:", err);
    req.flash("notification", "Failed to load vendor coordinator details");
    res.redirect("/app/vendor/coordinator/view");
  }
});

router.post("/vendor/coordinator/details/:userId/delete", requireAuth, deleteLimiter, async (req, res) => {
  try {
    const { userId } = req.params;
    const vendorUser = await VendorUser.findById(userId).lean();

    if (!vendorUser) {
      req.flash("notification", "Vendor coordinator not found");
      return res.redirect("/app/vendor/coordinator/view");
    }

    await Vendor.updateOne(
      { vendorId: vendorUser.vendorId },
      { $pull: { users: vendorUser._id } },
    );

    await VendorUser.deleteOne({ _id: vendorUser._id });

    res.locals.auditDescription = `Deleted vendor coordinator "${vendorUser.userName}"`;
    req.flash("notification", `Coordinator ${vendorUser.userName} removed successfully`);
    return res.redirect("/app/vendor/coordinator/view");
  } catch (err) {
    console.error("VENDOR COORDINATOR DELETE ERROR:", err);
    req.flash("notification", "Failed to remove coordinator");
    return res.redirect("/app/vendor/coordinator/details/" + req.params.userId);
  }
});

// ----------------------------------Vendor coordinator active / inactive----------------------------------
// Toggles the coordinator's own status and keeps its activation timeline in
// step: marking INACTIVE closes the open stint, re-activating opens a fresh
// one. The vendor profile page renders that timeline.
router.post("/vendor/coordinator/details/:userId/status", requireAuth, updateLimiter, async (req, res) => {
  try {
    const target = String(req.body.status || "").trim().toUpperCase();
    if (!["ACTIVE", "INACTIVE"].includes(target)) {
      return res.status(400).json({ success: false, message: "Invalid status" });
    }

    const vendorUser = await VendorUser.findById(req.params.userId);
    if (!vendorUser) {
      return res.status(404).json({ success: false, message: "Coordinator not found" });
    }

    const current = vendorUser.coordinatorStatus || "ACTIVE";
    if (current === target) {
      return res.json({ success: true, redirect: `/app/vendor/coordinator/details/${vendorUser._id}` });
    }

    // Legacy coordinators predate the timeline -- seed it from the _id's
    // creation time so the history still reads sensibly.
    if (!Array.isArray(vendorUser.activityLog) || vendorUser.activityLog.length === 0) {
      vendorUser.activityLog = [{ from: vendorUser._id.getTimestamp(), to: null }];
    }

    const now = new Date();
    const openPeriod = [...vendorUser.activityLog].reverse().find((p) => !p.to);

    if (target === "INACTIVE") {
      if (openPeriod) openPeriod.to = now;
      vendorUser.coordinatorStatus = "INACTIVE";
    } else {
      if (openPeriod) openPeriod.to = openPeriod.to || now; // close any stray open stint
      vendorUser.activityLog.push({ from: now, to: null });
      vendorUser.coordinatorStatus = "ACTIVE";
    }
    vendorUser.markModified("activityLog");
    await vendorUser.save();

    res.locals.auditDescription = `Marked vendor coordinator "${vendorUser.userName}" ${target}`;
    req.flash("notification", `Coordinator ${vendorUser.userName} marked ${target === "ACTIVE" ? "active" : "inactive"}`);
    res.json({ success: true, redirect: `/app/vendor/coordinator/details/${vendorUser._id}` });
  } catch (err) {
    console.error("VENDOR COORDINATOR STATUS ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to update coordinator status" });
  }
});

// ----------------------------------Vendor coordinator edit----------------------------------
// Edit Coordinator is a dialog on the coordinator's details page
// (views/users/_editVendorUserDialog.ejs); old links forward there and open it.
router.get("/form/edit/vendor-user/:userId", (req, res) => {
  res.redirect(`/app/vendor/coordinator/details/${encodeURIComponent(req.params.userId)}?edit=1`);
});

router.post("/form/edit/vendor-user/:userId", requireAuth, updateLimiter, async (req, res) => {
  try {
    const userId = req.params.userId;
    const user = await VendorUser.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "Vendor coordinator not found" });
    }

    const vendorId = String(user.vendorId || "").trim();
    const userName = String(req.body.userName || "").trim();
    const userContact = String(req.body.userContact || "").trim();
    const userEmail = String(req.body.userEmail || "")
      .trim()
      .toLowerCase();
    // Helper returns fully-parsed, uppercased entries with per-location dispatch
    // details (and per-entry self-dispatch cleanup) — use them as-is.
    const locationDetails = normalizeLocationDetails(
      req.body.locationDetails,
      req.body.userLocation,
      req.body.dispatchAddress,
    );
    if (!locationDetails.length) {
      return res.status(400).json({ success: false, message: "Please add at least one location and address" });
    }
    const primaryLocation = locationDetails[0];

    const vendor = await Vendor.findOne({ vendorId: user.vendorId }).lean();
    const vendorSnapshot = getVendorSnapshot(vendor, user);

    const updatedData = {
      ...vendorSnapshot,
      vendorId,
      vendorName: vendorSnapshot.vendorName,
      vendorStatus: vendorSnapshot.vendorStatus,
      hoLocation: vendorSnapshot.hoLocation,
      warehouseLocation: vendorSnapshot.warehouseLocation,
      userName,
      userDepartment: String(req.body.userDepartment || "").trim(),
      userContact,
      userEmail,
      locationsCount: locationDetails.length,
      locationDetails,
      userLocation: primaryLocation.userLocation,
      dispatchAddress: primaryLocation.dispatchAddress,
      // Top-level dispatch fields mirror the primary (first) location so
      // existing consumers (vendor coordinator view/details) keep working.
      transportName: primaryLocation.transportName || "",
      transportContact: primaryLocation.transportContact || "",
      dropLocation: primaryLocation.dropLocation || "",
      dropLocation1: primaryLocation.dropLocation1 || "",
      deliveryMode: primaryLocation.deliveryMode || "",
      deliveryLocation: primaryLocation.deliveryLocation || "",
      deliveryLocation1: primaryLocation.deliveryLocation1 || "",
      vendorPayment: primaryLocation.vendorPayment || "",
      SelfDispatch: primaryLocation.selfDispatch || "",
      vendorStatus: vendorSnapshot.vendorStatus,
      ownerName: String(req.body.ownerName || "").trim(),
      ownerMobNo: String(req.body.ownerMobNo || "").trim(),
      ownerEmail: String(req.body.ownerEmail || "").trim(),
      vendorGst: vendorSnapshot.vendorGst,
      vendorMsme: vendorSnapshot.vendorMsme,
    };

    updatedData.vendorUserSignature = hashSignature(buildVendorUserSignature(updatedData, vendorId));

    const duplicateVendorUser = await VendorUser.findOne({
      _id: { $ne: userId },
      $or: [
        { vendorUserSignature: updatedData.vendorUserSignature },
        {
          vendorId,
          userName: new RegExp(`^${escapeRegex(userName)}$`, "i"),
          userEmail: new RegExp(`^${escapeRegex(userEmail)}$`, "i"),
          userContact: new RegExp(`^${escapeRegex(userContact)}$`, "i"),
        },
      ],
    }).lean();

    if (duplicateVendorUser) {
      return res.status(400).json({
        success: false,
        message: "vendor user already exist (same vendor + name + email + contact)",
      });
    }

    const vf = verificationUpdate(req, user);
    await VendorUser.findByIdAndUpdate(
      userId,
      { $set: { ...updatedData, ...vf.set }, ...(Object.keys(vf.unset).length ? { $unset: vf.unset } : {}) },
      { runValidators: true },
    );
    res.locals.auditDescription = `Updated vendor coordinator "${userName}"`;
    req.flash("notification", "Vendor coordinator updated successfully!");
    return res.json({ success: true, redirect: `/app/vendor/coordinator/details/${userId}` });
  } catch (err) {
    console.error("VENDOR COORDINATOR EDIT POST ERROR:", err);
    if (err?.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "vendor user already exist (same vendor + name + email + contact)",
      });
    }
    return res.status(400).json({ success: false, message: err.message });
  }
});

// ----------------------------------Labels display (individual)---------------------------------->
// route for details page.
router.get("/disp/labels", async (req, res) => {
  let jsonData = await Label.find();

  res.render("inventory/labels/labelsDisp.ejs", {
    jsonData,
    CSS: "tableDisp.css",
    JS: false,
    title: "Labels Display",
    notification: req.flash("notification"),
  });
});

// Display all Labels bound to a client user (rich view with actions).
router.get("/labels/view/:id", async (req, res) => {
  try {
    const user = await Username.findById(req.params.id).populate("label").lean();
    if (!user) {
      req.flash("notification", "User not found");
      return res.redirect("back");
    }

    // When arriving from the per-location count on the master view, only show
    // bindings for that location; without the param, show all of the user's.
    const locationFilter = typeof req.query.location === "string" ? req.query.location.trim() : "";
    const sameLoc = (a, b) => normalizeLocationName(a) === normalizeLocationName(b);

    let labels = user.label || [];
    if (locationFilter) {
      labels = labels.filter((binding) => sameLoc(binding.location, locationFilter));
    }

    const jsonData = labels.map((binding) => ({
      ...binding,
      // Show the live user's identity, not the binding's own (possibly stale) snapshot.
      clientName: user.clientName,
      userName: user.userName,
      userContact: user.userContact,
      status: binding.status || "ACTIVE",
      userId: req.params.id,
    }));

    res.render("inventory/labels/labelsBindingDisp.ejs", {
      jsonData,
      CSS: "tableDisp.css",
      JS: false,
      title: "Labels Display",
      clientName: user.clientName || "",
      userName: user.userName || "",
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("LABELS VIEW ERROR:", err);
    res.redirect("back");
  }
});



// Remove a Label binding.
router.post("/labels-binding/delete/:id", requireAuth, deleteLimiter, async (req, res) => {
  try {
    const [owner, binding] = await Promise.all([
      Username.findOne({ label: req.params.id }).select("_id").lean(),
      Label.findById(req.params.id).select("productId").lean(),
    ]);
    await Label.deleteOne({ _id: req.params.id });
    if (owner) {
      await Username.updateOne({ _id: owner._id }, { $pull: { label: req.params.id } });
    }

    res.locals.auditDescription = `Deleted label binding "${binding?.productId || req.params.id}"`;
    req.flash("notification", "Label binding removed successfully!");
    return res.redirect(owner ? `/app/labels/view/${owner._id}` : "/app/master/view");
  } catch (err) {
    console.error("LABEL BINDING DELETE ERROR:", err);
    req.flash("notification", "Failed to remove Label binding");
    return res.redirect("back");
  }
});

// Set a label binding INACTIVE.
router.post("/labels-binding/set-inactive/:id", requireAuth, updateLimiter, async (req, res) => {
  try {
    const binding = await Label.findByIdAndUpdate(req.params.id, { status: "INACTIVE" }, { new: false });
    if (!binding) return res.status(404).json({ success: false, message: "Not found" });
    res.locals.auditDescription = `Set label binding "${binding.productId}" inactive`;
    res.json({ success: true });
  } catch (err) {
    console.error("LABEL SET INACTIVE ERROR:", err);
    res.status(500).json({ success: false });
  }
});

// Set a label binding ACTIVE.
router.post("/labels-binding/set-active/:id", requireAuth, updateLimiter, async (req, res) => {
  try {
    const binding = await Label.findByIdAndUpdate(req.params.id, { status: "ACTIVE" }, { new: false });
    if (!binding) return res.status(404).json({ success: false, message: "Not found" });
    res.locals.auditDescription = `Set label binding "${binding.productId}" active`;
    res.json({ success: true });
  } catch (err) {
    console.error("LABEL SET ACTIVE ERROR:", err);
    res.status(500).json({ success: false });
  }
});


// ----------------------------------Welcome---------------------------------->
const MOTIVATIONAL_QUOTES = [
  { q: "The only way to do great work is to love what you do.", a: "Steve Jobs" },
  { q: "Success is not final; failure is not fatal: it is the courage to continue that counts.", a: "Winston Churchill" },
  { q: "Believe you can and you're halfway there.", a: "Theodore Roosevelt" },
  { q: "The best way to predict the future is to create it.", a: "Peter Drucker" },
  { q: "Everything you’ve ever wanted is on the other side of fear.", a: "George Addair" },
  { q: "The only limit to our realization of tomorrow will be our doubts of today.", a: "Franklin D. Roosevelt" },
  { q: "Hardships often prepare ordinary people for an extraordinary destiny.", a: "C.S. Lewis" },
  { q: "Your time is limited, so don't waste it living someone else's life.", a: "Steve Jobs" },
  { q: "Success is walking from failure to failure with no loss of enthusiasm.", a: "Winston Churchill" },
  { q: "Whether you think you can or you think you can't, you're right.", a: "Henry Ford" },
  { q: "The future belongs to those who believe in the beauty of their dreams.", a: "Eleanor Roosevelt" },
  { q: "Don't watch the clock; do what it does. Keep going.", a: "Sam Levenson" },
  { q: "The search for excellence is a journey, not a destination.", a: "Unknown" },
  { q: "What you get by achieving your goals is not as important as what you become by achieving your goals.", a: "Zig Ziglar" },
  { q: "It always seems impossible until it's done.", a: "Nelson Mandela" },
  { q: "Quality is not an act, it is a habit.", a: "Aristotle" },
  { q: "The only person you are destined to become is the person you decide to be.", a: "Ralph Waldo Emerson" },
  { q: "Be so good they can't ignore you.", a: "Steve Martin" },
  { q: "Integrity is doing the right thing, even when no one is watching.", a: "C.S. Lewis" },
  { q: "The secret of getting ahead is getting started.", a: "Mark Twain" }
];

router.get("/api/motivational", (req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  const quote = MOTIVATIONAL_QUOTES[Math.floor(Math.random() * MOTIVATIONAL_QUOTES.length)];
  res.json(quote);
});

router.get("/welcome", (req, res) => {
  res.render("miscellaneous/welcome.ejs", {
    title: "Welcome",
    CSS: false,
    JS: false,
    notification: req.flash("notification"),
  });
});

export default router;
