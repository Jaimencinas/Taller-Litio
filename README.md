# Taller Litio · Volta Baterías

Panel de encargos, seguimiento por almacén y presupuestos para la reparación de baterías de litio.
Página estática (`public/`) + funciones de Netlify (`netlify/functions/`) + **Airtable** como base de datos.

## Cómo funciona
- **Dos accesos fijos**: *Empleado* y *Administrador*, cada uno con su contraseña. Al entrar, cada persona escribe su nombre para firmar sus notas.
- **Empleado**: pestaña Encargos completa (crear, anotar, fotos, audios, estado y almacén) y la lista de presupuestos con estado, total y PDF.
- **Administrador**: todo lo anterior más la calculadora de presupuestos, coste y beneficio, tarifas y datos de empresa.
- La clave de Airtable vive solo en Netlify; el navegador nunca la ve. La función `api` aplica los permisos por rol (un empleado no puede leer costes ni escribir presupuestos).
- Datos en Airtable, base **Taller Litio** (`app5zyLy77zW0ymtp`): tablas `Encargos`, `Notas`, `Presupuestos` y `Config`. Fotos y audios van como adjuntos de Airtable.

## Puesta en marcha en Netlify (una sola vez)
1. **Add new site → Import an existing project → GitHub → `Taller-Litio`**. La configuración de build ya está en `netlify.toml`.
2. **Site configuration → Environment variables**, añade:

| Variable | Valor |
|---|---|
| `AIRTABLE_TOKEN` | Token personal de Airtable (airtable.com/create/tokens) con permisos `data.records:read`, `data.records:write`, `schema.bases:read` y acceso a la base *Taller Litio* |
| `AIRTABLE_BASE_ID` | `app5zyLy77zW0ymtp` |
| `SESSION_SECRET` | Una frase larga cualquiera (firma las sesiones); p. ej. 40 caracteres aleatorios |
| `ADMIN_PASSWORD` | Contraseña del acceso Administrador |
| `EMPLEADO_PASSWORD` | Contraseña del acceso Empleado |
| `SESSION_DAYS` | (opcional) días que dura la sesión, por defecto 30 |
| `HOLDED_API_KEY` | (opcional) Holded → Configuración → Desarrolladores → API key, para crear la factura al aprobar |
| `HOLDED_DOC_TYPE` | (opcional) `invoice` (factura, por defecto) o `estimate` (presupuesto) |

3. **Deploy**. Cada `git push` vuelve a desplegar solo.

Para cambiar una contraseña: edita la variable en Netlify y vuelve a desplegar (Deploys → Trigger deploy). Las sesiones antiguas siguen válidas hasta que caducan; si quieres cerrarlas todas, cambia también `SESSION_SECRET`.

## Holded
Al **aprobar** un presupuesto el panel llama a la función `holded`: con `HOLDED_API_KEY` configurada crea el documento en Holded y marca el presupuesto como facturado con su número; sin ella, descarga el CSV de importación.

## Estructura
```
public/index.html            la página
public/airtable-layer.js     capa de datos del navegador (habla con /.netlify/functions/api)
netlify/functions/login.js   acceso (dos contraseñas, sesión firmada)
netlify/functions/api.js     lectura/escritura en Airtable con permisos por rol; op "setup" crea tablas si faltan
netlify/functions/holded.js  factura en Holded
netlify/functions/_seed.json datos iniciales (tarifas, costes, empresa)
netlify.toml                 configuración de despliegue
```

## Límites a tener en cuenta
- Adjuntos: hasta 4,5 MB por archivo (las fotos se comprimen solas antes de subir).
- Airtable admite 5 peticiones/segundo por base; para un taller es más que suficiente.
- Los cambios de otros usuarios aparecen en menos de 20 segundos (la página consulta periódicamente).
