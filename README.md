# Taller Litio · Volta Baterías

Panel de encargos, seguimiento por almacén y presupuestos para la reparación de baterías de litio.
Página estática (`public/`) + funciones de Netlify (`netlify/functions/`) + **Airtable** como base de datos.

## Cómo funciona
- **Dos accesos fijos**: *Empleado* y *Administrador*, cada uno con su contraseña. Al entrar, cada persona escribe su nombre para firmar sus notas.
- **Empleado**: Encargos completo (crear, anotar, fotos, audios, estado y almacén) y Presupuestos completo (crear, modificar, enviar, aprobar, PDF), pero sin ver costes ni beneficio.
- **Administrador**: todo lo anterior más coste y beneficio de cada presupuesto (calculados en el servidor con las tarifas internas), tarifas y datos de empresa, y la pestaña **Rentabilidad**.
- **Varios productos por presupuesto**: en la calculadora, «+ Añadir producto» crea Producto B, C… Cada producto tiene sus propias celdas, BMS, horas, diagnosis, otros conceptos, precio cerrado y trabajos realizados; el presupuesto suma todos. Los presupuestos anteriores (un solo producto) se abren y se guardan igual que siempre.
- **Descarga del PDF**: en cuanto un presupuesto está marcado como *enviado* aparece el botón «⬇ Descarga Archivo» junto a las acciones.
- **Señal de diagnosis**: al crear o editar un encargo hay un botón para confirmar que el cliente deja la señal obligatoria (30 € por defecto, cambiable en *Tarifas y almacenes*). También se puede marcar o quitar desde la ficha del encargo; queda guardado en Airtable (campos `Señal diagnosis` y `Señal importe` de `Encargos`) y anotado en el seguimiento. Al crear un encargo con la señal marcada se descarga un **recibo en PDF** para el cliente (datos del cliente, batería, síntoma, fotos e importe); desde la ficha del encargo, el botón «Recibo señal» lo vuelve a generar. El texto de condiciones del recibo se edita en *Tarifas y almacenes → Datos de empresa*. El importe de la señal se elige entre 30 € y 50 € (u otro).
- **Señal en el presupuesto**: si el encargo asociado tiene señal, la línea de diagnosis se factura por ese importe y, bajo el total, aparece «Señal de diagnosis ya abonada» y el «Total pendiente de pago» (también en el PDF y como nota al aprobar). El descuento se aplica antes de restar la señal. La factura de Holded va por el total, con la señal anotada en las notas.
- **Costes por producto (solo administrador)**: «Coste de diagnosis» (20 € por defecto, desde Tarifas) y «Coste cerrado sin IVA», que sustituye la suma de costes del producto. Ambos entran en el beneficio y en Rentabilidad; un empleado nunca los ve ni los borra al guardar.
- **KPIs de Encargos**: encargos abiertos, pendientes de aprobar, presupuestos aprobados y rechazados, listos para entregar y encargos por almacén; el administrador ve además la conversión de presupuestos (% aceptados / rechazados / pendientes sobre los lanzados).
- **Rentabilidad** (solo administrador): presupuestos aprobados y facturados con ingresos sin IVA, costes directos y beneficio; gastos fijos (mensuales, anuales o puntuales); beneficio neto, punto de equilibrio, gráfica mensual, filtro por fechas y exportación a CSV. Los gastos mensuales (y anuales ÷ 12) se reparten entre los días laborables del mes (22 por defecto, cambiable en Tarifas) y cada día laborable carga su parte (el mes completo suma el importe mensual); la caja «Coste por día abierto» muestra lo que cuesta cada día. La gráfica de evolución es **por día** (cada presupuesto aprobado cuenta su ingreso y coste el día de aprobación), con opción de agrupar por semana o por mes. En la gráfica y en las cajas, los costes directos **no incluyen las horas de personal** (son gasto fijo); la tabla «Presupuestos aprobados» sí las incluye (con columna de horas) y la tabla «solo materiales» resta únicamente celdas, BMS y materiales.
- La clave de Airtable vive solo en Netlify; el navegador nunca la ve. La función `api` aplica los permisos por rol (un empleado nunca recibe costes ni beneficios).
- Datos en Airtable, base **Taller Litio** (`app5zyLy77zW0ymtp`): tablas `Encargos`, `Notas`, `Presupuestos` y `Config`. Fotos y audios van como adjuntos de Airtable.
- Los productos de cada presupuesto y su fecha de aprobación van dentro del campo `Datos` de `Presupuestos`; los gastos fijos, en `Config` con la clave `gastos` (el servidor nunca la envía a un empleado). No hace falta crear tablas ni campos nuevos en Airtable.

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
