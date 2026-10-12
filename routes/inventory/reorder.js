import express from "express";
import Tape from "../../models/inventory/tape.js";
import TapeStock from "../../models/inventory/TapeStock.js";
import TapeSalesOrder from "../../models/inventory/TapeSalesOrder.js";
import VendorTapeBinding from "../../models/inventory/vendorTapeBinding.js";
import VendorUser from "../../models/users/vendorUser.js";
import Vendor from "../../models/users/vendor.js";
import PurchaseOrder from "../../models/inventory/PurchaseOrder.js";
import PurchaseOrderLog from "../../models/inventory/PurchaseOrderLog.js";
import { requireAuth } from "../../middleware/auth.js";
import { createLimiter, updateLimiter, deleteLimiter } from "../../utils/limiters.js";

const router = express.Router();

async function getReorderData() {
  const activePOStatuses = ["PENDING", "CONFIRMED", "PARTIALLY_RECEIVED"];
  const types = [
    { model: Tape, stockModel: TapeStock, stockRef: "tape", minQtyField: "tapeMinQty", typeKey: "Tape", label: "Tape", bindingModel: VendorTapeBinding, refField: "tapeId" },
  ];

  const results = [];

  for (const t of types) {
    const items = await t.model.find().lean();
    const itemIds = items.map(i => i._id);

    // Aggregate Stock
    const stockAgg = await t.stockModel.aggregate([
      { $match: { [t.stockRef]: { $in: itemIds } } },
      { $group: { _id: `$${t.stockRef}`, total: { $sum: "$quantity" } } }
    ]);
    const stockMap = {};
    stockAgg.forEach(s => stockMap[s._id.toString()] = s.total);

    // Aggregate Booked (Pending Sales Orders)
    const salesAgg = await TapeSalesOrder.aggregate([
      { $match: { tapeId: { $in: itemIds }, status: { $in: ["PENDING", "CONFIRMED"] }, onModel: t.typeKey } },
      { $project: { tapeId: 1, balance: { $max: [0, { $subtract: ["$quantity", { $ifNull: ["$dispatchedQuantity", 0] }] }] } } },
      { $group: { _id: "$tapeId", totalBooked: { $sum: "$balance" } } }
    ]);
    const bookedMap = {};
    salesAgg.forEach(s => bookedMap[s._id.toString()] = s.totalBooked);

    // Fetch Bindings for Vendor/Coordinator info
    const bindings = await t.bindingModel.find({ [t.refField]: { $in: itemIds } })
      .populate("vendorUserId", "vendorName userName userLocation")
      .lean();

    const vendorMap = {};
    const coordinatorMap = {};
    const locationMap = {};

    bindings.forEach(b => {
      const itemId = b[t.refField].toString();
      if (!vendorMap[itemId]) vendorMap[itemId] = new Set();
      if (!coordinatorMap[itemId]) coordinatorMap[itemId] = new Set();
      if (!locationMap[itemId]) locationMap[itemId] = new Set();

      if (b.vendorUserId) {
        if (b.vendorUserId.vendorName) vendorMap[itemId].add(b.vendorUserId.vendorName);
        if (b.vendorUserId.userName) coordinatorMap[itemId].add(b.vendorUserId.userName);
        if (b.vendorUserId.userLocation) locationMap[itemId].add(b.vendorUserId.userLocation);
      }
    });

    const activePOs = await PurchaseOrder.find({
      onModel: t.typeKey,
      itemId: { $in: itemIds },
      status: { $in: activePOStatuses },
      vendorUserId: { $ne: null },
      vendorBinding: { $ne: null },
    }).select("itemId").lean();
    const activePOMap = new Set(activePOs.map((po) => String(po.itemId)));

    items.forEach(item => {
      if (activePOMap.has(String(item._id))) return;

      const stock = stockMap[item._id.toString()] || 0;
      const booked = bookedMap[item._id.toString()] || 0;
      const minQty = item[t.minQtyField] || 0;
      const effectiveStock = stock - booked;

      if (effectiveStock < minQty) {
        const itemIdStr = item._id.toString();
        results.push({
          _id: item._id,
          type: t.label,
          typeKey: t.typeKey,
          productId: item.tapeProductId || "N/A",
          name: getItemName(item, t.typeKey),
          stock,
          booked,
          effectiveStock,
          minQty,
          shortage: minQty - effectiveStock,
          vendors: Array.from(vendorMap[itemIdStr] || []).join(", "),
          coordinators: Array.from(coordinatorMap[itemIdStr] || []).join(", "),
          locations: Array.from(locationMap[itemIdStr] || []).join(", "),
          hasVendors: (vendorMap[itemIdStr] || new Set()).size > 0,
          bindingPath: "/app/vendor/coordinator/view"
        });
      }
    });
  }

  return results;
}

