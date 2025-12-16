const crypto = require("crypto");

function isoNow() {
  return new Date().toISOString();
}
function monthKey(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function getDeviceKey(deviceId, pepper) {
  const p = pepper || "";
  const s = `${String(deviceId || "")}|${p}`;
  return crypto.createHash("sha256").update(s).digest("hex");
}

function ensureDb(db) {
  if (!db || typeof db !== "object") db = {};
  if (!db.meta) db.meta = {};
  if (!db.devices) db.devices = {};
  if (!db.promos) db.promos = {};
  if (!db.promos.monthly) {
    db.promos.monthly = {
      enabled: true,
      percent: 10,
      maxDiscount: 5000,
      minAmount: 1000,
    };
  }
  if (!db.promos.custom) db.promos.custom = {};
  if (!db.usage) db.usage = {};
  return db;
}

function computeDiscount({ amount, type, value, maxDiscount }) {
  let disc = 0;
  if (type === "percent") disc = Math.floor((amount * Number(value || 0)) / 100);
  if (type === "fixed") disc = Math.floor(Number(value || 0));
  if (!Number.isFinite(disc)) disc = 0;
  if (maxDiscount != null) disc = Math.min(disc, Math.floor(Number(maxDiscount || 0)));
  disc = clamp(disc, 0, amount);
  return disc;
}

function applyMonthly(db, deviceKey, amount) {
  const mconf = db.promos.monthly || {};
  if (!mconf.enabled) return null;

  const minAmount = Number(mconf.minAmount || 0);
  if (amount < minAmount) return null;

  const dk = db.devices[deviceKey] || {};
  const mk = monthKey(new Date());

  const used = dk.monthlyPromo && dk.monthlyPromo.month === mk && dk.monthlyPromo.used;
  if (used) return null;

  const percent = Number(mconf.percent || 0);
  const maxDiscount = mconf.maxDiscount != null ? Number(mconf.maxDiscount) : null;

  const discount = computeDiscount({
    amount,
    type: "percent",
    value: percent,
    maxDiscount,
  });

  if (discount <= 0) return null;

  dk.firstSeen = dk.firstSeen || isoNow();
  dk.monthlyPromo = { month: mk, used: true, usedAt: isoNow() };
  db.devices[deviceKey] = dk;

  return {
    kind: "monthly",
    code: "MONTHLY_FIRST",
    discount,
    detail: { percent, maxDiscount, minAmount },
  };
}

function applyCustom(db, deviceKey, amount, promoCodeRaw) {
  const code = String(promoCodeRaw || "").trim().toUpperCase();
  if (!code) return null;

  const p = db.promos.custom[code];
  if (!p || !p.enabled) return null;

  const now = Date.now();
  if (p.expiresAt) {
    const ex = Date.parse(p.expiresAt);
    if (Number.isFinite(ex) && now > ex) return null;
  }

  const minAmount = Number(p.minAmount || 0);
  if (amount < minAmount) return null;

  const usage = db.usage[code] || { usedCount: 0, perDevice: {} };
  const usedCount = Number(usage.usedCount || 0);
  const usageLimit = p.usageLimit != null ? Number(p.usageLimit) : null;
  if (usageLimit != null && usedCount >= usageLimit) return null;

  const perDeviceLimit = p.perDeviceLimit != null ? Number(p.perDeviceLimit) : null;
  const usedByDevice = Number((usage.perDevice || {})[deviceKey] || 0);
  if (perDeviceLimit != null && usedByDevice >= perDeviceLimit) return null;

  const type = p.type === "fixed" ? "fixed" : "percent";
  const value = Number(p.value || 0);
  const maxDiscount = p.maxDiscount != null ? Number(p.maxDiscount) : null;

  const discount = computeDiscount({ amount, type, value, maxDiscount });
  if (discount <= 0) return null;

  usage.usedCount = usedCount + 1;
  usage.perDevice = usage.perDevice || {};
  usage.perDevice[deviceKey] = usedByDevice + 1;
  db.usage[code] = usage;

  return {
    kind: "custom",
    code,
    discount,
    detail: {
      type,
      value,
      maxDiscount,
      minAmount,
      expiresAt: p.expiresAt || null,
    },
  };
}

function applyDiscount(db, { amount, deviceId, pepper, promoCode }) {
  db = ensureDb(db);
  const deviceKey = getDeviceKey(deviceId, pepper);

  let applied = null;

  if (promoCode) {
    applied = applyCustom(db, deviceKey, amount, promoCode);
  }

  if (!applied) {
    applied = applyMonthly(db, deviceKey, amount);
  }

  if (!applied) {
    return {
      db,
      changed: false,
      result: {
        amountOriginal: amount,
        amountFinal: amount,
        discount: 0,
        applied: null,
      },
    };
  }

  const finalAmount = Math.max(1, amount - applied.discount);

  return {
    db,
    changed: true,
    result: {
      amountOriginal: amount,
      amountFinal: finalAmount,
      discount: applied.discount,
      applied,
    },
  };
}

function adminSetMonthlyPromo(db, payload) {
  db = ensureDb(db);
  const enabled = payload.enabled !== undefined ? !!payload.enabled : true;

  db.promos.monthly = {
    enabled,
    percent: Number(payload.percent ?? db.promos.monthly.percent ?? 10),
    maxDiscount: payload.maxDiscount ?? db.promos.monthly.maxDiscount ?? 5000,
    minAmount: payload.minAmount ?? db.promos.monthly.minAmount ?? 1000,
  };

  db.meta.updatedAt = isoNow();
  db.meta.updatedBy = "adminSetMonthlyPromo";
  return db;
}

function adminUpsertCustomPromo(db, payload) {
  db = ensureDb(db);
  const code = String(payload.code || "").trim().toUpperCase();
  if (!code) throw new Error("code required");

  const promo = {
    enabled: payload.enabled !== undefined ? !!payload.enabled : true,
    type: payload.type === "fixed" ? "fixed" : "percent",
    value: Number(payload.value ?? 0),
    minAmount: Number(payload.minAmount ?? 0),
    maxDiscount: payload.maxDiscount ?? null,
    expiresAt: payload.expiresAt || null,
    usageLimit: payload.usageLimit ?? null,
    perDeviceLimit: payload.perDeviceLimit ?? 1,
  };

  db.promos.custom[code] = promo;

  db.meta.updatedAt = isoNow();
  db.meta.updatedBy = "adminUpsertCustomPromo";
  return { db, code, promo };
}

function adminListPromos(db) {
  db = ensureDb(db);
  return {
    monthly: db.promos.monthly,
    custom: db.promos.custom,
  };
}

module.exports = {
  getDeviceKey,
  applyDiscount,
  adminSetMonthlyPromo,
  adminUpsertCustomPromo,
  adminListPromos,
};
