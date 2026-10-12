import express from "express";
import mongoose from "mongoose";
import { randomUUID } from "crypto";
import SachikoLabelStock from "../../models/sachiko/sachikoLabelStock.js";
import PendingProduction from "../../models/inventory/pendingProduction.js";
import MaterialStock from "../../models/inventory/materialStock.js";
import MaterialStockLog from "../../models/inventory/materialStockLog.js";
import FinishedStock from "../../models/inventory/finishedStock.js";
import FinishedStockLog from "../../models/inventory/finishedStockLog.js";
import SlittingJobCard from "../../models/inventory/slittingJobCard.js";
import Machine from "../../models/system/machine.js";
import Employee from "../../models/hr/employee_model.js";
import Counter from "../../models/system/counter.js";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import { createLimiter, updateLimiter } from "../../utils/limiters.js";
import { notifyOperatorQueue } from "../../utils/operatorEvents.js";
import { findScannedReel } from "../../utils/rollId.js";
// The code every generated id starts with -- the Company master's own
// (utils/companyBrand.js), read live so a rename needs no restart.
import { currentIdPrefix } from "../../utils/companyBrand.js";
import { normalizeLocationName } from "../../utils/locations.js";
// The Slitting WIP page's live run plan -- the slitting sibling of buildRunPlan
// (same output contract, measured per Deckle). See utils/productionEta.js.
import { buildSlittingRunPlan, SLITTING_SPEED_MPM } from "../../utils/productionEta.js";

const router = express.Router();

// ----------------------------------Slitting---------------------------------->
//
// The step after lamination. The machine job card (routes/system/machine.js)
// turns raw reels into Deckles -- full-width laminated webs in Semi Finished
// Goods (MaterialStock). Slitting cuts one of those webs into the finished
// roll widths a client order asked for, which land in Finished Goods
// (FinishedStock).
//
// Split in two, the same way Assign Production and the Machine Job Card are:
//
//   PLANNER  /slitting/allocate/:pendingId?deckle=<stockId>[&deckle=<stockId>...]
//     Deckle-scoped -- opened from the Slitting Queue's "Choose Deckle"
//     dialog for one or more Deckles (one row per Deckle). Picks the
//     machine, operator and helper shared by all of them, and per Deckle its
//     web width, the metres to run off it, the length per finished roll and
//     the A..L knife layout. Writes one "allocated" SlittingJobCard per
//     Deckle, which puts each on the chosen machine's queue. Nothing moves
//     in stock.
//
//   OPERATOR /slitting/jobcard/:cardId
//     Reached off their machine queue. Per Deckle: scan the reel to confirm
//     it, Start, Stop, confirm the metres that actually ran. Each Stop inwards
//     that row's finished rolls and draws the metres off the Deckle.
//
// This router is mounted on the bare "/app" prefix ahead of the
// role-gated routers (see server.js), so like machine.js every route carries
// its own gate; operators are admitted to the job card because slitting is
// shop-floor work, but never to allocation.
const requireSlittingPlanner = requireRole(["proprietor", "admin", "hod"]);
const requireSlittingFloor = requireRole(["proprietor", "admin", "hod", "operator"]);
const requireSlittingView = requireRole(["proprietor", "admin", "hod", "sales", "operator"]);

// Knife positions across one Deckle web -- exactly the columns on the paper
// card.
export const CUT_SLOTS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"];

// Machine.machineType is free text (see models/system/machine.js), so slitters
// are matched on the stem rather than an exact string -- "SLITTING",
// "SLITTER" and "SLITTING MACHINE" all read as one. Deliberately narrow: the
// other types in use ("COATING", "SHEET CUT") do not contain it.
const SLITTING_MACHINE_RE = /SLIT/i;

