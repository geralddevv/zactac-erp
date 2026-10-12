import mongoose from "mongoose";
import { verificationFields } from "../../utils/verification.js";

const labelStockBindingSchema = new mongoose.Schema(
  {
    labelStock: { type: mongoose.Schema.Types.ObjectId, ref: "SachikoLabelStock", required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "Username", required: true },
    location: { type: String, required: true },
    paperSize: { type: String },
    runningMeters: { type: Number },
    rate: { type: Number, required: true },
    status: { type: String, enum: ["ACTIVE", "INACTIVE"], default: "ACTIVE" },
    // Identifies "the same binding" -- labelStock + userId + paperSize +
    // runningMeters, hashed the same way as Client/TapeSalesOrder's own
    // duplicate-prevention signatures (see routes/sachiko/labelStockBinding.js).
    // Deliberately excludes location: two bindings that agree on SKU, paper
    // size, RM, client and user are the same binding regardless of location.
    bindingSignature: { type: String, unique: true, sparse: true, trim: true },
    ...verificationFields,
  },
  { timestamps: true },
);

const LabelStockBinding = mongoose.model("LabelStockBinding", labelStockBindingSchema, "labelstockbindings");

export default LabelStockBinding;
