import express from "express";
import { verificationUpdate } from "../../utils/verification.js";
import mongoose from "mongoose";
import { randomUUID } from "crypto";
import Machine from "../../models/system/machine.js";
import Location from "../../models/system/location.js";
import Employee from "../../models/hr/employee_model.js";
import SachikoLabelStock from "../../models/sachiko/sachikoLabelStock.js";
import PendingProduction from "../../models/inventory/pendingProduction.js";
import MaterialStock from "../../models/inventory/materialStock.js";
import MaterialStockLog from "../../models/inventory/materialStockLog.js";
import FacestockStock from "../../models/inventory/facestockStock.js";
import AdhesiveStock from "../../models/inventory/adhesiveStock.js";
import ReleaseLinerStock from "../../models/inventory/releaseLinerStock.js";
import MachineJobCard from "../../models/inventory/machineJobCard.js";
import MaintenanceRequest from "../../models/system/maintenanceRequest.js";
import Counter from "../../models/system/counter.js";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import { deckleTotalRunningMetres, deckleRunningMetersText } from "../../utils/deckleTotals.js";
import { deckleTargetOf } from "../../utils/productionEta.js";
import { computeRawMaterialNeed } from "../../utils/rawMaterialNeed.js";
import { createLimiter, updateLimiter, deleteLimiter } from "../../utils/limiters.js";
import { normalizeLocationName } from "../../utils/locations.js";
import { normalizeRollId, extractScannedRollId, findScannedReel, generateDeckleId, deckleSeriesFor, deckleFySeriesFor, deckleBaseCode, highestDeckleSerial, formatDeckleId, formatDeckleSerial } from "../../utils/rollId.js";
import { escapeRegex } from "../../utils/security.js";
import { requiredLayersFor, LAYER_META, POOL_MODELS, pickStockIds, getEligibleRawMaterials } from "../../utils/labelStockProduction.js";
import { resolveActualLabelStock, resolveLabelStockCombinations } from "../../utils/labelStockVariant.js";
import { buildSlittingQueueRows } from "./slitting.js";
import { advanceShareByBatch } from "../../utils/pendingProduction.js";
// The code every generated id starts with -- the Company master's own
// (utils/companyBrand.js), read live so a rename needs no restart.
import { currentIdPrefix } from "../../utils/companyBrand.js";

const router = express.Router();

// Whether an order has the material it needs actually set aside to start.
// Assign Production stops at recording reel picks per raw-material layer
// (PendingProduction.allottedLayers -- it no longer laminates a Deckle on
// submit, see the doc comment above #rawLayersGrid in
// assignProduction.ejs), so "every layer this SKU's recipe calls for holds
// at least one allotted reel" is what readiness means now. allottedRollIds
// (a finished Deckle roll ticked on) still counts on its own, for orders
// assigned through the older flow. Used by the queue's Start button and by
// both job-card guards, so all three agree.
export function hasStartableAllotment({ rollType, allottedLayers, allottedRollIds }) {
  if (Array.isArray(allottedRollIds) && allottedRollIds.length) return true;
  const required = requiredLayersFor(rollType);
  return required.length > 0 && required.every((key) => pickStockIds(allottedLayers?.[key]).length > 0);
}

