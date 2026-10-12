import express from "express";
import crypto from "crypto";
import SachikoLabelStock from "../../models/sachiko/sachikoLabelStock.js";
import LabelStockBinding from "../../models/sachiko/labelStockBinding.js";
import Client from "../../models/users/client.js";
import Username from "../../models/users/username.js";
import TapeSalesOrder from "../../models/inventory/TapeSalesOrder.js";
import { requireAuth } from "../../middleware/auth.js";
import { createLimiter, updateLimiter, deleteLimiter } from "../../utils/limiters.js";
import { getUserLocationNames } from "../../utils/locations.js";
import { verificationUpdate } from "../../utils/verification.js";

const router = express.Router();

// Same sha256 signature scheme used for Client/TapeSalesOrder duplicate
// prevention (see routes/users/clients.js, routes/fairdesk_route.js) --
// applied here to "same SKU, same paper size, same RM, same client and user".
function hashSignature(rawSignature) {
  return `sha256:${crypto.createHash("sha256").update(String(rawSignature ?? "")).digest("hex")}`;
}

function canonicalizePaperSize(value) {
  return String(value || "").trim().toUpperCase().replace(/\s+/g, " ");
}

function buildBindingSignature({ labelStock, userId, paperSize, runningMeters }) {
  return hashSignature(
    [
      String(labelStock || ""),
      String(userId || ""),
      canonicalizePaperSize(paperSize),
      String(Number(runningMeters ?? "")),
    ].join("||"),
  );
}

const DUPLICATE_BINDING_MESSAGE =
  "This Label Stock binding already exists (same SKU Code, Paper Size, RM, Client and User).";

// Flat field id (used by the form/JS) -> the SachikoLabelStock document path it matches.
const SPEC_FIELDS = {
  fsFamily: "facestock.facestockFamily",
  fsType: "facestock.facestockType",
  fsGsm: "facestock.facestockGsm",
  fsMicron: "facestock.facestockMicron",
  adType: "adhesive.adhesiveType",
  adGsm: "adhesive.adhesiveGsm",
  rlType: "releaseLiner.releaseLinerType",
  rlColor: "releaseLiner.releaseLinerColor",
  rlGsm: "releaseLiner.releaseLinerGsm",
};

// Tolerate a value coming in as either a string or a number (GSM/Micron are
// stored as Numbers on SachikoLabelStock, but query params always arrive as strings).
const flex = (val) => {
  if (!val && val !== 0) return val;
  const arr = [val];
  if (typeof val === "string") {
    const t = val.trim();
    if (t !== val) arr.push(t);
    const n = Number(t);
    if (t !== "" && !isNaN(n)) arr.push(n);
  } else {
    arr.push(String(val));
  }
  return { $in: arr };
};

/* GET : Load Label Stock Binding Form */
router.get("/form/label-stock-binding", async (req, res) => {
  try {
    const [clients, fsFamilies, fsTypes, fsGsms, fsMicrons, adTypes, adGsms, rlTypes, rlColors, rlGsms, labelStocks] = await Promise.all([
      Client.distinct("clientName"),
      SachikoLabelStock.distinct("facestock.facestockFamily"),
      SachikoLabelStock.distinct("facestock.facestockType"),
      SachikoLabelStock.distinct("facestock.facestockGsm"),
      SachikoLabelStock.distinct("facestock.facestockMicron"),
      SachikoLabelStock.distinct("adhesive.adhesiveType"),
      SachikoLabelStock.distinct("adhesive.adhesiveGsm"),
      SachikoLabelStock.distinct("releaseLiner.releaseLinerType"),
      SachikoLabelStock.distinct("releaseLiner.releaseLinerColor"),
      SachikoLabelStock.distinct("releaseLiner.releaseLinerGsm"),
      SachikoLabelStock.find({}, {
        skuCode: 1, productCode: 1, rollType: 1,
        facestock: 1, facestock2: 1, adhesive: 1, adhesive2: 1, releaseLiner: 1, releaseLiner2: 1,
      }).sort({ skuCode: 1 }).lean(),
    ]);

    res.render("sachiko/labelStockBindingForm.ejs", {
      title: "Client Label Stock",
      clients,
      CSS: false,
      JS: false,
      notification: req.flash("notification"),
      fsFamilies,
      fsTypes,
      fsGsms,
      fsMicrons,
      adTypes,
      adGsms,
      rlTypes,
      rlColors,
      rlGsms,
      labelStocks,
    });
  } catch (err) {
    console.error(err);
    req.flash("notification", "Failed to load Label Stock Binding");
    res.redirect(req.get("Referrer") || "/");
  }
});

