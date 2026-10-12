import "./config/loadEnv.js";
import express from "express";
import compression from "compression";
import ejsMate from "ejs-mate";
import connectDB from "./config/db.js";
import fairdeskRoute from "./routes/fairdesk_route.js";
import sachikoRoute from "./routes/sachiko/sachiko_route.js";
import machineRoutes from "./routes/system/machine.js";
import slittingRoutes from "./routes/system/slitting.js";
import operatorApiRoutes from "./routes/api/operatorApi.js";
import maintenanceRoutes from "./routes/system/maintenance.js";
import facestockMasterRoutes from "./routes/system/facestockMaster.js";
import familyMasterRoutes from "./routes/system/familyMaster.js";
import companyRoutes from "./routes/system/company.js";
import typeMasterRoutes from "./routes/system/typeMaster.js";
import coreMasterRoutes from "./routes/system/coreMaster.js";
import boardPaperMasterRoutes from "./routes/system/boardPaperMaster.js";
import adhesiveMasterRoutes from "./routes/system/adhesiveMaster.js";
import releaseMasterRoutes from "./routes/system/releaseMaster.js";
import notificationRoutes from "./routes/system/notifications.js";
import payrollRoute from "./routes/acccounting/payroll.js";
import loanRoute from "./routes/acccounting/loan.js";
import advanceRoute from "./routes/acccounting/advance.js";
import employeeRoute from "./routes/hr/employee.js";
import pettycashRoute from "./routes/acccounting/pettycash.js";
import labelStockBindingRoutes from "./routes/sachiko/labelStockBinding.js";
import labelStockAdhesiveBindingRoutes from "./routes/sachiko/labelStockAdhesiveBinding.js";
import stockViewRoutes from "./routes/stock/stockView.js";
import facestockStockRoutes from "./routes/stock/facestockStock.js";
import wipStockRoutes from "./routes/stock/wipStock.js";
import adhesiveStockRoutes from "./routes/stock/adhesiveStock.js";
import releaseLinerStockRoutes from "./routes/stock/releaseLinerStock.js";
import coreStockRoutes from "./routes/stock/coreStock.js";
import semiFinishedStockRoutes from "./routes/stock/semiFinishedStock.js";
import finishedStockRoutes from "./routes/stock/finishedStock.js";
import labelStockProductionRoutes from "./routes/sachiko/labelStockProduction.js";
import clientFormRoute from "./routes/users/clients.js";
import reorderRoutes from "./routes/inventory/reorder.js";
import { requireAuth, requireRole } from "./middleware/auth.js";
import { auditLogger, logAuthEvent } from "./middleware/auditLogger.js";
import { authenticateOperator } from "./utils/operatorAuth.js";
import { fileURLToPath } from "url";
import path from "path";
import os from "os";
import fs from "fs";
import sharp from "sharp";
import bcrypt from "bcrypt";
import { escapeRegex } from "./utils/security.js";
import { normalizeLocationName } from "./utils/locations.js";
import Employee from "./models/hr/employee_model.js";
import Location from "./models/system/location.js";
import crypto from "crypto";

import session from "express-session";
import flash from "connect-flash";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import csrf from "csurf";
import cookieParser from "cookie-parser";
import MongoSessionStore from "./utils/mongoSessionStore.js";
import { safeJson } from "./utils/security.js";
import { currentBrand, ensureFreshBrand, refreshBrand, shortBrand } from "./utils/companyBrand.js";
import { brandPrefix } from "./middleware/brandPrefix.js";
import { sendAsset, assetExists, assetPath } from "./utils/media.js";
import { offlinePageHtml } from "./utils/offlinePage.js";
import { loginLimiter, createLimiter, updateLimiter, deleteLimiter } from "./utils/limiters.js";
import { startTaskReminderJob } from "./utils/taskReminders.js";

const app = express();
if (!process.env.PORT) {
  console.error("❌ CRITICAL: PORT not set in .env");
  process.exit(1);
}
const port = Number(process.env.PORT);
if (!Number.isFinite(port) || port <= 0) {
  console.error("❌ CRITICAL: PORT in .env is not a valid number");
  process.exit(1);
}

/* DB (env already loaded by the config/loadEnv.js import at the top of this file) */
connectDB();
// Prime the company name / URL-slug cache (mongoose buffers this until connected).
refreshBrand().catch(() => {});

// Validate required environment variables
const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  console.error("❌ CRITICAL: SESSION_SECRET not set in .env");
  process.exit(1);
}

/* SECURITY MIDDLEWARE (HELMET) */
// Let a per-request CSP header with nonces be applied later so inline scripts can be selectively allowed.
app.use(
  helmet({
    contentSecurityPolicy: false,
    frameguard: { action: "deny" },
    noSniff: true,
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    strictTransportSecurity: {
      maxAge: 31536000, // 1 year
      includeSubDomains: true,
      preload: true,
    },
    permissionsPolicy: {
      camera: [],
      microphone: [],
      geolocation: [],
      usb: [],
      magnetometer: [],
      gyroscope: [],
      accelerometer: [],
    },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: "unsafe-none" },
    originAgentCluster: true,
  }),
);

/* RATE LIMITING */
// Imported from utils/limiters.js: loginLimiter, createLimiter, updateLimiter, deleteLimiter

/* PATH SETUP */
const file_name = fileURLToPath(import.meta.url);
const dir_name = path.dirname(file_name);

/* VIEW ENGINE */
app.engine("ejs", ejsMate);
app.set("view engine", "ejs");
app.set("views", path.join(dir_name, "views"));

/* GZIP COMPRESSION */
app.use(compression());

/* BODY PARSERS */
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
// app.use(cookieParser()); // Redundant and can interfere with express-session