// Generate a sequential id of the form `<ID> | <CODE> | 000001`, matching the
// convention already used for Label Stock/Job Card ids in
// routes/sachiko/sachiko_route.js's generateId/previewId.
async function generateId(key, code) {
  const counter = await Counter.findOneAndUpdate(
    { key },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();
  return `${currentIdPrefix()} | ${code} | ${String(counter.seq).padStart(6, "0")}`;
}

export async function previewId(key, code) {
  const counter = await Counter.findOne({ key }).select("seq").lean();
  const nextSeq = Number(counter?.seq || 0) + 1;
  return `${currentIdPrefix()} | ${code} | ${String(nextSeq).padStart(6, "0")}`;
}

const numOrUndef = (value) => {
  if (value === undefined || value === null || String(value).trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

const trim = (value) => String(value ?? "").trim();

// Normalize repeated form fields into an array (single value -> [value]).
const toArray = (value) => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
};

// A browser normally contributes one usage row per physical reel, but POST
// bodies are not a trusted source. Collapse repeated ids before they reach a
// stock mutation so one reel can never receive two competing deductions (or
// two outward logs) in the same job card.
const consolidateUsageRows = (rows, amountKey) => {
  const byStockId = new Map();
  for (const row of rows) {
    const stockId = trim(row?.stockId);
    const amount = Number(row?.[amountKey]);
    if (!stockId) continue;
    const remainingKg = row?.remainingKg !== undefined && Number.isFinite(Number(row.remainingKg)) ? Number(row.remainingKg) : undefined;
    const existing = byStockId.get(stockId);
    if (!existing) {
      byStockId.set(stockId, { stockId, [amountKey]: Number.isFinite(amount) ? amount : 0, remainingKg });
    } else {
      existing[amountKey] = round2(existing[amountKey] + (Number.isFinite(amount) ? amount : 0));
      if (remainingKg !== undefined) existing.remainingKg = remainingKg;
    }
  }
  return [...byStockId.values()].filter((r) => r[amountKey] > 0 || r.remainingKg !== undefined);
};

// ----------------------------------Machine Master---------------------------------->

// Machine Speed (m/min) from the form: blank = not set (the WIP pages use
// their default), otherwise a positive number.
function parseMachineSpeed(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return { value: null };
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return { error: "Machine speed must be a number above 0 (metres per minute)." };
  return { value: n };
}

// This router is mounted on the bare "/app" prefix with no role gate (see
// server.js for why), so every route below carries its own. The machine
// master -- adding, editing and deleting machines -- stays with management;
// the queue and job card pages additionally admit shopfloor operators.
const requireMachineMaster = requireRole(["proprietor", "admin", "hod"]);
const requireMachineFloor = requireRole(["proprietor", "admin", "hod", "operator"]);

router.get("/form/machine", requireMachineMaster, async (req, res) => {
  const [locations, machines] = await Promise.all([
    Location.find().sort({ locationName: 1 }).lean(),
    Machine.find().populate("location").sort({ machineName: 1 }).lean(),
  ]);
  res.render("inventory/masters/machineMaster.ejs", {
    JS: false,
    CSS: "tableDisp.css",
    title: "Machine Master",
    locations,
    machines,
    notification: req.flash("notification"),
  });
});

router.post("/form/machine", requireAuth, requireMachineMaster, createLimiter, async (req, res) => {
  try {
    const machineName = String(req.body.machineName || "").trim().toUpperCase();
    const machineWidth = Number(req.body.machineWidth);
    const locationId = req.body.locationId;
    const machineType = String(req.body.machineType || "").trim();
    const speed = parseMachineSpeed(req.body.speedMpm);

    if (!machineName) {
      return res.status(400).json({ success: false, message: "Machine name is required." });
    }
    if (speed.error) {
      return res.status(400).json({ success: false, message: speed.error });
    }
    if (!machineWidth || machineWidth <= 0) {
      return res.status(400).json({ success: false, message: "Machine width is required." });
    }
    if (!locationId) {
      return res.status(400).json({ success: false, message: "Location is required." });
    }

    const locationDoc = await Location.findById(locationId).lean();
    if (!locationDoc) {
      return res.status(400).json({ success: false, message: "Invalid location" });
    }

    const alreadyExists = await Machine.exists({ machineName, location: locationId });
    if (alreadyExists) {
      return res.status(400).json({ success: false, message: "Machine already exists at this location" });
    }

    await Machine.create({ machineName, machineWidth, location: locationId, machineType, ...(speed.value != null && { speedMpm: speed.value }), ...verificationUpdate(req).set });
    res.locals.auditDescription = `Created machine "${machineName}" at "${locationDoc.locationName}"`;
    req.flash("notification", "Machine created successfully!");
    res.json({ success: true, redirect: "/app/form/machine" });
  } catch (err) {
    console.error(err);
    const msg = err.code === 11000 ? "Machine already exists at this location" : err.message;
    res.status(400).json({ success: false, message: msg });
  }
});

router.get("/api/machines", requireMachineMaster, async (req, res) => {
  const machines = await Machine.distinct("machineName");
  res.json([...new Set(machines.filter(Boolean))].sort());
});

router.put("/api/machines/:id", requireAuth, requireMachineMaster, updateLimiter, async (req, res) => {
  try {
    const machineName = String(req.body.machineName || "").trim().toUpperCase();
    const machineWidth = Number(req.body.machineWidth);
    const locationId = req.body.locationId;
    const machineType = String(req.body.machineType || "").trim();
    const speed = parseMachineSpeed(req.body.speedMpm);

    if (!machineName) {
      return res.status(400).json({ success: false, message: "Machine name is required." });
    }
    if (speed.error) {
      return res.status(400).json({ success: false, message: speed.error });
    }
    if (!machineWidth || machineWidth <= 0) {
      return res.status(400).json({ success: false, message: "Machine width is required." });
    }
    if (!locationId) {
      return res.status(400).json({ success: false, message: "Location is required." });
    }

    const locationDoc = await Location.findById(locationId).lean();
    if (!locationDoc) {
      return res.status(400).json({ success: false, message: "Invalid location." });
    }

    const alreadyExists = await Machine.exists({
      machineName,
      location: locationId,
      _id: { $ne: req.params.id },
    });
    if (alreadyExists) {
      return res.status(400).json({ success: false, message: "Machine already exists at this location." });
    }

    // A blank speed clears it (back to the default), so it is $unset rather
    // than written as null.
    const existing = await Machine.findById(req.params.id).select("verified verifiedBy").lean();
    const vf = verificationUpdate(req, existing);
    const baseSet = { machineName, machineWidth, location: locationId, machineType, ...vf.set };
    const updated = await Machine.findByIdAndUpdate(
      req.params.id,
      speed.value == null
        ? { $set: baseSet, $unset: { speedMpm: 1, ...vf.unset } }
        : { $set: { ...baseSet, speedMpm: speed.value }, ...(Object.keys(vf.unset).length ? { $unset: vf.unset } : {}) },
      { new: true, runValidators: true },
    );

    if (!updated) {
      return res.status(404).json({ success: false, message: "Machine not found." });
    }

    res.locals.auditDescription = `Updated machine "${machineName}" at "${locationDoc.locationName}"`;
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    const msg = err.code === 11000 ? "Machine already exists at this location." : err.message;
    res.status(400).json({ success: false, message: msg });
  }
});

router.delete("/api/machines/:id", requireAuth, requireMachineMaster, deleteLimiter, async (req, res) => {
  try {
    const existing = await Machine.findById(req.params.id).select("machineName").lean();
    await Machine.findByIdAndDelete(req.params.id);
    res.locals.auditDescription = `Deleted machine "${existing?.machineName || req.params.id}"`;
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE MACHINE ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to delete machine." });
  }
});

// ----------------------------------Machine Production Queue---------------------------------->
// Overview of every machine with a pending-order count, linking through to
// each machine's own queue detail page below. ?type=<machineType> narrows the
// list to one machine type (e.g. the Slitting nav's own "Machine Queue" link
// uses ?type=SLITTING to show just S1/S2/S3) -- omitted, every machine shows
// as before.
router.get("/machine/queue", requireMachineFloor, async (req, res) => {
  const typeFilter = String(req.query.type || "").trim().toUpperCase();
  const isSlitting = typeFilter === "SLITTING";
  const machines = await Machine.find(typeFilter ? { machineType: typeFilter } : {})
    .populate("location")
    .sort({ machineName: 1 })
    .lean();

  // Slitting machines are never targeted by Assign Production
  // (PendingProduction.assignedMachineId) -- their queue lives on
  // SlittingJobCard instead, so the two pending-job sources are mutually
  // exclusive per machine type rather than merged.
  const [queuedJobs, slittingJobs] = await Promise.all([
    isSlitting ? [] : buildQueueRows({ assignedMachineId: { $ne: null }, producedAt: null }),
    isSlitting ? buildSlittingQueueRows({}) : [],
  ]);
  const jobsByMachine = new Map();
  queuedJobs.forEach((job) => {
    if (!job.machineId) return;
    if (!jobsByMachine.has(job.machineId)) jobsByMachine.set(job.machineId, []);
    jobsByMachine.get(job.machineId).push({
      _id: job._id,
      productCode: job.productCode,
      quantity: job.quantity,
      rolls: job.rolls,
      balanceRolls: job.balanceRolls,
      producedRolls: job.producedRolls,
      rollIds: job.allottedRollDetails.map((r) => r.rollId).filter(Boolean),
      clientName: job.clientName,
      advance: job.advance,
      // What the laminator list spells out (as the slitting one does): lot,
      // size, cut layout, how far the job has got, and whether it is running
      // on the machine now ("running" = a deckle on the laminator; "setting",
      // "paused" etc. come through liveStatus) plus the material verdict.
      lotNo: job.lotNo,
      paperSize: job.paperSize,
      layoutSummary: job.layoutSummary || "",
      deckleTarget: job.deckleTarget,
      liveStatus: job.liveStatus || "",
      materialStatus: job.materialStatus || "",
    });
  });
  // Every allocated (not yet fully run) Slitting Job Card, folded into the
  // same jobs-per-machine shape the table/card view already renders -- one
  // "job" here is one card, quantity/rolls read off its Deckle count instead
  // of a PendingProduction's roll quantity.
  slittingJobs.forEach((job) => {
    if (!job.machineId) return;
    if (!jobsByMachine.has(job.machineId)) jobsByMachine.set(job.machineId, []);
    jobsByMachine.get(job.machineId).push({
      _id: job._id,
      productCode: job.productCode,
      quantity: job.deckleCount,
      rolls: job.plannedRolls,
      producedRolls: job.producedRolls,
      rollIds: [],
      clientName: job.clientName,
      // What the slitting machine list spells out (grouped by product + cut
      // pattern there): the pattern, the lot, how far the card's Deckles have
      // got and whether one of them is on the slitter right now.
      lotNo: job.lotNo,
      layoutKey: job.layoutKey || "",
      layoutSummary: job.layoutSummary || "",
      deckleCount: job.deckleCount,
      deckleDone: job.deckleDone,
      deckleLeft: job.deckleLeft,
      plannedRolls: job.plannedRolls,
      curing: !!job.curing,
      running: (job.deckles || []).some((d) => d.running),
    });
  });

  // Operator <-> Machine link is by profile code, matching the auto-select on
  // the Assign Production form: an employee's empProfileCode is set to the
  // machine's name they operate. Keyed by code + location too, since the same
  // machine name/code can exist at more than one location and an operator
  // only runs the machine at their own location.
  const operators = await Employee.find(
    { isActive: true, empProfile: "OPERATOR", empProfileCode: { $exists: true, $ne: "" } },
    "empName empProfileCode empLoc",
  ).lean();
  const operatorByProfileCodeAndLocation = new Map(
    operators.map((emp) => [
      `${String(emp.empProfileCode).trim().toUpperCase()}||${normalizeLocationName(emp.empLoc)}`,
      emp.empName,
    ]),
  );

  const rows = machines.map((m) => {
    const key = `${String(m.machineName).trim().toUpperCase()}||${normalizeLocationName(m.location?.locationName)}`;
    const jobs = jobsByMachine.get(String(m._id)) || [];
    return {
      _id: String(m._id),
      machineName: m.machineName,
      machineType: m.machineType || "—",
      locationName: m.location?.locationName || "—",
      operatorName: operatorByProfileCodeAndLocation.get(key) || "—",
      pendingCount: jobs.length,
      // Slitting list only (jobs there are cards): Deckles still to run across
      // them, and whether any one is running.
      deckleLeft: jobs.reduce((n, j) => n + (Number(j.deckleLeft) || 0), 0),
      running: jobs.some((j) => j.running || j.liveStatus === "running"),
      jobs,
    };
  });

  const heading = isSlitting ? "Slitting Machine Queues" : "Machine Queues";
  res.render("inventory/masters/machineQueueList.ejs", {
    title: heading,
    heading,
    CSS: "tableDisp.css",
    JS: false,
    rows,
    isSlitting,
    notification: req.flash("notification"),
  });
});

// ----------------------------------Operator Work Queue---------------------------------->
// An operator's personal worklist: every order assigned to *them* (by
// PendingProduction.operatorId, set at Assign Production), grouped under the
// machine each job sits on. This is where operators land straight after
// login, so it reads their own empObjId off the session rather than a URL
// param.
// Extracted so the JSON operator API's GET /queue can reuse exactly this
// grouping logic instead of re-deriving it -- see routes/api/operatorApi.js.
export async function buildOperatorQueue({ empObjId, empName, empNickName, empLoc }) {
  const operatorObjId = empObjId;

  const rows =
    operatorObjId && mongoose.isValidObjectId(operatorObjId)
      ? await buildQueueRows({ operatorId: operatorObjId, assignedMachineId: { $ne: null }, producedAt: null })
      : [];

  const machineIds = [...new Set(rows.map((r) => r.machineId).filter(Boolean))];
  const machines = machineIds.length
    ? await Machine.find({ _id: { $in: machineIds } }).populate("location").lean()
    : [];
  const machineMap = new Map(machines.map((m) => [String(m._id), m]));

  const groupsMap = new Map();
  rows.forEach((row) => {
    if (!groupsMap.has(row.machineId)) groupsMap.set(row.machineId, []);
    groupsMap.get(row.machineId).push(row);
  });

  const groups = [...groupsMap.entries()]
    .map(([machineId, jobs]) => {
      const m = machineMap.get(machineId);
      return {
        machineId,
        machineName: m?.machineName || "—",
        machineType: m?.machineType || "—",
        locationName: m?.location?.locationName || "—",
        jobs,
      };
    })
    .sort((a, b) => String(a.machineName).localeCompare(String(b.machineName)));

  // Badge on the Maintenance tab: the operator's own tickets still being
  // worked on, so a raised problem stays visible from the queue page too.
  const openMaintenanceCount =
    operatorObjId && mongoose.isValidObjectId(operatorObjId)
      ? await MaintenanceRequest.countDocuments({
          raisedById: operatorObjId,
          status: { $in: ["OPEN", "IN PROGRESS"] },
        })
      : 0;

  // Slitting cards allocated to this operator (routes/system/slitting.js).
  // Kept as its own list rather than merged into `groups`: a slitting job is
  // not a PendingProduction and has none of a lamination row's shape.
  const slittingRows =
    operatorObjId && mongoose.isValidObjectId(operatorObjId)
      ? await buildSlittingQueueRows({ operatorId: operatorObjId })
      : [];

  return {
    operatorName: empName || "",
    // Additive on purpose: the EJS operator queue page keeps rendering
    // operatorName, while the mobile app greets the operator by the short
    // name they actually go by. Falls back to the full name so an operator
    // with no nick name set still reads sensibly.
    operatorNickName: empNickName || empName || "",
    operatorLocation: empLoc || "",
    groups,
    slittingRows,
    totalJobs: rows.length,
    openMaintenanceCount,
  };
}

router.get("/operator/queue", requireRole(["operator"]), async (req, res) => {
  const authUser = req.session?.authUser;
  const queue = await buildOperatorQueue({
    empObjId: authUser?.empObjId,
    empName: authUser?.empName,
    empNickName: authUser?.empNickName,
    empLoc: authUser?.empLoc,
  });

  res.render("inventory/masters/operatorQueue.ejs", {
    title: "Work Queue",
    CSS: "tableDisp.css",
    JS: false,
    ...queue,
    notification: req.flash("notification"),
  });
});

// Shared by the per-machine queue page, the queue overview's card view and the
// job card form's prefill lookup. Takes a match filter rather than a single
// id so the overview can build every machine's jobs in one pass instead of
// one round of queries per machine.
// How far the reels actually allotted to an order get it -- and so how many
// deckles it can run before the machine stops for want of material.
//
// The queue used to answer only "is there a reel on every layer", which says
// yes to a 27 kg remnant standing in for a 770 kg job. An order could sit
// green on this page and stop three deckles in. This works out the same two
// figures Assign Production measures against (utils/rawMaterialNeed.js's kg
// and running metres per layer) and reports the WORST layer, because a deckle
// is every layer at once.
//
// The conversion is the one the allotment page uses, kept in step with it:
//
//     metres = kg x 1e6 / (gsm x width)
//
// at the reel's own GSM and width where it has them, and at the recipe's wet
// GSM over the job's web for an adhesive drum, which has neither.
//
// Returns null when the order isn't described well enough to measure (no
// deckle size or web length yet) -- the caller then shows nothing rather than
// a made-up number.
function computeAllotmentCoverage(p, item, layerAllotments, deckleTarget) {
  const need = computeRawMaterialNeed(p, item);
  if (!need || !layerAllotments.length) return null;
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);

  // One reel can be allotted to more than one layer -- a DOUBLE RELEASE job
  // runs its two passes off one liner reel, and both adhesive coats off one
  // drum (see POST /labels/production/assign/:id). Its stock is then SHARED:
  // counting the whole reel on each layer would say the material goes twice as
  // far as it does, and the queue would show a job as fully covered that stops
  // half way.
  //
  // Shared out in proportion to what each layer NEEDS, not evenly. The two
  // passes are rarely equal -- a second liner over a coated web needs more than
  // the first -- and an even split hands the hungrier layer too little,
  // inventing a shortfall on a reel that in fact covers both (85 kg split
  // 42.5/42.5 reads short against needs of 35.3 and 43.0, though 78.3 is all
  // the job asks for).
  const needKgOf = (key) => {
    const v = Number(need.rows.find((r) => r.key === key)?.needKg);
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  const shareOfReel = new Map();   // "<reelId>|<layerKey>" -> fraction of that reel
  const layersByReel = new Map();
  for (const l of layerAllotments) {
    for (const reel of l.reels) {
      if (!layersByReel.has(reel._id)) layersByReel.set(reel._id, []);
      layersByReel.get(reel._id).push(l.key);
    }
  }
  for (const [reelId, keys] of layersByReel) {
    if (keys.length === 1) { shareOfReel.set(`${reelId}|${keys[0]}`, 1); continue; }
    const needs = keys.map((k) => needKgOf(k));
    const total = needs.reduce((sum, n) => sum + (n || 0), 0);
    keys.forEach((k, i) => {
      // No usable needs to weigh by -- fall back to an even split.
      const fraction = total > 0 && needs[i] != null ? needs[i] / total : 1 / keys.length;
      shareOfReel.set(`${reelId}|${k}`, fraction);
    });
  }

  const layers = layerAllotments.map((l) => {
    const row = need.rows.find((r) => r.key === l.key) || {};
    const needKg = num(row.needKg);
    const needMtrs = num(row.needMtrs);
    const recipeGsm = num(row.mtrsGsm);
    const drumWidth = num(row.mtrsWidthMm);          // set for the adhesive only
    const isDrum = drumWidth != null;

    let gotKg = 0;
    let gotMtrs = 0;
    let unmeasured = 0;
    for (const reel of l.reels) {
      const whole = num(reel.reelMtrs);
      if (whole == null) { unmeasured += 1; continue; }
      // Its share, where the same reel feeds more than one layer of this job.
      const kg = whole * (shareOfReel.get(`${reel._id}|${l.key}`) ?? 1);
      gotKg += kg;
      const gsm = isDrum ? recipeGsm : (num(reel.gsm) ?? recipeGsm);
      const width = isDrum ? drumWidth : num(reel.size);
      if (gsm == null || width == null) { unmeasured += 1; continue; }
      gotMtrs += (kg * 1e6) / (gsm * width);
    }
    gotKg = Math.round(gotKg * 100) / 100;
    gotMtrs = Math.round(gotMtrs * 100) / 100;

    // The lower of the two sides, same as the allotment page's progress bars:
    // enough weight but not enough length (or the other way round) is short.
    //
    // With ONE exception: when not a single reel on the layer can be turned
    // into a length (no GSM recorded, say), the metres side is not a measure
    // of anything -- it is zero for want of an input. Reporting "0 of 15
    // rolls" with 800 kg sitting on the machine is worse than saying nothing,
    // so the weight alone answers and `unmeasured` says why. A layer where
    // only SOME reels are unmeasurable keeps both sides and so reads low,
    // which is the safe direction.
    const allUnmeasured = l.reels.length > 0 && unmeasured === l.reels.length;
    return { key: l.key, label: l.label, unit: l.unit, allocated: l.allocated,
      needKg, needMtrs, gotKg, gotMtrs, unmeasured, allUnmeasured };
  });

  // How far each layer's material goes. Layers that SHARE a reel are answered
  // together: the reel is one lump of stock serving both passes, so the honest
  // question is whether it covers what the two of them add up to -- not
  // whether some invented split of it covers each. Apportioning first is what
  // reports a shortfall on a reel that in fact feeds both (85 kg against needs
  // of 35.3 + 43.0 is enough; no split of it makes both sides land).
  const groupOf = new Map();                 // layerKey -> group id
  const reelSeenIn = new Map();              // reelId -> group id
  layerAllotments.forEach((l, i) => {
    let g = null;
    for (const reel of l.reels) if (reelSeenIn.has(reel._id)) { g = reelSeenIn.get(reel._id); break; }
    if (g == null) g = `g${i}`;
    groupOf.set(l.key, g);
    for (const reel of l.reels) reelSeenIn.set(reel._id, g);
  });
  const groupTotals = new Map();             // group id -> { needKg, needMtrs, gotKg, gotMtrs, allUnmeasured }
  for (const layer of layers) {
    const g = groupOf.get(layer.key);
    const t = groupTotals.get(g) || { needKg: 0, needMtrs: 0, gotKg: 0, gotMtrs: 0, haveKg: false, haveMtrs: false, allUnmeasured: true };
    if (layer.needKg != null) { t.needKg += layer.needKg; t.haveKg = true; }
    if (layer.needMtrs != null) { t.needMtrs += layer.needMtrs; t.haveMtrs = true; }
    t.gotKg += layer.gotKg;
    t.gotMtrs += layer.gotMtrs;
    if (!layer.allUnmeasured) t.allUnmeasured = false;
    groupTotals.set(g, t);
  }
  for (const layer of layers) {
    const t = groupTotals.get(groupOf.get(layer.key));
    const parts = [];
    if (t.haveKg && t.needKg > 0) parts.push(t.gotKg / t.needKg);
    if (t.haveMtrs && t.needMtrs > 0 && !t.allUnmeasured) parts.push(t.gotMtrs / t.needMtrs);
    const covered = parts.length ? Math.min(...parts) : (layer.allocated ? 1 : 0);
    layer.covered = Math.round(Math.max(0, covered) * 10000) / 10000;
    delete layer.allUnmeasured;
  }

  const covered = layers.reduce((m, l) => Math.min(m, l.covered), 1);
  // Deckles, not a percentage: a part-covered job is run until the material
  // runs out, so what the floor needs is how many webs it will get through.
  // Rounded DOWN -- a deckle half fed is a deckle that stops mid-run.
  const target = Number(deckleTarget) > 0 ? Number(deckleTarget) : null;
  const rolls = target != null ? Math.min(target, Math.floor(target * covered + 1e-9)) : null;
  // Which layer is the one holding it back, for the message.
  const worst = layers.reduce((w, l) => (w == null || l.covered < w.covered ? l : w), null);
  return {
    covered: Math.round(covered * 10000) / 10000,
    rolls,
    target,
    shortLabels: layers.filter((l) => l.covered < 0.9999).map((l) => l.label),
    worstLabel: worst && worst.covered < 0.9999 ? worst.label : "",
    layers,
  };
}

export async function buildQueueRows(match) {
  const pending = await PendingProduction.find(match)
    .populate({
      path: "itemId",
      select: "productCode skuCode rollType facestock facestock2 adhesive adhesive2 releaseLiner releaseLiner2",
    })
    .populate({ path: "operatorId", select: "empName" })
    .populate({ path: "helperId", select: "empName" })
    .populate({ path: "userId", select: "clientName userName" })
    .sort({ assignedAt: 1 })
    .lean();

  // The exact rolls ticked on the Assign Production form, so the job card can
  // name the physical rolls rather than just a count.
  const rollIds = pending.flatMap((p) => (Array.isArray(p.allottedRollIds) ? p.allottedRollIds : []));
  const rollDocs = rollIds.length
    ? await MaterialStock.find({ _id: { $in: rollIds } }).select("rollId reelMtrs location").lean()
    : [];
  const rollMap = new Map(rollDocs.map((r) => [String(r._id), r]));

  // Deckles already laminated for these orders. One MaterialStock doc per
  // Production Log row, minted the instant that row's Stop was punched (POST
  // /jobcard/log/produce -> produceDecklesFromLog). PendingProduction
  // .producedRolls only catches up at the final job-card save, so a job that
  // is still running would otherwise show a stale "produced" count here even
  // though the Deckle is already in Semi Finished Stock and on the operator's
  // Logs. Batched per pending id across every order in this match.
  const pendingIds = pending.map((p) => p._id);
  const jobcardDeckleCounts = pendingIds.length
    ? await MaterialStock.aggregate([
        { $match: { producedFor: { $in: pendingIds }, producedVia: "jobcard" } },
        { $group: { _id: "$producedFor", n: { $sum: 1 } } },
      ])
    : [];
  const deckleCountByPending = new Map(
    jobcardDeckleCounts.map((d) => [String(d._id), d.n]),
  );

  // Rolls in each batch that were set in advance of their sales order -- the
  // queue, the job card and the operator app flag the job until the real
  // order takes them over (see absorbAdvanceOrders).
  const advanceByBatch = await advanceShareByBatch(
    pending.filter((p) => p.isDeckleBatch).map((p) => p._id),
  );

  // Raw-material layer picks (Facestock/Adhesive/Release Liner, ...) recorded
  // on the assign form -- kept as { pool, stockIds } on each order (see
  // models/inventory/pendingProduction.js's allottedLayers, one or more
  // reels per layer), so the queue always re-reads the live rollId/reelMtrs
  // off the actual pool doc(s) rather than trusting a snapshot. Batched per
  // pool across every order in this match, same pattern as rollMap above.
  const stockIdsByPool = {};
  for (const p of pending) {
    for (const pick of Object.values(p.allottedLayers || {})) {
      if (!pick?.pool) continue;
      (stockIdsByPool[pick.pool] ||= []).push(...pickStockIds(pick));
    }
  }
  const layerDocMaps = {};
  for (const [pool, ids] of Object.entries(stockIdsByPool)) {
    const { Model } = POOL_MODELS[pool];
    const docs = await Model.find({ _id: { $in: ids } })
      .select("rollId reelMtrs location size gsm make vendorSkuCode")
      .lean();
    layerDocMaps[pool] = new Map(docs.map((d) => [String(d._id), d]));
  }

  return pending.map((p) => {
    const item = p.itemId || {};
    const qty = Number(p.quantity) || 0;
    const balanceQty = Math.max(qty - (Number(p.dispatchedQuantity) || 0), 0);
    // The machine floor laminates one deckle per Production Log row, so the
    // job's target is the DECKLE count -- for a plain order that's its Qty,
    // for a deckle batch it's the planner-entered Deckle Qty (stored on the
    // batch as noOfRolls). A plain order's own noOfRolls is the sales order's
    // finished-roll count, a downstream slitting figure that never drives the
    // machine queue or the job card.
    const deckleTarget = deckleTargetOf(p);
    const rolls = deckleTarget;
    const allottedRolls = p.allottedRolls != null ? p.allottedRolls : null;
    // Rolls this order's Job Cards have already produced -- one per Production
    // Log row, laminated on each Stop punch. Counted live off MaterialStock
    // (deckleCountByPending) rather than the cached p.producedRolls, which
    // only updates at final job-card save; the persisted value is kept as a
    // floor so nothing regresses if a Deckle doc is removed downstream. The
    // balance is what's still to run -- distinct from allotment: allottedRolls
    // / rollsStatus below still track how many reels the office set aside.
    const producedRolls = Math.max(
      Number(p.producedRolls) || 0,
      deckleCountByPending.get(String(p._id)) || 0,
    );
    const balanceRolls =
      rolls == null ? null : Math.max(rolls - producedRolls, 0);

    // Why this job could NOT be sent back to Pending, in the same order the
    // unassign route checks (routes/fairdesk_route.js) -- so the queue's own
    // button is never offered for something the POST would refuse, and says
    // what to do instead when it is greyed.
    const jobcardDeckles = deckleCountByPending.get(String(p._id)) || 0;
    const undoBlockedReason = p.producedAt
      ? "This order is already produced."
      : Number(p.producedRolls) > 0 || jobcardDeckles > 0
        ? "A Deckle has already been produced on this job — open the Job Card and Save Production Entry to close it out."
        : (p.materialSwapLog || []).length
          ? "A reel was already reconciled mid-job — open the Job Card and Save Production Entry to close it out."
          : "";
    const rollsStatus =
      allottedRolls == null || rolls == null
        ? null
        : allottedRolls === rolls
        ? "match"
        : allottedRolls < rolls
        ? "short"
        : "over";

    const allottedRollDetails = (Array.isArray(p.allottedRollIds) ? p.allottedRollIds : [])
      .map((rid) => rollMap.get(String(rid)))
      .filter(Boolean)
      .map((r) => ({
        rollId: r.rollId || "",
        reelMtrs: Number(r.reelMtrs) || 0,
        location: r.location || "",
      }))
      .sort((a, b) => a.reelMtrs - b.reelMtrs || String(a.rollId).localeCompare(String(b.rollId)));

    const runningMetersLabel =
      p.runningMeters != null ? `${Number(p.runningMeters).toLocaleString("en-IN")} kg` : "";

    // Per-layer allocation -- one row per raw-material layer this item's
    // recipe actually calls for (facestock/adhesive/releaseLiner, +2 more
    // for DOUBLE FACESTOCK/DOUBLE RELEASE), so "Facestock allotted, Adhesive
    // not" reads as its own line rather than collapsing into one Deckle
    // count. A layer can hold more than one picked reel (see pickStockIds),
    // so `reels` is a list -- `allocated` is true once at least one of them
    // still resolves to a real doc, which also silently drops any pick whose
    // doc since got deleted/emptied rather than showing it as garbage.
    const layerAllotments = requiredLayersFor(item.rollType).map((key) => {
      const meta = LAYER_META[key];
      const pick = p.allottedLayers?.[key];
      const reels = pick
        ? pickStockIds(pick)
            .map((sid) => layerDocMaps[pick.pool]?.get(sid))
            .filter(Boolean)
            .map((doc) => ({
              _id: String(doc._id),
              rollId: doc.rollId || "",
              reelMtrs: Number(doc.reelMtrs) || 0,
              location: doc.location || "",
              code: doc.vendorSkuCode || "",
              gsm: doc.gsm,
              size: doc.size || "",
              make: doc.make || "",
            }))
        : [];
      return {
        key,
        pool: meta.pool,
        label: meta.label,
        unit: meta.unit,
        allocated: reels.length > 0,
        reels,
      };
    });

    // Row highlight -- green once every raw-material layer this item's
    // recipe calls for is allotted (Facestock/Adhesive/Release Liner, ...),
    // red otherwise. Deliberately NOT the same thing as rollsStatus above
    // (Deckle reels produced vs. noOfRolls ordered): "Produce New Deckle"
    // only ever laminates one physical reel per Assign & Continue submission,
    // so an order needing 2+ rolls reads "short" on rollsStatus after the
    // very first run even though every layer feeding that run is fully
    // allocated -- material allocation, not roll count, is what says this
    // order is actually ready to run.
    // How far the allotted reels actually get this job (null when the order
    // has no deckle size/web length yet to measure against).
    const coverage = computeAllotmentCoverage(p, item, layerAllotments, deckleTarget);

    // THREE states, not two. "short" is a layer with no reel at all -- the
    // job cannot be laminated. "partial" is every layer allotted but not
    // enough of it: the job runs, and stops part way. Reading those two as
    // one "allotted" is what let an order sit green on this page with a 27 kg
    // remnant standing in for a 770 kg job.
    const materialStatus = layerAllotments.length === 0
      ? null
      : !layerAllotments.every((l) => l.allocated)
      ? "short"
      : coverage && coverage.covered < 0.9999
      ? "partial"
      : "match";

    // Same allotment facts as materialStatus above, split per raw-material
    // pool (Facestock/Adhesive/Release Liner) instead of collapsed into one
    // yes/no -- DOUBLE FACESTOCK/DOUBLE RELEASE rollTypes call for 2 layers
    // out of the same pool (facestock+facestock2, or adhesive+adhesive2 /
    // releaseLiner+releaseLiner2), so "one of two allotted" needs its own
    // "partial" state distinct from "none" and "full".
    // ...and "partial" now covers the other way a pool can be half-done: every
    // layer of it allotted, but not enough material on them to run the job
    // out. Both are the same thing to the floor -- this pool will stop the
    // machine before the last deckle -- so they share the badge, and the
    // tooltip says which it is.
    const coverageOf = (key) => (coverage ? coverage.layers.find((l) => l.key === key) : null);
    const poolStatus = (pool) => {
      const layers = layerAllotments.filter((l) => LAYER_META[l.key].pool === pool);
      if (layers.length === 0) return null;
      const allocatedCount = layers.filter((l) => l.allocated).length;
      if (allocatedCount === 0) return "none";
      if (allocatedCount < layers.length) return "partial";
      const under = layers.some((l) => {
        const c = coverageOf(l.key);
        return c && c.covered < 0.9999;
      });
      return under ? "partial" : "full";
    };
    const facestockStatus = poolStatus("facestock");
    const adhesiveStatus = poolStatus("adhesive");
    const releaseStatus = poolStatus("release");

    // The item's recipe, one row per layer it calls for, as
    // { tag: "Facestock" | "Adhesive" | "Release" (+ " 2" for a second
    // layer), code, gsm, size }. Drawn straight off the Label Stock's saved
    // facestock/adhesive/releaseLiner (+ *2) sub-docs -- Adhesive has no
    // size of its own.
    const POOL_TAG = { facestock: "Facestock", adhesive: "Adhesive", release: "Release" };
    const RECIPE_FIELDS = {
      facestock: { code: "facestockVendorSkuCode", gsm: "facestockGsm", size: "facestockSize" },
      adhesive: { code: "adhesiveVendorSkuCode", gsm: "adhesiveGsm", size: null },
      release: { code: "releaseLinerVendorSkuCode", gsm: "releaseLinerGsm", size: "releaseLinerSize" },
    };
    const recipe = requiredLayersFor(item.rollType).map((key) => {
      const meta = LAYER_META[key];
      const spec = item[meta.specField] || {};
      const f = RECIPE_FIELDS[meta.pool];
      return {
        tag: POOL_TAG[meta.pool] + (key.endsWith("2") ? " 2" : ""),
        code: spec[f.code] || "",
        gsm: f.gsm != null && spec[f.gsm] != null ? spec[f.gsm] : "",
        size: f.size ? spec[f.size] || "" : "",
      };
    });

    // The deckle layout(s) this job was planned with on Set Deckle -- one
    // line per cut pattern, its knife widths and how many webs run it, the
    // same `cuts`/`count` shape Assign Production's Material Details card and
    // the Slitting Queue already read (PendingProduction.deckleLayout). A
    // plain order with no batch plan, or a batch saved before layouts existed,
    // has none -- the queue shows "—" rather than guessing one from the
    // order's own width.
    const layoutRows = (Array.isArray(p.deckleLayout) ? p.deckleLayout : [])
      .map((L) => {
        const widths = (Array.isArray(L.cuts) ? L.cuts : [])
          .map((c) => Number(c.width))
          .filter((w) => w > 0);
        return {
          label: widths.map((w) => (w % 1 ? w.toFixed(2) : String(w))).join(" + "),
          count: Math.max(1, Math.floor(Number(L.count) || 1)),
          deckleSize: Number(L.deckleSize) > 0 ? Number(L.deckleSize) : (p.deckleSize ?? null),
        };
      })
      .filter((L) => L.label);
    const layoutSummary = layoutRows
      .map((L) => `${L.label}${L.count > 1 ? ` × ${L.count}` : ""}`)
      .join("  |  ");

    return {
      _id: String(p._id),
      machineId: String(p.assignedMachineId || ""),
      lotNo: p.lotNo || "—",
      // { rolls, orders } of this job still set in advance (no sales order
      // yet), or null. Shipped to the operator app as-is.
      advance: advanceByBatch.get(String(p._id))
        || (p.isAdvance ? { rolls: Number(p.quantity) || 0, orders: 1 } : null),
      productCode: item.productCode || item.skuCode || "—",
      paperSize: p.paperSize || "—",
      rollType: item.rollType || "—",
      deckleSize: p.deckleSize ?? null,
      layoutSummary: layoutSummary || "",
      layoutRows,
      // Both derived rather than read straight off the order: on a batch the
      // stored `runningMeters` (and the text built from it) is a sum of the
      // member orders' per-roll lengths, which counted orders rather than
      // metres -- see utils/deckleTotals.js.
      runningMeters: deckleTotalRunningMetres(p),
      // Free-text run spec set on Deckle Set (e.g. "1000 MTRS OF 5 ROLL") --
      // shown in place of the bare number where present, same as the Deckle
      // Queue / Assign Production pages.
      runningMetersText: deckleRunningMetersText(p) || p.runningMetersText || "",
      // Length of ONE deckle web, as typed into Deckle Set's "Per deckle"
      // input -- distinct from runningMeters above, which is the whole job's
      // finished length across every roll slit off that web (see the field
      // comments on models/inventory/pendingProduction.js). The operator app
      // runs against this one.
      deckleRunningMeters: p.deckleRunningMeters ?? null,
      // Which device is currently running this job, if any. Additive and
      // read only by the operator API's /queue, which turns it into a plain
      // "not you, and who" flag -- the web queue pages ignore it.
      runningOn: p.runningOn || null,
      // The job's hold, if it is paused (see PendingProduction.livePause) --
      // read by the operator API's /queue the same way, so a paused job reads
      // "Paused" on the tablet even when its local draft is gone.
      livePause: p.livePause?.since ? p.livePause : null,
      // Where the job is on the floor, for the machine queue's Status column:
      // "paused" outranks everything (as on the WIP tab), then a deckle on the
      // machine now, then a Job Setting row, then merely played.
      liveStatus: p.livePause?.since
        ? "paused"
        : p.liveRun?.startedAt
          ? "running"
          : p.liveSetting?.startedAt
            ? "setting"
            : p.liveStartedAt
              ? "started"
              : "",
      deckleTarget: deckleTarget != null ? deckleTarget : null,
      rolls: rolls != null ? String(rolls) : "—",
      allottedRolls: allottedRolls != null ? String(allottedRolls) : "—",
      balanceRolls: balanceRolls != null ? String(balanceRolls) : "—",
      producedRolls,
      rollsStatus,
      materialStatus,
      // Everything the "material for N of M rolls" line and the dialog's
      // per-layer table are drawn from. Null when the order isn't described
      // well enough to measure.
      coverage,
      facestockStatus,
      adhesiveStatus,
      releaseStatus,
      // Same rule as hasStartableAllotment(), but off the live-resolved
      // layerAllotments above -- so a pick whose reel doc has since been
      // deleted stops counting here too. A PARTIAL allotment still starts:
      // every layer is on the machine, so the job runs and stops when the
      // material does -- which is a normal way to work, and the queue says how
      // far it will get rather than barring it.
      canStart: materialStatus === "match" || materialStatus === "partial" || allottedRollDetails.length > 0,
      // Whether this job can still be taken off the machine ("undo"), and if
      // not, why. Decided by the same facts POST /labels/production/unassign
      // refuses on, so the button on the queue and the route behind it can't
      // disagree: once the job card has MOVED something -- a Deckle inwarded
      // off a Stop punch, a reel reconciled mid-job, rolls booked as produced
      // -- there is no clean reversal, and the job has to be closed out by
      // saving its Job Card instead. Merely being started (Start punched,
      // reels scanned) is still undoable: nothing has left stock yet.
      canUndo: !undoBlockedReason,
      undoBlockedReason,
      quantity: qty,
      balanceQuantity: balanceQty,
      clientName: p.userId?.clientName || p.userId?.userName || "—",
      operatorName: p.operatorId?.empName || "—",
      helperName: p.helperId?.empName || "—",
      allottedRollDetails,
      layerAllotments,
      recipe,
      materialReference: {
        facestockType: item.facestock?.facestockType || "",
        facestockFamily: item.facestock?.facestockFamily || "",
        adhesiveType: item.adhesive?.adhesiveType || "",
        releaseLinerType: item.releaseLiner?.releaseLinerType || "",
        runningMeters: runningMetersLabel,
        paperSize: p.paperSize || "",
      },
    };
  });
}

// Raw-material reels that ANY other still-open production order has actually
// started drawing on -- scanned + Start punched (liveMaterialInUse), or
// recorded as live-consumed (materialSwapLog, legacy). This is the exact
// "in use right now" signal the WIP Stock page shows (routes/stock/
// wipStock.js). A reel here is strictly off-limits to another job: the same
// physical reel can't feed two machines at once. Distinct from a mere paper
// allotment, which the shop floor is free to override by scanning something
// else.
//
// Returns { byStockId, byRollId } -- both Maps to { lotNo, machineName, pool }
// -- keyed by `${pool}|${stockId}` and by normalized rollId respectively.
export async function reelsInUseElsewhere(exceptPendingId) {
  const byStockId = new Map();
  const byRollId = new Map();

  const filter = { producedAt: null };
  if (mongoose.isValidObjectId(exceptPendingId)) filter._id = { $ne: exceptPendingId };

  const others = await PendingProduction.find(filter)
    .select("lotNo assignedMachineId liveMaterialInUse materialSwapLog")
    .lean();
  if (!others.length) return { byStockId, byRollId };

  const machineIds = [...new Set(others.map((p) => String(p.assignedMachineId || "")).filter(Boolean))];
  const machines = machineIds.length
    ? await Machine.find({ _id: { $in: machineIds } }).select("machineName").lean()
    : [];
  const machineNameById = new Map(machines.map((m) => [String(m._id), m.machineName || ""]));

  // pool -> Set(stockId) -> owning order info
  const stockIdsByPool = { facestock: new Map(), adhesive: new Map(), release: new Map() };
  for (const p of others) {
    const info = { lotNo: p.lotNo || "", machineName: machineNameById.get(String(p.assignedMachineId || "")) || "" };
    for (const [pool, ids] of Object.entries(p.liveMaterialInUse || {})) {
      if (!stockIdsByPool[pool]) continue;
      for (const sid of ids || []) {
        stockIdsByPool[pool].set(String(sid), info);
        byStockId.set(`${pool}|${String(sid)}`, { ...info, pool });
      }
    }
    for (const s of p.materialSwapLog || []) {
      if (!s?.pool || !stockIdsByPool[s.pool] || !s.stockId) continue;
      stockIdsByPool[s.pool].set(String(s.stockId), info);
      byStockId.set(`${s.pool}|${String(s.stockId)}`, { ...info, pool: s.pool });
    }
  }

  // Translate every in-use stockId back to its rollId so a scanned id (which
  // is a rollId, not a stockId) can be checked directly.
  for (const [pool, map] of Object.entries(stockIdsByPool)) {
    if (!map.size) continue;
    const { Model } = POOL_MODELS[pool];
    const reels = await Model.find({ _id: { $in: [...map.keys()] } }).select("rollId").lean();
    for (const r of reels) {
      const key = normalizeRollId(r.rollId);
      if (key) byRollId.set(key, { ...map.get(String(r._id)), pool });
    }
  }

  return { byStockId, byRollId };
}

// Shows every order currently assigned to a machine (via Assign Production)
// that hasn't been produced yet.
// ---------------------------------------------------------------------------
// TEMPORARY: Deckle No Setup. Every Deckle -- laminated at Assign & Continue,
// or made on the shop floor from the web job card or the operator app -- gets
// its id from generateDeckleId(): PRODUCT / FY / <year letter><lot> / <serial>.
// The serial is one running count per product code per FINANCIAL YEAR (it does
// not restart with each lot), exactly as the Lot No's serial is -- and a "-A"/"-B"
// variant counts on its MASTER's series -- so the plant's numbering since the
// year began has to be told to the ERP once, on the master: "the last
// Deckle of C001WB this year was 0123" makes the next one 0124. The counter is
// the single source, so web and app both follow it. Opened as a dialog from a
// queue row (the gear); lists every product like the Lot No Setup does, with
// that job's own product pinned to the top.
// ---------------------------------------------------------------------------
const DECKLE_SETUP_ROLES = ["proprietor", "admin", "hod"];
const MAX_DECKLE_SERIAL = 9999; // the id carries four digits

// Highest Deckle serial of every MASTER product for the current financial year
// (a variant's Deckles count toward its master), in two queries: the FY
// counters, and what Deckles already exist (any lot, either serial width).
// Keys/ids of other years and of the old per-lot counters (one segment longer)
// are ignored.
async function deckleHighestByCode(fy, yearLetter) {
  const idRe = new RegExp(`^(.+)\\/${escapeRegex(fy)}\\/${yearLetter}\\d+\\/(\\d+)$`);
  const [counters, stock] = await Promise.all([
    Counter.find({ key: new RegExp(`^deckleId:.+:${escapeRegex(fy)}:${yearLetter}$`) }).select("key seq forcedAt").lean(),
    MaterialStock.find({ rollId: new RegExp(`\\/${escapeRegex(fy)}\\/${yearLetter}\\d+\\/\\d+$`) }).select("rollId createdAt").lean(),
  ]);
  // Series forced below existing Deckles: only Deckles made since count.
  const forcedAtByCode = new Map();
  for (const c of counters) {
    if (c.forcedAt) forcedAtByCode.set(deckleBaseCode(String(c.key).slice("deckleId:".length, -(`:${fy}:${yearLetter}`.length))), c.forcedAt);
  }
  const byCode = new Map();
  const raise = (code, n) => { if (code && n > (byCode.get(code) || 0)) byCode.set(code, n); };
  for (const c of counters) {
    // deckleId:<item>:<fy>:<letter>
    raise(deckleBaseCode(String(c.key).slice("deckleId:".length, -(`:${fy}:${yearLetter}`.length))), Number(c.seq) || 0);
  }
  for (const d of stock) {
    const m = idRe.exec(String(d.rollId || ""));
    if (!m) continue;
    const base = deckleBaseCode(m[1]);
    const forcedAt = forcedAtByCode.get(base);
    if (forcedAt && d.createdAt && new Date(d.createdAt) < forcedAt) continue;
    raise(base, Number(m[2]));
  }
  return byCode;
}

const deckleSetupRow = (code, highest) => ({
  code,
  highest,
  last: highest ? formatDeckleSerial(highest) : "",
  next: formatDeckleSerial(highest + 1),
});

router.get("/machine/deckle-no-setup", requireAuth, requireMachineFloor, async (req, res) => {
  try {
    if (!DECKLE_SETUP_ROLES.includes(req.session?.authUser?.role)) {
      return res.status(403).json({ error: "You can't change the Deckle No series." });
    }
    // The job the dialog was opened from (optional): its product is pinned to
    // the top and its Lot No is what the live "next Deckle ID" preview shows.
    let job = null;
    if (req.query.pendingId) {
      if (!mongoose.isValidObjectId(req.query.pendingId)) return res.status(400).json({ error: "Invalid order." });
      job = await PendingProduction.findById(req.query.pendingId).select("lotNo itemId").populate("itemId", "productCode").lean();
      if (!job) return res.status(404).json({ error: "Order not found." });
    }
    const allCodes = [...new Set((await SachikoLabelStock.distinct("productCode")).map((c) => String(c).trim().toUpperCase()).filter(Boolean))].sort();
    // A "-A"/"-B" variant is not a product of its own here: it counts on its
    // master's series, so only masters are listed (a variant whose master isn't
    // a product at all stands in for it).
    const known = new Set(allCodes);
    const codes = allCodes.filter((c) => deckleBaseCode(c) === c || !known.has(deckleBaseCode(c)));
    if (!codes.length) return res.json({ fy: "", yearLetter: "", rows: [], current: "", series: "", jobPrefix: "", lotNo: "" });

    const { fy, yearLetter } = deckleFySeriesFor(codes[0]);
    const byCode = await deckleHighestByCode(fy, yearLetter);

    // The job's own code is what its Deckle ids are written under (a variant of
    // the order's product, once produced); the row it sits on is its master.
    const own = String(job?.itemId?.productCode || "").trim().toUpperCase();
    const series = own ? (known.has(deckleBaseCode(own)) ? deckleBaseCode(own) : own) : "";
    const ordered = codes.slice().sort((a, b) => (b === series) - (a === series) || a.localeCompare(b));

    let jobPrefix = "";
    if (own && String(job.lotNo || "").trim()) {
      try { jobPrefix = deckleSeriesFor(own, job.lotNo).prefix; } catch { jobPrefix = ""; }
    }
    return res.json({
      fy,
      yearLetter,
      lotNo: job?.lotNo || "",
      current: own,
      series,
      jobPrefix,
      rows: ordered.map((c) => deckleSetupRow(c, byCode.get(deckleBaseCode(c)) || 0)),
    });
  } catch (err) {
    console.error("DECKLE NO SETUP LOAD ERROR:", err);
    return res.status(500).json({ error: "Failed to load the Deckle No series." });
  }
});

router.post("/machine/deckle-no-setup", requireAuth, requireMachineFloor, updateLimiter, async (req, res) => {
  const refuse = (message, status = 400) => res.status(status).json({ error: message });
  try {
    if (!DECKLE_SETUP_ROLES.includes(req.session?.authUser?.role)) {
      return refuse("You can't change the Deckle No series.", 403);
    }
    const code = String(req.body.productCode ?? "").trim().toUpperCase();
    if (!code) return refuse("Product Code is required.");
    const raw = String(req.body.lastSerial ?? "").trim();
    if (!/^\d{1,4}$/.test(raw)) return refuse("Last Deckle No must be a whole number, e.g. 123 for 0123.");
    const serial = Number(raw);
    if (serial > MAX_DECKLE_SERIAL) return refuse(`Last Deckle No can't be above ${MAX_DECKLE_SERIAL}.`);
    // Only a real product -- never an arbitrary series.
    if (!(await SachikoLabelStock.exists({ productCode: code }))) return refuse(`Unknown Product Code "${code}".`);

    const series = deckleFySeriesFor(code);
    // A variant has no series of its own: it counts on its master's, so that is
    // where it is set (unless the master isn't a product here -- then this is it).
    if (series.baseCode !== code && (await SachikoLabelStock.exists({ productCode: series.baseCode }))) {
      return refuse(`${code} follows the Deckle series of ${series.baseCode}. Set it on ${series.baseCode}.`);
    }
    // Deckles this year can't be un-made: the series may be moved forward to
    // match the paper records, never behind what already exists.
    // `force` overrides that: the counter is set exactly as typed and only
    // Deckles made from now on count toward the floor (Counter.forcedAt).
    const force = ["1", "true", "on"].includes(String(req.body.force ?? "").toLowerCase());
    const highest = await highestDeckleSerial(series);
    if (serial < highest && !force) {
      return refuse(`${code}: Deckle ${formatDeckleSerial(highest)} is already in use this year, so the last Deckle No can't be set below ${highest}. Tick "Force override" to set it anyway.`);
    }
    const forcedBelow = force && serial < highest;

    if (forcedBelow) {
      await Counter.updateOne({ key: series.key }, { $set: { seq: serial, forcedAt: new Date() } }, { upsert: true });
    } else {
      // $max: never lowers, and is atomic against a Deckle being minted at the
      // same moment (the next one then takes serial + 1 or whatever is higher).
      await Counter.updateOne({ key: series.key }, { $max: { seq: serial } }, { upsert: true });
    }

    const row = deckleSetupRow(code, forcedBelow ? serial : Math.max(serial, highest));
    res.locals.auditDescription = `Set last Deckle No of "${series.baseCode}" and its variants (${series.fy}) to ${row.last}${forcedBelow ? ` (FORCED below existing ${formatDeckleSerial(highest)})` : ""}`;
    return res.json({
      ok: true,
      message: `${code}: last Deckle No set to ${row.last}. Next will be ${row.next}.`,
      row,
    });
  } catch (err) {
    console.error("DECKLE NO SETUP ERROR:", err);
    return refuse("Failed to save the last Deckle No.", 500);
  }
});

router.get("/machine/:id/queue", requireMachineFloor, async (req, res) => {
  const fallbackUrl =
    req.session?.authUser?.role === "operator" ? "/app/machine/queue" : "/app/form/machine";

  if (!mongoose.isValidObjectId(req.params.id)) {
    req.flash("notification", "Invalid machine");
    return res.redirect(fallbackUrl);
  }

  const machine = await Machine.findById(req.params.id).populate("location").lean();
  if (!machine) {
    req.flash("notification", "Machine not found");
    return res.redirect(fallbackUrl);
  }

  const [rows, slittingRows] = await Promise.all([
    buildQueueRows({ assignedMachineId: machine._id, producedAt: null }),
    buildSlittingQueueRows({ machineId: machine._id }),
  ]);

  res.render("inventory/masters/machineQueue.ejs", {
    title: `${machine.machineName} Queue`,
    CSS: "tableDisp.css",
    JS: false,
    machine,
    rows,
    slittingRows,
    notification: req.flash("notification"),
  });
});

// ----------------------------------Job Card---------------------------------->

// "Initiate Production" on the machine queue lands here with
// ?pendingId=<PendingProduction _id>, prefilling lot no / product / paper /
// operator / helper from that queue row so the operator only has to fill in
// materials, job setting and the production log by hand.
router.get("/machine/jobcard/form", requireMachineFloor, async (req, res) => {
  const pendingId = req.query.pendingId;
  let machine = null;
  let prefill = null;
  let materialSwapLog = [];

  let eligibleRawStock = { facestock: [], adhesive: [], release: [] };
  if (pendingId && mongoose.isValidObjectId(pendingId)) {
    const pendingDoc = await PendingProduction.findById(pendingId).select("assignedMachineId itemId allottedLayers materialSwapLog").lean();
    materialSwapLog = pendingDoc?.materialSwapLog || [];
    if (pendingDoc?.assignedMachineId) {
      machine = await Machine.findById(pendingDoc.assignedMachineId).lean();
      const rows = await buildQueueRows({ assignedMachineId: pendingDoc.assignedMachineId });
      prefill = rows.find((r) => r._id === String(pendingId)) || null;
      if (pendingDoc.itemId) {
        eligibleRawStock = await getEligibleRawMaterials({
          labelStock: pendingDoc.itemId,
          allottedLayers: pendingDoc.allottedLayers,
        });
      }
    }
  }

  // A pendingId that resolves to nothing -- the order was deleted, sent back
  // to Pending, or the link is simply stale. Without it the form still opens,
  // but every field reads "—" and a save would record a job card belonging to
  // no order and deducting from no reel. Send them back to the queue instead.
  // A form opened with no pendingId at all is left alone: that's the
  // deliberate blank-entry route the POST handler's "new" case covers.
  if (pendingId && !prefill) {
    req.flash("notification", "That production order no longer exists — pick a job from the queue.");
    return res.redirect("/app/machine/queue");
  }

  // Not every raw-material layer has a reel set aside on Assign Production
  // yet -- starting the job card would let the operator scan against
  // material that was never actually reserved, so send them back to the
  // queue instead of opening the form.
  if (prefill && !prefill.canStart) {
    req.flash("notification", "Allot every raw material (Facestock / Adhesive / Release Liner) to this order before starting production.");
    return res.redirect(
      prefill.machineId ? `/app/machine/${prefill.machineId}/queue` : "/app/machine/queue"
    );
  }

  const previewJobCardId = await previewId("machineJobCardId", "JC");

  res.render("inventory/masters/jobCardForm.ejs", {
    title: "Production Entry",
    CSS: false,
    JS: false,
    pendingId: pendingId && mongoose.isValidObjectId(pendingId) ? String(pendingId) : "",
    machine,
    prefill,
    previewJobCardId,
    eligibleRawStock,
    materialSwapLog,
    // One-shot token so a double-submit of this page can't save (or deduct) twice.
    submissionToken: randomUUID(),
    notification: req.flash("notification"),
  });
});

// Metres a single row consumed. The two tables measure it differently: a Job
// Setting row is a counter run, so it's the stop reading minus the start
// reading; a Production Log row is one deckle, which carries the metres it
// made outright.
const consumedMeters = (row) => {
  const made = Number(row?.meters);
  if (Number.isFinite(made) && made > 0) return made;
  const from = Number(row?.mtrs1);
  const to = Number(row?.mtrs2);
  return Number.isFinite(from) && Number.isFinite(to) && to > from ? to - from : 0;
};

const round2 = (n) => Math.round(Number(n) * 100) / 100;

// Draw the running metres recorded on a job card off the facestock reels
// allotted to that job -- both the Job Setting rows (setup wastage) and the
// Production Log rows count. The Roll ID is what the operator scanned off the
// QR label pasted on the reel, so it names exactly one of the job's allotted
// reels (PendingProduction.allottedRollIds -> MaterialStock.rollId) and that
// length comes off its reelMtrs. A reel taken to 0 metres (or below) is
// emptied -- reelMtrs clamped to 0 and quantity set to 0.
//
// Every deduction writes an OUTWARD MaterialStockLog line, the mirror of the
// INWARD one an inward form would write.
export async function consumeAllottedRollMeters({ pendingProductionId, logRows, jobCardId, createdBy }) {
  const result = { deducted: 0, emptied: 0, meters: 0, unmatched: [] };
  if (!pendingProductionId || !Array.isArray(logRows) || logRows.length === 0) return result;

  const pending = await PendingProduction.findById(pendingProductionId).select("allottedRollIds").lean();
  const rollIds = Array.isArray(pending?.allottedRollIds) ? pending.allottedRollIds : [];

  const reels = rollIds.length
    ? await MaterialStock.find({ _id: { $in: rollIds } })
        .select("rollId material location quantity reelMtrs rate")
        .lean()
    : [];
  const reelByRollId = new Map();
  reels.forEach((reel) => {
    const key = normalizeRollId(reel.rollId);
    if (key && !reelByRollId.has(key)) reelByRollId.set(key, reel);
  });

  // Sum the metres consumed per reel first, so a reel named on more than one
  // row (across job setting and the production log) is written back once.
  const usedByReelId = new Map();
  for (const row of logRows) {
    const used = consumedMeters(row);
    if (used <= 0) continue;
    const key = extractScannedRollId(row.rollId);
    const reel = key ? reelByRollId.get(key) : null;
    if (!reel) {
      if (key) result.unmatched.push(trim(row.rollId));
      continue;
    }
    usedByReelId.set(String(reel._id), (usedByReelId.get(String(reel._id)) || 0) + used);
  }
  if (!usedByReelId.size) return result;

  const reelById = new Map(reels.map((r) => [String(r._id), r]));

  const balanceKey = (reel) => `${String(reel.material)}||${reel.location}`;
  const balances = new Map();
  for (const reelId of usedByReelId.keys()) {
    const reel = reelById.get(reelId);
    const key = balanceKey(reel);
    if (balances.has(key)) continue;
    const bal = await MaterialStock.aggregate([
      { $match: { material: new mongoose.Types.ObjectId(String(reel.material)), location: reel.location } },
      { $group: { _id: null, qty: { $sum: "$quantity" } } },
    ]);
    balances.set(key, bal[0]?.qty || 0);
  }

  for (const [reelId, used] of usedByReelId) {
    const reel = reelById.get(reelId);
    const remaining = round2((Number(reel.reelMtrs) || 0) - used);
    const emptied = remaining <= 0;

    await MaterialStock.updateOne(
      { _id: reelId },
      emptied ? { $set: { reelMtrs: 0, quantity: 0 } } : { $set: { reelMtrs: remaining } },
    );

    const key = balanceKey(reel);
    const openingStock = balances.get(key) ?? 0;
    const rollsOut = emptied ? Number(reel.quantity) || 0 : 0;
    const closingStock = openingStock - rollsOut;
    balances.set(key, closingStock);

    await MaterialStockLog.create({
      material: reel.material,
      location: reel.location,
      openingStock,
      quantity: rollsOut,
      reelMtrs: round2(used),
      rate: reel.rate,
      rollId: reel.rollId,
      closingStock,
      type: "OUTWARD",
      source: "SYSTEM",
      remarks: `${jobCardId ? `${jobCardId}: ` : ""}${round2(used)} mtrs consumed${emptied ? " — reel emptied" : ""}`,
      createdBy: createdBy || "SYSTEM",
    });

    result.deducted += 1;
    result.meters = round2(result.meters + used);
    if (emptied) result.emptied += 1;
  }
  return result;
}

// Deducts the operator-reported usage from each Facestock/Adhesive/Release
// Liner reel/drum recorded in the Material Stock dialog. Directly updates the
// stock balance to the remaining kg entered by the operator.
export async function consumePoolUsage({ pool, rows, jobCardId, createdBy }) {
  const result = { deducted: 0, emptied: 0, used: 0, rows: [], limited: [] };
  if (!Array.isArray(rows) || rows.length === 0) return result;

  const { Model, LogModel } = POOL_MODELS[pool];
  const unitLabel = "kg";
  const requestedByStockId = new Map();
  for (const row of rows) {
    const stockId = trim(row?.stockId);
    if (!stockId) continue;
    const remainingKg = row?.remainingKg !== undefined && row?.remainingKg !== null && Number.isFinite(Number(row.remainingKg))
      ? round2(Number(row.remainingKg))
      : undefined;
    const used = round2(Number(row?.used) || 0);
    requestedByStockId.set(stockId, { remainingKg, used });
  }
  const stockIds = [...requestedByStockId.keys()];
  const reels = stockIds.length
    ? await Model.find({ _id: { $in: stockIds } }).select("rollId type location quantity reelMtrs rate").lean()
    : [];
  const reelById = new Map(reels.map((d) => [String(d._id), d]));

  for (const [stockId, reqData] of requestedByStockId) {
    const reel = reelById.get(stockId);
    if (!reel) continue;

    const available = Math.max(round2(Number(reel.reelMtrs) || 0), 0);
    let newRemaining;
    let used;

    if (reqData.remainingKg !== undefined) {
      newRemaining = Math.max(0, Math.min(reqData.remainingKg, available));
      used = round2(available - newRemaining);
    } else {
      used = Math.min(Math.max(0, reqData.used || 0), available);
      newRemaining = round2(available - used);
    }

    const emptied = newRemaining <= 0;

    const bal = await Model.aggregate([
      { $match: { type: reel.type, location: reel.location } },
      { $group: { _id: null, qty: { $sum: "$quantity" } } },
    ]);
    const openingStock = bal[0]?.qty || 0;
    const rollsOut = emptied ? Number(reel.quantity) || 0 : 0;
    const closingStock = openingStock - rollsOut;

    // Directly update the stock to the remaining kg (new value in stock)
    await Model.updateOne(
      { _id: reel._id },
      emptied ? { $set: { reelMtrs: 0, quantity: 0 } } : { $set: { reelMtrs: newRemaining } },
    );

    if (used > 0 || emptied) {
      await LogModel.create({
        location: reel.location,
        openingStock,
        quantity: rollsOut,
        closingStock,
        reelMtrs: used,
        rate: reel.rate,
        rollId: reel.rollId,
        type: "OUTWARD",
        source: "SYSTEM",
        remarks: `${jobCardId ? `${jobCardId}: ` : ""}${used} ${unitLabel} consumed (${newRemaining} ${unitLabel} remaining in stock)${emptied ? " — reel emptied" : ""}`,
        createdBy: createdBy || "SYSTEM",
      });
    }

    result.deducted += 1;
    result.used = round2(result.used + used);
    if (emptied) result.emptied += 1;
    result.rows.push({ stockId: reel._id, rollId: reel.rollId, used, remainingKg: newRemaining });
  }
  return result;
}

// This machine IS the laminator -- every Production Log row is one finished
// Deckle coming off the run right now (the model's own doc comment already
// says as much: "Production Log: one row per deckle produced"), not a
// pre-existing reel merely being drawn down. Raw material for this job was
// already reserved at Assign Production and already deducted elsewhere
// (the older allottedRollIds flow via consumeAllottedRollMeters; the newer
// layerAllotments flow -- Facestock/Adhesive/Release Liner alike -- via
// consumePoolUsage above) -- this only creates the finished-goods side: one
// MaterialStock (Deckle) + one
// INWARD MaterialStockLog per row, at the location the job's own raw
// material sits at. Mirrors produceDeckle's own inward-write half
// (utils/labelStockProduction.js) without repeating its raw-material
// deduction half, since that already happened through a different path here.
//
// A row with no `meters` (Job Setting-style rows, or a Production Log row
// still mid-entry) produces nothing -- there's no length to inward. The
// generated Deckle ID is written back onto the row it came from (by index)
// so the saved job card records which Deckle each row actually became.
export async function produceDecklesFromLog({ pendingDoc, productionLog, jobSetting = [], facestockUsage = [], adhesiveUsage = [], releaseUsage = [], location, jobCardId, createdBy }) {
  const result = { rows: [], rowMeta: [], created: 0, meters: 0, resolvedProductCode: null };
  const labelStockId = pendingDoc?.itemId?._id || pendingDoc?.itemId;
  if (!labelStockId || !location || !Array.isArray(productionLog) || !productionLog.length) return result;

  const baseLabelStock = await SachikoLabelStock.findById(labelStockId).lean();
  if (!baseLabelStock) return result;

  const allFsRollIds = new Set();
  const allAdRollIds = new Set();
  const allRlRollIds = new Set();
  const allFsStockIds = new Set();
  const allAdStockIds = new Set();
  const allRlStockIds = new Set();

  const collectPoolId = (str, rollSet) => {
    const key = extractScannedRollId(str);
    if (key) rollSet.add(key);
  };

  const poolRollSet = { facestock: allFsRollIds, adhesive: allAdRollIds, release: allRlRollIds };
  [...jobSetting, ...productionLog].forEach((r) => {
    collectPoolId(r.fsRollId, allFsRollIds);
    collectPoolId(r.adRollId, allAdRollIds);
    collectPoolId(r.rlRollId, allRlRollIds);
    // Reels a deckle used that aren't its "current" one -- a mid-run swap
    // (see the Materials Mounted strip). Load them into the maps below too.
    (Array.isArray(r.materialsUsed) ? r.materialsUsed : []).forEach((m) => {
      if (poolRollSet[m?.pool]) collectPoolId(m.rollId, poolRollSet[m.pool]);
    });
  });

  (facestockUsage || []).forEach((u) => { if (u.stockId) allFsStockIds.add(String(u.stockId)); if (u.rollId) collectPoolId(u.rollId, allFsRollIds); });
  (adhesiveUsage || []).forEach((u) => { if (u.stockId) allAdStockIds.add(String(u.stockId)); if (u.rollId) collectPoolId(u.rollId, allAdRollIds); });
  (releaseUsage || []).forEach((u) => { if (u.stockId) allRlStockIds.add(String(u.stockId)); if (u.rollId) collectPoolId(u.rollId, allRlRollIds); });

  if (pendingDoc?.allottedLayers) {
    pickStockIds(pendingDoc.allottedLayers.facestock).forEach((id) => allFsStockIds.add(String(id)));
    pickStockIds(pendingDoc.allottedLayers.facestock2).forEach((id) => allFsStockIds.add(String(id)));
    pickStockIds(pendingDoc.allottedLayers.adhesive).forEach((id) => allAdStockIds.add(String(id)));
    pickStockIds(pendingDoc.allottedLayers.adhesive2).forEach((id) => allAdStockIds.add(String(id)));
    pickStockIds(pendingDoc.allottedLayers.releaseLiner).forEach((id) => allRlStockIds.add(String(id)));
    pickStockIds(pendingDoc.allottedLayers.releaseLiner2).forEach((id) => allRlStockIds.add(String(id)));
  }

  const fsQuery = [];
  if (allFsStockIds.size) fsQuery.push({ _id: { $in: [...allFsStockIds] } });
  if (allFsRollIds.size) fsQuery.push({ rollId: { $in: [...allFsRollIds] } });
  const fsDocs = fsQuery.length ? await FacestockStock.find({ $or: fsQuery }).lean() : [];
  const fsByRollId = new Map();
  fsDocs.forEach((d) => {
    const k = normalizeRollId(d.rollId);
    if (k) fsByRollId.set(k, d);
    fsByRollId.set(String(d._id), d);
  });

  const adQuery = [];
  if (allAdStockIds.size) adQuery.push({ _id: { $in: [...allAdStockIds] } });
  if (allAdRollIds.size) adQuery.push({ rollId: { $in: [...allAdRollIds] } });
  const adDocs = adQuery.length ? await AdhesiveStock.find({ $or: adQuery }).lean() : [];
  const adByRollId = new Map();
  adDocs.forEach((d) => {
    const k = normalizeRollId(d.rollId);
    if (k) adByRollId.set(k, d);
    adByRollId.set(String(d._id), d);
  });

  const rlQuery = [];
  if (allRlStockIds.size) rlQuery.push({ _id: { $in: [...allRlStockIds] } });
  if (allRlRollIds.size) rlQuery.push({ rollId: { $in: [...allRlRollIds] } });
  const rlDocs = rlQuery.length ? await ReleaseLinerStock.find({ $or: rlQuery }).lean() : [];
  const rlByRollId = new Map();
  rlDocs.forEach((d) => {
    const k = normalizeRollId(d.rollId);
    if (k) rlByRollId.set(k, d);
    rlByRollId.set(String(d._id), d);
  });

  // Track / create all combinations of materials used in this job (same method as Assign Production)
  const pickedLayers = [];
  if (fsDocs.length) pickedLayers.push({ layerKey: "facestock", pool: "facestock", reels: fsDocs });
  if (adDocs.length) pickedLayers.push({ layerKey: "adhesive", pool: "adhesive", reels: adDocs });
  if (rlDocs.length) pickedLayers.push({ layerKey: "releaseLiner", pool: "release", reels: rlDocs });
  if (pickedLayers.length) {
    try {
      await resolveLabelStockCombinations(baseLabelStock, pickedLayers);
    } catch (comboErr) {
      console.error("RESOLVE COMBINATIONS ERROR:", comboErr);
    }
  }

  const poolMap = { facestock: fsByRollId, adhesive: adByRollId, release: rlByRollId };

  let lastFsReel = fsDocs[0] || null;
  let lastAdReel = adDocs[0] || null;
  let lastRlReel = rlDocs[0] || null;

  // Every reel that fed this deckle. Prefers the row's own materialsUsed list
  // (the strip records each reel mounted during the row's run, so a mid-run
  // facestock swap keeps both), and falls back to the single "current" reel
  // per pool when the client didn't send a list.
  const buildSourceReels = (row) => {
    const out = [];
    const seen = new Set();
    const add = (pool, reel, rawRollId) => {
      const doc = reel
        || poolMap[pool]?.get(extractScannedRollId(rawRollId))
        || (rawRollId && poolMap[pool]?.get(String(rawRollId)));
      const rollId = doc?.rollId || trim(rawRollId);
      const key = `${pool}|${normalizeRollId(rollId)}`;
      if (!rollId || seen.has(key)) return;
      seen.add(key);
      out.push({ pool, stockId: doc?._id ? String(doc._id) : undefined, rollId });
    };
    (Array.isArray(row.materialsUsed) ? row.materialsUsed : []).forEach((m) => {
      if (m?.pool && (m.rollId || m.stockId)) add(m.pool, null, m.rollId || m.stockId);
    });
    if (!out.length) {
      add("facestock", lastFsReel);
      add("adhesive", lastAdReel);
      add("release", lastRlReel);
    }
    return out;
  };

  const reelSummary = (reels) => {
    const byPool = { facestock: [], adhesive: [], release: [] };
    reels.forEach((r) => { if (byPool[r.pool]) byPool[r.pool].push(r.rollId); });
    return [
      byPool.facestock.length ? `FS ${byPool.facestock.join(", ")}` : "",
      byPool.adhesive.length ? `AD ${byPool.adhesive.join(", ")}` : "",
      byPool.release.length ? `REL ${byPool.release.join(", ")}` : "",
    ].filter(Boolean).join("; ");
  };

  for (let i = 0; i < productionLog.length; i++) {
    const row = productionLog[i];
    const meters = round2(Number(row.meters) || 0);
    if (meters <= 0) {
      result.rows.push(null);
      result.rowMeta.push(null);
      continue;
    }

    const fsKey = extractScannedRollId(row.fsRollId);
    if (fsKey && fsByRollId.has(fsKey)) lastFsReel = fsByRollId.get(fsKey);

    const adKey = extractScannedRollId(row.adRollId);
    if (adKey && adByRollId.has(adKey)) lastAdReel = adByRollId.get(adKey);

    const rlKey = extractScannedRollId(row.rlRollId);
    if (rlKey && rlByRollId.has(rlKey)) lastRlReel = rlByRollId.get(rlKey);

    const resolvedLayers = [
      lastFsReel ? { layerKey: "facestock", meta: LAYER_META.facestock, reel: lastFsReel } : null,
      lastAdReel ? { layerKey: "adhesive", meta: LAYER_META.adhesive, reel: lastAdReel } : null,
      lastRlReel ? { layerKey: "releaseLiner", meta: LAYER_META.releaseLiner, reel: lastRlReel } : null,
    ].filter(Boolean);

    let actualLabelStock = baseLabelStock;
    if (resolvedLayers.length) {
      try {
        actualLabelStock = await resolveActualLabelStock(baseLabelStock, resolvedLayers);
      } catch (variantErr) {
        console.error("VARIANT RESOLUTION ERROR ON ROW:", variantErr);
        actualLabelStock = baseLabelStock;
      }
    }

    const sourceReels = buildSourceReels(row);
    const rowProductCode = actualLabelStock?.productCode || baseLabelStock.productCode || "";

    // Already inwarded to Semi-Finished Stock the instant its Stop was punched
    // (POST /machine/jobcard/log/produce). Don't re-produce it -- but the
    // variant + reel trace above are still resolved so the saved job card row
    // carries them. Two ways a row can already be produced:
    //   - the client marked it so (alreadyProduced + the system deckleId it
    //     got back), or
    //   - it isn't marked, but a Deckle carrying this row's idempotency token
    //     exists anyway -- the instant call committed it and only its response
    //     was lost. Match on the token and reuse it rather than minting a
    //     second Deckle for the same physical roll.
    let existingDeckleId = row.alreadyProduced && row.deckleId ? row.deckleId : "";
    // Carried alongside existingDeckleId so rowMeta.stockId (see below -- used
    // by the mobile app's Deckle print button) is populated on every replay
    // path, not just a fresh create.
    let existingStockId = null;
    if (!existingDeckleId && row.rowToken) {
      const priorDeckle = await MaterialStock.findOne({ productionRowToken: row.rowToken })
        .select("rollId")
        .lean();
      if (priorDeckle) {
        existingDeckleId = priorDeckle.rollId;
        existingStockId = priorDeckle._id;
      }
    }
    if (existingDeckleId) {
      if (!existingStockId) {
        const doc = await MaterialStock.findOne({ rollId: existingDeckleId }).select("_id").lean();
        existingStockId = doc?._id || null;
      }
      result.rows.push(existingDeckleId);
      result.rowMeta.push({
        productCode: rowProductCode,
        sourceReels,
        stockId: existingStockId ? String(existingStockId) : null,
      });
      if (rowProductCode) result.resolvedProductCode = rowProductCode;
      continue;
    }

    const deckleId = await generateDeckleId(rowProductCode || baseLabelStock.skuCode, pendingDoc.lotNo);

    // The job card records the status of both webs. Preserve the actual
    // selected value(s) on this particular finished reel for its SOFT.prn
    // JOINTS field, while omitting it completely for a clean run.
    const joints = [...new Set([row.face?.joint, row.release?.joint]
      .map((value) => trim(value))
      .filter(Boolean))]
      .join(" / ") || undefined;

    const bal = await MaterialStock.aggregate([
      { $match: { material: actualLabelStock._id, location } },
      { $group: { _id: null, qty: { $sum: "$quantity" } } },
    ]);
    const openingStock = bal[0]?.qty || 0;

    let createdDeckle;
    try {
      createdDeckle = await MaterialStock.create({
        material: actualLabelStock._id,
        location,
        quantity: 1,
        reelMtrs: meters,
        size: trim(pendingDoc.paperSize),
        joints,
        lotNo: trim(pendingDoc.lotNo),
        rollId: deckleId,
        producedFor: pendingDoc._id,
        sourceReels,
        productionRowToken: row.rowToken || undefined,
        producedVia: "jobcard",
        productionTime: {
          startTime: trim(row.time?.startTime) || undefined,
          endTime: trim(row.time?.endTime) || undefined,
        },
        // Per web, for the WIP tab's Live Status until the card is saved
        // (`joints` above is one merged label, for the sticker).
        productionJoints: {
          face: {
            joint: trim(row.face?.joint) || undefined,
            mtr: numOrUndef(row.face?.mtr),
          },
          release: {
            joint: trim(row.release?.joint) || undefined,
            mtr: numOrUndef(row.release?.mtr),
          },
        },
      });
    } catch (createErr) {
      // Lost the race to a concurrent instant-produce of this same row (its
      // Deckle just landed under the shared idempotency token). Reuse it --
      // the generated deckleId above is simply abandoned, same as any other
      // failed create.
      if (createErr?.code === 11000 && row.rowToken) {
        const priorDeckle = await MaterialStock.findOne({ productionRowToken: row.rowToken })
          .select("rollId")
          .lean();
        if (priorDeckle) {
          result.rows.push(priorDeckle.rollId);
          result.rowMeta.push({ productCode: rowProductCode, sourceReels, stockId: String(priorDeckle._id) });
          if (rowProductCode) result.resolvedProductCode = rowProductCode;
          continue;
        }
      }
      throw createErr;
    }

    const traceNote = `as ${rowProductCode || baseLabelStock.productCode}${sourceReels.length ? ` from ${reelSummary(sourceReels)}` : ""}`;
    await MaterialStockLog.create({
      material: actualLabelStock._id,
      location,
      openingStock,
      quantity: 1,
      closingStock: openingStock + 1,
      reelMtrs: meters,
      rollId: deckleId,
      type: "INWARD",
      source: "SYSTEM",
      remarks: `${jobCardId ? `${jobCardId}: ` : ""}Deckle produced from Production Log row ${i + 1} — ${traceNote}`,
      createdBy: createdBy || "SYSTEM",
    });

    result.rows.push(deckleId);
    result.rowMeta.push({ productCode: rowProductCode, sourceReels, stockId: String(createdDeckle._id) });
    result.created += 1;
    result.meters = round2(result.meters + meters);
    if (rowProductCode) result.resolvedProductCode = rowProductCode;
  }
  return result;
}

// Where a Deckle produced for this order gets inwarded -- the same location
// its own raw material already sits at (Assign Production's reel pickers are
// scoped to one location per order, so every layer agrees anyway). Facestock
// is checked first since every roll type calls for it; release liner is the
// fallback for the one hypothetical recipe that somehow doesn't (there isn't
// one today, but nothing enforces it). Shared by the final bulk save below
// and the per-row instant-produce endpoint right after it.
export async function resolveDeckleLocation(pendingDoc) {
  if (!pendingDoc?.allottedLayers) return "";
  for (const key of ["facestock", "facestock2", "adhesive", "adhesive2", "releaseLiner", "releaseLiner2"]) {
    const pick = pendingDoc.allottedLayers[key];
    const sids = pickStockIds(pick);
    if (!pick?.pool || !sids.length) continue;
    const { Model } = POOL_MODELS[pick.pool];
    const doc = await Model.findById(sids[0]).select("location").lean();
    if (doc?.location) return doc.location;
  }
  return "";
}

// The primary recipe layer key for each raw-material pool.
const POOL_PRIMARY_LAYER = { facestock: "facestock", adhesive: "adhesive", release: "releaseLiner" };

// Resolve which Label Stock the CURRENTLY MOUNTED combination (the reel just
// scanned for `pool` + the reels already on for the other pools) WOULD
// produce -- its own SKU, or a "-A"/"-B"/... Product Code variant when the
// combination differs from the order's SKU spec on a soft field (vendor,
// size, ...). Read-only: resolveActualLabelStock is called with dryRun, so
// this scan-time check (fires on every scan/blur) never writes a variant
// row -- that happens for real at produce time (produceDecklesFromLog).
//
// Deliberately only resolves once EVERY pool the recipe needs has a reel --
// a half-scanned combination (facestock in, adhesive/release still from the
// SKU spec) isn't a real combination to report. Until the mount is complete
// the caller just shows "pending".
export async function resolveScannedCombinationVariant({ baseLabelStock, pool, reel, mounted }) {
  if (!baseLabelStock) return null;

  const wanted = { facestock: null, adhesive: null, release: null };
  wanted[pool] = reel;

  const codeToPool = { fs: "facestock", ad: "adhesive", rl: "release" };
  for (const [code, otherPool] of Object.entries(codeToPool)) {
    if (otherPool === pool) continue;
    const rid = extractScannedRollId(mounted?.[code]);
    if (!rid) continue;
    wanted[otherPool] = await POOL_MODELS[otherPool].Model.findOne({ rollId: rid }).lean();
  }

  const requiredPools = [...new Set(
    requiredLayersFor(baseLabelStock.rollType).map((k) => LAYER_META[k]?.pool).filter(Boolean),
  )];
  const complete = requiredPools.every((p) => wanted[p]);
  if (!complete) {
    return { pending: true, baseProductCode: baseLabelStock.productCode };
  }

  const resolvedLayers = requiredPools
    .filter((p) => wanted[p])
    .map((p) => ({ layerKey: POOL_PRIMARY_LAYER[p], meta: LAYER_META[POOL_PRIMARY_LAYER[p]], reel: wanted[p] }));

  // dryRun: this is a scan-time validation check that fires on every scan and
  // blur -- it must not write a variant Product Code row. The real row is
  // minted later, at produce time (produceDecklesFromLog).
  const actual = await resolveActualLabelStock(baseLabelStock, resolvedLayers, { dryRun: true });
  const isVariant = Boolean(actual.__dryRun) || String(actual._id) !== String(baseLabelStock._id);
  return {
    productCode: actual.productCode || baseLabelStock.productCode,
    skuCode: actual.skuCode || baseLabelStock.skuCode,
    baseProductCode: baseLabelStock.productCode,
    isVariant,
  };
}

// Validates one raw-material reel the operator has scanned/typed into the
// Materials Mounted strip, BEFORE it's committed to anything. The shop floor
// is free to run whatever reel physically matches the recipe -- the office
// allotment is only a name here -- but:
//   - the reel has to match this order's recipe on the must-match fields
//     (getEligibleRawMaterials' validStockIds).
//   - the reel must not already be WIP on another still-open job -- one
//     physical reel can't feed two machines (HARD stop / blocking alert).
//   - the resulting facestock+adhesive+release combination is resolved to the
//     Product Code it would produce (read-only -- the "-A"/"-B" variant row is
//     minted for real only at produce time, not by this check).
router.post("/machine/jobcard/material/check", requireAuth, requireMachineFloor, createLimiter, async (req, res) => {
  try {
    const { pendingId, pool, rollId, mounted } = req.body || {};
    if (!mongoose.isValidObjectId(pendingId)) {
      return res.status(400).json({ ok: false, code: "bad-request" });
    }
    if (!POOL_MODELS[pool]) {
      return res.status(400).json({ ok: false, code: "bad-request" });
    }
    if (!String(rollId ?? "").trim()) return res.json({ ok: false, code: "unknown" });

    const pendingDoc = await PendingProduction.findById(pendingId)
      .select("itemId allottedLayers")
      .lean();
    if (!pendingDoc) return res.status(404).json({ ok: false, code: "no-order" });

    // Resolved against stock itself rather than parsed down to one id first:
    // a label's QR ends with the Roll ID glued straight onto the box in front
    // of it, so only stock can say where the id starts. See findScannedReel in
    // utils/rollId.js.
    const reel = await findScannedReel(POOL_MODELS[pool].Model, rollId);
    if (!reel) return res.json({ ok: false, code: "unknown" });

    // A reel with nothing physically left can't be run, allotted or not --
    // block the scan outright rather than mounting an empty reel the operator
    // would just have to "Change" straight back out again. getEligibleRawMaterials
    // still lists an allotted-but-empty reel below (so it can be reconciled via
    // "Change"), so this can't be caught by the recipe-match check that follows.
    if ((Number(reel.quantity) || 0) <= 0 || (Number(reel.reelMtrs) || 0) <= 0) {
      return res.json({ ok: false, code: "empty", rollId: reel.rollId });
    }

    // A reel inwarded without its purchase invoice is not fit to run: the
    // invoice is what ties the physical reel to what was actually bought, and
    // it is the LOT NO printed on its own label (see utils/facestockRollLabel.js
    // and its siblings), so a blank one also means the sticker on the reel
    // carries no lot. Refused before the recipe and WIP checks below -- those
    // describe a reel that is fine but wrong for this order or busy right now,
    // whereas this one must not be consumed on any order until the office
    // fills the invoice in. invoiceNo is an optional String on all three raw
    // pools, so it can be absent, null or "".
    if (!String(reel.invoiceNo || "").trim()) {
      return res.json({ ok: false, code: "no-invoice", rollId: reel.rollId });
    }

    const eligible = await getEligibleRawMaterials({
      labelStock: pendingDoc.itemId,
      allottedLayers: pendingDoc.allottedLayers,
    });
    const matchesRecipe = eligible.validStockIds?.[pool]?.has(String(reel._id));

    const { byStockId } = await reelsInUseElsewhere(pendingId);
    const wip = byStockId.get(`${pool}|${String(reel._id)}`);
    if (wip) {
      return res.json({
        ok: false,
        code: "wip",
        rollId: reel.rollId,
        lotNo: wip.lotNo,
        machineName: wip.machineName,
      });
    }

    if (!matchesRecipe) {
      return res.json({ ok: false, code: "mismatch", rollId: reel.rollId });
    }

    const allotted = new Set(
      Object.values(pendingDoc.allottedLayers || {})
        .filter((pick) => pick?.pool === pool)
        .flatMap((pick) => pickStockIds(pick).map(String)),
    );

    let variant = null;
    try {
      const baseLabelStock = await SachikoLabelStock.findById(pendingDoc.itemId).lean();
      variant = await resolveScannedCombinationVariant({ baseLabelStock, pool, reel, mounted });
    } catch (variantErr) {
      console.error("SCAN VARIANT RESOLUTION ERROR:", variantErr);
    }

    res.json({
      ok: true,
      reel: {
        _id: String(reel._id),
        rollId: reel.rollId,
        reelMtrs: Number(reel.reelMtrs) || 0,
        location: reel.location || "",
        allotted: allotted.has(String(reel._id)),
      },
      variant,
    });
  } catch (err) {
    console.error("JOB CARD MATERIAL CHECK ERROR:", err);
    res.status(500).json({ ok: false, code: "error" });
  }
});

// Fires the moment a Job Setting/Production Log row's Start is punched (see
// the .js-start-btn/.log-start-btn handlers in jobCardForm.ejs), for
// whichever of that row's Jumbo FS id/Drum id/Jumbo REL id are already
// filled in -- long before Save Production Entry exists to record real
// consumption. Purely a live "this reel is now actually being drawn on"
// hint (PendingProduction.liveMaterialInUse, see its own schema comment),
// read by /sachiko/facestockstock (and Adhesive/Release Liner Stock) to
// show which specific reel a job is running against, distinct from
// whichever reel was merely allotted on paper at Assign Production. A
// scanned id that isn't a real reel, or a pool this order has no live use
// for yet, is simply ignored -- this never blocks the operator from
// continuing to fill in the card.
router.post("/machine/jobcard/mark-in-use", requireAuth, requireMachineFloor, createLimiter, async (req, res) => {
  try {
    const { pendingId, pool, rollId } = req.body || {};
    if (!mongoose.isValidObjectId(pendingId)) return res.status(400).json({ success: false });
    const poolInfo = POOL_MODELS[pool];
    if (!poolInfo) return res.status(400).json({ success: false });

    if (!String(rollId ?? "").trim()) return res.status(400).json({ success: false });

    // Resolved against stock itself rather than parsed down to one id first:
    // a label's QR ends with the Roll ID glued straight onto the box in front
    // of it, so only stock can say where the id starts. See findScannedReel in
    // utils/rollId.js.
    const reel = await findScannedReel(poolInfo.Model, rollId, "_id rollId");
    if (!reel) return res.status(404).json({ success: false });

    // Hard stop: this reel is already running on another still-open job. Don't
    // mark it in use here -- the UI shows a blocking alert and the operator
    // must scan a different one.
    const { byStockId } = await reelsInUseElsewhere(pendingId);
    const wip = byStockId.get(`${pool}|${String(reel._id)}`);
    if (wip) {
      return res.status(409).json({
        success: false,
        code: "wip",
        rollId: reel.rollId,
        lotNo: wip.lotNo,
        machineName: wip.machineName,
      });
    }

    await PendingProduction.updateOne(
      { _id: pendingId },
      { $addToSet: { [`liveMaterialInUse.${pool}`]: reel._id } },
    );
    res.json({ success: true });
  } catch (err) {
    console.error("JOB CARD MARK-IN-USE ERROR:", err);
    res.status(500).json({ success: false });
  }
});

// The deckle the machine is running right now (PendingProduction.liveRun) --
// what the WIP tab's Live column counts its ETA from. Shared by the web card's
// POST below and the operator app's POST /api/operator/jobcard/log/start.
//
// Answers why it did nothing rather than throwing: the caller is a fire-and-
// forget punch that must never hold the operator up.
//
// `at` (here and in the setting / pause functions below) is when the punch
// actually happened, as a Date on the server's clock -- the operator app
// works it out for a punch that waited in its outbox (eventTimeOf in
// routes/api/operatorApi.js). Anything else -- the web card sends none -- is
// "now".
const liveEventTime = (at) => (at instanceof Date && Number.isFinite(at.getTime()) ? at : new Date());

export async function startLiveRun({ pendingId, rowToken, startTime, startMtrs, at }) {
  const token = trim(rowToken).slice(0, 128);
  if (!mongoose.isValidObjectId(pendingId) || !token) return { ok: false, code: "bad-request" };
  // A row whose Deckle already exists has finished. A Start replayed for it
  // (a retry, a restored draft) must not put it back on the machine.
  if (await MaterialStock.exists({ productionRowToken: token })) return { ok: true, code: "already-made" };
  // Only a job still on a machine; and a repeat of the SAME row's Start keeps
  // the first stamp, so a retried call can't push the ETA back. A deckle on
  // the machine means setting is over (liveSetting goes), and the job counts
  // as played from here if nothing was punched before it ($min: set once).
  const now = liveEventTime(at);
  // A deckle starting is the machine running: whatever hold the job was on
  // ends here, even if its Resume never arrived.
  await endLivePause(pendingId, now);
  const result = await PendingProduction.updateOne(
    { _id: pendingId, assignedMachineId: { $ne: null }, producedAt: null, "liveRun.rowToken": { $ne: token } },
    {
      $set: {
        liveRun: {
          rowToken: token,
          startedAt: now,
          startTime: trim(startTime).slice(0, 16) || undefined,
          startMtrs: numOrUndef(startMtrs),
        },
      },
      $unset: { liveSetting: "" },
      $min: { liveStartedAt: now },
    },
  );
  return { ok: true, code: result.modifiedCount ? "started" : "unchanged" };
}

// A Job Setting row's Start / Stop (PendingProduction.liveSetting) -- the WIP
// tab's JOB SETTING phase, and the first punch that makes a job STARTED.
// Shared by the web card's POSTs below and the operator app's
// /api/operator/jobcard/setting/*. Fire-and-forget from the caller's side,
// like the deckle Start: they answer, never throw at the operator.
export async function startLiveSetting({ pendingId, startTime, startMtrs, at }) {
  if (!mongoose.isValidObjectId(pendingId)) return { ok: false, code: "bad-request" };
  const now = liveEventTime(at);
  await endLivePause(pendingId, now);
  const result = await PendingProduction.updateOne(
    { _id: pendingId, assignedMachineId: { $ne: null }, producedAt: null },
    {
      $set: {
        liveSetting: {
          startedAt: now,
          startTime: trim(startTime).slice(0, 16) || undefined,
          startMtrs: numOrUndef(startMtrs),
        },
      },
      $min: { liveStartedAt: now },
    },
  );
  return { ok: true, code: result.modifiedCount ? "started" : "unchanged" };
}

// Ends the setting row whose Start was punched at `startTime` (the card row's
// own start time, which a restored draft keeps) -- so a Stop can't end a
// different row's setting. Without a start time it ends whatever is running.
export async function stopLiveSetting({ pendingId, startTime, at }) {
  if (!mongoose.isValidObjectId(pendingId)) return { ok: false, code: "bad-request" };
  await endLivePause(pendingId, liveEventTime(at));
  const filter = { _id: pendingId };
  const punched = trim(startTime).slice(0, 16);
  if (punched) filter["liveSetting.startTime"] = punched;
  const result = await PendingProduction.updateOne(filter, { $unset: { liveSetting: "" } });
  return { ok: true, code: result.modifiedCount ? "stopped" : "unchanged" };
}

// ---- On hold (PendingProduction.livePause / livePauseLog) ----
// The operator app's Pause and Resume. Only a job still on a machine can be
// put on hold, and a job already on hold keeps the hold it has -- a Pause
// retried after its response was lost must not move `since` on.
export const LIVE_PAUSE_LOG_MAX = 100;
export async function pauseLiveJob({ pendingId, reason, deviceLabel, at }) {
  if (!mongoose.isValidObjectId(pendingId)) return { ok: false, code: "bad-request" };
  const result = await PendingProduction.updateOne(
    { _id: pendingId, assignedMachineId: { $ne: null }, producedAt: null, "livePause.since": { $exists: false } },
    {
      $set: {
        livePause: {
          since: liveEventTime(at),
          reason: trim(reason).slice(0, 80) || undefined,
          deviceLabel: trim(deviceLabel).slice(0, 64) || undefined,
        },
      },
    },
  );
  return { ok: true, code: result.modifiedCount ? "paused" : "unchanged" };
}

// Ends the hold, filing it in livePauseLog. Called by the app's Resume
// (`explicit`) and by every punch on the card (startLiveRun / startLiveSetting
// / stopLiveSetting above, and a Deckle's Stop). A punch only ends a hold
// that began before it: a Start that sat in an offline tablet's outbox and
// arrives after the Pause that followed it must leave that Pause alone. An
// explicit Resume is never earlier than its own Pause -- the two came off the
// same tablet in order, so a gap below zero is only network jitter between
// two taps a moment apart, and it is closed rather than refused.
//
// The write is conditional on the very `since` read, so a Resume and a punch
// landing together file the hold once, not twice.
export async function endLivePause(pendingId, at, { explicit = false } = {}) {
  if (!mongoose.isValidObjectId(pendingId)) return { ok: false, code: "bad-request" };
  try {
    const doc = await PendingProduction.findById(pendingId).select("livePause").lean();
    const since = doc?.livePause?.since ? new Date(doc.livePause.since) : null;
    if (!since) return { ok: true, code: "not-paused" };
    let end = liveEventTime(at);
    if (end < since) {
      if (!explicit) return { ok: true, code: "before-pause" };
      end = since;
    }
    const result = await PendingProduction.updateOne(
      { _id: pendingId, "livePause.since": since },
      {
        $push: {
          livePauseLog: {
            $each: [{ from: since, to: end, reason: doc.livePause.reason || "" }],
            $slice: -LIVE_PAUSE_LOG_MAX,
          },
        },
        $unset: { livePause: "" },
      },
    );
    return { ok: true, code: result.modifiedCount ? "resumed" : "unchanged" };
  } catch (err) {
    // A punch must never fail on the hold's bookkeeping.
    console.error("END LIVE PAUSE ERROR:", err);
    return { ok: false, code: "error" };
  }
}

// That row's Deckle is made, so it is no longer running. Matched on the row's
// token so a Stop can never end a different row's run. Best-effort: a stale
// liveRun is also ignored on read once its Deckle exists
// (buildJobCardProgressMap in routes/fairdesk_route.js).
export async function endLiveRun(pendingId, rowToken) {
  const token = trim(rowToken);
  if (!mongoose.isValidObjectId(pendingId) || !token) return;
  try {
    await PendingProduction.updateOne({ _id: pendingId, "liveRun.rowToken": token }, { $unset: { liveRun: "" } });
  } catch (err) {
    console.error("END LIVE RUN ERROR:", err);
  }
}

// Fire the moment a Job Setting row's Start / Stop is punched (the
// .js-start-btn / .js-stop-btn handlers in jobCardForm.ejs).
router.post("/machine/jobcard/setting/start", requireAuth, requireMachineFloor, createLimiter, async (req, res) => {
  try {
    const result = await startLiveSetting(req.body || {});
    res.status(result.code === "bad-request" ? 400 : 200).json({ success: result.ok, code: result.code });
  } catch (err) {
    console.error("JOB CARD SETTING START ERROR:", err);
    res.status(500).json({ success: false });
  }
});
router.post("/machine/jobcard/setting/stop", requireAuth, requireMachineFloor, createLimiter, async (req, res) => {
  try {
    const result = await stopLiveSetting(req.body || {});
    res.status(result.code === "bad-request" ? 400 : 200).json({ success: result.ok, code: result.code });
  } catch (err) {
    console.error("JOB CARD SETTING STOP ERROR:", err);
    res.status(500).json({ success: false });
  }
});

// Fires the moment a Production Log row's Start is punched (the
// .log-start-btn handler in jobCardForm.ejs), alongside mark-in-use.
router.post("/machine/jobcard/log/start", requireAuth, requireMachineFloor, createLimiter, async (req, res) => {
  try {
    const result = await startLiveRun(req.body || {});
    res.status(result.code === "bad-request" ? 400 : 200).json({ success: result.ok, code: result.code });
  } catch (err) {
    console.error("JOB CARD LOG START ERROR:", err);
    res.status(500).json({ success: false });
  }
});

// Fires the moment a Production Log row's Stop is punched (with its Meters
// already filled in) -- see the .log-stop-btn handler in jobCardForm.ejs --
// rather than waiting for the whole Job Card to be saved. On a job that runs
// a full shift, that's the difference between a Deckle showing up on Semi
// Finished Stock right away and it not existing anywhere until the operator
// eventually hits "Save Production Entry" hours later. Reuses
// produceDecklesFromLog for a single row; the job card doesn't exist yet at
// this point (it's only created on final save), so its remarks simply omit a
// job card id prefix. The final save then skips re-producing any row this
// endpoint already inwarded -- see productionLog's `alreadyProduced` in
// POST /machine/jobcard/form below -- so it's recorded once, not twice.
//
// Idempotent on the row's `rowToken` (MaterialStock.productionRowToken): a
// retried call whose first response was lost, and the final save if the row
// never came back marked produced, both match the existing Deckle on that
// token and reuse it instead of making a duplicate.
router.post("/machine/jobcard/log/produce", requireAuth, requireMachineFloor, createLimiter, async (req, res) => {
  try {
    const b = req.body;
    if (!mongoose.isValidObjectId(b.pendingId)) {
      return res.status(400).json({ success: false, message: "Missing or invalid production order." });
    }
    const meters = numOrUndef(b.meters);
    if (!meters || meters <= 0) {
      return res.status(400).json({ success: false, message: "Enter the produced metres first." });
    }

    // Idempotent replay: a Deckle carrying this row's token already exists,
    // so the first attempt committed and only its response was lost. Hand
    // back the same Deckle instead of inwarding a second one.
    const rowToken = trim(b.rowToken) || undefined;
    if (rowToken) {
      const priorDeckle = await MaterialStock.findOne({ productionRowToken: rowToken })
        .select("rollId reelMtrs location material sourceReels")
        .populate({ path: "material", select: "productCode" })
        .lean();
      if (priorDeckle) {
        await endLiveRun(b.pendingId, rowToken);
        return res.json({
          success: true,
          deckleId: priorDeckle.rollId,
          meters: Number(priorDeckle.reelMtrs) || 0,
          location: priorDeckle.location || "",
          productCode: priorDeckle.material?.productCode || "",
          sourceReels: priorDeckle.sourceReels || [],
          replayed: true,
        });
      }
    }

    const pendingDoc = await PendingProduction.findById(b.pendingId)
      .select("allottedLayers itemId paperSize lotNo")
      .lean();
    if (!pendingDoc) {
      return res.status(404).json({ success: false, message: "That production order no longer exists." });
    }

    const deckleLocation = await resolveDeckleLocation(pendingDoc);
    if (!deckleLocation) {
      return res.status(400).json({ success: false, message: "Couldn't resolve a stock location for this order." });
    }

    const fs = trim(b.fsRollId);
    const ad = trim(b.adRollId);
    const rl = trim(b.rlRollId);
    let materialsUsed = [];
    try {
      const arr = JSON.parse(b.materialsUsed || "[]");
      if (Array.isArray(arr)) {
        materialsUsed = arr
          .filter((m) => m && m.pool && (m.rollId || m.stockId))
          .map((m) => ({ pool: trim(m.pool), rollId: trim(m.rollId), stockId: mongoose.isValidObjectId(m.stockId) ? m.stockId : undefined }));
      }
    } catch { materialsUsed = []; }
    const row = {
      rollId: fs || [fs, ad, rl].filter(Boolean).join(", "),
      fsRollId: fs,
      adRollId: ad,
      rlRollId: rl,
      materialsUsed,
      deckleId: "",
      rowToken,
      startMtrs: numOrUndef(b.startMtrs),
      stopMtrs: numOrUndef(b.stopMtrs),
      meters,
      face: { joint: trim(b.faceJoint), mtr: numOrUndef(b.faceMtr), reason: trim(b.faceJointReason) },
      release: { joint: trim(b.releaseJoint), mtr: numOrUndef(b.releaseMtr), reason: trim(b.releaseJointReason) },
      time: { startTime: trim(b.startTime), endTime: trim(b.endTime) },
    };

    const production = await produceDecklesFromLog({
      pendingDoc,
      productionLog: [row],
      location: deckleLocation,
      createdBy: req.session?.authUser?.username || req.session?.authUser?.empName || "SYSTEM",
    });

    const deckleId = production.rows[0];
    if (!deckleId) {
      return res.status(400).json({ success: false, message: "Couldn't produce a Deckle for this row." });
    }
    // The row is off the machine -- the WIP tab stops counting down to it --
    // and a deckle coming off means the job isn't on hold.
    await endLiveRun(b.pendingId, rowToken);
    await endLivePause(b.pendingId);

    // Firm the reel reservation: every reel this Deckle actually consumed is
    // now locked to this order, whether or not the scan-time mark-in-use call
    // landed. Released only when the order finishes (final Save) or is sent
    // back to Pending. Best-effort -- a hiccup here never fails the produce.
    try {
      const addToSet = {};
      for (const sr of production.rowMeta?.[0]?.sourceReels || []) {
        if (!sr?.pool || !POOL_MODELS[sr.pool] || !mongoose.isValidObjectId(sr.stockId)) continue;
        const key = `liveMaterialInUse.${sr.pool}`;
        // ObjectId, to match POST /machine/jobcard/mark-in-use -- a Mixed
        // array would otherwise hold the same reel as both a string and an
        // ObjectId and $addToSet wouldn't dedupe them.
        (addToSet[key] ||= { $each: [] }).$each.push(new mongoose.Types.ObjectId(String(sr.stockId)));
      }
      if (Object.keys(addToSet).length) {
        await PendingProduction.updateOne({ _id: b.pendingId }, { $addToSet: addToSet });
      }
    } catch (lockErr) {
      console.error("JOB CARD INSTANT DECKLE LOCK ERROR:", lockErr);
    }

    res.json({
      success: true,
      deckleId,
      meters: production.meters,
      location: deckleLocation,
      productCode: production.rowMeta?.[0]?.productCode || "",
      sourceReels: production.rowMeta?.[0]?.sourceReels || [],
    });
  } catch (err) {
    console.error("JOB CARD INSTANT DECKLE ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to move this Deckle to Semi Finished Stock." });
  }
});

// Fires when the operator clicks "Change" on a mounted material (a reel ran
// out, or the wrong one was scanned) -- reconciles the OUTGOING reel before
// the next one goes on. The operator enters how many kg are physically left
// on it; stock is updated to exactly that (consumed = current - remaining,
// reel emptied at 0), and the swap is recorded on the order so (a) the
// end-of-job Material Used dialog skips this reel and (b) the shop floor can
// see a short "what was used on this job" history. No allocation here -- any
// recipe-matching in-stock reel is fair game.
router.post("/machine/jobcard/material/set-remaining", requireAuth, requireMachineFloor, createLimiter, async (req, res) => {
  try {
    const { pendingId, pool, stockId, remainingKg } = req.body || {};
    if (!mongoose.isValidObjectId(pendingId)) {
      return res.status(400).json({ success: false, message: "Missing production order." });
    }
    if (!POOL_MODELS[pool]) {
      return res.status(400).json({ success: false, message: "Unknown material pool." });
    }
    if (!mongoose.isValidObjectId(stockId)) {
      return res.status(400).json({ success: false, message: "Missing stock reference." });
    }
    const remaining = Number(remainingKg);
    if (!Number.isFinite(remaining) || remaining < 0) {
      return res.status(400).json({ success: false, message: "Enter a valid non-negative kg amount." });
    }
    // Mandatory -- why this reel is coming off the job mid-run. Checked here
    // too, not just client-side, so the swap is never recorded without one.
    const reason = trim(req.body?.reason).slice(0, 300);
    if (reason.length < 3) {
      return res.status(400).json({ success: false, message: "Give a reason for taking this reel off the job." });
    }

    const pendingDoc = await PendingProduction.findById(pendingId).select("allottedLayers itemId").lean();
    if (!pendingDoc) {
      return res.status(404).json({ success: false, message: "That production order no longer exists." });
    }

    // Any reel that matches this order's recipe (allotted or not) can be
    // resolved this way -- getEligibleRawMaterials' validStockIds is that set.
    const eligible = await getEligibleRawMaterials({ labelStock: pendingDoc.itemId, allottedLayers: pendingDoc.allottedLayers });
    if (!eligible.validStockIds?.[pool]?.has(String(stockId))) {
      return res.status(400).json({ success: false, message: "That reel doesn't match this order's recipe." });
    }

    // A reel running on another still-open job can't be drawn down here.
    const { byStockId } = await reelsInUseElsewhere(pendingId);
    const wip = byStockId.get(`${pool}|${String(stockId)}`);
    if (wip) {
      return res.status(409).json({ success: false, code: "wip", lotNo: wip.lotNo, machineName: wip.machineName });
    }

    const createdBy = req.session?.authUser?.username || req.session?.authUser?.empName || "SYSTEM";
    const result = await consumePoolUsage({
      pool,
      rows: [{ stockId, remainingKg: remaining }],
      jobCardId: "",
      createdBy,
    });
    const row = result.rows[0];
    if (!row) {
      return res.status(404).json({ success: false, message: "Couldn't find that reel in stock." });
    }

    const swapEntry = {
      pool,
      stockId: row.stockId,
      rollId: row.rollId,
      usedKg: row.used,
      remainingKg: row.remainingKg,
      emptied: row.remainingKg <= 0,
      reason,
      swappedAt: new Date(),
      swappedBy: createdBy,
    };
    await PendingProduction.updateOne({ _id: pendingId }, { $push: { materialSwapLog: swapEntry } });

    res.json({ success: true, swap: swapEntry });
  } catch (err) {
    console.error("JOB CARD MATERIAL SET-REMAINING ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to update stock." });
  }
});

