import express from "express";
import mongoose from "mongoose";
import Notification from "../../models/system/notification.js";
import { sessionEmployeeId } from "../../utils/sessionUser.js";
import { unreadCount } from "../../utils/notify.js";
import { requireAuth } from "../../middleware/auth.js";
import { updateLimiter } from "../../utils/limiters.js";

const router = express.Router();

/*
 * The header bell's API (public/js/notifications.js).
 *
 * Every route here is scoped to the Employee._id behind the current session
 * (utils/sessionUser.js) -- a user can only ever see or modify their own rows,
 * and the id is never taken from the request. A session with no employee
 * record behind it (the dev backdoor logins) gets an empty inbox rather than
 * an error, so the bell is simply quiet for them.
 *
 * Mounted with requireAuth only and ahead of the role-gated routers, so the
 * bell answers on every page for every role, operators included.
 */

const LIST_LIMIT_DEFAULT = 20;
const LIST_LIMIT_MAX = 50;

router.get("/notifications/count", requireAuth, async (req, res) => {
  const userId = await sessionEmployeeId(req);
  if (!userId) return res.json({ unread: 0 });
  res.json({ unread: await unreadCount(userId) });
});

router.get("/notifications", requireAuth, async (req, res) => {
  try {
    const userId = await sessionEmployeeId(req);
    if (!userId) return res.json({ items: [], unread: 0 });

    const limit = Math.min(Math.max(Number(req.query.limit) || LIST_LIMIT_DEFAULT, 1), LIST_LIMIT_MAX);
    const filter = { userId };

    // Cursor for "older than what I already have", so the panel can page
    // without re-sending ids it has.
    const before = req.query.before ? new Date(String(req.query.before)) : null;
    if (before && !isNaN(before)) filter.createdAt = { $lt: before };

    const [items, unread] = await Promise.all([
      Notification.find(filter)
        .select("type title body link readAt createdAt actorName")
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean(),
      unreadCount(userId),
    ]);

    res.json({ items, unread });
  } catch (err) {
    console.error("NOTIFICATION LIST ERROR:", err);
    res.status(500).json({ items: [], unread: 0 });
  }
});

// Idempotent: clicking a row that is already read is a no-op, not a 404.
router.post("/notifications/:id/read", requireAuth, updateLimiter, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid notification id." });
    }
    const userId = await sessionEmployeeId(req);
    if (!userId) return res.status(404).json({ success: false, message: "Notification not found." });

    const updated = await Notification.findOneAndUpdate(
      { _id: req.params.id, userId, readAt: null },
      { readAt: new Date() },
      { new: true },
    ).select("_id").lean();

    // Not found here means either already read or not this user's row -- the
    // caller is told the same thing either way, so the endpoint can't be used
    // to probe whether someone else's notification exists.
    res.json({ success: true, changed: Boolean(updated), unread: await unreadCount(userId) });
  } catch (err) {
    console.error("NOTIFICATION READ ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to mark as read." });
  }
});

router.post("/notifications/read-all", requireAuth, updateLimiter, async (req, res) => {
  try {
    const userId = await sessionEmployeeId(req);
    if (!userId) return res.json({ success: true, unread: 0 });

    await Notification.updateMany({ userId, readAt: null }, { readAt: new Date() });
    res.json({ success: true, unread: 0 });
  } catch (err) {
    console.error("NOTIFICATION READ-ALL ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to mark all as read." });
  }
});

export default router;
