// lib/github.js
// GitHub JSON storage via Contents API

const DEFAULT_DB = {
  version: 1,
  devices: {}, // { [deviceKey]: { monthlyUsed: { "YYYY-MM": true } } }
  promo: {
    monthlyFirst: { enabled: true, percent: 10, resetEveryMonths: 1 },
    custom: {}, // { CODE: { code, percent, expiresAt, active, maxUses, used } }
  },
};

function ghUrl(owner, repo, path, ref) {
  // Contents API
  return `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`;
}

function must(gh) {
  const missing = [];
  if (!gh.owner) missing.push("GH_OWNER");
  if (!gh.repo) missing.push("GH_REPO");
  if (!gh.branch) missing.push("GH_BRANCH");
  if (!gh.path) missing.push("GH_PATH");
  if (!gh.token) missing.push("GH_TOKEN");
  if (missing.length) throw new Error("Missing env: " + missing.join(", "));
}

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "User-Agent": "levpay-netlify",
    Accept: "application/vnd.github+json",
  };
}

async function loadDb(gh) {
  must(gh);

  const r = await fetch(ghUrl(gh.owner, gh.repo, gh.path, gh.branch), {
    method: "GET",
    headers: authHeaders(gh.token),
  });

  if (r.status === 404) {
    // file not exist -> create with default
    return { db: { ...DEFAULT_DB }, sha: null, missing: true };
  }

  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`GitHub load failed: HTTP ${r.status} ${txt}`);
  }

  const json = await r.json();
  const sha = json.sha;
  const content = json.content || "";
  const decoded = Buffer.from(content, "base64").toString("utf8");

  let db;
  try {
    db = JSON.parse(decoded);
  } catch {
    db = { ...DEFAULT_DB };
  }

  // normalize minimal schema
  if (!db || typeof db !== "object") db = { ...DEFAULT_DB };
  if (!db.devices || typeof db.devices !== "object") db.devices = {};
  if (!db.promo || typeof db.promo !== "object") db.promo = { ...DEFAULT_DB.promo };
  if (!db.promo.monthlyFirst) db.promo.monthlyFirst = { ...DEFAULT_DB.promo.monthlyFirst };
  if (!db.promo.custom) db.promo.custom = {};

  return { db, sha, missing: false };
}

async function saveDb(gh, db, sha, message = "levpay: update database.json") {
  must(gh);

  const body = {
    message,
    content: Buffer.from(JSON.stringify(db, null, 2), "utf8").toString("base64"),
    branch: gh.branch,
  };
  if (sha) body.sha = sha;

  const r = await fetch(`https://api.github.com/repos/${gh.owner}/${gh.repo}/contents/${encodeURIComponent(gh.path)}`, {
    method: "PUT",
    headers: { ...authHeaders(gh.token), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`GitHub save failed: HTTP ${r.status} ${txt}`);
  }

  const json = await r.json();
  return { ok: true, sha: json?.content?.sha || null };
}

module.exports = { loadDb, saveDb };