// Extracted from POST /machine/jobcard/form so the JSON operator API's
// POST /jobcard (routes/api/operatorApi.js) can reuse this exact
// save/consume/produce pipeline instead of re-deriving it. Deliberately
// takes no req/res -- every early exit (idempotent resubmit, allotment
// gate, a reel already WIP elsewhere) and the final outcome are reported
// back as a status object; callers decide what to do with it (the EJS
// route below turns it into a flash+redirect, the bearer route turns it
// into a JSON response).
export async function saveMachineJobCard({ body, actorName }) {
  const b = body;
  const createdBy = actorName || "SYSTEM";
  try {
    // Idempotency: a resubmit of the same loaded page carries the same
    // token. If one already saved, don't create a second entry or deduct
    // stock again -- just report it as already-saved.
    const submissionToken = trim(b.submissionToken);
    if (submissionToken) {
      const already = await MachineJobCard.findOne({ submissionToken }).select("_id").lean();
      if (already) {
        return { status: "duplicate", pendingId: mongoose.isValidObjectId(b.pendingId) ? String(b.pendingId) : "new" };
      }
    }

    // Mirror the GET guard -- a direct POST (bypassing the form) still can't
    // start a job with no reels actually set aside for it. Kept in scope past
    // this block (not just re-checked here) -- the Adhesive Used dialog's
    // rows get validated against this same order's own allottedLayers below,
    // rather than trusting whatever stockIds the client posted.
    let pendingDoc = null;
    if (mongoose.isValidObjectId(b.pendingId)) {
      pendingDoc = await PendingProduction.findById(b.pendingId)
        .select("allottedRollIds allottedLayers itemId paperSize lotNo materialSwapLog noOfRolls quantity isDeckleBatch producedRolls")
        .populate({ path: "itemId", select: "rollType" })
        .lean();
      if (!pendingDoc || !hasStartableAllotment({
        rollType: pendingDoc.itemId?.rollType,
        allottedLayers: pendingDoc.allottedLayers,
        allottedRollIds: pendingDoc.allottedRollIds,
      })) {
        return {
          status: "gate-failed",
          message: "Allot every raw material (Facestock / Adhesive / Release Liner) to this order before starting production.",
          machineId: b.machineId,
        };
      }
    }

    // Where each new Deckle this job produces gets inwarded -- see
    // resolveDeckleLocation above.
    const deckleLocation = await resolveDeckleLocation(pendingDoc);

    // Material Used dialog rows -- one per reel this order actually had
    // reserved, per pool (facestockStockId[]/facestockMtrsUsed[],
    // adhesiveStockId[]/adhesiveKgUsed[], releaseStockId[]/
    // releaseMtrsUsed[], each its own parallel-array pair, same convention as
    // Job Setting/Production Log above). Only a stockId that's genuinely one
    // of this order's own allottedLayers picks for that pool is kept -- the
    // dialog only ever offers those, but the form is still a POST body, not
    // a trusted source.
    let eligiblePostStock = { facestock: [], adhesive: [], release: [], validStockIds: { facestock: new Set(), adhesive: new Set(), release: new Set() } };
    if (pendingDoc?.itemId) {
      eligiblePostStock = await getEligibleRawMaterials({
        labelStock: pendingDoc.itemId,
        allottedLayers: pendingDoc.allottedLayers,
      });
    }

    const validStockIdsForPool = (pool, keys) => {
      const allotted = new Set(
        keys
          .map((key) => pendingDoc?.allottedLayers?.[key])
          .filter((pick) => pick?.pool === pool)
          .flatMap((pick) => pickStockIds(pick)),
      );
      const eligible = eligiblePostStock.validStockIds?.[pool] || new Set();
      return new Set([...allotted, ...eligible]);
    };

    // A reel already resolved live via the Materials in Use "Add" flow
    // (POST /machine/jobcard/material/set-remaining) was already deducted at
    // that moment -- the client's own Material Used dialog is told not to
    // ask about it again, but this is the belt-and-suspenders backstop
    // against double-deducting the same reel if it slips through anyway.
    const alreadyResolvedStockIds = new Set((pendingDoc?.materialSwapLog || []).map((s) => String(s.stockId)));

    const validFacestockStockIds = validStockIdsForPool("facestock", ["facestock", "facestock2"]);
    const fsStockId = toArray(b.facestockStockId);
    const fsMtrsUsed = toArray(b.facestockMtrsUsed);
    const fsRemainingKg = toArray(b.facestockRemainingKg);
    const facestockUsage = consolidateUsageRows(
      fsStockId
        .map((sid, i) => ({
          stockId: trim(sid),
          mtrsUsed: numOrUndef(fsMtrsUsed[i]),
          remainingKg: numOrUndef(fsRemainingKg[i]),
        }))
        .filter((row) => row.stockId && validFacestockStockIds.has(row.stockId) && !alreadyResolvedStockIds.has(row.stockId)),
      "mtrsUsed",
    );

    const validAdhesiveStockIds = validStockIdsForPool("adhesive", ["adhesive", "adhesive2"]);
    const adKgStockId = toArray(b.adhesiveStockId);
    const adKgUsed = toArray(b.adhesiveKgUsed);
    const adRemainingKg = toArray(b.adhesiveRemainingKg);
    const adhesiveUsage = consolidateUsageRows(
      adKgStockId
        .map((sid, i) => ({
          stockId: trim(sid),
          kgUsed: numOrUndef(adKgUsed[i]),
          remainingKg: numOrUndef(adRemainingKg[i]),
        }))
        .filter((row) => row.stockId && validAdhesiveStockIds.has(row.stockId) && !alreadyResolvedStockIds.has(row.stockId)),
      "kgUsed",
    );

    const validReleaseStockIds = validStockIdsForPool("release", ["releaseLiner", "releaseLiner2"]);
    const rlStockId = toArray(b.releaseStockId);
    const rlMtrsUsed = toArray(b.releaseMtrsUsed);
    const rlRemainingKg = toArray(b.releaseRemainingKg);
    const releaseUsage = consolidateUsageRows(
      rlStockId
        .map((sid, i) => ({
          stockId: trim(sid),
          mtrsUsed: numOrUndef(rlMtrsUsed[i]),
          remainingKg: numOrUndef(rlRemainingKg[i]),
        }))
        .filter((row) => row.stockId && validReleaseStockIds.has(row.stockId) && !alreadyResolvedStockIds.has(row.stockId)),
      "mtrsUsed",
    );

    const jobCardId = await generateId("machineJobCardId", "JC");

    // Job Setting rows
    const jsFsRollId = toArray(b.jsFsRollId);
    const jsAdRollId = toArray(b.jsAdRollId);
    const jsRlRollId = toArray(b.jsRlRollId);
    const jsRollId = toArray(b.jsRollId);
    const jsMtrs1 = toArray(b.jsMtrs1);
    const jsStart = toArray(b.jsStart);
    const jsMtrs2 = toArray(b.jsMtrs2);
    const jsStop = toArray(b.jsStop);
    const jobSetting = jsMtrs1
      .map((_, i) => {
        const fs = trim(jsFsRollId[i]);
        const ad = trim(jsAdRollId[i]);
        const rl = trim(jsRlRollId[i]);
        const legacyRoll = trim(jsRollId[i]);
        const mainRoll = fs || legacyRoll || [fs, ad, rl].filter(Boolean).join(", ");
        return {
          rollId: mainRoll,
          fsRollId: fs,
          adRollId: ad,
          rlRollId: rl,
          mtrs1: numOrUndef(jsMtrs1[i]),
          startTime: trim(jsStart[i]),
          mtrs2: numOrUndef(jsMtrs2[i]),
          stopTime: trim(jsStop[i]),
        };
      })
      .filter((row) => row.rollId || row.fsRollId || row.adRollId || row.rlRollId || row.mtrs1 != null || row.mtrs2 != null || row.startTime || row.stopTime);

    // Production Log rows -- one per deckle produced, so alongside Job
    // Setting's start/stop counter pair these also carry the deckle's own
    // produced metres, plus the joint/wrinkle noted on each web.
    const fsRollId = toArray(b.fsRollId);
    const adRollId = toArray(b.adRollId);
    const rlRollId = toArray(b.rlRollId);
    const rollId = toArray(b.rollId);
    const deckleId = toArray(b.deckleId);
    // Set by the instant-produce call the moment this row's Stop was punched
    // (see the .log-stop-btn handler in jobCardForm.ejs and POST
    // /machine/jobcard/log/produce above) -- a row carrying both this and its
    // system-issued deckleId already has its Deckle inwarded to Semi Finished
    // Stock, so produceDecklesFromLog below must not do it again.
    const logInstantProduced = toArray(b.logInstantProduced);
    // Per-row idempotency token (see MaterialStock.productionRowToken) -- lets
    // produceDecklesFromLog below reuse a Deckle the instant-produce call
    // already inwarded even when this row didn't come back marked
    // `alreadyProduced` (its response was lost).
    const logRowToken = toArray(b.logRowToken);
    const logMaterialsUsed = toArray(b.logMaterialsUsed);
    const parseMaterialsUsed = (raw) => {
      try {
        const arr = JSON.parse(raw || "[]");
        return Array.isArray(arr)
          ? arr
              .filter((m) => m && m.pool && (m.rollId || m.stockId))
              .map((m) => ({
                pool: trim(m.pool),
                rollId: trim(m.rollId),
                stockId: mongoose.isValidObjectId(m.stockId) ? m.stockId : undefined,
              }))
          : [];
      } catch { return []; }
    };
    const logStart = toArray(b.logStart);
    const logStartMtrs = toArray(b.logStartMtrs);
    const logEnd = toArray(b.logEnd);
    const logStopMtrs = toArray(b.logStopMtrs);
    const logMeters = toArray(b.logMeters);
    const faceJoint = toArray(b.faceJoint);
    const faceMtr = toArray(b.faceMtr);
    const faceJointReason = toArray(b.faceJointReason);
    const releaseJoint = toArray(b.releaseJoint);
    const releaseMtr = toArray(b.releaseMtr);
    const releaseJointReason = toArray(b.releaseJointReason);
    const productionLog = logMeters
      .map((_, i) => {
        const fs = trim(fsRollId[i]);
        const ad = trim(adRollId[i]);
        const rl = trim(rlRollId[i]);
        const legacyRoll = trim(rollId[i]);
        const mainRoll = fs || legacyRoll || [fs, ad, rl].filter(Boolean).join(", ");
        const rowDeckleId = trim(deckleId[i]);
        return {
          rollId: mainRoll,
          fsRollId: fs,
          adRollId: ad,
          rlRollId: rl,
          deckleId: rowDeckleId,
          rowToken: trim(logRowToken[i]) || undefined,
          materialsUsed: parseMaterialsUsed(logMaterialsUsed[i]),
          alreadyProduced: trim(logInstantProduced[i]) === "1" && Boolean(rowDeckleId),
          startMtrs: numOrUndef(logStartMtrs[i]),
          stopMtrs: numOrUndef(logStopMtrs[i]),
          meters: numOrUndef(logMeters[i]),
          face: { joint: trim(faceJoint[i]), mtr: numOrUndef(faceMtr[i]), reason: trim(faceJointReason[i]) },
          release: { joint: trim(releaseJoint[i]), mtr: numOrUndef(releaseMtr[i]), reason: trim(releaseJointReason[i]) },
          time: { startTime: trim(logStart[i]), endTime: trim(logEnd[i]) },
        };
      })
      .filter(
        (row) =>
          row.rollId ||
          row.fsRollId ||
          row.adRollId ||
          row.rlRollId ||
          row.deckleId ||
          row.startMtrs != null ||
          row.stopMtrs != null ||
          row.meters != null ||
          row.face.mtr != null ||
          row.release.mtr != null ||
          row.time.startTime ||
          row.time.endTime,
      );

    // Hard stop, server-side backstop for the scan-time alert: no reel that is
    // already WIP on another still-open job may be recorded here. Checks every
    // scanned roll id across Job Setting / Production Log, plus every stockId
    // the Material Used dialog posted.
    if (mongoose.isValidObjectId(b.pendingId)) {
      const { byRollId, byStockId } = await reelsInUseElsewhere(b.pendingId);
      if (byRollId.size || byStockId.size) {
        const scannedByPool = { facestock: [], adhesive: [], release: [] };
        for (const r of [...jobSetting, ...productionLog]) {
          if (r.fsRollId) scannedByPool.facestock.push(extractScannedRollId(r.fsRollId));
          if (r.adRollId) scannedByPool.adhesive.push(extractScannedRollId(r.adRollId));
          if (r.rlRollId) scannedByPool.release.push(extractScannedRollId(r.rlRollId));
        }
        let clash = null;
        for (const [, rid] of Object.entries(scannedByPool).flatMap(([p, ids]) => ids.map((id) => [p, id]))) {
          const hit = rid && byRollId.get(rid);
          if (hit) { clash = { rollId: rid, ...hit }; break; }
        }
        if (!clash) {
          for (const u of [...facestockUsage, ...adhesiveUsage, ...releaseUsage]) {
            const poolKey = ["facestock", "adhesive", "release"].find((p) => byStockId.has(`${p}|${String(u.stockId)}`));
            if (poolKey) { clash = { rollId: u.rollId || "", ...byStockId.get(`${poolKey}|${String(u.stockId)}`) }; break; }
          }
        }
        if (clash) {
          return {
            status: "wip-clash",
            message: `Reel ${clash.rollId || ""} is already running on job ${clash.lotNo || "(another order)"}${clash.machineName ? ` at ${clash.machineName}` : ""} — it can't be used here.`,
            machineId: b.machineId,
          };
        }
      }
    }

    await MachineJobCard.create({
      jobCardId,
      submissionToken: submissionToken || undefined,
      date: b.date ? new Date(b.date) : new Date(),
      pendingProductionId: mongoose.isValidObjectId(b.pendingId) ? b.pendingId : undefined,
      machineId: mongoose.isValidObjectId(b.machineId) ? b.machineId : undefined,
      machineName: trim(b.machineNo),
      lotNo: trim(b.lotNo),
      productCode: trim(b.productCode),
      paperSize: trim(b.paperSize),
      rolls: trim(b.rolls),
      quantity: numOrUndef(b.quantity),
      operatorName: trim(b.operatorName),
      helperName: trim(b.helperName),
      faceStock: {
        rollDrumNo: trim(b.fsRollDrumNo) || [...new Set([...jobSetting, ...productionLog].map((r) => r.fsRollId).filter(Boolean))].join(", "),
        code: trim(b.fsCode),
        gsmMic: trim(b.fsGsmMic),
        size: trim(b.fsSize),
      },
      adhesive: {
        rollDrumNo: trim(b.adRollDrumNo) || [...new Set([...jobSetting, ...productionLog].map((r) => r.adRollId).filter(Boolean))].join(", "),
        code: trim(b.adCode),
        gsmMic: trim(b.adGsmMic),
        size: trim(b.adSize),
      },
      releaseLiner: {
        rollDrumNo: trim(b.rlRollDrumNo) || [...new Set([...jobSetting, ...productionLog].map((r) => r.rlRollId).filter(Boolean))].join(", "),
        code: trim(b.rlCode),
        gsmMic: trim(b.rlGsmMic),
        size: trim(b.rlSize),
      },
      jobSetting,
      productionLog,
      facestockUsage,
      adhesiveUsage,
      releaseUsage,
      totalMeter: trim(b.totalMeter),
      sqMtr: trim(b.sqMtr),
    });

    // Deduct the production log's running metres from the reels this job was
    // allotted. Isolated from the create above: the job card is already
    // saved, so a hiccup here must not read back as a failed save.
    let consumption = { deducted: 0, emptied: 0, meters: 0, unmatched: [] };
    try {
      consumption = await consumeAllottedRollMeters({
        pendingProductionId: mongoose.isValidObjectId(b.pendingId) ? b.pendingId : null,
        logRows: [...jobSetting, ...productionLog],
        jobCardId,
        createdBy,
      });
    } catch (stockErr) {
      console.error("JOB CARD STOCK DEDUCTION ERROR:", stockErr);
    }

    // Deduct the mtrs/kg the operator reported in the "Material Used" dialog,
    // per pool. Same isolation as above -- the job card and its meter
    // deduction are already committed, so none of these three can turn a
    // successful save into an apparent failure.
    let facestockConsumption = { deducted: 0, emptied: 0, used: 0, rows: [] };
    try {
      facestockConsumption = await consumePoolUsage({
        pool: "facestock",
        rows: facestockUsage.map((r) => ({ stockId: r.stockId, used: r.mtrsUsed, remainingKg: r.remainingKg })),
        jobCardId,
        createdBy,
      });
      // Fills in the rollId snapshot the create above couldn't (the reel
      // docs are only read inside consumePoolUsage itself) -- purely
      // cosmetic for the saved card, the deduction already happened above
      // regardless of whether this write succeeds.
      if (facestockConsumption.rows.length) {
        await MachineJobCard.updateOne(
          { jobCardId },
          { $set: { facestockUsage: facestockConsumption.rows.map((r) => ({ stockId: r.stockId, rollId: r.rollId, mtrsUsed: r.used, remainingKg: r.remainingKg })) } },
        );
      }
    } catch (fsErr) {
      console.error("JOB CARD FACESTOCK DEDUCTION ERROR:", fsErr);
    }

    let adhesiveConsumption = { deducted: 0, emptied: 0, used: 0, rows: [] };
    try {
      adhesiveConsumption = await consumePoolUsage({
        pool: "adhesive",
        rows: adhesiveUsage.map((r) => ({ stockId: r.stockId, used: r.kgUsed, remainingKg: r.remainingKg })),
        jobCardId,
        createdBy,
      });
      if (adhesiveConsumption.rows.length) {
        await MachineJobCard.updateOne(
          { jobCardId },
          { $set: { adhesiveUsage: adhesiveConsumption.rows.map((r) => ({ stockId: r.stockId, rollId: r.rollId, kgUsed: r.used, remainingKg: r.remainingKg })) } },
        );
      }
    } catch (adErr) {
      console.error("JOB CARD ADHESIVE DEDUCTION ERROR:", adErr);
    }

    let releaseConsumption = { deducted: 0, emptied: 0, used: 0, rows: [] };
    try {
      releaseConsumption = await consumePoolUsage({
        pool: "release",
        rows: releaseUsage.map((r) => ({ stockId: r.stockId, used: r.mtrsUsed, remainingKg: r.remainingKg })),
        jobCardId,
        createdBy,
      });
      if (releaseConsumption.rows.length) {
        await MachineJobCard.updateOne(
          { jobCardId },
          { $set: { releaseUsage: releaseConsumption.rows.map((r) => ({ stockId: r.stockId, rollId: r.rollId, mtrsUsed: r.used, remainingKg: r.remainingKg })) } },
        );
      }
    } catch (rlErr) {
      console.error("JOB CARD RELEASE LINER DEDUCTION ERROR:", rlErr);
    }

    // Lamination: one new Deckle per Production Log row that actually made
    // metres (produceDecklesFromLog above), inwarded to Semi-Finished Stock.
    // Same isolation as the deductions above -- the job card is already
    // saved, so a hiccup here can't turn a successful save into an apparent
    // failure. The generated ids replace whatever the operator typed into
    // each row's Deckle ID box (see productionLog's own `deckleId` above) --
    // system-issued now, the same way jobCardId itself is.
    let deckleProduction = { rows: [], created: 0, meters: 0 };
    try {
      deckleProduction = await produceDecklesFromLog({
        pendingDoc,
        productionLog,
        jobSetting,
        facestockUsage,
        adhesiveUsage,
        releaseUsage,
        location: deckleLocation,
        jobCardId,
        createdBy,
      });
      const updateSet = productionLog.reduce((set, _row, i) => {
        if (deckleProduction.rows[i]) set[`productionLog.${i}.deckleId`] = deckleProduction.rows[i];
        const meta = deckleProduction.rowMeta?.[i];
        if (meta) {
          if (meta.productCode) set[`productionLog.${i}.productCode`] = meta.productCode;
          if (meta.sourceReels?.length) set[`productionLog.${i}.materialsUsed`] = meta.sourceReels;
        }
        return set;
      }, {});
      if (deckleProduction.resolvedProductCode) {
        updateSet.productCode = deckleProduction.resolvedProductCode;
      }
      if (Object.keys(updateSet).length) {
        await MachineJobCard.updateOne({ jobCardId }, { $set: updateSet });
      }
    } catch (deckleErr) {
      console.error("JOB CARD DECKLE PRODUCTION ERROR:", deckleErr);
    }

    // Accumulate the rolls this Job Card produced onto the order (one per
    // Production Log row that recorded metres -- each row is one deckle),
    // and drop the live in-use hint (liveMaterialInUse) -- the real
    // consumption just saved above (facestockUsage etc.) is now the
    // permanent record, so the Start-punch hint that stood in for it has
    // nothing left to add.
    //
    // Only stamp producedAt -- which takes the order off every machine /
    // operator queue -- once the running total of deckles laminated reaches
    // this job's DECKLE target: a plain order's Qty, or a deckle batch's
    // planner-entered Deckle Qty (stored as noOfRolls). Deliberately NOT a
    // plain order's own noOfRolls -- that's the sales order's finished-roll
    // count for the downstream slitting step, always >= the deckle count.
    // Producing fewer than the target (the operator switched to another job
    // mid-order) leaves producedAt unset, so the order stays on the queue
    // showing its balance still to run. An order with no target recorded
    // closes on the first save, as before.
    let productionProgress = null;
    if (mongoose.isValidObjectId(b.pendingId)) {
      try {
        const rollsThisSession = productionLog.filter((r) => Number(r.meters) > 0).length;
        const priorProduced = Number(pendingDoc?.producedRolls) || 0;
        const totalProduced = priorProduced + rollsThisSession;
        const requiredRolls = Number(
          pendingDoc?.isDeckleBatch ? pendingDoc?.noOfRolls : pendingDoc?.quantity,
        );
        const hasTarget = Number.isFinite(requiredRolls) && requiredRolls > 0;
        const complete = !hasTarget || totalProduced >= requiredRolls;
        const update = {
          $set: { producedRolls: totalProduced },
          // The live punches go with it: this card's rows are now filed, so
          // nothing of it is running, setting or on hold, and a resumed job is
          // played afresh on its next card.
          $unset: {
            liveMaterialInUse: "", liveRun: "", liveSetting: "", liveStartedAt: "", livePause: "", livePauseLog: "",
          },
        };
        if (complete) update.$set.producedAt = new Date();
        await PendingProduction.updateOne({ _id: b.pendingId }, update);
        productionProgress = { totalProduced, requiredRolls, hasTarget, complete };
      } catch (prodErr) {
        console.error("JOB CARD MARK-PRODUCED ERROR:", prodErr);
      }
    }

    let message = "Production entry saved successfully!";
    if (productionProgress && productionProgress.hasTarget && !productionProgress.complete) {
      const remaining = Math.max(productionProgress.requiredRolls - productionProgress.totalProduced, 0);
      message +=
        ` Job switch: ${productionProgress.totalProduced} of ${productionProgress.requiredRolls} deckle` +
        `${productionProgress.requiredRolls === 1 ? "" : "s"} produced — ${remaining} still pending,` +
        ` order kept on the queue.`;
    }
    if (consumption.deducted) {
      message +=
        ` Stock: ${consumption.meters} mtrs off ${consumption.deducted} reel${consumption.deducted === 1 ? "" : "s"}` +
        `${consumption.emptied ? ` (${consumption.emptied} emptied)` : ""}.`;
    }
    if (consumption.unmatched.length) {
      const uniq = [...new Set(consumption.unmatched)];
      message += ` Note: stock not deducted for roll${uniq.length === 1 ? "" : "s"} ${uniq.join(", ")} (not among this job's allotted reels).`;
    }
    if (facestockConsumption.deducted) {
      message +=
        ` Facestock: ${facestockConsumption.used} kg off ${facestockConsumption.deducted} reel${facestockConsumption.deducted === 1 ? "" : "s"}` +
        `${facestockConsumption.emptied ? ` (${facestockConsumption.emptied} emptied)` : ""}.`;
    }
    if (adhesiveConsumption.deducted) {
      message +=
        ` Adhesive: ${adhesiveConsumption.used} kg off ${adhesiveConsumption.deducted} drum${adhesiveConsumption.deducted === 1 ? "" : "s"}` +
        `${adhesiveConsumption.emptied ? ` (${adhesiveConsumption.emptied} emptied)` : ""}.`;
    }
    if (releaseConsumption.deducted) {
      message +=
        ` Release Liner: ${releaseConsumption.used} kg off ${releaseConsumption.deducted} reel${releaseConsumption.deducted === 1 ? "" : "s"}` +
        `${releaseConsumption.emptied ? ` (${releaseConsumption.emptied} emptied)` : ""}.`;
    }
    if (deckleProduction.created) {
      const ids = deckleProduction.rows.filter(Boolean);
      message +=
        ` Produced: ${deckleProduction.meters} mtrs as ${deckleProduction.created} Deckle${deckleProduction.created === 1 ? "" : "s"}` +
        `${ids.length ? ` (${ids.join(", ")})` : ""} — inwarded to Semi-Finished Stock.`;
    }

    return {
      status: "ok",
      jobCardId,
      pendingId: mongoose.isValidObjectId(b.pendingId) ? String(b.pendingId) : "new",
      message,
      consumption,
      facestockConsumption,
      adhesiveConsumption,
      releaseConsumption,
      deckleProduction,
      productionProgress,
    };
  } catch (err) {
    // Two submits of the same page racing past the pre-check both reach
    // create; the loser trips the unique submissionToken index. That's a
    // duplicate, not a failure.
    if (err?.code === 11000 && err?.keyPattern?.submissionToken) {
      return { status: "duplicate", pendingId: mongoose.isValidObjectId(b.pendingId) ? String(b.pendingId) : "new" };
    }
    throw err;
  }
}