function getItemName(item, type) {
  if (type === "Tape") return `${item.tapePaperCode || ""} ${item.tapeGsm || ""}gsm`.trim() || item.tapeProductId;
  return "N/A";
}

async function getItemShortage(type, id) {
  try {
    const types = {
      "Tape": { stockModel: TapeStock, stockRef: "tape", minQtyField: "tapeMinQty" },
    };
    const t = types[type];
    if (!t) return 0;

    const item = await Tape.findById(id).lean();
    if (!item) return 0;

    // Current Stock
    const stockAgg = await t.stockModel.aggregate([
      { $match: { [t.stockRef]: item._id } },
      { $group: { _id: null, total: { $sum: "$quantity" } } }
    ]);
    const stock = stockAgg[0]?.total || 0;

    // Booked (Pending Sales)
    const salesAgg = await TapeSalesOrder.aggregate([
      { $match: { tapeId: item._id, status: { $in: ["PENDING", "CONFIRMED"] }, onModel: type } },
      { $project: { balance: { $max: [0, { $subtract: ["$quantity", { $ifNull: ["$dispatchedQuantity", 0] }] }] } } },
      { $group: { _id: null, totalBooked: { $sum: "$balance" } } }
    ]);
    const booked = salesAgg[0]?.totalBooked || 0;

    const minQty = item[t.minQtyField] || 0;
    const effectiveStock = stock - booked;
    return Math.max(0, minQty - effectiveStock);
  } catch (err) {
    console.error("GET ITEM SHORTAGE ERROR:", err);
    return 0;
  }
}

router.get("/reorder", async (req, res) => {
  try {
    const items = await getReorderData();
    res.render("inventory/orders/reorder.ejs", {
      title: "Reorder List",
      items,
      notification: req.flash("notification"),
      CSS: "tableDisp.css",
      JS: false
    });
  } catch (err) {
    console.error("REORDER ROUTE ERROR:", err);
    res.status(500).send("Internal Server Error");
  }
});


router.get("/reorder/api/vendors/:type/:id", async (req, res) => {
  try {
    const { type, id } = req.params;
    let bindingModel;
    let refField;

    if (type === "Tape") {
        bindingModel = VendorTapeBinding;
        refField = "tapeId";
    }

    if (!bindingModel) return res.status(400).json([]);

    const bindings = await bindingModel.find({ [refField]: id })
      .populate("vendorUserId", "vendorName userName userContact userLocation")
      .lean();

    res.json(bindings);
  } catch (err) {
    console.error("API VENDORS ERROR:", err);
    res.status(500).json([]);
  }
});

router.get("/reorder/select-vendor/:type/:id", async (req, res) => {
  try {
    const { type, id } = req.params;
    let model, bindingModel, refField;

    const normalizedType = type.toLowerCase();
    if (normalizedType === "tape") {
      model = Tape;
      bindingModel = VendorTapeBinding;
      refField = "tapeId";
    }

    if (!model) return res.status(404).send("Item Type Not Found");
    const { poId } = req.query;

    const [item, bindings, orderToEdit] = await Promise.all([
      model.findById(id).lean(),
      bindingModel.find({ [refField]: id }).populate("vendorUserId").lean(),
      poId ? PurchaseOrder.findById(poId).populate("vendorUserId").lean() : Promise.resolve(null)
    ]);

    if (!item) return res.status(404).send("Item Not Found");

    // Fetch all coordinators for the vendors found in bindings
    const vendorIds = [...new Set(bindings.map(b => b.vendorUserId?.vendorId).filter(Boolean))];
    const allCoordinators = await VendorUser.find({ vendorId: { $in: vendorIds } }).lean();

    // Item Spec
    const typeKey = normalizedType.charAt(0).toUpperCase() + normalizedType.slice(1).replace("-", "");
    const shortage = req.query.shortage || (await getItemShortage(typeKey, id));

    res.render("inventory/orders/selectVendor.ejs", {
      title: orderToEdit ? "Edit Purchase Order" : "Create Purchase Order",
      item,
      orderToEdit,
      itemName: getItemName(item, typeKey),
      type: typeKey,
      bindings,
      allCoordinators,
      shortage: shortage || 0,
      notification: req.flash("notification"),
      CSS: false,
      JS: false
    });
  } catch (err) {
    console.error("SELECT VENDOR ROUTE ERROR:", err);
    res.status(500).send("Internal Server Error");
  }
});

