import express from "express";
import crypto from "crypto";
import Client from "../../models/users/client.js";
import Employee from "../../models/hr/employee_model.js";
import Username from "../../models/users/username.js";
import TapeSalesOrder from "../../models/inventory/TapeSalesOrder.js";
import { editLocationRows } from "../../utils/userLocations.js";
import { getNextClientIdPreview } from "../../utils/clientId.js";
import { verificationUpdate } from "../../utils/verification.js";
import { escapeRegex } from "../../utils/security.js";
import { requireAuth } from "../../middleware/auth.js";
import { createLimiter, updateLimiter, deleteLimiter } from "../../utils/limiters.js";

const router = express.Router();

function normalizeClientPart(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function buildClientSignature(source) {
  return [
    normalizeClientPart(source.clientName),
    normalizeClientPart(source.clientType),
    normalizeClientPart(source.clientStatus),
    normalizeClientPart(source.hoLocation),
    normalizeClientPart(source.accountHead),
    normalizeClientPart(source.clientGst),
    normalizeClientPart(source.clientMsme),
    normalizeClientPart(source.clientGumasta),
    normalizeClientPart(source.clientPan),
  ].join("||");
}

function hashSignature(rawSignature) {
  return `sha256:${crypto
    .createHash("sha256")
    .update(String(rawSignature ?? ""))
    .digest("hex")}`;
}

router.use((req, res, next) => {
  const authUser = req.session?.authUser;
  const role = String(authUser?.role || "").toLowerCase();
  const permissions = authUser?.permissions || {};
  const hasSalesAccess = role === "sales" || Boolean(permissions.sales);
  const hasClientAccess = hasSalesAccess || Boolean(permissions.master);

  if (!role) return res.redirect("/app/login");

  if (role === "proprietor" || role === "admin" || role === "hod") return next();

  if (hasClientAccess) {
    const path = req.path || "";
    const nPath = path.toLowerCase().replace(/\/$/, "");

    if (
      req.method === "GET" &&
      (nPath === "/view" || path.startsWith("/api/") || path.startsWith("/profile/") || path.startsWith("/details/") || path.startsWith("/edit/") || path.startsWith("/orders/"))
    ) {
      return next();
    }

    if (req.method === "POST" && (path.includes("/delete") || path.includes("/edit/"))) {
      return next();
    }

    return res.redirect("/app/login");
  }

  return res.redirect("/app/login");
});

// Groups sales orders (of a given collection) by the owning client, via a
// $lookup into usernames — cheaper than fetching every Username doc into app
// memory just to map userId -> clientId. Cancelled orders don't count as an
// actual purchase.
function purchaseCountPipeline() {
  return [
    { $match: { status: { $ne: "CANCELLED" } } },
    { $lookup: { from: "usernames", localField: "userId", foreignField: "_id", as: "u" } },
    { $unwind: "$u" },
    { $group: { _id: "$u.clientId", count: { $sum: 1 } } },
  ];
}

/* ================= CLIENTS VIEW ================= */
router.get("/view", async (req, res) => {
  try {
    const [clients, userCounts, tapeCounts, employees, previewClientId] = await Promise.all([
      // Every client. This listing was temporarily pinned to one name
      // ("FAIRTECH SYSTEMS") while the other clients were archived out of the
      // app by scripts/move-non-fairtech-clients-temp.js. That archive is
      // restored (temp_hidden_clients is empty) but the filter was left
      // behind, so a client created afterwards was saved correctly and then
      // never appeared here. Use the script's --restore/--apply if the
      // archive is ever needed again; don't re-pin the view.
      Client.find(
        {},
        {
          clientId: 1,
          clientName: 1,
          clientType: 1,
          verified: 1,
          verifiedBy: 1,
          verifiedAt: 1,
          hoLocation: 1,
          accountHead: 1,
          clientGst: 1,
          clientPan: 1,
          clientMsme: 1,
          clientGumasta: 1,
          clientStatus: 1,
          vendorCode: 1,
          verticals: 1,
          users: 1,
        },
      )
        .sort({ clientName: 1 })
        .lean(),
      Username.aggregate([{ $group: { _id: "$clientId", count: { $sum: 1 } } }]),
      TapeSalesOrder.aggregate(purchaseCountPipeline()),
      // For the New Client dialog (views/users/_clientDialog.ejs).
      Employee.find({}, "empName").sort({ empName: 1 }).lean(),
      getNextClientIdPreview(),
    ]);

    const userCountByClientId = new Map(userCounts.map((entry) => [String(entry._id || ""), Number(entry.count || 0)]));

    const purchaseCountByClientId = new Map();
    for (const bucket of [tapeCounts]) {
      for (const entry of bucket) {
        const key = String(entry._id || "");
        purchaseCountByClientId.set(key, (purchaseCountByClientId.get(key) || 0) + Number(entry.count || 0));
      }
    }

    clients.forEach((client) => {
      client.userCount = userCountByClientId.get(String(client.clientId || "")) || 0;
      client.purchaseCount = purchaseCountByClientId.get(String(client.clientId || "")) || 0;
    });

    res.render("users/clientsView.ejs", {
      title: "Client View",
      jsonData: clients,
      clients: clients.map((c) => c.clientName),
      employees,
      previewClientId,
      CSS: "tableDisp.css",
      JS: false,
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error(err);
    req.flash("notification", "Failed to load Clients");
    res.redirect("back");
  }
});

/* ================= CLIENT PURCHASE HISTORY ================= */
// All sales orders (across the three order collections) placed by any of
// this client's users — what the "Purchases" column on /view drills into.
router.get("/orders/:id", async (req, res) => {
  try {
    const client = await Client.findById(req.params.id).select("clientName clientId users").lean();
    if (!client) {
      req.flash("notification", "Client not found");
      return res.redirect("/app/client/view");
    }

    const userIds = client.users || [];
    const populateUser = { path: "userId", select: "clientName userName" };
    const itemSelect =
      "productId tapeProductId tapePaperCode tapeWidth tapeMtrs labelWidth labelHeight productCode skuCode";
    const orderSelect =
      "onModel userId quantity dispatchedQuantity poDate poNumber orderRate estimatedDate status remarks createdAt sourceLocation paperSize runningMeters";

    const tapeOrders = await TapeSalesOrder.find({ userId: { $in: userIds } })
      .select(`${orderSelect} tapeId`)
      .populate(populateUser)
      .populate({ path: "tapeId", select: itemSelect })
      .lean();

    const orders = tapeOrders
      .map((o) => ({ ...o, item: o.tapeId }))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.render("users/clientOrders.ejs", {
      title: "Client Purchase History",
      clientName: client.clientName,
      orders,
      CSS: "tableDisp.css",
      JS: false,
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("CLIENT ORDERS ERROR:", err);
    req.flash("notification", "Failed to load client purchase history");
    res.redirect("/app/client/view");
  }
});

/* ================= CLIENT POPUP DATA ================= */
router.get("/api/:id", async (req, res) => {
  try {
    const client = await Client.findById(req.params.id, { __v: 0 });
    if (!client) return res.status(404).json({ error: "Client not found" });
    res.json(client);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ================= EDIT CLIENT FORM ================= */
router.get("/edit/:id", async (req, res) => {
  try {
    const [client, employees] = await Promise.all([
      Client.findById(req.params.id),
      Employee.find({}, { empName: 1 }).sort({ empName: 1 }).lean(),
    ]);

    if (!client) {
      req.flash("notification", "Client not found");
      return res.redirect("/app/client/view");
    }

    res.render("users/clientEditForm.ejs", {
      title: "Edit Client",
      clientRec: client,
      employees,
      JS: false,
      CSS: "tabOpt.css",
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error(err);
    req.flash("notification", "Failed to load client");
    res.redirect("/app/client/view");
  }
});

/* ================= UPDATE CLIENT ================= */
router.post("/edit/:id", requireAuth, updateLimiter, async (req, res) => {
  try {
    const currentClient = await Client.findById(req.params.id).select("clientId verified verifiedBy").lean();

    if (!currentClient) {
      return res.status(404).json({
        success: false,
        message: "Client not found",
      });
    }

    const clientName = String(req.body.clientName || "").trim();
    const clientType = String(req.body.clientType || "").trim();
    const clientStatus = String(req.body.clientStatus || "").trim();
    const hoLocation = String(req.body.hoLocation || "").trim();
    const accountHead = String(req.body.accountHead || "").trim();
    const clientGst = String(req.body.clientGst || "").trim().toUpperCase();
    const clientMsme = String(req.body.clientMsme || "").trim().toUpperCase();
    const clientGumasta = String(req.body.clientGumasta || "").trim().toUpperCase();
    const clientPan = String(req.body.clientPan || "").trim().toUpperCase();
    const vendorCode = String(req.body.vendorCode || "").trim();
    const verticals = String(req.body.verticals || "").trim();

    // GST and PAN Validation
    const gstRegex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
    const panRegex = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;

    // Clients saved with the dialog's "Unregistered" box carry this sentinel
    // instead of a real GST/PAN; keep them editable.
    const isUnregistered = clientGst === "UNREGISTERED" && clientPan === "UNREGISTERED";
    if (!isUnregistered) {
      if (clientGst && !gstRegex.test(clientGst)) {
        return res.status(400).json({ success: false, message: "Invalid GST number format" });
      }
      if (clientPan && !panRegex.test(clientPan)) {
        return res.status(400).json({ success: false, message: "Invalid PAN number format" });
      }
      if (clientGst && clientPan && clientGst.substring(2, 12) !== clientPan) {
        return res.status(400).json({ success: false, message: "PAN does not match GST number" });
      }
    }

    const clientSignature = hashSignature(
      buildClientSignature({
        clientName,
        clientType,
        clientStatus,
        hoLocation,
        accountHead,
        clientGst,
        clientMsme,
        clientGumasta,
        clientPan,
      }),
    );

    // Block edit only when another client already has the same full entity.
    const duplicateClient = await Client.findOne({
      _id: { $ne: req.params.id },
      $or: [
        { clientSignature },
        {
          clientName: new RegExp(`^${escapeRegex(clientName)}$`, "i"),
          clientType: new RegExp(`^${escapeRegex(clientType)}$`, "i"),
          clientStatus: new RegExp(`^${escapeRegex(clientStatus)}$`, "i"),
          hoLocation: new RegExp(`^${escapeRegex(hoLocation)}$`, "i"),
          accountHead: new RegExp(`^${escapeRegex(accountHead)}$`, "i"),
          clientGst: new RegExp(`^${escapeRegex(clientGst)}$`, "i"),
          clientMsme: new RegExp(`^${escapeRegex(clientMsme)}$`, "i"),
          clientGumasta: new RegExp(`^${escapeRegex(clientGumasta)}$`, "i"),
          clientPan: new RegExp(`^${escapeRegex(clientPan)}$`, "i"),
        },
      ],
    }).lean();

    if (duplicateClient) {
      return res.status(400).json({
        success: false,
        message: "client already exist (same full details)",
      });
    }

    const vf = verificationUpdate(req, currentClient);
    await Client.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
        ...vf.set,
        clientName,
        clientType,
        clientStatus,
        hoLocation,
        accountHead,
        clientGst,
        clientMsme,
        clientGumasta,
        clientPan,
        vendorCode,
        verticals,
        clientSignature,
        },
        ...(Object.keys(vf.unset).length ? { $unset: vf.unset } : {}),
      },
      {
        runValidators: true,
      },
    );

    await Username.updateMany(
      { clientId: currentClient.clientId },
      {
        $set: {
          clientId: currentClient.clientId,
          clientName,
          clientType,
          clientStatus,
          hoLocation,
          accountHead,
        },
      },
    );

    res.locals.auditDescription = `Updated client "${clientName}"`;
    req.flash("notification", "Client updated successfully!");
    res.json({ success: true, redirect: "/app/client/view" });
  } catch (err) {
    console.error(err);
    res.status(400).json({ success: false, message: "Failed to update client" });
  }
});

/* ================= CLIENT PROFILE (OPTIONAL) ================= */
router.get("/profile/:id", async (req, res) => {
  try {
    const client = await Client.findById(req.params.id).populate({
      path: "users",
      populate: [
        { path: "label" },
        { path: "labelStock", populate: { path: "labelStock", model: "SachikoLabelStock" } },
      ],
    });

    if (!client) {
      req.flash("notification", "Client not found");
      return res.redirect("/app/client/view");
    }

    res.render("users/clientProfile.ejs", {
      title: "Client Profile",
      breadcrumb: [
        { label: "Client" },
        { label: "Client List", href: "/app/client/view" },
        { label: client.clientName },
      ],
      clientRec: client,
      CSS: false,
      JS: false,
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error(err);
    req.flash("notification", "Invalid client link");
    res.redirect("/app/client/view");
  }
});

/* ================= USER DETAILS ================= */
router.get("/details/:userId", async (req, res) => {
  try {
    const user = await Username.findById(req.params.userId)
      .populate("label")
      .populate({
        path: "labelStock",
        populate: { path: "labelStock", model: "SachikoLabelStock" },
      });

    if (!user) {
      req.flash("notification", "User not found");
      return res.redirect("/app/master/view");
    }

    const userData = {
      _id: user._id,
      clientId: user.clientId,
      clientName: user.clientName,
      clientType: user.clientType,
      hoLocation: user.hoLocation,
      accountHead: user.accountHead,
      userName: user.userName,
      verified: !!user.verified,
      verifiedBy: user.verifiedBy,
      verifiedAt: user.verifiedAt,
      userContact: user.userContact,
      userEmail: user.userEmail,
      userLocation: user.userLocation,
      locationDetails: Array.isArray(user.locationDetails) ? user.locationDetails : [],
      userDepartment: user.userDepartment,
      SelfDispatch: user.SelfDispatch,
      dispatchAddress: user.dispatchAddress,
      transportName: user.transportName,
      transportContact: user.transportContact,
      dropLocation: user.dropLocation,
      deliveryMode: user.deliveryMode,
      deliveryLocation: user.deliveryLocation,
      clientPayment: user.clientPayment,
    };

    const stats = {
      labels: (user.label || []).length,
      labelStocks: (user.labelStock || []).length,
    };

    res.render("users/clientDetails.ejs", {
      title: "User Details",
      breadcrumb: [
        { label: "Client" },
        { label: "Client Data", href: "/app/master/view" },
        { label: userData.userName },
      ],
      CSS: false,
      JS: false,
      userData,
      initialLocationDetails: editLocationRows(user),
      labels: user.label || [],
      labelStocks: user.labelStock || [],
      stats,
      filterLocation: req.query.location ? String(req.query.location).trim() : "",
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("USER DETAILS ERROR:", err);
    req.flash("notification", "Failed to load user details");
    res.redirect("/app/master/view");
  }
});

/* ================= DELETE USER ================= */
router.post("/details/:userId/delete", requireAuth, deleteLimiter, async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await Username.findById(userId).lean();
    if (!user) {
      req.flash("notification", "User not found");
      return res.redirect("/app/master/view");
    }
    await Client.updateOne({ clientId: user.clientId }, { $pull: { users: user._id } });
    await Username.deleteOne({ _id: user._id });
    res.locals.auditDescription = `Deleted user "${user.userName}" (client: ${user.clientName})`;
    req.flash("notification", `User ${user.userName} deleted successfully`);
    return res.redirect("/app/master/view");
  } catch (err) {
    console.error("USER DELETE ERROR:", err);
    req.flash("notification", "Failed to delete user");
    return res.redirect(`/app/client/details/${req.params.userId}`);
  }
});

export default router;