const trim = (value) => String(value ?? "").trim();
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const numOrNull = (value) => {
  if (value === undefined || value === null || trim(value) === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

// ---- Deckle layouts ------------------------------------------------------->
// A "layout" is one A..L knife pattern the Set Deckle planner drew for a batch
// (PendingProduction.deckleLayout). It matters on the Slitting Queue because a
// single deckle width can be planned with SEVERAL different patterns: those
// webs are physically identical but they are not interchangeable jobs -- each
// has to be cut to its own pattern -- so the queue keys a row on the layout as
// well as the Product Code, width and roll length, and one row is one cut job.
//
// Identity is the multiset of roll widths, not the slot letters: A/B/C and
// B/A/C cut the same web, and the slitting card's own row is often typed in a
// different order than the plan was.
export function cutsSignature(cuts) {
  const widths = (Array.isArray(cuts) ? cuts : [])
    .map((c) => Number(c?.width))
    .filter((w) => Number.isFinite(w) && w > 0)
    .map((w) => round2(w))
    .sort((a, b) => a - b);
  return widths.length ? widths.join("+") : "";
}

// Deckle widths reach here as Strings on the reel ("635") and Numbers on the
// layout (635), so every width used as a map key goes through this.
const widthKey = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && trim(value) !== "" ? String(round2(n)) : trim(value);
};

// Grace (Set Deckle): spare web that would have been scrapped as side trim is
// shared out over a layout's rolls instead, so a roll is CUT wider than it was
// ordered. The client is still billed the width they ordered, so the two have
// to stay paired all the way to the finished roll
// (PendingProduction.deckleLayout[].cuts[].orderedWidth).
//
// The allocation grid only ever sends widths -- the browser has no idea a width
// is graced -- so the pairing is resolved here, server-side, off the batch's own
// plan. Keyed on the cut width, which is all a saved row carries.
//
// A cut width that two layouts grace from DIFFERENT ordered widths is ambiguous
// and is dropped: falling back to the width physically made is a defensible
// bill, guessing between two client widths is not.
function gracedWidthMap(pending) {
  const byCut = new Map();
  for (const L of Array.isArray(pending?.deckleLayout) ? pending.deckleLayout : []) {
    for (const c of Array.isArray(L?.cuts) ? L.cuts : []) {
      const cut = Number(c?.width);
      const ordered = Number(c?.orderedWidth);
      if (!(cut > 0) || !(ordered > 0) || !(cut - ordered > 0.005)) continue;
      const key = widthKey(cut);
      if (!byCut.has(key)) byCut.set(key, ordered);
      else if (byCut.get(key) !== ordered) byCut.set(key, null);
    }
  }
  return byCut;
}

// The ordered width behind a cut width, or null when it was never graced (or is
// ambiguous) -- in which case the cut width IS the ordered width.
function orderedWidthFor(map, width) {
  const v = map.get(widthKey(width));
  return Number(v) > 0 ? Number(v) : null;
}

// One order's planned layouts, in the order they were planned. `width` is the
// width THAT layout is cut from -- a mixed-web batch runs several (see
// PendingProduction.deckleLayout) -- falling back to the batch's own.
function pendingLayouts(pending) {
  const list = Array.isArray(pending?.deckleLayout) ? pending.deckleLayout : [];
  return list
    .filter((L) => Array.isArray(L.cuts) && L.cuts.length)
    .map((L) => {
      const own = Number(L.deckleSize);
      const width = own > 0 ? own : Number(pending?.deckleSize);
      return {
        width: Number.isFinite(width) && width > 0 ? widthKey(width) : "",
        sig: cutsSignature(L.cuts),
        // `orderedWidth` rides along wherever the Set Deckle planner gave the
        // roll some of the web's side trim: the knife is set to `width`, the
        // client ordered -- and is billed -- `orderedWidth`. Dropping it here
        // is what left the slitting side with no way to say how much grace a
        // layout carries: the queue showed a 157.5 mm knife on a 150 mm order
        // as if 157.5 were the order. Kept only when it is a real width BELOW
        // the cut, the same test normCuts applies when it is stored
        // (routes/fairdesk_route.js) and produceRollsFromCard when it bills.
        cuts: L.cuts
          .filter((c) => Number(c?.width) > 0)
          .map((c) => {
            const cut = round2(c.width);
            const ordered = Number(c?.orderedWidth);
            const graced = ordered > 0 && cut - ordered > 0.005;
            return graced
              ? { slot: trim(c.slot), width: cut, orderedWidth: round2(ordered) }
              : { slot: trim(c.slot), width: cut };
          }),
        count: Math.max(1, Math.floor(Number(L.count) || 1)),
        plannedRunningMeter: L.plannedRunningMeter ?? null,
        // Total edge trim (both edges) the planner fitted these cuts inside,
        // so the queue can draw the layout against the full web the way the
        // Set Deckle and Allocate pages do. Null where the batch stored none:
        // the Allocate page's own 10 mm default is that page's input default,
        // not a fact about this batch, so the view shows no edge rather than
        // inventing one. Note Number(null) is 0, hence the explicit check.
        trim: pending?.deckleTrim != null && Number(pending.deckleTrim) >= 0
          ? round2(pending.deckleTrim)
          : null,
      };
    })
    .filter((L) => L.sig && L.width);
}
// <------------------------------------------------------- Deckle layouts ---

// ---- Deckle curing -------------------------------------------------------->
// After lamination the adhesive has to cure before the web can be slit --
// counted from the moment the Deckle (MaterialStock reel) was created, for as
// long as its facestock family needs: CHROMO 6 h, PP 8 h. A family not listed
// takes DEFAULT_CURING_HOURS. A build whose every adhesive layer is hot melt
// sets on contact and is exempt whatever the family. The PLANNER's allocation
// is deliberately NOT gated on this (a job can be planned while the reel
// cures); the OPERATOR's run IS -- Start and Stop on the slitting job card
// refuse an un-cured Deckle, and the machine / operator queues flag it.
const CURING_HOURS_BY_FAMILY = [
  { re: /\bPP\b/, hours: 8 },
  { re: /\bCHROMO\b/, hours: 6 },
];
const DEFAULT_CURING_HOURS = 6;
const HOT_MELT_RE = /HOT\s*-?\s*MELT/i;

// What deckleCuring() reads off a reel's populated `material`. Any query whose
// reels are passed to deckleCuring() must populate at least these -- without
// the family every Deckle silently falls back to DEFAULT_CURING_HOURS.
const CURING_MATERIAL_FIELDS =
  "family rollType facestock.facestockFamily facestock2.facestockFamily adhesive adhesive2";

// Hours this build needs. The Label Stock's own Family and its facestock's
// family normally agree; where they don't (or a DOUBLE FACESTOCK pairs two
// families) the longest wait wins, so a web is never run early.
function curingHoursFor(material) {
  const families = [material?.family, material?.facestock?.facestockFamily];
  if (material?.rollType === "DOUBLE FACESTOCK") families.push(material?.facestock2?.facestockFamily);
  let hours = null;
  for (const family of families.map((f) => trim(f).toUpperCase()).filter(Boolean)) {
    const hit = CURING_HOURS_BY_FAMILY.find((e) => e.re.test(family));
    if (hit) hours = Math.max(hours ?? 0, hit.hours);
  }
  return hours ?? DEFAULT_CURING_HOURS;
}

// Exempt only when there is at least one adhesive layer and EVERY layer
// present is hot melt -- a waterbase + hotmelt double build still cures.
function adhesiveExemptFromCuring(material) {
  const types = [material?.adhesive?.adhesiveType, material?.adhesive2?.adhesiveType]
    .map((t) => trim(t))
    .filter(Boolean);
  return types.length > 0 && types.every((t) => HOT_MELT_RE.test(t));
}

// { hotMelt, hours, curedAt: Date|null, cured: bool } for one Deckle reel. A
// reel with no createdAt (pre-timestamps legacy stock) is treated as cured.
function deckleCuring(reel, at = Date.now()) {
  const hotMelt = adhesiveExemptFromCuring(reel?.material);
  const hours = hotMelt ? 0 : curingHoursFor(reel?.material);
  const createdAt = reel?.createdAt ? new Date(reel.createdAt) : null;
  const curedAt = hotMelt || !createdAt
    ? null
    : new Date(createdAt.getTime() + hours * 3600 * 1000);
  const cured = !curedAt || at >= curedAt.getTime();
  return { hotMelt, hours, curedAt, cured };
}

// Short "ready at 14:30 (about 2 h 10 min from now)" tail for messages/labels.
function curingWhenLabel(curedAt, at = Date.now()) {
  if (!curedAt) return "";
  const d = new Date(curedAt);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const sameDay = d.toDateString() === new Date(at).toDateString();
  return sameDay ? `${hh}:${mm}` : `${hh}:${mm}, ${d.toLocaleDateString("en-IN")}`;
}

function curingBlockedMessage(rollId, curedAt, hours) {
  const mins = Math.max(0, Math.round((new Date(curedAt).getTime() - Date.now()) / 60000));
  const left = mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`;
  const gateMins = Math.round(hours * 60);
  const gate = gateMins >= 60 ? `${hours} h` : `${gateMins} min`;
  return `Deckle ${rollId} is still curing (${gate} after lamination) — ready at `
    + `${curingWhenLabel(curedAt)}, about ${left} from now. Only fully hot-melt Deckles skip curing.`;
}
// <----------------------------------Deckle curing --------------------------

// Same `<ID> | <CODE> | 000001` scheme as the machine job card's own ids.
async function generateSlittingId() {
  const counter = await Counter.findOneAndUpdate(
    { key: "slittingJobCardId" },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();
  return `${currentIdPrefix()} | SJC | ${String(counter.seq).padStart(6, "0")}`;
}

async function previewSlittingId() {
  const counter = await Counter.findOne({ key: "slittingJobCardId" }).select("seq").lean();
  return `${currentIdPrefix()} | SJC | ${String(Number(counter?.seq || 0) + 1).padStart(6, "0")}`;
}

const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Matches a Product Code and its raw-material-brand variants ("C003WB",
// "C003WB-A", "C003WB-E", ...). The suffix only records which brand of raw
// material a Deckle was laminated from -- for tracing a client defect back --
// so for slitting a "C003WB" order every "C003WB-*" Deckle is the same
// product. A genuinely different code ("C014AC") is not.
function productCodeBase(productCode) {
  const code = trim(productCode);
  if (!code) return "";
  return /^(.*[^-])-[A-Z]+$/.exec(code)?.[1] || code;
}

function productCodeFamilyRe(productCode) {
  const base = productCodeBase(productCode);
  if (!base) return null;
  return new RegExp(`^${escapeRegExp(base)}(-[A-Z]+)?$`);
}

// Every Label Stock row in one Product Code's variant family.
async function labelStockFamilyIds(productCode) {
  const re = productCodeFamilyRe(productCode);
  if (!re) return [];
  const rows = await SachikoLabelStock.find({ productCode: re }).select("_id").lean();
  return rows.map((r) => r._id);
}

// Deckles this order may be slit from, richest link first:
//   1. produced for it (the job-card path stamps MaterialStock.producedFor),
//   2. ticked onto it on Assign Production (allottedRollIds, older flow),
//   3. any other Deckle of the same Product Code still in stock -- the floor
//      routinely finishes an order off a web laminated on an earlier run.
// Every offered reel must carry the order's Product Code (its brand variants
// included): the producedFor / allotted links are NOT trusted blindly -- a
// mislinked reel of a different code must never surface here, because the
// finished rolls are named after the Deckle. Only reels that still carry
// metres are offered.
async function deckleOptionsFor(pending) {
  const orderCode = trim(pending?.itemId?.productCode || pending?.itemId?.skuCode);
  const familyIds = await labelStockFamilyIds(orderCode);
  const or = [{ producedFor: pending._id }];
  const allotted = Array.isArray(pending.allottedRollIds) ? pending.allottedRollIds : [];
  if (allotted.length) or.push({ _id: { $in: allotted } });
  if (familyIds.length) or.push({ material: { $in: familyIds } });

  const reels = await MaterialStock.find({ $or: or, reelMtrs: { $gt: 0 }, quantity: { $gt: 0 } })
    .populate({ path: "material", select: `productCode skuCode ${CURING_MATERIAL_FIELDS}` })
    .sort({ createdAt: 1 })
    .lean();

  const familySet = new Set(familyIds.map(String));
  const codeRe = productCodeFamilyRe(orderCode);
  const inFamily = (r) => {
    const mid = r.material?._id ? String(r.material._id) : String(r.material || "");
    if (familySet.has(mid)) return true;
    const code = trim(r.material?.productCode || r.material?.skuCode);
    return codeRe && code ? codeRe.test(code) : false;
  };

  const allottedSet = new Set(allotted.map(String));
  return (codeRe ? reels.filter(inFamily) : reels).map((r) => {
    const cure = deckleCuring(r);
    return {
      _id: String(r._id),
      rollId: r.rollId,
      reelMtrs: round2(Number(r.reelMtrs) || 0),
      // When this web was laminated -- shown beside it on the allocate page.
      createdAt: r.createdAt || null,
      // The Deckle web's own width as recorded when it was laminated; falls
      // back to the order's paper size for reels made before it was stored.
      size: r.size || pending.paperSize || "",
      location: r.location || "",
      lotNo: r.lotNo || "",
      productCode: r.material?.productCode || r.material?.skuCode || "",
      // Whether this reel belongs to the order or was pulled off general stock
      // -- the picker groups on it.
      ownOrder: String(r.producedFor || "") === String(pending._id) || allottedSet.has(String(r._id)),
      // Advisory only on allocation -- the plan can be made now, but the
      // operator can't run it until this clears.
      curing: {
        hotMelt: cure.hotMelt,
        hours: cure.hours,
        cured: cure.cured,
        curedAt: cure.curedAt ? cure.curedAt.toISOString() : null,
        curedAtLabel: cure.curedAt ? curingWhenLabel(cure.curedAt) : "",
      },
    };
  });
}

// ---- Deckle numbering across a layout's run --------------------------------
//
// One Slitting Job Card is ONE Deckle (see the allocation POST below: each
// ticked Deckle gets its own card), so "5 Deckles cut 210 + 210 + 210" is five
// cards allocated in one submit -- and every Deckle slit takes its card off the
// queue, because the card auto-completes at its own Stop.
//
// The floor counts Deckles by the knife setting, not by the card and not by the
// Product Code: what the operator wants to read is "6 of 10 on this layout",
// and that count has to keep running when more work arrives for a setting
// already up on the machine.
//
// A LAYOUT RUN is therefore every Deckle -- slit or still to run -- at one
// knife layout on one machine, chained through overlapping allocations: a card
// joins the run of the card before it when that one was still open at the
// moment this one was allocated. The chain breaks wherever the layout ran dry
// (nothing of it open when the next card came), and that break is what starts
// the numbering over -- so the count runs "until the layout is finished" and
// no further. Product Code is deliberately NOT part of the key: the knife
// setting is the same whatever is being cut on it.
//
// Positions are handed out in allocation order and never move, so a Deckle slit
// early keeps its number and the ones still to run read 3/10, 4/10, ... as more
// work lands on the same layout. Finished cards are off the queue but still
// counted, which is what makes the denominator grow instead of resetting.
//
// How far back finished cards are chased. A run ends by itself when the machine
// runs out of that layout, so this only bounds the query -- every finished card
// the machine ever had would otherwise be read on each queue load. A single
// knife setting is not kept continuously fed for two months.
const LAYOUT_RUN_LOOKBACK_DAYS = 60;

// The cut patterns a card's Deckles run, as label -> how many of its Deckles
// run it. One builder so the queue's layout summary and the run's pool key can
// never drift apart.
function layoutGroupsOf(rows) {
  const groups = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    const widths = (Array.isArray(r.cuts) ? r.cuts : [])
      .map((cut) => Number(cut.width))
      .filter((w) => w > 0);
    if (!widths.length) continue;
    const label = widths.map((w) => (w % 1 ? w.toFixed(2) : String(w))).join(" + ");
    groups.set(label, (groups.get(label) || 0) + 1);
  }
  return groups;
}

const layoutKeyOf = (rows) => [...layoutGroupsOf(rows).keys()].sort().join("  |  ");

// Where each of `openCards` sits in its layout run:
//   Map<cardId, { from, total, done, plannedRolls, producedRolls }>
// `from` is the position of the card's FIRST Deckle, so its i-th Deckle is at
// `from + i`. Pools are keyed on machine + layout and are read across every
// card on that machine, not just the ones `match` selected -- an operator
// looking at their own cards must still see the machine's own numbering.
async function buildLayoutRuns(openCards) {
  const machineIds = [
    ...new Set(openCards.map((c) => String(c.machineId || "")).filter((id) => mongoose.isValidObjectId(id))),
  ];
  if (!machineIds.length) return new Map();

  const since = new Date(Date.now() - LAYOUT_RUN_LOOKBACK_DAYS * 86400000);
  const cards = await SlittingJobCard.find({
    machineId: { $in: machineIds.map((id) => new mongoose.Types.ObjectId(id)) },
    // Open cards are never windowed out (one of them may be what we are
    // numbering); only finished ones are, and those just pad the count.
    $or: [{ status: "allocated" }, { status: "completed", createdAt: { $gte: since } }],
  })
    .select("machineId status createdAt completedAt slittingLog.status slittingLog.cuts.width")
    .sort({ createdAt: 1, _id: 1 })
    .lean();

  // machine + layout -> its cards, oldest allocation first. A card whose
  // Deckle has no recorded cuts has no layout to share, so it pools alone.
  const pools = new Map();
  for (const c of cards) {
    const layout = layoutKeyOf(c.slittingLog);
    const key = `${String(c.machineId)}\u0000${layout || `none-${String(c._id)}`}`;
    if (!pools.has(key)) pools.set(key, []);
    pools.get(key).push(c);
  }

  const openIds = new Set(openCards.map((c) => String(c._id)));
  const out = new Map();
  for (const list of pools.values()) {
    if (!list.some((c) => openIds.has(String(c._id)))) continue;

    // The run in progress: walk back from the newest card while each card's
    // predecessor was still open when that card was allocated. An open card is
    // always inside this last chain -- it has been open ever since it was
    // allocated, so the layout cannot have run dry after it.
    let start = list.length - 1;
    while (start > 0) {
      const prev = list[start - 1];
      const openThen =
        prev.status !== "completed" ||
        !prev.completedAt ||
        new Date(prev.completedAt).getTime() >= new Date(list[start].createdAt).getTime();
      if (!openThen) break;
      start -= 1;
    }
    const run = list.slice(start);

    const rowsOf = (c) => (Array.isArray(c.slittingLog) ? c.slittingLog : []);
    const cuts = (r) => (Array.isArray(r.cuts) ? r.cuts.length : 0);
    const total = run.reduce((n, c) => n + rowsOf(c).length, 0);
    const done = run.reduce((n, c) => n + rowsOf(c).filter((r) => r.status === "done").length, 0);
    const plannedRolls = run.reduce((n, c) => n + rowsOf(c).reduce((m, r) => m + cuts(r), 0), 0);
    const producedRolls = run.reduce(
      (n, c) => n + rowsOf(c).filter((r) => r.status === "done").reduce((m, r) => m + cuts(r), 0),
      0,
    );

    let pos = 0;
    for (const c of run) {
      const from = pos + 1;
      pos += rowsOf(c).length;
      if (openIds.has(String(c._id))) {
        out.set(String(c._id), { from, total, done, plannedRolls, producedRolls });
      }
    }
  }
  return out;
}

// Every open slitting job on a machine / for an operator, in the shape the
// queue pages render. Exported so routes/system/machine.js can fold slitting
// jobs into the machine and operator queues without re-deriving any of it.
export async function buildSlittingQueueRows(match) {
  const cards = await SlittingJobCard.find({ status: "allocated", ...match })
    .sort({ createdAt: 1 })
    .lean();

  // Curing state of every Deckle still to run on these cards -- the operator
  // can't work a card until its pending Deckles have cured.
  const pendingDeckleIds = [
    ...new Set(
      cards.flatMap((c) =>
        (c.slittingLog || [])
          .filter((r) => r.status !== "done")
          .map((r) => String(r.deckleStockId || ""))
          .filter(Boolean),
      ),
    ),
  ];
  const cureReels = pendingDeckleIds.length
    ? await MaterialStock.find({ _id: { $in: pendingDeckleIds } })
        .select("createdAt rollId")
        .populate({ path: "material", select: CURING_MATERIAL_FIELDS })
        .lean()
    : [];
  const cureByReel = new Map(cureReels.map((r) => [String(r._id), deckleCuring(r)]));

  // Deckle numbering across each layout's run -- see buildLayoutRuns.
  const runs = await buildLayoutRuns(cards);

  return cards.map((c) => {
    const rows = Array.isArray(c.slittingLog) ? c.slittingLog : [];
    const done = rows.filter((r) => r.status === "done").length;

    const uncured = rows
      .filter((r) => r.status !== "done")
      .map((r) => cureByReel.get(String(r.deckleStockId)))
      .filter((info) => info && !info.cured && info.curedAt);
    const curingUntil = uncured.reduce(
      (max, info) => Math.max(max, new Date(info.curedAt).getTime()),
      0,
    );

    const undoBlock = slittingUndoBlock(c);
    const run = runs.get(String(c._id)) || null;

    // The knife layout(s) this card's Deckles are cut to -- one line per
    // distinct cut pattern, its roll widths and how many Deckles run it.
    // Each slittingLog row carries its own `cuts` (set at allocation from the
    // batch's deckleLayout, see Slitting Allocation), so a card can in theory
    // mix patterns even though the common case is one pattern across every
    // row. Grouped so the queue shows "150 + 200 + 150 × 8" rather than
    // repeating the same pattern once per Deckle.
    const layoutGroups = layoutGroupsOf(rows);
    const layoutSummary = [...layoutGroups.entries()]
      .map(([label, n]) => `${label}${n > 1 ? ` × ${n}` : ""}`)
      .join("  |  ");

    return {
      _id: String(c._id),
      slittingJobCardId: c.slittingJobCardId,
      // Undo (see slittingUndoBlock): offered only while nothing has run.
      canUndo: !undoBlock,
      undoBlockedReason: undoBlock || "",
      // For the queue's Edit button -- reopens exactly the Allocate page this
      // card was created from (routes/system/slitting.js "/slitting/allocate").
      pendingProductionId: c.pendingProductionId ? String(c.pendingProductionId) : "",
      deckleStockId: rows[0]?.deckleStockId ? String(rows[0].deckleStockId) : "",
      machineId: String(c.machineId || ""),
      machineName: c.machineName || "",
      lotNo: c.lotNo || "—",
      clientOrderNo: c.clientOrderNo || "—",
      productCode: c.productCode || "—",
      clientName: c.clientName || "—",
      operatorName: c.operatorName || "—",
      helperName: c.helperName || "—",
      layoutSummary,
      // The cut pattern(s) alone, without the "× n" Deckle counts -- two cards
      // cut to the same pattern share this key whatever their Deckle counts
      // (the machine queue folds them into one expandable row).
      layoutKey: layoutKeyOf(rows),
      deckleCount: rows.length,
      deckleDone: done,
      deckleLeft: rows.length - done,
      // This card's place in its layout's run (buildLayoutRuns): the Deckles
      // of every card at this knife layout on this machine, counted as one
      // series across cards and Product Codes, finished cards included. This
      // is what the queues count in ("6 of 10"), NOT the card's own
      // deckleCount/deckleDone above, which only ever describe this one card.
      // Absent only if the card somehow fell out of its own pool -- the card's
      // own figures then stand in, so a reader never sees a blank.
      layoutRunTotal: run ? run.total : rows.length,
      layoutRunDone: run ? run.done : done,
      layoutRunPlannedRolls: run ? run.plannedRolls : 0,
      layoutRunProducedRolls: run ? run.producedRolls : 0,
      // Each Deckle's id and whether it has run -- additive, read only by the
      // operator app's queue, which bundles same-layout cards into one tile and
      // uses these to find which card a scanned Deckle belongs to.
      deckles: rows.map((r, i) => ({
        id: r.deckleId || "",
        done: r.status === "done",
        // On the slitter now (same test the WIP page uses for its live Deckle).
        running: r.status !== "done" && !!r.startedAt,
        // 1-based place in the layout run -- the "6" of "6 of 10". Positions
        // are fixed at allocation order, so they never move under a reader.
        pos: run ? run.from + i : i + 1,
      })),
      // Rolls this card will produce once every row is run.
      plannedRolls: rows.reduce((n, r) => n + (Array.isArray(r.cuts) ? r.cuts.length : 0), 0),
      producedRolls: rows
        .filter((r) => r.status === "done")
        .reduce((n, r) => n + (Array.isArray(r.cuts) ? r.cuts.length : 0), 0),
      // A Deckle still to run has not finished curing -- the card can be
      // opened but not run yet.
      curing: uncured.length > 0,
      curingUntilLabel: curingUntil ? curingWhenLabel(curingUntil) : "",
      // True once the operator has actually punched Start on a row that
      // hasn't been Stopped yet -- as opposed to a card that is merely
      // allocated and still sitting untouched on the machine's queue. Used
      // to separate "/slitting/wip" (running right now) from the machine
      // queue (every allocated card, run or not).
      running: rows.some((r) => r.status !== "done" && !!r.startTime),
    };
  });
}

// Every Deckle web still carrying metres and still free to allocate (or
// re-allocatable after a completed card left metres behind), across every
// order -- the flat, per-Deckle facts the Slitting Queue clubs into groups
// AND, filtered down to one Product Code + Size + Running Meters, what the
// Allocate page below counts as "this batch"'s Total/Available. Kept as one
// function so the two pages can never disagree on which Deckles club
// together or how many of them are actually still free.
async function buildAvailableDeckleRows({ includeHeld = false } = {}) {
  const [orders, reels] = await Promise.all([
    PendingProduction.find({ deckleBatchId: null })
      .populate({ path: "itemId", select: "productCode skuCode" })
      .populate({ path: "userId", select: "clientName userName" })
      .sort({ assignedAt: -1, createdAt: -1 })
      .lean(),
    MaterialStock.find({ reelMtrs: { $gt: 0 }, quantity: { $gt: 0 } })
      .populate({ path: "material", select: `productCode skuCode ${CURING_MATERIAL_FIELDS}` })
      .select("material producedFor reelMtrs rollId size location lotNo createdAt")
      .sort({ location: 1, rollId: 1 })
      .lean(),
  ]);

  const pendingById = new Map(orders.map((o) => [String(o._id), o]));

  // Product Code -> the Label Stock material ids in its variant family.
  const codes = [...new Set(orders.map((o) => trim(o.itemId?.productCode || o.itemId?.skuCode)).filter(Boolean))];
  const familyByCode = new Map();
  for (const code of codes) familyByCode.set(code, new Set((await labelStockFamilyIds(code)).map(String)));

  // Which order a loose Deckle (no producedFor) belongs to, matched on its
  // Label Stock being ticked onto the order or sharing its Product Code family.
  const orderForReel = (reel) => {
    const direct = reel.producedFor && pendingById.get(String(reel.producedFor));
    if (direct) return { order: direct, by: "producedFor" };
    const rid = String(reel._id);
    const allottedTo = orders.find((o) => (o.allottedRollIds || []).some((x) => String(x) === rid));
    if (allottedTo) return { order: allottedTo, by: "allotted" };
    const mid = reel.material?._id ? String(reel.material._id) : String(reel.material || "");
    const byCode = orders.find((o) => {
      const code = trim(o.itemId?.productCode || o.itemId?.skuCode);
      return familyByCode.get(code)?.has(mid);
    });
    if (byCode) return { order: byCode, by: "productCode" };
    return { order: null, by: null };
  };

  // Every Deckle already named on a Slitting Job Card row, so the queue can
  // flag it -- "on <card>", or slit if that row / card is finished.
  const cards = await SlittingJobCard.find({ status: { $in: ["allocated", "completed"] } })
    .select("slittingJobCardId pendingProductionId machineName operatorName status slittingLog")
    .lean();
  const deckleCard = new Map();
  for (const c of cards) {
    for (const lr of c.slittingLog || []) {
      const k = String(lr.deckleStockId || "");
      if (!k) continue;
      const run = lr.status === "done" || c.status === "completed";
      const prev = deckleCard.get(k);
      // An open (unrun) allocation wins over a finished one.
      if (!prev || (prev.run && !run)) {
        deckleCard.set(k, {
          slittingJobCardId: c.slittingJobCardId,
          machineName: c.machineName || "—",
          operatorName: c.operatorName || "—",
          run,
        });
      }
    }
  }

  // Deckles a scan swapped OFF a card (see swapSlittingDeckle). The planner's
  // allocation for these was replaced by another web, so they are free stock
  // with no job on them -- the queue names the card they came off so the
  // planner can see the web was meant for a job and put it back on one. Only
  // the newest removal per web is kept.
  const cameOff = new Map();
  for (const c of cards) {
    for (const lr of c.slittingLog || []) {
      for (const s of lr.swappedFrom || []) {
        const k = String(s.deckleStockId || "");
        if (!k) continue;
        const prev = cameOff.get(k);
        if (!prev || new Date(s.at || 0) >= new Date(prev.at || 0)) {
          cameOff.set(k, {
            slittingJobCardId: s.slittingJobCardId || c.slittingJobCardId || "",
            at: s.at || null,
            by: s.by || "",
          });
        }
      }
    }
  }

  // Webs of each planned layout already spoken for: every Slitting Job Card
  // row -- merely allocated or fully run -- counted against the order and the
  // layout it cuts. This is what tells the queue how many webs a layout still
  // wants, so the Deckles left in stock go to the layouts that have not had
  // theirs yet instead of always filling the first one planned.
  //
  // Keyed on the order + cut signature and deliberately NOT on the web width:
  // a card row's `width` is the CUTTABLE width (the deckle less its edge trim
  // -- 200 on a 210 mm reel), while a layout's is the deckle width, so keying
  // on it matched nothing and every layout read as though none of its webs had
  // been allocated yet. The cut signature alone identifies a layout within one
  // order; two layouts of the same order with identical roll widths on
  // different webs would share a count, which is the same plan cut twice over.
  const slitByLayout = new Map();
  for (const c of cards) {
    const pid = String(c.pendingProductionId || "");
    if (!pid) continue;
    for (const lr of c.slittingLog || []) {
      const sig = cutsSignature(lr.cuts);
      if (!sig) continue;
      const k = `${pid}::${sig}`;
      slitByLayout.set(k, (slitByLayout.get(k) || 0) + 1);
    }
  }

  const rows = reels.map((reel) => {
    const { order, by } = orderForReel(reel);
    const card = deckleCard.get(String(reel._id)) || null;
    const cure = deckleCuring(reel);
    // The length wound onto each finished roll for this order -- same field
    // the Allocate page seeds its R. Meter default from (see GET
    // "/slitting/allocate/:pendingId" below). Two Deckles of the same
    // Product Code + Size but different running meters still need separate
    // cut plans, so this is part of what clubs them on this queue.
    const runningMeters = order ? (order.deckleRunningMeters ?? order.runningMeters ?? null) : null;
    return {
      deckleStockId: String(reel._id),
      rollId: reel.rollId || "—",
      // The reel's own code, suffix and all -- it names the finished rolls and
      // traces a defect back to the raw material brand.
      productCode: trim(reel.material?.productCode || reel.material?.skuCode) || "—",
      // ...and the variant family it belongs to, which is what the Slitting
      // Queue clubs on: "C001WB-A" and "C001WB" are one product to slit.
      productCodeBase: productCodeBase(reel.material?.productCode || reel.material?.skuCode) || "—",
      mtrs: round2(Number(reel.reelMtrs) || 0),
      size: reel.size || "—",
      runningMeters,
      location: reel.location || "—",
      lotNo: reel.lotNo || "",
      // When this web was laminated -- the Deckle's own date/time on the queue.
      createdAt: reel.createdAt || null,
      // Advisory: a Deckle can be allocated while it cures, but not run.
      curing: !cure.cured,
      curingUntilLabel: cure.curedAt && !cure.cured ? curingWhenLabel(cure.curedAt) : "",
      // ISO so the client can render (and tick down) a live "ready in Xh Ym"
      // countdown alongside the fixed clock-time label above.
      curingUntil: cure.curedAt && !cure.cured ? cure.curedAt.toISOString() : null,
      hotMelt: cure.hotMelt,
      order: order
        ? {
            _id: String(order._id),
            lotNo: order.lotNo || "—",
            clientOrderNo: order.poNumber || "—",
            clientName: order.userId?.clientName || order.userId?.userName || "—",
            runningMeters,
          }
        : null,
      matchedBy: by,
      // Which of its batch's planned A..L patterns this web is queued to be
      // cut to -- filled in by the attribution pass below, and left empty for
      // a Deckle whose order has no layout at this width (every order from
      // before the Set Deckle planner stored them), which is exactly how the
      // queue grouped before layouts existed.
      layoutSig: "",
      layoutCuts: null,
      layoutTrim: null,
      card,
      // Set when a scan took this web off a card (see cameOff above) -- null
      // for every other Deckle.
      cameOff: cameOff.get(String(reel._id)) || null,
      // Deckle-scoped: the allocation page cuts exactly the Deckle named here,
      // never "the order". Every Deckle row therefore carries its own stock id.
      allocateHref: order
        ? `/app/slitting/allocate/${order._id}?deckle=${reel._id}`
        : null,
    };
  });

  // A Deckle already sitting on an open (not yet run) card has moved to that
  // machine's queue -- routes/system/machine.js "/machine/:id/queue", which
  // also carries an Edit button back to this same Allocate page. Keeping it
  // listed here too would just be the same job in two places, so only Deckles
  // still free to allocate (or re-allocatable after a completed card left
  // metres behind) belong in this queue.
  const visibleRows = rows.filter((r) => !(r.card && !r.card.run));

  // ---- which layout each free Deckle is waiting for ----------------------
  // Deckle webs of one width off one batch are physically identical; what
  // separates them is the pattern they are to be cut to. So the plan's layouts
  // are handed the webs they still want, oldest web first: a layout whose webs
  // are already on a slitting card takes none, and a web beyond anything the
  // plan asks for is left without a layout rather than padded onto the last
  // one. Nothing here changes a document -- it is how the queue sorts the
  // stock in front of the planner, who still names the layout on the Allocate
  // page.
  const byOrderWidth = new Map();
  for (const r of visibleRows) {
    if (!r.order) continue;
    const k = `${r.order._id}::${widthKey(r.size)}`;
    if (!byOrderWidth.has(k)) byOrderWidth.set(k, []);
    byOrderWidth.get(k).push(r);
  }
  for (const [k, reelRows] of byOrderWidth) {
    const sep = k.lastIndexOf("::");
    const pid = k.slice(0, sep);
    const w = k.slice(sep + 2);
    const layouts = pendingLayouts(pendingById.get(pid)).filter((L) => L.width === w);
    if (!layouts.length) continue;
    // Oldest web first -- the order they came off the laminator.
    const queueOrder = reelRows.slice().sort(
      (a, b) =>
        new Date(a.createdAt || 0) - new Date(b.createdAt || 0)
        || a.rollId.localeCompare(b.rollId),
    );
    let i = 0;
    for (const L of layouts) {
      const need = Math.max(0, L.count - (slitByLayout.get(`${pid}::${L.sig}`) || 0));
      for (let n = 0; n < need && i < queueOrder.length; n++, i++) {
        queueOrder[i].layoutSig = L.sig;
        queueOrder[i].layoutCuts = L.cuts;
        queueOrder[i].layoutTrim = L.trim;
        // How many webs this layout still wants (its planned count, less any
        // already slit). Carried on the row so the queue can say what the cut
        // job is FOR even after the plan stops listing it -- see the
        // `expected` backfill in the queue route.
        queueOrder[i].layoutWants = need;
      }
    }
  }

  visibleRows.sort((a, b) =>
    a.location.localeCompare(b.location) || a.rollId.localeCompare(b.rollId),
  );

  if (!includeHeld) return visibleRows;
  // Deckles already held by an open card, returned only for the queue to show
  // them. They are not free: they never get a layout, are never ticked, and
  // are not counted in any group's stock.
  const heldRows = rows
    .filter((r) => r.card && !r.card.run)
    .map((r) => ({ ...r, held: true }));
  return [...visibleRows, ...heldRows];
}

// Deckle configs that are SET but not yet (fully) made -- what the planner
// fixed on Deckle Sorting, sitting here waiting for the machine to laminate
// it. Without these the queue only ever showed Deckles that already exist, so
// a job disappeared between "deckle set" and "deckle produced"; now the config
// lands here the moment it is set and its Stock count fills in as webs come
// off the machine.
//
// One group per LAYOUT, not per batch and not merely per width: a mixed-web
// plan (utils/deckleOptimizer) laminates several widths off one batch, and a
// single width can be planned with several different A..L patterns -- each of
// those is its own cut job waiting for its own webs. Keys are built exactly
// like the produced rows' below, so a config and the Deckles that fulfil it
// land in the same group.
async function buildPlannedDeckleGroups() {
  const pendings = await PendingProduction.find({
    deckleSize: { $ne: null },
    // A batch stands for its member orders -- listing both would double it.
    deckleBatchId: null,
    // A Deckle Only batch was set with no slitting plan, so there is nothing
    // to wait for here; its webs join the queue as free Deckles once made.
    deckleOnly: { $ne: true },
  })
    .populate({ path: "itemId", select: "productCode skuCode" })
    .sort({ createdAt: 1 })
    .lean();
  if (!pendings.length) return [];

  // Deckles ever made for these orders, counted per order + width. Counted
  // from every reel, not just the ones still carrying metres, so a config
  // does not pop back up as "waiting" once its webs have been slit away.
  const madeReels = await MaterialStock.find({ producedFor: { $in: pendings.map((p) => p._id) } })
    .select("producedFor size")
    .lean();
  const madeCount = new Map();
  for (const r of madeReels) {
    const k = `${String(r.producedFor)}::${widthKey(r.size)}`;
    madeCount.set(k, (madeCount.get(k) || 0) + 1);
  }

  const groups = [];
  for (const p of pendings) {
    // The base of the variant family, not the exact code: a Deckle laminated as
    // "C001WB-A" is the same product as an order reading "C001WB" -- the suffix
    // only records which brand of raw material went into it (see
    // productCodeFamilyRe). Keying on the base is what lets a config and the
    // Deckles that fulfil it share one row.
    const productCode = productCodeBase(p.itemId?.productCode || p.itemId?.skuCode) || "—";
    // Same running-meters expression the produced rows use, so the keys meet.
    const runningMeters = p.deckleRunningMeters ?? p.runningMeters ?? null;

    // One waiting entry per planned layout -- { size, expected, sig, cuts } --
    // else, for a batch the Set Deckle planner never stored layouts for, the
    // one entry per width this queue showed before layouts existed.
    const layouts = pendingLayouts(p);
    const wanted = [];
    if (layouts.length) {
      for (const L of layouts) {
        wanted.push({ size: L.width, expected: L.count, sig: L.sig, cuts: L.cuts, trim: L.trim });
      }
    } else {
      const size = widthKey(p.deckleSize);
      if (size) {
        wanted.push({
          size,
          expected: Math.max(1, Math.floor(Number(p.noOfRolls) || 1)),
          sig: "",
          cuts: null,
          trim: null,
        });
      }
    }

    // The webs already laminated at a width fill that width's layouts in the
    // order they were planned -- the order the machine works them -- so a
    // layout drops off this waiting list only once its own webs exist, rather
    // than the whole width going quiet as soon as the first ones are made.
    const madeLeft = new Map();
    for (const w of wanted) {
      if (!madeLeft.has(w.size)) madeLeft.set(w.size, madeCount.get(`${String(p._id)}::${w.size}`) || 0);
      const pool = madeLeft.get(w.size);
      const made = Math.min(pool, w.expected);
      madeLeft.set(w.size, pool - made);
      // Fully laminated -- its real Deckles speak for it from here on.
      if (made >= w.expected) continue;
      groups.push({
        key: `${productCode}::${w.size}::${runningMeters ?? ""}::${w.sig}`,
        productCode,
        size: w.size,
        runningMeters,
        layoutSig: w.sig,
        layoutCuts: w.cuts,
        layoutTrim: w.trim,
        expected: w.expected,
        made,
        pendingId: String(p._id),
        assigned: !!p.assignedMachineId,
        // When the deckle was set on Deckle Sorting -- how long this job has
        // been waiting here.
        createdAt: p.createdAt || null,
      });
    }
  }
  return groups;
}

// ---- Slitting Queue: every Deckle web still carrying metres ----------------
// One row per Deckle (the laminated web made upstream), not per order. The
// planner picks a Deckle here and "Allocate" opens the Slitting Job Card for
// that Deckle's order with the Deckle pre-filled as the first row.
// Read-only Product Code card for the Slitting Queue's product dialog. A queue
// row names the variant FAMILY ("C001WB"), so this returns the exact code plus
// any "-A"/"-B" variants of it; the dialog lets the planner flip between them.
router.get("/slitting/product/:code", requireSlittingView, async (req, res) => {
  const code = String(req.params.code || "").trim();
  if (!code) return res.status(400).json({ error: "Product Code is required." });
  // A Deckle row carries its full code ("C001WB-A"); always load the whole
  // family from the base so the card can flip between variants and diff them.
  const escaped = code.replace(/-[A-Z]+$/i, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const docs = await SachikoLabelStock.find({
    productCode: new RegExp(`^${escaped}(-[A-Z]+)?$`, "i"),
  })
    .select("-labelStockSignature -materialSignature -wordFile -pdfFile -wordFileOriginalName -pdfFileOriginalName -__v")
    .sort({ productCode: 1 })
    .lean();
  if (!docs.length) return res.status(404).json({ error: `No Label Stock found for ${code}.` });
  res.json({ code, items: docs });
});

router.get("/slitting/queue", requireSlittingView, async (req, res) => {
  const [allRows, planned] = await Promise.all([
    buildAvailableDeckleRows({ includeHeld: true }),
    buildPlannedDeckleGroups(),
  ]);
  // Free webs are the stock the groups are built and counted from. Held webs
  // (on an open card) are listed under their group too, so an operator can see
  // where a web went, but they are shown disabled and never counted or ticked.
  const visibleRows = allRows.filter((r) => !r.held);
  const heldRows = allRows.filter((r) => r.held);

  // Club same Product Code + Size + Running Meters + Layout together -- these
  // are interchangeable for slitting, so the queue shows one group with one
  // NOTE Product Code here means the variant FAMILY ("C001WB"), not the exact
  // code on the reel ("C001WB-A"): the suffix only records the brand of raw
  // material laminated in, so for slitting they are one product (see
  // productCodeFamilyRe). Each Deckle still carries its own full code in its
  // Deckle ID on the child row beneath.
  // "Slit" action rather than a separate row (and separate button) per
  // physical Deckle. The last two are part of the key for the same reason:
  // two Deckles of the same Product Code + Size but wound to a different
  // finished-roll length, or planned to a different A..L knife pattern, still
  // need their own cut plan, so clubbing them would just hide that they are
  // not actually interchangeable. One row is therefore one cut job, named by
  // its Product Code and its Layout. The dialog this opens is where the
  // planner actually picks which Deckle to cut.
  const groupMap = new Map();
  const newGroup = (key, productCode, size, runningMeters, layout) => ({
    _id: key,
    isGroup: true,
    productCode,
    // Every full code the Deckles in this group were laminated under. Same as
    // `productCode` unless the group clubs more than one brand variant, which
    // the view spells out on the row.
    variantCodes: [],
    size,
    runningMeters,
    // The planned knife pattern this row's webs are queued to be cut to:
    // `layoutSig` is its identity (the sorted roll widths, also what the Slit
    // button hands to the Allocate page so it seeds THIS layout), `layoutCuts`
    // the A..L widths, and `layoutTrim` the edge trim they were fitted inside
    // -- enough for the view to draw the web to scale. All empty for stock
    // whose order never had a layout planned: those rows read "—" and behave
    // exactly as before.
    layoutSig: layout?.sig || "",
    layoutCuts: layout?.cuts || null,
    layoutTrim: layout?.trim ?? null,
    // The order this row's cut job belongs to -- what Slit opens the Allocate
    // page against. It is the batch that PLANNED the layout, which is not
    // necessarily the batch a given web was laminated for: webs are pooled by
    // Product Code + width, so a job routinely cuts one borrowed from an
    // earlier run. Allocating against the planning batch is what seeds this
    // row's layout and books the finished rolls to the order that wants them
    // (the Allocate page accepts the borrowed web -- see deckleOptionsFor).
    pendingId: null,
    deckleCount: 0,
    totalMtrs: 0,
    anyCuring: false,
    // Soonest curedAt among this group's still-curing Deckles (ISO), so the
    // queue can show "ready in Xh Ym" rather than a bare "Curing" tag. Set in
    // the pool pass below, once every Deckle at this width is in view.
    curingUntil: null,
    // Deckles in this group that are out of curing and can actually be run --
    // what decides whether the group reads Waiting / Curing / Ready.
    readyCount: 0,
    // How many webs of this width the deckle config calls for, so Stock can
    // read "5 of 13" rather than a bare count with nothing to measure it
    // against. 0 for a group that exists only because Deckles do (an order
    // from before deckle configs, or stock no config now claims).
    expected: 0,
    // Oldest date in this group -- when its work first landed on this queue:
    // the deckle config's own date, or its first Deckle's if the config is
    // already gone.
    createdAt: null,
    _children: [],
  });

  const keepOldest = (group, when) => {
    if (!when) return;
    if (!group.createdAt || new Date(when) < new Date(group.createdAt)) group.createdAt = when;
  };

  for (const r of visibleRows) {
    const key = `${r.productCodeBase}::${widthKey(r.size)}::${r.runningMeters ?? ""}::${r.layoutSig}`;
    if (!groupMap.has(key)) {
      groupMap.set(key, newGroup(key, r.productCodeBase, r.size, r.runningMeters, {
        sig: r.layoutSig, cuts: r.layoutCuts, trim: r.layoutTrim,
      }));
    }
    const g = groupMap.get(key);
    if (r.productCode && !g.variantCodes.includes(r.productCode)) g.variantCodes.push(r.productCode);
    if (!g.pendingId && r.order) g.pendingId = r.order._id;
    g.deckleCount += 1;
    g.totalMtrs = round2(g.totalMtrs + r.mtrs);
    if (r.curing) g.anyCuring = true;
    else g.readyCount += 1;
    keepOldest(g, r.createdAt);
    g._children.push({ ...r, isGroup: false, _id: r.deckleStockId });
  }

  // Now fold in the configs that are set but not yet fully made, so a job set
  // on Deckle Sorting shows here from the moment it is set -- Stock 0 until
  // the machine runs it.
  //
  // A Deckle is often laminated under a VARIANT Product Code of the order's
  // own (C003AC-D against an order reading C003FG -- see the Label Stock
  // variant scheme), so matching a config to its stock by Product Code would
  // strand the two in separate groups. Attach by the order + width the
  // Deckles were actually produced for, and only fall back to a group of its
  // own when this width has nothing made yet.
  //
  // The layout is matched too, for the same reason it keys the group at all:
  // a width planned with two patterns waits for each of them separately, so a
  // config must meet the Deckles queued for ITS pattern, not the other one's.
  const groupForPending = (pendingId, size, layoutSig) => {
    for (const g of groupMap.values()) {
      if (g.layoutSig !== layoutSig) continue;
      if (g._children.some((c) => c.order && String(c.order._id) === pendingId && widthKey(c.size) === size)) return g;
    }
    return null;
  };
  for (const p of planned) {
    const hit = groupForPending(p.pendingId, p.size, p.layoutSig);
    if (hit) {
      hit.expected += p.expected;
      hit.pendingId = hit.pendingId || p.pendingId;
      keepOldest(hit, p.createdAt);
      continue;
    }
    if (!groupMap.has(p.key)) {
      groupMap.set(p.key, newGroup(p.key, p.productCode, p.size, p.runningMeters, {
        sig: p.layoutSig, cuts: p.layoutCuts, trim: p.layoutTrim,
      }));
    }
    const g = groupMap.get(p.key);
    g.expected += p.expected;
    g.pendingId = g.pendingId || p.pendingId;
    keepOldest(g, p.createdAt);
  }

  // A layout that is FULLY laminated stops being "planned" (buildPlannedDeckle
  // Groups drops it once made >= expected), so nothing above ever gave its
  // group an `expected` -- it sat at 0, which reads as "this row has no plan
  // of its own". That is wrong twice over: the Stock cell lost its "of N", and
  // the Slit dialog, which ticks `expected` webs (and, when it is 0, used to
  // fall back to the WHOLE POOL), pre-ticked every free web of that width. A
  // layout wanting one web arrived with three ticked.
  //
  // So a group with no planned entry of its own takes the count off its own
  // rows (`layoutWants` -- the layout's planned webs less any already slit).
  // Only where `expected` is still 0, so a partly-made layout keeps the
  // planned figure and nothing is counted twice.
  for (const g of groupMap.values()) {
    if (g.expected > 0) continue;
    const wants = g._children.reduce((n, c) => Math.max(n, Number(c.layoutWants) || 0), 0);
    if (wants > 0) g.expected = wants;
  }

  // ---- the free webs of a Product Code at a width are ONE shared pool ------
  // Up to here each Deckle sat under the single cut job it was attributed to,
  // which left a job reading "0 in stock" while webs it could be cut from were
  // sitting in another row -- three different C001WB jobs want a 635 mm web,
  // and the five free ones only showed under the batch they were laminated
  // for. But a free 635 mm C001WB web is a free 635 mm C001WB web: the floor
  // routinely finishes one order off a web laminated on an earlier run, which
  // is exactly what the Allocate page already offers (see deckleOptionsFor --
  // "any other Deckle of the same Product Code still in stock").
  //
  // So every group of a family + width now lists that whole pool. The counts
  // are deliberately NOT additive across those rows -- the same webs are
  // available to each of them, and `poolShared` tells the view to say so.
  // Which webs a job actually takes is settled at Slit: the attribution above
  // survives as `forThisLayout`, the dialog's default tick.
  const poolByFamilyWidth = new Map();
  for (const r of visibleRows) {
    const k = `${r.productCodeBase}::${widthKey(r.size)}`;
    if (!poolByFamilyWidth.has(k)) poolByFamilyWidth.set(k, []);
    poolByFamilyWidth.get(k).push(r);
  }

  for (const g of groupMap.values()) {
    const pool = poolByFamilyWidth.get(`${g.productCode}::${widthKey(g.size)}`) || [];
    // How many cut jobs draw on this same pool -- 1 means it is this row's alone.
    const sharedBy = [...groupMap.values()].filter(
      (o) => o.productCode === g.productCode && widthKey(o.size) === widthKey(g.size),
    ).length;

    // What the Slit dialog ticks by default: as many webs as this job still
    // wants, its OWN attributed ones first (the layout attribution in
    // buildAvailableDeckleRows), then the rest of the pool oldest-first. A web
    // borrowed from another batch never carries this job's layout, so ticking
    // on the attribution alone would leave a borrowing job with nothing
    // ticked. A group with no planned count ticks NOTHING: ticking the whole
    // pool by default is how a job got every free web of its width pre-ticked,
    // and the operator picks those by hand.
    const wants = g.expected > 0 ? g.expected : 0;
    const order = [
      ...pool.filter((r) => g.layoutSig && r.layoutSig === g.layoutSig),
      ...pool.filter((r) => !(g.layoutSig && r.layoutSig === g.layoutSig)),
    ];
    const ticked = new Set(order.slice(0, wants).map((r) => r.deckleStockId));

    g._children = pool.map((r) => ({
      ...r,
      isGroup: false,
      _id: r.deckleStockId,
      // Unique per row in the tree: the same Deckle appears under every job
      // that can use it, and Tabulator indexes rows by this.
      _rowId: `${g._id}|${r.deckleStockId}`,
      forThisLayout: ticked.has(r.deckleStockId),
    }));
    // The held webs of this family + width, listed after the free ones and
    // left out of every count above.
    g._children.push(
      ...heldRows
        .filter((r) => r.productCodeBase === g.productCode && widthKey(r.size) === widthKey(g.size))
        .map((r) => ({
          ...r,
          isGroup: false,
          _id: r.deckleStockId,
          _rowId: `${g._id}|${r.deckleStockId}`,
          forThisLayout: false,
          allocateHref: null,
        })),
    );
    g._rowId = g._id;
    g.deckleCount = pool.length;
    g.readyCount = pool.filter((r) => !r.curing).length;
    g.anyCuring = pool.some((r) => r.curing);
    // Earliest deadline among the ones still curing -- ISO strings sort the
    // same as the dates they name, so a plain string sort finds it.
    g.curingUntil = pool
      .filter((r) => r.curing && r.curingUntil)
      .map((r) => r.curingUntil)
      .sort()[0] || null;
    g.totalMtrs = round2(pool.reduce((n, r) => n + r.mtrs, 0));
    // Only worth saying when there are actually webs to share.
    g.poolShared = sharedBy > 1 && pool.length > 0;
    g.variantCodes = [...new Set(pool.map((r) => r.productCode).filter(Boolean))];
    for (const r of pool) keepOldest(g, r.createdAt);
  }

  const groups = [...groupMap.values()].sort(
    (a, b) =>
      a.productCode.localeCompare(b.productCode)
      || (Number(a.size) || 0) - (Number(b.size) || 0)
      || String(a.size).localeCompare(String(b.size))
      || (Number(a.runningMeters) || 0) - (Number(b.runningMeters) || 0)
      || a.layoutSig.localeCompare(b.layoutSig),
  );

  res.render("inventory/masters/slittingQueue.ejs", {
    title: "Deckle Slitting",
    CSS: "tableDisp.css",
    JS: false,
    rows: groups,
    notification: req.flash("notification"),
  });
});

// ---- Slitting WIP: cards actually running on a machine right now ----------
// Deckle Slitting above only lists Deckles still free to allocate; an
// allocated-but-not-yet-started card sits on its machine's own queue --
// routes/system/machine.js "/machine/:id/queue", where the operator starts
// it. This page is read-only and scoped narrower still: only cards with a
// row the operator has actually punched Start on (and not yet Stopped) --
// i.e. physically running on the floor right now, not merely queued.
// The live run facts of one slitting card, shaped exactly like the lamination
// WIP tab's progress entry (buildJobCardProgressMap in routes/fairdesk_route.js)
// so buildSlittingRunPlan + the view read them the same way. The card is updated
// per punch, so this is built straight off it -- no second collection to join.
//   metres: a Deckle's planned run length, falling back to the metres it
//   actually ran, else 0, so the ETA/Target have a figure even on a card the
//   planner left blank.
function plannedMetresOf(row) {
  const planned = Number(row?.plannedMeter);
  if (Number.isFinite(planned) && planned > 0) return planned;
  const ran = Number(row?.meter);
  return Number.isFinite(ran) && ran > 0 ? ran : 0;
}

// The operator's "why was it late?" remarks as the WIP pages read them: only the
// ones that say something (a dismissed reminder is stored but not shown), times
// as epoch ms like the rest of the run plan.
export function overtimeRemarksOf(log) {
  return (Array.isArray(log) ? log : [])
    .filter((e) => String(e?.remark || "").trim())
    .map((e) => ({
      deckleIndex: e.deckleIndex ?? null,
      runStartedAt: e.runStartedAt ? new Date(e.runStartedAt).getTime() : null,
      remark: e.remark,
      at: e.at ? new Date(e.at).getTime() : null,
      byName: e.byName || "",
    }));
}

function buildSlittingProgressMap(card) {
  const rows = Array.isArray(card.slittingLog) ? card.slittingLog : [];
  const doneRows = rows.filter((r) => r.status === "done");
  const production = doneRows.map((r, idx) => ({
    index: idx + 1,
    deckleId: r.deckleId || "",
    width: r.width ?? null,
    meters: Number(r.meter) || 0,
    runningMeter: r.runningMeter ?? null,
    cuts: Array.isArray(r.cuts) ? r.cuts.length : 0,
    startTime: r.startTime || "",
    endTime: r.endTime || "",
    joint: r.joint || "",
    jointMtr: r.jointMtr ?? null,
    producedAt: r.producedAt || null,
  }));
  // The Deckle on the slitter now: started, not yet done. Its own startedAt is
  // what the Live ETA counts from (no separate liveRun -- the card is live).
  const curIdx = rows.findIndex((r) => r.status !== "done" && r.startedAt);
  const cur = curIdx >= 0 ? rows[curIdx] : null;
  const currentRun = cur
    ? { index: curIdx + 1, startedAt: cur.startedAt, startTime: cur.startTime || "", startMtrs: cur.startMtrs ?? null, mtrs: plannedMetresOf(cur) }
    : null;
  const setting = card.liveSetting?.startedAt
    ? { startedAt: card.liveSetting.startedAt, startTime: card.liveSetting.startTime || "", startMtrs: card.liveSetting.startMtrs ?? null }
    : null;
  const lastDoneAt = doneRows.reduce((max, r) => {
    const t = r.producedAt ? new Date(r.producedAt).getTime() : null;
    return t != null && (max == null || t > max) ? t : max;
  }, null);
  const settings = (Array.isArray(card.jobSetting) ? card.jobSetting : []).map((r, idx) => ({
    index: idx + 1,
    startMtrs: Number.isFinite(Number(r.mtrs1)) ? Number(r.mtrs1) : null,
    stopMtrs: Number.isFinite(Number(r.mtrs2)) ? Number(r.mtrs2) : null,
    startTime: r.startTime || "",
    stopTime: r.stopTime || "",
    completed: !!r.stopTime,
  }));
  const pendingRows = rows.filter((r) => r.status !== "done");
  const paused = card.livePause?.since
    ? { since: card.livePause.since, reason: card.livePause.reason || "", deviceLabel: card.livePause.deviceLabel || "" }
    : null;
  const pauses = (Array.isArray(card.livePauseLog) ? card.livePauseLog : [])
    .filter((p) => p?.from && p?.to)
    .map((p) => ({ from: p.from, to: p.to, reason: p.reason || "" }));
  const claimed = slittingActiveClaim(card.runningOn);
  return {
    overtimeRemarks: overtimeRemarksOf(card.overtimeLog),
    settings,
    production,
    currentRun,
    setting,
    jobStartedAt: card.liveStartedAt || card.runningOn?.claimedAt || null,
    lastDoneAt: lastDoneAt != null ? new Date(lastDoneAt) : null,
    paused,
    pauses,
    totalMeters: round2(doneRows.reduce((n, r) => n + (Number(r.meter) || 0), 0)),
    target: rows.length,
    totalPlannedMtrs: rows.reduce((n, r) => n + plannedMetresOf(r), 0),
    remainingMtrs: pendingRows.reduce((n, r) => n + plannedMetresOf(r), 0),
    remainingMtrsAfterCurrent: pendingRows.filter((r) => r !== cur).reduce((n, r) => n + plannedMetresOf(r), 0),
    running: !!claimed,
    runningOn: card.runningOn?.deviceId
      ? {
          deviceLabel: card.runningOn.deviceLabel || "",
          claimedAt: card.runningOn.claimedAt || null,
          lastSeenAt: card.runningOn.lastSeenAt || null,
          stale: !claimed,
        }
      : null,
  };
}

// Machine Master's Machine Speed (mtrs/min) for the given machines, keyed by
// machine id -- a machine with none set is simply absent, and the caller falls
// back to SLITTING_SPEED_MPM.
export async function slittingSpeedsByMachine(machineIds) {
  const ids = [...new Set((machineIds || []).filter(Boolean).map(String))];
  if (!ids.length) return new Map();
  const machines = await Machine.find({ _id: { $in: ids }, speedMpm: { $gt: 0 } }).select("speedMpm").lean();
  return new Map(machines.map((m) => [String(m._id), m.speedMpm]));
}

// One Slitting WIP row: the identity/progress columns (same fields as a queue
// row) plus liveUpdate (the dialog's data) and runPlan (the Live/Target/Status/
// Estimate columns). `cureByReel` is the shared curing lookup built once below.
function mapSlittingWipRow(card, cureByReel, speedMpm) {
  const rows = Array.isArray(card.slittingLog) ? card.slittingLog : [];
  const done = rows.filter((r) => r.status === "done").length;
  const uncured = rows
    .filter((r) => r.status !== "done")
    .map((r) => cureByReel.get(String(r.deckleStockId)))
    .filter((info) => info && !info.cured && info.curedAt);
  const curingUntil = uncured.reduce((max, info) => Math.max(max, new Date(info.curedAt).getTime()), 0);
  const progress = buildSlittingProgressMap(card);
  return {
    _id: String(card._id),
    slittingJobCardId: card.slittingJobCardId,
    machineName: card.machineName || "",
    lotNo: card.lotNo || "—",
    productCode: card.productCode || "—",
    clientName: card.clientName || "—",
    operatorName: card.operatorName || "—",
    helperName: card.helperName || "—",
    deckleCount: rows.length,
    deckleDone: done,
    deckleLeft: rows.length - done,
    plannedRolls: rows.reduce((n, r) => n + (Array.isArray(r.cuts) ? r.cuts.length : 0), 0),
    producedRolls: rows.filter((r) => r.status === "done").reduce((n, r) => n + (Array.isArray(r.cuts) ? r.cuts.length : 0), 0),
    curing: uncured.length > 0,
    curingUntilLabel: curingUntil ? curingWhenLabel(curingUntil) : "",
    // The office/floor reads these the same way the lamination WIP tab does.
    liveUpdate: progress,
    runPlan: buildSlittingRunPlan(progress, speedMpm > 0 ? speedMpm : SLITTING_SPEED_MPM),
  };
}

// Every slitting card an operator has actually STARTED (not merely allocated and
// sitting on a queue) and not yet completed -- the WIP membership, mirroring the
// lamination WIP tab. "started" = the card was played (liveStartedAt), someone
// is on it now (a fresh claim), or a row has been started/run (covers cards from
// before the live fields existed).
async function collectSlittingWipRows() {
  const cards = await SlittingJobCard.find({ status: "allocated" }).sort({ createdAt: 1 }).lean();
  const started = cards.filter(
    (c) =>
      c.liveStartedAt
      || slittingActiveClaim(c.runningOn)
      || (Array.isArray(c.slittingLog) && c.slittingLog.some((r) => r.startedAt || r.status === "done")),
  );
  const pendingDeckleIds = [
    ...new Set(
      started.flatMap((c) =>
        (c.slittingLog || [])
          .filter((r) => r.status !== "done")
          .map((r) => String(r.deckleStockId || ""))
          .filter(Boolean),
      ),
    ),
  ];
  const cureReels = pendingDeckleIds.length
    ? await MaterialStock.find({ _id: { $in: pendingDeckleIds } })
        .select("createdAt rollId")
        .populate({ path: "material", select: CURING_MATERIAL_FIELDS })
        .lean()
    : [];
  const cureByReel = new Map(cureReels.map((r) => [String(r._id), deckleCuring(r)]));
  const speedByMachine = await slittingSpeedsByMachine(started.map((c) => c.machineId));
  const rows = started.map((c) => mapSlittingWipRow(c, cureByReel, speedByMachine.get(String(c.machineId))));
  rows.sort(
    (a, b) => a.machineName.localeCompare(b.machineName) || a.slittingJobCardId.localeCompare(b.slittingJobCardId),
  );
  return rows;
}

router.get("/slitting/wip", requireSlittingView, async (req, res) => {
  const rows = await collectSlittingWipRows();
  res.render("inventory/masters/slittingWip.ejs", {
    title: "Slitting WIP",
    CSS: "tableDisp.css",
    JS: false,
    rows,
    slittingSpeedMpm: SLITTING_SPEED_MPM,
    notification: req.flash("notification"),
  });
});

// The 10 s reconcile poll -- the whole current row set (same builder as the
// render), so the page can update, add and drop rows without a reload. Mirrors
// GET /labels/production/wip-progress.
router.get("/slitting/wip-progress", requireSlittingView, async (req, res) => {
  try {
    const rows = await collectSlittingWipRows();
    res.json({ rows });
  } catch (err) {
    console.error("SLITTING WIP PROGRESS ERROR:", err);
    res.status(500).json({ rows: [] });
  }
});

// ---- Allocation: the planner fixes one or more Deckles' jobs up front ------
// Deckle-scoped. The Slitting Queue's "Choose Deckle" dialog links here with
// one ?deckle=<stockId> per ticked Deckle; this page allocates each of them
// -- one shared machine, operator and helper, and per Deckle its own web
// width, the metres to run off it, the length per finished roll and the A..L
// knife layout. One Deckle == one SlittingJobCard, and once saved each card
// sits on the chosen machine's queue. Any other Deckle clubbed with these on
// the queue (same Product Code + Size) but left unticked is only shown here
// for context, never edited from this page.
router.get("/slitting/allocate/:pendingId", requireSlittingPlanner, async (req, res) => {
  const { pendingId } = req.params;
  if (!mongoose.isValidObjectId(pendingId)) {
    req.flash("notification", "Invalid order id.");
    return res.redirect("/app/slitting/queue");
  }

  const pending = await PendingProduction.findById(pendingId)
    .populate({ path: "itemId", select: "productCode skuCode" })
    .populate({ path: "userId", select: "clientName userName" })
    .populate({ path: "operatorId", select: "empName" })
    .populate({ path: "helperId", select: "empName" })
    .lean();
  if (!pending) {
    req.flash("notification", "That production order no longer exists.");
    return res.redirect("/app/slitting/queue");
  }

  // The Slitting Queue's "Choose Deckle" dialog ticks one or more Deckles --
  // ?deckle= repeats once per Deckle; a single value still works the same,
  // so re-opening one Deckle's own Allocate/Edit link is unchanged.
  const deckleIds = [
    ...new Set(
      [].concat(req.query.deckle || [])
        .map(trim)
        .filter((id) => mongoose.isValidObjectId(id)),
    ),
  ];
  if (!deckleIds.length) {
    req.flash("notification", "Open Allocate from Deckle Slitting so it knows which Deckle to cut.");
    return res.redirect("/app/slitting/queue");
  }

  // The Slitting Queue keys a row on the batch layout those Deckles are queued
  // to be cut to, and its Slit button passes that layout's signature through
  // (see cutsSignature). Used twice below: to seed only that pattern's rows,
  // and to scope the "other Deckles in this group" list to the same cut job.
  // Absent on an older link, and on stock whose batch had no layouts planned.
  const wantLayout = trim(req.query.layout);

  const deckles = await deckleOptionsFor(pending);
  if (!deckles.length) {
    req.flash("notification", "No Deckle stock left to slit for this order.");
    return res.redirect("/app/slitting/queue");
  }
  const deckleById = new Map(deckles.map((d) => [d._id, d]));
  const targets = deckleIds.map((id) => deckleById.get(id)).filter(Boolean);
  if (!targets.length) {
    req.flash("notification", "Those Deckles are no longer available to slit for this order.");
    return res.redirect("/app/slitting/queue");
  }

  // Each target's own open slitting card, if it already has one -- that (and
  // only that) is what this page edits and prefills its row from. One card
  // per Deckle, so a card already run is never touched here.
  const scopedCards = await SlittingJobCard.find({
    pendingProductionId: pending._id,
    status: "allocated",
    "slittingLog.0.deckleStockId": { $in: targets.map((t) => new mongoose.Types.ObjectId(t._id)) },
  }).lean();
  const scopedCardByDeckle = new Map(
    scopedCards.map((c) => [String(c.slittingLog?.[0]?.deckleStockId || ""), c]),
  );

  const [machines, operators, helpers] = await Promise.all([
    Machine.find({ machineType: SLITTING_MACHINE_RE }).populate("location").sort({ machineName: 1 }).lean(),
    Employee.find({ isActive: true, empProfile: "OPERATOR" }, "empName empNickName empProfileCode empLoc").sort({ empName: 1 }).lean(),
    Employee.find({ isActive: true, empProfile: "HELPER" }, "empName empNickName empProfileCode").sort({ empName: 1 }).lean(),
  ]);

  const order = {
    _id: String(pending._id),
    lotNo: pending.lotNo || "",
    clientOrderNo: pending.poNumber || "",
    clientName: pending.userId?.clientName || pending.userId?.userName || "",
    productCode: pending.itemId?.productCode || pending.itemId?.skuCode || "",
    // The ordered finished-roll width, and the length/count asked for --
    // these seed the card's first requirement line.
    paperSize: pending.paperSize || "",
    runningMeters: pending.deckleRunningMeters ?? pending.runningMeters ?? null,
    noOfRolls: pending.noOfRolls ?? null,
    operatorName: pending.operatorId?.empName || "",
    helperName: pending.helperId?.empName || "",
  };

  // Machine / operator / helper are prefilled ONLY when this page allocates a
  // single Deckle that already has a card (re-opening its allocation). A
  // fresh Deckle, or more than one at once, starts blank -- another Deckle's
  // crew is never carried over.
  const soloCard = targets.length === 1 ? scopedCardByDeckle.get(targets[0]._id) : null;
  const crew = {
    machineId: String(soloCard?.machineId || ""),
    operatorId: String(soloCard?.operatorId || ""),
    helperId: String(soloCard?.helperId || ""),
  };

  const previewCardId = targets.length === 1
    ? (soloCard ? soloCard.slittingJobCardId : await previewSlittingId())
    : "";

  const targetDeckles = targets.map((t) => {
    const card = scopedCardByDeckle.get(t._id);
    const row = card?.slittingLog?.[0] || null;
    return {
      _id: t._id,
      rollId: t.rollId,
      reelMtrs: t.reelMtrs,
      createdAt: t.createdAt || null,
      size: t.size,
      location: t.location,
      productCode: t.productCode,
      ownOrder: t.ownOrder,
      curing: t.curing,
      // This Deckle's existing allocation, if any -- seeds its row and flags
      // it as an in-place update rather than a fresh card.
      existing: card
        ? {
            slittingJobCardId: card.slittingJobCardId || "",
            row: {
              deckleStockId: String(row?.deckleStockId || ""),
              deckleId: row?.deckleId || "",
              width: row?.width ?? null,
              plannedMeter: row?.plannedMeter ?? null,
              plannedRunningMeter: row?.plannedRunningMeter ?? null,
              cuts: Object.fromEntries((row?.cuts || []).map((c) => [c.slot, c.width])),
            },
          }
        : null,
    };
  });

  const targetIds = new Set(targets.map((t) => t._id));
  // Every other Deckle clubbed with these on the Slitting Queue (same
  // Product Code + Size + Running Meters + Layout) but NOT ticked in --
  // context only, same as the Slitting Queue's "Choose Deckle" dialog this
  // page was opened from. Sourced from buildAvailableDeckleRows() -- the exact pool the
  // queue itself clubs from -- rather than deckleOptionsFor's order-scoped
  // pool above, which can miss Deckles linked (producedFor) to a *different*
  // order that nonetheless shares this batch's Product Code + Size +
  // Running Meters, undercounting Total/Available here.
  // The variant family, matching how the queue clubbed these Deckles into one
  // row -- "C001WB-A" and "C001WB" are one product to slit.
  const groupProductCode = productCodeBase(targets[0].productCode);
  const groupSize = targets[0].size;
  const groupRunningMeters = order.runningMeters ?? null;
  const availableRows = await buildAvailableDeckleRows({ includeHeld: true });
  const groupDeckles = availableRows
    .filter((r) =>
      !targetIds.has(r.deckleStockId)
      && r.productCodeBase === groupProductCode
      // Webs already on an open card carry no layout or running-meters match
      // (they were left out of grouping); the queue lists them by product
      // family + width alone, so this does too -- shown for reference.
      && (r.held
        ? widthKey(r.size) === widthKey(groupSize)
        : r.size === groupSize
          && (r.runningMeters ?? null) === groupRunningMeters
          && (!wantLayout || r.layoutSig === wantLayout)),
    )
    .map((r) => ({
      _id: r.deckleStockId,
      rollId: r.rollId,
      reelMtrs: r.mtrs,
      location: r.location,
      lotNo: r.lotNo,
      curing: { cured: !r.curing, curedAtLabel: r.curingUntilLabel },
      // Same rule as the queue's Choose Deckle dialog: a web with no order of
      // its own can't be allocated, one already on an open card is reference only.
      createdAt: r.createdAt || null,
      curingUntil: r.curingUntil || null,
      hotMelt: !!r.hotMelt,
      card: r.card && !r.card.run ? { slittingJobCardId: r.card.slittingJobCardId, machineName: r.card.machineName } : null,
      selectable: !!r.order && !(r.card && !r.card.run),
      heldOn: r.card && !r.card.run ? (r.card.slittingJobCardId || "another card") : "",
    }));

  // The deckle layouts the planner drew on the Set Deckle page for this batch
  // (models/inventory/pendingProduction.js deckleLayout -- one entry per cut
  // pattern, each with its own A..L widths + R. Meter + web count). Pre-fills a
  // fresh allocation's layout rows so the widths are not re-typed here. An
  // existing SlittingJobCard row always wins over this (see the view).
  //
  // `width` is the web the row runs on. A batch may have been planned with its
  // layouts on DIFFERENT deckle widths (mixed webs -- see deckleLayout's own
  // comment), so each entry's own deckleSize is what to pre-fill; only where
  // it is absent (every batch saved before mixed webs existed) does the
  // batch-level deckleSize stand in for it.
  //
  // The Slitting Queue keys a row on the layout, so its Slit button names the
  // one pattern these Deckles are queued for (?layout=<signature>) -- seed
  // just that one rather than every pattern the batch happens to hold. A link
  // without it, or naming a layout this batch no longer has, falls back to all
  // of them, which is what this page did before the queue was layout-keyed.
  const plannedLayouts = (pending.isDeckleBatch && Array.isArray(pending.deckleLayout))
    ? pending.deckleLayout.filter((L) => Array.isArray(L.cuts) && L.cuts.length)
    : [];
  let scopedLayouts = wantLayout
    ? plannedLayouts.filter((L) => cutsSignature(L.cuts) === wantLayout)
    : [];

  // ...and when it isn't one of THIS order's, look for it across the Product
  // Code family. The Slitting Queue pools free webs by Product Code + width,
  // so a cut job routinely runs on a web laminated for an earlier batch, and
  // this page then opens against an order that never planned the pattern its
  // row names. The planner did set it -- on a sibling batch of the same
  // Product Code -- so the widths are on record and the slitter should not
  // have to re-type them. The edge trim rides along with it: the layout was
  // fitted inside that batch's trim, and defaulting to this page's 10 mm
  // instead would flag a layout that actually fits as over the web.
  let borrowedTrim = null;
  if (wantLayout && !scopedLayouts.length) {
    const familyIds = await labelStockFamilyIds(
      pending.itemId?.productCode || pending.itemId?.skuCode,
    );
    if (familyIds.length) {
      const kin = await PendingProduction.find({
        _id: { $ne: pending._id },
        itemId: { $in: familyIds },
        deckleBatchId: null,
        deckleLayout: { $exists: true, $ne: null },
      }).select("deckleSize deckleTrim deckleLayout").lean();

      const targetWidth = numOrNull(targets[0].size);
      const hits = [];
      for (const k of kin) {
        for (const L of k.deckleLayout || []) {
          if (!Array.isArray(L.cuts) || !L.cuts.length) continue;
          if (cutsSignature(L.cuts) !== wantLayout) continue;
          const w = Number(L.deckleSize) > 0 ? Number(L.deckleSize) : Number(k.deckleSize);
          hits.push({ L, w, trim: k.deckleTrim != null && Number(k.deckleTrim) >= 0 ? Number(k.deckleTrim) : null });
        }
      }
      // Prefer one planned for the very width these Deckles are.
      const pick = hits.find((h) => targetWidth !== null && round2(h.w) === round2(targetWidth)) || hits[0];
      if (pick) {
        scopedLayouts = [pick.L];
        borrowedTrim = pick.trim;
      }
    }
  }

  const layoutSource = scopedLayouts.length ? scopedLayouts : plannedLayouts;

  // ---- how many webs this cut job actually calls for ----------------------
  // The Deckles ticked in are what is being allocated NOW; this is what the
  // whole layout wants ("8 webs of 210+210+210"), less the ones already on a
  // card, so the planner can see at a glance that allocating these 5 still
  // leaves 3 to come. Cards this page is itself editing are not counted --
  // they are the rows on screen, not work already done elsewhere.
  let layoutNeed = null;
  let layoutAllocated = 0;
  if (layoutSource.length) {
    layoutNeed = layoutSource.reduce(
      (n, L) => n + Math.max(1, Math.floor(Number(L.count) || 1)), 0,
    );
    const sigs = new Set(layoutSource.map((L) => cutsSignature(L.cuts)));
    const editingIds = new Set(scopedCards.map((c) => String(c._id)));
    const doneCards = await SlittingJobCard.find({
      pendingProductionId: pending._id,
      status: { $in: ["allocated", "completed"] },
    }).select("slittingLog").lean();
    for (const c of doneCards) {
      if (editingIds.has(String(c._id))) continue;
      for (const lr of c.slittingLog || []) {
        if (sigs.has(cutsSignature(lr.cuts))) layoutAllocated += 1;
      }
    }
  }

  const batchLayout = layoutSource.length
    ? layoutSource.map((L) => ({
        width: Number(L.deckleSize) > 0
          ? Number(L.deckleSize)
          : (Number(pending.deckleSize) > 0 ? Number(pending.deckleSize) : null),
        plannedRunningMeter: L.plannedRunningMeter ?? null,
        count: L.count ?? 1,
        cuts: Object.fromEntries(L.cuts.map((c) => [c.slot, c.width])),
      }))
    : null;

  res.render("inventory/masters/slittingAllocation.ejs", {
    title: "Slitting Allocation",
    CSS: false,
    JS: false,
    order,
    // The Deckle(s) this page allocates -- one row per Deckle in the table
    // below. Fixed -- not a picker.
    targetDeckles,
    groupDeckles,
    batchLayout,
    // True when this page is cutting to a layout the planner already fixed on
    // the Set Deckle page and the Slitting Queue named in the link. The layout
    // is then shown read-only -- it is not this page's to change; a different
    // pattern is a different cut job, drawn on Set Deckle. Without it (a bare
    // Allocate link, or stock no deckle config claims) the A..L grid stays
    // editable exactly as before.
    layoutLocked: !!(wantLayout && scopedLayouts.length),
    // Webs this layout calls for in total, and how many are already on another
    // card -- the "Deckles Needed" figure. Null when no planned layout applies.
    layoutNeed,
    layoutAllocated,
    // Trim the Set Deckle planner used for this batch -- or, for a layout
    // borrowed from a sibling batch above, the trim IT was fitted inside --
    // else the 10 mm default.
    defaultTrim: pending.isDeckleBatch && pending.deckleTrim != null && Number(pending.deckleTrim) >= 0
      ? Number(pending.deckleTrim)
      : (borrowedTrim ?? 10),
    cutSlots: CUT_SLOTS,
    previewCardId,
    machines: machines.map((m) => ({
      _id: String(m._id),
      machineName: m.machineName,
      machineType: m.machineType || "",
      locationName: m.location?.locationName || "",
      operatorKey: `${String(m.machineName || "").trim().toUpperCase()}||${normalizeLocationName(m.location?.locationName)}`,
    })),
    // Profile code + location is how an operator is tied to a machine (the
    // machine's name / location) -- the allocate page uses it to pick the
    // operator when a machine is chosen.
    operators: operators.map((e) => ({
      _id: String(e._id),
      empName: e.empName,
      empNickName: e.empNickName || "",
      machineKey: e.empProfileCode ? `${String(e.empProfileCode).trim().toUpperCase()}||${normalizeLocationName(e.empLoc)}` : "",
    })),
    helpers: helpers.map((e) => ({ _id: String(e._id), empName: e.empName, empNickName: e.empNickName || "" })),
    crew,
    submissionToken: randomUUID(),
    notification: req.flash("notification"),
  });
});

router.post("/slitting/allocate/:pendingId", requireAuth, requireSlittingPlanner, createLimiter, async (req, res) => {
  const fail = (message) => res.status(400).json({ success: false, message });
  try {
    const { pendingId } = req.params;
    if (!mongoose.isValidObjectId(pendingId)) return fail("Invalid order.");

    const pending = await PendingProduction.findById(pendingId)
      .populate({ path: "itemId", select: "productCode skuCode" })
      .populate({ path: "userId", select: "clientName userName" })
      .lean();
    if (!pending) return fail("Order not found.");

    const b = req.body || {};

    if (!mongoose.isValidObjectId(b.machineId)) return fail("Select a slitting machine.");
    const machine = await Machine.findById(b.machineId).select("machineName machineType").lean();
    if (!machine) return fail("Select a valid slitting machine.");
    if (!SLITTING_MACHINE_RE.test(machine.machineType || "")) {
      return fail(`"${machine.machineName}" is not a slitting machine.`);
    }

    if (!mongoose.isValidObjectId(b.operatorId)) return fail("Select an operator.");
    const operator = await Employee.findById(b.operatorId).select("empName").lean();
    if (!operator) return fail("Select a valid operator.");

    let helper = null;
    if (trim(b.helperId)) {
      if (!mongoose.isValidObjectId(b.helperId)) return fail("Select a valid helper.");
      helper = await Employee.findById(b.helperId).select("empName").lean();
      if (!helper) return fail("Select a valid helper.");
    }

    const rawRows = Array.isArray(b.rows) ? b.rows : [];
    if (!rawRows.length) return fail("Fill in the Deckle's layout.");

    // Cut width -> the width it was ordered at, for this batch's graced layouts.
    // Empty for every batch that was planned without grace, which is the norm.
    const graceMap = gracedWidthMap(pending);

    // Normalize + validate the whole plan before writing any of it.
    const rows = [];
    for (let i = 0; i < rawRows.length; i++) {
      const r = rawRows[i] || {};
      const label = `Row ${i + 1}`;
      if (!mongoose.isValidObjectId(r.deckleStockId)) return fail(`${label}: select a Deckle.`);

      const plannedMeter = numOrNull(r.plannedMeter);
      if (!(plannedMeter > 0)) return fail(`${label}: enter the metres to run off the Deckle.`);

      const plannedRunningMeter = numOrNull(r.plannedRunningMeter);
      if (!(plannedRunningMeter > 0)) return fail(`${label}: enter the R. Meter for each roll.`);

      const cuts = CUT_SLOTS.map((slot) => ({ slot, width: numOrNull(r.cuts?.[slot]) }))
        .filter((c) => c.width !== null);
      if (!cuts.length) return fail(`${label}: enter at least one roll width (A–L).`);
      if (cuts.some((c) => !(c.width > 0))) return fail(`${label}: roll widths must be greater than zero.`);
      // Record what each knife was ordered at where it differs from what it
      // cuts, so the card itself carries the billing width rather than the Stop
      // having to re-derive it from a plan that may have moved on since.
      for (const c of cuts) {
        const ordered = orderedWidthFor(graceMap, c.width);
        if (ordered != null) c.orderedWidth = ordered;
      }

      const width = numOrNull(r.width);
      const cutTotal = round2(cuts.reduce((n, c) => n + c.width, 0));
      // The knives cannot cut more web than the Deckle has. Equal is fine --
      // a layout with no edge trim at all.
      if (width !== null && cutTotal > width) {
        return fail(`${label}: roll widths total ${cutTotal} mm but the Deckle web is only ${width} mm.`);
      }

      rows.push({
        deckleStockId: r.deckleStockId,
        width,
        cuts,
        plannedMeter: round2(plannedMeter),
        plannedRunningMeter: round2(plannedRunningMeter),
        status: "pending",
      });
    }

    // One Deckle may be planned across more than one row; check its whole
    // demand at once so two rows can't each pass on the same metres.
    const demandByDeckle = new Map();
    for (const r of rows) {
      const k = String(r.deckleStockId);
      demandByDeckle.set(k, round2((demandByDeckle.get(k) || 0) + r.plannedMeter));
    }

    const reels = await MaterialStock.find({ _id: { $in: [...demandByDeckle.keys()] } })
      .populate({ path: "material", select: "productCode skuCode" })
      .lean();
    const reelById = new Map(reels.map((r) => [String(r._id), r]));

    for (const [id, wanted] of demandByDeckle) {
      const reel = reelById.get(id);
      if (!reel) return fail("A selected Deckle no longer exists — reload the page.");
      const available = round2(Number(reel.reelMtrs) || 0);
      if (wanted > available) {
        return fail(`Deckle "${reel.rollId}" only has ${available} mtrs left — this plan asks for ${wanted}.`);
      }
    }

    // Finished rolls are inwarded where their own Deckle already sits, and
    // every Deckle here gets its own card (below) -- so unlike a single
    // shared card, one row's location has no bearing on another's.
    const locationless = reels.find((r) => !trim(r.location));
    if (locationless) {
      return fail(`Deckle "${locationless.rollId}" has no location on it.`);
    }

    // Every finished roll is named after the Product Code of the Deckle it
    // came off. Check that up front rather than failing mid-run.
    const codeless = reels.find(
      (r) => !trim(r.material?.productCode || r.material?.skuCode || pending.itemId?.productCode),
    );
    if (codeless) {
      return fail(`Deckle "${codeless.rollId}" has no Product Code on its Label Stock — it cannot be slit.`);
    }

    // A Deckle can only be slit against an order of its own Product Code
    // (brand variants included) -- the finished rolls take the Deckle's code,
    // so a reel of a genuinely different code would mis-name the whole run.
    const orderCode = trim(pending.itemId?.productCode || pending.itemId?.skuCode);
    const codeRe = productCodeFamilyRe(orderCode);
    if (codeRe) {
      const foreign = reels.find((r) => {
        const code = trim(r.material?.productCode || r.material?.skuCode);
        return code && !codeRe.test(code);
      });
      if (foreign) {
        const code = trim(foreign.material?.productCode || foreign.material?.skuCode);
        return fail(
          `Deckle "${foreign.rollId}" is Product Code ${code} — this order is ${orderCode}. Only ${orderCode} Deckles can be slit here.`,
        );
      }
    }

    const allocatedBy = req.session?.authUser?.username || req.session?.authUser?.empName || "SYSTEM";
    const submissionToken = trim(b.submissionToken) || undefined;

    // One Deckle == one card, so each row of the table above gets its own --
    // re-opening this page for a Deckle that already has an open card
    // updates THAT card in place (so it keeps its id and its spot on the
    // operator's queue); a Deckle with no open card yet gets a fresh one.
    // A card already run is finished work and is never touched here.
    const cardIds = [];
    let anyUpdate = false;
    for (const r of rows) {
      const deckleStockId = r.deckleStockId;
      const reel = reelById.get(deckleStockId);
      const deckleId = reel?.rollId || "";

      // Per-row idempotency: one submissionToken shared by the whole submit
      // can't sit on more than one document (its index is unique), so each
      // card's own token is derived from it -- a resubmit of the same loaded
      // page still recognizes every row it already created and skips it.
      const rowSubmissionToken = submissionToken ? `${submissionToken}:${deckleStockId}` : undefined;
      if (rowSubmissionToken && (await SlittingJobCard.exists({ submissionToken: rowSubmissionToken }))) {
        continue;
      }

      const scopedCard = await SlittingJobCard.findOne({
        pendingProductionId: pending._id,
        status: "allocated",
        "slittingLog.0.deckleStockId": new mongoose.Types.ObjectId(deckleStockId),
      });

      const shared = {
        status: "allocated",
        pendingProductionId: pending._id,
        machineId: machine._id,
        machineName: machine.machineName || "",
        operatorId: operator._id,
        operatorName: operator.empName || "",
        helperId: helper?._id,
        helperName: helper?.empName || "",
        clientOrderNo: trim(b.clientOrderNo) || pending.poNumber || "",
        clientName: pending.userId?.clientName || pending.userId?.userName || "",
        productCode: pending.itemId?.productCode || pending.itemId?.skuCode || "",
        // A slitting card is one Deckle's own cut job, not the sales order's
        // batch -- named by that Deckle's id rather than the order's lot no,
        // which is shared by every Deckle laminated for the order and so
        // wouldn't tell two cards apart on the machine queue or job card log.
        lotNo: deckleId || pending.lotNo || "",
        location: reel.location,
        allocatedBy,
      };

      let card;
      if (scopedCard) {
        anyUpdate = true;
        Object.assign(scopedCard, shared);
        const prior = (scopedCard.slittingLog || [])[0];
        scopedCard.slittingLog = [{
          ...r,
          deckleId,
          // The token is what makes this card's Stop idempotent, so it is kept
          // across a re-allocation rather than re-minted -- a Stop already in
          // flight must still match.
          rowToken: prior?.rowToken || randomUUID(),
          status: "pending",
        }];
        await scopedCard.save();
        card = scopedCard;
      } else {
        card = await SlittingJobCard.create({
          ...shared,
          slittingJobCardId: await generateSlittingId(),
          submissionToken: rowSubmissionToken,
          date: b.date ? new Date(b.date) : new Date(),
          slittingLog: [{ ...r, deckleId, rowToken: randomUUID(), status: "pending" }],
        });
      }
      cardIds.push(card.slittingJobCardId);
    }

    if (!cardIds.length) {
      // Every row was already submitted -- a resubmit of the same loaded page.
      return res.json({ success: true, redirect: "/app/slitting/queue" });
    }

    notifyOperatorQueue(operator._id);
    res.locals.auditDescription =
      `${anyUpdate ? "Updated/Allocated" : "Allocated"} ${cardIds.length} slitting job${cardIds.length === 1 ? "" : "s"} `
      + `(${cardIds.join(", ")}) on ${machine.machineName} for ${operator.empName} (order ${pending.lotNo || pending._id}).`;
    req.flash(
      "notification",
      cardIds.length === 1
        ? `${anyUpdate ? "Updated" : "Allocated"} ${cardIds[0]} on ${machine.machineName}'s queue.`
        : `Allocated ${cardIds.length} Deckles to ${machine.machineName}'s queue.`,
    );
    res.json({ success: true, redirect: "/app/slitting/queue" });
  } catch (err) {
    console.error("SLITTING ALLOCATION ERROR:", err);
    if (err?.code === 11000 && err?.keyPattern?.submissionToken) {
      return res.json({ success: true, redirect: "/app/slitting/queue" });
    }
    res.status(500).json({ success: false, message: "Failed to save the slitting allocation." });
  }
});

