import mongoose from "mongoose";
import { verificationFields } from "../../utils/verification.js";

let vendorSchema = new mongoose.Schema({
  vendorId: { type: String, required: true, unique: true },
  vendorName: { type: String, required: true },
  vendorStatus: { type: String, required: true },
  hoLocation: { type: String, required: true },
  warehouseLocation: { type: String, required: true },
  commodities: [{ type: String }],
  vendorGst: { type: String, required: true },
  vendorMsme: { type: String, required: true },
  vendorGumasta: { type: String, required: true },
  vendorPan: { type: String, required: true },
  vendorSignature: { type: String, unique: true, sparse: true, trim: true },
  users: [{ type: mongoose.Schema.Types.ObjectId, ref: "VendorUser" }],
  ...verificationFields,
});

let Vendor = mongoose.model("Vendor", vendorSchema);

export default Vendor;
