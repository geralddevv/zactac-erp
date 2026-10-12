import AuditLog from "../models/system/auditLog.js";

/*
 * Records who did what: every mutating request (POST/PUT/PATCH/DELETE) made
 * by a logged-in user gets one AuditLog entry, written fire-and-forget on
 * res.on("finish") so it never adds latency to the actual response and a
 * logging failure can never break the real request.
 *
 * Deliberately does NOT log GET requests (page views) — at this app's route
 * count that would be extremely high volume for very little audit value.
 * LOGIN/LOGOUT are logged explicitly at their own call sites in server.js
 * instead of here, since req.session.authUser isn't in a meaningful state
 * around those requests.
 *
 * Description (the human-readable "what happened") is resolved in three
 * tiers, richest first:
 *   1. res.locals.auditDescription — set by the route handler itself, which
 *      has full context (e.g. `Created client "NAYASA SUPERPLAST"`, or for
 *      deletes, the entity's name looked up *before* it was removed).
 *   2. A generic guess from a small allowlist of common identifying body
 *      fields (clientName, productId, poNumber, ...) — covers routes that
 *      haven't been individually instrumented yet.
 *   3. Bare "<ACTION> <path>" — last-resort fallback.
 * Only the allowlisted fields below are ever read from req.body; nothing
 * else (so passwords/tokens/free-text fields never end up in the log).
 */

const AUDITED_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SKIP_PATHS = new Set(["/app/login", "/logout"]);

// Marking a notification read is a UI gesture, not an action on company data
// -- every bell click would otherwise file an audit entry. The notification
// itself records what happened; who glanced at it is not worth keeping.
const SKIP_PREFIXES = ["/app/notifications/"];

const ACTION_BY_METHOD = {
  POST: "CREATE",
  PUT: "UPDATE",
  PATCH: "UPDATE",
  DELETE: "DELETE",
};

const VERB_BY_ACTION = {
  CREATE: "Created",
  UPDATE: "Updated",
  DELETE: "Deleted",
};

const GENERIC_NAME_FIELDS = [
  "clientName",
  "userName",
  "vendorName",
  "empName",
  "machineName",
  "jobName",
  "poNumber",
  "blockNo",
  "dieDieNo",
  "locationName",
  "companyName",
  "tapeClientPaperCode",
  "ttrClientMaterialCode",
  "vendorTapePaperCode",
  "vendorTtrMaterialCode",
];

// Replace ObjectId-looking path segments with :id so similar routes group together.
function normalizePath(path) {
  return String(path || "")
    .split("/")
    .map((seg) => (/^[0-9a-fA-F]{24}$/.test(seg) ? ":id" : seg))
    .join("/");
}

function guessDescription(req, action, path) {
  const verb = VERB_BY_ACTION[action] || action;
  for (const field of GENERIC_NAME_FIELDS) {
    const val = req.body?.[field];
    if (typeof val === "string" && val.trim()) {
      return `${verb} "${val.trim()}"`;
    }
  }
  return `${verb} ${path}`;
}

export function auditLogger(req, res, next) {
  res.on("finish", () => {
    try {
      const authUser = req.session?.authUser;
      if (!authUser) return;
      if (!AUDITED_METHODS.has(req.method)) return;
      if (SKIP_PATHS.has(req.path)) return;
      if (SKIP_PREFIXES.some((prefix) => req.path.startsWith(prefix))) return;

      const action = ACTION_BY_METHOD[req.method] || req.method;
      const path = normalizePath(req.originalUrl?.split("?")[0] || req.path);
      const description = res.locals.auditDescription || guessDescription(req, action, path);

      AuditLog.create({
        username: authUser.username,
        empName: authUser.empName,
        profileCode: authUser.profileCode,
        role: authUser.role,
        action,
        method: req.method,
        path,
        description,
        statusCode: res.statusCode,
        ip: req.ip,
      }).catch((err) => console.error("Audit log write failed:", err));
    } catch (err) {
      console.error("Audit log middleware error:", err);
    }
  });
  next();
}

// The device-reported position on the wire is untrusted input off a login
// request body, so nothing goes into the log that hasn't been coerced to a
// finite number in range (or, on the failure side, matched against the three
// reasons the app is allowed to give). Anything else is dropped rather than
// stored, and a login with no usable geo simply has none.
const GEO_ERRORS = new Set(["denied", "timeout", "unavailable"]);

function sanitizeGeo(geo) {
  if (!geo || typeof geo !== "object") return undefined;

  const lat = Number(geo.latitude);
  const lng = Number(geo.longitude);
  if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
    const accuracy = Number(geo.accuracy);
    return {
      lat,
      lng,
      accuracy: Number.isFinite(accuracy) && accuracy >= 0 ? accuracy : undefined,
    };
  }

  return GEO_ERRORS.has(geo.error) ? { error: geo.error } : undefined;
}

// `via` names the client the event came from, for the sessions the auditLogger
// middleware above can never see: it keys off req.session.authUser, and the
// mobile operator app is bearer-authenticated (req.authUser), so nothing it
// does passes through that middleware. Omitted for the web portal so its
// existing entries read exactly as before.
export async function logAuthEvent(authUser, action, req, { via, geo } = {}) {
  const who = authUser?.empName || authUser?.username;
  const suffix = via ? ` (${via})` : "";
  try {
    await AuditLog.create({
      username: authUser?.username,
      empName: authUser?.empName,
      profileCode: authUser?.profileCode,
      role: authUser?.role,
      action,
      method: req.method,
      path: req.path,
      description: action === "LOGIN" ? `Logged in as "${who}"${suffix}` : `Logged out "${who}"${suffix}`,
      statusCode: 200,
      ip: req.ip,
      geo: sanitizeGeo(geo),
    });
  } catch (err) {
    console.error("Audit log auth-event write failed:", err);
  }
}
