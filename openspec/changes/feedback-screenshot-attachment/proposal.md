# Proposal: Captura de pantalla opcional en el panel de feedback

> **Change base**: `feedback-beta-testers` (mergeado a `main` en PR #46). Ese change dejó
> explícitamente **fuera de scope** los adjuntos ("capturas de pantalla / adjuntos: almacenar
> blobs en TimescaleDB es un riesgo real ya pagado... el stack no tiene object storage") y su
> exclusión de "sin adjuntos" queda **parcialmente superada** por este change: sigue sin haber
> threading ni múltiples adjuntos, pero se agrega UNA captura opcional por reporte, con
> storage externo (no en TimescaleDB) que resuelve el motivo original de la exclusión.

## Intent

El widget de feedback (`FeedbackWidget.tsx`) ya captura contexto automático de texto (ruta,
URL, user agent) pero un reporte de tipo `bug` sin imagen sigue obligando al tester a describir
con palabras algo que a veces es puramente visual (un layout roto, un color equivocado, un
elemento superpuesto). Agregar una captura de pantalla automática del viewport al abrir el
widget cierra esa brecha sin agregar fricción: el tester no tiene que buscar una herramienta de
captura externa, adjuntarla a mano ni describir en texto lo que una imagen muestra directo.

## Scope

### In Scope

- Captura **automática** del viewport al momento de abrir `FeedbackWidget.tsx`, client-side,
  vía la librería `modern-screenshot` (elegida sobre `html2canvas` por mantenimiento activo y
  mejor soporte de `oklch()`/custom properties CSS, que el tema Tailwind v4 de esta app ya usa).
- **UNA sola captura por reporte**, opcional (el reporte se envía igual si la captura falla o
  el tester la descarta) — sin threading, sin múltiples adjuntos, sin galería.
- **Advertencia de limitación conocida y aceptada**: la vista globo (`SeismicGlobe.tsx`,
  `react-globe.gl`/three.js sobre WebGL) no puede capturarse con librerías DOM-a-canvas —
  renderiza negro/vacío porque los framebuffers de WebGL no son legibles sin
  `preserveDrawingBuffer`, que esta app no controla. El widget detecta un `<canvas>` WebGL en
  pantalla y muestra un aviso ("la captura puede no incluir el globo 3D") antes de enviar; el
  reporte se envía igual, la captura nunca bloquea el envío.
- **Storage: Cloudflare R2** (S3-compatible vía `boto3` con `endpoint_url` propio, cero costo de
  egress). Railway no tiene plugin nativo de object storage (verificado).
- **Flujo de subida con URL prefirmada**: el backend emite una URL prefirmada, el browser sube
  el PNG **directamente** al bucket — el backend FastAPI nunca hace proxy del binario (este
  proyecto ya se quemó una vez ruteando payloads binarios por el proceso Python: importar
  miniSEED cuesta 8x su tamaño en RAM).
- **Schema**: columna nueva `screenshot_key TEXT NULL` en `feedback_reports` (migración `020`,
  la 019 ya está tomada por el change base), mismo patrón de par que `admin_comment` /
  `admin_comment_updated_at` — no una tabla separada, porque es una relación 1:1 opcional, no
  1:N.
- **UI de administración**: `FeedbackCard.tsx` (thumbnail cuando `screenshot_key` está
  presente) y `FeedbackCardDetail.tsx` (lightbox/vista completa) — hoy ninguno de los dos
  renderiza imágenes; esto es UI nueva, no solo cambio de schema.
- **No debe bloquear el envío del reporte**: si la captura, la subida o la llamada de presign
  fallan, el reporte se envía igual sin captura — mismo criterio de manejo de errores que ya
  tiene el widget (outcome como dato, texto preservado en reintento).

### Out of Scope

- Threading o múltiples adjuntos por reporte (sigue vigente del change base).
- Captura del globo 3D vía mecanismo alternativo (por ejemplo, forzar
  `preserveDrawingBuffer: true` en el `WebGLRenderer` y pagar su costo de performance) — se
  documenta como limitación aceptada, no se resuelve en este change.
- Edición o anotación de la captura (recortar, dibujar, blur) antes de enviar.
- Borrado/retención automática de objetos en R2 — vida del objeto queda igual de indefinida que
  las filas de `feedback_reports` hasta que exista una política explícita.
- Captura en dispositivos táctiles/mobile más allá de lo que el navegador soporte de forma
  nativa (sin fallback especial).

## Approach

1. **Cliente**: al abrir el widget, disparar `modern-screenshot` sobre el `<body>` (o el
   contenedor de la app) para producir un PNG del viewport visible. Detectar presencia de un
   `<canvas>` con contexto WebGL (`canvas.getContext('webgl')` / `'webgl2'` ya no nulo) para
   activar el aviso de "puede no incluir el globo 3D" — el detector es genérico (cualquier
   canvas WebGL en pantalla), no un caso especial de `/live`.
2. **Presign + subida directa**: el backend expone un endpoint que emite una URL prefirmada de
   R2 con expiración corta; el browser hace el `PUT` directo a esa URL con el PNG. El backend
   nunca toca el binario. La forma exacta del flujo (endpoint separado antes del `POST
   /feedback` vs. plegado en el propio create) se decide en design — ver Open Questions.
3. **Persistencia**: al confirmar la subida (o al crear el reporte, según lo que decida el
   design), se guarda `screenshot_key` en la fila de `feedback_reports`. Si la subida falla, la
   fila se crea igual con `screenshot_key = NULL`.
4. **Lectura admin**: `GET /feedback` ya devuelve `FeedbackReportItem` completo; se agrega
   `screenshot_key` (o una URL derivada, según decida el design) al contrato. `FeedbackCard.tsx`
   renderiza un thumbnail condicional; `FeedbackCardDetail.tsx` abre un lightbox.

## Affected Areas

| Area | Impact | Description |
|------|--------|--------------|
| `deploy/sql/migrations/020_feedback_screenshot.sql` | New | Columna `screenshot_key TEXT NULL` en `feedback_reports`, idempotente (patrón de las 19 migraciones existentes) |
| `src/services/feedback_service.py` | Modified | Persistir/leer `screenshot_key`; posible nuevo método de presign |
| `src/services/` (nuevo servicio o helper R2) | New | Cliente `boto3` con `endpoint_url` de Cloudflare R2, emisión de URL prefirmada con expiración |
| `src/api/routers/feedback.py` | Modified | Nuevo endpoint de presign (forma exacta a decidir en design) o campo adicional en el flujo de creación |
| `src/models/feedback.py` | Modified | `screenshot_key` en los modelos de lectura/creación |
| `requirements.txt` | Modified | Agregar `boto3` (no está en el repo hoy) |
| `dashboard/components/feedback/FeedbackWidget.tsx` | Modified | Captura automática al abrir, detección de WebGL, aviso, subida a la URL prefirmada, no bloquea el envío |
| `dashboard/components/feedback/FeedbackCard.tsx` | Modified | Thumbnail condicional cuando `screenshot_key` está presente |
| `dashboard/components/feedback/FeedbackCardDetail.tsx` | Modified | Lightbox / vista completa de la captura |
| `dashboard/lib/feedback.ts` | Modified | Cliente API: llamada de presign + subida directa a R2 |
| `dashboard/package.json` | Modified | Agregar `modern-screenshot` (dependencia nueva) |
| `dashboard/messages/{es,en}.json` | Modified | Strings del aviso de WebGL, estado de subida, lightbox (paridad es/en obligatoria) |
| Cloudflare (fuera del repo) | New (manual) | Bucket R2 + token API — bloqueante de rollout, ver Dependencies |
| Railway `api` service secrets | New (manual) | Credenciales R2 cargadas como env vars — bloqueante de rollout |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|--------------|
| URL prefirmada como superficie de ataque nueva: alcance/expiración mal definidos permiten `PUT` arbitrario al bucket | Med | Debe resolverse en design, no asumirse seguro — ver Open Questions. Expiración corta, key con prefijo predecible por reporte, sin permisos de lectura pública amplia si no hace falta |
| El aviso de WebGL no dispara en todos los casos reales (falso negativo) o dispara siempre (falso positivo, ruido) | Med | Criterio de éxito específico: aparece en `/live` (tiene el globo) y no aparece en una vista de espectrograma pura (solo canvas 2D) |
| Tamaño del PNG sin cap definido infla el bucket o la subida es lenta en conexiones débiles | Med | Cap de tamaño/dimensión queda para design (Open Question) |
| R2 mal configurado o inalcanzable en prod tras el deploy | Med | Bloqueante de rollout explícito (no de planning/implementación), igual que "promover a admin" en el change base; el envío del reporte debe seguir funcionando sin captura si R2 falla — criterio de éxito específico |
| `boto3` es una dependencia nueva y relativamente pesada para un backend que hoy no toca object storage | Low | Solo se usa en el path de presign, aislado en un servicio propio; no afecta el resto del backend |
| Captura del DOM expone contenido sensible visible en pantalla en el momento de abrir el widget (datos de otro tester, sesión, etc.) | Low | Es exactamente lo que el tester ve — mismo modelo de confianza que el contexto de URL/ruta ya capturado; se documenta en el aviso de la UI |

## Rollback Plan

1. **Código**: revertir el commit — los cambios de backend son aditivos (columna nullable,
   endpoint nuevo o campo adicional, servicio R2 aislado) y los de frontend también (captura
   condicional en el widget, thumbnail condicional en la card). Un reporte sin `screenshot_key`
   se comporta exactamente como hoy.
2. **Migración**: la 020 es aditiva e idempotente (`ADD COLUMN IF NOT EXISTS`); revertir el
   código deja la columna huérfana pero inerte. Limpieza manual opcional: `ALTER TABLE
   feedback_reports DROP COLUMN screenshot_key;`.
3. **R2**: el bucket y las credenciales quedan aunque se revierta el código — no hay
   dependencia inversa (nada más del stack lee de ese bucket). Sin costo de mantenerlo vacío.
4. **Sin estado compartido**: no toca ingesta, walls, eventos ni auth.

## Dependencies

- Change base `feedback-beta-testers` ya mergeado a `main` (widget, tablero, migración 019,
  modelos y router de feedback existentes).
- **Bloqueante de rollout, NO de planning ni de implementación** (mismo criterio que
  "promover a admin" en el change base): alguien debe crear manualmente el bucket R2 + token de
  API en el dashboard de Cloudflare y cargar las credenciales en los secrets del servicio `api`
  de Railway antes de que la feature funcione de punta a punta en prod. El SDD puede avanzar
  entero (specs, design, tasks, apply, verify local) sin esto resuelto.
- Migraciones auto-aplicadas activas en Railway (`RUN_MIGRATIONS_ON_STARTUP`) — ya operativo.
- Dependencias nuevas: `modern-screenshot` (frontend), `boto3` (backend) — ninguna presente hoy
  en el repo (verificado: `dashboard/package.json` y `requirements.txt` no las tienen).

## Success Criteria

- [ ] Un reporte enviado sin captura (el tester la descarta, o falla la captura/subida/presign)
      sigue respondiendo 201 y creando la fila — verificable simulando R2 inalcanzable o
      mal configurado y confirmando que el envío no se rompe.
- [ ] Un reporte con captura exitosa sube el PNG directo a R2 (nunca pasa por el proceso
      Python) y el tablero de admin muestra un thumbnail en `FeedbackCard.tsx` para ese reporte.
- [ ] El lightbox de `FeedbackCardDetail.tsx` muestra la captura completa cuando
      `screenshot_key` está presente, y no muestra ningún control de imagen cuando no lo está.
- [ ] El aviso de "la captura puede no incluir el globo 3D" aparece al abrir el widget en una
      vista con `SeismicGlobe.tsx` (`/live` u otra que lo monte) y NO aparece en una vista de
      espectrograma pura (canvas 2D, sin WebGL) — verificable por test de componente o QA
      manual con el detector de canvas WebGL como criterio.
- [ ] Una URL prefirmada expirada (más allá de su ventana de validez) es rechazada por R2 al
      intentar el `PUT` — verificable con una URL vieja reintentada tras la expiración.
- [ ] La migración 020 se auto-aplica en el deploy sin intervención manual y un segundo
      arranque es no-op (mismo patrón verificado desde la 015).
- [ ] Rollout: el bucket R2 existe, las credenciales están cargadas en Railway, y un reporte
      real con captura se sube y se ve en el tablero de producción.

## Open Questions (para spec/design — no resolver acá)

- **Cap de tamaño/dimensión del PNG**: sin definir en esta propuesta; el design debe fijar un
  límite concreto (dimensiones máximas del viewport capturado, límite de bytes) y qué pasa si
  se excede (¿se recomprime client-side, se rechaza, se trunca?).
- **Forma del flujo de subida**: ¿un `POST /feedback/upload-url` separado que se llama ANTES de
  `POST /feedback` (dos round-trips, pero diff mínimo sobre el flujo de creación existente), o
  el presign plegado dentro del propio `POST /feedback` (un solo round-trip, pero el create
  deja de ser solo-texto)? El design debe elegir y justificar contra "diff mínimo al submit
  existente".
- **Scoping y expiración de la URL prefirmada como superficie de ataque**: qué permisos exactos
  lleva la URL (solo `PUT` a una key específica, no lectura/listado del bucket), cuánto dura la
  ventana de validez, y si la key incluye algo impredecible (UUID) para evitar colisión o
  sobrescritura por un tercero que adivine la ruta. Esto debe resolverse explícitamente en
  design — no se puede asumir seguro solo por usar S3/R2 presigned URLs.