router.post("/reorder/create-po", requireAuth, createLimiter, async (req, res) => {
  try {
    let { orderId, itemId, itemType, vendorUserId, vendorBindingId, userLocation, quantity, poNumber, estimatedDate, remarks } = req.body;

    // Standardize itemType for Model Enums
    if (itemType === "tape") itemType = "Tape";

    let bindingModel, refField, onBindingModel;
    if (itemType === "Tape") {
      bindingModel = VendorTapeBinding;
      refField = "tapeId";
      onBindingModel = "VendorTapeBinding";
    }

    if (!bindingModel) {
        req.flash("notification", "Invalid item type specified.");
        return res.redirect("/app/purchase/pending");
    }

    let binding = null;
    if (vendorBindingId) {
      binding = await bindingModel.findById(vendorBindingId);
      if (binding && String(binding[refField]) !== String(itemId)) {
        binding = null;
      }
      if (binding && vendorUserId && String(binding.vendorUserId) !== String(vendorUserId)) {
        binding = null;
      }
    } else {
      binding = await bindingModel.findOne({ [refField]: itemId, vendorUserId });
    }
    if (!binding) {
      const itemBindings = await bindingModel.find({ [refField]: itemId }).sort({ createdAt: 1 }).limit(2).lean();
      if (itemBindings.length === 1) {
        binding = itemBindings[0];
      }
    }
    if (!binding) {
      req.flash("notification", "Vendor not binded for this item. Purchase Order was not created.");
      return res.redirect("/app/purchase/pending");
    }

    const resolvedVendorUserId = vendorUserId || binding.vendorUserId;
    const parsedEstimatedDate = new Date(estimatedDate);
    const resolvedEstimatedDate = Number.isNaN(parsedEstimatedDate.getTime())
      ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      : parsedEstimatedDate;

    const poData = {
      onBindingModel,
      vendorBinding: binding._id,
      vendorUserId: resolvedVendorUserId,
      onModel: itemType,
      itemId,
      userLocation,
      quantity: Number(quantity),
      poNumber: String(poNumber || "").trim(),
      estimatedDate: resolvedEstimatedDate,
      remarks,
      status: "PENDING",
    };

    const vendorDoc = await VendorUser.findById(resolvedVendorUserId).select("vendorName userName").lean();
    const vendorLabel = vendorDoc?.vendorName || vendorDoc?.userName || "Unknown Vendor";

    if (orderId) {
      const updatedPo = await PurchaseOrder.findByIdAndUpdate(orderId, poData, { new: true });
      await PurchaseOrderLog.create({
        orderId: updatedPo._id,
        action: "EDITED",
        poNumber: updatedPo.poNumber,
        quantity: updatedPo.quantity,
        performedBy: req.session?.authUser?.username || "SYSTEM"
      });
      res.locals.auditDescription = `Updated purchase order "${updatedPo.poNumber}" for ${itemType} from "${vendorLabel}" (qty ${updatedPo.quantity})`;
      req.flash("notification", "Purchase Order updated successfully.");
    } else {
      poData.createdBy = req.session?.authUser?.username || "SYSTEM";
      const po = await PurchaseOrder.create(poData);
      await PurchaseOrderLog.create({
        orderId: po._id,
        action: "CREATED",
        poNumber: po.poNumber,
        quantity: po.quantity,
        performedBy: req.session?.authUser?.username || "SYSTEM"
      });
      res.locals.auditDescription = `Created purchase order "${po.poNumber}" for ${itemType} from "${vendorLabel}" (qty ${po.quantity})`;
      req.flash("notification", "Purchase Order created successfully.");
    }

    res.redirect("/app/purchase/pending");
  } catch (err) {
    console.error("CREATE PO ERROR:", err);
    req.flash("notification", "Error: " + (err.message || "Failed to create Purchase Order."));
    res.redirect("back");
  }
});

