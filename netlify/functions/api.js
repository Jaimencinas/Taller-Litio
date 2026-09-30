// API del panel sobre Airtable.
//   GET  /.netlify/functions/api?op=state              → todo el estado (filtrado por rol)
//   POST /.netlify/functions/api  {op:"set"|"update"|"delete"|"add", path, data|patch, files}
//   POST /.netlify/functions/api  {op:"setup"}         → crea las tablas en Airtable y carga las semillas (solo admin)
// Rutas de documento (las mismas que usaba la página):
//   encargos/{id} · notas/{encargoId} · presupuestos/{id} · config/{clave} · config/costes/analitica/{presId}
const { json, sessionFrom, configured, at, listAll, findByField, createRec, updateRec, deleteRec, uploadAttachment, BASE } = require("./_lib");
const SEED = require("./_seed.json");

const T = { enc: "Encargos", notas: "Notas", pres: "Presupuestos", config: "Config" };
const ADMIN_PRES_FIELDS = ["Coste", "Beneficio", "Margen %", "Interno"];
const newId = () => Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
const num = (v) => (v === "" || v == null || isNaN(+v) ? null : +v);
const parseJSON = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

// ---------- mapeos Airtable <-> documento ----------
const attIds = (arr) => (arr || []).map((a) => a.id);
const attMap = (arr, map) => { (arr || []).forEach((a) => { map[a.id] = { url: a.url, filename: a.filename, type: a.type }; }); };

function encToDoc(r, adj) {
  const f = r.fields; attMap(f["Fotos"], adj);
  return { id: f["ID"], ref: f["Ref"] || "", cliente: f["Cliente"] || "", tel: f["Teléfono"] || "", fecha: f["Fecha entrada"] || "", bateria: f["Batería"] || "", v: num(f["Tensión (V)"]), ah: num(f["Capacidad (Ah)"]), estado: f["Estado"] || "", almacen: f["Almacén"] || "", desc: f["Síntoma"] || "", fotos: attIds(f["Fotos"]), createdAt: num(f["Creado"]) || 0, updatedAt: num(f["Actualizado"]) || 0, creadoPor: f["Creado por"] || null };
}
function encFields(d) {
  return { "ID": d.id, "Ref": d.ref || "", "Cliente": d.cliente || "", "Teléfono": d.tel || "", "Fecha entrada": d.fecha || null, "Batería": d.bateria || "", "Tensión (V)": num(d.v), "Capacidad (Ah)": num(d.ah), "Estado": d.estado || "", "Almacén": d.almacen || "", "Síntoma": d.desc || "", "Creado": num(d.createdAt) || Date.now(), "Actualizado": num(d.updatedAt) || Date.now(), "Creado por": d.creadoPor || "" };
}
function notaToItem(r, adj) {
  const f = r.fields; attMap(f["Adjunto"], adj); const a = (f["Adjunto"] || [])[0];
  return { id: f["ID"], ts: num(f["Fecha"]) || 0, tipo: f["Tipo"] || "texto", texto: f["Texto"] || "", autor: f["Autor"] || null, autorNombre: f["Autor nombre"] || undefined, estado: f["Estado"] || "", almacen: f["Almacén"] || "", asset: a ? a.id : undefined, mime: a ? (f["Mime"] || a.type) : undefined, fileName: a ? a.filename : undefined };
}
function notaFields(encargoId, n) {
  return { "ID": n.id, "Encargo": encargoId, "Fecha": num(n.ts) || Date.now(), "Tipo": n.tipo || "texto", "Texto": n.texto || "", "Autor": n.autor || "", "Autor nombre": n.autorNombre || "", "Estado": n.estado || "", "Almacén": n.almacen || "", "Mime": n.mime || "" };
}
function presToDoc(r, admin) {
  const f = r.fields; const d = parseJSON(f["Datos"], {});
  const interno = (parseJSON(f["Interno"], {}).interno) || {};
  const doc = { ...d, interno: { costeCelda: interno.costeCelda ?? null, costeBms: interno.costeBms ?? null }, id: f["ID"], num: f["Número"] || d.num, encargoId: f["Encargo"] || d.encargoId || null, cliente: f["Cliente"] || d.cliente || "", nif: f["NIF"] || "", dir: f["Dirección"] || "", email: f["Email"] || "", bateria: f["Batería"] || "", estado: f["Estado"] || "borrador", base: num(f["Base"]) ?? d.base, iva: num(f["IVA"]) ?? d.iva, total: num(f["Total"]) ?? d.total, numFactura: f["Nº factura"] || null };
  return doc;
}
function presFields(d) {
  const { id, num: n, encargoId, cliente, nif, dir, email, bateria, estado, base, iva, total, numFactura, interno, ...rest } = d;
  return { "ID": id, "Número": n || "", "Encargo": encargoId || "", "Cliente": cliente || "", "NIF": nif || "", "Dirección": dir || "", "Email": email || "", "Batería": bateria || "", "Estado": estado || "borrador", "Base": num(base), "IVA": num(iva), "Total": num(total), "Nº factura": numFactura || "", "Datos": JSON.stringify(rest) };
}
const analToDoc = (r) => { const f = r.fields; return { presId: f["ID"], num: f["Número"], estado: f["Estado"], coste: num(f["Coste"]), beneficio: num(f["Beneficio"]), margen: num(f["Margen %"]), ...parseJSON(f["Interno"], {}) }; };
const analFields = (d) => ({ "Coste": num(d.coste), "Beneficio": num(d.beneficio), "Margen %": num(d.margen), "Interno": JSON.stringify({ interno: d.interno || {}, desglose: d.desglose || [], baseNeta: d.baseNeta }) });