// ---- The operator's card ---------------------------------------------------
// Declared ahead of the "/:cardId" route below -- Express matches in
// declaration order, and "view" would otherwise be read as a card id.
router.get("/slitting/jobcard/view", requireSlittingView, async (req, res) => {
  const cards = await SlittingJobCard.find().sort({ createdAt: -1 }).lean();

  res.render("inventory/masters/slittingJobCardView.ejs", {
    title: "Slitting Logs",
    CSS: "tableDisp.css",
    JS: false,
    cutSlots: CUT_SLOTS,
    jsonData: cards,
    notification: req.flash("notification"),
  });
});

// ---- The operator's card ---------------------------------------------------

// One open slitting card, in the exact shape the operator works it from.
// Exported because BOTH front ends render this same payload: the EJS form
// below, and the Sachiko Operator app's own JSON route (routes/api/
// operatorApi.js). Returns { ok:false, status, message } rather than
// throwing, so each caller can turn a dead card into its own kind of
// answer -- a flash + redirect there, an HTTP status here.
export async function buildSlittingCard(cardId) {
  if (!mongoose.isValidObjectId(cardId)) {
    return { ok: false, status: 400, message: "Invalid slitting card." };
  }

  const card = await SlittingJobCard.findById(cardId).lean();
  if (!card) {
    return { ok: false, status: 404, message: "That slitting card no longer exists." };
  }
  if (card.status === "completed") {
    return { ok: false, status: 409, code: "completed", message: `${card.slittingJobCardId} is already finished.` };
  }

  // Live remaining metres per allocated reel, so a row whose Deckle has been
  // drawn down elsewhere since allocation shows the truth rather than the
  // plan.
  const stockIds = (card.slittingLog || []).map((r) => r.deckleStockId).filter(Boolean);
  const reels = stockIds.length
    ? await MaterialStock.find({ _id: { $in: stockIds } })
        .select("rollId reelMtrs location createdAt size")
        .populate({ path: "material", select: CURING_MATERIAL_FIELDS })
        .lean()
    : [];
  const reelById = new Map(reels.map((r) => [String(r._id), r]));
  // This machine's speed from Machine Master (SLITTING_SPEED_MPM where none is
  // set) -- what the app's overtime reminder times each Deckle against.
  const speedMpm = (await slittingSpeedsByMachine([card.machineId])).get(String(card.machineId)) || SLITTING_SPEED_MPM;
  // Where this card's Deckle sits in its knife layout's run, so the card names
  // the Deckle by the same number the queues do ("Deckle 6 of 10") -- see
  // buildLayoutRuns. One card is one Deckle, hence `run.from` per row.
  const run = (await buildLayoutRuns([card])).get(String(card._id)) || null;

  return {
    ok: true,
    card: {
      timing: { speedMpm },
      // The layout run this card belongs to, or null for a card whose Deckle
      // has no recorded cuts (nothing to share a setting with).
      layoutRun: run ? { from: run.from, total: run.total, done: run.done } : null,
      _id: String(card._id),
      slittingJobCardId: card.slittingJobCardId,
      date: card.date,
      machineName: card.machineName || "",
      operatorName: card.operatorName || "",
      helperName: card.helperName || "",
      clientOrderNo: card.clientOrderNo || "",
      clientName: card.clientName || "",
      productCode: card.productCode || "",
      lotNo: card.lotNo || "",
      location: card.location || "",
      // Setup Start/Stop readings taken before the first Deckle is cut -- see
      // POST /slitting/jobcard/setting below. Prefills the Job Setting table
      // so a reload picks up exactly where the operator left off instead of
      // losing already-punched rows.
      jobSetting: (card.jobSetting || []).map((r) => ({
        mtrs1: r.mtrs1 ?? null,
        startTime: r.startTime || "",
        mtrs2: r.mtrs2 ?? null,
        stopTime: r.stopTime || "",
      })),
      rows: (card.slittingLog || []).map((r, i) => {
        const reel = reelById.get(String(r.deckleStockId));
        const cure = deckleCuring(reel);
        return {
          index: i,
          deckleId: r.deckleId || reel?.rollId || "",
          // This Deckle's place in its layout's run -- the "6" of "6 of 10".
          runPos: run ? run.from + i : null,
          width: r.width ?? null,
          // orderedWidth rides along where the cut was graced, so the operator's
          // card can say a roll is cut wider than it is sold at.
          cuts: (r.cuts || []).map((c) => ({
            slot: c.slot, width: c.width, orderedWidth: c.orderedWidth ?? null, rollId: c.rollId || "",
          })),
          plannedMeter: r.plannedMeter ?? null,
          plannedRunningMeter: r.plannedRunningMeter ?? null,
          // Raw web size the Deckle was laminated to (its MaterialStock.size,
          // e.g. "210") -- what the allocation page called rawWebWidth, before
          // the edge trim it netted out to get this row's own `width`. Only
          // for drawing the web view's edge-trim segments; not itself stored
          // on the row.
          webWidth: reel?.size ? (() => {
            const m = /-?\d+(\.\d+)?/.exec(String(reel.size));
            return m ? Number(m[0]) : null;
          })() : null,
          status: r.status || "pending",
          startMtrs: r.startMtrs ?? null,
          stopMtrs: r.stopMtrs ?? null,
          meter: r.meter ?? null,
          runningMeter: r.runningMeter ?? null,
          startTime: r.startTime || "",
          endTime: r.endTime || "",
          joint: r.joint || "",
          jointMtr: r.jointMtr ?? null,
          // What is actually left on the reel right now.
          reelMtrs: reel ? round2(Number(reel.reelMtrs) || 0) : null,
          // Curing gate -- Start / Stop stay locked until the adhesive has
          // cured (CHROMO 6 h / PP 8 h after lamination), unless hot melt.
          curing: {
            cured: cure.cured,
            hotMelt: cure.hotMelt,
            hours: cure.hours,
            curedAt: cure.curedAt ? cure.curedAt.toISOString() : null,
            curedAtLabel: cure.curedAt ? curingWhenLabel(cure.curedAt) : "",
          },
        };
      }),
    },
  };
}

