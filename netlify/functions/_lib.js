// Utilidades compartidas: respuestas JSON, sesiones firmadas y cliente de Airtable.
const crypto = require("crypto");

const json = (status, body, extra) => ({ statusCode: status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...(extra || {}) }, body: JSON.stringify(body) });

// ---------- sesiones (token firmado HMAC, sin base de datos) ----------
const b64u = (s) => Buffer.from(s).toString("base64url");
const unb64u = (s) => Buffer.from(s, "base64url").toString();
function sign(payload) {
  const secret = process.env.SESSION_SECRET || "";
  const body = b64u(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return body + "." + sig;
}
function verify(token) {
  try {
    const secret = process.env.SESSION_SECRET || "";
    const [body, sig] = String(token || "").split(".");
    if (!body || !sig) return null;
    const good = crypto.createHmac("sha256", secret).update(body).digest("base64url");
    if (good.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(good), Buffer.from(sig))) return null;
    const p = JSON.parse(unb64u(body));
    if (!p.exp || p.exp < Date.now()) return null;
    return p;
  } catch { return null; }
}
function sessionFrom(event) {
  const h = event.headers.authorization || event.headers.Authorization || "";
  return verify(h.replace(/^Bearer\s+/i, ""));
}
function configured() {
  const miss = ["AIRTABLE_TOKEN", "AIRTABLE_BASE_ID", "SESSION_SECRET", "ADMIN_PASSWORD", "EMPLEADO_PASSWORD"].filter((k) => !process.env[k]);
  return miss;
}

// ---------- Airtable ----------
const BASE = () => process.env.AIRTABLE_BASE_ID;
const HDR = () => ({ authorization: "Bearer " + process.env.AIRTABLE_TOKEN, "content-type": "application/json" });
async function at(method, path, body, isContent) {
  const url = (isContent ? "https://content.airtable.com/v0/" : "https://api.airtable.com/v0/") + path;
  let last;
  for (let i = 0; i < 4; i++) {
    const r = await fetch(url, { method, headers: HDR(), body: body ? JSON.stringify(body) : undefined });
    if (r.status === 429) { await new Promise((res) => setTimeout(res, 600 * (i + 1))); continue; }
    const text = await r.text(); let out; try { out = JSON.parse(text); } catch { out = { raw: text }; }
    if (!r.ok) { const e = new Error((out.error && (out.error.message || out.error)) || ("Airtable " + r.status)); e.status = r.status; e.airtable = out; throw e; }
    return out;
  }
  throw last || new Error("Airtable: demasiadas peticiones");
}
async function listAll(table, params) {
  const out = []; let offset;
  do {
    const q = new URLSearchParams(params || {}); if (offset) q.set("offset", offset);
    const r = await at("GET", `${BASE()}/${encodeURIComponent(table)}?${q}`);
    out.push(...(r.records || [])); offset = r.offset;
  } while (offset);
  return out;
}
const findByField = async (table, field, value) => (await listAll(table, { filterByFormula: `{${field}}='${String(value).replace(/'/g, "\\'")}'`, maxRecords: 1 }))[0] || null;
const createRec = (table, fields) => at("POST", `${BASE()}/${encodeURIComponent(table)}`, { records: [{ fields }], typecast: true }).then((r) => r.records[0]);
const updateRec = (table, recId, fields) => at("PATCH", `${BASE()}/${encodeURIComponent(table)}/${recId}`, { fields, typecast: true });
const deleteRec = (table, recId) => at("DELETE", `${BASE()}/${encodeURIComponent(table)}/${recId}`);
const uploadAttachment = (recId, field, { contentType, filename, base64 }) => at("POST", `${BASE()}/${recId}/${encodeURIComponent(field)}/uploadAttachment`, { contentType, filename, file: base64 }, true);

module.exports = { json, sign, verify, sessionFrom, configured, at, listAll, findByField, createRec, updateRec, deleteRec, uploadAttachment, BASE };
