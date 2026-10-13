import express from "express";
import mongoose from "mongoose";
import ReleaseLinerStock from "../../models/inventory/releaseLinerStock.js";
import ReleaseMaster from "../../models/inventory/releaseMaster.js";
import FacestockStock from "../../models/inventory/facestockStock.js";
import AdhesiveStock from "../../models/inventory/adhesiveStock.js";
import Vendor from "../../models/users/vendor.js";
import Location from "../../models/system/location.js";
import PurchaseOrder from "../../models/inventory/PurchaseOrder.js";
import PurchaseOrderLog from "../../models/inventory/PurchaseOrderLog.js";
import PendingProduction from "../../models/inventory/pendingProduction.js";
import MachineJobCard from "../../models/inventory/machineJobCard.js";
import { requireAuth } from "../../middleware/auth.js";
import { createLimiter, updateLimiter, deleteLimiter } from "../../utils/limiters.js";
import { generateMaterialRollId, previewMaterialRollIds } from "../../utils/materialRollId.js";
import { unallotReel } from "../../utils/reelAllotment.js";
import { pickStockIds } from "../../utils/labelStockProduction.js";
import {
  LABEL_HEIGHT_MM,
  LABEL_WIDTH_MM,
  buildInwardLabelFields,
  buildQrPayload,
  rollLabelQrDataUrl,
} from "../../utils/releaseLinerRollLabel.js";

const router = express.Router();
const ROLL_ID_PREFIX = "RELEASE";
const MAX_ROLLS_PER_BATCH = 100;
// Ceiling on one print run from the Print Roll Labels dialog. Well past any
// real inward batch, and there so a hand-written `ids` list can't ask the
// server to render QRs all day.
const MAX_LABELS_PER_SHEET = 200;