router.get("/slitting/jobcard/:cardId", requireSlittingFloor, async (req, res) => {
  const built = await buildSlittingCard(req.params.cardId);
  if (!built.ok) {
    req.flash("notification", built.message);
    return res.redirect(built.code === "completed" ? "/app/slitting/jobcard/view" : "/app/slitting/queue");
  }

  res.render("inventory/masters/slittingJobCardForm.ejs", {
    title: "Slitting Job Card",
    CSS: false,
    JS: false,
    card: built.card,
    notification: req.flash("notification"),
  });
});

// Persists the Job Setting rows (setup Start/Stop meter readings, punched
// client-side) in one shot when the operator clicks "Start Production" --
// unlike a Deckle row's Start/Stop, nothing here moves stock or is gated by
// curing, so there is no need for the per-punch round trip row/start below
// uses. Re-saving simply overwrites, so revisiting this step is harmless.
export async function saveSlittingSetting({ cardId, rows }) {
  if (!mongoose.isValidObjectId(cardId)) return { ok: false, status: 400, message: "Invalid card." };
  if (!Array.isArray(rows) || !rows.length) {
    return { ok: false, status: 400, message: "Add at least one Job Setting row." };
  }

  const card = await SlittingJobCard.findById(cardId);
  if (!card) return { ok: false, status: 404, message: "Card not found." };

  // numOrNull, NOT `Number(x) || undefined`: a counter reading of 0 is a
  // real reading (a fresh counter starts there), and the falsy-zero form
  // silently dropped it -- which then rendered the field blank AND
  // readonly on reload, with no way left to correct it.
  //
  // This replaces the whole jobSetting array, so the server-clock startedAt /
  // stoppedAt that the per-punch setting endpoints stamped (used by the WIP
  // page's JOB SETTING phase) are carried forward by index -- a bulk save of
  // the readings must not wipe the live timing.
  const prev = Array.isArray(card.jobSetting) ? card.jobSetting : [];
  card.jobSetting = rows.map((r, i) => ({
    mtrs1: numOrNull(r?.mtrs1),
    startTime: trim(r?.startTime),
    mtrs2: numOrNull(r?.mtrs2),
    stopTime: trim(r?.stopTime),
    startedAt: prev[i]?.startedAt,
    stoppedAt: prev[i]?.stoppedAt,
  }));
  await card.save();
  return { ok: true };
}

