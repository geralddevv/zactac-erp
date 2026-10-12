import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import connectDB from "../config/db.js";
import mongoose from "mongoose";
import Client from "../models/users/client.js";
import Username from "../models/users/username.js";

// ---------------------------------------------------------------------------
// Temporarily hides every client except FAIRTECH SYSTEMS from the whole app by
// moving the other Client master docs, and their Username/client-user docs,
// into temp collections. Orders, bindings, labels, and production records are
// left untouched.
//
// Dry-run by default:
//   node scripts/move-non-fairtech-clients-temp.js
//
// Apply the move:
//   node scripts/move-non-fairtech-clients-temp.js --apply
//
// Restore moved docs later:
//   node scripts/move-non-fairtech-clients-temp.js --restore --apply
//
// Restore from the archive held in ANOTHER database on the same server -- used
// when the live database was copied (utils/companyDb.js renames a company by
// copying) after the move, so the archive only survives in a snapshot copy
// while the live database's temp collections stand empty:
//   node scripts/move-non-fairtech-clients-temp.js --restore --from-db=aimerz --apply
// ---------------------------------------------------------------------------

const KEEP_NAME = "FAIRTECH SYSTEMS";
const TEMP_CLIENTS = "temp_hidden_clients";
const TEMP_USERS = "temp_hidden_usernames";
const APPLY = process.argv.includes("--apply");
const RESTORE = process.argv.includes("--restore");
// --from-db=<name>: read the archive out of that database instead of the one
// the app is connected to. Docs are always written back into the LIVE database.
const FROM_DB = (process.argv.find((arg) => arg.startsWith("--from-db=")) || "").split("=")[1] || "";

function normalized(value) {
  return String(value || "").trim().toUpperCase();
}

function withoutArchiveFields(doc) {
  const { _archivedAt, _archiveReason, ...rest } = doc;
  return rest;
}

async function upsertRawDocs(collection, docs) {
  if (!docs.length) return;
  await collection.bulkWrite(
    docs.map((doc) => ({
      replaceOne: {
        filter: { _id: doc._id },
        replacement: doc,
        upsert: true,
      },
    })),
    { ordered: false },
  );
}

async function moveToTemp() {
  const db = mongoose.connection.db;
  const tempClients = db.collection(TEMP_CLIENTS);
  const tempUsers = db.collection(TEMP_USERS);

  const allClients = await Client.find({}).lean();
  const keepClients = allClients.filter((client) => normalized(client.clientName) === KEEP_NAME);
  const moveClients = allClients.filter((client) => normalized(client.clientName) !== KEEP_NAME);

  console.log(`Mode: ${APPLY ? "APPLY (moving docs)" : "DRY-RUN (no changes)"}`);
  console.log(`Keeping client name: ${KEEP_NAME}`);
  console.log(`Live clients found: ${allClients.length}`);
  console.log(`Clients to keep: ${keepClients.length}`);
  console.log(`Clients to move: ${moveClients.length}`);

  if (keepClients.length === 0) {
    throw new Error(`ABORTING: no live client found with clientName exactly "${KEEP_NAME}".`);
  }

  const moveClientIds = moveClients.map((client) => client._id);
  const moveClientBusinessIds = moveClients.map((client) => client.clientId).filter(Boolean);
  const moveUsers = await Username.find({ clientId: { $in: moveClientBusinessIds } }).lean();
  const moveUserIds = moveUsers.map((user) => user._id);

  console.log(`Client users to move: ${moveUsers.length}`);
  for (const client of moveClients) {
    console.log(`  CLIENT  ${client.clientName} (clientId ${client.clientId}, _id ${client._id})`);
  }

  if (!APPLY) {
    console.log("\nDry-run only. Re-run with --apply to move these docs into temp collections.");
    return;
  }

  const archivedAt = new Date();
  const archiveReason = `temporary hide except ${KEEP_NAME}`;

  await upsertRawDocs(
    tempClients,
    moveClients.map((doc) => ({ ...doc, _archivedAt: archivedAt, _archiveReason: archiveReason })),
  );
  await upsertRawDocs(
    tempUsers,
    moveUsers.map((doc) => ({ ...doc, _archivedAt: archivedAt, _archiveReason: archiveReason })),
  );

  await Username.deleteMany({ _id: { $in: moveUserIds } });
  await Client.deleteMany({ _id: { $in: moveClientIds } });

  console.log(`\nMoved ${moveClients.length} client doc(s) to ${TEMP_CLIENTS}.`);
  console.log(`Moved ${moveUsers.length} client-user doc(s) to ${TEMP_USERS}.`);
}

async function restoreFromTemp() {
  const liveDb = mongoose.connection.db;
  const db = FROM_DB ? mongoose.connection.client.db(FROM_DB) : liveDb;
  if (FROM_DB && FROM_DB === liveDb.databaseName) {
    throw new Error(`ABORTING: --from-db=${FROM_DB} is the live database; drop the flag for a plain restore.`);
  }
  if (FROM_DB) {
    console.log(`Reading archive from database "${FROM_DB}" into live database "${liveDb.databaseName}".`);
  }
  const tempClients = db.collection(TEMP_CLIENTS);
  const tempUsers = db.collection(TEMP_USERS);

  const [archivedClients, archivedUsers] = await Promise.all([
    tempClients.find({}).toArray(),
    tempUsers.find({}).toArray(),
  ]);

  console.log(`Mode: ${APPLY ? "APPLY (restoring docs)" : "DRY-RUN (no changes)"}`);
  console.log(`Archived clients found in ${TEMP_CLIENTS}: ${archivedClients.length}`);
  console.log(`Archived client users found in ${TEMP_USERS}: ${archivedUsers.length}`);
  for (const doc of archivedClients) {
    console.log(`  CLIENT  ${doc.clientName} (clientId ${doc.clientId}, _id ${doc._id})`);
  }
  for (const doc of archivedUsers) {
    console.log(`  USER    ${doc.userName} of ${doc.clientName} (_id ${doc._id})`);
  }

  if (!APPLY) {
    console.log("\nDry-run only. Re-run with --restore --apply to restore these docs.");
    return;
  }

  await upsertRawDocs(Client.collection, archivedClients.map(withoutArchiveFields));
  await upsertRawDocs(Username.collection, archivedUsers.map(withoutArchiveFields));

  // The archive is emptied only when it sits in the live database. A snapshot
  // copy read through --from-db is left intact: it is the only backup of these
  // docs, and nothing in the live database records that they were ever moved.
  if (FROM_DB) {
    console.log(`Left ${TEMP_CLIENTS}/${TEMP_USERS} in "${FROM_DB}" untouched (still the backup).`);
  } else {
    if (archivedUsers.length) await tempUsers.deleteMany({ _id: { $in: archivedUsers.map((doc) => doc._id) } });
    if (archivedClients.length) await tempClients.deleteMany({ _id: { $in: archivedClients.map((doc) => doc._id) } });
  }

  console.log(`\nRestored ${archivedClients.length} client doc(s) into clients.`);
  console.log(`Restored ${archivedUsers.length} client-user doc(s) into usernames.`);
}

try {
  await connectDB();
  if (RESTORE) {
    await restoreFromTemp();
  } else {
    await moveToTemp();
  }
} catch (err) {
  console.error(err.message || err);
  process.exitCode = 1;
} finally {
  await mongoose.connection.close();
}
