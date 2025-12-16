// lib/voucher.js
// Promo logic:
// #1 monthlyFirst: diskon untuk device per bulan (reset 1 bulan)
// #2 custom promo: code + percent + expiresAt + maxUses

function monthKey(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function clampPercent(p) {
  const x = Number(p || 0);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(100, x));
}

function getDeviceKey({ headers, ip, deviceId }) {
  // best-effort only
  const did =
    (headers["x-device-id"] || headers["X-Device-Id"] || "").toString().trim() ||
    String(deviceId || "").trim();

  if (did) return `dev:${did}`;
  if (ip) return `ip:${ip}`;
  return "unknown";
}

function ensureDevice(db, deviceKey) {
  db.devices = db.devices || {};
  if (!db.devices[deviceKey]) db.devices[deviceKey] = { monthlyUsed: {} };
  if (!db.devices[deviceKey].monthlyUsed) db.devices[deviceKey].monthlyUsed = {};
  return db.devices[deviceKey];
}

function applyDiscount({ db, amount, deviceKey, promoCode, now }) {
  const amountOriginal = Number(amount);
  const m = monthKey(now);

  const monthly = db?.promo?.monthlyFirst || { enabled: false, percent: 0, resetEveryMonths: 1 };
  const customMap = db?.promo?.custom || {};

  let applied = false;
  let promoType = null;
  let promoCodeApplied = null;
  let discountPercent = 0;

  // custom code first (lebih “kuat”)
  const code = String(promoCode || "").trim().toUpperCase();
  if (code && customMap[code]) {
    const c = customMap[code];
    const active = c.active !== false;
    const pct = clampPercent(c.percent);
    const used = Number(c.used || 0);
    const maxUses = c.maxUses == null ? null : Number(c.maxUses);
    const exp = c.expiresAt ? Date.parse(c.expiresAt) : null;

    const notExpired = exp ? Date.now() <= exp : true;
    const underLimit = maxUses == null ? true : used < maxUses;

    if (active && pct > 0 && notExpired && underLimit) {
      applied = true;
      promoType = "custom";
      promoCodeApplied = code;
      discountPercent = pct;
    }
  }

  // monthly promo if no custom applied
  if (!applied && monthly.enabled) {
    const pct = clampPercent(monthly.percent);
    if (pct > 0) {
      const dev = ensureDevice(db, deviceKey);
      const usedThisMonth = !!dev.monthlyUsed[m];
      if (!usedThisMonth) {
        applied = true;
        promoType = "monthlyFirst";
        promoCodeApplied = null;
        discountPercent = pct;
      }
    }
  }

  const discountAmount = Math.floor((amountOriginal * discountPercent) / 100);
  const amountFinal = Math.max(1, amountOriginal - discountAmount);

  return {
    applied,
    promoType,
    promoCodeApplied,
    amountOriginal,
    discountPercent,
    discountAmount,
    amountFinal,
  };
}

function recordPromoUsage({ db, deviceKey, promoCode, type, now }) {
  if (!db) return;

  if (type === "monthlyFirst") {
    const dev = ensureDevice(db, deviceKey);
    const m = monthKey(now);
    dev.monthlyUsed[m] = true;
  }

  if (type === "custom") {
    const code = String(promoCode || "").trim().toUpperCase();
    if (!code) return;
    db.promo = db.promo || {};
    db.promo.custom = db.promo.custom || {};
    const c = db.promo.custom[code];
    if (!c) return;
    c.used = Number(c.used || 0) + 1;
    db.promo.custom[code] = c;
  }
}

// ===== Admin helpers =====
function adminSetMonthlyPromo(db, { enabled, percent, resetEveryMonths }) {
  db.promo = db.promo || {};
  db.promo.monthlyFirst = {
    enabled: enabled !== false,
    percent: clampPercent(percent),
    resetEveryMonths: Math.max(1, Number(resetEveryMonths || 1)),
  };
  return db.promo.monthlyFirst;
}

function adminUpsertCustomPromo(db, body) {
  const code = String(body.code || "").trim().toUpperCase();
  if (!code) throw new Error("code required");

  db.promo = db.promo || {};
  db.promo.custom = db.promo.custom || {};

  const cur = db.promo.custom[code] || {};
  const next = {
    code,
    percent: clampPercent(body.percent ?? cur.percent ?? 0),
    expiresAt: body.expiresAt ?? cur.expiresAt ?? null,
    active: body.active ?? cur.active ?? true,
    maxUses: body.maxUses ?? cur.maxUses ?? null,
    used: body.used ?? cur.used ?? 0,
  };

  db.promo.custom[code] = next;
  return next;
}

module.exports = {
  getDeviceKey,
  applyDiscount,
  recordPromoUsage,
  adminUpsertCustomPromo,
  adminSetMonthlyPromo,
};
