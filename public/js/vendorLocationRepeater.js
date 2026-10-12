/* Location repeater for the New Coordinator / Edit Coordinator dialogs of a
   VENDOR (one card per location with its pick up details: mode, location,
   payment). Sister of public/js/locationRepeater.js, which is the client
   users' version (transport / self dispatch) -- vendor rows carry different
   fields, so they can't share a row template. Load locationRepeater.js first
   for window.formatMobileInput; this file needs nothing else.

     const rep = createVendorLocationRepeater({ container, countInput, minus, plus });
     rep.setCount(n)                           grow/shrink, keeping typed values
     rep.setRows([{ userLocation, dispatchAddress, deliveryMode, ... }])
                                               replace every row (Edit dialog)
   Row field names (locationDetails[i][...]) are what POST /form/vendor-user
   and POST /form/edit/vendor-user/:id read. */
(function () {
  "use strict";

  const MAX_LOCATIONS = 20;

  const EMPTY_ROW = {
    userLocation: "",
    dispatchAddress: "",
    deliveryMode: "",
    deliveryLocation: "",
    vendorPayment: "",
  };

  function escapeAttr(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function readRowValues(row) {
    const get = (suffix) => row.querySelector(`[name$="[${suffix}]"]`)?.value || "";
    return {
      userLocation: get("userLocation"),
      dispatchAddress: get("dispatchAddress"),
      deliveryMode: get("deliveryMode"),
      deliveryLocation: get("deliveryLocation"),
      vendorPayment: get("vendorPayment"),
    };
  }

  // Location + address, then that location's own pick up details.
  function buildRowHtml(i, v) {
    const sel = (val, opt) => (val === opt ? "selected" : "");
    return `
      <div class="location-row">
        <div class="loc-line">
          <input type="text" name="locationDetails[${i}][userLocation]"
            placeholder="Enter Location" aria-label="Location ${i + 1}"
            value="${escapeAttr(v.userLocation.toUpperCase())}" oninput="this.value = this.value.toUpperCase()" required />
          <input type="text" name="locationDetails[${i}][dispatchAddress]"
            placeholder="Enter Address" aria-label="Address ${i + 1}"
            value="${escapeAttr(v.dispatchAddress.toUpperCase())}" oninput="this.value = this.value.toUpperCase()" required />
        </div>
        <div class="loc-dispatch">
          <span class="loc-title">Pick Up Details — Location ${i + 1}</span>
          <div class="loc-fields loc-fields--pickup">
            <select name="locationDetails[${i}][deliveryMode]" aria-label="Pick Up Mode for location ${i + 1}">
              <option value="">Pick Up Mode</option>
              <option value="DOOR" ${sel(v.deliveryMode, "DOOR")}>DOOR</option>
              <option value="GODOWN" ${sel(v.deliveryMode, "GODOWN")}>GODOWN</option>
            </select>
            <input type="text" name="locationDetails[${i}][deliveryLocation]"
              placeholder="Pick Up Loc" value="${escapeAttr(v.deliveryLocation.toUpperCase())}" oninput="this.value = this.value.toUpperCase()" />
            <select name="locationDetails[${i}][vendorPayment]" aria-label="Payment for location ${i + 1}">
              <option value="">Payment</option>
              <option value="PAID" ${sel(v.vendorPayment, "PAID")}>Paid</option>
              <option value="HAVE TO PAY" ${sel(v.vendorPayment, "HAVE TO PAY")}>Have to Pay</option>
            </select>
          </div>
        </div>
      </div>
    `;
  }

  window.createVendorLocationRepeater = function (opts) {
    const container = opts.container;
    const countInput = opts.countInput;

    function normalizeCount(value) {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed < 1) return 1;
      return Math.min(parsed, MAX_LOCATIONS);
    }

    function setCount(value) {
      if (!countInput || !container) return;
      const safeCount = normalizeCount(value);
      countInput.value = String(safeCount);
      const current = Array.from(container.querySelectorAll(".location-row")).map(readRowValues);
      let html = "";
      for (let i = 0; i < safeCount; i += 1) {
        html += buildRowHtml(i, current[i] || { ...EMPTY_ROW });
      }
      container.innerHTML = html;
    }

    function setRows(rows) {
      const list = (rows && rows.length ? rows : [{}])
        .slice(0, MAX_LOCATIONS)
        .map((r) => ({ ...EMPTY_ROW, ...r }));
      Object.keys(EMPTY_ROW).forEach((k) => list.forEach((r) => { r[k] = String(r[k] ?? ""); }));
      container.innerHTML = list.map((r, i) => buildRowHtml(i, r)).join("");
      countInput.value = String(list.length);
    }

    if (countInput && container) {
      setCount(countInput.value || 1);
      opts.minus?.addEventListener("click", () => setCount(Math.max(1, normalizeCount(countInput.value || 1) - 1)));
      opts.plus?.addEventListener("click", () => setCount(Math.min(MAX_LOCATIONS, normalizeCount(countInput.value || 1) + 1)));
    }

    return { setCount, setRows };
  };
})();