const numOrUndef = (value) => {
  if (value === undefined || value === null || String(value).trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

const roundKg = (value) => Math.round(((Number(value) || 0) + Number.EPSILON) * 100) / 100;

const SENSING_VALUES = ["SENSING", "NON-SENSING"];

// Fields shared by every reel in one inward batch (one spec, one invoice) --
// every field Release Master itself carries (type/color/gsm/vendor/make/
// vendorSkuCode/sensing), plus this batch's own location/rate/invoice.
async function buildHeaderPayload(body) {
  const vendorId = String(body.vendorId || "").trim();
  const header = {
    type: String(body.type || "").trim(),
    color: String(body.color || "WHITE").trim() || "WHITE",
    size: String(body.size || "").trim(),
    gsm: numOrUndef(body.gsm),
    vendorId: vendorId || undefined,
    make: String(body.make || "").trim(),
    vendorSkuCode: String(body.vendorSkuCode || "").trim(),
    // Comes off the chosen Release Master (see the stock model's own note on
    // this field). Anything that isn't one of the two known values is stored
    // blank rather than failing the whole inward on a schema enum.
    sensing: SENSING_VALUES.includes(String(body.sensing || "").trim().toUpperCase())
      ? String(body.sensing).trim().toUpperCase()
      : "",
    location: String(body.location || "").trim(),
    rate: numOrUndef(body.rate),
    invoiceNo: String(body.invoiceNo || "").trim(),
    inwardDate: body.inwardDate ? new Date(body.inwardDate) : new Date(),
    remarks: String(body.remarks || "").trim(),
  };

  if (vendorId) {
    const vendor = await Vendor.findById(vendorId).select("vendorName").lean();
    header.vendorName = vendor?.vendorName || "";
  }

  return header;
}

function validateHeaderPayload(header) {
  if (!header.type) return "Type is required.";
  if (!header.location) return "Location is required.";
  return null;
}

// Per-reel fields -- one physical reel of the batch's shared spec.
function buildRollPayload(raw) {
  return {
    reelMtrs: Number(raw?.reelMtrs),
    vendorRollId: String(raw?.vendorRollId || "").trim(),
  };
}

// The Edit dialog still edits one existing reel at a time (its own Roll ID
// is already assigned, so there's nothing to batch) -- full single-reel
// payload, same shape as the pre-batch /create used.
async function buildEditPayload(body) {
  const header = await buildHeaderPayload(body);
  const payload = { ...header, ...buildRollPayload(body) };
  // Roll ID is only editable from the Inward Timeline's Edit dialog (fixing
  // a mis-keyed id without deleting and re-adding the whole reel) -- the
  // main stock page's own Edit dialog never sends this key, so `undefined`
  // here means "leave the id alone", not "clear it".
  if (body.rollId !== undefined) {
    payload.rollId = String(body.rollId || "").trim().toUpperCase();
  }
  // A reel Label Stock Production emptied is left on file at quantity: 0,
  // reelMtrs: 0 (see produceDeckle in utils/labelStockProduction.js) -- the
  // Stock page/timeline filter those out of "current stock" entirely. The
  // Edit dialog can't actually save a reel over at reelMtrs: 0 anyway
  // (validateEditPayload below requires Kg > 0), so an edit that passes
  // validation is always asserting "this reel is physically present with
  // this Kg" -- restoring quantity to 1 is what makes that reel show up
  // again on the Stock page instead of silently saving a Kg nobody can see.
  payload.quantity = 1;
  return payload;
}

function validateEditPayload(payload) {
  const headerError = validateHeaderPayload(payload);
  if (headerError) return headerError;
  if (!payload.reelMtrs || payload.reelMtrs <= 0) return "Kg is required.";
  if (payload.rollId !== undefined && !payload.rollId) return "Roll ID is required.";
  return null;
}

// Strips null/undefined/blank entries out of a Mongo .distinct() result and
// sorts it -- numeric fields (gsm) sort numerically, everything else
// alphabetically.
function cleanDistinct(values, { numeric = false } = {}) {
  const filtered = (values || []).filter((v) => v !== null && v !== undefined && v !== "");
  return numeric ? filtered.sort((a, b) => a - b) : filtered.sort();
}

function omit(obj, key) {
  const { [key]: _, ...rest } = obj;
  return rest;
}

// vendorId is an ObjectId, not a plain scalar, so it can't go through
// .distinct() + cleanDistinct() like the other fields -- this groups by it
// instead and keeps each vendor's denormalized name for display, the same
// {vendorId, vendorName} pairing Release Master itself stores.
async function distinctVendorPairs(filter) {
  const rows = await ReleaseMaster.aggregate([
    { $match: { ...filter, vendorId: { $ne: null } } },
    { $group: { _id: "$vendorId", vendorName: { $first: "$vendorName" } } },
  ]);
  return rows
    .map((r) => ({ vendorId: String(r._id), vendorName: r.vendorName || "" }))
    .filter((v) => v.vendorName)
    .sort((a, b) => a.vendorName.localeCompare(b.vendorName));
}

// Single source of truth for the Add dialog's Type/Color/GSM/Vendor/Make/
// Vendor SKU Code pickers -- every field Release Master itself carries,
// sourced from it instead of a hardcoded list or free typing, so inward
// entry only ever selects a real cataloged spec. Used both for the initial
// page load (`filter: {}`) and /filter-specs (each field narrowed by every
// OTHER currently-selected field, never by itself, so picking a value never
// removes itself from its own list). Same "narrow as you pick" pattern as
// Tape Stock inward (routes/stock/tapeStock.js's /filter-specs) and
// Facestock Stock inward (routes/stock/facestockStock.js's /filter-specs).
async function loadSpecOptions(filter) {
  const [types, colors, sizes, gsms, vendors, makes, vendorSkuCodes] = await Promise.all([
    ReleaseMaster.distinct("type", omit(filter, "type")),
    ReleaseMaster.distinct("color", omit(filter, "color")),
    ReleaseMaster.distinct("size", omit(filter, "size")),
    ReleaseMaster.distinct("gsm", omit(filter, "gsm")),
    distinctVendorPairs(omit(filter, "vendorId")),
    ReleaseMaster.distinct("make", omit(filter, "make")),
    ReleaseMaster.distinct("vendorSkuCode", omit(filter, "vendorSkuCode")),
  ]);
  return {
    types: cleanDistinct(types),
    colors: cleanDistinct(colors),
    sizes: cleanDistinct(sizes),
    gsms: cleanDistinct(gsms, { numeric: true }),
    vendors,
    makes: cleanDistinct(makes),
    vendorSkuCodes: cleanDistinct(vendorSkuCodes),
  };
}

// Groups a Release Master row and a ReleaseLinerStock reel as "the same
// spec" using exactly the fields buildReleaseSignature() (routes/system/
// releaseMaster.js) hashes -- every field the stock schema mirrors from the
// master, so a reel entered against a spec always lands in that spec's
// bucket. Not the hash itself (no need to match the master's stored
// signature, just to group consistently within this one request).
function releaseSpecKey(o) {
  const s = (v) => String(v || "").trim().toUpperCase().replace(/\s+/g, " ");
  const n = (v) => (v === undefined || v === null || v === "" ? "" : String(Number(v)));
  return [String(o.vendorId || ""), s(o.type), s(o.make), s(o.vendorSkuCode), s(o.color), s(o.size), n(o.gsm)].join("||");
}

// mtrs actually reserved on WIP Label Stock orders, per Release Master spec
// -- the sum of the picked reels' own reelMtrs, not any estimate of what the
// job will eventually need (there isn't one to know in advance). Scoped to
// assignedMachineId being set -- an order still in Pending (not yet assigned
// to a machine) hasn't committed to a location/timeline yet, so it doesn't
// reserve stock here. Nothing picked yet = nothing allocated for that order,
// even once it's assigned to a machine.
//
// Once an order is drawn (produceDeckle already laminated a Deckle from it --
// see utils/labelStockProduction.js), its picked reel's own reelMtrs was
// already reduced on the reel itself, so currentStock already reflects that
// consumption. A drawn order is excluded here entirely rather than needing a
// separate "drawn" correction: the alternative (still counting it as
// Allocated) would double-subtract material that's already gone from Stock.
async function loadAllottedByKey() {
  const pending = await PendingProduction.find({
    producedAt: null,
    assignedMachineId: { $ne: null },
    allottedRollIds: { $size: 0 },
  })
    .select("allottedLayers")
    .lean();

  // The actual reels set aside on the assign form, batched in one query -- a
  // layer can hold more than one picked reel (Assign Production's pickers
  // are checkboxes).
  const pickedIds = pending.flatMap((p) =>
    Object.values(p.allottedLayers || {})
      .filter((pick) => pick?.pool === "release")
      .flatMap((pick) => pickStockIds(pick)),
  );
  const pickedReels = pickedIds.length
    ? await ReleaseLinerStock.find({ _id: { $in: pickedIds } }).select("vendorId type make vendorSkuCode color size gsm reelMtrs").lean()
    : [];

  const allottedByKey = new Map();
  const rollsByKey = new Map();
  for (const reel of pickedReels) {
    const key = releaseSpecKey(reel);
    allottedByKey.set(key, (allottedByKey.get(key) || 0) + (Number(reel.reelMtrs) || 0));
    rollsByKey.set(key, (rollsByKey.get(key) || 0) + 1);
  }
  return { allottedByKey, rollsByKey };
}

// Per-REEL (not per-spec) allotment/usage -- same idea, and same "Allotted"
// vs. "Used"/"Live" split, as loadFacestockReelUsage in routes/stock/
// facestockStock.js: "Allotted" is a reel still reserved on paper (assigned
// to a machine, not yet produced -- self-heals once the order is produced,
// same scope as loadAllottedByKey above); "Used" is either permanent (a job
// card's own releaseUsage, mtrsUsed > 0) or live (Start already punched on a
// still-open job -- PendingProduction.liveMaterialInUse.release, no Kg yet).
async function loadReleaseReelUsage() {
  const pending = await PendingProduction.find({
    producedAt: null,
    assignedMachineId: { $ne: null },
    allottedRollIds: { $size: 0 },
  })
    .select("allottedLayers liveMaterialInUse lotNo itemId")
    .populate({ path: "itemId", select: "productCode" })
    .lean();

  const allottedByReel = new Map();
  const usedByReel = new Map();
  const touchUsed = (id, lotNo) => {
    const key = String(id);
    const entry = usedByReel.get(key) || { totalKg: 0, lots: new Set() };
    if (lotNo) entry.lots.add(lotNo);
    usedByReel.set(key, entry);
    return entry;
  };

  for (const p of pending) {
    for (const pick of Object.values(p.allottedLayers || {})) {
      if (pick?.pool !== "release") continue;
      for (const id of pickStockIds(pick)) {
        const key = String(id);
        if (!allottedByReel.has(key)) {
          allottedByReel.set(key, { lotNo: p.lotNo || "", productCode: p.itemId?.productCode || "" });
        }
      }
    }
    const liveRl = Array.isArray(p.liveMaterialInUse?.release) ? p.liveMaterialInUse.release : [];
    for (const id of liveRl) touchUsed(id, p.lotNo);
  }

  const jobCards = await MachineJobCard.find({ "releaseUsage.0": { $exists: true } })
    .select("releaseUsage lotNo productCode")
    .lean();

  for (const jc of jobCards) {
    for (const u of jc.releaseUsage || []) {
      const used = Number(u.mtrsUsed) || 0;
      if (!u.stockId || used <= 0) continue;
      touchUsed(u.stockId, jc.lotNo).totalKg += used;
    }
  }

  return { allottedByReel, usedByReel };
}

// Reorder view for the Masters panel -- current stock (total mtrs still on
// non-empty reels) per master spec vs. its MSQ, plus whether a PO is already
// in flight for it (see models/inventory/PurchaseOrder.js's onModel
// extension for Facestock/Adhesive/Release Master).
async function loadMastersWithStock(stock, reelUsage) {
  const stockByKey = new Map();
  const rollCountByKey = new Map();
  const rollsByKey = new Map();
  // Master-level rollup of usedBy below, "in use now" only -- see
  // routes/stock/facestockStock.js's loadMastersWithStock for the fuller
  // comment.
  const liveRollsByKey = new Map();
  for (const s of stock) {
    if (!s.quantity) continue;
    const key = releaseSpecKey(s);
    stockByKey.set(key, (stockByKey.get(key) || 0) + (Number(s.reelMtrs) || 0));
    rollCountByKey.set(key, (rollCountByKey.get(key) || 0) + (Number(s.quantity) || 0));
    if (!rollsByKey.has(key)) rollsByKey.set(key, []);
    const allottedTo = reelUsage?.allottedByReel?.get(String(s._id)) || null;
    const usedEntry = reelUsage?.usedByReel?.get(String(s._id));
    if (usedEntry && usedEntry.totalKg <= 0) {
      liveRollsByKey.set(key, (liveRollsByKey.get(key) || 0) + 1);
    }
    rollsByKey.get(key).push({
      _id: s._id,
      rollId: s.rollId,
      vendorRollId: s.vendorRollId,
      reelMtrs: s.reelMtrs,
      location: s.location,
      rate: s.rate,
      invoiceNo: s.invoiceNo,
      remarks: s.remarks,
      createdAt: s.createdAt,
      inwardDate: s.inwardDate,
      allottedTo,
      usedBy: usedEntry
        ? { totalKg: roundKg(usedEntry.totalKg), lots: [...usedEntry.lots], live: usedEntry.totalKg <= 0 }
        : null,
    });
  }

  const masters = await ReleaseMaster.find().sort({ skuId: 1 }).lean();
  const activePOs = await PurchaseOrder.find({
    onModel: "ReleaseMaster",
    itemId: { $in: masters.map((m) => m._id) },
    status: { $in: ["PENDING", "CONFIRMED", "PARTIALLY_RECEIVED"] },
  }).select("itemId").lean();
  const activePOSet = new Set(activePOs.map((po) => String(po.itemId)));
  // `rollsByKey` is already taken above (reels in stock), hence the rename.
  const { allottedByKey, rollsByKey: allottedRollsByKey } = await loadAllottedByKey();

  return masters.map((m) => {
    const key = releaseSpecKey(m);
    const currentStock = roundKg(stockByKey.get(key) || 0);
    const rollCount = rollCountByKey.get(key) || 0;
    const msq = Number(m.msq) || 0;
    const rolls = (rollsByKey.get(key) || []).slice().sort((a, b) => String(a.rollId).localeCompare(String(b.rollId)));
    const allotted = roundKg(allottedByKey.get(key) || 0);
    const available = currentStock;
    return {
      ...m,
      currentStock,
      rollCount,
      rolls,
      allotted,
      allottedRolls: allottedRollsByKey.get(key) || 0,
      liveRolls: liveRollsByKey.get(key) || 0,
      available,
      shortage: roundKg(Math.max(0, msq - currentStock)),
      hasActivePO: activePOSet.has(String(m._id)),
    };
  });
}

// Rupee value of stock actually on hand right now -- each reel's own
// reelMtrs (Kg) times its own rate (rate can vary reel to reel, batch to
// batch, so this sums per-reel rather than using one blended rate). Reels
// already emptied by Label Stock Production (quantity 0) hold nothing, so
// they contribute nothing, same "quantity > 0" gate loadMastersWithStock
// uses for Stock (Kg).
function totalStockValueOf(stock) {
  return stock.reduce((sum, s) => (s.quantity ? sum + (Number(s.reelMtrs) || 0) * (Number(s.rate) || 0) : sum), 0);
}

// Running metres a master's Stock (Kg) works out to at its own GSM and width
// -- same conversion the "Stock (RM)" column applies client-side
// (views/stock/releaseLinerStock.ejs's kgToRm) and the same helper
// routes/stock/facestockStock.js's header total uses, mirrored here so the
// header total and the column it's summing can never disagree. A master with
// no GSM contributes nothing, same as the column.
function kgToRunningMetres(kg, gsm, widthMm) {
  const k = Number(kg);
  const g = Number(gsm);
  const w = Number(widthMm);
  if (!(k > 0) || !(g > 0) || !(w > 0)) return 0;
  return (k * 1e6) / (g * w);
}

// The page's live figures: the masters with their {noun}, and the header
// totals. Shared by the page render and GET /figures, which the page re-reads
// after an edit, remove or inward so it can redraw in place instead of
// reloading (a reload dropped the open specs and the search box).
async function loadReleaseLinerFigures() {
  const [stock, facestockStock, adhesiveStock, reelUsage] = await Promise.all([
    ReleaseLinerStock.find().sort({ createdAt: -1 }).lean(),
    // Facestock and Adhesive Stock's own value figures, shown alongside
    // Release Liner's on this page's header (see routes/stock/facestockStock.js's
    // own header) -- each pool's rate can differ reel/drum to reel/drum, so
    // this sums per-reel/drum, same as this page's own totalStockValueOf.
    FacestockStock.find().select("quantity reelMtrs rate").lean(),
    AdhesiveStock.find().select("quantity reelMtrs rate").lean(),
    loadReleaseReelUsage(),
  ]);
  const masters = await loadMastersWithStock(stock, reelUsage);
  const releaseValue = totalStockValueOf(stock);
  const facestockValue = totalStockValueOf(facestockStock);
  const adhesiveValue = totalStockValueOf(adhesiveStock);
  const totalRunningMeters = masters.reduce((sum, m) => sum + kgToRunningMetres(m.currentStock, m.gsm, m.size), 0);
  return {
    masters,
    totals: {
      releaseValue,
      facestockValue,
      adhesiveValue,
      totalStockValue: releaseValue + facestockValue + adhesiveValue,
      totalRunningMeters,
    },
  };
}

router.get("/", async (req, res) => {
  const [locations, specOptions, { masters, totals }] = await Promise.all([
    Location.find().sort({ locationName: 1 }).lean(),
    loadSpecOptions({}),
    loadReleaseLinerFigures(),
  ]);
  res.render("stock/releaseLinerStock.ejs", {
    JS: false,
    CSS: "tableDisp.css",
    title: "Release Liner Stock",
    locations,
    masters,
    ...totals,
    // Sizes the Print dialog's preview frame to the real sticker. Passed
    // from utils/releaseLinerRollLabel.js rather than written into the view,
    // so the frame can't quietly disagree with the label inside it.
    labelSizeMm: { width: LABEL_WIDTH_MM, height: LABEL_HEIGHT_MM },
    ...specOptions,
    notification: req.flash("notification"),
  });
});

// Read-only: the same figures the page was drawn from, as JSON, for redrawing
// the table in place after a change. Nothing here writes.
router.get("/figures", async (req, res) => {
  try {
    const figures = await loadReleaseLinerFigures();
    res.json({ success: true, ...figures });
  } catch (err) {
    console.error("RELEASELINERSTOCK FIGURES ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to load release liner stock." });
  }
});

// Inward Timeline -- every Release Liner reel ever inwarded, across every
// spec, newest first. Deliberately NOT loadMastersWithStock's `rolls` (which
// only keeps quantity > 0, i.e. what's still on the shelf, and is grouped
// under one master at a time) -- this is the fuller, whole-pool picture of
// when stock arrived, a reel already used up included, so it reads as a real
// history rather than "what's currently in stock, dated".
router.get("/timeline", async (req, res) => {
  const [stock, masters, locations] = await Promise.all([
    ReleaseLinerStock.find().lean(),
    ReleaseMaster.find().select("skuId type color size gsm vendorId make vendorSkuCode").lean(),
    Location.find().sort({ locationName: 1 }).lean(),
  ]);

  // Same grouping key loadMastersWithStock uses to line a reel up with its
  // master -- lets each row show the SKU ID it was inwarded against without
  // storing a master reference on the stock schema itself.
  const skuIdByKey = new Map(masters.map((m) => [releaseSpecKey(m), m.skuId]));

  const rows = stock
    .map((s) => ({
      _id: String(s._id),
      rollId: s.rollId,
      vendorRollId: s.vendorRollId || "",
      skuId: skuIdByKey.get(releaseSpecKey(s)) || "",
      type: s.type || "",
      vendorId: s.vendorId ? String(s.vendorId) : "",
      vendorName: s.vendorName || "",
      vendorSkuCode: s.vendorSkuCode || "",
      make: s.make || "",
      sensing: s.sensing || "",
      color: s.color || "",
      size: s.size || "",
      gsm: s.gsm ?? null,
      reelMtrs: s.reelMtrs,
      rate: s.rate,
      location: s.location,
      invoiceNo: s.invoiceNo || "",
      remarks: s.remarks || "",
      // A reel drawn all the way to 0 is still part of the inward history --
      // shown as USED rather than dropped, so the page stays a true record of
      // everything that came in, not just what's left.
      inStock: Boolean(s.quantity),
      // inwardDate is the date the reel actually arrived and is what someone
      // reading a timeline means by "when" -- createdAt (when the record was
      // saved) only stands in for reels entered before that field existed.
      inwardDate: s.inwardDate || s.createdAt,
    }))
    .sort((a, b) => new Date(b.inwardDate) - new Date(a.inwardDate));

  res.render("stock/releaseLinerTimeline.ejs", {
    JS: false,
    CSS: "tableDisp.css",
    title: "Release Liner — Inward Timeline",
    rows,
    locations,
    // Sizes the Print dialog's preview frame to the real sticker -- same
    // values the main stock page's own Print Reel Labels dialog uses.
    labelSizeMm: { width: LABEL_WIDTH_MM, height: LABEL_HEIGHT_MM },
    notification: req.flash("notification"),
  });
});

router.post("/purchase-order", requireAuth, createLimiter, async (req, res) => {
  try {
    const { masterId, quantity, poNumber, estimatedDate, userLocation, remarks } = req.body;

    const master = await ReleaseMaster.findById(masterId).lean();
    if (!master) return res.status(404).json({ success: false, message: "Release master not found." });
    if (!master.vendorId) return res.status(400).json({ success: false, message: "This release liner has no vendor set." });

    const qty = Number(quantity);
    if (!qty || qty <= 0) return res.status(400).json({ success: false, message: "Quantity is required." });
    if (!String(poNumber || "").trim()) return res.status(400).json({ success: false, message: "PO Number is required." });

    const parsedDate = new Date(estimatedDate);
    const resolvedDate = Number.isNaN(parsedDate.getTime())
      ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      : parsedDate;
    const performer = req.session?.authUser?.username || "SYSTEM";

    const po = await PurchaseOrder.create({
      onModel: "ReleaseMaster",
      itemId: master._id,
      vendorId: master.vendorId,
      vendorName: master.vendorName,
      userLocation,
      quantity: qty,
      poNumber: String(poNumber).trim(),
      estimatedDate: resolvedDate,
      remarks,
      status: "PENDING",
      createdBy: performer,
    });
    await PurchaseOrderLog.create({
      orderId: po._id,
      action: "CREATED",
      poNumber: po.poNumber,
      quantity: po.quantity,
      performedBy: performer,
    });

    res.locals.auditDescription = `Created purchase order "${po.poNumber}" for release liner "${master.skuId}" from "${master.vendorName}" (qty ${po.quantity} kg)`;
    req.flash("notification", "Purchase Order created successfully.");
    res.json({ success: true, redirect: "/app/purchase/pending" });
  } catch (err) {
    console.error("RELEASE LINER CREATE PO ERROR:", err);
    res.status(400).json({ success: false, message: "Failed to create Purchase Order." });
  }
});

router.get("/filter-specs", async (req, res) => {
  try {
    const { type, color, size, gsm, vendorId, make, vendorSkuCode } = req.query;
    const filter = {};
    if (type) filter.type = type;
    if (color) filter.color = color;
    if (size) filter.size = size;
    if (gsm) filter.gsm = Number(gsm);
    if (vendorId) filter.vendorId = vendorId;
    if (make) filter.make = make;
    if (vendorSkuCode) filter.vendorSkuCode = vendorSkuCode;

    res.json(await loadSpecOptions(filter));
  } catch (err) {
    console.error("RELEASE LINER STOCK FILTER-SPECS ERROR:", err);
    res.status(500).json({ error: "Failed to load filter options." });
  }
});

// Read-only preview of the next `count` Roll IDs -- refreshed by the add
// dialog whenever "No of Rolls" changes, so row 1 always shows the lowest id
// and they read as a consecutive run. Doesn't consume the sequence.
router.get("/preview-roll-ids", async (req, res) => {
  const count = Math.min(Math.max(parseInt(req.query.count, 10) || 1, 1), MAX_ROLLS_PER_BATCH);
  const rollIds = await previewMaterialRollIds(ROLL_ID_PREFIX, count);
  res.json({ rollIds });
});

router.post("/create", requireAuth, createLimiter, async (req, res) => {
  try {
    const header = await buildHeaderPayload(req.body);
    const headerError = validateHeaderPayload(header);
    if (headerError) return res.status(400).json({ success: false, message: headerError });
    // Every inward field is mandatory except Invoice No/Remarks (see
    // buildHeaderPayload/validateHeaderPayload) -- Rate specifically, since
    // it's optional on the schema and on the single-reel Edit dialog, is only
    // enforced here at batch-create time.
    if (!header.rate || header.rate <= 0) {
      return res.status(400).json({ success: false, message: "Rate is required." });
    }

    const rawRolls = Array.isArray(req.body.rolls) ? req.body.rolls : [];
    if (!rawRolls.length) return res.status(400).json({ success: false, message: "At least one roll is required." });
    if (rawRolls.length > MAX_ROLLS_PER_BATCH) {
      return res.status(400).json({ success: false, message: `A batch can hold at most ${MAX_ROLLS_PER_BATCH} rolls.` });
    }

    const rolls = rawRolls.map(buildRollPayload);
    const invalidIndex = rolls.findIndex((r) => !r.reelMtrs || r.reelMtrs <= 0);
    if (invalidIndex !== -1) {
      return res.status(400).json({ success: false, message: `Kg is required for roll ${invalidIndex + 1}.` });
    }
    const missingVendorRollIdIndex = rolls.findIndex((r) => !r.vendorRollId);
    if (missingVendorRollIdIndex !== -1) {
      return res.status(400).json({ success: false, message: `Vendor Roll ID is required for roll ${missingVendorRollIdIndex + 1}.` });
    }

    // The rolls must add up to the Total Kg keyed off the invoice. Too
    // much and one has been entered twice or a figure is wrong; too little and
    // one is missing -- both put stock on the shelf that isn't what arrived,
    // and neither is recoverable later from the rows alone. The dialog says the
    // same thing while it is being typed; this is the half a hand-made request
    // can't skip.
    const totalKg = Number(req.body.totalKg);
    if (!Number.isFinite(totalKg) || totalKg <= 0) {
      return res.status(400).json({ success: false, message: "Total Kg is required." });
    }
    const rollsKg = roundKg(rolls.reduce((sum, r) => sum + (Number(r.reelMtrs) || 0), 0));
    const diff = roundKg(rollsKg - totalKg);
    if (Math.abs(diff) > 0.01) {
      const over = diff > 0;
      return res.status(400).json({
        success: false,
        message: `The ${rolls.length} roll${rolls.length === 1 ? "" : "s"} add up to ${rollsKg} kg, which is `
          + `${roundKg(Math.abs(diff))} kg ${over ? "MORE" : "LESS"} than the Total Kg of ${roundKg(totalKg)}.`,
      });
    }

    const locationExists = await Location.exists({ locationName: header.location });
    if (!locationExists) {
      return res.status(400).json({ success: false, message: "Invalid location." });
    }

    const createdRollIds = [];
    for (const roll of rolls) {
      const rollId = await generateMaterialRollId(ROLL_ID_PREFIX, ReleaseLinerStock);
      await ReleaseLinerStock.create({ ...header, ...roll, rollId });
      createdRollIds.push(rollId);
    }

    res.locals.auditDescription = `Added ${createdRollIds.length} release liner stock reel(s) (${header.type}) at "${header.location}": ${createdRollIds.join(", ")}`;
    // No flash: the page refreshes its own table and shows a toast (see the
    // facestock stock route for why).
    res.json({ success: true, added: createdRollIds.length });
  } catch (err) {
    console.error("RELEASE LINER STOCK CREATE ERROR:", err);
    const msg = err.code === 11000 ? "Roll ID collision, please retry." : "Failed to add release liner stock.";
    res.status(400).json({ success: false, message: msg });
  }
});

// No X-Frame-Options exception is needed for this route, and none should be
// added. The Print dialog does not navigate an iframe here -- it fetches
// this HTML and writes it in as srcdoc (see openLabelDialog in
// views/stock/releaseLinerStock.ejs), and X-Frame-Options governs
// navigations, not inline documents. Pointing a frame at this URL instead
// would follow whatever came back, and an expired session answers 302 ->
// /sachiko/login, which is DENY like the rest of the app: the frame dies on
// the redirect target, where no header set here can reach.

// Failures here are read inside that iframe, so they have to BE the page.
// A flash-and-redirect (this file's pattern everywhere else) is invisible in
// a frame -- the operator would get the stock page rendered at sticker size,
// or another blocked navigation -- so this states the problem in the frame
// where the label would have been.
function sendLabelError(res, status, message) {
  res.status(status).type("html").send(
    `<!DOCTYPE html><meta charset="utf-8">`
    + `<div style="font:600 13px/1.5 Arial,Helvetica,sans-serif;color:#b91c1c;`
    + `display:flex;align-items:center;justify-content:center;height:100vh;`
    + `margin:0;text-align:center;padding:0 12px;">${message}</div>`,
  );
}

// The reel's printed sticker, as a page the browser prints: opened in its
// own tab by the Print button on the stock page, it fires the print dialog
// on load so the operator just picks the label printer.
//
// The page is the sticker and nothing else -- one 101.5 x 75.1 mm sheet,
// with each value positioned in the pre-printed box it belongs to. All of
// that geometry comes from utils/releaseLinerRollLabel.js (over the shared
// utils/materialRollLabel.js), which derives it from the very coordinates
// SOFT.prn uses, so the browser-printed label and the thermal-printed one
// land identically. This route only looks the reel up and renders the QR.
// The fields a reel is printed from, and its QR. Both the one-reel route and
// the many-reel sheet below go through this, so a label printed off a row's
// own Print button and the same reel printed as part of a batch are built
// from one place and cannot drift apart.
const LABEL_REEL_FIELDS = "rollId vendorName vendorSkuCode invoiceNo reelMtrs size type gsm inwardDate";

async function buildLabelFor(reel) {
  const labelInput = {
    vendorName: reel.vendorName,
    vendorSkuCode: reel.vendorSkuCode,
    invoiceNo: reel.invoiceNo,
    reelMtrs: reel.reelMtrs,
    size: reel.size,
    type: reel.type,
    gsm: reel.gsm,
    inwardDate: reel.inwardDate,
    rollId: reel.rollId,
  };
  // The QR still carries the full pre-printed-grid payload, so anything that
  // scans it is unaffected by the label's visual redesign.
  return {
    rollId: reel.rollId,
    fields: buildInwardLabelFields(labelInput),
    qrDataUrl: await rollLabelQrDataUrl(buildQrPayload(labelInput)),
  };
}

// Named `mm`, not `layout` -- `layout` is ejs-mate's own helper and a local
// of that name breaks rendering. The current design draws itself from an SVG
// scaled to these dimensions, so only the sticker size is needed here now,
// not the pre-printed SOFT.prn slot geometry.
const LABEL_MM = { labelWidth: LABEL_WIDTH_MM, labelHeight: LABEL_HEIGHT_MM };

router.get("/label/:stockId", requireAuth, async (req, res) => {
  try {
    const { stockId } = req.params;
    if (!mongoose.isValidObjectId(stockId)) return sendLabelError(res, 404, "Roll not found.");

    const reel = await ReleaseLinerStock.findById(stockId).select(LABEL_REEL_FIELDS).lean();
    if (!reel) return sendLabelError(res, 404, "Roll not found.");

    res.render("stock/releaseLinerRollLabel.ejs", {
      labels: [await buildLabelFor(reel)],
      mm: LABEL_MM,
    });
  } catch (err) {
    console.error("RELEASE LINER ROLL LABEL ERROR:", err);
    sendLabelError(res, 500, "Failed to build the label.");
  }
});

// The same sticker, one per page, for however many reels were ticked in the
// stock page's Print Roll Labels dialog -- so a whole inward batch is stuck
// in one pass at the printer instead of a reel at a time.
//
// Only the ids travel: every value on every label is re-read here, exactly
// as the one-reel route reads it, so a doctored request can ask for labels
// for reels it shouldn't see (the same reels this page already lists) but
// can never put wrong figures ON a label.
router.get("/labels", requireAuth, async (req, res) => {
  try {
    const ids = String(req.query.ids || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);

    if (!ids.length) return sendLabelError(res, 400, "No reels were selected.");
    if (ids.length > MAX_LABELS_PER_SHEET) {
      return sendLabelError(res, 400, `Too many reels at once — ${MAX_LABELS_PER_SHEET} labels is the most one print can hold.`);
    }
    if (!ids.every((id) => mongoose.isValidObjectId(id))) return sendLabelError(res, 400, "One of the selected reels is not a valid reel.");

    const reels = await ReleaseLinerStock.find({ _id: { $in: ids } }).select(LABEL_REEL_FIELDS).lean();
    if (!reels.length) return sendLabelError(res, 404, "None of the selected reels could be found.");

    // Printed in the order they were ticked, which is the order the dialog
    // lists them in -- so the stack coming off the printer runs the same way
    // as the reels on the screen, and can be matched off one by one.
    const byId = new Map(reels.map((reel) => [String(reel._id), reel]));
    const ordered = ids.map((id) => byId.get(id)).filter(Boolean);

    res.render("stock/releaseLinerRollLabel.ejs", {
      labels: await Promise.all(ordered.map(buildLabelFor)),
      mm: LABEL_MM,
      // A reel that has been deleted between opening the dialog and printing
      // is dropped rather than failing the whole sheet, but it is said out
      // loud on the page: a silently short stack is how a reel ends up with
      // no sticker on it.
      missingCount: ids.length - ordered.length,
    });
  } catch (err) {
    console.error("RELEASE LINER ROLL LABEL SHEET ERROR:", err);
    sendLabelError(res, 500, "Failed to build the labels.");
  }
});

router.put("/:id", requireAuth, updateLimiter, async (req, res) => {
  try {
    const existing = await ReleaseLinerStock.findById(req.params.id).select("rollId").lean();
    if (!existing) {
      return res.status(404).json({ success: false, message: "Release liner stock reel not found." });
    }

    const payload = await buildEditPayload(req.body);
    const error = validateEditPayload(payload);
    if (error) return res.status(400).json({ success: false, message: error });

    const locationExists = await Location.exists({ locationName: payload.location });
    if (!locationExists) {
      return res.status(400).json({ success: false, message: "Invalid location." });
    }

    // Roll ID carries a unique index, but checked explicitly here (rather
    // than just letting the write hit it) so a renamed-onto-a-duplicate-id
    // mistake comes back as a clear 400 naming the clash, not a raw Mongo
    // duplicate-key error.
    if (payload.rollId && payload.rollId !== existing.rollId) {
      const dupe = await ReleaseLinerStock.exists({ rollId: payload.rollId, _id: { $ne: req.params.id } });
      if (dupe) {
        return res.status(400).json({ success: false, message: `Roll ID "${payload.rollId}" is already used by another reel.` });
      }
    }

    const updated = await ReleaseLinerStock.findByIdAndUpdate(req.params.id, payload, { new: true, runValidators: true });
    if (!updated) {
      return res.status(404).json({ success: false, message: "Release liner stock reel not found." });
    }

    res.locals.auditDescription = payload.rollId && payload.rollId !== existing.rollId
      ? `Updated release liner stock reel "${existing.rollId}" (renamed to "${updated.rollId}")`
      : `Updated release liner stock reel "${updated.rollId}"`;
    res.json({ success: true, rollId: updated.rollId });
  } catch (err) {
    console.error("RELEASE LINER STOCK UPDATE ERROR:", err);
    const msg = err.code === 11000 ? "Roll ID already in use by another reel." : "Failed to update release liner stock.";
    res.status(400).json({ success: false, message: msg });
  }
});

router.delete("/:id", requireAuth, deleteLimiter, async (req, res) => {
  try {
    const existing = await ReleaseLinerStock.findById(req.params.id);
    if (!existing) {
      return res.status(404).json({ success: false, message: "Release liner stock reel not found." });
    }

    // Removable whatever its status -- allotted, in use on a job card, even
    // live on a machine. If it's only ALLOTTED (reserved for an order, not
    // drawn on), it's released from that order's allotment first, so
    // nothing is left pointing at a reel that no longer exists; a reel
    // already used/live is removed as-is (its recorded usage stays on the
    // job card as history -- a stockId that no longer resolves, same as any
    // other record of a deleted thing).
    const { allottedByReel, usedByReel } = await loadReleaseReelUsage();
    const key = String(existing._id);
    const wasUsed = usedByReel.has(key);
    const released = allottedByReel.has(key) ? await unallotReel("release", key) : [];

    await existing.deleteOne();
    res.locals.auditDescription = `Deleted release liner stock reel "${existing.rollId}"${released.length ? ` (un-allotted from ${released.join(", ")})` : ""}${wasUsed ? " (was already in use on a job card)" : ""}`;
    res.json({ success: true, released, wasUsed });
  } catch (err) {
    console.error("RELEASE LINER STOCK DELETE ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to delete release liner stock." });
  }
});

export default router;