router.post("/machine/jobcard/form", requireAuth, requireMachineFloor, createLimiter, async (req, res) => {
  try {
    const result = await saveMachineJobCard({
      body: req.body,
      actorName: req.session?.authUser?.username || req.session?.authUser?.empName,
    });

    if (result.status === "duplicate") {
      return res.redirect(`/app/machine/jobcard/view?saved=${encodeURIComponent(result.pendingId)}`);
    }
    if (result.status === "gate-failed" || result.status === "wip-clash") {
      req.flash("notification", result.message);
      return res.redirect(
        mongoose.isValidObjectId(result.machineId) ? `/app/machine/${result.machineId}/queue` : "/app/machine/queue",
      );
    }

    req.flash("notification", result.message);
    return res.redirect(`/app/machine/jobcard/view?saved=${encodeURIComponent(result.pendingId)}`);
  } catch (err) {
    console.error("JOB CARD CREATE ERROR:", err);
    req.flash("notification", "Failed to save production entry");
    res.redirect("back");
  }
});

// ---------------------------------- Deckle Logs ----------------------------------
// The page loads nothing up front: /machine/jobcard/view is just the shell,
// /machine/jobcard/days returns one summary line per day (a single aggregation,
// a few hundred bytes), and a day's deckles are fetched from
// /machine/jobcard/day/:yyyy-mm-dd only when that day is opened. A shop with
// years of cards therefore costs one small query per page view instead of
// reading, populating and decorating every card each time.
//
// "Day" = the day the Deckle was made (its Stop punch, MaterialStock.createdAt),
// in the viewer's timezone (the page sends its offset); a log row with no Deckle
// falls back to the card's own date.

