// Universal search: lists every link in the side nav (so it follows the
// signed-in user's role/permissions) and jumps to the chosen one.
(function () {
  const input = document.getElementById("fdNavSearch");
  const box = document.getElementById("fdNavSearchResults");
  const sideNav = document.querySelector(".side-nav");
  if (!input || !box || !sideNav) return;

  const hidden = (el) => !!el.closest('[style*="display: none"], [style*="display:none"]');

  const entries = [];
  const seen = new Set();
  sideNav.querySelectorAll("a[href]").forEach((a) => {
    if (hidden(a) || a.closest(".side-nav-watermark")) return;
    const label = (a.querySelector(".nav-items-para")?.textContent || a.title || "").trim();
    const href = a.getAttribute("href");
    if (!label || !href || href === "#") return;
    const wrap = a.closest(".nav-opt-wrap");
    const group = wrap ? (wrap.querySelector(".nav-items-para")?.textContent || "").trim() : "";
    // Sub-heading ("View", "Entry", "Deckle"...) = nearest preceding heading in the group
    let sub = "";
    for (let p = a.previousElementSibling; p; p = p.previousElementSibling) {
      if (p.tagName === "DIV" && p.querySelector("p") && !p.classList.contains("nav-items")) {
        sub = p.textContent.trim();
        break;
      }
    }
    const key = href + "|" + label;
    if (seen.has(key)) return;
    seen.add(key);
    const path = [group && group !== label ? group : "", sub].filter(Boolean).join(" › ");
    const icon = a.querySelector("i")?.className || "fa-solid fa-link";
    entries.push({ label, href, path, icon, hay: (label + " " + path).toLowerCase() });
  });

  let active = -1;
  let shown = [];

  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  function score(e, terms) {
    let s = 0;
    const l = e.label.toLowerCase();
    for (const t of terms) {
      if (!e.hay.includes(t)) return -1;
      s += l.startsWith(t) ? 3 : l.includes(t) ? 2 : 1;
    }
    return s;
  }

  function render() {
    const terms = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    shown = terms.length
      ? entries
          .map((e) => ({ e, s: score(e, terms) }))
          .filter((x) => x.s >= 0)
          .sort((a, b) => b.s - a.s)
          .map((x) => x.e)
      : entries.slice();
    active = shown.length ? 0 : -1;
    box.innerHTML = shown.length
      ? shown
          .map(
            (e, i) =>
              `<a class="ns-item${i === 0 ? " is-active" : ""}" href="${esc(e.href)}" data-i="${i}">` +
              `<i class="${esc(e.icon)}"></i><span class="ns-label">${esc(e.label)}</span>` +
              `<span class="ns-path">${esc(e.path)}</span></a>`
          )
          .join("")
      : '<div class="ns-empty">No matching page</div>';
  }

  function open() {
    // One header dropdown at a time: opening search closes the notification bell's.
    document.getElementById("fdNotifMenu")?.classList.remove("show");
    render();
    box.classList.add("is-open");
  }
  function close() { box.classList.remove("is-open"); }

  function setActive(i) {
    if (!shown.length) return;
    active = (i + shown.length) % shown.length;
    box.querySelectorAll(".ns-item").forEach((el, n) => el.classList.toggle("is-active", n === active));
    box.querySelector(".ns-item.is-active")?.scrollIntoView({ block: "nearest" });
  }

  input.addEventListener("focus", open);
  input.addEventListener("input", open);
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowDown") { ev.preventDefault(); setActive(active + 1); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); setActive(active - 1); }
    else if (ev.key === "Enter") {
      ev.preventDefault();
      if (shown[active]) window.location.href = shown[active].href;
    } else if (ev.key === "Escape") { input.blur(); close(); }
  });
  box.addEventListener("mousemove", (ev) => {
    const it = ev.target.closest(".ns-item");
    if (it) setActive(Number(it.dataset.i));
  });
  box.addEventListener("mousedown", (ev) => ev.preventDefault()); // keep focus so click registers
  document.addEventListener("click", (ev) => {
    if (!ev.target.closest(".ns-wrap")) close();
  });
  document.addEventListener("keydown", (ev) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) ||
      document.activeElement?.isContentEditable;
    if ((ev.key === "k" && (ev.ctrlKey || ev.metaKey)) || (ev.key === "/" && !typing && !ev.ctrlKey && !ev.metaKey && !ev.altKey)) {
      ev.preventDefault();
      input.focus();
      input.select();
    }
  });
})();
