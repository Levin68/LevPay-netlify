const axios = require("axios");
const { loadDb, saveDb } = require("../../lib/github");
const {
  applyDiscount,
  adminSetMonthlyPromo,
  adminUpsertCustomPromo,
  adminListPromos,
} = require("../../lib/voucher");

const VPS_BASE = process.env.VPS_BASE || "http://82.27.2.229:5021";
const CALLBACK_SECRET = process.env.CALLBACK_SECRET || "";
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const DEVICE_PEPPER = process.env.DEVICE_PEPPER || "change_me";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Callback-Secret, X-Admin-Key",
    "Cache-Control": "no-store",
  };
}

function baseUrlFromEvent(event) {
  const proto = (event.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host = event.headers["x-forwarded-host"] || event.headers.host;
  return `${proto}://${host}`;
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { ...corsHeaders(), "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(obj),
  };
}

function parseBody(event) {
  if (!event.body) return {};
  try {
    return JSON.parse(event.body);
  } catch {
    return {};
  }
}

function requireSecret(event) {
  if (!CALLBACK_SECRET) return true;
  const got =
    (event.headers["x-callback-secret"] || "").toString().trim() ||
    (event.headers.authorization || "").toString().replace(/^Bearer\s+/i, "").trim();
  return got === CALLBACK_SECRET;
}

function requireAdmin(event) {
  if (!ADMIN_KEY) return false;
  const got =
    (event.headers["x-admin-key"] || "").toString().trim() ||
    (event.headers.authorization || "").toString().replace(/^Bearer\s+/i, "").trim();
  return got === ADMIN_KEY;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: corsHeaders(), body: "" };
  }

  const qs = event.queryStringParameters || {};
  const action = String(qs.action || "").toLowerCase().trim();
  const baseUrl = baseUrlFromEvent(event);

  if (!action || action === "ping") {
    return json(200, {
      success: true,
      service: "levpay-netlify-proxy",
      vps: VPS_BASE,
      routes: [
        "GET  /api/orkut?action=ping",
        "POST /api/orkut?action=createqr",
        "GET  /api/orkut?action=status&idTransaksi=...",
        "POST /api/orkut?action=cancel",
        "GET  /api/orkut?action=qr&idTransaksi=...",
        "POST /api/orkut?action=setstatus",
        "POST /api/orkut?action=admin_set_monthly",
        "POST /api/orkut?action=admin_upsert_promo",
        "GET  /api/orkut?action=admin_list_promos",
      ],
    });
  }

  if (action === "createqr") {
    if (event.httpMethod !== "POST") return json(405, { success: false, error: "Method Not Allowed" });

    const body = parseBody(event);
    const amount = Number(body.amount);
    const theme = body.theme === "theme2" ? "theme2" : "theme1";
    const deviceId = String(body.deviceId || "").trim();
    const promoCode = String(body.promoCode || "").trim();

    if (!Number.isFinite(amount) || amount < 1) {
      return json(400, { success: false, error: "amount invalid" });
    }
    if (!deviceId) {
      return json(400, { success: false, error: "deviceId required" });
    }

    let db = await loadDb(process.env);

    const applied = applyDiscount(db, {
      amount,
      deviceId,
      pepper: DEVICE_PEPPER,
      promoCode: promoCode || null,
    });

    db = applied.db;
    if (applied.changed) {
      try {
        await saveDb(process.env, db);
      } catch (e) {
        return json(500, { success: false, error: `saveDb failed: ${e.message}` });
      }
    }

    const finalAmount = applied.result.amountFinal;

    try {
      const r = await axios.post(
        `${VPS_BASE}/api/createqr`,
        { amount: finalAmount, theme },
        { timeout: 20000, validateStatus: () => true, headers: { "Content-Type": "application/json" } }
      );

      const data = r.data;

      if (r.status !== 200) {
        return json(r.status, { success: false, error: "VPS createqr failed", provider: data });
      }

      const idTransaksi = data?.data?.idTransaksi || data?.idTransaksi;
      const vpsQrPngUrl =
        data?.data?.qrPngUrl || data?.qrPngUrl || (idTransaksi ? `/api/qr/${idTransaksi}.png` : null);

      const qrUrl = idTransaksi
        ? `${baseUrl}/api/orkut?action=qr&idTransaksi=${encodeURIComponent(idTransaksi)}`
        : null;

      return json(200, {
        ...data,
        data: {
          ...(data?.data || {}),
          idTransaksi,
          qrUrl,
          qrVpsUrl: idTransaksi && vpsQrPngUrl ? `${VPS_BASE}${vpsQrPngUrl}` : null,
          pricing: applied.result,
        },
      });
    } catch (e) {
      return json(500, { success: false, error: e.message || "createqr error" });
    }
  }

  if (action === "status") {
    if (event.httpMethod !== "GET") return json(405, { success: false, error: "Method Not Allowed" });

    const idTransaksi = String(qs.idTransaksi || "").trim();
    if (!idTransaksi) return json(400, { success: false, error: "idTransaksi required" });

    try {
      const r = await axios.get(`${VPS_BASE}/api/status?idTransaksi=${encodeURIComponent(idTransaksi)}`, {
        timeout: 15000,
        validateStatus: () => true,
      });
      return json(r.status, r.data);
    } catch (e) {
      return json(500, { success: false, error: e.message || "status error" });
    }
  }

  if (action === "cancel") {
    if (event.httpMethod !== "POST") return json(405, { success: false, error: "Method Not Allowed" });

    const body = parseBody(event);
    const idTransaksi = String(body.idTransaksi || qs.idTransaksi || "").trim();
    if (!idTransaksi) return json(400, { success: false, error: "idTransaksi required" });

    try {
      const r = await axios.post(
        `${VPS_BASE}/api/cancel`,
        { idTransaksi },
        { timeout: 15000, validateStatus: () => true, headers: { "Content-Type": "application/json" } }
      );
      return json(r.status, r.data);
    } catch (e) {
      return json(500, { success: false, error: e.message || "cancel error" });
    }
  }

  if (action === "qr") {
    if (event.httpMethod !== "GET") return json(405, { success: false, error: "Method Not Allowed" });

    const idTransaksi = String(qs.idTransaksi || "").trim();
    if (!idTransaksi) return json(400, { success: false, error: "idTransaksi required" });

    try {
      const r = await axios.get(`${VPS_BASE}/api/qr/${encodeURIComponent(idTransaksi)}.png`, {
        responseType: "arraybuffer",
        timeout: 20000,
        validateStatus: () => true,
      });

      if (r.status !== 200) {
        return json(r.status, { success: false, error: "QR not found on VPS" });
      }

      const b64 = Buffer.from(r.data).toString("base64");
      return {
        statusCode: 200,
        headers: { ...corsHeaders(), "Content-Type": "image/png" },
        body: b64,
        isBase64Encoded: true,
      };
    } catch (e) {
      return json(500, { success: false, error: e.message || "qr error" });
    }
  }

  if (action === "setstatus") {
    if (event.httpMethod !== "POST") return json(405, { success: false, error: "Method Not Allowed" });
    if (!requireSecret(event)) return json(401, { success: false, error: "Unauthorized" });

    const body = parseBody(event);
    const { idTransaksi, status, paidAt, note, paidVia } = body || {};
    if (!idTransaksi || !status) {
      return json(400, { success: false, error: "idTransaksi & status required" });
    }

    try {
      const r = await axios.post(
        `${VPS_BASE}/api/status`,
        { idTransaksi, status, paidAt, note, paidVia },
        { timeout: 15000, validateStatus: () => true, headers: { "Content-Type": "application/json" } }
      );
      return json(r.status, r.data);
    } catch (e) {
      return json(500, { success: false, error: e.message || "setstatus error" });
    }
  }

  if (action === "admin_set_monthly") {
    if (event.httpMethod !== "POST") return json(405, { success: false, error: "Method Not Allowed" });
    if (!requireAdmin(event)) return json(401, { success: false, error: "Unauthorized" });

    const body = parseBody(event);

    try {
      let db = await loadDb(process.env);
      db = adminSetMonthlyPromo(db, body || {});
      await saveDb(process.env, db);
      return json(200, { success: true, data: db.promos.monthly });
    } catch (e) {
      return json(500, { success: false, error: e.message || "admin_set_monthly error" });
    }
  }

  if (action === "admin_upsert_promo") {
    if (event.httpMethod !== "POST") return json(405, { success: false, error: "Method Not Allowed" });
    if (!requireAdmin(event)) return json(401, { success: false, error: "Unauthorized" });

    const body = parseBody(event);

    try {
      let db = await loadDb(process.env);
      const r = adminUpsertCustomPromo(db, body || {});
      await saveDb(process.env, r.db);
      return json(200, { success: true, data: { code: r.code, promo: r.promo } });
    } catch (e) {
      return json(500, { success: false, error: e.message || "admin_upsert_promo error" });
    }
  }

  if (action === "admin_list_promos") {
    if (event.httpMethod !== "GET") return json(405, { success: false, error: "Method Not Allowed" });
    if (!requireAdmin(event)) return json(401, { success: false, error: "Unauthorized" });

    try {
      const db = await loadDb(process.env);
      return json(200, { success: true, data: adminListPromos(db) });
    } catch (e) {
      return json(500, { success: false, error: e.message || "admin_list_promos error" });
    }
  }

  return json(404, {
    success: false,
    error: "Unknown action",
    hint: "ping|createqr|status|cancel|qr|setstatus|admin_set_monthly|admin_upsert_promo|admin_list_promos",
  });
};