// ---------- lectura del estado ----------
async function readState(admin) {
  const adj = {};
  const [enc, notas, pres, cfg] = await Promise.all([listAll(T.enc), listAll(T.notas), listAll(T.pres), listAll(T.config)]);
  const notasMap = {};
  notas.forEach((r) => { const e = r.fields["Encargo"]; if (!e) return; (notasMap[e] = notasMap[e] || { encargoId: e, items: [] }).items.push(notaToItem(r, adj)); });
  const config = {};
  cfg.forEach((r) => { const k = r.fields["Clave"]; if (!k) return; if (k === "costes" && !admin) return; config[k] = parseJSON(r.fields["JSON"], {}); });
  const analitica = {};
  if (admin) pres.forEach((r) => { if (r.fields["Coste"] != null) analitica[r.fields["ID"]] = analToDoc(r); });
  return { encargos: enc.map((r) => encToDoc(r, adj)).filter((d) => d.id), notas: notasMap, presupuestos: pres.map((r) => presToDoc(r, admin)).filter((d) => d.id), config, analitica, adjuntos: adj, ts: Date.now() };
}

// ---------- rutas ----------
function route(path) {
  const s = String(path || "").split("/").filter(Boolean);
  if (s.length === 4 && s[0] === "config" && s[1] === "costes" && s[2] === "analitica") return { kind: "analitica", id: s[3] };
  if (s.length === 2 && s[0] === "encargos") return { kind: "encargo", id: s[1] };
  if (s.length === 2 && s[0] === "notas") return { kind: "notas", id: s[1] };
  if (s.length === 2 && s[0] === "presupuestos") return { kind: "pres", id: s[1] };
  if (s.length === 2 && s[0] === "config") return { kind: "config", id: s[1] };
  if (s.length === 1 && s[0] === "encargos") return { kind: "encargo", id: null };
  if (s.length === 1 && s[0] === "presupuestos") return { kind: "pres", id: null };
  return null;
}
const isPending = (v) => typeof v === "string" && v.startsWith("pending:");
async function attachPending(recId, field, ids, files) {
  // Sube los archivos "pending:x" al registro y devuelve {pendingId: attachmentId}
  const out = {};
  for (const pid of ids) {
    const f = files && files[pid]; if (!f) continue;
    const r = await uploadAttachment(recId, field, { contentType: f.contentType, filename: f.filename, base64: f.base64 });
    const arr = (r.fields && (r.fields[field] || Object.values(r.fields)[0])) || [];
    const created = arr.find((a) => a.filename === f.filename && !Object.values(out).includes(a.id)) || arr[arr.length - 1];
    if (created) out[pid] = created.id;
  }
  return out;
}

