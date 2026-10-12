# Notifications (header bell) — build guide

Written so the same module can be built cleanly in **SACHIKO** and **FAIRTECH** (separate deployments/DBs; copy the files, change only the items under "Per-app differences").

## Status

| Part | State |
|---|---|
| Bell icon in the top header + dropdown panel | **Done** (`views/layout/boilerplate.ejs`) — always shows "No notifications" |
| Data model, API, unread badge, mark-read | **Not built** — this document |
| Producers (Tasks module and others) | **Not built** — build with the Tasks module |

The UI shell is already in place: `#fdNotifBtn` (bell), `#fdNotifBadge` (red count, hidden until `.has-count`), `#fdNotifMenu` / `#fdNotifList` (panel; empty state is the static markup). CSS is the `.notif-*` block next to the profile-menu rules; JS is "Notification Bell Logic" next to the profile dropdown logic. Do not restyle the bell as `.header-nav`-less — it reuses that class for the translucent pill look.

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

Indexes: `{ userId: 1, readAt: 1, createdAt: -1 }` (list + unread count) and a TTL on `createdAt` (e.g. 90 days) so the collection cannot grow forever.

Dedupe: for repeating events (due-soon reminders) add a `dedupeKey` string (`task.due:<taskId>:<yyyy-mm-dd>`) with a unique sparse index on `{ userId, dedupeKey }` and `insertMany(..., { ordered: false })` so retries are harmless.

## 2. Producer helper — `utils/notify.js`

The only way anything creates a notification. Modules never touch the model directly.

```js
notify({ userIds, type, title, body, link, refModel, refId, dedupeKey })
```

- Drops the acting user from `userIds` (don't notify people of their own actions).
- Validates `link` starts with `/` (never an absolute URL — prevents open-redirect/phishing links).
- Never throws into the caller: wrap in try/catch and log. A failed notification must not fail the task save.
- Call it **after** the main write succeeds.

## 3. API — `routes/system/notifications.js`

Mount under the app prefix next to the other system routers (before role-restricted routers, like the machine router, if operators should get a bell — see below). All routes `requireAuth`; every query is scoped to `req.session` user — **a user can only ever see/modify their own rows**.

| Method | Path | Purpose |
|---|---|---|
| GET | `/notifications?limit=20&before=<iso>` | newest first, plus `unread` count |
| GET | `/notifications/count` | `{ unread }` only — cheap, used by polling |
| POST | `/notifications/:id/read` | set `readAt` (idempotent) |
| POST | `/notifications/read-all` | mark all mine read |

Mutating routes use `updateLimiter` from `utils/limiters.js`. CSRF is automatic via the `common.js` fetch wrapper.

## 4. Front end — `public/js/notifications.js`

Loaded from `boilerplate.ejs` (`defer`). It replaces the static empty state:

1. On load: `GET /notifications/count` → set `#fdNotifBadge` text (`99+` cap) and toggle `.has-count`.
2. On bell open: `GET /notifications?limit=20` → render rows into `#fdNotifList`. Empty list → keep the "No notifications" markup.
3. Row = `<a class="notif-item unread" href="…" data-id="…">` with `.notif-title` and `.notif-time` (relative time). Build with DOM `textContent` — never `innerHTML` with notification text (titles contain user-typed task names). The `href` comes from `link` (server-validated, but re-check it starts with `/`).
4. Click on a row → `POST /notifications/:id/read` (use `navigator.sendBeacon`/`keepalive` fetch so navigation doesn't cancel it), then follow the link.
5. Add a "Mark all read" button in `.notif-head` once there is at least one unread row.
6. Poll `/notifications/count` every 60 s, **skipped while `document.hidden`**. (SSE/websocket is not worth it at this scale.)
7. Operators (`role: "operator"`, tablet app): the bell shows for them too in the header today; either hide it for operators or give them an API — decide per app. Default: hide with `authUser.role !== "operator"` in the markup until they have producers.

## 5. Tasks module hookup

The Tasks module (`/fairtech/tasks`, isolated DB, see `config/tasksDb.js`) is the first producer. **Notifications live in the main DB, not the tasks DB** — the bell must work on every page and for non-task events; the tasks module stores only `refId` back-pointers.

| Task event | Recipients | `type` | `link` |
|---|---|---|---|
| assigned / reassigned | new assignee | `task.assigned` | `/…/tasks?open=<id>` |
| comment added | assignee + creator + prior commenters | `task.comment` | same |
| due in 24 h / overdue | assignee (+ creator when overdue) | `task.due` / `task.overdue` (use `dedupeKey` per day) | same |
| marked done | creator | `task.done` | same |
| status/priority changed by someone else | assignee | `task.updated` | same |

Due reminders need a periodic job (`setInterval` in `server.js` every 15 min, or a cron script in `scripts/`); keep it idempotent via `dedupeKey`. Because the tasks DB is separate, `userId` must be an id that exists in the main DB (the logged-in session user), not a tasks-DB id.

## 6. Per-app differences (SACHIKO vs FAIRTECH)

| Thing | SACHIKO | FAIRTECH |
|---|---|---|
| URL prefix | company slug (`/sachiko/…`, moves on rename) | `/fairtech/…` |
| Link building | never hardcode the prefix; build from the live brand prefix (see "Renaming the company" in CLAUDE.md) or store app-relative paths and prefix at render | fixed `/fairtech` |
| Recipient id | session user's `_id` from `authUser` | same — check `authUser` shape in that app's `middleware/auth.js` |
| Header file | `views/layout/boilerplate.ejs` | the same layout; place the bell block **before** the profile dropdown inside `.header-nav-right` |
| Roles | proprietor, admin, hod, sales, hr, employee, master, operator | check that app's role list |

## 7. Build order (checklist)

1. Copy the bell markup, `.notif-*` CSS and the JS block from `boilerplate.ejs` (FAIRTECH only).
2. `models/system/notification.js` + indexes.
3. `utils/notify.js`.
4. `routes/system/notifications.js`; mount in `server.js`.
5. `public/js/notifications.js`; include in layout.
6. Wire the first producer (task assigned) and verify end to end: assign a task as user A → user B's badge shows 1 within 60 s → click row → lands on the task, badge clears.
7. Remaining task events, then due-reminder job.

## 8. Rules to keep

- Own rows only; every route filters by session user.
- Notification text is data: render with `textContent`.
- Links are in-app paths starting with `/`.
- `notify()` never breaks the caller.
- Add new ids/roles the way CLAUDE.md says (no hardcoded company prefix).
