/* Taller Litio — capa de datos sobre Supabase.
   Expone window.TL = { init(), auth, db, assets, user, downloads, blobUrl, profilesTable }
   La interfaz de db/assets/user imita la que usaba el panel en claude.ai
   para que el código de la página cambie lo mínimo. */
(function () {
  "use strict";
  const cfg = window.TL_CONFIG || {};
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey || /PEGA_AQUI/.test(cfg.supabaseUrl)) {
    console.warn("[TL] Falta configurar config.js con la URL y la anon key de Supabase.");
    window.TL = { configured: false };
    return;
  }
  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  // ---------- rutas → tablas ----------
  // "encargos/{id}" | "notas/{id}" | "presupuestos/{id}" | "config/{key}" | "config/costes/analitica/{id}"
  function parseDoc(path) {
    const seg = path.split("/").filter(Boolean);
    if (seg.length === 4 && seg[0] === "config" && seg[1] === "costes" && seg[2] === "analitica") return { table: "analitica", id: seg[3] };
    if (seg.length === 2 && ["encargos", "notas", "presupuestos", "config"].includes(seg[0])) return { table: seg[0], id: seg[1] };
    throw new TypeError("Ruta de documento no soportada: " + path);
  }
  function parseCol(path) {
    const seg = path.split("/").filter(Boolean);
    if (seg.length === 1 && ["encargos", "notas", "presupuestos", "config", "analitica"].includes(seg[0])) return { table: seg[0] };
    throw new TypeError("Ruta de colección no soportada: " + path);
  }
  const newId = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, "").slice(0, 20) : Math.random().toString(36).slice(2, 12) + Date.now().toString(36));
  const snap = (id, row) => ({ id, exists: !!row, data: () => (row ? row.data : undefined), metadata: { fromCache: false, hasPendingWrites: false } });
  const err = (e) => { const x = new Error(e.message || String(e)); x.code = e.code || "unavailable"; x.details = e.details; return x; };

  // Un canal de realtime por tabla; los listeners se registran y se refresca por tabla.
  const listeners = {}; // table -> Set(fn)
  const channels = {};
  function listen(table, fn) {
    (listeners[table] = listeners[table] || new Set()).add(fn);
    if (!channels[table]) {
      channels[table] = sb.channel("tl-" + table)
        .on("postgres_changes", { event: "*", schema: "public", table }, (payload) => {
          (listeners[table] || []).forEach((f) => { try { f(payload); } catch (e) { console.warn(e); } });
        })
        .subscribe();
    }
    return () => { listeners[table].delete(fn); };
  }
  // Refresco de seguridad cada 45 s (por si realtime se corta)
  setInterval(() => { Object.keys(listeners).forEach((t) => (listeners[t] || []).forEach((f) => { try { f({ poll: true }); } catch {} })); }, 45000);

  function docRef(table, id) {
    const ref = {
      id, path: table + "/" + id,
      async get() {
        const { data, error } = await sb.from(table).select("id,data").eq("id", id).maybeSingle();
        if (error) throw err(error);
        return snap(id, data);
      },
      async set(body) {
        const { error } = await sb.from(table).upsert({ id, data: body }, { onConflict: "id" });
        if (error) throw err(error);
      },
      async update(patch) {
        const cur = await ref.get();
        if (!cur.exists) { const e = new Error("El documento no existe"); e.code = "invalid_argument"; throw e; }
        const { error } = await sb.from(table).update({ data: { ...cur.data(), ...patch } }).eq("id", id);
        if (error) throw err(error);
      },
      async delete() {
        const { error } = await sb.from(table).delete().eq("id", id);
        if (error) throw err(error);
      },
      onSnapshot(next, onError) {
        let alive = true;
        const load = async () => { try { const s = await ref.get(); if (alive) next(s); } catch (e) { if (alive && onError) onError(e); } };
        load();
        const off = listen(table, (p) => { if (p.poll || !p.new && !p.old || (p.new && p.new.id === id) || (p.old && p.old.id === id)) load(); });
        return () => { alive = false; off(); };
      },
      collection(sub) { return colRef(parseCol(table === "config" && id === "costes" && sub === "analitica" ? "analitica" : sub).table); },
    };
    return ref;
  }
  function colRef(table) {
    const col = {
      path: table,
      doc(id) { return docRef(table, id || newId()); },
      async add(body) { const r = docRef(table, newId()); await r.set(body); return r; },
      async get() {
        const { data, error } = await sb.from(table).select("id,data").order("id");
        if (error) throw err(error);
        const docs = data.map((r) => snap(r.id, r));
        return { docs, size: docs.length, empty: !docs.length, docChanges: () => docs.map((d, i) => ({ type: "added", doc: d, oldIndex: -1, newIndex: i })), metadata: { fromCache: false, hasPendingWrites: false } };
      },
      onSnapshot(next, onError) {
        let alive = true, timer = null;
        const load = async () => { try { const s = await col.get(); if (alive) next(s); } catch (e) { if (alive && onError) onError(e); } };
        load();
        const off = listen(table, () => { clearTimeout(timer); timer = setTimeout(load, 150); });
        return () => { alive = false; off(); };
      },
      where() { return col; }, orderBy() { return col; }, limit() { return col; },
    };
    return col;
  }
  const db = { doc: (p) => { const { table, id } = parseDoc(p); return docRef(table, id); }, collection: (p) => colRef(parseCol(p).table) };

  // ---------- adjuntos ----------
  const BUCKET = "adjuntos";
  const extFor = (type, name) => { const m = /\.([a-z0-9]{2,5})$/i.exec(name || ""); if (m) return m[1].toLowerCase(); return ({ "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "video/mp4": "mp4", "video/webm": "webm" })[type] || "bin"; };
  const blobUrl = (id) => sb.storage.from(BUCKET).getPublicUrl(id).data.publicUrl;
  const assets = {
    async upload(blob, opts) {
      const type = (opts && opts.type) || blob.type || "application/octet-stream";
      const id = new Date().toISOString().slice(0, 10) + "/" + newId() + "." + extFor(type, blob.name);
      const { error } = await sb.storage.from(BUCKET).upload(id, blob, { contentType: type, upsert: false });
      if (error) throw err(error);
      return { id, url: blobUrl(id), sizeBytes: blob.size, contentType: type };
    },
    async delete(id) { const { error } = await sb.storage.from(BUCKET).remove([id]); if (error) throw err(error); return { deleted: true }; },
    async list() { const { data } = await sb.storage.from(BUCKET).list(); return { assets: data || [], usage: {} }; },
  };

  // ---------- usuario y perfiles ----------
  let session = null, perfil = null;
  const profCache = new Map();
  const initials = (name) => (name || "?").split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  const colorFor = (id) => { let h = 0; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) % 360; return `hsl(${h} 45% 45%)`; };
  const avatarFor = (id, name) => { const c = colorFor(id); const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'><rect width='64' height='64' rx='32' fill='${c}'/><text x='32' y='40' font-family='system-ui' font-size='26' fill='white' text-anchor='middle'>${initials(name)}</text></svg>`; return "data:image/svg+xml;utf8," + encodeURIComponent(svg); };
  async function loadPerfil() {
    if (!session) { perfil = null; return null; }
    const { data } = await sb.from("perfiles").select("*").eq("id", session.user.id).maybeSingle();
    perfil = data || { id: session.user.id, email: session.user.email, nombre: session.user.email, rol: "empleado", activo: true };
    profCache.set(perfil.id, perfil);
    return perfil;
  }
  const user = {
    async isOwner() { return !!(perfil && perfil.rol === "admin"); },
    async canEdit() { return !!(perfil && perfil.rol === "admin" && perfil.activo); },
    async can(name) { if (!perfil) return null; if (name === "data.write") return !!perfil.activo; if (name === "files.write" || name === "assets.write") return !!perfil.activo; return false; },
    async id() { return perfil ? perfil.id : null; },
    async me() { return perfil ? { id: perfil.id, name: perfil.nombre || perfil.email || "", avatarUrl: avatarFor(perfil.id, perfil.nombre || perfil.email), color: colorFor(perfil.id), email: perfil.email, isOwner: perfil.rol === "admin", canEdit: perfil.rol === "admin" && perfil.activo, rol: perfil.rol } : { id: null, name: "", avatarUrl: avatarFor("x", "?"), color: "#888", email: null, isOwner: false, canEdit: false };
    },
    async profiles(ids) {
      ids = Array.isArray(ids) ? ids : [ids];
      const missing = ids.filter((i) => i && !profCache.has(i));
      if (missing.length) {
        const { data } = await sb.from("perfiles").select("id,email,nombre,rol,activo").in("id", missing);
        (data || []).forEach((p) => profCache.set(p.id, p));
      }
      const out = {};
      ids.forEach((i) => { const p = profCache.get(i); out[i] = { id: i, name: p ? (p.nombre || p.email || "") : "", avatarUrl: avatarFor(i, p ? (p.nombre || p.email) : ""), color: colorFor(i), email: p ? p.email : null, isMe: !!(perfil && perfil.id === i), guest: false }; });
      return out;
    },
    async search() { return []; },
  };

  // ---------- descargas (fuera del visor de claude.ai un enlace normal funciona) ----------
  const downloads = {
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    },
  };

  // ---------- autenticación ----------
  const auth = {
    async session() { const { data } = await sb.auth.getSession(); session = data.session; return session; },
    async signIn(email, password) { const { data, error } = await sb.auth.signInWithPassword({ email, password }); if (error) throw err(error); session = data.session; await loadPerfil(); return perfil; },
    async signOut() { await sb.auth.signOut(); session = null; perfil = null; },
    async resetPassword(email) { const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname }); if (error) throw err(error); },
    async updatePassword(password) { const { error } = await sb.auth.updateUser({ password }); if (error) throw err(error); },
    onChange(fn) { sb.auth.onAuthStateChange((ev, s) => { session = s; fn(ev, s); }); },
    perfil: () => perfil,
    token: () => (session ? session.access_token : null),
  };

  // ---------- gestión de usuarios (admin) ----------
  const admin = {
    async listUsers() { const { data, error } = await sb.from("perfiles").select("*").order("created_at"); if (error) throw err(error); return data; },
    async setRol(id, rol) { const { error } = await sb.from("perfiles").update({ rol }).eq("id", id); if (error) throw err(error); },
    async setActivo(id, activo) { const { error } = await sb.from("perfiles").update({ activo }).eq("id", id); if (error) throw err(error); },
    async setNombre(id, nombre) { const { error } = await sb.from("perfiles").update({ nombre }).eq("id", id); if (error) throw err(error); },
    // Invitar requiere la clave de servicio: se hace en la función de Netlify
    async invite(email, nombre, rol) {
      const r = await fetch("/.netlify/functions/invite", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + auth.token() }, body: JSON.stringify({ email, nombre, rol }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { const e = new Error(j.error || ("Error " + r.status)); e.code = j.code || "invite_failed"; throw e; }
      return j;
    },
    async holdedFactura(payload) {
      const r = await fetch("/.netlify/functions/holded", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + auth.token() }, body: JSON.stringify(payload) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { const e = new Error(j.error || ("Error " + r.status)); e.code = j.code || "holded_failed"; throw e; }
      return j;
    },
  };

  window.TL = { configured: true, sb, db, assets, user, downloads, auth, admin, blobUrl, loadPerfil };
})();