// ---- Per-deckle reel breakdown for the "Deckle" dialog, in the
//      same shape as /sachiko/semifinishedstock's view dialog (Layer / Reel
//      ID / Spec / Kg Used / Status / Remark). Spec is read off the raw
//      reel's own Stock row (kept at qty 0 after it is consumed); Kg Used
//      comes from this Job Card's end-of-job *Usage arrays, falling back to
//      the order's materialSwapLog for a reel swapped out mid-run, then
//      pro-rated across every Deckle row on the card that shared the reel
//      (same reasoning as semiFinishedStock.js); Remark is the swap reason. ----
const jcNorm = (v) => String(v || "").trim().toUpperCase();
const jcReelMatches = (entry, sid, rid) =>
  (sid && String(entry.stockId) === sid) || (rid && jcNorm(entry.rollId) === rid);
const jcCompact = (parts) => parts.filter((p) => p != null && p !== "").join(" · ");
const POOL_ROLL_FIELD = { facestock: "fsRollId", adhesive: "adRollId", release: "rlRollId" };
const reelsOfRow = (row) => {
  const list = Array.isArray(row.materialsUsed) && row.materialsUsed.length
    ? row.materialsUsed.map((m) => ({ pool: m.pool, stockId: m.stockId, rollId: m.rollId }))
    : Object.entries(POOL_ROLL_FIELD)
        .map(([pool, f]) => (row[f] ? { pool, rollId: row[f] } : null))
        .filter(Boolean);
  return list.filter((r) => r && r.rollId);
};

