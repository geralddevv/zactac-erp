// MUST be the first import: models/miscellaneous/task_model.js opens the tasks
// database connection at IMPORT time, and ES modules run every static import
// before this file's body. See the comment in config/loadEnv.js.
import "../config/loadEnv.js";
import mongoose from "mongoose";
import connectDB from "../config/db.js";
import Task from "../models/miscellaneous/task_model.js";
import Notification from "../models/system/notification.js";
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ---------------------------------------------------------------------------
// One-shot deployment of the task-assignment + notification-bell release.
//
// Runs the whole runbook in order, refuses to continue when a step fails, and
// is safe to run again -- every step checks the current state first, so a
// second run reports "already done" rather than doing it twice.
//
// DRY RUN BY DEFAULT (like every other script here): it inspects everything,
// prints exactly what it would change, and writes nothing. Pass --apply to
// commit.
//
//   node scripts/deploy-task-notifications.js                    # inspect
//   node scripts/deploy-task-notifications.js --apply            # do it
//
// Options:
//   --apply                 actually make changes
//   --skip-backup           don't run mongodump (NOT advised; prints a warning)
//   --skip-pull             leave git and npm alone (deploying by other means)
//   --restart "<cmd>"       command that restarts the app, run through the
//                           shell: "pm2 restart sachiko",
//                           "sudo systemctl restart sachiko",
//                           "nssm restart Sachiko" (Windows service), ...
//                           Omitted: pm2 is auto-detected; if that fails the
//                           restart is left to you and the script says so.
//   --backup-dir <path>     where mongodump writes (default ./backups/<date>)
//   --url <base>            base URL for the post-restart health check
//                           (default http://127.0.0.1:<PORT from .env>)
//
// What it does NOT do, because it cannot:
//   - set the server timezone (it only warns; that belongs to your service
//     manager or the OS)
//   - log in as two real employees and click the bell. The last section
//     prints that checklist for you.
//
// RUN FROM THE PROJECT ROOT -- .env, git and npm are all resolved from the
// working directory.
// ---------------------------------------------------------------------------

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag, fallback = "") => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};

/* Windows needs care here. git.exe, node.exe and mongodump.exe are real
   executables and spawn directly, but npm and pm2 are .cmd wrappers -- and
   Node refuses to execute a .cmd without a shell. Spawning them bare reports
   "not on PATH" for tools that work perfectly from the command line. */
const IS_WIN = process.platform === "win32";

const APPLY = has("--apply");
const SKIP_BACKUP = has("--skip-backup");
const SKIP_PULL = has("--skip-pull");
const RESTART_CMD = valueOf("--restart");
const BACKUP_DIR = valueOf("--backup-dir", path.join(ROOT, "backups", new Date().toISOString().slice(0, 10)));

/* ─── output ─────────────────────────────────────────────────────────────── */

