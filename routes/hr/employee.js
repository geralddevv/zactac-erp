import { verificationUpdate } from "../../utils/verification.js";
import express from "express";
import Employee from "../../models/hr/employee_model.js";
import Loan from "../../models/accounting/Loan.js";
import Advance from "../../models/accounting/advance.js";
import Client from "../../models/users/client.js";
import Username from "../../models/users/username.js";
import Machine from "../../models/system/machine.js";
import Location from "../../models/system/location.js";
import multer from "multer";
import path from "path";
import fs from "fs";
import { randomBytes } from "crypto";
import { requireAuth } from "../../middleware/auth.js";
import { createLimiter, updateLimiter, deleteLimiter } from "../../utils/limiters.js";
import { normalizeLocationName } from "../../utils/locations.js";

const router = express.Router();

/* ================= SURRENDERED ASSETS PARSER ================= */
// The form sends the surrendered asset list as a JSON string (robust across
// multipart parsing). Returns a clean array of strings.
const parseSurrenderedAssets = (raw) => {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
};

/* ================= MULTER STORAGE (MULTIPLE FILE TYPES) ================= */
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (file.fieldname === "empPhoto") {
      cb(null, "images/empimg");
    } else if (file.fieldname === "empAadhaarImg") {
      cb(null, "images/aadhaar");
    } else if (file.fieldname === "empPanImg") {
      cb(null, "images/pan");
    } else if (file.fieldname === "empBiodata") {
      cb(null, "images/biodata");
    } else {
      cb(new Error("Invalid upload field"));
    }
  },
  filename: (req, file, cb) => {
    const randomName = randomBytes(16).toString("hex") + path.extname(file.originalname);
    cb(null, randomName);
  },
});

// Every attachment is image-only except Biodata (a CV/resume, normally a
// PDF) -- it alone also accepts application/pdf.
const fileFilter = (req, file, cb) => {
  const isBiodata = file.fieldname === "empBiodata";
  const isImageMime = file.mimetype.startsWith("image/");
  const isPdfMime = file.mimetype === "application/pdf";

  if (!isImageMime && !(isBiodata && isPdfMime)) {
    return cb(new Error(isBiodata ? "Only image or PDF files allowed" : "Only image files allowed"), false);
  }

  const allowedExts = isBiodata
    ? [".jpg", ".jpeg", ".png", ".gif", ".webp", ".pdf"]
    : [".jpg", ".jpeg", ".png", ".gif", ".webp"];
  const ext = path.extname(file.originalname).toLowerCase();
  if (!allowedExts.includes(ext)) {
    return cb(
      new Error(
        isBiodata
          ? "Invalid file extension. Use JPG, PNG, GIF, WebP, or PDF."
          : "Invalid file extension. Use JPG, PNG, GIF, or WebP.",
      ),
      false,
    );
  }

  cb(null, true);
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
});

/* ================= MULTER WRAPPER FOR CLEAN ERRORS ================= */
const uploadMiddleware = upload.fields([
  { name: "empPhoto", maxCount: 1 },
  { name: "empAadhaarImg", maxCount: 1 },
  { name: "empPanImg", maxCount: 1 },
  { name: "empBiodata", maxCount: 1 },
]);

const normalizeProfileCode = (value) => String(value || "").trim().toUpperCase();

// A Profile Code only has to be unique per location -- the same code (e.g. an
// OPERATOR's machine name) is fine at two different locations, since we'll
// be scoping operator login by location later. Combined into one key so both
// the client-side pre-check and the server-side save-time check agree.
const profileCodeLocationKey = (code, location) =>
  `${normalizeProfileCode(code)}||${normalizeLocationName(location)}`;

const getExistingProfileCodes = async (excludeId = null) => {
  const query = {
    empProfileCode: { $exists: true, $ne: "" },
  };
  if (excludeId) query._id = { $ne: excludeId };

  const employees = await Employee.find(query, "empProfileCode empLoc").lean();
  return employees
    .filter((emp) => normalizeProfileCode(emp.empProfileCode))
    .map((emp) => profileCodeLocationKey(emp.empProfileCode, emp.empLoc));
};

const findEmployeeByProfileCode = async (profileCode, location, excludeId = null) => {
  const normalizedCode = normalizeProfileCode(profileCode);
  if (!normalizedCode) return null;

  const key = profileCodeLocationKey(profileCode, location);
  const query = { empProfileCode: { $exists: true, $ne: "" } };
  if (excludeId) query._id = { $ne: excludeId };

  const employees = await Employee.find(query, "_id empProfileCode empLoc").lean();
  return employees.find((emp) => profileCodeLocationKey(emp.empProfileCode, emp.empLoc) === key) || null;
};

