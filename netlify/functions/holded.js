// POST /.netlify/functions/holded  { contact:{name,code,address,email,phone}, items:[{sku,name,units,subtotal,tax,discount}], notes, numSerie, date }
// Crea una FACTURA en Holded a partir del presupuesto aceptado. Requiere HOLDED_API_KEY en Netlify.
// Referencia: https://developers.holded.com  (Invoicing → Documents → Create document)
const { json, sessionFrom } = require("./_lib");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Método no permitido" });
  const sess = sessionFrom(event);
  if (!sess) return json(401, { error: "Sesión no válida" });
  if (sess.rol !== "admin") return json(403, { error: "Solo administrador" });

  const key = process.env.HOLDED_API_KEY;
  if (!key) return json(501, { error: "HOLDED_API_KEY no configurada", code: "not_configured" });

  let d = {};
  try { d = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "JSON inválido" }); }
  if (!d.contact || !d.contact.name || !Array.isArray(d.items) || !d.items.length) return json(400, { error: "Faltan datos del contacto o líneas" });

  const docType = process.env.HOLDED_DOC_TYPE || "invoice"; // "invoice" (factura) o "estimate" (presupuesto)
  const payload = {
    contactName: d.contact.name,
    contactCode: d.contact.code || undefined,
    contactEmail: d.contact.email || undefined,
    contactAddress: d.contact.address || undefined,
    contactPhone: d.contact.phone || undefined,
    date: Math.floor(new Date(d.date || Date.now()).getTime() / 1000),
    notes: d.notes || "",
    numSerie: d.numSerie || undefined,
    items: d.items.map((it) => ({
      name: it.name,
      units: Number(it.units) || 1,
      subtotal: Number(it.subtotal) || 0,     // precio unitario sin IVA
      tax: Number(it.tax) || 0,               // % IVA
      discount: Number(it.discount) || 0,     // % descuento
      sku: it.sku || undefined,
    })),
  };

  const r = await fetch(`https://api.holded.com/api/invoicing/v1/documents/${docType}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", key },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  let out = {}; try { out = JSON.parse(text); } catch { out = { raw: text }; }
  if (!r.ok || out.status === 0) return json(502, { error: out.info || out.message || ("Holded respondió " + r.status), holded: out });

  // Holded devuelve { status:1, id:"...", invoiceNum:"F2026-0001" } (el campo del número varía según versión)
  const docNumber = out.invoiceNum || out.docNumber || out.number || out.id;
  return json(200, { ok: true, id: out.id, docNumber, holded: out });
};