/* STATIC FILES */
// Our own JS/CSS change with every release, so the browser must revalidate them
// on each load (a cheap 304 when unchanged) instead of serving a day-old copy --
// a page that calls a function added to a cached public/js file otherwise breaks
// (its table never draws) until a hard refresh. Images/fonts keep the 1-day cache.
app.use(
  express.static(path.join(dir_name, "public"), {
    maxAge: "1d",
    setHeaders(res, filePath) {
      if (/\.(js|css)$/i.test(filePath)) res.setHeader("Cache-Control", "no-cache");
    },
  }),
);
app.use("/bootstrap", express.static(dir_name + "/node_modules/bootstrap/dist", { maxAge: "1d" }));

// Per-request nonce + HTML post-processing middleware to inject nonce on inline scripts
app.use((req, res, next) => {
  const nonce = crypto.randomBytes(16).toString("base64");
  res.locals.cspNonce = nonce;

  // Wrap res.render to inject nonce attributes into inline <script> tags and set CSP header
  const _render = res.render.bind(res);
  res.render = function (view, options = {}, callback) {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    options = Object.assign({}, options, { cspNonce: nonce });
    _render(view, options, function (err, html) {
      if (err) {
        if (callback) return callback(err);
        return next(err);
      }
      // Allow inline scripts and existing inline event handlers for compatibility.
      // (Consider refactoring to remove 'unsafe-inline' in future.)
      const csp = [
        `default-src 'self'`,
        `script-src 'self' cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com 'unsafe-inline'`,
        `script-src-elem 'self' cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com 'unsafe-inline'`,
        // Permit font-awesome, tabulator and other styles
        `style-src 'self' cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com 'unsafe-inline'`,
        `style-src-elem 'self' cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com 'unsafe-inline'`,
        `img-src 'self' data:`,
        // Video/audio: served from this origin, plus blob: so a clip picked in
        // a form can be previewed before it is uploaded.
        `media-src 'self' blob:`,
        `connect-src 'self' cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com`,
        `font-src 'self' cdn.jsdelivr.net https://cdnjs.cloudflare.com`,
        `object-src 'none'`,
      ].join("; ");
      res.setHeader("Content-Security-Policy", csp);

      if (callback) return callback(null, html);
      res.send(html);
    });
  };

  next();
});

/* SESSION */
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

const sessionStore = new MongoSessionStore({
  ttlMs: SESSION_TTL_MS,
});

// Browsers key cookies by (domain, path, name) -- never by port. Three
// copies of this app on the same host (different PORTs, e.g. running several
// branded deployments side by side) would otherwise all write "app.sid" to the
// same cookie slot, so logging into one silently logs the others out (and
// worse, could hand one deployment's session to another's server). Folding the
// port into the cookie name gives each deployment its own slot in the browser's
// cookie jar. Logout has to clear this exact name, so it lives in one constant.
const SESSION_COOKIE_NAME = `app.sid.${port}`;
const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
};

app.use(
  session({
    name: SESSION_COOKIE_NAME,
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    store: sessionStore,
    cookie: {
      ...SESSION_COOKIE_OPTIONS,
      maxAge: SESSION_TTL_MS,
    },
  }),
);

const getSessionExpiresAt = (req) => {
  const maxAge = Number(req.session?.cookie?.maxAge ?? req.session?.cookie?.originalMaxAge);
  if (Number.isFinite(maxAge) && maxAge > 0) {
    return new Date(Date.now() + maxAge).toISOString();
  }

  const expires = req.session?.cookie?.expires;
  if (expires) {
    const expiresDate = new Date(expires);
    if (!Number.isNaN(expiresDate.getTime())) {
      return expiresDate.toISOString();
    }
  }

  return new Date(Date.now() + SESSION_TTL_MS).toISOString();
};

/* CSRF PROTECTION SETUP */
const csrfProtection = csrf({ cookie: false });

/* FLASH */
app.use(flash());

/* AUTH SESSION EXPIRY HELPERS */
app.use((req, res, next) => {
  if (req.session?.authUser) {
    const sessionExpiresAt = getSessionExpiresAt(req);
    res.locals.sessionExpiresAt = sessionExpiresAt;
    res.setHeader("X-Session-Expires-At", sessionExpiresAt);
  }

  next();
});

/* GLOBAL LOCALS (EARLY) */
app.use((req, res, next) => {
  res.locals.notification = req.session.flash?.notification || [];
  res.locals.error = req.session.flash?.error || [];
  // A session stores the permission snapshot taken at login, so backdoor
  // sessions opened before DEV_PERMISSIONS_BY_ROLE existed still carry the old
  // "everything true" set and render menus their role shouldn't have. Refresh
  // it here so those sessions correct themselves instead of needing a re-login.
  // DB employees (which have an empId) keep the permissions from their record.
  const sessionUser = req.session?.authUser;
  if (sessionUser && !sessionUser.empId && DEV_PERMISSIONS_BY_ROLE[sessionUser.role]) {
    sessionUser.permissions = DEV_PERMISSIONS_BY_ROLE[sessionUser.role];
  }

  res.locals.authUser = req.session?.authUser || null;
  res.locals.sessionExpiresAt = res.locals.sessionExpiresAt || null;
  res.locals.safeJson = safeJson;
  // "Home" isn't the same page for everyone: operators can't open /welcome, so
  // the layout's Dashboard link points wherever landingForUser sends them.
  res.locals.homeUrl = landingForUser(req.session?.authUser);

  next();
});

/* Company-slug URL prefix: maps the live /<company>/... the user sees onto the
   constant internal mount, and rewrites it back on the way out. Must sit above
   every "/app" route mount and above auditLogger / auth path checks. */
app.use(brandPrefix);

/* AUDIT LOG — records every mutating request made by a logged-in user */
app.use(auditLogger);

/* Favicon / app icon -- the company logo if one is set, otherwise a square with
   the first letter of the company name. Public (also used on the login page).
   Referenced as /company/favicon?v=<brandVer> so a logo change busts the cache. */