router.post("/slitting/jobcard/setting", requireAuth, requireSlittingFloor, updateLimiter, async (req, res) => {
  try {
    const { cardId, rows } = req.body || {};
    const result = await saveSlittingSetting({ cardId, rows });
    if (!result.ok) return res.status(result.status).json({ success: false, message: result.message });
    res.json({ success: true });
  } catch (err) {
    console.error("SLITTING JOB SETTING ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to save Job Setting." });
  }
});

// The operator re-orders the knives across one Deckle's web -- 210+210+230
// laid out as 210+230+210 -- to suit the machine or the reel's edge. `order` is
// the NEW left-to-right order given as the CURRENT positions: [0, 2, 1] means
// "keep the first cut, then the third, then the second".
//
// Only the widths move. The slot letters (A, B, C...) are positions across the
// web and stay where they are, so after a re-order slot B simply holds a
// different width -- and the finished roll ids (<deckle>-<slot>) minted at Stop
// follow the new positions. A graced cut's orderedWidth is the width the client
// ordered for THAT cut, so it travels with its width, never with its slot.
//
// Allowed only until the Deckle is started: once the slitter has run, the rolls
// physically exist in the old order. The set of widths never changes, so the
// plan's cutsSignature (a sorted multiset) -- and with it every queue grouping
// -- is untouched.
export async function reorderSlittingCuts({ cardId, index, order }) {
  const fail = (message, code) => ({ ok: false, status: 400, message, code });

  if (!mongoose.isValidObjectId(cardId)) return fail("Invalid card.");

  const card = await SlittingJobCard.findById(cardId);
  if (!card) return { ok: false, status: 404, message: "Card not found." };
  if (card.status === "completed") return fail(`${card.slittingJobCardId} is already finished.`);

  const row = card.slittingLog?.[Number(index)];
  if (!row) return fail("That row is not on this card.");
  if (row.status === "done") return fail("That Deckle has already been run.", "done");
  if (row.startTime || row.startedAt) {
    return fail("That Deckle has already been started — its layout can't be changed now.", "started");
  }

  const current = Array.isArray(row.cuts) ? row.cuts : [];
  const n = current.length;
  if (n < 2) return fail("There is nothing to re-order on this Deckle.");

  const next = Array.isArray(order) ? order.map(Number) : [];
  const valid =
    next.length === n &&
    next.every((p) => Number.isInteger(p) && p >= 0 && p < n) &&
    new Set(next).size === n;
  if (!valid) return fail("That layout is not valid. Please try again.");

  const before = current.map((c) => ({ width: c.width, orderedWidth: c.orderedWidth }));
  row.cuts = next.map((from, pos) => {
    const cut = { slot: current[pos].slot, width: before[from].width };
    if (before[from].orderedWidth !== undefined && before[from].orderedWidth !== null) {
      cut.orderedWidth = before[from].orderedWidth;
    }
    return cut;
  });
  card.markModified("slittingLog");
  await card.save();

  const saved = card.slittingLog[Number(index)];
  return {
    ok: true,
    cuts: (saved.cuts || []).map((c) => ({
      slot: c.slot, width: c.width, orderedWidth: c.orderedWidth ?? null, rollId: c.rollId || "",
    })),
    auditDescription:
      `Re-ordered the knives on ${row.deckleId || "a Deckle"} (${card.slittingJobCardId}): ` +
      `${before.map((c) => c.width).join("+")} -> ${(saved.cuts || []).map((c) => c.width).join("+")}`,
  };
}