router.post("/purchase/status", requireAuth, updateLimiter, async (req, res) => {
  try {
    const { orderId, status, remarks } = req.body;
    
    const po = await PurchaseOrder.findById(orderId);
    if (!po) {
      req.flash("notification", "Purchase Order not found.");
      return res.redirect("back");
    }

    po.status = status;
    if (remarks) po.remarks = (po.remarks ? po.remarks + " | " : "") + remarks;
    await po.save();

    // Log Action
    await PurchaseOrderLog.create({
      orderId: po._id,
      action: status === "RECEIVED" ? "RECEIVED" : "CANCELLED",
      poNumber: po.poNumber,
      quantity: po.quantity,
      remarks: remarks || "",
      performedBy: req.session?.authUser?.username || "SYSTEM"
    });

    res.locals.auditDescription = `Marked purchase order "${po.poNumber}" as ${status}`;
    req.flash("notification", `Purchase Order mark as ${status.toLowerCase()} successfully.`);
    res.redirect("/app/purchase/pending");
  } catch (err) {
    console.error("PO STATUS UPDATE ERROR:", err);
    req.flash("notification", "Error updating Purchase Order status.");
    res.redirect("back");
  }
});

router.get("/reorder/select-vendor-multi", async (req, res) => {
  try {
    const itemsParam = req.query.items;
    if (!itemsParam) return res.redirect("/app/inventory/orders/reorder");

    const tokens = decodeURIComponent(itemsParam).split(",").map(s => s.trim()).filter(Boolean);
    const cartItems = [];

    for (const token of tokens) {
      const parts = token.split(":");
      if (parts.length < 2) continue;
      const typeKey  = parts[0];  // Tape
      const id       = parts[1];
      const shortage = parseInt(parts[2]) || 0;

      let model, bindingModel, refField;
      if (typeKey === "Tape")    { model = Tape;    bindingModel = VendorTapeBinding;    refField = "tapeId"; }
      else continue;

      const [item, bindings] = await Promise.all([
        model.findById(id).lean(),
        bindingModel.find({ [refField]: id }).populate("vendorUserId", "vendorName userName userContact userLocation locationDetails vendorId").lean()
      ]);
      if (!item) continue;

      const vendorIds = [...new Set(bindings.map(b => b.vendorUserId?.vendorId).filter(Boolean))];
      const coordinators = await VendorUser.find({ vendorId: { $in: vendorIds } }).lean();

      const groupedVendors = {};
      coordinators.forEach(v => {
        const vId = v.vendorId;
        if (!vId) return;
        if (!groupedVendors[vId]) groupedVendors[vId] = { id: vId, name: v.vendorName, coordinators: [] };
        const binding = bindings.find(b => b.vendorUserId?._id?.toString() === v._id.toString());
        groupedVendors[vId].coordinators.push({
          bindingId:       binding ? binding._id : null,
          userId:          v._id,
          userName:        v.userName,
          userContact:     v.userContact,
          userLocation:    v.userLocation,
          locationDetails: v.locationDetails || [],
          minQty:          binding ? (binding.tapeMinQty || 0) : 0,
          hasBinding:      !!binding
        });
      });

      cartItems.push({
        _id:           item._id,
        typeKey,
        itemName:      getItemName(item, typeKey),
        shortage,
        item,
        groupedVendors
      });
    }

    if (cartItems.length === 0) return res.redirect("/app/inventory/orders/reorder");

    res.render("inventory/orders/selectVendorMulti.ejs", {
      title: "Create Purchase Orders",
      cartItems,
      notification: req.flash("notification"),
      CSS: false,
      JS: false
    });
  } catch (err) {
    console.error("SELECT VENDOR MULTI ERROR:", err);
    res.status(500).send("Internal Server Error");
  }
});

