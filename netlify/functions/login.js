// POST /.netlify/functions/login  { rol: "admin"|"empleado", password, nombre }
// Dos accesos fijos definidos en variables de entorno de Netlify: ADMIN_PASSWORD y EMPLEADO_PASSWORD.
const crypto = require("crypto");
const { json, sign, configured } = require("./_lib");

const safeEq = (a, b) => { const A = Buffer.from(String(a)), B = Buffer.from(String(b)); return A.length === B.length && crypto.timingSafeEqual(A, B); };

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Método no permitido" });
  const miss = configured();
  if (miss.length) return json(501, { error: "Faltan variables en Netlify: " + miss.join(", "), code: "not_configured" });
  let b = {}; try { b = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "JSON inválido" }); }
  const rol = b.rol === "admin" ? "admin" : "empleado";
  const nombre = String(b.nombre || "").trim().slice(0, 40);
  if (!nombre) return json(400, { error: "Indica tu nombre" });
  const expected = rol === "admin" ? process.env.ADMIN_PASSWORD : process.env.EMPLEADO_PASSWORD;
  if (!b.password || !safeEq(b.password, expected)) {
    await new Promise((r) => setTimeout(r, 600)); // frena intentos por fuerza bruta
    return json(401, { error: "Contraseña incorrecta" });
  }
  const dias = Number(process.env.SESSION_DAYS || 30);
  const token = sign({ rol, nombre, iat: Date.now(), exp: Date.now() + dias * 864e5 });
  return json(200, { token, rol, nombre });
};
