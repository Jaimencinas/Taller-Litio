// Utilidades compartidas: comprueba que quien llama es un administrador activo.
const { createClient } = require("@supabase/supabase-js");

const json = (status, body) => ({ statusCode: status, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function requireAdmin(event) {
  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anon || !service) return { error: json(501, { error: "Función no configurada en Netlify", code: "not_configured" }) };

  const auth = event.headers.authorization || event.headers.Authorization || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) return { error: json(401, { error: "Sin sesión" }) };

  const asUser = createClient(url, anon, { global: { headers: { Authorization: "Bearer " + token } } });
  const { data: u, error } = await asUser.auth.getUser(token);
  if (error || !u || !u.user) return { error: json(401, { error: "Sesión no válida" }) };

  const admin = createClient(url, service, { auth: { persistSession: false } });
  const { data: perfil } = await admin.from("perfiles").select("rol,activo,nombre").eq("id", u.user.id).maybeSingle();
  if (!perfil || perfil.rol !== "admin" || !perfil.activo) return { error: json(403, { error: "Solo administradores" }) };

  return { admin, user: u.user, perfil };
}

module.exports = { json, requireAdmin };
