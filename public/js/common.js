// ================= MOBILE BURGER MENU (side nav as a drawer ≤768px) =================
(function () {
  const btn = document.getElementById("fdMobileToggle");
  const nav = document.getElementById("fdSideNav");
  const backdrop = document.getElementById("fdNavBackdrop");
  if (!btn || !nav) return;

  const mq = window.matchMedia("(max-width: 768px)");
  const setOpen = (open) => {
    document.body.classList.toggle("nav-open", open);
    btn.setAttribute("aria-expanded", String(open));
    btn.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    const icon = btn.querySelector("i");
    if (icon) icon.className = open ? "fa-solid fa-xmark" : "fa-solid fa-bars";
  };

  btn.addEventListener("click", () => setOpen(!document.body.classList.contains("nav-open")));
  backdrop?.addEventListener("click", () => setOpen(false));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setOpen(false);
  });
  // Following a link closes the drawer (matters for same-page hash links).
  nav.addEventListener("click", (e) => {
    if (e.target.closest("a[href]")) setOpen(false);
  });
  // Rotating/resizing to desktop width must not leave the page scroll-locked.
  mq.addEventListener("change", () => setOpen(false));
})();

// ================= SIDEBAR TOGGLE WITH PERSISTENCE =================


(function () {
  const sideNav = document.querySelector(".side-nav");

  // Storage keys
  const SESSION_EXPIRES_HEADER = "x-session-expires-at";
  const SESSION_KEEPALIVE_MIN_INTERVAL_MS = 5 * 60 * 1000;

  // CSRF Protection Helpers
  const getCsrfToken = () => document.querySelector('meta[name="csrf-token"]')?.getAttribute("content");
  const getSessionExpiresAt = () => document.querySelector('meta[name="session-expires-at"]')?.getAttribute("content");
  let sessionTimeoutId = null;
  let sessionKeepAliveTimerId = null;
  let keepAliveInFlight = false;
  let lastKeepAliveAt = 0;

  const redirectToLogin = () => {
    // Operators sign in at their own portal; the layout tells us which one.
    const loginUrl =
      document.querySelector('meta[name="login-url"]')?.getAttribute("content") || "/app/login";
    if (window.location.pathname === loginUrl) return;
    window.location.replace(`${loginUrl}?reason=session-ended`);
  };

  const clearSessionTimer = () => {
    if (sessionTimeoutId) {
      clearTimeout(sessionTimeoutId);
      sessionTimeoutId = null;
    }
  };

  const scheduleSessionLogout = (expiresAt) => {
    if (!expiresAt) return;

    const expiresDate = new Date(expiresAt);
    if (Number.isNaN(expiresDate.getTime())) return;

    clearSessionTimer();

    const delay = expiresDate.getTime() - Date.now();
    if (delay <= 0) {
      keepSessionAlive({ force: true });
      return;
    }

    sessionTimeoutId = setTimeout(() => {
      keepSessionAlive({ force: true });
    }, delay + 250);
  };

  const startSessionWatchdog = () => {
    if (window.location.pathname.endsWith("/login")) return;

    const sessionExpiresAt = getSessionExpiresAt();
    scheduleSessionLogout(sessionExpiresAt);
  };

  const keepSessionAlive = async ({ force = false } = {}) => {
    if (window.location.pathname.endsWith("/login")) return;
    if (!force && document.visibilityState === "hidden") return;
    if (keepAliveInFlight) return;

    const now = Date.now();
    if (!force && now - lastKeepAliveAt < SESSION_KEEPALIVE_MIN_INTERVAL_MS) {
      return;
    }

    keepAliveInFlight = true;

    try {
      const response = await window.fetch("/check-session", {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
        },
      });

      if (response.status === 401) {
        redirectToLogin();
        return;
      }

      lastKeepAliveAt = now;

      const sessionExpiresAt = response.headers?.get?.(SESSION_EXPIRES_HEADER);
      if (sessionExpiresAt) {
        scheduleSessionLogout(sessionExpiresAt);
      } else {
        const payload = await response.json().catch(() => null);
        if (payload?.expiresAt) {
          scheduleSessionLogout(payload.expiresAt);
        }
      }
    } catch (err) {
      // Ignore transient connectivity issues and retry on the next activity pulse.
    } finally {
      keepAliveInFlight = false;
    }
  };

  const restartSessionKeepAlive = () => {
    if (sessionKeepAliveTimerId) {
      clearInterval(sessionKeepAliveTimerId);
      sessionKeepAliveTimerId = null;
    }

    if (window.location.pathname.endsWith("/login")) return;

    sessionKeepAliveTimerId = setInterval(() => {
      keepSessionAlive();
    }, SESSION_KEEPALIVE_MIN_INTERVAL_MS);
  };

  startSessionWatchdog();
  restartSessionKeepAlive();

  // Global Fetch Wrapper to include CSRF token
  const originalFetch = window.fetch;
  window.fetch = function (url, options = {}) {
    const requestUrl = typeof url === "string" ? url : url?.url || "";
    const token = getCsrfToken();
    if (token) {
      options.headers = options.headers || {};
      if (options.headers instanceof Headers) {
        if (!options.headers.has("X-CSRF-Token")) {
          options.headers.set("X-CSRF-Token", token);
        }
      } else if (Array.isArray(options.headers)) {
        if (!options.headers.some(([k]) => k.toLowerCase() === "x-csrf-token")) {
          options.headers.push(["X-CSRF-Token", token]);
        }
      } else {
        if (!options.headers["x-csrf-token"]) {
          options.headers["x-csrf-token"] = token;
        }
      }
    }
    return originalFetch(url, options).then((response) => {
      const isSessionCheck =
        requestUrl.includes("/check-session") || requestUrl.includes("/login") || requestUrl.includes("/logout");
      const looksLikeLoginRedirect = response.redirected && response.url && response.url.includes("/login");

      const sessionExpiresAt = response.headers?.get?.(SESSION_EXPIRES_HEADER);
      if (sessionExpiresAt) {
        scheduleSessionLogout(sessionExpiresAt);
      }

      if (!isSessionCheck && (response.status === 401 || looksLikeLoginRedirect)) {
        redirectToLogin();
      }

      return response;
    });
  };

  // Global Form Submit Interceptor to inject CSRF token
  document.addEventListener("submit", (e) => {
    const form = e.target;
    if (form && form.method && form.method.toLowerCase() === "post") {
      const token = getCsrfToken();
      if (token && !form.querySelector('input[name="_csrf"]')) {
        const input = document.createElement("input");
        input.type = "hidden";
        input.name = "_csrf";
        input.value = token;
        form.appendChild(input);
      }
    }
  });

  ["pointerdown", "keydown", "focus"].forEach((eventName) => {
    window.addEventListener(eventName, () => {
      keepSessionAlive({ force: eventName === "focus" });
    });
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      keepSessionAlive({ force: true });
    }
  });



  // ================= SIDE NAV: A TWO-LEVEL TREE =================
  // The nav is group -> page. The CSS draws the nesting (an indent guide down
  // each open group, the current page lighting its own segment of it); this
  // makes it operable, and says in words what the drawing says in pixels:
  //
  //   * aria-expanded / role / tabindex, wired here because the group headers
  //     are <div>s in the EJS -- doing it in the markup would mean the same
  //     three attributes repeated across a dozen blocks, each able to drift;
  //   * .has-active, marking the group that holds the current page, so the
  //     trail shows even while that group is shut;
  //   * which groups are open, remembered between page loads: without it,
  //     opening Masters and clicking through to Daybook shuts Masters again;
  //   * arrow keys, walking the tree the way a file explorer does.

  const NAV_OPEN_KEY = "fd_navOpenGroups";

  const navGroupToggle = (wrapper) => wrapper.querySelector(":scope > .nav-items");

  // The header's own label is the group's identity -- there is no id in the
  // markup, and the label is what the user is choosing to keep open.
  const navGroupLabel = (wrapper) =>
    (navGroupToggle(wrapper)?.querySelector(".nav-items-para")?.textContent || "").trim();

  // Storage can be missing or throw outright (private window, blocked site
  // data), in which case the nav simply stops remembering. It never fails to
  // render over it, so every read and write is wrapped.
  const navReadOpen = () => {
    try {
      const raw = localStorage.getItem(NAV_OPEN_KEY);
      const list = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(list) ? list : []);
    } catch (err) {
      return new Set();
    }
  };

  const navWriteOpen = (open) => {
    try {
      localStorage.setItem(NAV_OPEN_KEY, JSON.stringify([...open]));
    } catch (err) {
      /* nothing to do -- see above */
    }
  };

  function setNavGroup(wrapper, open, { remember = true } = {}) {
    const menu = wrapper.querySelector(".nav-labels-opt");
    if (!menu) return;

    wrapper.classList.toggle("is-open", open);
    navGroupToggle(wrapper)?.setAttribute("aria-expanded", String(open));

    // Measured AFTER the class lands: the open state adds vertical padding to
    // the panel, so a height read before it is short by that padding and
    // clips the last page in the group.
    menu.style.height = open ? (menu.scrollHeight || 500) + "px" : "0px";

    if (!remember) return;
    const label = navGroupLabel(wrapper);
    if (!label) return;
    const stored = navReadOpen();
    if (open) stored.add(label);
    else stored.delete(label);
    navWriteOpen(stored);
  }

  // Every row you can currently reach: group headers, the pages of open
  // groups, and the standalone links. A page inside a shut group is not
  // reachable -- the panel is clipped to no height, which leaves the row a
  // box all the same, so the group's own state is what decides. A row hidden
  // app-wide (inline display:none) has no offsetParent and drops out here.
  function navRows() {
    if (!sideNav) return [];
    return [...sideNav.querySelectorAll(".nav-items")].filter((row) => {
      const panel = row.closest(".nav-labels-opt");
      if (panel && !panel.parentElement.classList.contains("is-open")) return false;
      return row.offsetParent !== null;
    });
  }

  function navMove(from, step) {
    const rows = navRows();
    const at = rows.indexOf(from);
    if (at < 0) return;
    rows[(at + step + rows.length) % rows.length]?.focus();
  }

  (function initSideNavTree() {
    if (!sideNav) return;

    sideNav.setAttribute("role", "navigation");
    if (!sideNav.getAttribute("aria-label")) sideNav.setAttribute("aria-label", "Main navigation");

    // Icons are decoration: a row's own text, and aria-expanded on a group
    // header, already carry everything a screen reader needs.
    sideNav.querySelectorAll(".nav-items i").forEach((icon) => icon.setAttribute("aria-hidden", "true"));

    // More than one row can carry .active -- several pages ("Stock Summary")
    // appear in two or three groups with one copy hidden app-wide. Only a
    // visible one is the page you are on, so only a visible one marks a trail.
    const actives = [...sideNav.querySelectorAll(".nav-items.active")].filter(
      (row) => row.offsetParent !== null
    );
    actives.forEach((row) => {
      row.setAttribute("aria-current", "page");
      row.closest(".nav-opt-wrap")?.classList.add("has-active");
    });

    const stored = navReadOpen();

    sideNav.querySelectorAll(".nav-opt-wrap").forEach((wrapper) => {
      const menu = wrapper.querySelector(".nav-labels-opt");
      const toggle = navGroupToggle(wrapper);
      if (!menu || !toggle) return;

      // A header that is itself a link (SKUs List -> /app/label-stock/view)
      // navigates on click: its group only ever holds the one page it already
      // points at, so there is nothing to expand and it stays a plain link.
      const isLink = toggle.tagName === "A";
      if (!isLink) {
        toggle.setAttribute("role", "button");
        toggle.setAttribute("tabindex", "0");
      }

      const label = navGroupLabel(wrapper);
      const openNow =
        wrapper.classList.contains("has-active") ||
        wrapper.hasAttribute("data-open-default") ||
        (!!label && stored.has(label));

      // Whatever state the page loads in is the state it was always in -- no
      // animation for it, or every page load plays the nav opening itself.
      menu.classList.add("no-transition");
      setNavGroup(wrapper, openNow, { remember: false });
      requestAnimationFrame(() => {
        requestAnimationFrame(() => menu.classList.remove("no-transition"));
      });

      if (isLink) return;

      toggle.addEventListener("click", (e) => {
        if (e.target.closest(".nav-labels-opt")) return;
        e.stopPropagation();
        setNavGroup(wrapper, !wrapper.classList.contains("is-open"));
      });

      // A <div> with role="button" gets none of a real button's keyboard
      // handling for free.
      toggle.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
          e.preventDefault(); // Space would scroll the page
          setNavGroup(wrapper, !wrapper.classList.contains("is-open"));
        }
      });
    });

    // Clicking a page must not also toggle the group it sits in.
    sideNav.querySelectorAll(".nav-opt-wrap .nav-labels-opt").forEach((menu) => {
      menu.addEventListener("click", (e) => e.stopPropagation());
    });

    sideNav.addEventListener("keydown", (e) => {
      const row = e.target.closest(".nav-items");
      if (!row || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const wrapper = row.closest(".nav-opt-wrap");
      // A link header has no open state, so left/right do nothing on it.
      const isHeader = !!wrapper && row === navGroupToggle(wrapper) && row.tagName !== "A";

      if (e.key === "ArrowDown") {
        e.preventDefault();
        navMove(row, 1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        navMove(row, -1);
      } else if (e.key === "Home") {
        e.preventDefault();
        navRows()[0]?.focus();
      } else if (e.key === "End") {
        e.preventDefault();
        navRows().slice(-1)[0]?.focus();
      } else if (e.key === "ArrowRight" && isHeader) {
        e.preventDefault();
        // Open it; once open, step into the first page under it.
        if (wrapper.classList.contains("is-open")) navMove(row, 1);
        else setNavGroup(wrapper, true);
      } else if (e.key === "ArrowLeft" && wrapper) {
        e.preventDefault();
        // On a page, go up to its group header; on an open header, shut it.
        if (isHeader && wrapper.classList.contains("is-open")) setNavGroup(wrapper, false);
        else if (!isHeader) navGroupToggle(wrapper)?.focus();
      }
    });

    // On a tree long enough to scroll, open it on the page you are actually
    // on. "nearest" so a page already in view doesn't jump.
    if (actives[0] && sideNav.scrollHeight > sideNav.clientHeight) {
      actives[0].scrollIntoView({ block: "nearest" });
    }
  })();

  // ================= INPUT UPPERCASE =================

  document.querySelectorAll("input[type='text']").forEach((input) => {
    input.addEventListener("input", function () {
      const start = this.selectionStart;
      const end = this.selectionEnd;
      const uppercased = this.value.toUpperCase();
      if (this.value !== uppercased) {
        this.value = uppercased;
        this.setSelectionRange(start, end);
      }
    });
  });

  // ================= NUMBER INPUT SCROLL GUARD =================
  // Chrome/Firefox change a focused number input's value on mouse-wheel
  // scroll, which silently corrupts data entry whenever the page (or a
  // dialog) happens to be scrollable under the cursor. Blur it on wheel so
  // scrolling just scrolls, never edits. Delegated on document so it also
  // covers number inputs added after page load (dialogs, dynamic rows).
  document.addEventListener(
    "wheel",
    () => {
      if (document.activeElement?.tagName === "INPUT" && document.activeElement.type === "number") {
        document.activeElement.blur();
      }
    },
    { passive: true }
  );

  // ================= CUSTOM NAV HISTORY =================

  (function () {
    const backBtn = document.getElementById("fdNavBack");
    const forwardBtn = document.getElementById("fdNavForward");
    if (!backBtn || !forwardBtn) return;

    const STACK_KEY = "fd_navStack";
    const FORWARD_KEY = "fd_navForwardStack";
    const LAST_KEY = "fd_navLast";
    const ACTION_KEY = "fd_navAction";

    const getLocationKey = () => window.location.pathname + window.location.search;

    const readStack = (key) => {
      try {
        const raw = sessionStorage.getItem(key);
        return raw ? JSON.parse(raw) : [];
      } catch (err) {
        return [];
      }
    };

    const writeStack = (key, arr) => {
      sessionStorage.setItem(key, JSON.stringify(arr));
    };

    const updateButtons = (backStack, forwardStack) => {
      const backDisabled = backStack.length === 0;
      const forwardDisabled = forwardStack.length === 0;

      backBtn.classList.toggle("disabled", backDisabled);
      forwardBtn.classList.toggle("disabled", forwardDisabled);
      backBtn.disabled = backDisabled;
      forwardBtn.disabled = forwardDisabled;
    };

    const current = getLocationKey();
    let backStack = readStack(STACK_KEY);
    let forwardStack = readStack(FORWARD_KEY);

    const last = sessionStorage.getItem(LAST_KEY);
    const actionRaw = sessionStorage.getItem(ACTION_KEY);
    let action = null;
    try {
      action = actionRaw ? JSON.parse(actionRaw) : null;
    } catch (err) {
      action = null;
    }

    if (action && action.target === current) {
      sessionStorage.removeItem(ACTION_KEY);
    } else if (last && last !== current) {
      if (!backStack.length || backStack[backStack.length - 1] !== last) {
        backStack.push(last);
      }
      forwardStack = [];
    } else if (!last) {
      try {
        const ref = document.referrer ? new URL(document.referrer) : null;
        if (ref && ref.origin === window.location.origin) {
          const refKey = ref.pathname + ref.search;
          if (refKey && refKey !== current) {
            backStack.push(refKey);
          }
        }
      } catch (err) {
        // ignore invalid referrer
      }
    }

    sessionStorage.setItem(LAST_KEY, current);
    writeStack(STACK_KEY, backStack);
    writeStack(FORWARD_KEY, forwardStack);
    updateButtons(backStack, forwardStack);

    backBtn.addEventListener("click", () => {
      if (!backStack.length) return;
      const target = backStack.pop();
      forwardStack.push(current);
      writeStack(STACK_KEY, backStack);
      writeStack(FORWARD_KEY, forwardStack);
      sessionStorage.setItem(ACTION_KEY, JSON.stringify({ target }));
      window.location.href = target;
    });

    forwardBtn.addEventListener("click", () => {
      if (!forwardStack.length) return;
      const target = forwardStack.pop();
      backStack.push(current);
      writeStack(STACK_KEY, backStack);
      writeStack(FORWARD_KEY, forwardStack);
      sessionStorage.setItem(ACTION_KEY, JSON.stringify({ target }));
      window.location.href = target;
    });
  })();
  // Shared helper to limit numeric input to two chars (moved from inline templates)
  window.limitToTwoChars = function(elem) {
    if (elem.value.length > 2) {
      elem.value = elem.value.slice(0, 2);
    }
  };
})();
