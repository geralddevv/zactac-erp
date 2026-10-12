# Notifications (header bell) — build guide

Written so the same module can be built cleanly in **SACHIKO** and **FAIRTECH** (separate deployments/DBs; copy the files, change only the items under "Per-app differences").

## Status

| Part | State |
|---|---|
| Bell icon in the top header + dropdown panel | **Done** (`views/layout/boilerplate.ejs`) |
| Data model, API, unread badge, mark-read | **Done** — `models/system/notification.js`, `routes/system/notifications.js`, `public/js/notifications.js` |
| Producer helper | **Done** — `utils/notify.js` |
| Tasks: assigned / reassigned / done / status changed | **Done** — `routes/fairdesk_route.js` |
| Tasks: due-soon + overdue reminders | **Done** — `utils/taskReminders.js`, started from `server.js` |
| Tasks: comment added | **Not built** — tasks have no comments yet (see §5) |

The UI shell lives in the layout: `#fdNotifBtn` (bell), `#fdNotifBadge` (red count, hidden until `.has-count`), `#fdNotifMenu` / `#fdNotifList` (panel; the static markup is the empty state, replaced on first open). CSS is the `.notif-*` block next to the profile-menu rules; the layout's inline JS does open/close **only** — the feed is `public/js/notifications.js`, loaded `defer` immediately after `common.js` so its POSTs get that file's CSRF header. Do not restyle the bell as `.header-nav`-less — it reuses that class for the translucent pill look.

**The recipient id is the thing that breaks.** A notification is addressed to an **`Employee._id` in the main DB**, so every producer needs the logged-in user reduced to that same id. The session was not uniform about it: operator logins carried `empObjId`, staff logins carried only `empId` (the id *code*). `utils/sessionUser.js` is now the one answer — `sessionEmployeeId(req)` returns `authUser.empObjId`, or resolves it from `empId` once and caches it back onto the session (so sessions predating the field keep working without a re-login). The dev backdoor logins have no employee record at all: they get `null`, which means **no inbox and no assignable work** — deliberately, since matching them on `profileCode` could hand one person's inbox to another.

## 1. Model — `models/system/notification.js`

One document per (recipient, event). Fan-out on write: an event for 3 people = 3 rows, so read/unread is per person with no joins.

```js
{
  userId:    ObjectId,        // recipient (Username / Employee _id — see per-app differences)
  type:      String,          // "task.assigned" | "task.due" | "task.comment" | "task.done" | "system" ...
  title:     String,          // one line, <= 120 chars
  body:      String,          // optional, <= 300 chars
  link:      String,          // in-app path to open on click, e.g. "/fairtech/tasks?open=<id>" (must start with "/")
  refModel:  String,          // optional: "Task"
  refId:     ObjectId,        // optional: source document
  readAt:    Date | null,     // null = unread
  createdAt: Date             // timestamps: true
}
```

Indexes: `{ userId: 1, readAt: 1, createdAt: -1 }` (list + unread count) and a TTL on `createdAt` (90 days) so the collection cannot grow forever. Notifications are an inbox, not a record — the audit log is the record.

Dedupe: repeating events (the due-soon reminders) carry a `dedupeKey` string (`task.due:<taskId>:<yyyy-mm-dd>`), unique per recipient, and `insertMany(..., { ordered: false })` so a re-run is harmless.

> **The dedupe index must be PARTIAL, not sparse.** A compound *sparse* index still indexes a document when **any** of its keys exists — and `userId` always exists — so every ordinary notification lands in the index under `(userId, null)` and the **second** notification to the same person is rejected as a duplicate. It fails silently (the duplicate is swallowed by `ordered: false`), so it looks like notifications simply stop arriving after the first one. Use:
> ```js
> { unique: true, partialFilterExpression: { dedupeKey: { $type: "string" } } }
> ```
> If a deployment ever ran the sparse version, drop the old `userId_1_dedupeKey_1` index once — mongoose creates the new one but never drops the old.

## 2. Producer helper — `utils/notify.js`

The only way anything creates a notification. Modules never touch the model directly.

```js
notify({ userIds, type, title, body, link, refModel, refId, dedupeKey, actorId, actorName })
```

- Drops `actorId` from `userIds` (nobody is told about their own action) and de-duplicates the list.
- Validates `link` starts with a single `/` — never an absolute URL, never `//host`. A bad link is dropped, not stored.
- Never throws into the caller; returns how many rows were written. A failed notification must not fail the task save.
- Call it **after** the main write succeeds.
- Links are stored against the **internal** `/app` prefix (`/app/tasks?open=<id>`). `middleware/brandPrefix.js` stamps the live company slug on the way out — inside JSON bodies too — so a stored link survives a company rename. Never write `/sachiko` into one.

## 3. API — `routes/system/notifications.js`

