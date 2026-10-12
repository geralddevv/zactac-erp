import mongoose from "mongoose";
import { verificationFields } from "../../utils/verification.js";
const { Schema } = mongoose;

const locationDetailSchema = new mongoose.Schema(
  {
    userLocation: { type: String, required: true },
    dispatchAddress: { type: String, required: true },
    // Per-location dispatch details. Only stored when they carry a value:
    // a self-dispatch entry keeps just selfDispatch ("Self Dispatch") and the
    // transport fields are omitted; an unused transport field is omitted too.
    selfDispatch: { type: String },
    transportName: { type: String },
    transportContact: { type: String },
    dropLocation: { type: String },
    dropLocation1: { type: String },
    deliveryMode: { type: String },
    deliveryLocation: { type: String },
    deliveryLocation1: { type: String },
    vendorPayment: { type: String },
  },
  { _id: false },
);

const vendorUserSchema = new mongoose.Schema({
  vendorId: { type: String, required: true },
  vendorName: { type: String, required: true },
  hoLocation: { type: String, required: true },
  warehouseLocation: { type: String, required: true },
  userName: { type: String, required: true },
  userLocation: { type: String, required: true },
  userDepartment: { type: String, required: true },
  userContact: { type: String, required: true },
  userEmail: { type: String, required: true },
  locationsCount: { type: Number, default: 1 },
  locationDetails: [locationDetailSchema],
  dispatchAddress: { type: String, required: true },
  transportName: { type: String },
  transportContact: { type: String },
  dropLocation: { type: String },
  dropLocation1: { type: String },
  deliveryMode: { type: String },
  deliveryLocation: { type: String },
  deliveryLocation1: { type: String },
  vendorPayment: { type: String },
  SelfDispatch: { type: String },
  vendorStatus: { type: String },
  ownerName: { type: String },
  ownerMobNo: { type: String },
  ownerEmail: { type: String },
  vendorGst: { type: String },
  vendorMsme: { type: String },
  commodities: [String],
  vendorUserSignature: { type: String, unique: true, sparse: true, trim: true },

  // The coordinator's own active/inactive state (distinct from `vendorStatus`,
  // which mirrors the parent vendor). Toggled from the coordinator details page.
  coordinatorStatus: {
    type: String,
    enum: ["ACTIVE", "INACTIVE"],
    default: "ACTIVE",
  },
  // Activation history -- one entry per stint the coordinator was active.
  // The open entry (no `to`) is the current stint; closing it (set `to`) is
  // what "mark inactive" does, re-activating pushes a fresh open entry. Shown
  // as a timeline on the vendor profile page.
  activityLog: [
    {
      _id: false,
      from: { type: Date, required: true },
      to: { type: Date, default: null },
    },
  ],

  ...verificationFields,

  tape: [
    {
      type: Schema.Types.ObjectId,
      ref: "VendorTapeBinding",
    },
  ],

  // Multiple label per vendor (future-proof)
  label: [
    {
      type: Schema.Types.ObjectId,
      ref: "Label",
    },
  ],
});

// A brand-new coordinator starts ACTIVE with its activation timeline opened now.
vendorUserSchema.pre("save", function (next) {
  if (this.isNew && (!this.activityLog || this.activityLog.length === 0)) {
    this.coordinatorStatus = this.coordinatorStatus || "ACTIVE";
    this.activityLog = [{ from: new Date(), to: null }];
  }
  next();
});

const VendorUser = mongoose.model("VendorUser", vendorUserSchema);

export default VendorUser;