/* POST : Save Label Stock Binding */
router.post("/form/label-stock-binding", requireAuth, createLimiter, async (req, res) => {
  try {
    const { userId, labelStockId } = req.body;
    const location = String(req.body.location || "").trim();
    const paperSize = String(req.body.paperSize || "").trim();
    const runningMeters = Number(req.body.runningMeters);
    const rate = Number(req.body.rate);

    const user = await Username.findById(userId);
    if (!user) {
      return res.status(400).json({ success: false, message: "Invalid user selected" });
    }

    if (!location) {
      return res.status(400).json({ success: false, message: "Please select a location" });
    }

    if (!paperSize) {
      return res.status(400).json({ success: false, message: "Please enter a paper size" });
    }

    if (!runningMeters && runningMeters !== 0) {
      return res.status(400).json({ success: false, message: "Please enter running meters" });
    }

    if (!rate && rate !== 0) {
      return res.status(400).json({ success: false, message: "Please enter a rate" });
    }

    if (!labelStockId) {
      return res.status(400).json({ success: false, message: "Please resolve a valid Label Stock before saving" });
    }

    const bindingSignature = buildBindingSignature({ labelStock: labelStockId, userId, paperSize, runningMeters });
    const existingBinding = await LabelStockBinding.findOne({ bindingSignature }).select("_id").lean();
    if (existingBinding) {
      return res.status(400).json({ success: false, message: DUPLICATE_BINDING_MESSAGE });
    }

    const binding = await LabelStockBinding.create({ labelStock: labelStockId, userId, location, paperSize, runningMeters, rate, bindingSignature, ...verificationUpdate(req).set });

    user.labelStock.push(binding._id);
    await user.save();

    res.locals.auditDescription = `Created Label Stock binding for "${user.userName}"`;
    req.flash("notification", "Label Stock binding created successfully!");
    res.json({ success: true, redirect: "/app/client/details/" + userId });
  } catch (err) {
    console.error("LABEL STOCK BINDING ERROR:", err);
    if (err?.code === 11000 && err?.keyPattern && Object.prototype.hasOwnProperty.call(err.keyPattern, "bindingSignature")) {
      return res.status(400).json({ success: false, message: DUPLICATE_BINDING_MESSAGE });
    }
    res.status(500).json({ success: false, message: "Failed to create Label Stock binding." });
  }
});

// Last / Lowest / Highest rate, plus total quantity actually sent, per Label
// Stock binding -- taken from every Sales Order ever placed against that
// binding (its `orderRate` and `dispatchedQuantity`). Rates follow the same
// rules as the vendor profile's price history: a blank or zero rate means
// "never priced" rather than "free", so those orders sit out of the rate
// stats (Sent still counts them) -- otherwise Lowest would peg at zero
// forever. Orders are walked oldest-first (by poDate, else createdAt) so the
// newest one is simply the one left standing for "Last".
async function buildBindingRateStats(bindingIds) {
  const stats = new Map();
  if (!bindingIds.length) return stats;

  const orders = await TapeSalesOrder.find({
    onBindingModel: "LabelStockBinding",
    tapeBinding: { $in: bindingIds },
    status: { $ne: "CANCELLED" }, // a cancelled order never actually priced or sent anything
  })
    .select("tapeBinding orderRate dispatchedQuantity poDate createdAt")
    .lean();

  const entry = (key) => {
    if (!stats.has(key)) stats.set(key, { sentQuantity: 0 });
    return stats.get(key);
  };

  // Sent: summed across every non-cancelled order's dispatchedQuantity,
  // regardless of whether that order was ever priced.
  orders.forEach((o) => {
    entry(String(o.tapeBinding)).sentQuantity += Number(o.dispatchedQuantity) || 0;
  });

  const priced = orders
    .map((o) => ({
      key: String(o.tapeBinding),
      rate: Number(o.orderRate),
      at: new Date(o.poDate || o.createdAt || 0).getTime(),
    }))
    .filter((e) => Number.isFinite(e.rate) && e.rate > 0)
    .sort((a, b) => a.at - b.at);

  for (const { key, rate } of priced) {
    const current = entry(key);
    if (current.lastRate === undefined) {
      current.lastRate = rate;
      current.lowestRate = rate;
      current.highestRate = rate;
      continue;
    }
    current.lastRate = rate;
    current.lowestRate = Math.min(current.lowestRate, rate);
    current.highestRate = Math.max(current.highestRate, rate);
  }
  return stats;
}

