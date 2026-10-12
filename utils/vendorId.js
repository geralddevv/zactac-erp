import Counter from "../models/system/counter.js";
import Vendor from "../models/users/vendor.js";

// Vendor Ids are `FS | VENDOR | <n>` (the older FAIRTECH-era family, like
// clients' `FS | CLIENT | <n>` -- deliberately not the company id code).

// Next Vendor Id the New Vendor dialog shows (display only -- POST
// /form/vendor assigns the real one). Skips ids already taken so the preview
// matches what the generator will actually hand out.
export async function getNextVendorIdPreview() {
  const counterDoc = await Counter.findOne({ key: "vendorId" }).select("seq").lean();
  let nextSeq = Number(counterDoc?.seq || 0) + 1;
  while (await Vendor.exists({ vendorId: `FS | VENDOR | ${nextSeq}` })) {
    nextSeq += 1;
  }
  return `FS | VENDOR | ${nextSeq}`;
}

export async function generateVendorId() {
  const maxAttempts = 10000;
  for (let i = 0; i < maxAttempts; i++) {
    const counter = await Counter.findOneAndUpdate(
      { key: "vendorId" },
      { $inc: { seq: 1 } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    ).lean();

    const candidateId = `FS | VENDOR | ${counter.seq}`;
    const exists = await Vendor.exists({ vendorId: candidateId });
    if (!exists) return candidateId;
  }
  throw new Error("Unable to generate unique vendor id");
}