Mounted in `server.js` as `app.use("/app", requireAuth, notificationRoutes)` **ahead of every role-gated router** (same reason as `machineRoutes`): the bell is in the layout of every page, so a role check further down would answer 403 for the count on pages that are otherwise fine. All routes `requireAuth`; every query is scoped to the session user's `Employee._id` — **a user can only ever see or modify their own rows**, and the id never comes from the request.

| Method | Path | Purpose |
|---|---|---|
| GET | `/notifications?limit=20&before=<iso>` | newest first, plus `unread` count |
| GET | `/notifications/count` | `{ unread }` only — cheap, used by polling |
| POST | `/notifications/:id/read` | set `readAt` (idempotent) |
| POST | `/notifications/read-all` | mark all mine read |

Mutating routes use `updateLimiter` from `utils/limiters.js`. CSRF is automatic via the `common.js` fetch wrapper. `POST /notifications/:id/read` is **idempotent** and answers the same `{ success: true, changed: false }` whether the row was already read or belongs to somebody else — so it can't be used to probe whether another person's notification exists. Both read routes return the fresh `unread` total, which is what the badge is repainted from. The paths are in `auditLogger`'s skip list: a bell click is a UI gesture, not an action on company data.

## 4. Front end — `public/js/notifications.js`

Loaded from `boilerplate.ejs` (`defer`). It replaces the static empty state:

1. On load: `GET /notifications/count` → set `#fdNotifBadge` text (`99+` cap) and toggle `.has-count`.
2. On bell open: `GET /notifications?limit=20` → render rows into `#fdNotifList`. Empty list → the "No notifications" block is rebuilt. The layout's inline handler has already toggled the panel by the time this file's click listener runs (it is `defer`red, so it registers second), so `.show` is what says "just opened".
3. Row = `<a class="notif-item unread" href="…" data-id="…">` with `.notif-title` and `.notif-time` (relative time). Built with DOM `textContent` — never `innerHTML` with notification text (titles contain user-typed task names). The `href` comes from `link`, server-validated and **re-checked** here that it starts with `/` and not `//`; a row with no usable link renders as a `<div>` that just closes the panel.
4. Click on a row → `POST /notifications/:id/read` with `keepalive: true` so the navigation that follows doesn't cancel it (`sendBeacon` can't carry the CSRF header). The badge is repainted from the `unread` in the reply, not by subtracting one — arithmetic on the badge text can't be right once it reads `99+`.
5. "Mark all read" is added to `.notif-head` only while something is unread (`.notif-mark-all`).
6. Poll `/notifications/count` every 60 s, **skipped while `document.hidden`**, plus one refresh on `visibilitychange` — coming back to a backgrounded tab is when the count is most likely stale. (SSE/websocket is not worth it at this scale.) The auth pages use `layout/auth`, not the boilerplate, so a logged-out tab never polls.
7. Operators (`role: "operator"`) get the bell in the header and the API answers for them, which is why the router is mounted before the role-gated ones. Nothing produces notifications for them yet.

## 5. Tasks module hookup

The Tasks module (`/<slug>/tasks`, isolated DB, see `config/tasksDb.js`) is the first producer. **Notifications live in the main DB, not the tasks DB** — the bell must work on every page and for non-task events; a task stores only `refModel`/`refId` back-pointers, which are deliberately not mongoose refs (the document is on another connection).