// A scan doesn't have to be the exact Deckle the planner allocated -- any
// free web of the same Product Code (brand variants included) and the same
// raw size can be run in its place. This re-points the row at whatever was
// actually scanned:
//   - the reel the row is leaving is automatically free again -- nothing on
//     any card references it once this save commits, and "free" is never
//     tracked any other way;
//   - the reel being scanned in is locked to THIS card the instant it does,
//     because "in use" is exactly "referenced by an allocated card's row" --
//     the clash check below is the whole lock, there is no separate flag.
export async function swapSlittingDeckle({ cardId, index, rollId, by }) {
  const fail = (message, code) => ({ ok: false, status: 400, message, code });

  if (!mongoose.isValidObjectId(cardId)) return fail("Invalid card.");
  if (!String(rollId ?? "").trim()) return fail("Scan a Deckle.", "unknown");

  const card = await SlittingJobCard.findById(cardId);
  if (!card) return { ok: false, status: 404, message: "Card not found." };
  if (card.status === "completed") return fail(`${card.slittingJobCardId} is already finished.`);

  const i = Number(index);
  const row = card.slittingLog?.[i];
  if (!row) return fail("That row is not on this card.");
  if (row.status === "done") return fail("That Deckle has already been run.");

  // The row's CURRENT reel names the spec every replacement has to match --
  // same rule the planner's own allocation enforces (see POST
  // /slitting/allocate above): Product Code family + raw web size. Falls
  // back to the card's own snapshot code if that reel is somehow gone.
  const specReel = await MaterialStock.findById(row.deckleStockId)
    .select("size")
    .populate({ path: "material", select: "productCode skuCode" })
    .lean();
  const codeRe = productCodeFamilyRe(
    specReel?.material?.productCode || specReel?.material?.skuCode || card.productCode,
  );
  const sizeOf = (v) => {
    const m = /-?\d+(\.\d+)?/.exec(String(v ?? ""));
    return m ? Number(m[0]) : null;
  };
  const specSize = sizeOf(specReel?.size);

  const scanned = await findScannedReel(MaterialStock, rollId, "_id");
  if (!scanned) return fail("That isn't a known Deckle — check the label.", "unknown");

  if (String(scanned._id) === String(row.deckleStockId)) {
    return { ok: true, unchanged: true };
  }

  // One fetch, fully populated, for every check below plus the curing gate.
  const newReel = await MaterialStock.findById(scanned._id)
    .select("rollId size location quantity reelMtrs createdAt")
    .populate({ path: "material", select: `productCode skuCode ${CURING_MATERIAL_FIELDS}` })
    .lean();

  const newCode = trim(newReel.material?.productCode || newReel.material?.skuCode);
  if (codeRe && (!newCode || !codeRe.test(newCode))) {
    return fail(
      `${newReel.rollId} is Product Code ${newCode || "unknown"} — this card needs ${specReel?.material?.productCode || card.productCode}.`,
      "mismatch",
    );
  }

  const newSize = sizeOf(newReel.size);
  if (specSize != null && newSize !== specSize) {
    return fail(`${newReel.rollId} is a ${newSize ?? "?"} mm web — this card needs ${specSize} mm.`, "mismatch");
  }

  if (!((Number(newReel.quantity) || 0) > 0 && (Number(newReel.reelMtrs) || 0) > 0)) {
    return fail(`${newReel.rollId} has no stock left.`, "empty");
  }
  if (Number(newReel.reelMtrs) < Number(row.plannedMeter)) {
    return fail(
      `${newReel.rollId} only has ${round2(newReel.reelMtrs)} mtrs left — this row needs ${row.plannedMeter}.`,
      "short",
    );
  }
  if (!trim(newReel.location)) {
    return fail(`${newReel.rollId} has no location on it.`, "no-location");
  }

  // Curing gate -- same check Start/Stop make, run here too so the operator
  // hears about it the moment they scan rather than only at Start.
  const cure = deckleCuring(newReel);
  if (!cure.cured) {
    return fail(curingBlockedMessage(newReel.rollId, cure.curedAt, cure.hours), "curing");
  }

  // Already claimed by another open card -- the entire "someone else can't
  // take it" lock. No index qualifier: every card only ever has one row in
  // practice, but this catches any that don't.
  const clash = await SlittingJobCard.findOne({
    _id: { $ne: card._id },
    status: "allocated",
    "slittingLog.deckleStockId": newReel._id,
  }).select("slittingJobCardId machineName").lean();
  if (clash) {
    return fail(
      `${newReel.rollId} is already on card ${clash.slittingJobCardId}${clash.machineName ? ` (${clash.machineName})` : ""}.`,
      "in-use",
    );
  }

  // Keep the Deckle being let go. Its planned allocation is not lost: it is
  // free stock again, and the queue lists it as "came off <card>" until it is
  // run or allocated to another job.
  if (row.deckleStockId && String(row.deckleStockId) !== String(newReel._id)) {
    row.swappedFrom.push({
      deckleStockId: row.deckleStockId,
      deckleId: row.deckleId || "",
      cardId: card._id,
      slittingJobCardId: card.slittingJobCardId || "",
      at: new Date(),
      by: trim(by) || "",
    });
  }
  row.deckleStockId = newReel._id;
  row.deckleId = newReel.rollId || "";
  // The card's own snapshot fields should name the reel actually on it now.
  card.lotNo = newReel.rollId || card.lotNo;
  card.location = newReel.location || card.location;
  await card.save();

  return {
    ok: true,
    row: {
      deckleId: row.deckleId,
      reelMtrs: round2(Number(newReel.reelMtrs) || 0),
      curing: {
        cured: cure.cured,
        hotMelt: cure.hotMelt,
        hours: cure.hours,
        curedAt: cure.curedAt ? cure.curedAt.toISOString() : null,
        curedAtLabel: cure.curedAt ? curingWhenLabel(cure.curedAt) : "",
      },
    },
  };
}