// The Location <select> is fed from the Location master (/form/location)
// rather than a hardcoded list, so opening a new unit is a master entry
// instead of a code change. Names are stored uppercase there; see
// scripts/backfill-location-master-seed.js for seeding the ones already in
// use on employee records.
const getLocationNames = () => Location.distinct("locationName").then((names) => names.sort());

const deleteUploadedEmployeeFiles = (files = {}) => {
  const folderByField = {
    empPhoto: "empimg",
    empAadhaarImg: "aadhaar",
    empPanImg: "pan",
    empBiodata: "biodata",
  };

  Object.entries(folderByField).forEach(([field, folder]) => {
    (files[field] || []).forEach((file) => {
      const filePath = path.join("images", folder, file.filename);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    });
  });
};

// Field labels as the form shows them, so a save error names the box the user
// has to go and fix rather than the schema path.
const EMPLOYEE_FIELD_LABELS = {
  empId: "Employee ID",
  empName: "Employee Name",
  empNickName: "Nick Name",
  empDateOfJoining: "Date of Joining",
  empDept: "Department",
  empProfile: "Profile",
  empProfileCode: "Profile Code",
  empLoc: "Location",
  empUnder: "Under",
  empReportingManager: "Reporting Manager",
  empMobile1: "Mobile Number",
  empAadhaar: "Aadhaar Number",
  empPan: "PAN Number",
  empAccNo: "Account Number",
};
const employeeFieldLabel = (path) => EMPLOYEE_FIELD_LABELS[path] || path;

// Mongo/Mongoose save errors go straight into a toast on the form, so turn
// the raw text ("E11000 duplicate key error ... index: empId_1 ...") into
// something a person can act on.
const saveErrorMessage = (err) => {
  if (err?.name === "ValidationError") {
    const missing = Object.values(err.errors || {}).map((e) => employeeFieldLabel(e.path));
    return missing.length
      ? `Please fill in ${missing.join(", ")}.`
      : "Some required details are missing.";
  }
  if (err?.code === 11000) {
    const fields = Object.keys(err.keyPattern || err.keyValue || {}).map(employeeFieldLabel);
    const value = Object.values(err.keyValue || {})[0];
    return fields.length
      ? `${fields.join(", ")}${value ? ` "${value}"` : ""} is already used by another employee.`
      : "That value is already used by another employee.";
  }
  return err?.message || "Could not save the employee.";
};

const handleUpload = (req, res, next) => {
  uploadMiddleware(req, res, (err) => {
    if (err) {
      if (req.xhr || req.headers.accept?.includes("application/json")) {
        return res.status(400).json({ success: false, message: err.message });
      }
      req.flash("notification", err.message);
      return res.redirect("back");
    }
    next();
  });
};

/* ================= CREATE EMPLOYEE FORM ================= */
router.get("/create", async (req, res) => {
  const employeeCount = (await Employee.countDocuments()) + 1;
  const employees = await Employee.find({}, "empName")
    .collation({ locale: "en", strength: 2 })
    .sort({ empName: 1 })
    .lean();
  const existingProfileCodes = await getExistingProfileCodes();
  const machineNames = await Machine.distinct("machineName").then((names) => names.sort());
  const locationNames = await getLocationNames();

  res.render("hr/employee.ejs", {
    title: "Employee Details",
    CSS: false,
    JS: false,
    employeeCount,
    employee: null,
    employees,
    existingProfileCodes,
    machineNames,
    locationNames,
    loan: null,
    advance: null,
    notification: req.flash("notification"),
  });
});

/* ================= EMPLOYEE LIST ================= */
router.get("/view", async (req, res) => {
  const [employees, loans, advances, managerEmployees, existingProfileCodes, machineNames, locationNames] = await Promise.all([
    Employee.find().lean(),
    Loan.find({}, "employee currentBalance").lean(),
    Advance.find({}, "employee currentBalance").lean(),
    Employee.find({}, "empName")
      .collation({ locale: "en", strength: 2 })
      .sort({ empName: 1 })
      .lean(),
    getExistingProfileCodes(),
    Machine.distinct("machineName").then((names) => names.sort()),
    getLocationNames(),
  ]);

  const loanMap = Object.fromEntries(loans.map(l => [l.employee.toString(), l.currentBalance]));
  const advanceMap = Object.fromEntries(advances.map(a => [a.employee.toString(), a.currentBalance]));

  const jsonData = employees.map(emp => ({
    ...emp,
    loanBalance: loanMap[emp._id.toString()] || 0,
    advanceBalance: advanceMap[emp._id.toString()] || 0,
  }));

  res.render("hr/employeeDisp.ejs", {
    jsonData,
    title: "Employee View",
    CSS: "tableDisp.css",
    JS: false,
    notification: req.flash("notification"),
    // For the Add Employee dialog -- same data GET /create renders the
    // standalone form with, so the dialog needs no round trip of its own.
    employeeCount: employees.length + 1,
    managerEmployees,
    existingProfileCodes,
    machineNames,
    locationNames,
  });
});

