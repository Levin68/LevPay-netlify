// netlify/functions/orkut.js
// LevPay Proxy (Netlify) -> VPS + GitHub DB (promo/voucher)
// Endpoint: /api/orkut?action=...

const crypto = require("crypto");
const { loadDb, saveDb } = require("../../lib/github");
const {
  getDeviceKey,
  applyDiscount,
  recordPromoUsage,
  adminUpsertCustomPromo,
  adminSetMonthlyPromo,
} = require("../../lib/voucher");

// ===== CONFIG (ENV) =====
const VPS_BASE = process.env.VPS_BASE || "http://82.27.2.229:5021";
const CALLBACK_SECRET = process.env.CALLBACK_SECRET || ""; // optional lock for setstatus
const ADMIN_KEY = process.env.ADMIN_KEY || ""; // for admin promo endpoints
const DEVICE_PEPPER = process.env.DEVICE_PEPPER || "levpay_pepper_random_please_change";

// GitHub DB file
const GH_OWNER = process.env.GH_OWNER || "";
const GH_REPO = process.env.GH_REPO || "";
const GH_BRANCH = process.env.GH_BRANCH || "main";
const GH_PATH = process.env.GH_PATH || "database.json";
const GH_TOKEN = process.env.GH_TOKEN || "";

// ===== Helpers =====
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Callback-Secret, X-Admin-Key",
    "Cache-Control": "no-store",
  };
}

function ok(statusCode, obj, extra = {}) {
  return {
    statusCode,
    headers: { ...corsHeaders(), ...extra },
    body: JSON.stringify(obj),
  };
}

function isAdmin(event) {
  if (!ADMIN_KEY) return false;
  const got =
    (event.headers["x-admin-key"] || event.headers["X-Admin-Key"] || "").toString().trim() ||
    (event.headers.authorization || "").toString().replace(/^Bearer\s+/i, "").trim();
  return got === ADMIN_KEY;
}

function requireCallbackSecret(event) {
  if (!CALLBACK_SECRET) return true;
  const got =
    (event.headers["x-callback-secret"] || event.headers["X-Callback-Secret"] || "").toString().trim() ||
    (event.headers.authorization || "").toString().replace(/^Bearer\s+/i, "").trim();
  return got === CALLBACK_SECRET;
}