const C = { red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", blue: "\x1b[36m", dim: "\x1b[2m", bold: "\x1b[1m", off: "\x1b[0m" };
const notes = [];
const warnings = [];
// Facts one step establishes and a later one needs.
const state = { hasNpm: false };

const say = (msg = "") => console.log(msg);
const ok = (msg) => say(`  ${C.green}✓${C.off} ${msg}`);
const info = (msg) => say(`  ${C.blue}·${C.off} ${msg}`);
const would = (msg) => say(`  ${C.yellow}→${C.off} would ${msg}`);
const warn = (msg) => { warnings.push(msg); say(`  ${C.yellow}!${C.off} ${msg}`); };
const fail = (msg) => say(`  ${C.red}✗${C.off} ${msg}`);
const heading = (n, title) => say(`\n${C.bold}${n}. ${title}${C.off}`);

// Credentials live in these URIs -- never print one raw.
const redact = (uri) => String(uri || "").replace(/\/\/[^@/]*@/, "//***:***@");

class StepFailed extends Error {}
const abort = (msg) => { throw new StepFailed(msg); };

function run(cmd, args, { cwd = ROOT, quiet = false, shell = false } = {}) {
  const res = spawnSync(cmd, args, { cwd, encoding: "utf8", shell });
  if (!quiet && res.stdout?.trim()) say(res.stdout.trim().split("\n").map((l) => `    ${C.dim}${l}${C.off}`).join("\n"));
  if (res.error) return { ok: false, out: "", err: String(res.error.message) };
  const err = (res.stderr || "").trim();
  if (!quiet && err && res.status !== 0) say(err.split("\n").map((l) => `    ${C.dim}${l}${C.off}`).join("\n"));
  return { ok: res.status === 0, out: (res.stdout || "").trim(), err, status: res.status };
}

// PATH lookup twice over: directly, then through a shell. On Windows npm and
// pm2 are .cmd wrappers that a bare spawn cannot run at all; elsewhere a
// version manager's shim (nvm, asdf, volta) can be equally invisible. Either
// way, reporting "not installed" for a tool the operator clearly has is worse
// than useless, so ask the shell as well -- `where` on Windows, `command -v`
// on everything else.
function tool(name) {
  if (spawnSync(name, ["--version"], { encoding: "utf8" }).status === 0) return true;
  const probe = IS_WIN ? `where ${name}` : `command -v ${name}`;
  return spawnSync(`${probe} >${IS_WIN ? "NUL" : "/dev/null"} 2>&1`, { shell: true }).status === 0;
}

/* ─── 1. preflight ───────────────────────────────────────────────────────── */

async function preflight() {
  heading(1, "Preflight");

  const major = Number(process.versions.node.split(".")[0]);
  if (major < 18) abort(`Node ${process.versions.node} is too old; this release needs 18+.`);
  ok(`Node ${process.versions.node}`);

  // The app itself exits without these, so there is no point going further.
  for (const key of ["PORT", "SESSION_SECRET", "MONGO_URI"]) {
    if (!String(process.env[key] || "").trim()) abort(`${key} is missing from .env — the app will not start without it.`);
  }
  ok(`.env carries PORT, SESSION_SECRET and MONGO_URI (${redact(process.env.MONGO_URI)})`);

  // In production the app refuses to boot while any backdoor login is set, so
  // catch it here rather than after a restart has taken the site down.
  if (process.env.NODE_ENV === "production") {
    const backdoors = ["PROPRIETOR_USER", "PROPRIETOR_PASS", "ADMIN_USER", "ADMIN_PASS", "HR_USER", "HR_PASS", "HOD_USER", "HOD_PASS", "SALES_USER", "SALES_PASS"]
      .filter((k) => String(process.env[k] || "").trim());
    if (backdoors.length) {
      abort(`NODE_ENV=production with backdoor logins still set (${backdoors.join(", ")}). The app exits on boot in this state — remove them from .env first.`);
    }
    ok("production mode, no backdoor logins set");
  } else {
    warn(`NODE_ENV is "${process.env.NODE_ENV || "unset"}", not "production". Fine for a staging box; on the live server set it.`);
  }

  // The reminder job and every due-date comparison use the server's LOCAL
  // calendar day, so the box's zone decides when "due tomorrow" flips.
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown";
  if (/^(UTC|Etc\/UTC|GMT)$/i.test(tz)) {
    warn(`server timezone is ${tz}. Due dates and the once-a-day reminder dedupe follow LOCAL days, so set TZ (e.g. TZ=Asia/Kolkata) in whatever starts the app.`);
  } else {
    ok(`timezone ${tz} (local day = ${new Date().toLocaleDateString("en-GB")})`);
  }

  // git and mongodump are load-bearing: without them the pull or the backup
  // cannot happen at all, so stop and say which flag skips that step.
  for (const [name, needed, flag] of [["git", !SKIP_PULL, "--skip-pull"], ["mongodump", !SKIP_BACKUP, "--skip-backup"]]) {
    if (!needed) continue;
    if (!tool(name)) {
      abort(`${name} is not on PATH. Install it, or re-run with ${flag}.${
        name === "mongodump" && IS_WIN
          ? ' On Windows the database tools ship separately from the server -- look in "C:\\Program Files\\MongoDB\\Tools\\<version>\\bin", or install the MongoDB Database Tools.'
          : ""}`);
    }
    ok(`${name} present`);
  }

  // npm is NOT load-bearing for this release: it added no dependencies, so the
  // install is belt-and-braces. Missing npm therefore downgrades that one step
  // rather than stopping the deploy.
  state.hasNpm = SKIP_PULL ? false : tool("npm");
  if (!SKIP_PULL) {
    if (state.hasNpm) ok("npm present");
    else warn("npm is not on PATH, so the dependency install will be skipped. This release adds no new packages, so that is safe -- but if you ever deploy one that does, run your own install first.");
  }

  await connectDB();
  await mongoose.connection.asPromise();
  await Task.db.asPromise();
  ok(`databases reachable: ${mongoose.connection.name} (main) and ${Task.db.name} (tasks)`);
  if (Task.db.name === "app_tasks" && !String(process.env.TASKS_MONGO_URI || "").trim()) {
    warn(`the tasks database resolved to "app_tasks", the fallback name. That usually means MONGO_URI was not loaded in time — check this is really the database your tasks live in.`);
  }
}

/* ─── 2. backup ──────────────────────────────────────────────────────────── */

// Mirrors deriveTasksUri() in config/tasksDb.js: same host, "<db>_tasks".
function tasksUriFor(mainUri, tasksDbName) {
  const explicit = String(process.env.TASKS_MONGO_URI || "").trim();
  if (explicit) return explicit;
  const sep = mainUri.indexOf("//");
  if (sep === -1) return mainUri;
  const prefix = mainUri.slice(0, sep + 2);
  const rest = mainUri.slice(sep + 2);
  const slash = rest.indexOf("/");
  if (slash === -1) return `${prefix}${rest}/${tasksDbName}`;
  const host = rest.slice(0, slash);
  const after = rest.slice(slash + 1);
  const q = after.indexOf("?");
  return `${prefix}${host}/${tasksDbName}${q === -1 ? "" : after.slice(q)}`;
}

function backup() {
  heading(2, "Back up both databases");
  if (SKIP_BACKUP) {
    warn("--skip-backup: no dump taken. If a later step goes wrong there is nothing to restore from.");
    return;
  }

  const mainUri = process.env.MONGO_URI;
  const tasksUri = tasksUriFor(mainUri, Task.db.name);
  info(`main  -> ${redact(mainUri)}`);
  info(`tasks -> ${redact(tasksUri)}`);

  if (!APPLY) {
    would(`run mongodump for both databases into ${BACKUP_DIR}`);
    return;
  }

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  for (const [label, uri] of [["main", mainUri], ["tasks", tasksUri]]) {
    const res = run("mongodump", [`--uri=${uri}`, `--out=${BACKUP_DIR}`], { quiet: true });
    if (!res.ok) abort(`mongodump failed for the ${label} database: ${res.err || `exit ${res.status}`}`);
    ok(`${label} database dumped`);
  }
  ok(`backup written to ${BACKUP_DIR}`);
  notes.push(`Backup: ${BACKUP_DIR} (restore with: mongorestore --drop --uri=<uri> ${BACKUP_DIR}/<dbname>)`);
}

/* ─── 3. code ────────────────────────────────────────────────────────────── */

function pullAndInstall() {
  heading(3, "Update the code");
  if (SKIP_PULL) { info("--skip-pull: leaving git and npm alone."); return; }

  const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { quiet: true }).out || "main";
  const dirty = run("git", ["status", "--porcelain"], { quiet: true }).out;
  if (dirty) {
    abort(`the working tree has uncommitted changes:\n${dirty.split("\n").map((l) => `      ${l}`).join("\n")}\n    A pull would clobber them. Commit, stash or drop them, or re-run with --skip-pull.`);
  }
  ok(`on branch ${branch}, working tree clean`);

  if (!APPLY) {
    const fetched = run("git", ["fetch", "--dry-run", "origin", branch], { quiet: true });
    would(`git pull --ff-only origin ${branch}${fetched.err ? ` (remote has: ${fetched.err.split("\n").slice(-1)[0].trim()})` : ""}`);
    if (state.hasNpm) would(fs.existsSync(path.join(ROOT, "package-lock.json")) ? "npm ci" : "npm install");
    else info("dependency install skipped (no npm; this release needs none)");
    return;
  }

  const pull = run("git", ["pull", "--ff-only", "origin", branch]);
  if (!pull.ok) abort(`git pull failed (${pull.err || `exit ${pull.status}`}). Resolve it by hand — a deploy should never merge on its own.`);
  ok(`pulled origin/${branch}`);

  if (!state.hasNpm) {
    info("dependency install skipped (no npm; this release needs none)");
    return;
  }
  // No new dependencies came with this release, but a lockfile install keeps
  // the server honest if anything else moved. Through a shell on Windows,
  // where npm is npm.cmd.
  const useCi = fs.existsSync(path.join(ROOT, "package-lock.json"));
  const install = run("npm", useCi ? ["ci"] : ["install"], { quiet: true, shell: IS_WIN });
  if (!install.ok) abort(`${useCi ? "npm ci" : "npm install"} failed: ${install.err || `exit ${install.status}`}`);
  ok(useCi ? "npm ci" : "npm install");
}

/* ─── 4. the index that breaks the bell ──────────────────────────────────── */

const DEDUPE_INDEX = "userId_1_dedupeKey_1";
const WANTED_PARTIAL = { dedupeKey: { $type: "string" } };

async function fixDedupeIndex() {
  heading(4, "Repair the notification dedupe index");
  say(`  ${C.dim}A compound SPARSE unique index still indexes a document when any key${C.off}`);
  say(`  ${C.dim}exists -- and userId always does -- so every person's SECOND notification${C.off}`);
  say(`  ${C.dim}onward is silently rejected. Mongoose never drops a changed index, so a${C.off}`);
  say(`  ${C.dim}build that once ran the sparse version keeps it forever.${C.off}`);

  const coll = Notification.collection;
  const exists = (await mongoose.connection.db.listCollections({ name: coll.collectionName }).toArray()).length > 0;
  if (!exists) {
    info("no notifications collection yet — the app will create it with the right indexes on first use.");
    if (APPLY) {
      await coll.createIndex({ userId: 1, dedupeKey: 1 }, { unique: true, partialFilterExpression: WANTED_PARTIAL, name: DEDUPE_INDEX });
      ok("created the collection with the correct partial unique index");
    } else {
      would("create the correct partial unique index up front");
    }
    return;
  }

  const indexes = await coll.indexes();
  const current = indexes.find((i) => i.name === DEDUPE_INDEX);
  const isCorrect = current && !current.sparse && JSON.stringify(current.partialFilterExpression || null) === JSON.stringify(WANTED_PARTIAL);

  if (isCorrect) { ok("already the partial unique index — nothing to do"); return; }

  if (current) {
    fail(`found the WRONG index: ${JSON.stringify({ key: current.key, unique: current.unique, sparse: current.sparse, partialFilterExpression: current.partialFilterExpression })}`);
    if (!APPLY) { would(`drop ${DEDUPE_INDEX} and recreate it as partial`); return; }
    await coll.dropIndex(DEDUPE_INDEX);
    ok(`dropped the stale ${DEDUPE_INDEX}`);
  } else if (!APPLY) {
    would(`create ${DEDUPE_INDEX} as a partial unique index`);
    return;
  }

  try {
    await coll.createIndex({ userId: 1, dedupeKey: 1 }, { unique: true, partialFilterExpression: WANTED_PARTIAL, name: DEDUPE_INDEX });
    ok("created the partial unique index");
  } catch (err) {
    abort(`could not create ${DEDUPE_INDEX}: ${err.message}. If this is a duplicate-key error, two reminder rows share a dedupeKey — remove one and re-run.`);
  }
}

/* ─── 5. restart ─────────────────────────────────────────────────────────── */

// Windows paths differ in case and slashes between what pm2 stored and what
// path.resolve() produces here, so compare them normalised.
const samePath = (a, b) => {
  const norm = (p) => path.resolve(String(p || "")).replace(/\\/g, "/").replace(/\/+$/, "");
  return IS_WIN ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
};

function pm2Targets() {
  if (!tool("pm2")) return [];
  // shell on Windows: pm2 is pm2.cmd and will not spawn bare.
  const res = spawnSync("pm2", ["jlist"], { encoding: "utf8", shell: IS_WIN });
  if (res.status !== 0) return [];
  try {
    // pm2 prints logger noise before the JSON on some versions.
    const json = res.stdout.slice(res.stdout.indexOf("["));
    return JSON.parse(json)
      .filter((p) => {
        const script = p?.pm2_env?.pm_exec_path || "";
        const cwd = p?.pm2_env?.pm_cwd || "";
        return /server\.js$/i.test(script) && (samePath(cwd, ROOT) || samePath(path.dirname(script), ROOT));
      })
      .map((p) => p.name);
  } catch { return []; }
}

function restart() {
  heading(5, "Restart the app");

  if (RESTART_CMD) {
    if (!APPLY) { would(`run: ${RESTART_CMD}`); return true; }
    // Handed to the shell whole, not split on spaces: it is a command line the
    // operator wrote, so it may be "pm2 restart sachiko", "nssm restart
    // Sachiko", "net stop … && net start …" or a quoted path.
    const res = run(RESTART_CMD, [], { shell: true });
    if (!res.ok) abort(`restart command failed: ${RESTART_CMD}${res.err ? ` — ${res.err}` : ""}`);
    ok(`ran: ${RESTART_CMD}`);
    return true;
  }

  const targets = pm2Targets();
  if (!targets.length) {
    warn(`could not work out how this app is run (no --restart given, no pm2 process for this directory). RESTART IT YOURSELF before the checks below mean anything, or re-run with --restart "<command>" — ${
      IS_WIN
        ? 'on Windows that is usually "pm2 restart sachiko", "nssm restart Sachiko", or "net stop Sachiko && net start Sachiko" for a service'
        : 'e.g. "pm2 restart sachiko" or "sudo systemctl restart sachiko"'}.`);
    notes.push("Restart was NOT automated — do it by hand, then re-run this script to verify.");
    return false;
  }
  if (!APPLY) { would(`pm2 restart ${targets.join(" ")} --update-env`); return true; }
  for (const name of targets) {
    const res = run("pm2", ["restart", name, "--update-env"], { quiet: true, shell: IS_WIN });
    if (!res.ok) abort(`pm2 restart ${name} failed`);
    ok(`pm2 restart ${name}`);
  }
  return true;
}

/* ─── 6. health ──────────────────────────────────────────────────────────── */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function health(restarted) {
  heading(6, "Check the app answers");
  const base = valueOf("--url", `http://127.0.0.1:${process.env.PORT}`);

  if (!APPLY && !restarted) { would(`poll ${base} until it answers, then check the bell API is mounted`); return; }

  let up = false;
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch(`${base}/app/login`, { redirect: "follow" });
      if (res.status < 500) { up = true; break; }
    } catch { /* not listening yet */ }
    await sleep(1500);
  }
  if (!up) abort(`nothing answered on ${base} after 30s. Check the app's own log.`);
  ok(`${base} is serving`);

  // Unauthenticated, the bell API must answer 401 JSON. That proves the new
  // router is mounted AND that it is behind requireAuth.
  try {
    const res = await fetch(`${base}/app/notifications/count`, { headers: { Accept: "application/json" }, redirect: "manual" });
    if (res.status === 401) ok("bell API mounted and refusing anonymous callers (401)");
    else if (res.status === 404) abort("GET /app/notifications/count returned 404 — the notifications router is not mounted. Is the new code really deployed?");
    else warn(`GET /app/notifications/count answered ${res.status}; expected 401 when not logged in.`);
  } catch (err) {
    warn(`could not probe the bell API: ${err.message}`);
  }
}

/* ─── 7. backfill ────────────────────────────────────────────────────────── */

function backfill() {
  heading(7, "Backfill existing tasks");
  const args = ["scripts/backfill-task-assignee.js", ...(APPLY ? ["--apply"] : [])];
  info(`node ${args.join(" ")}`);
  const res = run("node", args);
  if (!res.ok) abort("the backfill script failed — see its output above.");
  ok(APPLY ? "backfill applied" : "backfill dry run complete (no writes)");
}

/* ─── 8. what only a human can do ────────────────────────────────────────── */

function checklist() {
  heading(8, "Smoke test by hand (5 minutes, two real logins)");
  [
    "Log in as A, assign a task to B           -> B's bell shows 1 within 60s",
    "B opens the bell row                      -> lands on the task, badge clears",
    "Check A's own bell                         -> nothing (no self-notification)",
    "Log in as C (neither party)                -> the task is nowhere on their page",
    "B's row has no Mark Complete               -> it reads \"<A> closes\"",
    "A marks it done                            -> B is told \"marked your task Completed\"",
    "Log in as an admin who is neither party    -> the task must NOT be visible",
    "Open /audit/view as that admin             -> shows \"Created and assigned a task (<id>)\", never the title",
  ].forEach((line) => say(`  ${C.blue}·${C.off} ${line}`));
  say(`\n  ${C.dim}Then watch the app log for a few minutes: the reminder job runs 60s after${C.off}`);
  say(`  ${C.dim}boot and every 15 min, and is silent unless it prints TASK REMINDER JOB ERROR.${C.off}`);
}

/* ─── run ────────────────────────────────────────────────────────────────── */

async function main() {
  say(`${C.bold}Task assignment + notification bell — deployment${C.off}`);
  say(APPLY
    ? `${C.yellow}APPLY mode: this will back up, pull, install, change indexes, restart and migrate.${C.off}`
    : `${C.green}DRY RUN: nothing will be changed. Re-run with --apply to commit.${C.off}`);
  say(`${C.dim}root: ${ROOT}${C.off}`);

  await preflight();
  backup();
  pullAndInstall();
  await fixDedupeIndex();
  const restarted = restart();
  await health(restarted);
  backfill();
  checklist();

  heading(9, "Summary");
  if (!APPLY) {
    say(`  ${C.green}Dry run finished — nothing was changed.${C.off}`);
    say(`  Re-run with ${C.bold}--apply${C.off} to carry out the steps above.`);
  } else {
    say(`  ${C.green}Deployed.${C.off}`);
  }
  for (const n of notes) say(`  ${C.blue}·${C.off} ${n}`);
  if (warnings.length) {
    say(`\n  ${C.yellow}${warnings.length} warning(s) to deal with:${C.off}`);
    warnings.forEach((w) => say(`  ${C.yellow}!${C.off} ${w}`));
  }
  say("");
}

main()
  .then(async () => { await mongoose.disconnect().catch(() => {}); await Task.db.close().catch(() => {}); process.exit(0); })
  .catch(async (err) => {
    if (err instanceof StepFailed) {
      say(`\n  ${C.red}✗ ${err.message}${C.off}`);
      say(`\n  ${C.red}${C.bold}Stopped.${C.off} Nothing after this step ran${APPLY ? " — fix the above and run again; completed steps are safe to repeat." : "."}`);
    } else {
      say(`\n  ${C.red}✗ unexpected failure:${C.off}`);
      console.error(err);
    }
    await mongoose.disconnect().catch(() => {});
    await Task.db.close().catch(() => {});
    process.exit(1);
  });
