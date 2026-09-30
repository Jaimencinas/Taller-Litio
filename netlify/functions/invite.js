// POST /.netlify/functions/invite  { email, nombre, rol }
// Invita a un usuario por email (Supabase envía el correo con el enlace para crear contraseña).
const { json, requireAdmin } = require("./_auth");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Método no permitido" });
  const gate = await requireAdmin(event);
  if (gate.error) return gate.error;

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "JSON inválido" }); }
  const email = String(body.email || "").trim().toLowerCase();
  const nombre = String(body.nombre || "").trim();
  const rol = body.rol === "admin" ? "admin" : "empleado";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(400, { error: "Email no válido" });

  const redirectTo = process.env.SITE_URL || process.env.URL || undefined;
  const { data, error } = await gate.admin.auth.admin.inviteUserByEmail(email, { data: { nombre, rol }, redirectTo });
  if (error) {
    if (/already/i.test(error.message)) return json(409, { error: "Ese email ya tiene una cuenta" });
    return json(500, { error: error.message });
  }
  // Asegura el perfil con el rol pedido (el trigger lo crea; aquí lo fijamos por si acaso)
  await gate.admin.from("perfiles").upsert({ id: data.user.id, email, nombre: nombre || email.split("@")[0], rol, activo: true }, { onConflict: "id" });
  return json(200, { ok: true, id: data.user.id });
};
