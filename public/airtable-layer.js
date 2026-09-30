/* Taller Litio — capa de datos sobre la API de Netlify (que a su vez habla con Airtable).
   Expone window.TL = { db, assets, user, downloads, auth, blobUrl }
   con la misma interfaz que usaba el panel, para que index.html cambie lo mínimo.
   La página trabaja con documentos JSON; el servidor los traduce a filas de Airtable. */
(function () {
  "use strict";
  const API = "/.netlify/functions/api";
  const LS = "tl.session";
  let session = null; // {token, rol, nombre}
  try { session = JSON.parse(localStorage.getItem(LS) || "null"); } catch {}

  // ---------- estado en memoria ----------
  let state = { encargos: [], notas: {}, presupuestos: [], config: {}, analitica: {}, adjuntos: {}, ts: 0 };
  const pendingFiles = new Map(); // "pending:x" -> {file, contentType, filename}
  const listeners = new Set();
  let pollTimer = null, loading = null;

  async function call(method, body, qs) {
    const r = await fetch(API + (qs ? "?" + new URLSearchParams(qs) : ""), { method, headers: { "content-type": "application/json", authorization: "Bearer " + (session ? session.token : "") }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) { auth.signOut(false); const e = new Error(j.error || "Sesión caducada"); e.code = "unauthorized"; throw e; }
    if (!r.ok) { const e = new Error(j.error || ("Error " + r.status)); e.code = j.code || "server"; throw e; }
    return j;
  }
  async function refresh() {
    if (!session) return;
    if (loading) return loading;
    loading = call("GET", null, { op: "state" }).then((s) => { state = s; listeners.forEach((f) => { try { f(); } catch (e) { console.warn(e); } }); }).catch((e) => console.warn("[TL] refresh", e.message)).finally(() => { loading = null; });
    return loading;
  }
  function startPolling() { stopPolling(); pollTimer = setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 20000); document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refresh(); }); }
  function stopPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }

  // ---------- documentos ----------
  const snap = (id, data) => ({ id, exists: data != null, data: () => (data == null ? undefined : data), metadata: { fromCache: false, hasPendingWrites: false } });
  function parseDoc(path) {
    const s = path.split("/").filter(Boolean);
    if (s.length === 4 && s[0] === "config" && s[1] === "costes" && s[2] === "analitica") return { kind: "analitica", id: s[3] };
    if (s.length === 2 && ["encargos", "notas", "presupuestos", "config"].includes(s[0])) return { kind: s[0], id: s[1] };
    throw new TypeError("Ruta no soportada: " + path);
  }
  function localDoc(rt) {
    if (rt.kind === "encargos") return state.encargos.find((e) => e.id === rt.id) || null;
    if (rt.kind === "presupuestos") return state.presupuestos.find((p) => p.id === rt.id) || null;
    if (rt.kind === "notas") return state.notas[rt.id] || null;
    if (rt.kind === "config") return state.config[rt.id] || null;
    if (rt.kind === "analitica") return state.analitica[rt.id] || null;
    return null;
  }
  function applyLocal(rt, doc) {
    // actualiza la copia local con la respuesta del servidor para que la UI refleje el cambio al instante
    if (!doc) return;
    if (rt.kind === "encargos") { const i = state.encargos.findIndex((e) => e.id === rt.id); if (i >= 0) state.encargos[i] = doc; else state.encargos.push(doc); }
    else if (rt.kind === "presupuestos") { const i = state.presupuestos.findIndex((p) => p.id === rt.id); if (i >= 0) state.presupuestos[i] = doc; else state.presupuestos.push(doc); }
    else if (rt.kind === "notas") state.notas[rt.id] = doc;
    else if (rt.kind === "config") state.config[rt.id] = doc;
    else if (rt.kind === "analitica") state.analitica[rt.id] = doc;
    listeners.forEach((f) => { try { f(); } catch {} });
  }
  function removeLocal(rt) {
    if (rt.kind === "encargos") state.encargos = state.encargos.filter((e) => e.id !== rt.id);
    else if (rt.kind === "presupuestos") state.presupuestos = state.presupuestos.filter((p) => p.id !== rt.id);
    else if (rt.kind === "notas") delete state.notas[rt.id];
    else if (rt.kind === "config") delete state.config[rt.id];
    listeners.forEach((f) => { try { f(); } catch {} });
  }
  // archivos pendientes referenciados en el documento → se envían en la misma petición
  async function collectFiles(doc) {
    const ids = new Set();
    const walk = (v) => { if (typeof v === "string" && v.startsWith("pending:")) ids.add(v); else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") Object.values(v).forEach(walk); };
    walk(doc);
    const files = {};
    for (const id of ids) {
      const f = pendingFiles.get(id); if (!f) continue;
      files[id] = { contentType: f.contentType, filename: f.filename, base64: await toBase64(f.file) };
    }
    return files;
  }
  const toBase64 = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.onerror = rej; r.readAsDataURL(blob); });
  async function write(op, rt, path, payload) {
    const files = await collectFiles(payload);
    const body = { op, path, files };
    if (op === "update") body.patch = payload; else body.data = payload;
    const r = await call("POST", body);
    Object.keys(files).forEach((k) => pendingFiles.delete(k));
    if (r.adjuntos) Object.assign(state.adjuntos, r.adjuntos);
    if (r.analitica) state.analitica[r.id || rt.id] = r.analitica;
    applyLocal({ ...rt, id: r.id || rt.id }, r.doc);
    return r;
  }
  function docRef(path) {
    const rt = parseDoc(path);
    return {
      id: rt.id, path,
      async get() { const l = localDoc(rt); if (l) return snap(rt.id, l); const r = await call("GET", null, { op: "get", path }); if (r.adjuntos) Object.assign(state.adjuntos, r.adjuntos); return snap(rt.id, r.doc); },
      async set(data) { await write("set", rt, path, data); },
      async update(patch) { await write("update", rt, path, patch); },
      async delete() { await call("POST", { op: "delete", path }); removeLocal(rt); },
      onSnapshot(next, onError) {
        let alive = true; let last;
        const emit = () => { if (!alive) return; const d = localDoc(rt); const key = JSON.stringify(d); if (key === last) return; last = key; next(snap(rt.id, d)); };
        const fn = () => emit(); listeners.add(fn);
        if (state.ts) emit(); else refresh().then(emit);
        return () => { alive = false; listeners.delete(fn); };
      },
    };
  }
  function colRef(path) {
    const kind = path.split("/").filter(Boolean)[0];
    if (!["encargos", "presupuestos"].includes(kind)) throw new TypeError("Colección no soportada: " + path);
    const list = () => (kind === "encargos" ? state.encargos : state.presupuestos);
    const mk = (arr) => { const docs = arr.map((d) => snap(d.id, d)); return { docs, size: docs.length, empty: !docs.length, docChanges: () => docs.map((d, i) => ({ type: "added", doc: d, oldIndex: -1, newIndex: i })), metadata: { fromCache: false, hasPendingWrites: false } }; };
    const col = {
      path,
      doc(id) { return docRef(kind + "/" + (id || newId())); },
      async add(data) { const r = docRef(kind + "/" + newId()); await r.set(data); return r; },
      async get() { if (!state.ts) await refresh(); return mk(list()); },
      onSnapshot(next) {
        let alive = true, last;
        const emit = () => { if (!alive) return; const key = JSON.stringify(list()); if (key === last) return; last = key; next(mk(list())); };
        const fn = () => emit(); listeners.add(fn);
        if (state.ts) emit(); else refresh().then(emit);
        return () => { alive = false; listeners.delete(fn); };
      },
      where() { return col; }, orderBy() { return col; }, limit() { return col; },
    };
    return col;
  }
  const newId = () => Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
  const db = { doc: docRef, collection: colRef };

  // ---------- adjuntos ----------
  // upload() no sube nada todavía: guarda el archivo y devuelve un id "pending:..." que el
  // servidor sustituye por el adjunto real de Airtable al guardar el documento que lo referencia.
  async function compressImage(file, max = 1600, q = 0.82) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 400 * 1024) return file;
    try {
      const bmp = await createImageBitmap(file); const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
      const c = document.createElement("canvas"); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
      c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
      const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", q));
      return blob && blob.size < file.size ? new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" }) : file;
    } catch { return file; }
  }
  const assets = {
    async upload(blob, opts) {
      let file = blob; if (blob.type && blob.type.startsWith("image/")) file = await compressImage(blob);
      if (file.size > 4.5 * 1024 * 1024) { const e = new Error("El archivo supera 4,5 MB (límite de subida)"); e.code = "too_large"; throw e; }
      const type = (opts && opts.type) || file.type || "application/octet-stream";
      const id = "pending:" + newId();
      pendingFiles.set(id, { file, contentType: type, filename: file.name || ("adjunto." + (type.split("/")[1] || "bin")) });
      return { id, url: URL.createObjectURL(file), sizeBytes: file.size, contentType: type };
    },
    async delete(id) { pendingFiles.delete(id); return { deleted: true }; }, // los adjuntos reales se borran al quitarlos del documento
    async list() { return { assets: [], usage: {} }; },
  };
  const blobUrl = (id) => { if (!id) return ""; if (String(id).startsWith("pending:")) { const f = pendingFiles.get(id); return f ? URL.createObjectURL(f.file) : ""; } const a = state.adjuntos[id]; return a ? a.url : ""; };

  // ---------- usuario ----------
  const initials = (n) => (n || "?").split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  const colorFor = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return `hsl(${h} 45% 45%)`; };
  const avatarFor = (id, name) => "data:image/svg+xml;utf8," + encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'><rect width='64' height='64' rx='32' fill='${colorFor(id)}'/><text x='32' y='40' font-family='system-ui' font-size='26' fill='white' text-anchor='middle'>${initials(name)}</text></svg>`);
  const myId = () => (session ? session.rol + ":" + session.nombre : null);
  const user = {
    async isOwner() { return !!(session && session.rol === "admin"); },
    async canEdit() { return !!(session && session.rol === "admin"); },
    async can() { return session ? true : null; },
    async id() { return myId(); },
    async me() { const id = myId(); return { id, name: session ? session.nombre : "", avatarUrl: avatarFor(id || "x", session ? session.nombre : "?"), color: colorFor(id || "x"), email: null, isOwner: !!(session && session.rol === "admin"), canEdit: !!(session && session.rol === "admin"), rol: session ? session.rol : null }; },
    async profiles(ids) { ids = Array.isArray(ids) ? ids : [ids]; const out = {}; ids.forEach((i) => { const name = String(i || "").split(":").slice(1).join(":"); out[i] = { id: i, name, avatarUrl: avatarFor(i, name), color: colorFor(i), email: null, isMe: i === myId(), guest: false }; }); return out; },
    async search() { return []; },
  };

  // ---------- descargas ----------
  const downloads = { async save({ filename, data }) { const blob = data instanceof Blob ? data : new Blob([data]); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000); } };

  // ---------- autenticación ----------
  const auth = {
    session: () => session,
    async signIn(rol, password, nombre) {
      const r = await fetch("/.netlify/functions/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rol, password, nombre }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { const e = new Error(j.error || ("Error " + r.status)); e.code = j.code || "login_failed"; throw e; }
      session = { token: j.token, rol: j.rol, nombre: j.nombre };
      try { localStorage.setItem(LS, JSON.stringify(session)); } catch {}
      return session;
    },
    signOut(reload = true) { session = null; try { localStorage.removeItem(LS); } catch {} stopPolling(); if (reload) location.reload(); },
    async start() { if (!session) return null; await refresh(); if (!session) return null; startPolling(); return session; },
    refresh,
    async setup() { return call("POST", { op: "setup" }); },
    async holdedFactura(payload) {
      const r = await fetch("/.netlify/functions/holded", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + (session ? session.token : "") }, body: JSON.stringify(payload) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { const e = new Error(j.error || ("Error " + r.status)); e.code = j.code || "holded_failed"; throw e; }
      return j;
    },
  };

  window.TL = { configured: true, db, assets, user, downloads, auth, blobUrl, admin: { holdedFactura: auth.holdedFactura } };
})();
