import Employee from "../models/hr/employee_model.js";

/*
 * The one place that answers "which Employee document is the person logged in
 * right now?".
 *
 * This mapping is the hinge the whole notification/assignment feature turns
 * on: a task's assignee is an Employee._id, so unless the session can be
 * reduced to that same _id, "assigned to me" and the bell can never find the
 * right person.
 *
 * The session is not uniform about it:
 *   - operator logins already carry empObjId (utils/operatorAuth.js)
 *   - staff logins carry it too (server.js), but only since this feature --
 *     sessions are stored in Mongo and outlive a deploy, so a session started
 *     before it simply hasn't got the field. Rather than log everyone out, it
 *     is resolved from empId once and cached back onto the session.
 *   - the dev backdoor accounts (PROPRIETOR_USER etc.) have no employee record
 *     at all. They get null: they can't be assigned work and can't receive
 *     notifications. Matching them on profileCode would be worse than useless
 *     -- "admin" could collide with a real employee's profile code and hand
 *     one person's inbox to another.
 */
export async function sessionEmployeeId(req) {
  const authUser = req.session?.authUser;
  if (!authUser) return null;
  if (authUser.empObjId) return String(authUser.empObjId);

  // empId is the employee's own id code (e.g. "SP | EMP | 000001") and is
  // unique in the Employee collection -- the only safe handle a pre-existing
  // session gives us.
  if (!authUser.empId) return null;

  const employee = await Employee.findOne({ empId: authUser.empId }).select("_id empName").lean();
  if (!employee) return null;

  authUser.empObjId = String(employee._id);
  if (!authUser.empName) authUser.empName = employee.empName;
  return authUser.empObjId;
}

// Display name for the acting user, used in notification titles
// ("<creator> assigned you: <task>").
export function sessionDisplayName(req) {
  const authUser = req.session?.authUser;
  return String(authUser?.empName || authUser?.username || "Someone").trim();
}
