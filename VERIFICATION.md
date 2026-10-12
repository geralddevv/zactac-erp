# Verification module ("Verified" badge + who approved it)

A record can be signed off as *checked and approved*. It shows a blue Instagram-style
seal beside its name/code, and hovering the seal says **"Approved by Gerald on 10/10/2026, 2:24:24 pm"**.

Already wired in: **Label Stock** (`/sachiko/label-stock/view`), **Client** (`/client/view` table + dialog,
New Client dialog footer, Edit Client page) and **User** (`/master/view` table, User Details page, New User dialog
footer, Edit User page).
Also every form in the side-nav **Masters** tab: Company, Location, Machine, Facestock, Adhesive, Release, Family, Type,
Core, Board Paper and LS Adhesive (binding) — badge on the name/SKU column of each table, a "Verified" tick in each
add/edit dialog footer (Company: beside Cancel/Update), and a "Verified" row in the view popups. Also **Vendor** and **Vendor Coordinator** (`/app/vendor/view` + `/app/vendor/coordinator/view` tables, profile/details headers, New/Edit Vendor and New/Edit Coordinator dialogs). Also **Label Stock Binding** (client + product + size + RM → rate; `/label-stock-binding/view/:id` table + view popup, New/Edit binding form checkbox) and **Employee** (`/employee/view` table, profile header, Add Employee dialog footer, Edit Employee page; the routes strip `verified*` from the posted body so approval can only come from the session). Use the steps below to add it to anything else.

## The pieces (all shared — don't copy them)

| Piece | File | Does |
|---|---|---|
| Schema fields | `utils/verification.js` → `verificationFields` | `verified` (Boolean), `verifiedBy` (String), `verifiedAt` (Date) |
| Route helper | `utils/verification.js` → `verificationUpdate(req, existing)` | reads the `verified` checkbox, returns `{ set, unset }` |
| Badge + text (browser) | `public/js/verification.js` | `verifiedBadge(tip, size)`, `verifiedText(doc)`, `verifiedBadgeFor(doc, size)` |
| Table name/SKU column | `verifiedNameFormatter` in `public/js/verification.js` | `{ field: "familyName", formatter: verifiedNameFormatter }` — escaped text + badge |
| Master dialogs (add/edit footer) | `setVerifiedDialogState(prefix, row)` in the same file | fills `<prefix>Verified` checkbox + `<prefix>VerifiedNote`; send `verified: checkbox.checked` in the JSON body |
| Checkbox for form pages | `views/partials/verifiedCheckbox.ejs` | checkbox + "Approved by …" line |

## Rules (how it behaves)

- Ticked on save and not yet verified → stamps the **logged-in user** (`authUser.username`) and the time.
- Ticked and already verified → **keeps the original approver and time** (an edit never re-signs).
- Unticked on save → approval cleared (`verified` false, `verifiedBy`/`verifiedAt` removed).
- Any logged-in user who can create/edit the record can tick it (no extra role gate). Add one in the route if needed.
- Verification is **not** part of any duplicate-protection signature (`*Signature`) — don't add it there,
  or ticking the box would change a record's identity.
- Existing records start as *not verified*.

## Add it to a new module

**1. Model**
```js
import { verificationFields } from "../../utils/verification.js";
const schema = new mongoose.Schema({
  // ...existing fields
  ...verificationFields,
});
```

**2. Create route** — spread the `set` part into the new document:
```js
import { verificationUpdate } from "../../utils/verification.js";
await Thing.create({ ...data, ...verificationUpdate(req).set });
```

**3. Update route** — load the existing record (needs `verified verifiedBy`), then apply both parts:
```js
const existing = await Thing.findById(id).select("verified verifiedBy").lean();
const vf = verificationUpdate(req, existing);
await Thing.findByIdAndUpdate(id, {
  $set: { ...data, ...vf.set },
  ...(Object.keys(vf.unset).length ? { $unset: vf.unset } : {}),
});
```

**4. List page** — the listing query must **return the three fields** (add `verified: 1, verifiedBy: 1, verifiedAt: 1`
to a projection), and a table that builds its own row objects (like Label Stock's `buildLabelStockTableData`)
must **copy them across** — that's what hid the badge the first time.

**5. Browser** — load the helper, then draw the badge:
```html
<script src="/js/verification.js"></script>
```
```js
// table cell
formatter: (cell) => { const d = cell.getRow().getData();
  return `<span style="display:inline-flex;align-items:center;gap:5px;">${cell.getValue()}${verifiedBadgeFor(d, 16)}</span>`; }
// dialog title (badge 22–24 px) and a detail line
title.insertAdjacentHTML("beforeend", verifiedBadgeFor(doc, 22));
detail = doc.verified ? verifiedText(doc) : "";
```
Sizes used: 16 px in table rows, 22 px in dialog titles.

**6. Form** — on a normal form page (edit/create), one line, inside the form:
```ejs
<%- include('../partials/verifiedCheckbox', { doc: thing }) %>   <%# doc: null on create %>
```
In a custom dialog, add `<input type="checkbox" name="verified" />` (value `on`) to the form that is posted;
the server only needs that one field. See `views/sachiko/labelStockView.ejs` (footer checkbox + header badge).

## Gotchas

- The checkbox is read as `verified` = `on` / `true` / `1`; an **unchecked box sends nothing**, which the helper
  treats as "not verified". If a form saves via JSON/FormData built by hand, include the field only when ticked.
- A model change needs a server restart (nodemon does it); a **hard refresh** (Ctrl+Shift+R) picks up the new
  `public/js/verification.js` and styles.
- Badge hover text comes from the SVG `<title>`; keep `verifiedText()` as the single source of the wording.
- **Never pass a local named `client` to `res.render()`** (e.g. `res.render(view, { client })`). EJS reads `client`
  as its own compile option, so the layout's `include('pwaHead')` dies with *"include is not a function"*.
  The Client edit/profile pages use `clientRec` for this reason. Use `include()` (not ejs-mate's `partial()`, which
  ignores the data you pass) for `views/partials/verifiedCheckbox.ejs`.
