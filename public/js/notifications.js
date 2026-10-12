/*
 * Header bell feed (see NOTIFICATIONS.md).
 *
 * The bell markup, its CSS and the open/close toggle live in
 * views/layout/boilerplate.ejs; this file fills it with real rows. The toggle
 * is registered by that page's inline script, which parses before this
 * deferred file runs -- so by the time the click handler here fires, the menu
 * has already been shown or hidden and .show tells us which.
 *
 * Paths are written against the internal "/app" prefix on purpose: it answers
 * directly for client fetches whatever the company is currently called
 * (middleware/brandPrefix.js), so a rename can never break the bell.
 *
 * Notification text is user-typed data (task titles, names). Every row is
 * built with textContent -- never innerHTML.
 */
(function () {
  "use strict";

  const btn = document.getElementById("fdNotifBtn");
  const menu = document.getElementById("fdNotifMenu");
  const list = document.getElementById("fdNotifList");
  const badge = document.getElementById("fdNotifBadge");
  if (!btn || !menu || !list || !badge) return;

  const API = "/app/notifications";
  const POLL_MS = 60000;
  const LIMIT = 20;

  let loading = false;
  let loadedOnce = false;

  /* ─── badge ─── */

  function paintBadge(unread) {
    const n = Number(unread) || 0;
    badge.textContent = n > 99 ? "99+" : String(n);
    badge.classList.toggle("has-count", n > 0);
    btn.title = n > 0 ? `${n} unread notification${n === 1 ? "" : "s"}` : "Notifications";
  }

  async function refreshCount() {
    try {
      const res = await fetch(`${API}/count`, { headers: { Accept: "application/json" }, cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      paintBadge(data.unread);
    } catch {
      /* offline / transient — the next poll tries again */
    }
  }

  /* ─── rows ─── */

  // Short relative time: the panel is a glance, not a log.
  function relativeTime(iso) {
    const then = new Date(iso).getTime();
    if (isNaN(then)) return "";
    const mins = Math.round((Date.now() - then) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours} hr${hours === 1 ? "" : "s"} ago`;
    const days = Math.round(hours / 24);
    if (days < 8) return `${days} day${days === 1 ? "" : "s"} ago`;
    return new Date(then).toLocaleDateString("en-GB");
  }

  function emptyState() {
    const wrap = document.createElement("div");
    wrap.className = "notif-empty";
    const icon = document.createElement("i");
    icon.className = "fa-regular fa-bell-slash";
    wrap.appendChild(icon);
    wrap.appendChild(document.createTextNode("No notifications"));
    return wrap;
  }

  function rowFor(item) {
    // Re-check the link even though the server validated it: this is the
    // element's href, and an in-app path is the only thing that belongs there.
    const link = typeof item.link === "string" && item.link.startsWith("/") && !item.link.startsWith("//")
      ? item.link
      : "";

    const row = document.createElement(link ? "a" : "div");
    row.className = "notif-item" + (item.readAt ? "" : " unread");
    if (link) row.href = link;
    row.dataset.id = String(item._id);

    const body = document.createElement("div");
    body.style.cssText = "flex: 1; min-width: 0;";

    const title = document.createElement("div");
    title.className = "notif-title";
    title.textContent = item.title || "";
    body.appendChild(title);

    if (item.body) {
      const sub = document.createElement("div");
      sub.style.cssText = "color: #475569; margin-top: 2px;";
      sub.textContent = item.body;
      body.appendChild(sub);
    }

    const time = document.createElement("div");
    time.className = "notif-time";
    time.textContent = relativeTime(item.createdAt);
    body.appendChild(time);

    row.appendChild(body);
    return row;
  }

  function paintMarkAllButton(unread) {
    const head = menu.querySelector(".notif-head");
    if (!head) return;
    let link = head.querySelector(".notif-mark-all");
    if (!unread) {
      if (link) link.remove();
      return;
    }
    if (!link) {
      link = document.createElement("button");
      link.type = "button";
      link.className = "notif-mark-all";
      link.textContent = "Mark all read";
      link.addEventListener("click", markAllRead);
      head.appendChild(link);
    }
  }

  function render(items, unread) {
    list.textContent = "";
    if (!items.length) {
      list.appendChild(emptyState());
    } else {
      items.forEach((item) => list.appendChild(rowFor(item)));
    }
    paintBadge(unread);
    paintMarkAllButton(unread);
  }

  async function load() {
    if (loading) return;
    loading = true;
    try {
      const res = await fetch(`${API}?limit=${LIMIT}`, {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = await res.json();
      render(Array.isArray(data.items) ? data.items : [], data.unread);
      loadedOnce = true;
    } catch {
      if (!loadedOnce) {
        list.textContent = "";
        const err = document.createElement("div");
        err.className = "notif-empty";
        err.textContent = "Could not load notifications.";
        list.appendChild(err);
      }
    } finally {
      loading = false;
    }
  }

  /* ─── actions ─── */

  // keepalive so the request survives the navigation that follows it; the
  // CSRF header is added by the fetch wrapper in common.js. The reply carries
  // the new unread total, so the badge is repainted from the server's count
  // rather than from arithmetic on the text in it (which cannot be right once
  // the badge reads "99+").
  async function markRead(id) {
    try {
      const res = await fetch(`${API}/${id}/read`, {
        method: "POST",
        headers: { Accept: "application/json" },
        keepalive: true,
      });
      if (!res.ok) return;
      const data = await res.json();
      if (typeof data.unread === "number") {
        paintBadge(data.unread);
        paintMarkAllButton(data.unread);
      }
    } catch {
      /* the row is already shown as read; the next poll corrects the count */
    }
  }

  async function markAllRead() {
    try {
      const res = await fetch(`${API}/read-all`, { method: "POST", headers: { Accept: "application/json" } });
      if (!res.ok) return;
      list.querySelectorAll(".notif-item.unread").forEach((el) => el.classList.remove("unread"));
      paintBadge(0);
      paintMarkAllButton(0);
    } catch {
      /* leave the panel as it is; the next open re-reads it */
    }
  }

  list.addEventListener("click", (e) => {
    const row = e.target.closest(".notif-item");
    if (!row || !row.dataset.id) return;

    const wasUnread = row.classList.contains("unread");
    row.classList.remove("unread");
    if (wasUnread) markRead(row.dataset.id);
    // An <a> row then follows its own href; a row with no link just closes.
    if (!row.getAttribute("href")) menu.classList.remove("show");
  });

  btn.addEventListener("click", () => {
    // The layout's inline handler has already toggled the panel.
    if (menu.classList.contains("show")) load();
  });

  /* ─── polling ─── */

  refreshCount();
  setInterval(() => {
    if (document.hidden) return;
    refreshCount();
  }, POLL_MS);

  // Coming back to a tab that has been in the background is the moment the
  // count is most likely to be stale.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshCount();
  });
})();