router.post("/slitting/jobcard/row/swap-deckle", requireAuth, requireSlittingFloor, updateLimiter, async (req, res) => {
  try {
    const { cardId, index, rollId } = req.body || {};
    const by = req.session?.authUser?.username || req.session?.authUser?.empName || "SYSTEM";
    const result = await swapSlittingDeckle({ cardId, index, rollId, by });
    if (!result.ok) {
      return res.status(result.status).json({ success: false, message: result.message, code: result.code });
    }
    res.json({ success: true, unchanged: result.unchanged, row: result.row });
  } catch (err) {
    console.error("SLITTING ROW SWAP-DECKLE ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to swap the Deckle." });
  }
});

// Stamps the clock on one row when the operator punches Start. Deliberately
// separate from produce: a run that is started and then abandoned leaves a
// start time and no stock movement, which is exactly what happened.
// ---- Live signals for the Slitting WIP page --------------------------------
// The slitting counterparts of routes/system/machine.js's startLiveSetting /
// pauseLiveJob / endLivePause and routes/api/operatorApi.js's claim/heartbeat,
// written onto the SlittingJobCard (models/inventory/slittingJobCard.js). The
// card is updated per punch, so the started-not-done slittingLog row is itself
// the "liveRun" -- these manage the Job Setting live row, the hold, the running
// claim and the "when the card was played" stamp. All are repeat-safe so the
// operator app can resend them from its offline outbox.
const SLITTING_CLAIM_STALE_MS = 15 * 60 * 1000; // mirrors JOB_CLAIM_STALE_MS
const SLITTING_HEARTBEAT_MS = 60 * 1000;
const SLITTING_PAUSE_LOG_MAX = 50;
const asDate = (at) => (at instanceof Date ? at : at != null ? new Date(at) : new Date());

// A fresh claim or null -- the same 15-min rule as activeClaim in
// routes/api/operatorApi.js, kept local to avoid a slitting->operatorApi import
// cycle (operatorApi already imports from here).
export function slittingActiveClaim(runningOn, now = Date.now()) {
  if (!runningOn || !runningOn.deviceId) return null;
  const seen = runningOn.lastSeenAt || runningOn.claimedAt;
  if (!seen) return null;
  return now - new Date(seen).getTime() > SLITTING_CLAIM_STALE_MS ? null : runningOn;
}

// Why an allocation can't be undone, or null when it can. Allocating a card
// writes nothing but the card itself (no reel, no order), so undoing an
// allocation is removing that card -- and only while nothing has happened on
// it yet. Shared by the machine queue's Undo button and the undo route, so the
// button and the server can never disagree.
export function slittingUndoBlock(card, now = Date.now()) {
  if (card.status !== "allocated") return "This card is already finished.";
  const log = card.slittingLog || [];
  if (log.some((r) => r.status === "done")) return "A Deckle on this card has already been run.";
  if (log.some((r) => r.startTime || r.startMtrs != null)) {
    return "A Deckle on this card has been started, so the card can't be undone.";
  }
  if (card.liveStartedAt || card.liveSetting?.startTime) return "This card is in use on the floor right now.";
  if (slittingActiveClaim(card.runningOn, now)) return "A device is running this card right now.";
  return null;
}

// Mutate the in-memory card: stamp it as first played at `at` (once -- the
// earliest punch wins). Caller saves.
function stampSlittingStart(card, at) {
  const t = asDate(at);
  if (!card.liveStartedAt || new Date(card.liveStartedAt).getTime() > t.getTime()) {
    card.liveStartedAt = t;
  }
}

// File the current hold into livePauseLog and clear it. On a plain punch only a
// hold that began BEFORE the punch is closed (a late-arriving older punch can't
// end a newer Pause); on an explicit Resume it is always closed. Mutates the
// in-memory card; returns whether anything changed. Caller saves.
function closeSlittingPause(card, at, { explicit = false } = {}) {
  const since = card.livePause?.since ? new Date(card.livePause.since) : null;
  if (!since) return false;
  const to = asDate(at);
  if (!explicit && since.getTime() > to.getTime()) return false;
  const log = Array.isArray(card.livePauseLog) ? card.livePauseLog : [];
  log.push({ from: since, to, reason: card.livePause.reason || "" });
  card.livePauseLog = log.slice(-SLITTING_PAUSE_LOG_MAX);
  card.livePause = undefined;
  card.markModified("livePause");
  return true;
}

function clearSlittingSetting(card) {
  card.liveSetting = undefined;
  card.markModified("liveSetting");
}

// A Job Setting row's Start / Stop punch -- the WIP page's JOB SETTING phase and
// (for Start) the first thing that makes a card STARTED. The setting readings
// themselves are still saved in bulk by saveSlittingSetting; this only carries
// the live server-clock so the phase shows in real time. Index-tolerant: the
// bulk save may not have created the row yet, so liveSetting is held at card
// level regardless and the row is stamped only if present.
export async function startSlittingSetting({ cardId, index, startTime, startMtrs, at }) {
  if (!mongoose.isValidObjectId(cardId)) return { ok: false, status: 400, code: "bad-request" };
  const card = await SlittingJobCard.findById(cardId);
  if (!card) return { ok: false, status: 404, code: "no-card" };
  const i = Number(index);
  const when = asDate(at);
  const row = Number.isInteger(i) ? card.jobSetting?.[i] : null;
  if (row && !row.startedAt) row.startedAt = when;
  card.liveSetting = { index: Number.isInteger(i) ? i : undefined, startedAt: when, startTime: trim(startTime), startMtrs: numOrNull(startMtrs) };
  stampSlittingStart(card, when);
  closeSlittingPause(card, when);
  await card.save();
  return { ok: true, code: "started" };
}

export async function stopSlittingSetting({ cardId, index, at }) {
  if (!mongoose.isValidObjectId(cardId)) return { ok: false, status: 400, code: "bad-request" };
  const card = await SlittingJobCard.findById(cardId);
  if (!card) return { ok: false, status: 404, code: "no-card" };
  const i = Number(index);
  const when = asDate(at);
  const row = Number.isInteger(i) ? card.jobSetting?.[i] : null;
  if (row && !row.stoppedAt) row.stoppedAt = when;
  if (card.liveSetting && Number(card.liveSetting.index) === i) clearSlittingSetting(card);
  closeSlittingPause(card, when);
  await card.save();
  return { ok: true, code: "stopped" };
}

// Pause / Resume -- the operator stepping away without ending the card. The WIP
// page then shows it ON HOLD and freezes its clock. Repeat-safe: a second Pause
// keeps the first one's time; a Resume with nothing on hold is a no-op.
export async function pauseSlittingCard({ cardId, reason, deviceLabel, at }) {
  if (!mongoose.isValidObjectId(cardId)) return { ok: false, status: 400, code: "bad-request" };
  const card = await SlittingJobCard.findById(cardId);
  if (!card) return { ok: false, status: 404, code: "no-card" };
  if (!card.livePause?.since) {
    card.livePause = { since: asDate(at), reason: trim(reason), deviceLabel: trim(deviceLabel) };
    await card.save();
  }
  return { ok: true, code: "paused" };
}

export async function resumeSlittingCard({ cardId, at }) {
  if (!mongoose.isValidObjectId(cardId)) return { ok: false, status: 400, code: "bad-request" };
  const card = await SlittingJobCard.findById(cardId);
  if (!card) return { ok: false, status: 404, code: "no-card" };
  const changed = closeSlittingPause(card, asDate(at), { explicit: true });
  if (changed) await card.save();
  return { ok: true, code: changed ? "resumed" : "not-paused" };
}

// Running-device claim + heartbeat -- atomic conditional writes, the exact
// pattern of operatorApi.js's /jobcard/claim and /heartbeat, so two devices
// can't both run one card.
export async function claimSlittingCard({ cardId, deviceId, deviceLabel }) {
  if (!mongoose.isValidObjectId(cardId) || !deviceId) return { ok: false, status: 400, code: "bad-request" };
  const now = new Date();
  const staleBefore = new Date(now.getTime() - SLITTING_CLAIM_STALE_MS);
  const claimed = await SlittingJobCard.findOneAndUpdate(
    {
      _id: cardId,
      $or: [
        { runningOn: null },
        { "runningOn.deviceId": { $in: [null, ""] } },
        { "runningOn.deviceId": { $exists: false } },
        { "runningOn.deviceId": deviceId },
        { "runningOn.lastSeenAt": { $lt: staleBefore } },
      ],
    },
    { $set: { runningOn: { deviceId, deviceLabel: trim(deviceLabel), claimedAt: now, lastSeenAt: now } } },
    { new: true, projection: { runningOn: 1 } },
  ).lean();
  if (!claimed) return { ok: false, status: 409, code: "running-elsewhere" };
  return { ok: true, code: "claimed", heartbeatMs: SLITTING_HEARTBEAT_MS };
}

export async function heartbeatSlittingCard({ cardId, deviceId }) {
  if (!mongoose.isValidObjectId(cardId) || !deviceId) return { ok: false, status: 400, code: "bad-request" };
  const result = await SlittingJobCard.updateOne(
    { _id: cardId, "runningOn.deviceId": deviceId },
    { $set: { "runningOn.lastSeenAt": new Date() } },
  );
  if (!result.matchedCount) return { ok: false, status: 409, code: "claim-lost" };
  return { ok: true };
}

export async function startSlittingRow({ cardId, index, startTime, startMtrs, at }) {
  if (!mongoose.isValidObjectId(cardId)) return { ok: false, status: 400, message: "Invalid card." };

  const card = await SlittingJobCard.findById(cardId);
  if (!card) return { ok: false, status: 404, message: "Card not found." };

  const i = Number(index);
  const row = card.slittingLog?.[i];
  if (!row) return { ok: false, status: 400, message: "That Deckle is not on this card." };
  if (row.status === "done") return { ok: false, status: 400, message: "That Deckle has already been run." };

  // The machine's own counter reading at this moment -- same gate as the
  // Job Setting table above: Start won't punch without it.
  const startMtrsNum = numOrNull(startMtrs);
  if (startMtrsNum === null) {
    return { ok: false, status: 400, message: "Enter the machine's counter reading before punching Start." };
  }

  // Curing gate: the adhesive must have cured before the web is run.
  const cureReel = await MaterialStock.findById(row.deckleStockId)
    .select("rollId createdAt")
    .populate({ path: "material", select: CURING_MATERIAL_FIELDS })
    .lean();
  if (cureReel) {
    const cure = deckleCuring(cureReel);
    if (!cure.cured) {
      return {
        ok: false,
        status: 400,
        code: "curing",
        message: curingBlockedMessage(cureReel.rollId || row.deckleId || "this reel", cure.curedAt, cure.hours),
      };
    }
  }

  row.startMtrs = startMtrsNum;
  row.startTime = trim(startTime) || row.startTime;
  // Live signals for the WIP page: this Deckle is on the slitter now (startedAt
  // is what its ETA is counted from), the card is played, Job Setting is over,
  // and any hold older than this punch ends.
  const when = asDate(at);
  if (!row.startedAt) row.startedAt = when;
  stampSlittingStart(card, when);
  clearSlittingSetting(card);
  closeSlittingPause(card, when);
  await card.save();
  return { ok: true, startTime: row.startTime, startMtrs: row.startMtrs };
}

// Undo an allocation: take an unrun slitting card off its machine. Its Deckle
// goes back to the Slitting Queue, which is the whole of the undo, because
// allocation wrote nothing else (see slittingUndoBlock).
router.post("/slitting/jobcard/:cardId/undo", requireAuth, requireSlittingPlanner, updateLimiter, async (req, res) => {
  const queueOf = (machineId) => (machineId ? `/app/machine/${machineId}/queue` : "/app/slitting/queue");
  try {
    const { cardId } = req.params;
    if (!mongoose.isValidObjectId(cardId)) {
      req.flash("notification", "Invalid slitting card.");
      return res.redirect("/app/slitting/queue");
    }
    const card = await SlittingJobCard.findById(cardId)
      .select("slittingJobCardId status slittingLog liveStartedAt liveSetting runningOn machineId machineName lotNo operatorId")
      .lean();
    if (!card) {
      req.flash("notification", "That slitting card no longer exists.");
      return res.redirect("/app/slitting/queue");
    }
    const back = queueOf(card.machineId);
    const reason = slittingUndoBlock(card);
    if (reason) {
      req.flash("notification", `${card.slittingJobCardId} can't be undone. ${reason}`);
      return res.redirect(back);
    }
    // Guarded on status too, so a card finished between the read and this
    // delete is kept, not removed.
    const result = await SlittingJobCard.deleteOne({ _id: card._id, status: "allocated" });
    if (!result.deletedCount) {
      req.flash("notification", `${card.slittingJobCardId} changed while you were undoing it. Check the queue and try again.`);
      return res.redirect(back);
    }
    notifyOperatorQueue(card.operatorId);
    res.locals.auditDescription = `Undid slitting allocation ${card.slittingJobCardId} (Deckle ${card.lotNo || "—"}) on ${card.machineName || "machine"}`;
    req.flash("notification", `${card.slittingJobCardId} is undone. Its Deckle is back in the Slitting Queue.`);
    return res.redirect(back);
  } catch (err) {
    console.error("SLITTING CARD UNDO ERROR:", err);
    req.flash("notification", "Failed to undo the slitting allocation.");
    return res.redirect("/app/slitting/queue");
  }
});

