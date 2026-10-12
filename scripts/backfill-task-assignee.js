import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import mongoose from "mongoose";
import connectDB from "../config/db.js";
import Task from "../models/miscellaneous/task_model.js";
import Employee from "../models/hr/employee_model.js";

// ---------------------------------------------------------------------------
// Backfill for the task-assignment fields: assignedToName, createdById and
// createdByName.
//
// Tasks predating assignment stored the creator only as their empId code
// (createdBy, e.g. "SP | EMP | 000001") and the assignee only as an
// Employee._id with no name copy. Both now carry an id AND a name:
//
//   assignedToName  <- the assignee's empName (or assignedToOthers for a
//                      free-text "Others" assignee)
//   createdById     <- the Employee._id behind createdBy
//   createdByName   <- that employee's empName
//
// createdById is what the "task completed" notification is addressed to. The
// route resolves it on the fly for rows that lack it, so nothing is broken
// without this script -- it just saves that lookup, and fills the Created By
// column on the Tasks page for old rows.
//
// Left alone and reported rather than guessed at:
//   - a createdBy code matching no employee (the record was deleted, or the
//     task was made by a dev backdoor login, which has no employee at all)
//   - an assignedTo id matching no employee
// Fields that already hold a value are never overwritten.
//
// Dry-run by default. Pass --apply to write changes.
//
//   node scripts/backfill-task-assignee.js           # preview
//   node scripts/backfill-task-assignee.js --apply   # commit
// ---------------------------------------------------------------------------

const APPLY = process.argv.includes("--apply");

const blank = (value) => value === undefined || value === null || String(value).trim() === "";

async function run() {
  await connectDB();

  const tasks = await Task.find({ deletedAt: null }).lean();
  const employees = await Employee.find().select("_id empId empName").lean();

  const byEmpId = new Map(employees.map((e) => [String(e.empId), e]));
  const byObjId = new Map(employees.map((e) => [String(e._id), e]));

  const updates = [];
  const unknownCreator = [];
  const unknownAssignee = [];

  for (const task of tasks) {
    const set = {};

    if (blank(task.assignedToName)) {
      if (task.assignedToIsOthers) {
        if (!blank(task.assignedToOthers)) set.assignedToName = String(task.assignedToOthers).trim();
      } else if (task.assignedTo) {
        const employee = byObjId.get(String(task.assignedTo));
        if (employee) set.assignedToName = employee.empName;
        else unknownAssignee.push({ _id: String(task._id), title: task.title, assignedTo: String(task.assignedTo) });
      }
    }

    if (!blank(task.createdBy) && (blank(task.createdById) || blank(task.createdByName))) {
      const creator = byEmpId.get(String(task.createdBy).trim());
      if (creator) {
        if (blank(task.createdById)) set.createdById = creator._id;
        if (blank(task.createdByName)) set.createdByName = creator.empName;
      } else {
        unknownCreator.push({ _id: String(task._id), title: task.title, createdBy: task.createdBy });
      }
    }

    // A task already completed should carry the stamp the status now writes.
    if (task.status === "COMPLETED" && !task.completedAt) {
      set.completedAt = task.updatedAt || task.createdAt || new Date();
    }

    if (Object.keys(set).length) updates.push({ _id: task._id, title: task.title, set });
  }

  console.log(`Tasks scanned:            ${tasks.length}`);
  console.log(`Tasks needing a backfill: ${updates.length}`);
  for (const u of updates.slice(0, 20)) {
    console.log(`  ${u._id}  "${u.title}"  ${JSON.stringify(u.set)}`);
  }
  if (updates.length > 20) console.log(`  ... and ${updates.length - 20} more`);

  if (unknownCreator.length) {
    console.log(`\nCreator empId matching no employee (left alone): ${unknownCreator.length}`);
    for (const t of unknownCreator.slice(0, 10)) console.log(`  ${t._id}  "${t.title}"  createdBy=${t.createdBy}`);
  }
  if (unknownAssignee.length) {
    console.log(`\nAssignee id matching no employee (left alone): ${unknownAssignee.length}`);
    for (const t of unknownAssignee.slice(0, 10)) console.log(`  ${t._id}  "${t.title}"  assignedTo=${t.assignedTo}`);
  }

  if (!APPLY) {
    console.log("\nDry run — nothing written. Re-run with --apply to commit.");
  } else if (updates.length) {
    const result = await Task.bulkWrite(
      updates.map((u) => ({ updateOne: { filter: { _id: u._id }, update: { $set: u.set } } })),
    );
    console.log(`\nApplied. Modified ${result.modifiedCount} task(s).`);
  } else {
    console.log("\nNothing to apply.");
  }

  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