async function writeEncargo(id, doc, files, sess) {
  const adj = {};
  const rec = await findByField(T.enc, "ID", id);
  const fields = encFields({ ...doc, id });
  let r = rec ? await updateRec(T.enc, rec.id, fields) : await createRec(T.enc, { ...fields, "Creado por": doc.creadoPor || sess.nombre });
  const fotos = Array.isArray(doc.fotos) ? doc.fotos : (r.fields["Fotos"] || []).map((a) => a.id);
  const pend = fotos.filter(isPending);
  if (pend.length) { await attachPending(r.id, "Fotos", pend, files); r = (await findByField(T.enc, "ID", id)) || r; }
  // eliminar fotos quitadas
  const keep = new Set(fotos.filter((x) => !isPending(x)));
  const current = r.fields["Fotos"] || [];
  const afterNew = current.filter((a) => keep.has(a.id) || !(rec && (rec.fields["Fotos"] || []).some((o) => o.id === a.id)));
  if (afterNew.length !== current.length) r = await updateRec(T.enc, r.id, { "Fotos": afterNew.map((a) => ({ id: a.id })) });
  return { doc: encToDoc(r, adj), adjuntos: adj };
}
async function writeNotas(encargoId, doc, files) {
  const adj = {};
  const items = Array.isArray(doc.items) ? doc.items : [];
  const existing = await listAll(T.notas, { filterByFormula: `{Encargo}='${encargoId}'` });
  const byId = new Map(existing.map((r) => [r.fields["ID"], r]));
  for (const n of items) {
    if (byId.has(n.id)) continue;
    const r = await createRec(T.notas, notaFields(encargoId, n));
    if (isPending(n.asset)) await attachPending(r.id, "Adjunto", [n.asset], files);
  }
  const wanted = new Set(items.map((n) => n.id));
  for (const r of existing) if (!wanted.has(r.fields["ID"])) await deleteRec(T.notas, r.id);
  const fresh = await listAll(T.notas, { filterByFormula: `{Encargo}='${encargoId}'` });
  return { doc: { encargoId, items: fresh.map((r) => notaToItem(r, adj)) }, adjuntos: adj };
}
async function loadCostes() {
  const r = await findByField(T.config, "Clave", "costes");
  return r ? parseJSON(r.fields["JSON"], {}) : {};
}
// Coste real del presupuesto a partir de las tarifas internas (+ ajustes internos del admin)
function calcAnalitica(doc, costes, interno) {
  interno = interno || {};
  const cCelda = interno.costeCelda != null ? +interno.costeCelda : (+(costes.celdas || {})[doc.celdaId] || 0);
  const cBms = interno.costeBms != null ? +interno.costeBms : (+(costes.bms || {})[doc.bmsId] || 0);
  const cHora = +costes.hora || 0;
  const nCeldas = +doc.nCeldas || 0, nBms = doc.nBms == null ? 1 : +doc.nBms, horas = +doc.horas || 0;
  const bmsPrecio = doc.bmsId === "custom" ? +doc.bmsPrecio : null;
  const desglose = [];
  if (nCeldas > 0 && doc.celdaId) desglose.push({ c: "Celdas", n: nCeldas, coste: cCelda, total: nCeldas * cCelda });
  if (nBms > 0 && doc.bmsId && doc.bmsId !== "b0" && (bmsPrecio == null || bmsPrecio > 0)) desglose.push({ c: "BMS", n: nBms, coste: cBms, total: nBms * cBms });
  if (horas > 0) desglose.push({ c: "Horas", n: horas, coste: cHora, total: horas * cHora });
  if (doc.diagnosis && (+costes.diagnosis || 0) > 0) desglose.push({ c: "Diagnosis", n: 1, coste: +costes.diagnosis, total: +costes.diagnosis });
  const coste = desglose.reduce((a, d) => a + d.total, 0);
  const baseNeta = (+doc.base || 0) - (+doc.dtoImp || 0);
  const beneficio = baseNeta - coste;
  return { coste, beneficio, margen: baseNeta > 0 ? beneficio / baseNeta * 100 : 0, baseNeta, desglose, interno };
}
async function writePres(id, doc, admin) {
  const rec = await findByField(T.pres, "ID", id);
  const prevInterno = rec ? (parseJSON(rec.fields["Interno"], {}).interno || {}) : {};
  const sent = doc.interno && typeof doc.interno === "object" ? doc.interno : null;
  const interno = sent ? { costeCelda: sent.costeCelda == null || sent.costeCelda === "" ? null : +sent.costeCelda, costeBms: sent.costeBms == null || sent.costeBms === "" ? null : +sent.costeBms } : prevInterno;
  const costes = await loadCostes();
  const an = calcAnalitica({ ...doc, id }, costes, interno);
  const fields = { ...presFields({ ...doc, id }), ...analFields(an) };
  const r = rec ? await updateRec(T.pres, rec.id, fields) : await createRec(T.pres, fields);
  return { doc: presToDoc(r, admin), analitica: admin ? analToDoc(r) : undefined };
}
async function writeConfig(key, data) {
  const rec = await findByField(T.config, "Clave", key);
  const fields = { "Clave": key, "JSON": JSON.stringify(data) };
  const r = rec ? await updateRec(T.config, rec.id, fields) : await createRec(T.config, fields);
  return { doc: parseJSON(r.fields["JSON"], {}) };
}
async function writeAnalitica(presId, data) {
  // El admin guarda sus ajustes internos (costes personalizados); el coste se recalcula con ellos.
  const rec = await findByField(T.pres, "ID", presId);
  if (!rec) return { doc: null };
  const costes = await loadCostes();
  const an = calcAnalitica(presToDoc(rec, true), costes, data.interno || {});
  const r = await updateRec(T.pres, rec.id, analFields(an));
  return { doc: analToDoc(r) };
}
async function readDoc(rt, admin) {
  const adj = {};
  if (rt.kind === "encargo") { const r = await findByField(T.enc, "ID", rt.id); return { doc: r ? encToDoc(r, adj) : null, adjuntos: adj }; }
  if (rt.kind === "notas") { const rs = await listAll(T.notas, { filterByFormula: `{Encargo}='${rt.id}'` }); return { doc: rs.length ? { encargoId: rt.id, items: rs.map((r) => notaToItem(r, adj)) } : null, adjuntos: adj }; }
  if (rt.kind === "pres") { const r = await findByField(T.pres, "ID", rt.id); return { doc: r ? presToDoc(r, admin) : null }; }
  if (rt.kind === "config") { if (rt.id === "costes" && !admin) return { doc: null }; const r = await findByField(T.config, "Clave", rt.id); return { doc: r ? parseJSON(r.fields["JSON"], {}) : null }; }
  if (rt.kind === "analitica") { if (!admin) return { doc: null }; const r = await findByField(T.pres, "ID", rt.id); return { doc: r && r.fields["Coste"] != null ? analToDoc(r) : null }; }
  return { doc: null };
}