function serveBrandFavicon(req, res) {
  const { name, logo } = currentBrand();
  // Only serve the logo if its file is actually on disk -- a stale reference
  // (e.g. left behind by an old company-switch) must fall back to the letter,
  // not 404.
  if (logo && logo.filename && (assetExists(logo, { thumb: true }) || assetExists(logo))) {
    return sendAsset(res, logo, { thumb: true });
  }
  const letter = (String(name || "S").trim().toUpperCase().match(/[A-Z0-9]/) || ["S"])[0];
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
    `<rect width="64" height="64" rx="14" fill="#044a78"/>` +
    `<text x="32" y="34" dominant-baseline="central" text-anchor="middle" ` +
    `font-family="Segoe UI, Roboto, Helvetica, Arial, sans-serif" font-weight="700" ` +
    `font-size="34" fill="#ffffff">${letter}</text></svg>`;
  res.setHeader("Cache-Control", "public, max-age=300");
  res.type("image/svg+xml").send(svg);
}
app.get("/company/favicon", serveBrandFavicon);
app.get("/favicon.ico", serveBrandFavicon);

/* PWA: manifest, service worker and install icons. Public (the browser fetches
   them before/without a session) and branded from the Company master, so the
   installed app carries the company's name and logo. start_url is "/" because
   that already redirects every role to its own landing page, and scope "/"
   covers whatever URL prefix the company is currently served under. */
app.get("/manifest.webmanifest", (req, res) => {
  const { name, ver } = currentBrand();
  const v = encodeURIComponent(ver);
  res.setHeader("Cache-Control", "public, max-age=300");
  res.type("application/manifest+json").send(
    JSON.stringify({
      id: "/",
      name,
      short_name: shortBrand(name),
      description: `${name} - production, stock and sales management`,
      lang: "en-IN",
      dir: "ltr",
      categories: ["business", "productivity"],
      start_url: "/",
      scope: "/",
      display: "standalone",
      display_override: ["standalone", "minimal-ui"],
      orientation: "any",
      prefer_related_applications: false,
      launch_handler: { client_mode: "focus-existing" },
      theme_color: "#044a78",
      background_color: "#f8f9fa",
      icons: [
        { src: `/company/pwa-icon/192.png?v=${v}`, sizes: "192x192", type: "image/png", purpose: "any" },
        { src: `/company/pwa-icon/512.png?v=${v}`, sizes: "512x512", type: "image/png", purpose: "any" },
        { src: `/company/pwa-icon/512.png?v=${v}&maskable=1`, sizes: "512x512", type: "image/png", purpose: "maskable" },
      ],
    }),
  );
});