function getBaseUrl(event) {
  // Netlify headers
  const proto = (event.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host = event.headers["x-forwarded-host"] || event.headers.host;
  return `${proto}://${host}`;
}

function parseJsonBody(event) {
  try {
    return event.body ? JSON.parse(event.body) : {};
  } catch {
    return {};
  }
}

function qs(event, key) {
  return (event.queryStringParameters && event.queryStringParameters[key]) || "";
}

// ===== Main handler =====
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: corsHeaders(), body: "" };
  }

  const action = String(qs(event, "action") || "").toLowerCase().trim();
  const baseUrl = getBaseUrl(event);

  // ping/info
  if (!action || action === "ping") {
    return ok(200, {
      success: true,
      service: "levpay-netlify-proxy",
      vps: VPS_BASE,
      routes: [
        "POST /api/orkut?action=createqr",
        "GET  /api/orkut?action=status&idTransaksi=...",
        "POST /api/orkut?action=cancel",
        "GET  /api/orkut?action=qr&idTransaksi=...",
        "POST /api/orkut?action=setstatus (optional locked)",
        "",
        "ADMIN (need X-Admin-Key or Bearer ADMIN_KEY):",
        "POST /api/orkut?action=admin_monthly_promo",
        "POST /api/orkut?action=admin_custom_promo",
      ],
    });
  }

  // ===== CREATE QR =====
  if (action === "createqr") {
    if (event.httpMethod !== "POST") return ok(405, { success: false, error: "Method Not Allowed" });

    const body = parseJsonBody(event);
    const amount = Number(body.amount);
    const theme = body.theme === "theme1" ? "theme1" : "theme2";

    if (!Number.isFinite(amount) || amount < 1) {
      return ok(400, { success: false, error: "amount invalid" });
    }

    // device key (best-effort)
    const deviceKey = getDeviceKey({
      headers: event.headers,
      ip:
        (event.headers["x-forwarded-for"] || "").split(",")[0]?.trim() ||
        event.headers["client-ip"] ||
        "unknown",
      deviceId: body.deviceId || "",
    });

    // Load DB from GitHub
    const gh = { owner: GH_OWNER, repo: GH_REPO, branch: GH_BRANCH, path: GH_PATH, token: GH_TOKEN };
    const dbPack = await loadDb(gh); // { db, sha }
    const db = dbPack.db;

    // Apply promo discount (monthly first + optional custom code)
    const promoCode = String(body.promoCode || "").trim();
    const pricing = applyDiscount({
      db,
      amount,
      deviceKey,
      promoCode,
      now: new Date(),
    });

    // Proxy to VPS with FINAL amount (after discount)
    const vpsRes = await fetch(`${VPS_BASE}/api/createqr`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: pricing.amountFinal, theme }),
    });

    const vpsData = await vpsRes.json().catch(async () => ({ raw: await vpsRes.text() }));

    if (!vpsRes.ok) {
      return ok(vpsRes.status, { success: false, error: "VPS createqr failed", provider: vpsData });
    }

    const idTransaksi = vpsData?.data?.idTransaksi || vpsData?.idTransaksi;
    if (!idTransaksi) {
      return ok(500, { success: false, error: "VPS schema mismatch: missing idTransaksi", provider: vpsData });
    }

    // record promo usage if any promo applied (only AFTER VPS success)
    if (pricing.applied) {
      recordPromoUsage({
        db,
        deviceKey,
        promoCode: pricing.promoCodeApplied || "",
        type: pricing.promoType || "",
        now: new Date(),
      });

      // save db back to GitHub
      await saveDb(gh, db, dbPack.sha, `levpay: promo usage ${deviceKey}`);
    }

    const vercelQrUrl = `${baseUrl}/api/orkut?action=qr&idTransaksi=${encodeURIComponent(idTransaksi)}`;

    return ok(200, {
      ...vpsData,
      data: {
        ...(vpsData?.data || {}),
        idTransaksi,
        amountOriginal: pricing.amountOriginal,
        amountFinal: pricing.amountFinal,
        discountPercent: pricing.discountPercent,
        discountAmount: pricing.discountAmount,
        promoApplied: pricing.applied,
        promoType: pricing.promoType,
        promoCode: pricing.promoCodeApplied || null,

        // IMPORTANT: https url for frontend
        qrUrl: vercelQrUrl,
      },
    });
  }

  // ===== STATUS =====
  if (action === "status") {
    if (event.httpMethod !== "GET") return ok(405, { success: false, error: "Method Not Allowed" });

    const idTransaksi = String(qs(event, "idTransaksi") || "").trim();
    if (!idTransaksi) return ok(400, { success: false, error: "idTransaksi required" });

    const r = await fetch(`${VPS_BASE}/api/status?idTransaksi=${encodeURIComponent(idTransaksi)}`, { method: "GET" });
    const data = await r.json().catch(async () => ({ raw: await r.text() }));
    return ok(r.status, data);
  }

  // ===== CANCEL =====
  if (action === "cancel") {
    if (event.httpMethod !== "POST") return ok(405, { success: false, error: "Method Not Allowed" });

    const body = parseJsonBody(event);
    const idTransaksi = String(body.idTransaksi || qs(event, "idTransaksi") || "").trim();
    if (!idTransaksi) return ok(400, { success: false, error: "idTransaksi required" });

    const r = await fetch(`${VPS_BASE}/api/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idTransaksi }),
    });

    const data = await r.json().catch(async () => ({ raw: await r.text() }));
    return ok(r.status, data);
  }

  // ===== QR PNG STREAM =====
  // Netlify Functions -> return base64 (isBase64Encoded: true)
  if (action === "qr") {
    if (event.httpMethod !== "GET") return ok(405, { success: false, error: "Method Not Allowed" });

    const idTransaksi = String(qs(event, "idTransaksi") || "").trim();
    if (!idTransaksi) return ok(400, { success: false, error: "idTransaksi required" });

    const r = await fetch(`${VPS_BASE}/api/qr/${encodeURIComponent(idTransaksi)}.png`, { method: "GET" });
    if (!r.ok) return ok(r.status, { success: false, error: "QR not found on VPS" });

    const buf = Buffer.from(await r.arrayBuffer());
    return {
      statusCode: 200,
      headers: {
        ...corsHeaders(),
        "Content-Type": "image/png",
        "Cache-Control": "no-store",
      },
      isBase64Encoded: true,
      body: buf.toString("base64"),
    };
  }

  // ===== SET STATUS (callback to VPS) =====
  if (action === "setstatus") {
    if (event.httpMethod !== "POST") return ok(405, { success: false, error: "Method Not Allowed" });
    if (!requireCallbackSecret(event)) return ok(401, { success: false, error: "Unauthorized" });

    const body = parseJsonBody(event);
    const { idTransaksi, status, paidAt, note, paidVia } = body || {};
    if (!idTransaksi || !status) return ok(400, { success: false, error: "idTransaksi & status required" });

    const r = await fetch(`${VPS_BASE}/api/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idTransaksi, status, paidAt, note, paidVia }),
    });

    const data = await r.json().catch(async () => ({ raw: await r.text() }));
    return ok(r.status, data);
  }

  // ===== ADMIN: set monthly promo (promo #1) =====
  // body: { enabled: true, percent: 10, resetEveryMonths: 1 }
  if (action === "admin_monthly_promo") {
    if (event.httpMethod !== "POST") return ok(405, { success: false, error: "Method Not Allowed" });
    if (!isAdmin(event)) return ok(401, { success: false, error: "Unauthorized" });

    const body = parseJsonBody(event);
    const gh = { owner: GH_OWNER, repo: GH_REPO, branch: GH_BRANCH, path: GH_PATH, token: GH_TOKEN };
    const dbPack = await loadDb(gh);
    const db = dbPack.db;

    adminSetMonthlyPromo(db, {
      enabled: body.enabled !== false,
      percent: Number(body.percent || 0),
      resetEveryMonths: Number(body.resetEveryMonths || 1),
    });

    await saveDb(gh, db, dbPack.sha, "levpay: update monthly promo");
    return ok(200, { success: true, data: db.promo?.monthlyFirst || null });
  }

  // ===== ADMIN: upsert custom promo (promo #2) =====
  // body: { code: "ABC", percent: 20, expiresAt: "2026-01-01T00:00:00Z", maxUses: 100, active: true }
  if (action === "admin_custom_promo") {
    if (event.httpMethod !== "POST") return ok(405, { success: false, error: "Method Not Allowed" });
    if (!isAdmin(event)) return ok(401, { success: false, error: "Unauthorized" });

    const body = parseJsonBody(event);
    const gh = { owner: GH_OWNER, repo: GH_REPO, branch: GH_BRANCH, path: GH_PATH, token: GH_TOKEN };
    const dbPack = await loadDb(gh);
    const db = dbPack.db;

    const out = adminUpsertCustomPromo(db, body);
    await saveDb(gh, db, dbPack.sha, `levpay: upsert custom promo ${out.code}`);
    return ok(200, { success: true, data: out });
  }

  return ok(404, { success: false, error: "Unknown action", hint: "action=createqr|status|cancel|qr|setstatus|admin_monthly_promo|admin_custom_promo" });
};
