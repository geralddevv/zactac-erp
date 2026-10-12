import mongoose from "mongoose";
import Notification from "../models/system/notification.js";

/*
 * The only way anything in the app creates a notification. Modules never
 * touch the model directly, so every one of these rules holds everywhere:
 *
 *   - Nobody is told about their own action. Pass actorId (the acting user's
 *     Employee._id) and it is dropped from the recipient list -- a creator who
 *     assigns a task to themselves gets no bell.
 *   - A link is always an in-app path starting "/" (and never "//", which a
 *     browser reads as another host). Anything else is dropped rather than
 *     stored: a notification row is a click target, and an absolute URL in one
 *     is an open redirect waiting to happen.
 *   - It never throws into the caller, and it is always called AFTER the real
 *     write has succeeded. A notification that fails must not fail the task.
 *
 * Returns the number of rows written -- callers may log it, none depend on it.
 */

const MAX_TITLE = 160;
const MAX_BODY = 400;

function clean(value, max) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// In-app path only: must start with a single "/" and carry no scheme.
function safeLink(link) {
  const value = String(link || "").trim();
  if (!value.startsWith("/")) return "";
  if (value.startsWith("//")) return "";
  return value;
}

export async function notify({
  userIds,
  type,
  title,
  body,
  link,
  refModel,
  refId,
  dedupeKey,
  actorId,
  actorName,
} = {}) {
  try {
    const actor = actorId ? String(actorId) : "";
    const recipients = [
      ...new Set(
        (Array.isArray(userIds) ? userIds : [userIds])
          .filter(Boolean)
          .map(String)
          .filter((id) => mongoose.isValidObjectId(id))
          .filter((id) => id !== actor),
      ),
    ];

    const cleanTitle = clean(title, MAX_TITLE);
    if (!recipients.length || !type || !cleanTitle) return 0;

    const rows = recipients.map((userId) => ({
      userId,
      type: String(type).trim(),
      title: cleanTitle,
      body: clean(body, MAX_BODY),
      link: safeLink(link),
      refModel: refModel ? String(refModel).trim() : undefined,
      refId: refId && mongoose.isValidObjectId(refId) ? refId : undefined,
      actorName: clean(actorName, 80),
      dedupeKey: dedupeKey ? String(dedupeKey).trim() : undefined,
      readAt: null,
    }));

    // ordered: false so one duplicate (a repeating reminder that has already
    // gone out, caught by the unique userId+dedupeKey index) doesn't stop the
    // rest of the batch.
    const inserted = await Notification.insertMany(rows, { ordered: false });
    return inserted.length;
  } catch (err) {
    // A duplicate-key error here is the dedupe working as designed, not a
    // fault: report how many of the batch did land and say nothing else.
    if (err?.code === 11000 || err?.writeErrors) {
      return err.result?.insertedCount ?? err.insertedDocs?.length ?? 0;
    }
    console.error("NOTIFY ERROR:", err);
    return 0;
  }
}

export async function unreadCount(userId) {
  if (!userId || !mongoose.isValidObjectId(userId)) return 0;
  try {
    return await Notification.countDocuments({ userId, readAt: null });
  } catch (err) {
    console.error("NOTIFY COUNT ERROR:", err);
    return 0;
  }
}

export default notify;