// ---------- setup: crear tablas y semillas ----------
const F = (name, type, options) => ({ name, type, ...(options ? { options } : {}) });
const money = { precision: 2 }; const int = { precision: 0 };
const SCHEMA = [
  { name: T.enc, fields: [F("ID", "singleLineText"), F("Ref", "singleLineText"), F("Cliente", "singleLineText"), F("Teléfono", "phoneNumber"), F("Fecha entrada", "date", { dateFormat: { name: "iso" } }), F("Batería", "singleLineText"), F("Tensión (V)", "number", { precision: 1 }), F("Capacidad (Ah)", "number", { precision: 1 }), F("Estado", "singleLineText"), F("Almacén", "singleLineText"), F("Síntoma", "multilineText"), F("Fotos", "multipleAttachments"), F("Creado", "number", int), F("Actualizado", "number", int), F("Creado por", "singleLineText")] },
  { name: T.notas, fields: [F("ID", "singleLineText"), F("Encargo", "singleLineText"), F("Fecha", "number", int), F("Tipo", "singleLineText"), F("Texto", "multilineText"), F("Autor", "singleLineText"), F("Autor nombre", "singleLineText"), F("Estado", "singleLineText"), F("Almacén", "singleLineText"), F("Adjunto", "multipleAttachments"), F("Mime", "singleLineText")] },
  { name: T.pres, fields: [F("ID", "singleLineText"), F("Número", "singleLineText"), F("Encargo", "singleLineText"), F("Cliente", "singleLineText"), F("NIF", "singleLineText"), F("Dirección", "singleLineText"), F("Email", "email"), F("Batería", "singleLineText"), F("Estado", "singleLineText"), F("Base", "number", money), F("IVA", "number", money), F("Total", "number", money), F("Nº factura", "singleLineText"), F("Datos", "multilineText"), F("Coste", "number", money), F("Beneficio", "number", money), F("Margen %", "number", { precision: 1 }), F("Interno", "multilineText")] },
  { name: T.config, fields: [F("Clave", "singleLineText"), F("JSON", "multilineText")] },
];
async function setup() {
  const meta = await at("GET", `meta/bases/${BASE()}/tables`);
  const have = new Map((meta.tables || []).map((t) => [t.name, t]));
  const created = [], added = [];
  for (const t of SCHEMA) {
    const ex = have.get(t.name);
    if (!ex) { await at("POST", `meta/bases/${BASE()}/tables`, { name: t.name, fields: t.fields }); created.push(t.name); continue; }
    const names = new Set(ex.fields.map((f) => f.name));
    for (const f of t.fields) if (!names.has(f.name)) { await at("POST", `meta/bases/${BASE()}/tables/${ex.id}/fields`, f); added.push(t.name + "." + f.name); }
  }
  // semillas: solo si la clave no existe todavía
  const seeded = [];
  for (const [k, v] of Object.entries(SEED.config || {})) { if (!(await findByField(T.config, "Clave", k))) { await createRec(T.config, { "Clave": k, "JSON": JSON.stringify(v) }); seeded.push(k); } }
  for (const e of SEED.encargos || []) { if (!(await findByField(T.enc, "ID", e.id))) { await createRec(T.enc, encFields(e)); seeded.push("encargo " + e.ref); } }
  for (const p of SEED.presupuestos || []) { if (!(await findByField(T.pres, "ID", p.id))) { await createRec(T.pres, presFields(p)); seeded.push("presupuesto " + p.num); } }
  return { created, added, seeded };
}

