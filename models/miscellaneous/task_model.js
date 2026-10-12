import mongoose from "mongoose";
import { getTasksConnection } from "../../config/tasksDb.js";

const taskSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    label: { type: String, trim: true },
    // Every task has exactly one responsible person — usually a real Employee,
    // but assignedToIsOthers lets it be a free-text name (assignedToOthers)
    // for someone not in the Employee list.
    //
    // assignedTo IS the assignee id: an Employee._id in the MAIN database, the
    // same id the logged-in user reduces to (utils/sessionUser.js). That is
    // what makes "assigned to me" and the assignment notification able to find
    // the right person — never store a name here instead.
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", index: true },
    assignedToIsOthers: { type: Boolean, default: false },
    assignedToOthers: { type: String, trim: true },
    // Denormalised copy of the assignee's name, written whenever assignedTo is
    // written. Tasks live on their own database connection (config/tasksDb.js),
    // so there is no cross-database join to lean on: a list or an export can
    // show who a task belongs to without reaching into the main DB, and a
    // notification can name them. assignedTo stays the source of truth — if
    // the employee is renamed, this copy is stale until the task is next saved.
    // For an "Others" assignee it holds assignedToOthers, the only name there is.
    assignedToName: { type: String, trim: true },
    // Who the task CONCERNS, as opposed to who it belongs to — filled in when
    // somebody keeps a reminder for themselves about another person ("follow
    // up with RAVI"). The task is still the creator's: this is display context
    // only.
    //
    // It is deliberately a field of its own and not a second meaning for
    // assignedTo. No visibility query and no notification ever reads it, so a
    // reminder kept ABOUT someone can never appear in that person's list or
    // ring their bell — which is the whole point of having kept it.
    //
    // aboutEmployee is unset for a free-text name (the dialog's "Others"),
    // where aboutEmployeeName is the only name there is; both are empty when
    // the reminder is about nobody in particular.
    aboutEmployee: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", index: true },
    aboutEmployeeName: { type: String, trim: true },
    // Optional — a task doesn't have to be tied to a client/company. Same
    // Others pattern as assignedTo, for a client not in the Client list.
    client: { type: mongoose.Schema.Types.ObjectId, ref: "Client", index: true },
    clientIsOthers: { type: Boolean, default: false },
    clientOthers: { type: String, trim: true },
    dueDate: { type: Date },
    status: {
      type: String,
      enum: ["PENDING", "IN_PROGRESS", "COMPLETED"],
      default: "PENDING",
      index: true,
    },
    // When the task was moved to COMPLETED (cleared again if it is reopened).
    completedAt: { type: Date, default: null },
    // The owner key every existing query is built on: the creator's empId code
    // (sessionOwnerKey in routes/fairdesk_route.js). Kept as the "created by
    // me" handle — the Daybook keys its own rows on the same string.
    createdBy: { type: String, trim: true },
    // The creator as an id and a name, the same pair as the assignee above:
    // createdById is who the "task completed" notification goes to.
    createdById: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", index: true },
    createdByName: { type: String, trim: true },
    // Soft-delete: set instead of removing the document, so a mis-click doesn't
    // permanently destroy the task. Hidden from normal queries via deletedAt: null.
    deletedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true },
);

// Bound to the isolated tasks database connection (config/tasksDb.js)
// instead of the default mongoose connection — task data is kept in a
// physically separate database from the rest of the app.
const Task = getTasksConnection().model("Task", taskSchema);

export default Task;