/* GET : Display a client's bound Label Stocks */
router.get("/label-stock-binding/view/:id", async (req, res) => {
  try {
    const user = await Username.findById(req.params.id)
      .populate({ path: "labelStock", populate: { path: "labelStock", model: "SachikoLabelStock" } })
      .lean();

    if (!user) {
      req.flash("notification", "User not found");
      return res.redirect(req.get("Referrer") || "/");
    }

    const bindings = user.labelStock || [];
    const rateStats = await buildBindingRateStats(bindings.map((b) => b._id));
    const jsonData = bindings.map((binding) => ({
      ...binding,
      ...(rateStats.get(String(binding._id)) || {}),
    }));

    res.render("sachiko/labelStockBindingDisp.ejs", {
      jsonData,
      userId: String(user._id),
      clientName: user.clientName || "",
      userName: user.userName || "",
      CSS: "tableDisp.css",
      JS: false,
      title: "Label Stock Binding Display",
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("LABEL STOCK BINDING VIEW ERROR:", err);
    res.redirect(req.get("Referrer") || "/");
  }
});

/* POST : Delete a Label Stock binding */
router.post("/label-stock-binding/delete/:id", requireAuth, deleteLimiter, async (req, res) => {
  try {
    const binding = await LabelStockBinding.findById(req.params.id).select("userId").lean();
    if (!binding) {
      req.flash("notification", "Label Stock binding not found");
      return res.redirect(req.get("Referrer") || "/");
    }

    await LabelStockBinding.deleteOne({ _id: req.params.id });
    await Username.updateOne({ _id: binding.userId }, { $pull: { labelStock: req.params.id } });

    res.locals.auditDescription = `Deleted Label Stock binding for user ${binding.userId}`;
    req.flash("notification", "Label Stock binding removed successfully!");
    return res.redirect(`/app/label-stock-binding/view/${binding.userId}`);
  } catch (err) {
    console.error("LABEL STOCK BINDING DELETE ERROR:", err);
    req.flash("notification", "Failed to remove Label Stock binding");
    return res.redirect("back");
  }
});

/* GET : Load Label Stock Binding Edit Form */
router.get("/label-stock-binding/edit/:id", async (req, res) => {
  try {
    const binding = await LabelStockBinding.findById(req.params.id).populate("labelStock").populate("userId");
    if (!binding) {
      req.flash("notification", "Label Stock binding not found");
      return res.redirect(req.get("Referrer") || "/");
    }

    const labelStocks = await SachikoLabelStock.find({}, {
      skuCode: 1, productCode: 1, rollType: 1,
      facestock: 1, facestock2: 1, adhesive: 1, adhesive2: 1, releaseLiner: 1, releaseLiner2: 1,
    }).sort({ skuCode: 1 }).lean();

    res.render("sachiko/labelStockBindingEdit.ejs", {
      title: "Edit Label Stock Binding",
      binding,
      userLocations: getUserLocationNames(binding.userId, binding.location),
      labelStocks,
      CSS: false,
      JS: false,
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("LABEL STOCK BINDING EDIT GET ERROR:", err);
    req.flash("notification", "Failed to load Label Stock Binding Edit");
    res.redirect(req.get("Referrer") || "/");
  }
});

/* POST : Update Label Stock Binding */
router.post("/label-stock-binding/edit/:id", requireAuth, updateLimiter, async (req, res) => {
  try {
    const { id } = req.params;

    const binding = await LabelStockBinding.findById(id);
    if (!binding) {
      return res.status(404).json({ success: false, message: "Label Stock binding not found." });
    }

    const location = String(req.body.location || "").trim();
    const paperSize = String(req.body.paperSize || "").trim();
    const runningMeters = Number(req.body.runningMeters);
    const rate = Number(req.body.rate);
    const labelStockId = req.body.labelStockId;

    if (!location) {
      return res.status(400).json({ success: false, message: "Please select a location" });
    }
    if (!paperSize) {
      return res.status(400).json({ success: false, message: "Please enter a paper width" });
    }
    if (!runningMeters && runningMeters !== 0) {
      return res.status(400).json({ success: false, message: "Please enter running meters" });
    }
    if (!rate && rate !== 0) {
      return res.status(400).json({ success: false, message: "Please enter a rate" });
    }
    if (!labelStockId) {
      return res.status(400).json({ success: false, message: "Please select a valid Label Stock" });
    }

    const bindingSignature = buildBindingSignature({
      labelStock: labelStockId,
      userId: binding.userId,
      paperSize,
      runningMeters,
    });
    const duplicate = await LabelStockBinding.findOne({ _id: { $ne: id }, bindingSignature }).select("_id").lean();
    if (duplicate) {
      return res.status(400).json({ success: false, message: DUPLICATE_BINDING_MESSAGE });
    }

    binding.labelStock = labelStockId;
    binding.location = location;
    binding.paperSize = paperSize;
    binding.runningMeters = runningMeters;
    binding.rate = rate;
    binding.bindingSignature = bindingSignature;
    const vf = verificationUpdate(req, binding);
    Object.assign(binding, vf.set);
    Object.keys(vf.unset).forEach((k) => binding.set(k, undefined));
    await binding.save();

    res.locals.auditDescription = `Updated Label Stock binding for user ${binding.userId}`;
    req.flash("notification", "Label Stock binding updated successfully!");
    res.json({ success: true, redirect: `/app/label-stock-binding/view/${binding.userId}` });
  } catch (err) {
    console.error("LABEL STOCK BINDING EDIT POST ERROR:", err);
    if (err?.code === 11000 && err?.keyPattern && Object.prototype.hasOwnProperty.call(err.keyPattern, "bindingSignature")) {
      return res.status(400).json({ success: false, message: DUPLICATE_BINDING_MESSAGE });
    }
    res.status(500).json({ success: false, message: "Failed to update Label Stock binding." });
  }
});

router.post("/label-stock-binding/set-inactive/:id", requireAuth, updateLimiter, async (req, res) => {
  try {
    const binding = await LabelStockBinding.findByIdAndUpdate(req.params.id, { status: "INACTIVE" }, { new: false });
    if (!binding) return res.status(404).json({ success: false, message: "Not found" });
    res.locals.auditDescription = `Set Label Stock binding "${binding._id}" inactive`;
    res.json({ success: true });
  } catch (err) {
    console.error("LABEL STOCK BINDING SET INACTIVE ERROR:", err);
    res.status(500).json({ success: false });
  }
});

router.post("/label-stock-binding/set-active/:id", requireAuth, updateLimiter, async (req, res) => {
  try {
    const binding = await LabelStockBinding.findByIdAndUpdate(req.params.id, { status: "ACTIVE" }, { new: false });
    if (!binding) return res.status(404).json({ success: false, message: "Not found" });
    res.locals.auditDescription = `Set Label Stock binding "${binding._id}" active`;
    res.json({ success: true });
  } catch (err) {
    console.error("LABEL STOCK BINDING SET ACTIVE ERROR:", err);
    res.status(500).json({ success: false });
  }
});

/* GET : Fetch Users by Client (AJAX) */
router.get("/form/label-stock-binding/client/:name", async (req, res) => {
  try {
    const clientData = await Client.findOne({ clientName: req.params.name }).populate("users");
    res.status(200).json(clientData);
  } catch (err) {
    console.error(err);
    res.status(500).json(null);
  }
});

/* GET : Filter Label Stock Specs (cascading smart form) */
router.get("/form/label-stock-binding/filter-specs", async (req, res) => {
  try {
    const query = req.query;

    const buildFilter = (excludeKey) => {
      const f = {};
      Object.entries(SPEC_FIELDS).forEach(([key, path]) => {
        if (query[key] && key !== excludeKey) f[path] = flex(query[key]);
      });
      return f;
    };

    const result = {};
    for (const [key, path] of Object.entries(SPEC_FIELDS)) {
      result[key] = await SachikoLabelStock.distinct(path, buildFilter(key));
    }

    res.json(result);
  } catch (err) {
    console.error("LABEL STOCK FILTER SPECS ERROR:", err);
    res.status(500).json(null);
  }
});

/* GET : Resolve Label Stock from Specifications */
router.get("/form/label-stock-binding/resolve-label-stock", async (req, res) => {
  try {
    const query = req.query;
    const filter = {};
    for (const [key, path] of Object.entries(SPEC_FIELDS)) {
      if (!query[key] && query[key] !== "0") return res.status(400).json(null);
      filter[path] = flex(query[key]);
    }

    const labelStock = await SachikoLabelStock.findOne(filter).lean();
    if (!labelStock) {
      return res.status(404).json(null);
    }

    res.status(200).json({
      labelStockId: labelStock._id,
      productCode: labelStock.productCode,
      skuCode: labelStock.skuCode,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json(null);
  }
});

export default router;
