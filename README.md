# Taller Litio · Volta Baterías

Panel de encargos, seguimiento por almacén y presupuestos para la reparación de baterías de litio.
Página estática (`public/`) + base de datos, archivos y usuarios en **Supabase** + dos funciones en **Netlify**.

## Puesta en marcha (una sola vez)

### 1. Supabase
1. Crea un proyecto en [supabase.com](https://supabase.com) (plan Free, región **EU West**).
2. Abre **SQL Editor → New query**, pega el contenido de `supabase/schema.sql` y pulsa **Run**.
3. Repite con `supabase/seed.sql` (tarifas, costes, ajustes y los encargos ya creados).
4. En **Authentication → Providers → Email** deja activado *Email* y desactiva *Confirm email* si quieres que las invitaciones entren directas.
5. En **Authentication → URL Configuration** pon como *Site URL* la dirección de tu web en Netlify (p. ej. `https://taller-litio.netlify.app`) y añádela también en *Redirect URLs*.
6. En **Project Settings → API** copia la **Project URL** y la **anon public key** y pégalas en `public/config.js`.

### 2. Primer usuario (tú)
En **Authentication → Users → Add user → Create new user**: tu email y una contraseña.
**El primer usuario creado pasa a ser administrador automáticamente.** Los siguientes serán empleados salvo que los invites como administradores desde el panel.

### 3. Netlify
1. Sube esta carpeta a un repositorio de GitHub y en Netlify elige **Add new site → Import an existing project** → ese repositorio. La configuración (`netlify.toml`) ya está: publica `public/` y las funciones de `netlify/functions/`.
2. En **Site configuration → Environment variables** añade:

| Variable | Valor | Para qué |
|---|---|---|
| `SUPABASE_URL` | la Project URL | funciones |
| `SUPABASE_ANON_KEY` | la anon key | funciones |
| `SUPABASE_SERVICE_ROLE_KEY` | Project Settings → API → *service_role* (secreta, nunca en el HTML) | invitar usuarios |
| `SITE_URL` | `https://tu-sitio.netlify.app` | enlace de las invitaciones |
| `HOLDED_API_KEY` | Holded → Configuración → Desarrolladores → API key | crear la factura al aprobar (opcional) |
| `HOLDED_DOC_TYPE` | `invoice` (factura) o `estimate` (presupuesto) | opcional, por defecto `invoice` |

3. **Deploy**. Cada `git push` vuelve a desplegar solo.

## Cómo funciona el acceso
- Pantalla de inicio de sesión con email y contraseña. No hay registro público: las cuentas las crea un administrador desde la pestaña **Usuarios** (o desde Supabase → Authentication).
- **Empleado**: pestaña Encargos completa (crear, anotar, fotos, audios, cambiar estado y almacén) y la lista de presupuestos con su estado, total y PDF.
- **Administrador**: todo lo anterior más la calculadora de presupuestos, coste y beneficio, tarifas, datos de empresa y usuarios.
- Las reglas de seguridad están en la base de datos (`schema.sql`, sección RLS): un empleado no puede leer costes ni escribir presupuestos aunque manipule la página.

## Holded
Al **aprobar** un presupuesto el panel llama a la función `holded`: si `HOLDED_API_KEY` está configurada crea el documento en Holded y marca el presupuesto como facturado con su número; si no, descarga el CSV de importación como hasta ahora.

## Actualizar la página
Edita los archivos, y:
```bash
git add . && git commit -m "Cambio" && git push
```
Netlify despliega en menos de un minuto. La base de datos no se toca al desplegar.

## Estructura
```
public/              página (index.html), capa de datos (supabase-layer.js) y config.js
supabase/schema.sql  tablas, roles, seguridad, storage
supabase/seed.sql    datos iniciales
netlify/functions/   invite.js (alta de usuarios) · holded.js (facturas)
netlify.toml         configuración de despliegue
```
