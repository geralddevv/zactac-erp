# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start          # Run the server (node server.js) — port from PORT in .env (required; the app refuses to start without it)
```

No test suite, no build step — plain Node.js ES-module project.

Utility scripts (run directly). Signature/backfill ones are dry-run by default — pass `--apply` to commit:
```bash
node scripts/backfill-prodbinding-signatures.js
node scripts/backfill-prodbinding-calc.js
node scripts/backfill-employee-nickname.js       # empNickName = first word of empName
node scripts/backfill-task-assignee.js           # Task assignedToName / createdById / createdByName (+ completedAt) from the ids already on the row
node scripts/backfill-facestock-signatures.js    # repair Facestock Master dup protection (also drops old vendor+SKU index)
node scripts/backfill-adhesive-signatures.js     # same, Adhesive Master
node scripts/backfill-release-signatures.js      # repair Release Master dup protection
node scripts/backfill-releaselinerstock-sensing.js  # ReleaseLinerStock.sensing <- its Release Master's (Release Liner allocation matches on Sensing alone)
node scripts/backfill-core-signatures.js         # repair Core Master dup protection
node scripts/drop-legacy-skucode-index.js        # drop dead skuCode_1 index on Facestock/Adhesive/Release/Core Master
node scripts/send-back-to-pending.js <orderId>   # unassign one WIP order back to Pending (CLI form of the UI button)
node scripts/clear-label-stock-layer-data.js     # wipe SachikoLabelStock facestock/adhesive/releaseLiner (+2) so they're re-picked from master
node scripts/backfill-pendingproduction-allotted-layers.js  # PendingProduction allottedLayers <- parsed from the produced Deckle's log
node scripts/backfill-labelstock-signatures.js   # repair SachikoLabelStock dup protection
node scripts/backfill-finishedstock-rate.js      # price slit rolls that landed with no rate from their sales order's orderRate
node scripts/resignature-labelstock.js           # resync every /sachiko/label-stock/view row's labelStockSignature + list rows sharing a recipe
node scripts/serialize-labelstock-sku-codes.js   # close gaps in SachikoLabelStock skuCode + re-anchor variant SKUs ("000002-A") to their base row
node scripts/dissolve-deckle.js [deckleId]       # un-make a Deckle, returning its mtrs to the raw reels it was laminated from
node scripts/backfill-family-master-seed.js      # seed Family master from values in use + old hardcoded dropdown
node scripts/backfill-type-master-seed.js        # seed Type master likewise (Facestock / Adhesive / Release Master)
node scripts/backfill-location-master-seed.js    # seed Location master likewise (employee records + old Employee form dropdown)
node scripts/deckle-optimizer-bench.js [--verbose]  # bench + invariant check for utils/deckleOptimizer; no DB, exits non-zero on failure
node scripts/raw-auto-allot-bench.js [--verbose]    # invariant check for public/js/rawAutoAllot.js; no DB, exits non-zero on failure
node scripts/reset-transactional-data.js         # empty orders/production/bindings, KEEP masters+stock+people (dry-run; --apply --db=<name>)
node scripts/company-slug-history.js             # manual override for URL prefixes the company is served under (--add <slug> --apply)
node scripts/rewrite-id-prefix.js --from SP --to GM  # move ids left behind by an older company code
```

## Environment

Requires a `.env` file with at minimum:
- `SESSION_SECRET` — app crashes at startup without it
- `PORT` — app crashes at startup without it (no default)
- `MONGO_URI` (or equivalent — see `config/db.js`)
- `TASKS_MONGO_URI` (optional) — `/fairtech/tasks` stores data in a separate isolated DB (`config/tasksDb.js`). Defaults to sibling database `<main db>_tasks` on the same server.
- `DECKLE_AUTO_ENABLED` (optional) — kill switch for the Auto Deckle optimizer. On unless `false`/`0`/`off`/`no`; off (restart needed) removes the Auto Set panel and client code, API returns 503.
- `TASK_REMINDERS_ENABLED` (optional) — kill switch for the due-soon/overdue task reminder job (`utils/taskReminders.js`, every 15 min). Same on-unless-`false`/`0`/`off`/`no` form; restart to change.
- Dev only: `PROPRIETOR_USER/PASS`, `ADMIN_USER/PASS`, `HR_USER/PASS`, `HOD_USER/PASS`, `SALES_USER/PASS` (backdoor accounts; blocked in production)

## Architecture

### Route structure

All routes live under `/fairtech/`, split into sub-routers mounted in `server.js`:

| Mount point | File |
|---|---|
| `/fairtech/*` (main views) | `routes/fairdesk_route.js` |
| `/fairtech/` (machine master + binding) | `routes/system/machine.js` |
| `/fairtech/payroll` | `routes/acccounting/payroll.js` |
| `/fairtech/loan` | `routes/acccounting/loan.js` |
| `/fairtech/advance` | `routes/acccounting/advance.js` |
| `/fairtech/employee` | `routes/hr/employee.js` |
| `/fairtech/client` | `routes/users/clients.js` |
| `/fairtech/` (tape/ttr bindings) | `routes/inventory/*.js` |
| `/fairtech/tapestock` etc. | `routes/stock/*.js` |

Roles: `proprietor`, `admin`, `hod`, `sales`, `hr`, `employee`, `master`, `operator`. `proprietor` sits above `admin` and gets access everywhere `admin` does. Guard with `requireAuth` / `requireRole([...])` from `middleware/auth.js`.

`operator` is session-only: shopfloor operators sign in at `/fairtech/operator/login` with nick name (`empNickName`) + location + password (employee record has `empProfile: "OPERATOR"`, `role: "none"`) and land on the queue of the machine named by their profile code. They reach only `routes/system/machine.js` — mounted ahead of the other `/fairtech` routers, since each of those runs `requireRole` for every `/fairtech/*` request, not just its own paths.

### View rendering pattern

Every route renders an EJS view in the `boilerplate.ejs` layout (views start with `<% layout('/layout/boilerplate') %>`):

```js
res.render("inventory/machineMaster.ejs", {
  JS: false,            // or "filename.js" — loaded as /js/<filename>
  CSS: "tableDisp.css", // or false — loaded as /css/<filename>
  title: "Machine Master",
  notification: req.flash("notification"),
});
```

The layout loads `common.css`, `choices.min.css`, Bootstrap, Font Awesome and `common.js` on every page. `.indi-head` lives in `tableDisp.css` — pass `CSS: "tableDisp.css"` when using it.

### CSRF

`common.js` wraps `window.fetch` to inject `x-csrf-token`, and intercepts POST form submits to inject `_csrf` (or include `<input type="hidden" name="_csrf" value="<%= csrfToken %>">`). Multipart uploads can't carry the token in the body (csurf can't find it) — send it as an `x-csrf-token` header.

### Rate limiting

Every mutating route uses limiters from `utils/limiters.js`:

```js
import { createLimiter, updateLimiter, deleteLimiter } from "../../utils/limiters.js";
router.post("/...",   requireAuth, createLimiter, handler);
router.put("/...",    requireAuth, updateLimiter, handler);
router.delete("/...", requireAuth, deleteLimiter, handler);
```

### Photo / video uploads (shared media store)

`utils/media.js` is the one way to take a photo/video. It compresses (images → EXIF-rotated JPEG ≤1600px; videos → faststart H.264 MP4 ≤1280px, trimmed to 2 min, via `ffmpeg-static`), writes a 400px JPEG thumbnail, and returns records matching `mediaAssetSchema` (`models/system/mediaAsset.js`) to embed on your document. Files live in gitignored `media/<bucket>/` (one bucket per feature) under random filenames.

```js
const upload = mediaUpload({ bucket: "maintenance", fields: [
  { name: "photo", kind: "image", maxCount: 1 },
  { name: "video", kind: "video", maxCount: 1 },
]});
router.post("/x", requireAuth, createLimiter, upload, async (req, res) => {
  const assets = await storeUploads(req.files, "maintenance");
  try { await Thing.create({ media: assets }); }
  catch (e) { await removeAssets(assets); throw e; }   // no orphan files
});
```

Serve with `sendAsset(res, asset, { thumb })` after your own auth check (honours Range, so video seeks). Route by document id + array index (see `routes/system/maintenance.js`), never filename. CSP allows `media-src 'self' blob:` (blob to preview a clip before upload); image previews must use `data:` URLs (`img-src` disallows blob).

### Notifications (header bell) and task assignment

`utils/notify.js` is the one way anything creates a notification; the bell is `public/js/notifications.js` over `routes/system/notifications.js`. **Full how-to, traps and the FAIRTECH port: `NOTIFICATIONS.md`.** The essentials:

- **A notification is addressed to an `Employee._id` in the main DB.** Get it with `sessionEmployeeId(req)` (`utils/sessionUser.js`) — `authUser.empObjId`, else resolved from `empId` once and cached back onto the session, else `null` for the dev backdoor logins (no employee record → no inbox, nothing assignable). Both logins stamp `empObjId`; never match a person on `profileCode`.
- **Links are stored on the internal `/app` prefix** (`/app/tasks?open=<id>`), stamped with the live company slug by `middleware/brandPrefix.js` on the way out — JSON bodies included. Never write the slug in.
- `notify({ userIds, actorId, type, title, link, dedupeKey, … })` drops the actor (nobody hears about their own action), refuses a link that isn't an in-app path, and never throws — so **call it after the write succeeds**. Repeating producers pass a `dedupeKey`; its unique index is **partial, not sparse** (a compound sparse index would reject every person's second notification — see `NOTIFICATIONS.md` §1).
- Notification text is user-typed: the panel builds rows with `textContent`, never `innerHTML`. Row reads/polls are kept out of the audit log (`SKIP_PREFIXES` in `middleware/auditLogger.js`).
- The router is mounted **ahead of every role-gated router** (like `machineRoutes`), since the bell is in the layout of every page.

**A new task is either sent or kept.** The New Task dialog asks "Who is this for?" first, because it decides what the rest of the form means: **Send to employee** (default) assigns it to the picked employee and rings their bell; **Keep for myself** makes it the creator's own task — the Assigned Employee field is hidden, `assignedTo` is the creator, and nobody is notified (due reminders then ring the creator's own bell, which is the point of a reminder). `assignMode` is re-decided server-side in `POST /tasks`: in `self` mode a posted `assignedTo` is **ignored outright**, so a doctored request can't put a silent task on someone else. No flag on the document — a kept reminder is simply a task you assigned to yourself, so no query, scope or notification rule needs a special case. The button is disabled for logins with no employee record (nothing for the task to belong to).

**Tasks** (`/<slug>/tasks`, isolated DB) are the first producer, and are now delegated work rather than a private to-do list. `Task.assignedTo` **is** the assignee id — the same `Employee._id` a session reduces to — with `assignedToName` as a copy beside it (no cross-database join to lean on); `createdBy` stays the creator's `empId` code (the Daybook keys on it) alongside `createdById`/`createdByName`. The page has three server-enforced scopes — **Assigned to me** (default) / **Created by me** / **All** (proprietor, admin, hod only) — plus `GET /tasks/mine` (JSON: open / overdue / done). Who may change what: the creator (or an all-scope role) everything including delete; the **assignee status only**; anyone else gets "not found", so an id gives nothing away. The Daybook draws on both (created by me **or** assigned to me). Assignment only works end to end for the roles `fairdeskRoute` is mounted for — see the note in `NOTIFICATIONS.md` §6.

### Front-end conventions

- **Embedding data**: `res.locals.safeJson`: `<script id="x" type="application/json"><%- safeJson(data) %></script>`, read with `JSON.parse(document.getElementById("x").textContent)`. Never interpolate objects into `<script>` or `onclick`. `safeJson()` turns a bare falsy value into `"{}"` — wrap booleans (`safeJson({ picked })`).
- **onclick data**: use `data-*` attributes and read via `this.dataset`; never interpolate strings into onclick.
- **Dialogs**: use `.logout-modal` / `.logout-dialog` from `boilerplate.ejs`. `<dialog style="width: min(440px, 95vw); padding: 0; border-radius: 14px; border: none;">` — **no `overflow: hidden`** (clips Choices.js dropdowns); instead `border-radius: 14px 14px 0 0` on `.dialog-header` and `0 0 14px 14px` on `.dialog-body`.
- **Choices.js v11.1.0** is global but loaded **with `defer`**, so `new Choices(...)` at the top level of an inline script throws `Choices is not defined` and kills the rest of the script. Create it on `DOMContentLoaded` or from a user action, and attach your `change` listener to the `<select>` first. In dialogs destroy/reinit:
  ```js
  if (myChoices) { myChoices.destroy(); myChoices = null; }
  sel.innerHTML = options.map(o => `<option value="${o._id}">${o.name}</option>`).join("");
  myChoices = new Choices(sel, { searchEnabled: true, shouldSort: false, itemSelectText: "" });
  ```
  Pre-select by setting `selected` on the `<option>` before init (more reliable than `setChoiceByValue`). Add `z-index: 99999` to `.choices__list--dropdown` inside dialogs.
- **Text inputs auto-uppercase**: `common.js` uppercases all `input[type="text"]`, matching the models' uppercase-name convention.

### Renaming the company moves the URL prefix (and old links follow)

The public prefix is the first word of the company name (`slugifyCompany`): renaming SACHIKO PACKAGING → RYT INFO moves the app from `/sachiko/...` to `/ryt/...` immediately (no restart; `routes/system/company.js` → `refreshBrand()`). Bookmarks on the old prefix would 404, so:

- `Company.slugHistory` records the outgoing prefix on rename; `middleware/brandPrefix.js` forwards remembered prefixes: `/sachiko/x?tab=wip` → 302 `/ryt/x?tab=wip`.
- **302 for GET/HEAD, 307 otherwise** (keeps method/body for stale-tab form posts). Deliberately not 301 — browsers cache it and it misroutes if the company is renamed back.
- Five prefixes kept, newest last, never the current one nor the internal `/app` mount.
- A DB predating the field seeds itself on first start (`seedSlugHistory()` reads past names from the audit log; `undefined` = never looked, `[]` = looked, nothing).
- `scripts/company-slug-history.js --add <slug> --apply` only for prefixes neither mechanism can know (earlier installation, pre-audit-log).
- The database itself is **not** renamed (fixed random id from `utils/companyDb.js`).

### The id code every generated id starts with

`SP | FCS | 000001`, `SP | LS | 000047`, `SP | LOT | 0042` — `SP` is the **company's id code** (`Company.idPrefix`), read live via `currentIdPrefix()` in `utils/companyBrand.js` at mint time (no restart on change).

- **Typed, with a suggestion**: pre-filled by `suggestIdPrefix()` (initials; first two letters for one-word names: SACHIKO PACKAGING → SP, ZACTAC → ZA) and used as-is if left blank. Typed because a short code is a fact about the company (Zactac use **ZC**). 2–4 letters/digits, validated in the route and on the field.
- **Changing it moves ids minted under the outgoing code** via `rewriteIdPrefix()` (`utils/idPrefixRewrite.js`): `GM | LS | 000047` → `XY | LS | 000047`; count reported in the flash message and audit entry. Ids from *earlier* codes are deliberately left alone (old stickers/paper records would otherwise disagree with the screen again); `scripts/rewrite-id-prefix.js` does those by hand.
- **Blind scan of every string field, not a list of id fields** — the same id string is copied between documents (an order's Lot No is stamped on its Deckles and Job Cards), so a missing field would break a link. Audit log and every `*logs` collection are skipped (history, not links). An id that would collide with one under the new code is left alone and reported.
- **Numbering continues across a change**: generators take the next number from a `Counter` or the trailing 6 digits of the highest existing id (`parseSkuSeq`), both prefix-agnostic; `SP | FCS | 000025` is followed by `ZC | FCS | 000026`. Each generator's `exists()` probe is prefix-aware.

Mint sites (all read `currentIdPrefix()`): Facestock / Adhesive / Core / Release Master, Label Stock (id + SKU code, incl. `utils/labelStockVariant.js`), Machine, Machine Job Card, Slitting Job Card, Maintenance ticket. **Add new ones the same way — never write the letters in.** Lot No is the exception (see below). `scripts/serialize-labelstock-sku-codes.js` calls `refreshBrand()` after `connectDB()` and renumbers existing rows onto the current code (the one place existing ids change, only with `--apply`).

**Still hardcoded, deliberately:** FAIRTECH-era `FS | CLIENT | 1`, `FS | Tape | 000001`, `FS | <mat> | <cat> | 000001` ids in `routes/fairdesk_route.js` — an older family whose prefix never matched the company code; switching would change client/tape ids for installations that haven't renamed.

### Lot No

`PendingProduction.lotNo` (minted/edited at `GET`/`POST /labels/production/assign/:id`) is **`PRODUCTCODE / FY / <year-letter><serial>`**, e.g. `C001WB / 26-27 / G001`. No company code — it's built around the product code. Serial is scoped to one product code within one financial year (FY 2027-28 restarts at `H001`; `financialYearLetter()` in `utils/rollId.js`).

- **Manually editable.** The Assign Production header field is a plain text input (`form="assign-form"`), pre-filled with the current/previewed value; whatever is submitted is saved. A typed value is collision-checked only when it **changed** from what's on file (so resubmits after Undo — lotNo is kept across unassign — don't trip over themselves).
- **No separate `Counter`.** The next auto lot no is read off the highest saved serial for that product + year (`highestLotNoSerial()`, scanning `PendingProduction.lotNo` and `MachineJobCard.lotNo`), so a hand-typed value becomes the new baseline instantly.
- **Temporary Lot No Setup replaces the inline edit** (production predates the ERP's lot numbers): the gear beside Lot No (pencil disabled; `POST .../assign/:id/lot-no` refuses) opens a dialog of one row per Label Stock product code to enter "last Lot No used this year" (`14` = `G014`). Stored in `LotNoBaseline` (`models/system/lotNoBaseline.js`, one row per product + FY); `highestLotNoSerial()` takes **max(baseline, highest in orders/job cards)**. Can move a series forward, never below a held lot. admin/proprietor/hod only; JSON endpoints `GET|POST /labels/production/lot-no-setup`, no page of its own (a reload would drop ticked reels).

**Deckle IDs: `PRODUCT/FY/<year letter><lot>/<4-digit serial>`**, e.g. `C001WB/26-27/G0025/0124` (`generateDeckleId()` in `utils/rollId.js`). The lot number is regex-read off the **trailing digits** of the Lot No (`deckleLotNumber()`; `.../G001` → `0001`). The **serial is one running count per MASTER product code per FY, across lots** (counter key `deckleId:<base code>:<fy>:<letter>`; old per-lot counters are dead). A "-A"/"-B" variant counts on its master's series (`deckleBaseCode()`): after `C001WB/26-27/G0025/0124` comes `C001WB-A/26-27/G0025/0125`. `generateDeckleId()` first lifts the counter to the highest serial any existing Deckle of that product/year carries (4+ digits — old five-digit ids like `/00019` still exist, hence `\d{4,}` in `DECKLE_TAIL`, the job card page's copy, and the operator app's `src/utils/rollId.js`), and compares by number, not text.

**Lot No & Deckle No Setup** is one dialog (gear beside Lot No; `GET|POST /labels/production/lot-no-setup` and `GET|POST /machine/deckle-no-setup`) listing every **master** product (variants not listed) with last Lot serial and last Deckle serial. Deckle counter moves forward with `$max`, never below an existing Deckle of the master or any variant. Web job card, Assign & Continue and the operator app all mint through the one function.

### Label Stock order rates follow the binding, not the product

On `/sachiko/sales/order`, a Label Stock row's Rate belongs to the **`LabelStockBinding`**, identity = product + client + **Paper Size + RM** (`buildLabelStockBindingSignature` in `routes/fairdesk_route.js`). One product has several bindings at different rates (`C001WB`: 62.5/RM 300 = ₹20, 210/RM 1000 = ₹26, 250/RM 2000 = ₹27), so the rate can't be settled at Product Code pick. `aiResolveRow()` in `views/inventory/orders/salesOrderForm.ejs` re-runs on Product Code, Paper Size *and* RM input:

- exact binding match → fills its rate, sets `itemId`;
- no match → `itemId` empty, `labelStockMasterId` set (server auto-creates the binding); rate pre-filled from the client's other binding for that product as a starting point;
- a hand-typed rate (`dataset.userEdited`) is never overwritten.

An auto-filled rate shows yellow until clicked; `aiValidateRows()` blocks submit until acknowledged, re-armed only when the figure actually moves (typing re-runs the resolve on every keystroke).

**`aiFindBinding()` must match the server's signature**: Paper Size trimmed, uppercased, whitespace runs collapsed; RM compared as a number; blanks rejected (`Number("")` is `0` and would match a binding with no RM).

### Finished stock export (to the FAIRTECH ERP)

`/sachiko/finishedstock` **Export to FAIRTECH** turns ticked finished rolls into the JSON FAIRTECH's `/fairtech/paperstock` **Import from Sachiko** takes as paper stock. Rolls are ticked **in the dialog** (table ticks just pre-select); a roll FAIRTECH would refuse can't be ticked (the file is all-or-nothing).

`POST /finishedstock/export` **dispatches as it exports** (otherwise the same reels are counted in both databases). Nothing is deleted: `quantity` → 0, `dispatchedAt` / `dispatchInvoiceNo` stamped, INWARD/OUTWARD history kept. Dispatched rolls drop off `/sachiko/finishedstock` and show on `/sachiko/finishedstock/dispatched`. Rolls are claimed with an atomic `quantity > 0` guard (double-click / concurrent exports can't dispatch twice); if any claim loses the race the whole selection is put back.

Required FAIRTECH `PaperStock` fields, each validated here:

| finished roll | → | FAIRTECH |
|---|---|---|
| `material.productCode` **base code** | → | `Paper.prodCode` |
| `material.family` | → | `Paper.family` |
| `paperSize` / `mtrs` / `rate` | → | `paperSize` / `paperMtrs` / `rate` |
| `rollId` | → | `vendorRollId` (FAIRTECH mints its own `rollId`) |

**The base code is the trap**: a roll is booked against the Deckle's Label Stock, often a variant (`C001WB-B`). FAIRTECH knows nothing about variants; exporting verbatim misses the existing Paper and mints a junk duplicate. `baseProductCode()` strips it; the full code travels as `variantProductCode` (tracing only). Rate comes from the sales order (slitting Stop handler) — what FAIRTECH books the reel in at.

### Paper re-order import (from the FAIRTECH ERP)

`/sachiko/sales/pending` **Import** takes the JSON from FAIRTECH's `/fairtech/inventory/paper-reorder` and builds a multi-line Label Stock PO. Separate deployments/DBs — the file is the whole interface, so everything is re-resolved locally. Handshake = Product Code string (`SachikoLabelStock.productCode` ↔ FAIRTECH `Paper.prodCode`) plus client name (`Username.clientName`); neither is an id, so renames break the match (unmatched codes are reported per line, not skipped).

Two steps (nothing is written from an unread file):
1. `POST /sales/pending/import/preview` (multipart, field `file`) — resolves every line, parks resolved rows **on the session**, writes nothing. Each row reports its master, whether a `LabelStockBinding` (client + size + RM) exists (and its rate), and whether this PO already brought the line in. Unorderable lines carry an `error` and can't be ticked.
2. `POST /sales/pending/import/commit` — browser sends only *which* rows and at what rate; products/quantities/sizes come from the session copy (a doctored post can't add a line). Session entry cleared on success; `submissionToken` = `import-<upload token>-<line index>` so re-confirming can't double-create.

Both call `createLabelStockPoLines()` in `routes/fairdesk_route.js`, shared with `POST /sales/order`'s multi-item branch — **don't fork it** (bindings, `orderSignature`s and `PendingProduction` rows must match exactly).

- **Location is never asked for.** It only decides where a *new* binding is filed, but `resolveLabelStockBinding()` validates it for every line. Preview resolves: this user's binding locations → user's own location → Location master if it holds exactly one entry; carried on the session. No source → fails at preview telling the user to bind a product first.
- A rate is always required (validated before the binding lookup). Pre-filled from the matching binding, else the client's latest binding for that product (marked as a guess). Editing writes back to the binding, as on the Sales Order form.
- Same PO + product + size + RM already on the books = likely double upload, but a top-up is legitimate → line starts **unticked**, not blocked.
- "-A"/"-B" variant codes are excluded from matching (as in `GET /sales/order`'s picker).

### Inward: rows must add up to the invoice total

Every Add Stock dialog (**Facestock**, **Adhesive**, **Release Liner**, **Core**) refuses to save when row sum ≠ invoice total, in **either** direction (too much = double keyed/wrong weight; too little = missing row).

| page | rows | total |
|---|---|---|
| Facestock | reels, Kg | Total Kg |
| Adhesive | drums, Kg | Total Kg |
| Release Liner | reels, Kg | Total Kg |
| Core | lots, **Pieces** | **Total Pcs** (`addTotalPcsInput`) |

Kg pages compare to 2 decimals with 0.01 tolerance; Core compares whole numbers exactly. Checked in three places that must stay in step: the dialog header live (`summaryKgCheck` / `summaryPcsCheck`), the submit, and `POST /create` server-side (the total is sent with the batch for that reason).

### Reel labels: one sticker or a whole batch

On `/sachiko/facestockstock`, `/adhesivestock`, `/releaselinerstock` — the same page three times, so change all three. A reel row's **Print** button prints one (`GET /label/:stockId`); **clicking a master row** opens **Print Reel Labels** (that spec's reels in stock, ticked or **Select all**, `GET /labels?ids=...`), one sticker per page.

`views/stock/facestockRollLabel.ejs` renders **both**: it takes `labels` as an array; with more than one, `<html class="sheet">` adds a page break before each label after the first (`@page` is one 101.5 × 75.1 mm sticker). Don't fork it (SVG, QR, fit-to-box pass and 180° flip would need fixing twice).

- **The preview is the print target**: the frame holds the printed document, fetched and written as `srcdoc` (navigating a frame to the URL dies on the login redirect's `X-Frame-Options` instead of saying the session ended); Print is `labelApi.print()`. Ticking re-fetches on a 300 ms debounce; Print re-fetches first if one is pending.
- **Only ids travel**; every label value is re-read from the DB. A reel deleted meanwhile is dropped and the page says so.
- Printing writes nothing: allotted/part-used reels are still printable (badge shown).
- **Rotate 180°** = per-PC `localStorage.facestockLabelFlip180`, read by the label page itself (printer property, not reel property).
- `MAX_LABELS_PER_SHEET` = 200.
- Per pool only names differ: table id (`#facestock-` / `#adhesive-` / `#release-masters-table`), mount, flip key, noun (Adhesive prints **drums**), spec line (Adhesive has no family/size/micron; Release Liner adds Sensing and Colour). **The kg field is `reelMtrs` in every pool, drums included** — no `drumMtrs`.

Semi-Finished has its own label view and stock page; not wired in. **Create PO is switched off** on all three pages (greyed `disabled` button, `pointer-events: none` so the click falls through to the row, reason in tooltip); the dialog and `POST /purchase-order` are untouched — drop two lines in the Purchase Order column's formatter to re-enable.

Trap: `tableDisp.css` sets `cursor: default !important` on `.tabulator .tabulator-row:hover`, overriding a plain `cursor: pointer` on rows. The rule must name `:hover` and the `.tabulator-cell` children and carry `!important`.

### New Client and New User are dialogs (one per page)

**New Client** → `views/users/_clientDialog.ejs`, on `/client/view` ("+ Client", `openClientDialog()`). **New User** → `views/users/_userDialog.ejs`, on `/master/view` ("+ User", `openUserDialog(clientName)`). Each is one `<form class="so-dialog" data-so-form>` in its own `.so-dialog-backdrop`, styled by `public/css/soDialog.css` (the dialog half of FAIRTECH's form style, scoped so it never restyles the page; link it from the page) and driven by `public/js/soFormDialog.js`. The standalone page is gone: `GET /form/client?tab=client` redirects to `/client/view?new=client`, `?tab=user&clientName=X` to `/master/view?new=user&clientName=X`, which opens the dialog, so every old "Add User" link still works. Choices.js is created on `DOMContentLoaded` (it loads `defer`). "Unregistered" GST stores the sentinel `UNREGISTERED` in GST and PAN (the Edit Client page tolerates it). `public/js/clientForm.js` is still used by the Die pages — don't delete it.

### Verified badge (who approved a record)

Shared module: blue seal beside a record's name + "Approved by <user> on <date>" — `utils/verification.js` (`verificationFields`, `verificationUpdate(req, existing)`), `public/js/verification.js` (`verifiedBadge`, `verifiedText`), `views/partials/verifiedCheckbox.ejs`. Wired into Label Stock, Client, User and every Masters-tab form (Company, Location, Machine, Facestock, Adhesive, Release, Family, Type, Core, Board Paper, LS Adhesive). **Full how-to and gotchas: `VERIFICATION.md`** — reuse it, don't copy the SVG. Never put it in a `*Signature`; a hand-built table row object must copy `verified`/`verifiedBy`/`verifiedAt` across. **Never `res.render(view, { client })`** — EJS treats `client` as a compile option and the layout's `include()` breaks ("include is not a function"); use another name (`clientRec`).

### Label Stock Product Code variants

`SachikoLabelStock.productCode` is free text; only the full `labelStockSignature` (every editable field, Product Code included) is unique. `POST /sachiko/label-stock/form` (`routes/sachiko/sachiko_route.js`) resolves duplicates at create time via `resolveProductCodeVariant()`:
1. Find the variant family: rows named exactly the code or `<code>-<LETTERS>`.
2. Compare recipes with `buildLabelStockSpecSignature()` (same sha256 as `buildLabelStockSignature()` but without Product Code; shared builder `labelStockSignatureParts(payload, { includeProductCode })`).
3. Identical recipe in the family → rejected as duplicate, naming the existing code.
4. No match → new variant, next unused single-letter suffix (`C011` → `C011-A` → `C011-B`…, reusing freed letters).
5. No family → saved under the plain code.

Create-time only; editing uses the plain exact-duplicate check and never renames into a variant.

### DOUBLE RELEASE / DOUBLE FACESTOCK: one reel may serve two layers

`LAYER_ORDER["DOUBLE RELEASE"]` (`utils/labelStockProduction.js`) is facestock + adhesive + liner, then a second adhesive + liner — two sequential passes, so one reel/drum may be allotted to more than one layer. `POST /labels/production/assign/:id` therefore does **not** refuse a repeated pick (it used to, making these jobs unassignable — the operator ticks the one bound drum on both layers and the form bounced with a flash).

`produceDeckle()` makes that safe: reels serving several layers are grouped by reel id (`drawByReel`), **checked once against the total** (102 left is refused for two 100 m coats) and **deducted once for the total** (per-layer `reelMtrs - draw` writes overwrote each other, so half the adhesive never left stock). Each layer still writes its own OUTWARD log line.

The machine queue agrees: `computeAllotmentCoverage()` (`routes/system/machine.js`) **pools layers sharing a reel** and asks whether it covers their sum (counting it in full on each overstates; splitting invents a shortfall). Layers sharing nothing are measured alone.

### Advance orders (a deckle set before the sales order exists)

**Advance Order** on `/sachiko/labels/production/deckle-set` opens `.../deckle-set/plan` — the Set Deckle page itself (`deckleSetForm.ejs`, `advanceMode: true`). Product Code picked in its own box (reload with `?itemId=`, since the recipe decides deckle sizes); orders **typed in** as advance lines (Paper Size, Running Mtrs, Roll Qty, Remarks); the code's real loose orders listed unticked beside them. Layouts, grace and AI Deckle Set work as usual.

Typed lines are **not saved until Create Deckle Batch**: posted as `advanceJson` to the same `POST /labels/production/deckle-set`, which creates them as loose `isAdvance` rows just before batching and **deletes them on any refusal** (abandoned/rejected plans leave nothing on Deckle Sorting). AI Deckle Set sends them as `advanceLines`. One checker, `parseAdvanceLine()`, serves all three. Typed rows' checkboxes carry `advance:<n>` values, dropped server-side as non-ObjectIds.

**Advance** on a Product Code's `/plan/:itemId` page still saves one line immediately (`POST .../plan/:itemId/advance`). A loose advance row can be removed from Deckle Sorting; a batched one comes out via Dissolve.

Flagged cornflowerblue (`.adv-tag` / `.adv-row` / `.adv-tr` / `.adv-banner` in `common.css`) on Deckle Sorting, Deckle Queue, Assign Production, WIP, machine/operator queues, web job card and the operator app's queue + job card. Batch pages read it **live** off members via `advanceShareByBatch()` (`utils/pendingProduction.js`), not a stored flag, so it clears itself. Clone/shortfall rows split off an advance member carry `isAdvance`.

**The real order takes its place**: when a *new* Label Stock sales order syncs (`upsertPendingProduction` → `absorbAdvanceOrders`), open advance rows with the same Product Code + Paper Size + Running Mtrs are consumed — batched first (the order's row joins that batch, a clone for further batches), then loose, oldest first. Order excess stays loose as a `parentOrderId` remainder; advance excess stays advance. A batch made only of advance rows takes the first real order's client and PO. Edits to existing orders never absorb.

### One deckle batch per deckle size

`POST /labels/production/deckle-set` creates **one `PendingProduction` batch per deckle size the plan cuts** (a 660 × 8 + 635 × 15 + 510 × 3 plan makes three — three reels, laminator runs, Deckle Queue rows, Lot Nos, assignments, allotments). Bundling made Assign Production unreadable: batch-level `deckleSize` holds only the width with most webs, so the 635 mm reels the job mostly ran on were flagged too narrow against a 660 budget.

- layouts grouped by `L.deckleSize ?? deckleSize`, widest first; each group's `rollsByWidth` from its own layouts;
- each roll width's orders served group by group, oldest first, overflow on the last order out of the last group that cuts it;
- the order's **own row** joins the first group it appears in; further groups get a **clone** (`parentOrderId` = the order, like shortfall rows — which is why Dissolve folds back correctly one batch at a time; it only re-merges a spare row whose parent is itself loose);
- whatever no group cuts is carved off to Deckle Sorting as before.

`rollsByWidth` is keyed on **`orderedWidth ?? width`**: with grace the knife is wider than the order (157.5 for a 150 roll) but the roll is still the order's and billed at 150; keying on knife width left rolls belonging to nobody so the order read as short and had its balance carved off.

Per-layout `deckleSize` is **not** stored on the new batches (Slitting Allocation's `BATCH_LAYOUT_FOR_WEB` treats a width-less layout as always applicable). Older mixed batches have no migration: dissolve and re-create from Deckle Set.

### Deckle Only (a deckle for stock — no orders, no slitting layout)

**Deckle Only** (button on Deckle Sorting beside Advance Order) → `GET /labels/production/deckle-set/deckle-only` (`deckleOnlyForm.ejs`): pick Product Code (reload with `?itemId=`; inputs locked until picked), then Deckle Size (typed, 25–2,000 mm), Deckle R.M., Deckle Count. A page of its own — Set Deckle pages (`deckleSetForm.ejs`) know nothing about it. No Edge Trim field; `deckleTrim` is left unset (downstream reads treat missing as no edge; see Slitting Allocation pre-fill in `routes/system/slitting.js`).

`POST .../deckle-only` makes one batch (`deckleOnly: true`, `batchOrderIds: []`, `quantity: 0`, `noOfRolls` = count) from only the Product Code and those three figures (no `orderIds`/`advanceJson`) so it can't touch an order. A refusal returns to the page with the code still picked.

Downstream: no layout, no client (advance-only batches already lack a client). Assign Production budgets from `deckleSize × deckleRunningMeters × noOfRolls`; machine queue target is `noOfRolls`. Slitting Queue's `buildPlannedDeckleGroups()` skips it (webs appear as free Deckles once laminated); slit rolls get no rate (Finished Stock takes one by hand). Deckle Queue tags it **DECKLE ONLY** with "Stock" in Batch; Dissolve just removes it.

### Slitting: a Deckle has to cure before it is run

Cure time by **facestock family** from the Deckle's `createdAt`: **CHROMO 6 h, PP 8 h**, other 6 h (`DEFAULT_CURING_HOURS`); `CURING_HOURS_BY_FAMILY` in `routes/system/slitting.js`. A build whose **every** adhesive layer is hot melt (`HOTMELT`/`HOT MELT`) has no curing; hot melt + waterbase double still cures. Label Stock `family`, `facestock.facestockFamily` (and `facestock2` on DOUBLE FACESTOCK) are all read; longest wait wins.

Allocation is **not** gated; the operator's run **is** (scan, Start, Stop on the slitting job card refuse an uncured Deckle; queues show the countdown). Any query whose reels go to `deckleCuring()` must populate `CURING_MATERIAL_FIELDS`, or every Deckle quietly falls back to 6 h.

### Machine queue: how far the allotted material gets

`buildQueueRows()` (`routes/system/machine.js`) reports per order **how many rolls the allotted reels will run** ("material for 4 of 15" under Required Rolls and in the row dialog). `materialStatus` has three states:

| state | meaning | row | can start |
|---|---|---|---|
| `match` | every layer allotted, enough for the whole job | green | yes |
| `partial` | every layer allotted, runs out part way | amber | **yes** |
| `short` | at least one layer has no reel | red | no |

`partial` exists because "is there a reel on every layer" says yes to a 27 kg remnant standing in for a 770 kg job. A partial job runs and stops when material does. Facestock/Adhesive/Release badges: "Partial" = one of two layers of that pool *or* allotted-but-not-enough (tooltip says which).

`computeAllotmentCoverage()` uses the same figures as Assign Production (`utils/rawMaterialNeed.js`: kg and running metres per layer) and `kg × 1e6 / (gsm × width)` — reel's own GSM and width, or the recipe's wet GSM over the job web for a drum. Coverage = **worst layer**; rolls rounded **down**. If *no* reel on a layer can be turned into a length (no GSM), weight alone answers and the unmeasurable count is reported (instead of a misleading "0 of 15" with 800 kg on the machine); if only *some* are unmeasurable both sides are kept and it reads low (safe direction).

### Undoing an assignment (taking a job back off a machine)

`POST /labels/production/unassign/:id`: order → Pending; machine/operator/helper cleared; every allotted reel/drum released; any Deckle laminated at **Assign & Continue** (`producedVia: "assign"`) un-made with material returned; **Lot No kept**. `liveMaterialInUse` **and** `runningOn` are cleared (a stale device claim would otherwise block the next device for 15 minutes).

Offered on the **machine queue row** and the WIP tab (not for operators — same `canEditOrder` gate as Edit). `buildQueueRows` computes `canUndo` / `undoBlockedReason` from the same facts the POST refuses on.

| state | undo? |
|---|---|
| assigned, untouched | yes |
| Start punched, reels scanned, nothing made | yes (scanned reels released) |
| a Stop punched (Deckle inwarded off the log) | **no** — save the Job Card to close out |
| a reel reconciled mid-job (`materialSwapLog`) | **no** — same |
| already produced (`producedAt`) | **no** |

Once material has moved there's no clean reversal (raw consumed by a job-card Deckle is settled only when the card is saved; `dissolveDeckle` has no lamination ledger for it). Way out: **Save Production Entry** or cancel the order. To undo a produced Deckle: `node scripts/dissolve-deckle.js <deckleId>` first, then undo. An undo from a queue returns to that queue (`from`, validated against this app's queue paths); elsewhere it lands on Deckle Set.

### WIP tab: only started jobs, and what "live" means

`/sachiko/labels/production/pending?tab=wip` lists **jobs an operator has actually started**, not every order on a queue. Membership and the **Finished**/**Live** columns come from `buildJobCardProgressMap()` (`routes/fairdesk_route.js`). `MachineJobCard` is written **once, by Save Production Entry, at job end**, so cards alone read "Not started" for hours-long jobs; the shop floor's live writes are folded in:

