const axios = require("axios");

function rawUrl({ owner, repo, branch, path }) {
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
}

function apiBase() {
  return "https://api.github.com";
}

function mustEnv(name, v) {
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

async function loadDb(env) {
  const owner = mustEnv("GH_OWNER", env.GH_OWNER);
  const repo = mustEnv("GH_REPO", env.GH_REPO);
  const branch = env.GH_BRANCH || "main";
  const p = env.GH_PATH || "database.json";

  const url = rawUrl({ owner, repo, branch, path: p });

  try {
    const r = await axios.get(url, {
      timeout: 15000,
      validateStatus: () => true,
      headers: { "Cache-Control": "no-cache" },
    });

    if (r.status === 200 && r.data) {
      if (typeof r.data === "object") return r.data;
      try {
        return JSON.parse(String(r.data));
      } catch {
        return {};
      }
    }

    return {};
  } catch {
    return {};
  }
}

async function getSha({ owner, repo, path, token }) {
  const r = await axios.get(`${apiBase()}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, {
    timeout: 15000,
    validateStatus: () => true,
    headers: {
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      Accept: "application/vnd.github+json",
    },
  });

  if (r.status === 200 && r.data && r.data.sha) return r.data.sha;
  return null;
}

async function saveDb(env, db) {
  const owner = mustEnv("GH_OWNER", env.GH_OWNER);
  const repo = mustEnv("GH_REPO", env.GH_REPO);
  const branch = env.GH_BRANCH || "main";
  const path = env.GH_PATH || "database.json";
  const token = mustEnv("GH_TOKEN", env.GH_TOKEN);

  const sha = await getSha({ owner, repo, path, token });

  const contentStr = JSON.stringify(db, null, 2);
  const contentB64 = Buffer.from(contentStr, "utf8").toString("base64");

  const payload = {
    message: `update ${path}`,
    content: contentB64,
    branch,
  };
  if (sha) payload.sha = sha;

  const r = await axios.put(`${apiBase()}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, payload, {
    timeout: 20000,
    validateStatus: () => true,
    headers: {
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      Accept: "application/vnd.github+json",
    },
  });

  if (r.status !== 200 && r.status !== 201) {
    throw new Error(`GitHub save failed (${r.status}): ${JSON.stringify(r.data || {})}`);
  }

  return true;
}

module.exports = { loadDb, saveDb };