const pwaIconMemo = new Map(); // size|maskable|brandVer -> PNG; sharp runs once per logo change
app.get("/company/pwa-icon/:size.png", async (req, res) => {
  try {
    const size = Number(req.params.size);
    if (![180, 192, 512].includes(size)) return res.status(404).end();
    const maskable = req.query.maskable === "1";
    const { name, logo, ver } = currentBrand();
    const memoKey = `${size}|${maskable}|${ver}|${name}`;
    let png = pwaIconMemo.get(memoKey);
    if (png) {
      res.setHeader("Cache-Control", "public, max-age=300");
      return res.type("image/png").send(png);
    }
    if (logo && logo.filename && assetExists(logo)) {
      // "any" icons: a round badge (transparent corners) with the logo inside.
      // Maskable: full-bleed, extra padding -- the OS applies its own circle crop
      // (safe zone = inner 80%), so the logo must not reach the edge.
      const inner = Math.round(size * (maskable ? 0.58 : 0.74));
      const fitted = await sharp(assetPath(logo)).rotate().resize(inner, inner, { fit: "inside" }).png().toBuffer();
      const disc = maskable
        ? Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" fill="#ffffff"/></svg>`)
        : Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#ffffff"/></svg>`);
      png = await sharp(disc).composite([{ input: fitted, gravity: "centre" }]).png().toBuffer();
    } else {
      const letter = (String(name || "S").trim().toUpperCase().match(/[A-Z0-9]/) || ["S"])[0];
      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${maskable ? '<rect width="64" height="64" fill="#044a78"/>' : '<circle cx="32" cy="32" r="32" fill="#044a78"/>'}` +
        `<text x="32" y="34" dominant-baseline="central" text-anchor="middle" font-family="Segoe UI, Roboto, Helvetica, Arial, sans-serif" ` +
        `font-weight="700" font-size="${maskable ? 26 : 34}" fill="#ffffff">${letter}</text></svg>`;
      png = await sharp(Buffer.from(svg), { density: 384 }).resize(size, size).png().toBuffer();
    }
    if (pwaIconMemo.size > 30) pwaIconMemo.clear();
    pwaIconMemo.set(memoKey, png);
    res.setHeader("Cache-Control", "public, max-age=300");
    res.type("image/png").send(png);
  } catch (e) {
    console.error("pwa-icon failed:", e.message);
    res.status(500).end();
  }
});

/* Service worker -- served from the root so its scope covers every prefix.
   Deliberately thin: it makes the app installable and caches same-origin static
   files (stale-while-revalidate). Pages are never cached (they embed a per-session
   CSRF token and per-user data); offline shows a small notice instead. Bump
   SW_VERSION to drop old caches. */
const SW_SOURCE = `
const SW_VERSION = "v6";
const STATIC_CACHE = "static-" + SW_VERSION;
const STATIC_RE = /^\\/(css|js|assets|bootstrap|company\\/pwa-icon)\\//;
self.addEventListener("install", (e) => {
  // Precache the offline page so it can be shown when the server is unreachable.
  e.waitUntil(
    caches.open(STATIC_CACHE)
      .then((c) => c.add(new Request("/offline.html", { cache: "reload" })))
      .catch(() => {})
      .then(() => self.skipWaiting())
  );
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== STATIC_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req).catch(() =>
        caches.match("/offline.html").then((hit) => hit || new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain" } }))
      )
    );
    return;
  }
  if (STATIC_RE.test(url.pathname)) {
    // Our JS/CSS: network first, cache only as the offline fallback. Serving the
    // cached copy first (as below) hands a page the previous release's script and
    // the table breaks until a second load.
    if (/\\.(js|css)$/i.test(url.pathname)) {
      e.respondWith(
        fetch(req)
          .then((res) => {
            if (res.ok) { const copy = res.clone(); caches.open(STATIC_CACHE).then((c) => c.put(req, copy)); }
            return res;
          })
          .catch(() => caches.match(req))
      );
      return;
    }
    e.respondWith(
      caches.open(STATIC_CACHE).then((cache) =>
        cache.match(req).then((hit) => {
          const net = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => hit);
          return hit || net;
        })
      )
    );
  }
});
`;
app.get("/offline.html", (req, res) => {
  res.setHeader("Cache-Control", "no-cache");
  res.type("html").send(offlinePageHtml({ name: currentBrand().name }));
});
app.get("/sw.js", (req, res) => {
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Service-Worker-Allowed", "/");
  res.type("application/javascript").send(SW_SOURCE);
});

/* Session check endpoint – used by client-side polling (exempt from CSRF) */
app.get("/check-session", (req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  if (req.session?.authUser) {
    req.session.touch();
    const expiresAt = getSessionExpiresAt(req);
    res.setHeader("X-Session-Expires-At", expiresAt);
    return res.json({ authenticated: true, expiresAt });
  }
  return res.status(401).json({ authenticated: false });
});

/* JSON operator API for the Sachiko Operator mobile app -- bearer-token
   authenticated (middleware/apiAuth.js), not session/CSRF based, so it must
   sit here, exempt from CSRF the same way /check-session above is. */
app.use("/app/api/operator", operatorApiRoutes);

/* Apply CSRF protection to ALL routes */
app.use(csrfProtection);
app.use((req, res, next) => {
  res.locals.csrfToken = typeof req.csrfToken === "function" ? req.csrfToken() : "";
  next();
});

/* Login portal info: this app authenticates Sachiko only; the Fairtech
   option on the shared login switches the browser to the Fairtech app. */
app.use((req, res, next) => {
  res.locals.selfBrand = "sachiko";
  res.locals.fairtechLoginUrl = `${process.env.FAIRTECH_URL || "http://localhost:3000"}/fairtech/login`;
  res.locals.sachikoLoginUrl = "/app/login";
  // Company name from the Company master -- drives every page <title>, the nav
  // header and the login screen. Read synchronously from the cache
  // (utils/companyBrand.js); brandPrefix already kicked off any needed refresh.
  ensureFreshBrand();
  const _b = currentBrand();
  res.locals.brandName = _b.name;
  res.locals.brandShort = shortBrand(_b.name);
  res.locals.brandVer = _b.ver;
  res.locals.faviconUrl = `/company/favicon?v=${encodeURIComponent(_b.ver)}`;
  next();
});

/* Authenticated Image Serving */
app.get("/debug-image/:folder/:filename", async (req, res) => {
  const { folder, filename } = req.params;
  const filePath = path.join(dir_name, "images", folder, filename);
  if (fs.existsSync(filePath)) {
    return res.sendFile(filePath);
  }

  // Try alternate extension
  if (filename.toLowerCase().endsWith(".jpg") || filename.toLowerCase().endsWith(".jpeg")) {
    const base = filename.substring(0, filename.lastIndexOf("."));
    const altExt = filename.toLowerCase().endsWith(".jpg") ? ".jpeg" : ".jpg";
    const altPath = path.join(dir_name, "images", folder, base + altExt);
    if (fs.existsSync(altPath)) {
      return res.sendFile(altPath);
    }
  }

  res.status(404).send(`Not found on disk. Tried: ${filePath}`);
});

app.get("/images/:folder/:filename", requireAuth, async (req, res) => {
  const { folder, filename } = req.params;

  // Validate folder
  if (!["aadhaar", "pan", "empimg", "biodata"].includes(folder)) {
    return res.status(400).send("Invalid folder");
  }

  // Validate filename (prevent directory traversal and arbitrary uploads).
  // Biodata is the one folder that can also hold a PDF -- everything else
  // stays image-only, same as the upload-time fileFilter enforces.
  const filenamePattern =
    folder === "biodata" ? /^[\w\-. ]+\.(jpg|jpeg|png|gif|webp|pdf)$/i : /^[\w\-. ]+\.(jpg|jpeg|png|gif|webp)$/i;
  if (!filenamePattern.test(filename)) {
    return res.status(400).send("Invalid filename");
  }

  // Check ACL - user can only view own images
  const fieldMap = {
    empimg: "empPhoto",
    aadhaar: "empAadhaarImg",
    pan: "empPanImg",
    biodata: "empBiodata",
  };

  let employee = await Employee.findOne({
    [fieldMap[folder]]: filename,
  });

  // Handle common extension mismatch (.jpg vs .jpeg)
  if (!employee && (filename.toLowerCase().endsWith(".jpg") || filename.toLowerCase().endsWith(".jpeg"))) {
    const base = filename.substring(0, filename.lastIndexOf("."));
    const altExts = filename.toLowerCase().endsWith(".jpg") ? [".jpeg", ".JPG", ".JPEG"] : [".jpg", ".JPG", ".JPEG"];

    for (const ext of altExts) {
      employee = await Employee.findOne({ [fieldMap[folder]]: base + ext });
      if (employee) break;
    }
  }

  if (!employee) {
    console.warn(`[IMAGE] Not found in DB: ${folder}/${filename}`);
    return res.status(404).send("Not found");
  }

  // ACL - allow admin and HR to see everything.
  // Allow management (HOD, Sales) to see employee photos (empimg).
  // Everyone can see their own data.
  const authUser = req.session.authUser;
  const isAdmin = authUser.role === "admin" || authUser.role === "proprietor";
  const isHR = authUser.role === "hr";
  const isManagement = ["admin", "proprietor", "hr", "hod", "sales"].includes(authUser.role);
  const isOwnData = authUser.empId && authUser.empId === employee.empId;

  let allowed = false;
  if (isAdmin || isHR) {
    allowed = true;
  } else if (folder === "empimg" && isManagement) {
    allowed = true;
  } else if (isOwnData) {
    allowed = true;
  }

  if (!allowed) {
    console.warn(
      `[IMAGE] Access denied: user=${authUser.username} role=${authUser.role} folder=${folder} file=${filename}`,
    );
    return res.status(403).send("Forbidden");
  }

  // Serve with no-cache headers
  let filePath = path.join(dir_name, "images", folder, filename);

  if (!fs.existsSync(filePath)) {
    // Try alternate extension on disk if not found
    if (filename.toLowerCase().endsWith(".jpg") || filename.toLowerCase().endsWith(".jpeg")) {
      const base = filename.substring(0, filename.lastIndexOf("."));
      const altExt = filename.toLowerCase().endsWith(".jpg") ? ".jpeg" : ".jpg";
      const altPath = path.join(dir_name, "images", folder, base + altExt);

      if (fs.existsSync(altPath)) {
        filePath = altPath;
      } else {
        console.warn(`[IMAGE] File not on disk: ${filePath} (also tried ${altPath})`);
        return res.status(404).send("Not found");
      }
    } else {
      console.warn(`[IMAGE] File not on disk: ${filePath}`);
      return res.status(404).send("Not found");
    }
  }

  res.setHeader("Cache-Control", "private, no-cache, no-store");
  res.sendFile(filePath);
});

/* Image Thumbnail Route (Authenticated + Compressed) */
app.get("/images/thumb/:folder/:filename", requireAuth, async (req, res) => {
  const { folder, filename } = req.params;

  // Validate folder
  if (!["aadhaar", "pan", "empimg"].includes(folder)) {
    return res.status(400).send("Invalid folder");
  }

  // Validate filename
  if (!/^[\w\-. ]+\.(jpg|jpeg|png|gif|webp)$/i.test(filename)) {
    return res.status(400).send("Invalid filename");
  }

  // Check ACL
  const fieldMap = {
    empimg: "empPhoto",
    aadhaar: "empAadhaarImg",
    pan: "empPanImg",
  };

  let employee = await Employee.findOne({
    [fieldMap[folder]]: filename,
  });

  // Handle common extension mismatch (.jpg vs .jpeg)
  if (!employee && (filename.toLowerCase().endsWith(".jpg") || filename.toLowerCase().endsWith(".jpeg"))) {
    const base = filename.substring(0, filename.lastIndexOf("."));
    const altExts = filename.toLowerCase().endsWith(".jpg") ? [".jpeg", ".JPG", ".JPEG"] : [".jpg", ".JPG", ".JPEG"];

    for (const ext of altExts) {
      employee = await Employee.findOne({ [fieldMap[folder]]: base + ext });
      if (employee) break;
    }
  }

  if (!employee) return res.status(404).send("Not found");

  const authUser = req.session.authUser;
  const isAdmin = authUser.role === "admin" || authUser.role === "proprietor";
  const isHR = authUser.role === "hr";
  const isManagement = ["admin", "proprietor", "hr", "hod", "sales"].includes(authUser.role);
  const isOwnData = authUser.empId && authUser.empId === employee.empId;

  let allowed = false;
  if (isAdmin || isHR) {
    allowed = true;
  } else if (folder === "empimg" && isManagement) {
    allowed = true;
  } else if (isOwnData) {
    allowed = true;
  }

  if (!allowed) return res.status(403).send("Forbidden");

  const filePath = path.join(dir_name, "images", folder, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send("Not found");
  }

  try {
    const data = await sharp(filePath).resize(100, 100, { fit: "cover" }).jpeg({ quality: 80 }).toBuffer();

    res.set("Content-Type", "image/jpeg");
    res.set("Cache-Control", "private, max-age=3600"); // 1 hour, private cache
    res.send(data);
  } catch (err) {
    console.error("Image processing error:", err);
    res.sendFile(filePath); // Fallback to original
  }
});

/* ROUTES */
const redirectByRole = (role) => {
  if (["proprietor", "admin", "hod", "sales", "hr", "employee"].includes(role)) {
    return "/app/welcome";
  }
  return "/app/login";
};

// Operators sign in through their own portal and land straight on their work
// queue (resolved from PendingProduction.operatorId at login), so they never
// have to navigate the main menus.
const landingForUser = (authUser) => {
  if (!authUser) return "/app/login";
  if (authUser.role === "operator") {
    return "/app/operator/queue";
  }
  return redirectByRole(authUser.role);
};

app.get("/", (req, res) => {
  if (req.session?.authUser) {
    return res.redirect(landingForUser(req.session.authUser));
  }
  res.render("auth/login", { title: "Login", CSS: "login.css", csrfToken: req.csrfToken(), brand: "sachiko" });
});

// Back-compat: old /login path now lives at /sachiko/login
app.get("/login", (req, res) => res.redirect("/app/login"));

app.get("/app/login", (req, res) => {
  if (req.session?.authUser) {
    return res.redirect(landingForUser(req.session.authUser));
  }
  res.render("auth/login", { title: "Login", CSS: "login.css", csrfToken: req.csrfToken(), brand: "sachiko" });
});

// Permissions for the dev-only backdoor accounts. These used to hand every
// flag to every role, which made the HR account render the SKU, purchase,
// stock and sales-order menus -- so the test logins no longer resembled the
// roles they stand in for. A DB employee brings their own permissions instead.
const DEV_PERMISSIONS_BY_ROLE = {
  proprietor: { sales: true, inventory: true, hr: true, accounting: true, master: true },
  admin: { sales: true, inventory: true, hr: true, accounting: true, master: true },
  hod: { sales: true, inventory: true, hr: false, accounting: false, master: true },
  sales: { sales: true, inventory: true, hr: false, accounting: false, master: true },
  hr: { sales: false, inventory: false, hr: true, accounting: true, master: false },
};

app.post("/app/login", loginLimiter, async (req, res) => {
  const { profileCode, username, password } = req.body;
  const loginCode = String(profileCode || username || "").trim();
  const brand = req.body.brand === "sachiko" ? "sachiko" : "fairdesk";
  const proprietorUser = process.env.PROPRIETOR_USER;
  const proprietorPass = process.env.PROPRIETOR_PASS;
  const adminUser = process.env.ADMIN_USER;
  const adminPass = process.env.ADMIN_PASS;
  const hrUser = process.env.HR_USER;
  const hrPass = process.env.HR_PASS;
  const hodUser = process.env.HOD_USER;
  const hodPass = process.env.HOD_PASS;
  const salesUser = process.env.SALES_USER;
  const salesPass = process.env.SALES_PASS;

  // Prevent hardcoded backdoor credentials in production
  if (process.env.NODE_ENV === "production") {
    const hasProprietorCreds = proprietorUser && proprietorPass;
    const hasAdminCreds = adminUser && adminPass;
    const hasHrCreds = hrUser && hrPass;
    const hasHodCreds = hodUser && hodPass;
    const hasSalesCreds = salesUser && salesPass;

    if (hasProprietorCreds || hasAdminCreds || hasHrCreds || hasHodCreds || hasSalesCreds) {
      console.error("❌ SECURITY ERROR: Hardcoded backdoor credentials detected in production environment!");
      console.error(
        "❌ Remove PROPRIETOR_USER, PROPRIETOR_PASS, ADMIN_USER, ADMIN_PASS, HR_USER, HR_PASS, HOD_USER, HOD_PASS, SALES_USER, SALES_PASS from .env",
      );
      process.exit(1);
    }
  }

  if (!loginCode || !password) {
    return res.status(400).render("auth/login", {
      title: "Login",
      CSS: "login.css",
      profileCode: loginCode,
      password,
      brand,
      error: ["Please enter your credentials."],
    });
  }

  // In production, skip backdoor checks (already validated they don't exist above)
  const envProprietorUser = proprietorUser?.trim();
  const envProprietorPass = proprietorPass?.trim();
  const envAdminUser = adminUser?.trim();
  const envAdminPass = adminPass?.trim();
  const envHrUser = hrUser?.trim();
  const envHrPass = hrPass?.trim();
  const envHodUser = hodUser?.trim();
  const envHodPass = hodPass?.trim();
  const envSalesUser = salesUser?.trim();
  const envSalesPass = salesPass?.trim();

  const isProprietor =
    process.env.NODE_ENV !== "production" &&
    envProprietorUser &&
    envProprietorPass &&
    loginCode === envProprietorUser &&
    password === envProprietorPass;
  const isAdmin =
    process.env.NODE_ENV !== "production" &&
    envAdminUser &&
    envAdminPass &&
    loginCode === envAdminUser &&
    password === envAdminPass;
  const isHr =
    process.env.NODE_ENV !== "production" &&
    envHrUser &&
    envHrPass &&
    loginCode === envHrUser &&
    password === envHrPass;
  const isHod =
    process.env.NODE_ENV !== "production" &&
    envHodUser &&
    envHodPass &&
    loginCode === envHodUser &&
    password === envHodPass;
  const isSales =
    process.env.NODE_ENV !== "production" &&
    envSalesUser &&
    envSalesPass &&
    loginCode === envSalesUser &&
    password === envSalesPass;

  const processLogin = async (authUser) => {
    req.session.authUser = authUser;
    return req.session.save((err) => {
      if (err) {
        console.error("Failed to persist session on login:", err);
        return res.status(500).render("auth/login", {
          title: "Login",
          CSS: "login.css",
          profileCode: loginCode,
          brand,
          error: ["Unable to start session. Please try again."],
        });
      }
      logAuthEvent(authUser, "LOGIN", req);
      return res.redirect(landingForUser(authUser));
    });
  };

  if (isProprietor || isAdmin || isHr || isHod || isSales) {
    const role = isProprietor ? "proprietor" : isAdmin ? "admin" : isHr ? "hr" : isHod ? "hod" : "sales";
    return processLogin({
      username: loginCode,
      role,
      permissions: DEV_PERMISSIONS_BY_ROLE[role],
      profileCode: loginCode,
      empName: loginCode,
    });
  }

  const trimmedUser = loginCode;
  const trimmedPass = String(password || "").trim();

  // Fallback to database check
  try {
    const employee = await Employee.findOne({
      empProfileCode: { $regex: new RegExp(`^${escapeRegex(trimmedUser)}$`, "i") },
      isActive: true,
    });

    if (employee && (await employee.comparePassword(trimmedPass))) {
      if (employee.role === "none") {
        return res.status(403).render("auth/login", {
          title: "Login",
          CSS: "login.css",
          profileCode: loginCode,
          brand,
          error: ["Your account is disabled. Please contact admin."],
        });
      }
      return processLogin({
        username: employee.empName,
        empName: employee.empName,
        profileCode: employee.empProfileCode,
        role: employee.role || "employee",
        permissions: employee.permissions,
        empId: employee.empId,
        // The employee document _id. This is the id anything "about me"
        // matches on -- tasks assigned to me, notifications addressed to me --
        // so it has to be in the session, not just the empId code. The
        // operator login carries the same field (utils/operatorAuth.js);
        // sessions that predate it are resolved from empId on first use by
        // utils/sessionUser.js, so nobody has to log in again.
        empObjId: String(employee._id),
        empPhoto: employee.empPhoto,
      });
    }
  } catch (err) {
    console.error("Login database error:", err);
  }

  return res.status(401).render("auth/login", {
    title: "Login",
    CSS: "login.css",
    profileCode: loginCode,
    password,
    brand,
    error: ["Invalid username or password."],
  });
});

/* OPERATOR PORTAL
   Shopfloor operators sign in with the three things they know -- their nick
   name, their location and their password -- and land on their own work queue:
   every order assigned to them, grouped by machine. Kept separate from the
   staff login so the terminal on the floor never shows the full portal. */
app.get("/app/operator/login", async (req, res) => {
  if (req.session?.authUser) {
    return res.redirect(landingForUser(req.session.authUser));
  }
  const locations = await Location.find({}).sort({ locationName: 1 }).lean();
  res.render("auth/operatorLogin", { title: "Operator Login", CSS: "login.css", locations });
});

// Nick name -> location lookup, so the login form can auto-select Location
// once the operator types their nick name. Rate-limited the same as the
// login POST itself, since this is otherwise an easy oracle for "does this
// nick name exist, and where" without a password.
app.get("/app/operator/login/lookup", loginLimiter, async (req, res) => {
  try {
    const operatorNick = String(req.query.nick || "").trim();
    if (!operatorNick) return res.json({ locations: [] });

    const nickCollapsed = operatorNick.replace(/\s+/g, " ");
    const nickPattern = `^\\s*${escapeRegex(nickCollapsed).replace(/ /g, "\\s+")}\\s*$`;
    const candidates = await Employee.find({
      empNickName: { $regex: new RegExp(nickPattern, "i") },
      isActive: true,
    }).select("empProfile empLoc");

    const locations = [
      ...new Set(
        candidates
          .filter((emp) => String(emp.empProfile || "").trim().toUpperCase() === "OPERATOR")
          .map((emp) => normalizeLocationName(emp.empLoc))
          .filter(Boolean),
      ),
    ];
    res.json({ locations });
  } catch (err) {
    console.error("Operator nick lookup error:", err);
    res.json({ locations: [] });
  }
});

app.post("/app/operator/login", loginLimiter, async (req, res) => {
  const operatorNick = String(req.body.operatorNick || "").trim();
  const locationName = normalizeLocationName(req.body.location);
  const password = String(req.body.password || "").trim();

  const fail = async (message, status = 401) => {
    const locations = await Location.find({}).sort({ locationName: 1 }).lean();
    return res.status(status).render("auth/operatorLogin", {
      title: "Operator Login",
      CSS: "login.css",
      locations,
      operatorNick,
      selectedLocation: locationName,
      error: [message],
    });
  };

  try {
    // Matching logic lives in utils/operatorAuth.js so the EJS portal here and
    // the JSON operator API (POST /sachiko/api/operator/login) never drift
    // apart -- see that file for the nick-name/location/password matching
    // details this used to inline.
    const result = await authenticateOperator({ operatorNick, location: req.body.location, password });
    if (result.error) {
      return fail(result.error, result.status || 401);
    }

    const { authUser } = result;
    req.session.authUser = authUser;
    return req.session.save((err) => {
      if (err) {
        console.error("Failed to persist session on operator login:", err);
        return fail("Unable to start session. Please try again.", 500);
      }
      logAuthEvent(authUser, "LOGIN", req);
      return res.redirect(landingForUser(authUser));
    });
  } catch (err) {
    console.error("Operator login error:", err);
    return fail("Something went wrong. Please try again.", 500);
  }
});

app.get("/logout", (req, res) => {
  const authUser = req.session?.authUser;
  if (authUser) logAuthEvent(authUser, "LOGOUT", req);
  // Send operators back to their own portal, not the staff login they have no
  // account for. A shopfloor terminal is often left sitting until the session
  // has already expired, and by then the role is gone -- so fall back to the
  // page the Logout link was clicked from.
  const fromOperatorPortal = String(req.get("referer") || "").includes("/app/operator");
  const isOperator = authUser ? authUser.role === "operator" : fromOperatorPortal;
  const loginUrl = isOperator ? "/app/operator/login" : "/app/login";
  req.session.destroy(() => {
    res.clearCookie(SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS);
    res.redirect(loginUrl);
  });
});
app.use("/app/payroll", requireAuth, requireRole(["proprietor", "admin", "hr"]), payrollRoute);

/* PROFILE / ACCOUNT SECURITY - Accessible to all roles */
app.post("/app/profile/password", requireAuth, async (req, res) => {
  try {
    const { oldPassword, newPassword, confirmPassword } = req.body;
    const authUser = req.session.authUser;

    if (!authUser || !authUser.empId) {
      return res.status(403).json({
        success: false,
        message: "System accounts (managed via configuration) cannot change password via profile modal.",
      });
    }

    const employee = await Employee.findOne({ empId: authUser.empId });
    if (!employee) {
      return res.status(404).json({ success: false, message: "Employee record not found." });
    }

    const isMatch = await employee.comparePassword(String(oldPassword || "").trim());
    if (!isMatch) {
      return res.status(400).json({ success: false, message: "Current password is incorrect." });
    }

    if (confirmPassword !== undefined && newPassword !== confirmPassword) {
      return res.status(400).json({ success: false, message: "New password and confirmation do not match." });
    }

    employee.password = newPassword;
    await employee.save();

    res.json({ success: true, message: "Password updated successfully!" });
  } catch (err) {
    console.error("PASSWORD CHANGE ERROR:", err);
    res.status(500).json({ success: false, message: "Server error during password update." });
  }
});

app.use("/app/loan", requireAuth, requireRole(["proprietor", "admin", "hr"]), loanRoute);
app.use("/app/advance", requireAuth, requireRole(["proprietor", "admin", "hr"]), advanceRoute);
app.use("/app/employee", requireAuth, requireRole(["proprietor", "admin", "hr", "sales"]), employeeRoute);
app.use("/app/pettycash", requireAuth, requireRole(["proprietor", "admin", "hr", "sales"]), pettycashRoute);

app.use(
  "/app/client",
  requireAuth,
  requireRole(["proprietor", "admin", "hod", "sales", "master"]),
  clientFormRoute,
);

// The header bell's own API. Bare-mounted with no role gate and ahead of
// everything else for the same reason as machineRoutes below: the bell sits in
// the layout of every page, so every role -- operators included -- must be
// able to read its own count without a role check turning the request away.
app.use("/app", requireAuth, notificationRoutes);

// Mounted ahead of the other /sachiko routers, with no requireRole, so
// operators reach their machine queue before fairdeskRoute's requireRole
// turns them away. Because a path-prefixed app.use runs its middleware for
// EVERY /sachiko/* request -- not just the paths this router handles --
// there must be no requireRole here: it would 403 sales/hr/hod on their own
// pages before the request ever fell through. The roles are enforced per
// route inside the router instead.
app.use("/app", requireAuth, machineRoutes);
// The slitting step that follows lamination -- Deckles (Semi Finished Goods)
// cut into finished rolls. Bare-mounted for the same reason as machineRoutes
// above: it is shopfloor work, so operators must reach it before
// fairdeskRoute's requireRole below turns them away. Roles are enforced per
// route inside the router.
app.use("/app", requireAuth, slittingRoutes);
// Shopfloor maintenance tickets: raised by operators, actioned by management.
// Also bare-mounted with no role gate -- operators need to reach
// /sachiko/operator/maintenance before fairdeskRoute's requireRole below
// would turn them away.
app.use("/app", requireAuth, maintenanceRoutes);
app.use("/app", requireAuth, facestockMasterRoutes);
app.use("/app", requireAuth, familyMasterRoutes);
app.use("/app", requireAuth, companyRoutes);
app.use("/app", requireAuth, typeMasterRoutes);
app.use("/app", requireAuth, coreMasterRoutes);
app.use("/app", requireAuth, boardPaperMasterRoutes);
app.use("/app", requireAuth, adhesiveMasterRoutes);
app.use("/app", requireAuth, releaseMasterRoutes);

app.use("/app", requireAuth, requireRole(["proprietor", "admin", "hod", "sales", "hr"]), fairdeskRoute);
app.use("/app/stocks", requireAuth, requireRole(["proprietor", "admin", "hod", "sales"]), stockViewRoutes);
app.use("/app/facestockstock", requireAuth, requireRole(["proprietor", "admin", "hod", "sales"]), facestockStockRoutes);
app.use("/app/stock/wip", requireAuth, requireRole(["proprietor", "admin", "hod", "sales"]), wipStockRoutes);
app.use("/app/adhesivestock", requireAuth, requireRole(["proprietor", "admin", "hod", "sales"]), adhesiveStockRoutes);
app.use("/app/releaselinerstock", requireAuth, requireRole(["proprietor", "admin", "hod", "sales"]), releaseLinerStockRoutes);
app.use("/app/corestock", requireAuth, requireRole(["proprietor", "admin", "hod", "sales"]), coreStockRoutes);
app.use("/app/semifinishedstock", requireAuth, requireRole(["proprietor", "admin", "hod", "sales"]), semiFinishedStockRoutes);
app.use("/app/finishedstock", requireAuth, requireRole(["proprietor", "admin", "hod", "sales"]), finishedStockRoutes);
app.use("/app/labelstockproduction", requireAuth, requireRole(["proprietor", "admin", "hod", "sales"]), labelStockProductionRoutes);
app.use("/app/inventory", requireAuth, requireRole(["proprietor", "admin", "hod", "sales"]), reorderRoutes);
app.use("/app", requireAuth, requireRole(["proprietor", "admin", "hod"]), sachikoRoute);
app.use("/app", requireAuth, requireRole(["proprietor", "admin", "hod", "sales"]), labelStockBindingRoutes);
app.use("/app", requireAuth, requireRole(["proprietor", "admin", "hod"]), labelStockAdhesiveBindingRoutes);

/* 404 */
app.all("*", (req, res) => {
  if (req.xhr || req.headers.accept?.includes("application/json")) {
    return res.status(404).json({ error: "Not found" });
  }
  const homeUrl = landingForUser(req.session?.authUser);
  const homeLabel = req.session?.authUser ? "Back to Dashboard" : "Go to Login";
  res.status(404).render("errors/notFound", { title: "Page Not Found", CSS: false, JS: false, homeUrl, homeLabel });
});

/* ERROR HANDLER */
app.use((err, req, res, next) => {
  if (err.code === "EBADCSRFTOKEN") {
    console.warn(`[CSRF] Invalid token on ${req.method} ${req.originalUrl} from ${req.ip}`);
    if (req.xhr || req.headers.accept?.includes("json")) {
      return res.status(403).json({ success: false, message: "Your session ended. Please sign in again." });
    }
    return res.redirect("/app/login?reason=session-ended");
  }
  console.error("[Error Handler]", err);
  const status = err.statusCode || 500;
  const message = status === 500 && process.env.NODE_ENV === "production" ? "Something went wrong" : err.message;
  res.status(status).send(message);
});

/* Get dynamic IP address */
const networkInterfaces = os.networkInterfaces();
const ip =
  Object.values(networkInterfaces)
    .flat()
    .find((info) => info.family === "IPv4" && !info.internal)?.address || "localhost";

app.listen(port, "0.0.0.0", () => {
  console.log(`Server running on http://${ip}:${port}`);
  // Due-soon / overdue task reminders for the header bell. Idempotent by the
  // day (utils/taskReminders.js), so a restart mid-day re-sends nothing.
  startTaskReminderJob();
});