// ---------- handler ----------
exports.handler = async (event) => {
  const miss = configured();
  if (miss.length) return json(501, { error: "Faltan variables en Netlify: " + miss.join(", "), code: "not_configured" });
  const sess = sessionFrom(event);
  if (!sess) return json(401, { error: "Sesión caducada o no válida", code: "unauthorized" });
  const admin = sess.rol === "admin";
  try {
    if (event.httpMethod === "GET") {
      const op = (event.queryStringParameters || {}).op || "state";
      if (op === "state") return json(200, await readState(admin));
      if (op === "get") { const rt = route((event.queryStringParameters || {}).path); if (!rt || !rt.id) return json(400, { error: "Ruta no válida" }); return json(200, await readDoc(rt, admin)); }
      return json(400, { error: "Operación desconocida" });
    }
    if (event.httpMethod !== "POST") return json(405, { error: "Método no permitido" });
    let b = {}; try { b = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "JSON inválido" }); }
    if (b.op === "setup") { if (!admin) return json(403, { error: "Solo administrador" }); return json(200, await setup()); }
    const rt = route(b.path); if (!rt) return json(400, { error: "Ruta no válida: " + b.path });
    const needsAdmin = rt.kind === "config" || rt.kind === "analitica";
    if (needsAdmin && !admin) return json(403, { error: "Solo el administrador puede modificar esto", code: "forbidden" });
    const files = b.files || {};
    if (b.op === "delete") {
      if (!rt.id) return json(400, { error: "Falta id" });
      if (rt.kind === "encargo") { const r = await findByField(T.enc, "ID", rt.id); if (r) await deleteRec(T.enc, r.id); }
      else if (rt.kind === "notas") { for (const r of await listAll(T.notas, { filterByFormula: `{Encargo}='${rt.id}'` })) await deleteRec(T.notas, r.id); }
      else if (rt.kind === "pres") { const r = await findByField(T.pres, "ID", rt.id); if (r) await deleteRec(T.pres, r.id); }
      else if (rt.kind === "config") { const r = await findByField(T.config, "Clave", rt.id); if (r) await deleteRec(T.config, r.id); }
      return json(200, { ok: true });
    }
    let data = b.data || {};
    const id = rt.id || newId();
    if (b.op === "update") {
      const cur = await readDoc({ ...rt, id }, admin);
      if (!cur.doc) return json(404, { error: "El documento no existe", code: "invalid_argument" });
      data = { ...cur.doc, ...(b.patch || {}) };
    } else if (b.op !== "set" && b.op !== "add") return json(400, { error: "Operación desconocida" });
    let res;
    if (rt.kind === "encargo") res = await writeEncargo(id, data, files, sess);
    else if (rt.kind === "notas") res = await writeNotas(id, data, files);
    else if (rt.kind === "pres") res = await writePres(id, data, admin);
    else if (rt.kind === "config") res = await writeConfig(id, data);
    else if (rt.kind === "analitica") res = await writeAnalitica(id, data);
    return json(200, { id, ...res });
  } catch (e) {
    console.error(e);
    const msg = e.airtable ? (e.message + (e.status === 404 ? " (¿has ejecutado la configuración inicial?)" : "")) : (e.message || String(e));
    return json(e.status === 404 ? 424 : 500, { error: msg, code: e.status === 404 ? "not_setup" : "server" });
  }
};
