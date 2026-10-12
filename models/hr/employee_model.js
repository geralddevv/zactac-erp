import mongoose from "mongoose";
import bcrypt from "bcrypt";
import { verificationFields } from "../../utils/verification.js";

/* ================= DEPENDENTS ================= */
const dependentSchema = new mongoose.Schema(
  {
    dependentsName: { type: String },
    dependentsDOB: { type: String },
    dependentsRelation: { type: String },
  },
  { _id: false }
);

/* ================= EMPLOYEE ================= */
const employeeSchema = new mongoose.Schema(
  {
    /* ================= EMPLOYMENT ================= */
    empId: { type: String, unique: true, required: true },
    empDateOfJoining: { type: String },
    empType: { type: String },
    empUnder: { type: String },
    empLoc: { type: String },

    empAssets1: { type: String },
    empAssets2: { type: String },
    empAssets3: { type: String },
    empAssets4: { type: String },

    empDept: { type: String },
    empReportingManager: { type: String },
    empProfile: { type: String },
    empProfileCode: { type: String },

    empOfficeMob: { type: String },
    empOfficeEmailId: { type: String },

    /* ================= PERSONAL ================= */
    empName: { type: String },
    empNickName: { type: String }, // short call-name; defaults to the first word of empName
    empDob: { type: String },
    empGender: { type: String },

    empMobile1: { type: String },
    empMobile2: { type: String },

    empEmergencyNo1: { type: String },
    empEmergencyNo2: { type: String },

    empEmail: { type: String },
    empMartialStatus: { type: String },
    empMarriageAnniversary: { type: String },

    empPresentAddress: { type: String },
    empPermanentAddress: { type: String },

    empHobbies: { type: String },

    /* ================= IDENTIFICATION ================= */
    empPhoto: { type: String },        // images/empimg
    empAadhaar: { type: String },
    empAadhaarImg: { type: String },   // images/aadhaar
    empPan: { type: String },
    empPanImg: { type: String },       // images/pan
    empBiodata: { type: String },      // images/biodata -- resume/CV, image or PDF

    /* ================= BANKING ================= */
    empBankName: { type: String },
    empAccountHolderName: { type: String },
    empAccNo: { type: String },
    empIfscCode: { type: String },

    /* ================= DEDUCTIONS ================= */
    empPT: { type: Number, default: 0 },
    empTDS: { type: Number, default: 0 },
    empLIC: { type: Number, default: 0 },
    empMedical: { type: Number, default: 0 },
    empNSIC: { type: Number, default: 0 },
    empESIC: { type: Number, default: 0 },
    empPF: { type: Number, default: 0 },

    /* ================= PAYROLL ================= */
    basicSalary: { type: Number, default: 0 },
    railwayPass: { type: Number, default: 0 },
    travelling: { type: Number, default: 0 },
    houseRent: { type: Number, default: 0 },
    staffQuarters: { type: Number, default: 0 },
    otRatePerHour: { type: Number, default: 0 },
    bonus: { type: Number, default: 0 },

    /* ================= DEPENDENTS ================= */
    dependentsCount: { type: Number, default: 0 },
    dependentsDetails: [dependentSchema],

    /* ================= AUTHENTICATION & PERMISSIONS ================= */
    password: { type: String, default: "pass" }, // Hashed password
    role: { type: String, default: "employee" }, 
    permissions: {
      sales: { type: Boolean, default: false },
      inventory: { type: Boolean, default: false },
      hr: { type: Boolean, default: false },
      accounting: { type: Boolean, default: false },
      master: { type: Boolean, default: false },
    },
    canRead: { type: Boolean, default: true },
    canWrite: { type: Boolean, default: true },
    canDelete: { type: Boolean, default: true },

    /* ================= META ================= */
    isActive: { type: Boolean, default: true },
    empInactiveReason: { type: String, default: "" },
    empAssetsSurrendered: [{ type: String }],
    ...verificationFields,
  },
  {
    timestamps: true,
  }
);

employeeSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  try {
    const salt = await bcrypt.genSalt(12);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

employeeSchema.methods.comparePassword = async function (plainPassword) {
  return await bcrypt.compare(plainPassword, this.password);
};

const Employee = mongoose.model("Employee", employeeSchema);
export default Employee;