/* ================= CREATE EMPLOYEE ================= */
router.post("/form", requireAuth, createLimiter, handleUpload, async (req, res) => {
  try {
    const existingProfileCode = await findEmployeeByProfileCode(req.body.empProfileCode, req.body.empLoc);
    if (existingProfileCode) {
      deleteUploadedEmployeeFiles(req.files);
      return res.status(409).json({
        success: false,
        message: "Profile Code already exists at this location. Please enter a different code.",
      });
    }

    // Approval is stamped from the session, never taken from the posted body.
    const vf = verificationUpdate(req);
    delete req.body.verified; delete req.body.verifiedBy; delete req.body.verifiedAt;

    const isActive = req.body.status !== "inactive";
    const employeeData = {
      ...req.body,
      ...vf.set,
      isActive,
      empInactiveReason: isActive ? "" : (req.body.empInactiveReason || ""),
      empAssetsSurrendered: isActive ? [] : parseSurrenderedAssets(req.body.empAssetsSurrenderedJson),
      empPhoto: req.files?.empPhoto?.[0]?.filename || null,
      empAadhaarImg: req.files?.empAadhaarImg?.[0]?.filename || null,
      empPanImg: req.files?.empPanImg?.[0]?.filename || null,
      empBiodata: req.files?.empBiodata?.[0]?.filename || null,
    };

    // No password field on the create form — set the default explicitly
    // rather than relying on the schema default, so it's clear the value
    // still goes through the same pre-save bcrypt hashing as an edit.
    const newEmployee = new Employee(employeeData);
    newEmployee.password = "pass";
    await newEmployee.save();

    res.locals.auditDescription = `Created employee "${req.body.empName}" (${req.body.empProfileCode})`;
    req.flash("notification", "Employee created successfully!");
    if (req.xhr || req.headers.accept?.includes("application/json")) {
      res.json({ success: true, redirect: "/app/employee/view" });
    } else {
      res.redirect("/app/employee/view");
    }
  } catch (err) {
    console.error(err);
    res.status(400).json({ success: false, message: saveErrorMessage(err) });
  }
});

/* ================= EMPLOYEE PROFILE VIEW ================= */
router.get("/profile/:id", async (req, res) => {
  const employee = await Employee.findById(req.params.id).lean();
  if (!employee) return res.status(404).send("Employee not found");

  const [loan, advance] = await Promise.all([
    Loan.findOne({ employee: req.params.id }).lean(),
    Advance.findOne({ employee: req.params.id }).lean(),
  ]);

  res.render("hr/employeeView.ejs", { employee, loan, advance, title: "Employee Profile", CSS: false, JS: false });
});

/* ================= FETCH EMPLOYEE JSON ================= */
router.get("/:id", async (req, res) => {
  try {
    const emp = await Employee.findById(req.params.id).lean();
    if (!emp) return res.status(404).json(null);
    res.json(emp);
  } catch {
    res.status(500).json(null);
  }
});

/* ================= EDIT FORM ================= */
router.get("/edit/:id", async (req, res) => {
  const employee = await Employee.findById(req.params.id).lean();
  if (!employee) return res.redirect("back");
  const [employees, existingProfileCodes, machineNames, locationNames, loan, advance] = await Promise.all([
    Employee.find({ _id: { $ne: req.params.id } }, "empName")
      .collation({ locale: "en", strength: 2 })
      .sort({ empName: 1 })
      .lean(),
    getExistingProfileCodes(req.params.id),
    Machine.distinct("machineName").then((names) => names.sort()),
    getLocationNames(),
    Loan.findOne({ employee: req.params.id }).lean(),
    Advance.findOne({ employee: req.params.id }).lean(),
  ]);

  res.render("hr/employee.ejs", {
    title: "Edit Employee",
    CSS: false,
    JS: false,
    employee,
    employeeCount: null,
    employees,
    existingProfileCodes,
    machineNames,
    locationNames,
    loan,
    advance,
  });
});