// Adds reelDetails / madeAt / startTime / endTime to every Production Log row
// of the given (lean, populated) job cards.
async function decorateJobCards(jsonData) {
  const wantByPool = { facestock: new Set(), adhesive: new Set(), release: new Set() };
  for (const jc of jsonData) {
    for (const row of jc.productionLog || []) {
      for (const r of reelsOfRow(row)) {
        if (wantByPool[r.pool]) wantByPool[r.pool].add(jcNorm(r.rollId));
      }
    }
  }

  const [fsReels, adReels, rlReels] = await Promise.all([
    FacestockStock.find({ rollId: { $in: [...wantByPool.facestock] } }).select("rollId type size gsm micron").lean(),
    AdhesiveStock.find({ rollId: { $in: [...wantByPool.adhesive] } }).select("rollId type gsm").lean(),
    ReleaseLinerStock.find({ rollId: { $in: [...wantByPool.release] } }).select("rollId type color size gsm").lean(),
  ]);
  const specByRoll = new Map();
  for (const r of fsReels) specByRoll.set(jcNorm(r.rollId), jcCompact([r.type, r.gsm ? `${r.gsm} GSM` : "", r.micron ? `${r.micron} MIC` : "", r.size ? `${r.size} mm` : ""]));
  for (const r of adReels) specByRoll.set(jcNorm(r.rollId), jcCompact([r.type, r.gsm ? `${r.gsm} GSM` : ""]));
  for (const r of rlReels) specByRoll.set(jcNorm(r.rollId), jcCompact([r.type, r.color, r.gsm ? `${r.gsm} GSM` : "", r.size ? `${r.size} mm` : ""]));

  for (const jc of jsonData) {
    const usageByPool = {
      facestock: Array.isArray(jc.facestockUsage) ? jc.facestockUsage : [],
      adhesive: Array.isArray(jc.adhesiveUsage) ? jc.adhesiveUsage : [],
      release: Array.isArray(jc.releaseUsage) ? jc.releaseUsage : [],
    };
    const swaps = Array.isArray(jc.pendingProductionId?.materialSwapLog) ? jc.pendingProductionId.materialSwapLog : [];
    const logRows = Array.isArray(jc.productionLog) ? jc.productionLog : [];

    for (const row of logRows) {
      row.reelDetails = reelsOfRow(row).map((r) => {
        const sid = r.stockId ? String(r.stockId) : "";
        const rid = jcNorm(r.rollId);
        const usage = usageByPool[r.pool]?.find((u) => jcReelMatches(u, sid, rid));
        const swap = swaps.find((s) => s.pool === r.pool && jcReelMatches(s, sid, rid));
        let kg = null;
        if (usage) {
          const v = usage.kgUsed != null ? usage.kgUsed : usage.mtrsUsed;
          if (Number.isFinite(Number(v))) kg = Number(v);
        }
        if (kg == null && swap && Number.isFinite(Number(swap.usedKg))) kg = Number(swap.usedKg);
        if (kg != null) {
          const sharing = logRows.filter((rr) =>
            reelsOfRow(rr).some((x) => (x.pool || r.pool) === r.pool && jcReelMatches(x, sid, rid)));
          if (sharing.length > 1) {
            const totalMtrs = sharing.reduce((n, rr) => n + (Number(rr.meters) || 0), 0);
            const thisMtrs = Number(row.meters) || 0;
            kg = totalMtrs > 0 && thisMtrs > 0
              ? Math.round(kg * (thisMtrs / totalMtrs) * 100) / 100
              : Math.round((kg / sharing.length) * 100) / 100;
          } else {
            kg = Math.round(kg * 100) / 100;
          }
        }
        return {
          pool: r.pool || "",
          rollId: r.rollId || "",
          spec: specByRoll.get(rid) || "",
          kgUsed: kg,
          remark: swap?.reason ? String(swap.reason).trim() : "",
        };
      });
    }
  }

  // ---- When each Deckle was made. The Deckle (MaterialStock) is stamped the
  //      moment the operator punched Stop, so its createdAt is the date + time
  //      the Deckle Logs page shows. Start / End are the punches the card
  //      recorded ("1:23 PM"), falling back to the ones kept on the Deckle
  //      itself while the card is still unsaved. ----
  const deckleKeys = new Set();
  for (const jc of jsonData) {
    for (const row of jc.productionLog || []) {
      if (row?.deckleId) deckleKeys.add(jcNorm(row.deckleId));
    }
  }
  const madeDeckles = deckleKeys.size
    ? await MaterialStock.find({ rollId: { $in: [...deckleKeys] } }).select("rollId createdAt productionTime").lean()
    : [];
  const madeByDeckle = new Map(madeDeckles.map((d) => [jcNorm(d.rollId), d]));
  for (const jc of jsonData) {
    for (const row of jc.productionLog || []) {
      const made = row?.deckleId ? madeByDeckle.get(jcNorm(row.deckleId)) : null;
      row.madeAt = made?.createdAt || null;
      row.startTime = row.time?.startTime || made?.productionTime?.startTime || "";
      row.endTime = row.time?.endTime || made?.productionTime?.endTime || "";
    }
  }
  return jsonData;
}

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

