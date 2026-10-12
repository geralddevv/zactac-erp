import Task from "../models/miscellaneous/task_model.js";
import Client from "../models/users/client.js";
import { notify } from "./notify.js";

/*
 * Due-soon and overdue reminders for assigned tasks.
 *
 * Unlike every other notification in the app, nobody's click produces these --
 * a timer does, so the same reminder would go out on every run of the job.
 * What stops that is the dedupeKey: one key per task per recipient per
 * calendar day, unique in the database (models/system/notification.js), so a
 * reminder lands once a day however often this runs, and a restart, a second
 * app instance or a clock jump cannot produce a second copy.
 *
 * Killable from the environment: TASK_REMINDERS_ENABLED=false (also 0/off/no)
 * stops the job being scheduled at all. Needs a restart, like the other
 * startup switches.
 */

export const REMINDER_INTERVAL_MS = 15 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 60 * 1000;
const DUE_SOON_MS = 24 * 60 * 60 * 1000;

export function areTaskRemindersEnabled() {
  const raw = String(process.env.TASK_REMINDERS_ENABLED ?? "").trim().toLowerCase();
  return !["false", "0", "off", "no"].includes(raw);
}

// Local calendar day, matching todayDayKey() in routes/fairdesk_route.js --
// "once a day" has to mean the day the people using this are living in.
function dayKey(date = new Date()) {
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${mm}-${dd}`;
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

export async function runTaskDueReminders() {
  const today = startOfToday();
  const dueSoonBefore = new Date(Date.now() + DUE_SOON_MS);

  // Only assigned, unfinished, dated work: a task with no assignee has nobody
  // to remind, and one with no due date has nothing to be late for.
  const tasks = await Task.find({
    deletedAt: null,
    status: { $ne: "COMPLETED" },
    assignedTo: { $ne: null },
    dueDate: { $ne: null, $lt: dueSoonBefore },
  })
    .select("title dueDate assignedTo assignedToName createdById createdBy client clientIsOthers clientOthers")
    .populate({ path: "client", select: "clientName", model: Client })
    .lean();

  let sent = 0;
  for (const task of tasks) {
    const due = new Date(task.dueDate);
    if (isNaN(due)) continue;

    // A task due today is still due, not yet late.
    const overdue = due < today;
    const type = overdue ? "task.overdue" : "task.due";
    const dedupeKey = `${type}:${task._id}:${dayKey()}`;
    const dueText = due.toLocaleDateString("en-GB");
    const clientName = task.clientIsOthers ? task.clientOthers : task.client?.clientName;

    sent += await notify({
      userIds: [task.assignedTo],
      type,
      title: overdue ? `Overdue: ${task.title}` : `Due tomorrow: ${task.title}`,
      body: clientName ? `${clientName} · due ${dueText}` : `Due ${dueText}`,
      link: `/app/tasks?open=${task._id}`,
      refModel: "Task",
      refId: task._id,
      dedupeKey,
    });

    // The person who handed the work out hears about it once it is actually
    // late -- not a day early, when it is still the assignee's business.
    // Same dedupeKey on purpose: if they assigned it to themselves, the row
    // above already exists and this one is dropped by the unique index
    // instead of ringing twice.
    if (overdue && task.createdById) {
      sent += await notify({
        userIds: [task.createdById],
        type,
        title: `Overdue: ${task.title}`,
        body: task.assignedToName ? `With ${task.assignedToName} · due ${dueText}` : `Due ${dueText}`,
        link: `/app/tasks?open=${task._id}`,
        refModel: "Task",
        refId: task._id,
        dedupeKey,
      });
    }
  }

  return { scanned: tasks.length, sent };
}

export function startTaskReminderJob() {
  if (!areTaskRemindersEnabled()) {
    console.log("Task due reminders: disabled (TASK_REMINDERS_ENABLED)");
    return null;
  }

  const run = () => {
    runTaskDueReminders().catch((err) => console.error("TASK REMINDER JOB ERROR:", err));
  };

  // Give the database connections a moment before the first pass.
  setTimeout(run, FIRST_RUN_DELAY_MS);
  return setInterval(run, REMINDER_INTERVAL_MS);
}