/* ================= UPDATE EMPLOYEE ================= */
router.post("/edit/:id", requireAuth, updateLimiter, handleUpload, async (req, res) => {
  try {
    const emp = await Employee.findById(req.params.id);
    if (!emp) return res.status(400).json({ success: false, message: "Employee not found" });

    const existingProfileCode = await findEmployeeByProfileCode(req.body.empProfileCode, req.body.empLoc, req.params.id);
    if (existingProfileCode) {
      deleteUploadedEmployeeFiles(req.files);
      return res.status(409).json({
        success: false,
        message: "Profile Code already exists at this location. Please enter a different code.",
      });
    }

    const oldName = emp.empName;
    const newName = req.body.empName;

    const replaceFile = (field, folder, removeFlagField) => {
      if (req.files?.[field]) {
        // A new upload always takes precedence over a stale "remove" flag.
        if (emp[field]) {
          const oldPath = `images/${folder}/${emp[field]}`;
          if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
        }
        emp[field] = req.files[field][0].filename;
      } else if (req.body[removeFlagField] === "true" && emp[field]) {
        const oldPath = `images/${folder}/${emp[field]}`;
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
        emp[field] = "";
      }
    };

    replaceFile("empPhoto", "empimg", "removeEmpPhoto");
    replaceFile("empAadhaarImg", "aadhaar", "removeEmpAadhaarImg");
    replaceFile("empPanImg", "pan", "removeEmpPanImg");
    replaceFile("empBiodata", "biodata", "removeEmpBiodata");

    const vf = verificationUpdate(req, emp);
    delete req.body.verified; delete req.body.verifiedBy; delete req.body.verifiedAt;
    Object.assign(emp, req.body, vf.set);
    Object.keys(vf.unset).forEach((k) => emp.set(k, undefined));
    emp.isActive = req.body.status !== "inactive";
    if (emp.isActive) {
      emp.empInactiveReason = "";
      emp.empAssetsSurrendered = [];
    } else {
      emp.empInactiveReason = req.body.empInactiveReason || "";
      emp.empAssetsSurrendered = parseSurrenderedAssets(req.body.empAssetsSurrenderedJson);
    }
    await emp.save();

    // Propagate Name Change if empName was updated
    if (oldName && newName && oldName !== newName) {
      await Promise.all([
        Client.updateMany({ accountHead: oldName }, { $set: { accountHead: newName } }),
        Username.updateMany({ accountHead: oldName }, { $set: { accountHead: newName } }),
        Employee.updateMany({ empReportingManager: oldName }, { $set: { empReportingManager: newName } }),
      ]);
    }

    res.locals.auditDescription = `Updated employee "${emp.empName}"`;
    req.flash("notification", "Employee updated successfully!");
    const redirectUrl = "/app/employee/view";
    if (req.xhr || req.headers.accept?.includes("application/json")) {
      res.json({ success: true, redirect: redirectUrl });
    } else {
      res.redirect(redirectUrl);
    }
  } catch (err) {
    console.error(err);
    res.status(400).json({ success: false, message: saveErrorMessage(err) });
  }
});

/* ================= UPDATE INACTIVE DETAILS (from profile dialog) ================= */
router.post("/inactive-details/:id", requireAuth, updateLimiter, async (req, res) => {
  try {
    const emp = await Employee.findById(req.params.id);
    if (!emp) return res.status(404).json({ success: false, message: "Employee not found" });
    if (emp.isActive !== false) {
      return res.status(400).json({ success: false, message: "Employee is not inactive." });
    }
    const reason = (req.body.empInactiveReason || "").trim();
    if (!reason) return res.status(400).json({ success: false, message: "Reason is required." });
    emp.empInactiveReason = reason;
    emp.empAssetsSurrendered = parseSurrenderedAssets(req.body.empAssetsSurrenderedJson);
    await emp.save();
    res.locals.auditDescription = `Updated inactive details for employee "${emp.empName}"`;
    return res.json({ success: true });
  } catch (err) {
    console.error("UPDATE INACTIVE DETAILS ERROR:", err);
    return res.status(400).json({ success: false, message: err.message });
  }
});

/* ================= PERMISSION DASHBOARD ================= */
router.get("/admin/permissions", async (req, res) => {
  try {
    if (!["admin", "proprietor"].includes(req.session.authUser.role)) {
      return res.redirect("/");
    }

    const employees = await Employee.find({ isActive: true }).sort({ empName: 1 }).lean();
    res.render("hr/permissionsDashboard.ejs", {
      title: "Permission Dashboard",
      employees,
      CSS: "tableDisp.css",
      JS: false,
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

/* ================= UPDATE PERMISSIONS (AJAX) ================= */
router.post("/admin/permissions/:id", requireAuth, updateLimiter, async (req, res) => {
  try {
    // Role checking is already handled by middleware in server.js
    // ensure the route processes the request.
    const { role, permissions, canRead, canWrite, canDelete } = req.body;
    const emp = await Employee.findByIdAndUpdate(req.params.id, {
      $set: { role, permissions, canRead, canWrite, canDelete }
    }).select("empName");

    res.locals.auditDescription = `Updated permissions/role for employee "${emp?.empName || req.params.id}" (role: ${role})`;
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