router.post("/reorder/create-po-multi", requireAuth, createLimiter, async (req, res) => {
  try {
    const { poNumber, estimatedDate, remarks } = req.body;
    const rawItems = req.body.items;
    let parsedItems = [];
    try { parsedItems = JSON.parse(rawItems || "[]"); } catch { parsedItems = []; }

    const parsedEstimatedDate = new Date(estimatedDate);
    const resolvedDate = Number.isNaN(parsedEstimatedDate.getTime())
      ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      : parsedEstimatedDate;

    let createdCount = 0;

    for (const entry of parsedItems) {
      let { itemId, itemType, vendorUserId, vendorBindingId, userLocation, quantity } = entry;

      let bindingModel, refField, onBindingModel;
      if (itemType === "Tape")    { bindingModel = VendorTapeBinding;    refField = "tapeId";    onBindingModel = "VendorTapeBinding"; }
      else continue;

      let binding = null;
      if (vendorBindingId) {
        binding = await bindingModel.findById(vendorBindingId);
        if (binding && String(binding[refField]) !== String(itemId)) binding = null;
      }
      if (!binding) binding = await bindingModel.findOne({ [refField]: itemId, vendorUserId });
      if (!binding) {
        const fallback = await bindingModel.find({ [refField]: itemId }).sort({ createdAt: 1 }).limit(1).lean();
        if (fallback.length) binding = fallback[0];
      }
      if (!binding) continue;

      const po = await PurchaseOrder.create({
        onBindingModel,
        vendorBinding:  binding._id,
        vendorUserId:   vendorUserId || binding.vendorUserId,
        onModel:        itemType,
        itemId,
        userLocation,
        quantity:       Number(quantity) || 1,
        poNumber:       String(poNumber || "").trim(),
        estimatedDate:  resolvedDate,
        remarks,
        status:         "PENDING",
        createdBy:      req.session?.authUser?.username || "SYSTEM"
      });

      await PurchaseOrderLog.create({
        orderId:     po._id,
        action:      "CREATED",
        poNumber:    po.poNumber,
        quantity:    po.quantity,
        performedBy: req.session?.authUser?.username || "SYSTEM"
      });

      createdCount++;
    }

    if (createdCount > 0) {
      res.locals.auditDescription = `Created ${createdCount} purchase order(s) under PO "${poNumber}"`;
      req.flash("notification", `${createdCount} Purchase Order(s) created successfully under PO #${poNumber}.`);
    } else {
      req.flash("notification", "No Purchase Orders were created. Check vendor bindings for the selected items.");
    }

    res.redirect("/app/purchase/pending");
  } catch (err) {
    console.error("CREATE MULTI PO ERROR:", err);
    req.flash("notification", "Error: " + (err.message || "Failed to create Purchase Orders."));
    res.redirect("back");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PURCHASE ORDER PAGE (Vendor-first flow — mirrors /sales/order)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /purchase/order
 * Render the purchase order form. Loads all active vendors.
 */
router.get("/purchase/order", async (req, res) => {
  try {
    const { orderId, itemType, itemId, vendorUserId, items: itemsParam } = req.query;

    const [vendors, orderToEdit] = await Promise.all([
      Vendor.find().select("vendorId vendorName").sort({ vendorName: 1 }).lean(),
      orderId
        ? PurchaseOrder.findById(orderId)
            .populate("vendorUserId")
            .populate("itemId")
            .populate("vendorBinding")
            .lean()
        : Promise.resolve(null),
    ]);

    const prefill = {
      itemType: itemType || "",
      itemId: itemId || "",
      vendorUserId: vendorUserId || "",
      vendorId: ""
    };

    // If coming from reorder list, auto-detect vendor/type from first item
    if (itemsParam && !prefill.itemType) {
      const tokens = itemsParam.split(",").filter(Boolean);
      const first = tokens[0].split(":");
      if (first.length >= 2) {
        const typeKey = first[0];
        const id      = first[1];
        prefill.itemType = typeKey;

        let bindingModel, refField;
        if      (typeKey === "Tape")    { bindingModel = VendorTapeBinding;    refField = "tapeId"; }

        if (bindingModel) {
          const binding = await bindingModel.findOne({ [refField]: id }).populate("vendorUserId").lean();
          if (binding && binding.vendorUserId) {
            prefill.vendorUserId = String(binding.vendorUserId._id);
            prefill.vendorId     = binding.vendorUserId.vendorId;
          }
        }
      }
    }

    res.render("inventory/orders/purchaseOrder.ejs", {
      title: orderToEdit ? "Edit Purchase Order" : "Purchase Order",
      vendors,
      orderToEdit,
      prefill,
      CSS: false,
      JS: false,
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("PURCHASE ORDER PAGE ERROR:", err);
    res.status(500).send("Internal Server Error");
  }
});

/**
 * GET /purchase/coordinators/:vendorId
 * Returns all vendor users (coordinators) for a vendor.
 */
router.get("/purchase/coordinators/:vendorId", async (req, res) => {
  try {
    const { vendorId } = req.params;
    const coordinators = await VendorUser.find({ vendorId })
      .select("_id vendorId vendorName userName userContact userLocation locationDetails")
      .lean();
    res.json(coordinators);
  } catch (err) {
    console.error("PURCHASE COORDINATORS API ERROR:", err);
    res.status(500).json([]);
  }
});

/**
 * GET /purchase/items/:type/:vendorUserId
 * Returns items bound to the given coordinator, enriched with stock & shortage info.
 * type: Tape
 */
router.get("/purchase/items/:type/:vendorUserId", async (req, res) => {
  try {
    const { type, vendorUserId } = req.params;
    const location = String(req.query.location || "").trim();

    let bindingModel, stockModel, stockRef, itemRef, minQtyField;
    if      (type === "Tape")    { bindingModel = VendorTapeBinding;    stockModel = TapeStock;    stockRef = "tape";    itemRef = "tapeId";    minQtyField = "tapeMinQty"; }
    else return res.status(400).json([]);

    const bindings = await bindingModel
      .find({ vendorUserId, ...(location ? { location } : {}) })
      .populate(itemRef)
      .lean();

    if (!bindings.length) return res.json([]);

    const itemIds = bindings.map(b => b[itemRef]?._id).filter(Boolean);

    // Stock per item
    const stockAgg = await stockModel.aggregate([
      { $match: { [stockRef]: { $in: itemIds } } },
      { $group: { _id: `$${stockRef}`, total: { $sum: "$quantity" },
        locations: { $push: { location: "$location", qty: "$quantity" } } } }
    ]);
    const stockMap = {};
    stockAgg.forEach(s => stockMap[String(s._id)] = { total: s.total, locations: s.locations });

    // Booked per item (pending sales)
    const bookedAgg = await TapeSalesOrder.aggregate([
      { $match: { tapeId: { $in: itemIds }, status: { $in: ["PENDING", "CONFIRMED"] }, onModel: type } },
      { $project: { tapeId: 1, balance: { $max: [0, { $subtract: ["$quantity", { $ifNull: ["$dispatchedQuantity", 0] }] }] } } },
      { $group: { _id: "$tapeId", totalBooked: { $sum: "$balance" } } }
    ]);
    const bookedMap = {};
    bookedAgg.forEach(s => bookedMap[String(s._id)] = s.totalBooked);

    // Pending Purchase Orders per item
    const poAgg = await PurchaseOrder.aggregate([
      { $match: { itemId: { $in: itemIds }, status: { $in: ["PENDING", "CONFIRMED", "PARTIALLY_RECEIVED"] }, onModel: type } },
      { $group: { _id: "$itemId", totalPo: { $sum: "$quantity" } } }
    ]);
    const poMap = {};
    poAgg.forEach(p => poMap[String(p._id)] = p.totalPo);

    const items = bindings.map(b => {
      const item = b[itemRef];
      if (!item) return null;
      const idStr     = String(item._id);
      const stockRaw  = stockMap[idStr]  || { total: 0, locations: [] };
      const booked    = bookedMap[idStr] || 0;
      const stock     = stockRaw.total;
      const minQty    = item[minQtyField] || 0;
      const effective = stock - booked;
      const shortage  = Math.max(0, minQty - effective);

      let displayName, rate, details;

      if (type === "Tape") {
        displayName = `${item.tapeProductId || "N/A"} — ${item.tapePaperCode || ""} ${item.tapeGsm || ""}gsm`;
        rate    = b.tapeRatePerRoll;
        details = { type: "Tape", productId: item.tapeProductId, paperCode: item.tapePaperCode, gsm: item.tapeGsm,
          paperType: item.tapePaperType, width: item.tapeWidth, mtrs: item.tapeMtrs, finish: item.tapeFinish,
          vendorPaperCode: b.vendorTapePaperCode, vendorGsm: b.vendorTapeGsm, minQty };
      }

      return {
        _id:         String(item._id),
        bindingId:   String(b._id),
        displayName,
        rate:        rate || 0,
        minQty,
        shortage,
        location:    b.location || "",
        stock: {
          totalStock: stock,
          booked,
          balance:    effective,
          pendingPo:  poMap[idStr] || 0,
          locations:  stockRaw.locations,
        },
        details,
      };
    }).filter(Boolean);
    
    // Grouping & Sorting:
    // Group 1: Shortage > 0 AND No Pending PO (Highest priority)
    // Group 2: Shortage == 0 AND No Pending PO (Regular stock)
    // Group 3: Pending PO > 0 (Ordered/Replenishing)
    items.sort((a, b) => {
      const aHasPo = (a.stock?.pendingPo || 0) > 0;
      const bHasPo = (b.stock?.pendingPo || 0) > 0;
      
      // Group 3 always at bottom
      if (aHasPo && !bHasPo) return 1;
      if (!aHasPo && bHasPo) return -1;
      
      // If both are in the same PO group (both have or both don't have)
      if (!aHasPo) {
        // Within non-PO items, prioritize shortages
        const aShort = a.shortage > 0;
        const bShort = b.shortage > 0;
        if (aShort && !bShort) return -1;
        if (!aShort && bShort) return 1;
      }
      
      // Final fallback: balance
      return (a.stock?.balance ?? 0) - (b.stock?.balance ?? 0);
    });

    res.json(items);
  } catch (err) {
    console.error("PURCHASE ITEMS API ERROR:", err);
    res.status(500).json([]);
  }
});

/**
 * POST /purchase/order
 * Create or update a purchase order from the vendor-first form.
 */
router.post("/purchase/order", requireAuth, createLimiter, async (req, res) => {
  try {
    let { orderId, itemId, itemType, vendorUserId, vendorBindingId, userLocation,
          quantity, poNumber, estimatedDate, remarks } = req.body;

    let bindingModel, onBindingModel;
    if      (itemType === "Tape")    { bindingModel = VendorTapeBinding;    onBindingModel = "VendorTapeBinding"; }
    else { return res.status(400).json({ success: false, message: "Invalid item type." }); }

    let binding = null;
    if (vendorBindingId) binding = await bindingModel.findById(vendorBindingId);
    if (!binding && vendorUserId && itemId) {
      const refField = itemType === "Tape" ? "tapeId" : null;
      // A coordinator can have this item bound at more than one location now —
      // disambiguate with the selected delivery location when we have one.
      binding = await bindingModel.findOne({ [refField]: itemId, vendorUserId, ...(userLocation ? { location: userLocation } : {}) });
    }
    if (!binding) {
      req.flash("notification", "Vendor binding not found for selected item.");
      return res.redirect("/app/inventory/purchase/order");
    }

    const parsedDate = new Date(estimatedDate);
    const resolvedDate = Number.isNaN(parsedDate.getTime())
      ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      : parsedDate;

    const poData = {
      onBindingModel,
      vendorBinding:  binding._id,
      vendorUserId:   vendorUserId || binding.vendorUserId,
      onModel:        itemType,
      itemId,
      userLocation,
      quantity:       Number(quantity),
      poNumber:       String(poNumber || "").trim(),
      estimatedDate:  resolvedDate,
      remarks,
      status:         "PENDING",
    };

    const performer = req.session?.authUser?.username || "SYSTEM";
    const vendorDoc = await VendorUser.findById(vendorUserId || binding.vendorUserId).select("vendorName userName").lean();
    const vendorLabel = vendorDoc?.vendorName || vendorDoc?.userName || "Unknown Vendor";

    if (orderId) {
      const updated = await PurchaseOrder.findByIdAndUpdate(orderId, poData, { new: true });
      await PurchaseOrderLog.create({ orderId: updated._id, action: "EDITED",
        poNumber: updated.poNumber, quantity: updated.quantity, performedBy: performer });
      res.locals.auditDescription = `Updated purchase order "${updated.poNumber}" for ${itemType} from "${vendorLabel}" (qty ${updated.quantity})`;
      req.flash("notification", "Purchase Order updated successfully.");
    } else {
      poData.createdBy = performer;
      const po = await PurchaseOrder.create(poData);
      await PurchaseOrderLog.create({ orderId: po._id, action: "CREATED",
        poNumber: po.poNumber, quantity: po.quantity, performedBy: performer });
      res.locals.auditDescription = `Created purchase order "${po.poNumber}" for ${itemType} from "${vendorLabel}" (qty ${po.quantity})`;
      req.flash("notification", "Purchase Order created successfully.");
    }

    res.redirect("/app/purchase/pending");
  } catch (err) {
    console.error("CREATE PURCHASE ORDER ERROR:", err);
    req.flash("notification", "Error: " + (err.message || "Failed to create Purchase Order."));
    res.redirect("back");
  }
});

/**
 * POST /purchase/order-multi
 * Batch-create purchase orders from the vendor-first cart UI.
 * Accepts the same payload shape as /reorder/create-po-multi.
 */
router.post("/purchase/order-multi", requireAuth, createLimiter, async (req, res) => {
  try {
    const { poNumber, estimatedDate, remarks } = req.body;
    let parsedItems = [];
    try { parsedItems = JSON.parse(req.body.items || "[]"); } catch { parsedItems = []; }

    const parsedDate   = new Date(estimatedDate);
    const resolvedDate = Number.isNaN(parsedDate.getTime())
      ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      : parsedDate;

    let createdCount = 0;

    for (const entry of parsedItems) {
      const { itemId, itemType, vendorUserId, vendorBindingId, userLocation, quantity } = entry;

      let bindingModel, refField, onBindingModel;
      if      (itemType === "Tape")    { bindingModel = VendorTapeBinding;    refField = "tapeId";    onBindingModel = "VendorTapeBinding"; }
      else continue;

      let binding = null;
      if (vendorBindingId) {
        binding = await bindingModel.findById(vendorBindingId);
        if (binding && String(binding[refField]) !== String(itemId)) binding = null;
      }
      // A coordinator can have this item bound at more than one location now
      // -- disambiguate with the entry's delivery location when we have one.
      if (!binding) binding = await bindingModel.findOne({ [refField]: itemId, vendorUserId, ...(userLocation ? { location: userLocation } : {}) });
      if (!binding) {
        const fallback = await bindingModel.find({ [refField]: itemId }).sort({ createdAt: 1 }).limit(1).lean();
        if (fallback.length) binding = fallback[0];
      }
      if (!binding) continue;

      const po = await PurchaseOrder.create({
        onBindingModel,
        vendorBinding: binding._id,
        vendorUserId:  vendorUserId || binding.vendorUserId,
        onModel:       itemType,
        itemId,
        userLocation,
        quantity:      Number(quantity) || 1,
        poNumber:      String(poNumber || "").trim(),
        estimatedDate: resolvedDate,
        remarks,
        status:        "PENDING",
        createdBy:     req.session?.authUser?.username || "SYSTEM"
      });

      await PurchaseOrderLog.create({
        orderId:     po._id,
        action:      "CREATED",
        poNumber:    po.poNumber,
        quantity:    po.quantity,
        performedBy: req.session?.authUser?.username || "SYSTEM"
      });

      createdCount++;
    }

    if (createdCount > 0) {
      res.locals.auditDescription = `Created ${createdCount} purchase order(s) under PO "${poNumber}"`;
      req.flash("notification", `${createdCount} Purchase Order(s) created successfully under PO #${poNumber}.`);
    } else {
      req.flash("notification", "No Purchase Orders were created. Check vendor bindings for the selected items.");
    }

    res.redirect("/app/purchase/pending");
  } catch (err) {
    console.error("CREATE PURCHASE ORDER MULTI ERROR:", err);
    req.flash("notification", "Error: " + (err.message || "Failed to create Purchase Orders."));
    res.redirect("back");
  }
});

export default router;