// Browser offset (Date#getTimezoneOffset, minutes behind UTC) -> "+05:30" for
// Mongo's $dateToString, and the same offset in ms for building a day's range.
function readTzOffset(req) {
  const raw = Number(req.query.tz);
  const minutes = Number.isFinite(raw) && Math.abs(raw) <= 14 * 60 ? Math.round(raw) : 0;
  const east = -minutes; // getTimezoneOffset is positive WEST of UTC
  const sign = east < 0 ? "-" : "+";
  const abs = Math.abs(east);
  const pad = (n) => String(n).padStart(2, "0");
  return { minutes, east, label: `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}` };
}

// Page shell only -- no data.
router.get("/machine/jobcard/view", requireMachineFloor, (req, res) => {
  res.render("inventory/masters/jobCardView.ejs", {
    title: "Deckle Logs",
    CSS: "tableDisp.css",
    JS: false,
    notification: req.flash("notification"),
  });
});

// One line per day: deckles, production entries, metres. Newest day first.
router.get("/machine/jobcard/days", requireMachineFloor, async (req, res) => {
  try {
    const tz = readTzOffset(req);
    const rows = await MachineJobCard.aggregate([
      { $unwind: "$productionLog" },
      { $match: { $or: [{ "productionLog.deckleId": { $nin: [null, ""] } }, { "productionLog.meters": { $gt: 0 } }] } },
      { $addFields: { dk: { $toUpper: { $trim: { input: { $ifNull: ["$productionLog.deckleId", ""] } } } } } },
      {
        $lookup: {
          from: MaterialStock.collection.name,
          localField: "dk",
          foreignField: "rollId",
          pipeline: [{ $project: { createdAt: 1 } }],
          as: "mk",
        },
      },
      { $addFields: { stamp: { $ifNull: [{ $arrayElemAt: ["$mk.createdAt", 0] }, "$date"] } } },
      {
        $group: {
          _id: { $cond: [{ $ifNull: ["$stamp", false] }, { $dateToString: { format: "%Y-%m-%d", date: "$stamp", timezone: tz.label } }, null] },
          deckles: { $sum: 1 },
          cards: { $addToSet: "$_id" },
          meters: { $sum: { $ifNull: ["$productionLog.meters", 0] } },
        },
      },
      { $project: { _id: 0, key: "$_id", deckles: 1, cards: { $size: "$cards" }, meters: 1 } },
      { $sort: { key: -1 } },
    ]);
    // Undated rows (key null) sort last for the page.
    rows.sort((a, b) => (a.key === b.key ? 0 : !a.key ? 1 : !b.key ? -1 : a.key < b.key ? 1 : -1));
    res.json({ success: true, days: rows });
  } catch (err) {
    console.error("DECKLE LOGS DAYS ERROR:", err);
    res.status(500).json({ success: false, message: "Could not load the deckle logs." });
  }
});