| signal | written by | shows as |
|---|---|---|
| `MaterialStock.producedFor` + `producedVia: "jobcard"` | each Stop punch (`POST /machine/jobcard/log/produce`) | metres; Production Log row |
| `PendingProduction.runningOn` | first Start (`POST /api/operator/jobcard/claim`), heartbeated | **Running** |
| `PendingProduction.liveMaterialInUse` | each reel scanned (`POST /machine/jobcard/mark-in-use`) | **In Setting** |
| `PendingProduction.liveRun` | a Production Log row's Start (`POST /machine/jobcard/log/start`; app `/api/operator/jobcard/log/start`) | Live start + ETA |
| `PendingProduction.liveSetting` / `liveStartedAt` | Job Setting row Start/Stop (`POST /machine/jobcard/setting/start\|stop`; app `/api/operator/jobcard/setting/*`); first punch of any kind stamps `liveStartedAt` (`$min`) | **JOB SETTING** / **STARTED** |
| `MachineJobCard` | Save Production Entry | filed figures |

Rules:
- **A Deckle is counted once**: a card's Production Log row carries the same `rowToken` (and `deckleId`) the Deckle was minted with; matched and skipped.
- **A live Deckle carries its row times** (`MaterialStock.productionTime`, written at Stop). Older Deckles have neither; `createdAt` stands in for **End** only, never Start.
- **`producedVia: "assign"` never counts** (raw material laminated at Assign & Continue, not metres run).
- **Started is persistent, running is not**: `runningOn` clears only on card save, so presence = started; `activeClaim()` (`routes/api/operatorApi.js`, the 15-minute freshness rule) makes the badge say Running. A dead tablet leaves the job listed as "In Setting".
- Rows **join** at start and **leave** at produced, so `GET /labels/production/wip-progress` returns the whole row set (same query/`mapPendingProductionRow()`/filter as page render) and the poll reconciles update/add/delete (`wipTable.updateData()` alone rejects unknown rows).
- **Finished** = metres made; **Deckles** = made of planned. `lastDoneAt` (newest jobcard Deckle's `createdAt` — not card save, not `updatedAt` which heartbeats move) is shown in the Live Status dialog only.

**Live** = the deckle on the machine, ETA at that machine's **Machine Speed** (Machine Master `speedMpm`, mtrs/min; none set → laminator default **15**, `LAMINATOR_SPEED_MPM`, `utils/productionEta.js`; Slitting WIP likewise, default `SLITTING_SPEED_MPM` 30). Below, 15 stands for the machine's speed:

    deckle ETA = Start punch + Deckle R.M. / 15 min        (1,000 m -> 66.7 min)
    job ETA    = deckle ETA + deckles after it x R.M. / 15

- **Start punch exists only via `liveRun`**; both clients POST it (web `reportLogRowStart()` in `jobCardForm.ejs`; app `logStart()` in sachikoOperatorApp — older app builds show no ETA). `startedAt` is the server clock (punched string kept too). Retried Start for the same `rowToken` keeps the first stamp; Start for a row already having a Deckle is refused.
- **Ends when the row's Deckle is made** (`endLiveRun()`, by `rowToken`, from both produce routes); cleared by card save and unassign. On read, a `liveRun` whose token already has a Deckle is ignored.
- **Deckle R.M.** = `deckleRunningMeters`, else first layout's `deckleRunningMeter`, else — plain orders only — `runningMeters`. Batch with none → **no ETA** (never guess off `runningMeters`; see `utils/deckleTotals.js`). Target/count: `deckleTargetOf()` (shared with machine queue) and the larger of de-duplicated production rows and `producedRolls`.
- **Overrun is the browser's call** (its clock, every draw; running rows redrawn every 10 s on their own timer, independent of the 10 s data poll, skipped while tab hidden). Once overrun, job ETA = `max(job ETA, now + deckles after × R.M./15)`. ETAs to nearest minute; punched times cut to the minute.
- **Blink**: running → Live cell blinks green; past ETA (same whole-minute test as "X min over") → red; same 1.2 s `step-end`; Job Setting/Idle/All made/Started don't blink. `tableDisp.css` sets the cell colour `!important`, which an animation can't beat, so red keyframes move two `@property` colours read by the `!important` declarations. **`wipSetLiveCell()` owns the cell's state** (classes + one inline `animation` holding green blink, fill and red blink — separate helpers wiped each other's timing). Tabulator rebuilds cells every redraw, so each animation starts at the wall-clock point (blink phase of 1.2 s; fill at time since Start); a cell already in the same state is left alone (resetting a running animation's delay double-counts elapsed time). Reduced motion (`animation: none !important`): solid pale green / solid red, fill held still.
- The Live cell background doubles as a **progress bar** (stronger green, left to right, Start → ETA; `background-size` animation in `wipSetLiveCell()`).
- A deckle started after all planned reads "Deckle 3 · 2 planned" / "Extra deckle", never "Deckle 3 of 2".
- **Phase** (`plan.phase` from `buildRunPlan()`), precedence: **RUNNING** > **JOB SETTING** > **ALL MADE** > **IDLE** (`phase: "gap"`; idle counted from the last Deckle's `createdAt`) > **STARTED**. On screen always "Idle", never "gap" (internal names `gap`, `gapSince`, `gapBeforeMins` unchanged). With no deckle running, what's left shows as a **duration**. Stops between deckles aren't modelled.
- **A setting Stop only ends its own row** (matched on `liveSetting.startTime`, kept by a restored draft). A deckle Start clears `liveSetting`; card save and unassign clear all live fields (`livePause`/`livePauseLog` included).
- **PAUSED outranks every phase.** App Pause (fixed reason list) → `POST /api/operator/jobcard/pause` sets `livePause { since, reason, deviceLabel }`; Resume (queue ▶ or card banner) → `/resume` files `livePauseLog [{ from, to, reason }]` (capped, `LIVE_PAUSE_LOG_MAX`). **Any punch also ends a hold** (`endLivePause` in `routes/system/machine.js`) — but only one that began *before* the punch, so a late older punch can't end a newer Pause. While held, the page reads clocks at `runPlan.clockAt` via `wipNow()`: fill frozen grey (`wip-paused`), nothing overdue, Status/Estimate frozen. `buildRunPlan()` removes finished holds from every clock (`current.runFromAt`/`etaAt`, `setting.heldMs`, `gapHeldMs`, `gapBeforeMins`, Target `targetAt += heldMs`) so a break never reads Delayed. `phase` = `"paused"`, underlying = `basePhase`. Dialog shows a Paused status row and a **Hold Log** under the Production Log.
- **App punch times are dated when tapped**: outbox punches carry `at` (tablet clock at tap) and `sentAt`; `eventTimeOf()` (`routes/api/operatorApi.js`) subtracts `sentAt − at` from the server clock (capped 24 h). No stamps (old app / web card) = now. **Every live endpoint must be safe to repeat** (the outbox resends).
- **Idle time in the dialog**: separator between Production Log rows from the card's own punches (previous End → next Start; same tablet clock both ends; midnight wraps; missing punch shows none), plus a closing line for now off server times (`gapBeforeMins` or idle still running).
- **A live Deckle carries joints per web** (`MaterialStock.productionJoints`, written at Stop; `joints` merges both webs into one sticker label). Older live Deckles have only `joints`; absent `productionJoints` = clean run (omitted only when clean) so None is true; present-but-unsplit shows across both columns as "(facestock or release not recorded)".
- **Date** = day the row's deckle was *started*: Deckle `createdAt` (Stop; card rows matched by row token / Deckle id in `buildJobCardProgressMap`), a day earlier when punched Start is later in the day than punched End (End reads "next day"). Never-made rows fall back to card `date`.
- **Each clickable cell carries one underlined headline** (`.wip-link`) always — every one opens the dialog.

**Dialog**: Current Status first, then Job Setting Log, then Production Log (no "Now Running" panel, no footnote). Shared grid: *Job Setting Log* # · Mtrs · Start · End · Counter · Status; *Production Log* # · Deckle ID · Made · **Date** · Start · End · **Face Joint** · **Release Joint**. Start/End/right columns align exactly (`SETTING_COLGROUP` / `PROD_COLGROUP` — keep the sums). Joint cell = card's record ("Joint at 120 mtrs" / "Wrinkle at 85 mtrs"); empty reads **None**, never a dash; no LIVE badge on unsaved rows. **Current Status** (`.dlg-status-row`) looks exactly like a Production Log row (no tint, no button chrome): a running deckle shows in Production Log columns under `PROD_HEAD` (Date, **Running** badge — red past ETA, "extra deckle" — "45% of 500 mtrs", Start, "ETA ~2:39 PM" with how far over, joints "Not yet"); otherwise a one-line **Job Setting / Idle / All made / Started** badge. A bare grey chevron at the right end (`.dlg-toggle`, blue under pointer; grid untouched) — or a click anywhere on the row — opens details (`toggleLiveDetails`): on the machine, started, idle before it, to make, job started, Finished, Target, Status, Estimate. Heading carries the app chip: "Operator app online · TAB-1" while `activeClaim` is fresh, "last seen …" otherwise. Scroll areas use the brand-blue table scrollbar (rules of `.tabulator .tabulator-tableholder`).

**Columns: Deckles · Finished · Live · Target · Status · Estimate.** A figure plus at most one quiet line; **durations only** — no time of day in any cell or Excel export (times of day belong to the dialog). **Deckles** = `runPlan.done`/`target` with a bar; **Finished** = metres only. Table runs `columnDefaults: { vertAlign: "middle" }`.

**Target / Status / Estimate** ("is this job on time?"):

    Target   = (deckle target - producedRolls) x R.M. / 15            (a duration)
    delay    = finish counted from now - (jobStartedAt + Target)
               finish = job ETA, never before now + deckles after it x R.M. / 15  (running)
                      = now + deckles still to make x R.M. / 15       (setting / idle / started)
                      = when the last deckle came off                 (all made: actual)
    Status   = Delayed / Ahead / On time (delay within ±5 min, WIP_ON_TIME_MINS)
    Estimate = Target + delay  (start to finish, a duration)

- **Target is fixed once played** (`runPlan.targetAt`/`targetDeckles`, `buildRunPlan()`): the run done nonstop at speed from the first punch, so setting time counts as delay (deliberate).
- **A job can't start after its own deckle came off**: a missing start, or one later than this run's first unfiled Deckle's Stop, is worked back from that Stop by one deckle's running time (`startInferred`; dialog: "About … (not recorded; worked back from the first deckle)"). A recorded start before the first Stop is always kept.
- **Delay is counted from now** (browser clock), so settings/idle/overrun are already in it; not-all-made rows (`started` included) redraw every 10 s.
- **A job switched off mid-order owes only what wasn't filed**: card save clears `liveStartedAt` and files deckles as `producedRolls`; the next card times `target - producedRolls` deckles from its own first punch (`priorDone` / `targetDeckles`).
- **The three figures add up as shown**: Target and delay are whole minutes; Estimate is *built* as their sum (`wipOutlook()`).
- Target needs Deckle R.M. and Deckle Qty; Status/Estimate also need the recorded start. Missing → "—" with what's missing underneath.

"Total Mtrs Required" here is `deckleTotalRunningMetres()` (machine queue's figure), not stored `runningMeters`.

"Send Back to Pending" is disabled on `canSendBack`, from the same facts `POST /labels/production/unassign/:id` refuses on (anything produced, or a reel reconciled mid-job) — *not* "has started". This tab is the only UI path, so an assigned-but-unstarted order can't be un-assigned here (`scripts/send-back-to-pending.js <orderId>` does).

### Auto Allot (`public/js/rawAutoAllot.js`)

**Auto Allot (FIFO)** in Raw Material Allotment on `/labels/production/assign/:id` ticks Facestock/Adhesive/Release Liner reels the job needs, oldest first, and reports how much of the batch can be laminated. It only ticks checkboxes; nothing is reserved until **Assign & Continue**, and the server doesn't know a pick came from it.

Planner is plain numbers in/out (no DOM/fetch), tested by `scripts/raw-auto-allot-bench.js` (loads it in a `vm` context). `assignProduction.ejs` does measuring (reel weight, length at its width) and rendering.

- **Demands, not layer totals.** A mixed-web batch (660 × 8 + 635 × 15 + 510 × 3) needs a reel per run per width, and a reel serves only demands it is wide enough for. One flat oldest-first list would give all the oldest 510 mm reels to the whole job and read 100% for an uncuttable plan. Demands are served widest first. A **drum has no width**: adhesive states one demand for the whole job (per-web splitting would round part-drums up per width). Per-width requirement = *share* of the Raw Material Required strip's figures (metres by running-metre share, kg by area share) so parts add back exactly.
- **Order of choice**: exact-fit before wider (wider loses trim down the run), then FIFO on `inwardDate` (fallback `createdAt`; neither sorts last), stopping when a demand is covered on **both** kg and running metres. A reel wider than its web counts only `width / reel width` of its weight.
- **The topping-off reel is chosen by size, not date**: while the next FIFO reel still leaves the demand short, take it; only when it would *overshoot* reopen the choice and take the leanest reel that finishes. (A 125 kg demand took the 102 kg remnant then a 630 kg reel — 732 kg locked; now 102 + 27 = 129.) Test is on **the next FIFO reel**, not "can any reel finish" (a full reel nearly always can, walking past every remnant). Width tier still outranks it.
- **Matching to the shortest** (toggle, default on): each layer is allotted only what its widths can run (liner covers two thirds of the 635s → don't reserve 15 webs of facestock). Per width. Reported as **reels actually held back**, never a percentage (whole reels often give the same pick).
- A layer with nothing pickable (no adhesive binding / none in store) is **blocked** and left out of the width arithmetic (its zero would scale everything to nothing); `runMtrs` still goes to 0.
- **Allotment tables list only this deckle's web width** (`reelFitsBatchWeb`). Drums never narrowed; a reel with no Size is hidden. Off-width count sits under the column heading as a **toggle** (default off) since a store can lack exact width while a 640 reel could run a 635 web. A **ticked** reel stays listed whatever its width (the tick lives in the checkbox). Auto Allot considers only what the table shows.
- **Ticked reels pin to the top** of their column (`sortedReelsFor` takes the checked set as first sort key; re-render on tick).
- **"Too narrow" = narrower than *every* web in the plan** (judging against the widest marked the batch's own width unusable). A mixed-web batch's Size filter isn't seeded with one width, and `applyDeckleSize()` doesn't overwrite the list of all webs. `rawNeed.budgetWidthMm` (widest web) is what an adhesive drum's weight spreads over — not a fit test.

### Auto Deckle (`utils/deckleOptimizer/`)

Automatic layout planning behind **Auto Set Deckle** on `/labels/production/deckle-set/plan/:itemId`. Standalone (no mongoose/express/session; numbers in/out) so it can be benchmarked separately.

| File | Role |
|---|---|
| `patterns.js` | Enumerates every feasible A–L knife layout (integer hundredths of mm — decimal sizes make float `<=` unsafe). |
| `solver.js` | How many webs of each pattern: greedy warm start, then branch & bound under node/time budgets. |
| `index.js` | Public API `planDeckleLayouts()`, `deckleSize` outer loop, overrun caps, waste accounting, `isDeckleAutoEnabled()`. |

1-D cutting stock with three wrinkles: (1) **deckle size is an outer choice** — by default one size serves the batch (each candidate solved, cheapest wins); (2) **one roll length per layout** (`plannedRunningMeter` belongs to the layout) so orders are partitioned by running metres, one instance each; (3) **demand is in rolls, supply in position-webs** — one position on one web yields `floor(deckleRunningMeters / plannedRunningMeter)` rolls; this granularity usually forces overrun.

**Objective**: minimise facestock consumed (`deckleSize × deckleRunningMeters × webs`). Under-production never allowed; ordered area fixed → least consumed = least waste; with Deckle R.M. fixed it collapses to minimising `deckleSize × totalWebs`.

**Mixed webs** (*Different web per layout* toggle): each layout from whichever width suits (real 4-order job: waste 6.38% → 1.48%, overrun gone). Its search space contains every single-size answer but is much bigger for the same budget, so `planDeckleLayouts` always also runs single-size and keeps mixed only if genuinely cheaper (`notes` says so when mixed loses). Persistence:
- `PendingProduction.deckleLayout[].deckleSize` = width **that** layout is cut from; batch-level `deckleSize` = width with most webs. Read as `L.deckleSize ?? pending.deckleSize` (older batches lack it).
- Slitting Allocation allocates one width at a time, so its layout pre-fill filters `BATCH_LAYOUT` to layouts planned for that web (else a 1250 layout seeds onto a 510 deckle).

**Overrun** (spare rolls beyond order), tighter ceiling binds:

    allowed extra = min( ceil(qty * pct), maxExtraRolls )

`pct` default 10% (rounded up so a 3-roll order gets a whole roll), `maxExtraRolls` default 5; either 0 = none. Spares aren't extra consumption (web count already minimal; the spare uses width otherwise trimmed). Where granularity makes the cap unreachable (4 ordered, 3 per position → 6 made), the cap widens for that width instead of refusing, and `notes` says so.

**Waste accounting** — asserted by `scripts/deckle-optimizer-bench.js`; break either and it fails:

    consumedSqM = usefulSqM + edgeSqM + sideTrimSqM + endTrimSqM
    usefulSqM   = orderedSqM + overrunSqM

Optimizer `wasteSqM`/`wastePct` = **scrap only** (edge + side + end tail). `overrunSqM` is a *slice of* `usefulSqM`, not a sibling — booking it as waste double-charged width never lost (it once made the headline ~2× and unreconcilable).

**The Set Deckle page's headline is `Total`**, wider than optimizer waste: everything beyond the **ordered** widths = edge trim + Side Run (scrapped) + **Grace** (cut and wound but handed to the rolls, unbilled — not scrap, hence not called waste, but leaving it out made graced plans look tighter). Per layout Grace = `deckle size − ordered roll widths`. Side Run, Grace, Total are **whole-job totals** (mm and %), never per-web averages, so they reconcile by eye:

    Total = edge trim x webs + Side Run + Grace

matching the recap's Siderun / Trim / Grace / Total columns. Grace is already netted out of Side Run. Spare stock stays visible as m² beside Extra Rolls.

`POST /labels/production/deckle-set/plan/:itemId/auto` is **read-only**: order widths, quantities and roll lengths are re-read from the DB (the client chooses *which* orders, never what they say). The planner reviews the layouts dropped into the form and presses Create Deckle Batch, going through the same POST and validation as a hand-drawn plan — a wrong answer is discarded by not saving.

### Deckle Calculator (`/labels/production/deckle-calculator`)

The Set Deckle planner with nothing behind it — **Calculator** tab in the sidebar. Same web strip, layout dialog, grace panel, AI Deckle Set and figures as `/labels/production/deckle-set/plan/:itemId`. Differences: **requirements are typed** (roll width, running metres, roll quantity — "what would this cost me in trim" before an order exists), and it **ends nowhere** (no Create Deckle Batch, no writing POST, nothing stored).

Files: `views/utilities/deckleCalculator.ejs`, `public/js/deckleCalculator.js`, `public/css/deckleCalculator.css`, plus one route each for page and optimizer. Ids/classes are the Set Deckle page's (`dsf-`/`sl-`); the stylesheet began as a copy of that page's inline `<style>` (it renders with `CSS: false`). **They are two copies of the same rules — change one, look at the other.** After editing either, **check braces balance** (an unclosed rule silently swallows every declaration after it; `node -e` counting `{`/`}` outside comments does it).

Deliberate differences (not drift):
- **Recap columns narrower** (`min-width: 1240px`, diagram 46%/380px vs 1520/560) so Rolls, Deckle and footer totals don't fall off the right on a laptop.
- **Column filter boxes use a drawn magnifier**, not "Search" (clipped to "Sear" in 74px columns).
- **Available Sizes are chips**; a width not in store is dashed grey (`.dsf-size-item.is-added`) — on Set Deckle every candidate comes from stock.
- **Requirements** card (numbered, totals row, short/spare/exact states) exists only here.
- **One deckle width folds into the chip row**; the full-width bar is kept for the multi-width list.

What it reads:
- **Available Sizes opens on facestock widths in stock** (reel count and kg in the chip tooltip). `suggestDeckleSize()` narrows the same roll-up to a recipe on Set Deckle; here no recipe, nothing narrowed. Starting point only — the pencil adds/removes, nothing tied back to store.
- `POST /labels/production/deckle-calculator/auto` passes typed requirements to `planDeckleLayouts()`. Unlike its sister endpoint it re-reads **nothing** from the DB (nothing to re-read or protect; a doctored request only yields a wrong answer in the asker's browser). Same `DECKLE_AUTO_ENABLED` kill switch (off → no panel, 503).
- **A requirement is a width AND a roll length, matched on both**: 20 × 150 mm at 300 m aren't met by 150 mm rolls at 1000 m ("Rolls Set" says "no layout at this length", not a plain shortfall). Set Deckle pools by width alone (its orders come from one Deckle Sorting group). Either side may omit the length and then matches anything; exact matches served first.
- **Each layout picks its own deckle web**; one that hasn't is shown on the best fit **for its own knives**, not the plan's widest layout (which would put a 600 mm run on its neighbour's 1000 mm web and report that trim).