router.post("/slitting/jobcard/row/start", requireAuth, requireSlittingFloor, updateLimiter, async (req, res) => {
  try {
    const { cardId, index, startTime, startMtrs } = req.body || {};
    const result = await startSlittingRow({ cardId, index, startTime, startMtrs });
    if (!result.ok) return res.status(result.status).json({ success: false, message: result.message });
    res.json({ success: true, startTime: result.startTime, startMtrs: result.startMtrs });
  } catch (err) {
    console.error("SLITTING ROW START ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to record the start time." });
  }
});

// Stop. Inwards this row's finished rolls -- one per allocated roll width --
// and draws the metres that actually ran off the Deckle. This is the only
// place slitting moves stock. `b` is the punch as the client sent it
// (cardId, index, stopMtrs, meter, runningMeter, joint, jointMtr, endTime);
// `createdBy` is whoever is signed in, which differs by front end -- a
// session user on the EJS card, the bearer-token operator in the app.
export async function produceSlittingRow(b, { createdBy, at } = {}) {
  const fail = (message) => ({ ok: false, status: 400, message });

  if (!mongoose.isValidObjectId(b.cardId)) return fail("Invalid card.");

  const card = await SlittingJobCard.findById(b.cardId);
  if (!card) return { ok: false, status: 404, message: "Card not found." };

  const i = Number(b.index);
  const row = card.slittingLog?.[i];
  if (!row) return fail("That Deckle is not on this card.");

  // Idempotent replay: this row's rolls already exist, so the first attempt
  // committed and only its response was lost. Hand back the same rolls
  // rather than inwarding a second set.
  if (row.status === "done") {
    return {
      ok: true,
      replayed: true,
      rollIds: (row.cuts || []).map((c) => c.rollId).filter(Boolean),
      rolls: (row.cuts || [])
        .filter((c) => c.stockId && c.rollId)
        .map((c) => ({ stockId: String(c.stockId), rollId: c.rollId, productCode: card.productCode || "" })),
      meter: row.meter,
      runningMeter: row.runningMeter,
      stopMtrs: row.stopMtrs,
      endTime: row.endTime,
      cardCompleted: card.status === "completed",
    };
  }

  // The machine's own counter reading at this moment -- same gate Start
  // already passed. Must be at or past the Start reading; a smaller Stop
  // reading means the wrong number was punched in, not a real run.
  const stopMtrs = numOrNull(b.stopMtrs);
  if (stopMtrs === null) return fail("Enter the machine's counter reading before punching Stop.");
  // A row started before the Start reading was captured carries none --
  // take the one the operator typed into its (still editable) Start box so
  // the filed card isn't left with half a measurement. Never overwrites a
  // reading the row already has.
  if (row.startMtrs == null) {
    const backfilled = numOrNull(b.startMtrs);
    if (backfilled !== null) row.startMtrs = backfilled;
  }
  if (row.startMtrs != null && stopMtrs < row.startMtrs) {
    return fail(`Stop reading (${stopMtrs}) can't be less than the Start reading (${row.startMtrs}).`);
  }

  // The operator confirms what actually ran; the plan (and the counter
  // difference above) are only defaults -- see the schema note on `meter`.
  const meter = numOrNull(b.meter);
  if (!(meter > 0)) return fail("Enter the metres that actually ran.");
  const runningMeter = numOrNull(b.runningMeter);
  if (!(runningMeter > 0)) return fail("Enter the R. Meter wound on each roll.");

  const cuts = Array.isArray(row.cuts) ? row.cuts.filter((c) => Number(c.width) > 0) : [];
  if (!cuts.length) return fail("This Deckle has no roll widths allocated.");

  const reel = await MaterialStock.findById(row.deckleStockId)
    .populate({ path: "material", select: `productCode skuCode ${CURING_MATERIAL_FIELDS}` })
    .lean();
  if (!reel) return fail("That Deckle no longer exists.");

  // Curing gate: refuse to slit a web whose adhesive has not cured (CHROMO 6 h,
  // PP 8 h after lamination), unless it's a hot-melt build.
  const cure = deckleCuring(reel);
  if (!cure.cured) {
    return fail(curingBlockedMessage(reel.rollId || row.deckleId || "this reel", cure.curedAt, cure.hours));
  }

  const available = round2(Number(reel.reelMtrs) || 0);
  if (meter > available) {
    return fail(`Deckle "${reel.rollId}" only has ${available} mtrs left — you entered ${meter}.`);
  }

  const location = trim(reel.location) || card.location;
  if (!location) return fail("The Deckle has no stock location on it.");

  const material = reel.material?._id || reel.material;
  const code = reel.material?.productCode || reel.material?.skuCode || card.productCode;
  if (!trim(code)) return fail("The Deckle's Label Stock has no Product Code.");

  // ---- What each finished roll is worth ---------------------------------
  // The rate a roll carries is the rate its own SALES ORDER was placed at
  // (PendingProduction.orderRate, synced from the order -- see
  // utils/pendingProduction.js). Deliberately NOT reel.rate, which this
  // used to copy: a Deckle is semi-finished stock and carries a material
  // cost at best, never a sale price, so that left every slit roll with a
  // blank (or plain wrong) rate on Finished Stock.
  //
  // A deckle batch bundles SEVERAL orders' widths onto one web
  // (isDeckleBatch/batchOrderIds), and those orders can be at different
  // rates -- so this is matched per roll width, not taken once for the
  // card: exact width + R. Meter first, then width alone, then the card's
  // own order. Nothing matching leaves the rate unset rather than
  // inventing one; Finished Stock can still have it typed in by hand.
  const pending = await PendingProduction.findById(card.pendingProductionId)
    .select("orderRate paperSize runningMeters batchOrderIds")
    .lean();
  const rateSources = [];
  if (pending?.batchOrderIds?.length) {
    rateSources.push(
      ...(await PendingProduction.find({ _id: { $in: pending.batchOrderIds } })
        .select("orderRate paperSize runningMeters")
        .lean()),
    );
  }
  if (pending) rateSources.push(pending);

  const sizeNum = (v) => {
    const m = /-?\d+(\.\d+)?/.exec(String(v ?? ""));
    return m ? Number(m[0]) : null;
  };
  const priced = rateSources.filter((s) => Number(s?.orderRate) > 0);
  const rateForWidth = (width) => {
    const w = sizeNum(width);
    if (w === null) return undefined;
    const sameWidth = priced.filter((s) => sizeNum(s.paperSize) === w);
    const exact = sameWidth.find((s) => Number(s.runningMeters) === round2(runningMeter));
    const hit = exact || sameWidth[0];
    return hit ? Number(hit.orderRate) : undefined;
  };

  // ---- Finished Goods in ------------------------------------------------
  // One roll per allocated width. The roll is booked against the Deckle's
  // OWN Label Stock (a variant "-A" web stays an "-A" roll), not the
  // order's SKU, so finished stock keeps naming what was physically made.
  const bal = await FinishedStock.aggregate([
    { $match: { material: new mongoose.Types.ObjectId(String(material)), location } },
    { $group: { _id: null, qty: { $sum: "$quantity" } } },
  ]);
  let opening = bal[0]?.qty || 0;

  // Every roll this Stop creates is named off the physical Deckle itself,
  // not the generic ITEMCODE/YY-YY/NNN sequence: <deckleId>-<slot> for the
  // first time this reel is slit, then <deckleId>-<slot><runIndex> (1, 2,
  // ...) for a later run off whatever mtrs were left over from an earlier
  // partial Stop -- runIndex is this reel's own slitRunCount, so it stays
  // right regardless of which card that later run happens to be on.
  const runIndex = Number(reel.slitRunCount) || 0;
  const runSuffix = runIndex === 0 ? "" : String(runIndex);

  const createdRolls = [];
  // The finished rolls, with their stock ids -- so the app can auto-print each
  // one's label the moment Stop is punched, the same way the lamination card
  // auto-prints a Deckle (its print queue fetches the label by stock id).
  const createdRollDocs = [];
  for (const cut of cuts) {
    const rollId = `${reel.rollId}-${cut.slot}${runSuffix}`;
    // Grace: the knife cut `width`, but the client ordered -- and is billed --
    // `orderedWidth`, which the allocation stamped on this cut from the batch's
    // layout. Everything commercial runs off the ordered width: the rate lookup
    // (it matches a sales order's own paperSize, which a graced width would
    // never hit, leaving the roll unpriced), the roll's paperSize, and so the
    // client's bill and the export to FAIRTECH. What was physically cut is kept
    // beside it. Ungraced cuts have no orderedWidth and behave exactly as
    // before: the cut IS the order.
    const ordered = Number(cut.orderedWidth);
    const graced = ordered > 0 && Number(cut.width) - ordered > 0.005;
    const billWidth = graced ? ordered : cut.width;
    const rollRate = rateForWidth(billWidth);
    const doc = await FinishedStock.create({
      pendingProductionId: card.pendingProductionId,
      material,
      deckleStockId: reel._id,
      deckleRollId: reel.rollId,
      location,
      // The finished roll's own width -- the knife position it came off,
      // not the order's nominal size (they differ on a mixed layout).
      paperSize: String(billWidth),
      cutWidth: graced ? round2(Number(cut.width)) : undefined,
      lotNo: reel.lotNo || card.lotNo || "",
      clientName: card.clientName || "",
      quantity: 1,
      mtrs: round2(runningMeter),
      rate: rollRate,
      rollId,
    });
    cut.rollId = rollId;
    cut.stockId = doc._id;
    createdRolls.push(rollId);
    createdRollDocs.push({ stockId: String(doc._id), rollId, productCode: code });

    await FinishedStockLog.create({
      material,
      location,
      openingStock: opening,
      quantity: 1,
      closingStock: opening + 1,
      mtrs: round2(runningMeter),
      rate: rollRate,
      rollId,
      type: "INWARD",
      source: "SYSTEM",
      remarks: `${card.slittingJobCardId}: slit from Deckle ${reel.rollId} at ${cut.slot} — ${cut.width} mm × ${round2(runningMeter)} mtrs`,
      createdBy,
    });
    opening += 1;
  }

  // ---- Semi Finished Goods out ------------------------------------------
  // Same emptying rule as every other consumer of a Deckle: a reel taken to
  // 0 mtrs is emptied, quantity and all.
  const remaining = round2(available - meter);
  const emptied = remaining <= 0;
  await MaterialStock.updateOne(
    { _id: reel._id },
    {
      ...(emptied ? { $set: { reelMtrs: 0, quantity: 0 } } : { $set: { reelMtrs: remaining } }),
      $inc: { slitRunCount: 1 },
    },
  );

  const matBal = await MaterialStock.aggregate([
    { $match: { material: new mongoose.Types.ObjectId(String(material)), location: reel.location } },
    { $group: { _id: null, qty: { $sum: "$quantity" } } },
  ]);
  // The update above already landed, so add the emptied roll back to
  // recover the balance as it stood before this line.
  const matOpening = (matBal[0]?.qty || 0) + (emptied ? 1 : 0);
  await MaterialStockLog.create({
    material,
    location: reel.location,
    openingStock: matOpening,
    quantity: emptied ? 1 : 0,
    closingStock: matOpening - (emptied ? 1 : 0),
    reelMtrs: round2(meter),
    rate: reel.rate,
    rollId: reel.rollId,
    type: "OUTWARD",
    source: "SYSTEM",
    remarks: `${card.slittingJobCardId}: ${round2(meter)} mtrs slit into ${createdRolls.length} finished roll(s)${emptied ? " — reel emptied" : ""}`,
    createdBy,
  });

  // ---- Close the row, and the card once its last row is done ------------
  const cutTotal = round2(cuts.reduce((n, c) => n + Number(c.width), 0));
  row.status = "done";
  row.stopMtrs = stopMtrs;
  row.meter = round2(meter);
  row.runningMeter = round2(runningMeter);
  row.trim = row.width != null ? round2(row.width - cutTotal) : undefined;
  row.joint = trim(b.joint) || undefined;
  row.jointMtr = numOrNull(b.jointMtr) ?? undefined;
  row.endTime = trim(b.endTime) || row.endTime;
  // producedAt is the WIP page's clock for "when this Deckle came off" -- the
  // event time (eventTimeOf, for an app punch that waited in the outbox), else now.
  row.producedAt = asDate(at);
  // This Deckle's run is over: Job Setting (if any) is done and a hold older than
  // the Stop ends. The next Deckle's Start re-arms everything.
  clearSlittingSetting(card);
  closeSlittingPause(card, row.producedAt);

  const done = card.slittingLog.filter((r) => r.status === "done");
  card.totalDeckleMeter = round2(done.reduce((n, r) => n + (Number(r.meter) || 0), 0));
  card.totalRolls = done.reduce((n, r) => n + (Array.isArray(r.cuts) ? r.cuts.length : 0), 0);
  card.totalFinishedMeter = round2(
    done.reduce((n, r) => n + (Number(r.runningMeter) || 0) * (Array.isArray(r.cuts) ? r.cuts.length : 0), 0),
  );
  const allDone = card.slittingLog.every((r) => r.status === "done");
  if (allDone) {
    card.status = "completed";
    card.completedAt = new Date();
    // The card is off the floor -- drop the running claim rather than waiting
    // for it to go stale (mirrors the lamination save unsetting runningOn).
    card.runningOn = undefined;
    card.markModified("runningOn");
  }
  await card.save();

  return {
    ok: true,
    auditDescription:
      `${card.slittingJobCardId}: slit Deckle "${reel.rollId}" into ${createdRolls.length} finished roll(s) — ${createdRolls.join(", ")}`,
    rollIds: createdRolls,
    rolls: createdRollDocs,
    meter: row.meter,
    runningMeter: row.runningMeter,
    stopMtrs: row.stopMtrs,
    endTime: row.endTime,
    emptied,
    cardCompleted: allDone,
  };
}

router.post("/slitting/jobcard/row/produce", requireAuth, requireSlittingFloor, createLimiter, async (req, res) => {
  try {
    const createdBy = req.session?.authUser?.username || req.session?.authUser?.empName || "SYSTEM";
    const result = await produceSlittingRow(req.body || {}, { createdBy });
    if (!result.ok) return res.status(result.status).json({ success: false, message: result.message });
    if (result.auditDescription) res.locals.auditDescription = result.auditDescription;
    const { ok, status, auditDescription, ...payload } = result;
    res.json({ success: true, ...payload });
  } catch (err) {
    console.error("SLITTING ROW PRODUCE ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to move these rolls to Finished Stock." });
  }
});

// Corrects the Joint note on an already-run row -- the one piece of a
// finished row's record that ISN'T tied to a stock movement. meter,
// runningMeter and cuts[].rollId already deducted the reel and inwarded the
// finished rolls at Stop and are never reopened here or anywhere else; only
// this note can still be off (wrong joint type, wrong metre reading) without
// touching stock. Mirrors the lamination Job Card's own Edit pencil, which
// likewise only ever unlocks non-quantity fields on a produced row.
export async function editSlittingRowJoint({ cardId, index, joint, jointMtr }) {
  if (!mongoose.isValidObjectId(cardId)) return { ok: false, status: 400, message: "Invalid card." };

  const card = await SlittingJobCard.findById(cardId);
  if (!card) return { ok: false, status: 404, message: "Card not found." };

  const i = Number(index);
  const row = card.slittingLog?.[i];
  if (!row) return { ok: false, status: 400, message: "That row is not on this card." };
  if (row.status !== "done") {
    return { ok: false, status: 400, message: "Punch Stop on this Deckle before editing its joint note." };
  }

  row.joint = trim(joint);
  row.jointMtr = numOrNull(jointMtr);
  await card.save();

  return { ok: true, joint: row.joint, jointMtr: row.jointMtr };
}

router.post("/slitting/jobcard/row/edit", requireAuth, requireSlittingFloor, updateLimiter, async (req, res) => {
  try {
    const { cardId, index, joint, jointMtr } = req.body || {};
    const result = await editSlittingRowJoint({ cardId, index, joint, jointMtr });
    if (!result.ok) return res.status(result.status).json({ success: false, message: result.message });
    res.json({ success: true, joint: result.joint, jointMtr: result.jointMtr });
  } catch (err) {
    console.error("SLITTING ROW EDIT ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to save the joint note." });
  }
});

// Does this operator own that slitting card? The EJS card has no per-operator
// check -- any floor user can open any card there -- but the mobile app is
// operator-only, so ownership has to be enforced explicitly rather than
// falling out of "which page can you even reach" (the same rule every other
// route in routes/api/operatorApi.js follows). Returns the card's own
// operatorId so the caller can answer 404 vs 403 distinctly.
export async function slittingCardOperatorId(cardId) {
  if (!mongoose.isValidObjectId(cardId)) return null;
  const card = await SlittingJobCard.findById(cardId).select("operatorId").lean();
  return card ? String(card.operatorId || "") : null;
}

export default router;