// The deckles of ONE day, ready for the table (and each one's reel breakdown).
router.get("/machine/jobcard/day/:key", requireMachineFloor, async (req, res) => {
  try {
    const key = String(req.params.key || "");
    const undated = key === "none";
    if (!undated && !DAY_KEY_RE.test(key)) return res.status(400).json({ success: false, message: "Invalid day." });
    const tz = readTzOffset(req);

    let fromMs = 0;
    let toMs = 0;
    if (!undated) {
      const [y, m, d] = key.split("-").map(Number);
      fromMs = Date.UTC(y, m - 1, d) - tz.east * 60000; // local midnight, as a UTC instant
      toMs = fromMs + 24 * 60 * 60 * 1000;
    }
    const inDay = (ms) => (undated ? !ms : ms != null && ms >= fromMs && ms < toMs);

    // Cards that can hold a deckle of this day: those whose Deckle was made in
    // range, plus those whose own date is in range (rows with no Deckle).
    let cards = [];
    if (undated) {
      cards = await MachineJobCard.find({ $or: [{ date: null }, { date: { $exists: false } }] })
        .populate({ path: "pendingProductionId", select: "deckleSize materialSwapLog" }).lean();
    } else {
      const madeIds = (await MaterialStock.find({ createdAt: { $gte: new Date(fromMs), $lt: new Date(toMs) } })
        .select("rollId").lean()).map((d) => d.rollId);
      cards = await MachineJobCard.find({
        $or: [
          { "productionLog.deckleId": { $in: madeIds } },
          { date: { $gte: new Date(fromMs), $lt: new Date(toMs) } },
        ],
      }).populate({ path: "pendingProductionId", select: "deckleSize materialSwapLog" }).lean();
    }
    await decorateJobCards(cards);

    const rows = [];
    for (const jc of cards) {
      (jc.productionLog || []).forEach((r, idx) => {
        if (!r || !(r.deckleId || Number(r.meters) > 0)) return;
        const stampMs = r.madeAt ? new Date(r.madeAt).getTime() : (jc.date ? new Date(jc.date).getTime() : null);
        if (!inDay(stampMs)) return;
        const reelIds = [...new Set((r.reelDetails || []).map((d) => d.rollId)
          .concat([r.fsRollId, r.adRollId, r.rlRollId, r.rollId])
          .map((id) => String(id || "").trim()).filter(Boolean).map((id) => id.toUpperCase()))];
        rows.push({
          deckleId: r.deckleId || "",
          madeAt: r.madeAt || null,
          stamp: stampMs,
          jobCardId: jc.jobCardId,
          logIndex: idx,
          machineName: jc.machineName || "",
          productCode: r.productCode || jc.productCode || "",
          lotNo: jc.lotNo || "",
          deckleSize: jc.pendingProductionId?.deckleSize ?? null,
          meters: r.meters ?? null,
          startTime: r.startTime || "",
          endTime: r.endTime || "",
          rollIdUsed: reelIds.join(", "),
          operatorName: jc.operatorName || "",
          helperName: jc.helperName || "",
          detail: { deckleId: r.deckleId || "", productCode: r.productCode || jc.productCode || "", meters: r.meters ?? null, face: r.face || null, release: r.release || null, reelDetails: r.reelDetails || [] },
        });
      });
    }
    rows.sort((a, b) => (b.stamp || 0) - (a.stamp || 0));
    res.json({ success: true, rows });
  } catch (err) {
    console.error("DECKLE LOGS DAY ERROR:", err);
    res.status(500).json({ success: false, message: "Could not load this day." });
  }
});

export default router;