What a task now carries (`models/miscellaneous/task_model.js`): `assignedTo` **is** the assignee id (an `Employee._id`, the same id a session reduces to), with `assignedToName` as a denormalised copy written beside it; `createdBy` (the creator's `empId` code, which the Daybook also keys on) plus `createdById` / `createdByName`; `status`; `completedAt`.

| Task event | Recipients | `type` | Built |
|---|---|---|---|
| assigned (create) / reassigned (edit) | new assignee | `task.assigned` | yes |
| taken off someone | previous assignee | `task.unassigned` | yes |
| marked done | creator | `task.done` | code is in place but **currently unreachable**: only the creator may close a task, and `notify()` drops the actor. Kept for the day `canSetStatus` widens |
| status changed by someone else | assignee | `task.updated` | yes — this is how the assignee learns their work was signed off |
| due in 24 h / overdue | assignee (+ creator when overdue) | `task.due` / `task.overdue`, `dedupeKey` per day | yes |
| comment added | assignee + creator + prior commenters | `task.comment` | **no — tasks have no comments yet.** Add the feature first, then one `notify()` call in its POST handler |

Rules the handlers follow:

- **Only whoever assigned a task may close it**, and **a task is private to its creator and its assignee — administrators included** (`taskVisibilityFilter()`; there is no role that reads the whole collection). So the assignee has no status power at all (`canSetStatus` = `canEdit`), and the assignee learns their work was signed off through `task.updated`. Task titles are deliberately absent from the audit log, since that *is* readable by proprietor/admin/hod. If you ever restore the assignee's Mark Complete, `task.done` is the one notification path to re-check.
- **Save first, notify after.** Every `notify()` call sits after the write it reports.
- **Assigning to yourself rings nothing** (`actorId` is dropped by `notify()`).
- **A task kept for yourself notifies nobody.** The New Task dialog's "Who is this for?" switch posts `assignMode: "send" | "self"`; in `self` mode the task is assigned to the creator (a posted `assignedTo` is ignored, not trusted) and the `task.assigned` call is skipped outright rather than left to the `actorId` guard. Due/overdue reminders still reach them — it is their own reminder. There is no flag on the document: a kept reminder is just a task you assigned to yourself, so nothing downstream needs a special case.
- **…and neither does the person it is *about*.** In `self` mode the dialog's employee picker is relabelled "About (optional)" and its value is posted as `aboutEmployee`, stored in `Task.aboutEmployee` / `aboutEmployeeName`. That field is display context: no visibility filter and no `notify()` call anywhere reads it, so naming somebody there gives them nothing. If you add a producer, **never** address a notification to `aboutEmployee` — the whole point is that the task was kept rather than sent.
- **Editing a title, label, due date or client notifies nobody** — only a change of assignee or of status does.
- A reassignment tells **both** sides: the new assignee (`task.assigned`) and the person it was taken off (`task.unassigned`).
- The "someone else changed your task's status" row is skipped when that same person was just told they were given the task, so a single edit never produces two rows for one person.
- Tasks created before `createdById` existed are resolved from `createdBy` on the fly; `scripts/backfill-task-assignee.js` fills them in for good (dry-run by default, `--apply` to commit).

Due reminders: `utils/taskReminders.js`, started by `startTaskReminderJob()` from `app.listen` in `server.js` — first pass 60 s after boot, then every 15 minutes. Idempotent per calendar day via `dedupeKey`, so a restart, a second app instance or a clock jump re-sends nothing. `TASK_REMINDERS_ENABLED=false` (also `0`/`off`/`no`) stops it being scheduled; restart to change. The assignee is reminded a day ahead and once a day while late; the creator hears only once it is actually late. Note the key is deliberately the **same** for both: if someone assigned the task to themselves, the second write collides and they are rung once, not twice.

## 6. Per-app differences (SACHIKO vs FAIRTECH)

| Thing | SACHIKO | FAIRTECH |
|---|---|---|
| URL prefix | company slug (`/sachiko/…`, moves on rename) | `/fairtech/…` |
| Link building | store app-relative paths on the internal prefix (`/app/…`); `brandPrefix` stamps the slug on the way out | fixed `/fairtech` |
| Recipient id | `sessionEmployeeId(req)` — `authUser.empObjId`, else resolved from `empId` | same, but check that app's `authUser` shape before trusting it |
| Header file | `views/layout/boilerplate.ejs` | the same layout; place the bell block **before** the profile dropdown inside `.header-nav-right` |
| Roles | proprietor, admin, hod, sales, hr, employee, master, operator | check that app's role list |

**Who can actually open a task link (SACHIKO):** `fairdeskRoute` is mounted for `proprietor, admin, hod, sales, hr`, so those are the people for whom assignment works end to end. A task assigned to an `employee`-role staffer or to an operator is recorded and shows the right name, but the notification links to a page their role can't open. Widening it is a one-line change to that mount in `server.js` (Tasks and Daybook are already carved out of the router's own role gate, so those two pages are all a widened role would reach) — a permissions decision, not a bug fix.

## 7. Build order (checklist — done for SACHIKO, use it for FAIRTECH)

1. Copy the bell markup, `.notif-*` CSS and the open/close JS block from `boilerplate.ejs` (FAIRTECH only).
2. Make sure the session carries the employee `_id` (`utils/sessionUser.js` + the login handlers). **Do this first** — everything else matches on that id.
3. `models/system/notification.js` + indexes (partial, not sparse).
4. `utils/notify.js`.
5. `routes/system/notifications.js`; mount it before the role-gated routers in `server.js`.
6. `public/js/notifications.js`; include it after `common.js` in the layout.
7. Wire the first producer (task assigned) and verify end to end: assign a task as user A → user B's badge shows 1 within 60 s → click the row → lands on the task, badge clears → A gets nothing → a third user C can neither see nor mark B's row.
8. Remaining task events, then the due-reminder job.

## 8. Rules to keep

- Own rows only; every route filters by the session user's `Employee._id`, never by an id from the request.
- Notification text is data: render with `textContent`.
- Links are in-app paths starting with `/`, stored on the internal `/app` prefix.
- `notify()` never breaks the caller, and is only ever called after the real write.
- The dedupe index is **partial**, not sparse (§1).
- Add new ids/roles the way CLAUDE.md says (no hardcoded company prefix).
