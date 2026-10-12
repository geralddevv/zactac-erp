import mongoose from "mongoose";

/*
 * One row per (recipient, event) -- fan-out on write. An event for three
 * people is three documents, so "is this read" and the unread count are a
 * per-person fact answered without a join.
 *
 * userId is an Employee._id in the MAIN database (utils/sessionUser.js
 * resolves it from the session), never a tasks-DB id: the bell has to work on
 * every page and for events that have nothing to do with tasks. A producer in
 * an isolated database (the Tasks module, config/tasksDb.js) stores only
 * refModel/refId back-pointers, which are deliberately NOT mongoose refs --
 * the document they point at may live on another connection.
 *
 * Nothing creates these directly: utils/notify.js is the only writer.
 */
const notificationSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, required: true },
    // "task.assigned" | "task.unassigned" | "task.done" | "task.due" |
    // "task.overdue" | "task.comment" | "system" ...
    type: { type: String, required: true, trim: true },
    title: { type: String, required: true, trim: true, maxlength: 160 },
    body: { type: String, trim: true, default: "", maxlength: 400 },
    // In-app path to open on click, always starting "/" and always written
    // against the INTERNAL prefix ("/app/tasks?open=..."). The company slug is
    // stamped on by middleware/brandPrefix.js on the way out, so a stored link
    // survives the company being renamed -- never hardcode "/sachiko".
    link: { type: String, trim: true, default: "" },
    refModel: { type: String, trim: true },
    refId: { type: mongoose.Schema.Types.ObjectId },
    // Who caused it, for display only ("RAVI assigned you: ...").
    actorName: { type: String, trim: true, default: "" },
    readAt: { type: Date, default: null },
    // Set by repeating producers (daily due reminders) so the same reminder
    // cannot go out twice -- see the unique index below.
    dedupeKey: { type: String, trim: true },
  },
  { timestamps: true },
);

// The two reads the bell does: the list (newest first) and the unread count.
notificationSchema.index({ userId: 1, readAt: 1, createdAt: -1 });

// A repeating producer re-sends the same notification every time its job runs;
// the unique key is what makes those runs idempotent.
//
// PARTIAL, not sparse. A compound *sparse* index still indexes a document when
// ANY of its keys exists -- and userId always exists -- so every ordinary
// notification would be indexed under (userId, null) and the second one sent
// to the same person would be rejected as a duplicate. That is not a
// theoretical risk: it silently swallowed every notification after a person's
// first until this index was narrowed to rows that actually carry a key.
notificationSchema.index(
  { userId: 1, dedupeKey: 1 },
  { unique: true, partialFilterExpression: { dedupeKey: { $type: "string" } } },
);

// Notifications are a transient inbox, not a record (the audit log is the
// record) -- expire them so the collection cannot grow without bound.
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

const Notification = mongoose.model("Notification", notificationSchema);

export default Notification;
