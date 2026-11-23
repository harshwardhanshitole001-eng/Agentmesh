"use strict";
// AgentMesh backend: zero dependencies, Node >= 18.
const http = require("http"), fs = require("fs"), path = require("path"), net = require("net");
const dns = require("dns").promises;

const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, "public");
const DB = path.join(__dirname, "data", "registry.json");
const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE === "1"; // set for local testing only
const PATHS = ["/.network.json", "/.well-known/network.json", "/agent-manifest.json", "/.well-known/agent-manifest.json", "/network.json"];
const MIME = { ".html": "text/html; charset=utf-8", ".json": "application/json", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

/* ---------- helpers ---------- */
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type,Authorization" };
const send = (res, code, body, type = "application/json") => { res.writeHead(code, { ...CORS, "Content-Type": type, "Cache-Control": "no-cache" }); res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
const hits = new Map();
const limited = ip => { const n = Date.now(), a = (hits.get(ip) || []).filter(t => n - t < 60000); a.push(n); hits.set(ip, a); return a.length > 60; };
setInterval(() => hits.clear(), 300000).unref();

function isPrivate(ip) {
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  if (net.isIPv6(ip)) return ip === "::1" || ip === "::" || /^f[cd]/i.test(ip) || /^fe80/i.test(ip);
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}
async function safeUrl(u) {
  const url = new URL(u);
  if (!/^https?:$/.test(url.protocol)) throw new Error("Blocked: only http(s) URLs");
  if (!ALLOW_PRIVATE) {
    const ips = net.isIP(url.hostname) ? [{ address: url.hostname }] : await dns.lookup(url.hostname, { all: true });
    if (ips.some(i => isPrivate(i.address))) throw new Error("Blocked: private or local address");
  }
  return url;
}
async function fetchSafe(u, opt = {}, hop = 0) { // SSRF-guarded fetch, manual redirects, 7s timeout
  const url = await safeUrl(u);
  const r = await fetch(url, { ...opt, redirect: "manual", signal: AbortSignal.timeout(7000) });
  const loc = r.headers.get("location");
  if (r.status >= 300 && r.status < 400 && loc && hop < 3) return fetchSafe(new URL(loc, url).href, opt, hop + 1);
  return r;
}
async function readCapped(r) { const b = Buffer.from(await r.arrayBuffer()); if (b.length > 1e6) throw new Error("Response too large"); return b.toString("utf8"); }
function readBody(req) {
  return new Promise((ok, no) => { let s = ""; req.on("data", c => { s += c; if (s.length > 2e5) { no(new Error("Body too large")); req.destroy(); } }); req.on("end", () => { try { ok(s ? JSON.parse(s) : {}); } catch { no(new Error("Invalid JSON body")); } }); });
}

/* ---------- discovery + validation ---------- */
async function scanRemote(input) {
  let u = String(input || "").trim(); if (!u) throw new Error("url is required");
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  const url = new URL(u), dir = url.href.replace(/[^/]*$/, "");
  const cands = url.pathname.endsWith(".json") ? [url.href] : [...new Set([...PATHS.map(p => url.origin + p), ...PATHS.map(p => dir + p.slice(1))])];
  for (const c of cands) {
    try {
      const r = await fetchSafe(c, { headers: { accept: "application/json" } }); if (!r.ok) continue;
      const manifest = JSON.parse(await readCapped(r));
      if (manifest && typeof manifest === "object" && !Array.isArray(manifest)) return { manifest, source: c, origin: url.origin };
    } catch (e) { if (/^Blocked|Invalid URL/.test(e.message)) throw e; }
  }
  throw new Error("No manifest found at the usual paths");
}
function validate(m) {
  const issues = []; let score = 100; const bad = (t, n) => { issues.push(t); score -= n; };
  if (!m.name) bad("Missing name", 15);
  if (!m.description) bad("Missing description", 10);
  if (!m.url && !m.entry) bad("Missing url or entry point", 10);
  const tl = m.tools || m.capabilities || m.skills || m.actions;
  if (!Array.isArray(tl) || !tl.length) bad("No tools declared", 40);
  else tl.forEach((t, i) => {
    const n = (t && t.name) || "tool #" + (i + 1);
    if (!t.description) bad(`${n}: missing description`, 5);
    if (!(t.inputSchema || t.input_schema || t.parameters)) bad(`${n}: missing input schema`, 5);
    if (!t.endpoint && !t.url && !m.endpoint) bad(`${n}: no HTTP endpoint (callable only via postMessage)`, 2);
  });
  return { score: Math.max(0, score), issues };
}

/* ---------- registry (JSON file persistence) ---------- */
let reg = []; try { reg = JSON.parse(fs.readFileSync(DB, "utf8")); } catch {}
const save = () => { fs.mkdirSync(path.dirname(DB), { recursive: true }); fs.writeFileSync(DB + ".tmp", JSON.stringify(reg)); fs.renameSync(DB + ".tmp", DB); };
function register(r) {
  const entry = { origin: r.origin, source: r.source, manifest: r.manifest, score: validate(r.manifest).score, addedAt: new Date().toISOString() };
  reg = [entry, ...reg.filter(e => e.origin !== r.origin)].slice(0, 500); save(); return entry;
}
const brief = e => ({ origin: e.origin, name: e.manifest.name || e.origin, tools: (e.manifest.tools || e.manifest.capabilities || []).length, score: e.score, addedAt: e.addedAt });

/* ---------- own manifest (origin injected per request) ---------- */
function ownManifest(req) {
  const proto = req.headers["x-forwarded-proto"] || "http";
  return fs.readFileSync(path.join(__dirname, "manifest.template.json"), "utf8").replaceAll("__ORIGIN__", `${proto}://${req.headers.host}`);
}

/* ---------- server ---------- */
http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x"), p = decodeURIComponent(url.pathname);
  const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress;
  try {
    if (req.method === "OPTIONS") return send(res, 204, "");
    if (["/.network.json", "/agent-manifest.json", "/.well-known/network.json", "/.well-known/agent-manifest.json"].includes(p)) return send(res, 200, ownManifest(req));
    if (p.startsWith("/api/")) {
      if (limited(ip)) return send(res, 429, { error: "Rate limit: 60 requests per minute" });
      if (p === "/api/health") return send(res, 200, { ok: true, agents: reg.length, uptime: Math.round(process.uptime()) });
      if (p === "/api/scan" && req.method === "GET") return send(res, 200, await scanRemote(url.searchParams.get("url")));
      if (p === "/api/registry" && req.method === "GET") return send(res, 200, { agents: reg });
      if (p === "/api/registry" && req.method === "POST") { const b = await readBody(req); return send(res, 200, brief(register(await scanRemote(b.url)))); } // server re-fetches, so entries can't be spoofed
      if (p === "/api/validate" && req.method === "POST") { const b = await readBody(req); return send(res, 200, validate(b.manifest || {})); }
      if (p === "/api/relay" && req.method === "POST") { // server-side tool call for sites without CORS
        const b = await readBody(req);
        const r = await fetchSafe(b.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b.body || {}) });
        return send(res, r.status, await readCapped(r), r.headers.get("content-type") || "application/json");
      }
      if (req.method === "POST" && p.startsWith("/api/tools/")) { // AgentMesh's own callable tools
        const b = await readBody(req), t = p.slice(11);
        if (t === "scan_url") return send(res, 200, await scanRemote(b.url));
        if (t === "validate_manifest") { const r = await scanRemote(b.url); return send(res, 200, { origin: r.origin, ...validate(r.manifest) }); }
        if (t === "list_agents") return send(res, 200, { agents: reg.map(brief) });
        return send(res, 404, { error: "Unknown tool" });
      }
      return send(res, 404, { error: "Not found" });
    }
    const f = path.normalize(path.join(PUB, p === "/" ? "index.html" : p));
    if (!f.startsWith(PUB) || !fs.existsSync(f) || !fs.statSync(f).isFile()) return send(res, 404, "Not found", "text/plain");
    send(res, 200, fs.readFileSync(f), MIME[path.extname(f)] || "application/octet-stream");
  } catch (e) { send(res, /^Blocked/.test(e.message) ? 403 : 502, { error: e.message }); }
}).listen(PORT, () => console.log(`AgentMesh running on http://localhost:${PORT}`));
