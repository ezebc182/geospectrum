# Proposal: Panel de Feedback para Beta Testers (tablero Kanban)

> **Historial**: propuesta original 2026-09-01 (canal binario abierto/resuelto, solo-admin).
> **Alcance ampliado el 2026-09-03** por decisión del usuario, antes de escribir una sola
> línea de código: tablero Kanban de 5 estados, visible en modo solo-lectura para todos
> los beta testers, con un comentario opcional del admin por tarjeta. Las secciones de
> abajo reflejan el alcance vigente; lo que sigue siendo válido de la versión original se
> conservó tal cual.

## Intent

Los beta testers de producción (hoy 4 cuentas) no tienen ningún canal dentro de la app para reportar fallas o sugerencias: el feedback llega por vías informales (o no llega), sin contexto técnico, y no queda registrado en ningún lado. Cada reporte útil hoy exige que el tester describa a mano en qué página estaba, qué canal miraba y cuándo pasó — fricción que garantiza que la mayoría de los problemas no se reporten.

Este change agrega un canal de feedback honesto y **transparente**: un botón flotante siempre visible en el dashboard autenticado que al enviar captura automáticamente el contexto técnico (ruta/URL actual — que en las vistas de análisis ya codifica canal y ventana en sus query params —, user agent y timestamp), junto con el texto libre del tester y un tipo (falla | sugerencia). Los reportes viven en un **tablero Kanban** con cinco estados — `Nuevo → En análisis → En progreso → Hecho`, más `Descartado` como estado terminal aparte — que **todos los testers ven en modo solo-lectura** (con la columna de cada tarjeta y quién la reportó), para que nadie reporte dos veces lo mismo y para que la beta tenga visibilidad de qué se está atendiendo. Solo el admin mueve tarjetas y puede dejar **un** comentario opcional y editable por tarjeta, visible para los testers. Sigue siendo un canal de feedback de beta, **no un sistema de tickets**: sin asignaciones, prioridades, threading ni adjuntos.

## Scope

### In Scope

- **Migración `deploy/sql/migrations/019_feedback_reports.sql`**, idempotente como las 18 existentes (auto-aplicada por `scripts/apply_migrations.py`): tabla `feedback_reports` con `id UUID`, `user_id` FK a `users` (`ON DELETE CASCADE`, patrón `017_window_comments.sql`), `type` con `CHECK` (`bug` | `suggestion`), `body TEXT` con `CHECK` de longitud (1..2000), contexto técnico en columnas de texto acotadas (`route` ≤300, `url` ≤2000, `user_agent` ≤400 — no JSONB libre), `created_at` con default `now()`, **el estado de la tarjeta entre los cinco valores fijos**, **el comentario del admin (opcional, uno solo)** y los timestamps de auditoría que el design decida (ver Approach §1: el modelado exacto del estado es decisión del design, argumentada contra el criterio de `src/models/beta.py`).
- **Backend** (patrón `src/api/routers/comments.py` calcado), autorización 100% con los `Depends` existentes de `src/api/deps.py`:
  - `src/models/feedback.py` — modelos Pydantic (request de creación, item del tablero, request de cambio de estado, request de comentario).
  - `src/services/feedback_service.py` — SQL + lógica, instanciado en el lifespan de `src/main.py` y expuesto en `app.state`.
  - `src/api/routers/feedback.py` con cuatro capacidades (nombres de ruta definitivos en el design):
    - **Crear** — `POST /feedback`, cualquier usuario autenticado (`Depends(get_current_user)`). Responde **201 con un ack mínimo** (id + estado inicial `Nuevo`); el `user_id` sale de la sesión, jamás del body.
    - **Leer el tablero** — `GET /feedback`, **cualquier usuario autenticado**: TODOS los reportes con tipo, cuerpo, contexto, estado, autor (email — el mismo identificador que ya expone `window_comments` como `author_email`; `users.name` es opcional y no alcanza como identificador), comentario del admin si existe y timestamps.
    - **Mover de columna** — `Depends(require_min_role(UserRole.ADMIN))` (`src/api/deps.py:219`): cambia el estado a cualquiera de los cinco valores; un valor fuera del conjunto es 422; un viewer/moderador recibe 403.
    - **Escribir/editar el comentario del admin** — `Depends(require_min_role(UserRole.ADMIN))`: un único comentario por tarjeta, opcional, reemplazable (la edición pisa el anterior; sin historial), con longitud acotada; también debe poder vaciarse.
- **Widget flotante global** en `dashboard/app/(app)/layout.tsx` (precedente directo: `OnboardingGate`, `NotificationBell` — "lo global va en el layout"): botón flotante siempre visible que abre un dialog con selector de tipo (falla/sugerencia) y textarea. Al enviar, el cliente adjunta automáticamente `usePathname()`, `window.location.href` y `navigator.userAgent`, **truncados a 300/2000/400 en el cliente**; el backend responde **422** si aun así exceden los límites (defensa en profundidad, no tolerancia). El **body NUNCA se trunca**: 1..2000 chars, validado en Pydantic y en la base. El timestamp lo pone la base (`now()`), no el cliente. Confirmación visual de envío y cierre.
- **Tablero Kanban** en una página nueva del dashboard autenticado (`dashboard/app/(app)/feedback/page.tsx`, con entrada en la navegación visible para TODO usuario autenticado): cinco columnas en el orden `Nuevo → En análisis → En progreso → Hecho` y `Descartado` visual y semánticamente separado del flujo (no es "otro Hecho"). Cada tarjeta muestra tipo, resumen del cuerpo, autor, fecha y el comentario del admin si existe; el detalle completo (contexto técnico incluido) se abre desde la tarjeta.
  - **Modo lectura** (viewer/moderador): sin controles de gestión. Arrastrar no hace nada y no existe ningún botón de mover/comentar.
  - **Modo gestión** (`ADMIN_ROLES` en el cliente, gate real `require_min_role(ADMIN)` en el backend, como documenta `AppSidebar.tsx`): **drag & drop** entre columnas con `@dnd-kit` (ya instalado en `dashboard/package.json` — `@dnd-kit/core`, `/sortable`, `/utilities` — para los walls; cero dependencias nuevas) **más un fallback sin arrastre** (menú "Mover a…" en la tarjeta) como requisito de accesibilidad: teclado, lectores de pantalla y pantallas táctiles no pueden depender del drag. Editor del comentario del admin en la tarjeta/detalle.
  - Un movimiento que el backend rechaza (403/422/red caída) **revierte la tarjeta a su columna original** con aviso; nunca queda una UI "optimista" mintiendo.
- **Helper de API** en `dashboard/lib/feedback.ts` (con `credentials: 'include'`, como todo `lib/api.ts`) y sus tests unitarios.
- **Strings i18n es/en** del widget y del tablero (nombres de las cinco columnas incluidos), en `dashboard/messages/{es,en}.json`, que ya tienen test de paridad (`messages/parity.test.ts`).
- Tests backend siguiendo los precedentes de comments/picks: unitarios de service + integración de endpoints, incluyendo 401 sin sesión y **403 con sesión de viewer en mover/comentar**, y **200 con sesión de viewer en la lectura del tablero**.

### Out of Scope

- **Capturas de pantalla / adjuntos**: almacenar blobs en TimescaleDB es un riesgo real ya pagado (incidente de disco lleno del 2026-08-28 que tiró prod) y el stack no tiene object storage. La captura automática de URL + ruta ya reproduce el contexto de la mayoría de las vistas (las URLs de share codifican canal y ventana). Si la beta demuestra que hace falta, es un change propio con decisión de almacenamiento.
- **Threading**: el admin deja UN comentario por tarjeta; no hay hilos, respuestas del tester ni comentarios de testers sobre tarjetas ajenas. Si un tester quiere agregar algo, manda otro reporte o se lo dice al admin por fuera.
- **Notificaciones** (push, ntfy, email) a testers cuando su tarjeta cambia de columna, o al admin cuando entra un reporte — el tablero ES la notificación: se consulta. Si el volumen lo justifica algún día, `disk_alert.py` ya muestra el molde ntfy.
- **Tiempo real en el tablero** (WebSocket/SSE): los datos se cargan al entrar y se refrescan al recargar o con un botón; a la escala de 4 testers no hay caso de uso que justifique un canal vivo.
- **Historial de transiciones / log de auditoría por tarjeta**: se guarda el estado actual y cuándo cambió por última vez, no la secuencia completa de movimientos.
- **Orden manual dentro de una columna, prioridades, asignaciones, etiquetas, fechas límite, votos de testers**: eso es un tracker de issues, no un canal de feedback de beta. El orden dentro de cada columna es fijo (por fecha).
- **Filtros/búsqueda en el tablero** más allá de lo que las columnas ya dan: el tablero de 5 columnas reemplaza a los filtros por estado del proposal original; con decenas de tarjetas como techo realista no hace falta más.
- **Honeypot y rate limit**: el patrón de `POST /beta-signups` existe porque ese endpoint es público y anónimo. `POST /feedback` exige sesión válida — un bot sin cookie `session` recibe 401 antes de tocar la base. Con ~4 cuentas beta conocidas, un rate limit agrega complejidad sin amenaza que mitigar; la validación Pydantic + `CHECK` de longitud acotan el abuso accidental.
- **Edición o borrado de reportes por el tester** — un reporte enviado es un registro, no un documento vivo. El admin tampoco borra: descarta (columna `Descartado`), que deja rastro.
- **Captura de estado interno de la app** más allá de la URL: el contexto prometido es ruta, URL completa, user agent y timestamp — no un snapshot del estado de React.

> **Exclusiones del proposal original que YA NO RIGEN** (retiradas explícitamente el 2026-09-03): "los testers solo envían; no ven los reportes de otros ni el estado de los propios"; "sin comentarios del admin"; "sin estados intermedios: solo abierto/resuelto derivado de `resolved_at`". Cualquier artefacto posterior (specs, design, tasks) que las repita está desactualizado.

## Approach

Calcar los precedentes existentes pieza por pieza — el único territorio nuevo respecto del repo es el tablero con drag & drop, y hasta eso reusa `@dnd-kit` de los walls:

1. **Base**: migración 019 idempotente (`CREATE TABLE IF NOT EXISTS`), FK a `users` con cascade, auto-aplicada al deploy. **Modelado del estado — decisión del design, con una obligación explícita**: el design anterior derivaba el estado de `resolved_at`, citando `src/models/beta.py` ("timestamps, no columnas de estado que puedan desincronizarse"). Ese criterio es correcto para un estado **binario** (hay o no hay un instante de resolución) y se rompe con **cinco estados y transiciones en ambos sentidos**: modelarlos con cinco timestamps nullable obliga a derivar el estado de "cuál es el más reciente" y abre exactamente la desincronización que el criterio quería evitar (una tarjeta con `done_at` y `in_progress_at` posteriores… ¿en qué columna está?). El modelo más probable es **una columna `status` con `CHECK` sobre los cinco valores**, acompañada de timestamps de auditoría (`updated_at` / `status_changed_at`) — pero el design debe **argumentarlo contra el rationale de `beta.py`, no ignorarlo**, y dejar escrito por qué el criterio no traslada.
2. **Backend**: router dedicado en `src/api/routers/feedback.py` (patrón `comments.py`, el más nuevo del repo) en lugar de inline en `main.py` — feedback es un dominio propio, no auth. Autorización con las dependencias ya existentes de `src/api/deps.py`: `get_current_user` para crear y leer el tablero, `require_min_role(UserRole.ADMIN)` para mover y comentar (el rol se lee fresco de la base en cada request, así que promover/degradar un admin es efectivo al request siguiente). **Transiciones permitidas — decisión del design, sin restricción del usuario**: el usuario NO fijó una máquina de estados; el design elige entre "admin mueve de cualquier columna a cualquier otra" (simple, corrige errores con un arrastre de vuelta) y una máquina estricta (más chequeos, más 4xx, más strings i18n de error) y lo justifica.
3. **Frontend**: widget cliente montado en el layout de `(app)` — visible en TODO el dashboard autenticado sin tocar página por página. Tablero como página propia con un solo componente Kanban que recibe `canManage` (derivado del rol del `useAuth`/sesión, mismo mecanismo que `ADMIN_ROLES` en `AppSidebar.tsx`) y solo entonces monta sensores de dnd, menú "Mover a…" y editor de comentario. El servidor sigue siendo el juez: un cliente que fuerce `canManage` recibe 403 y la tarjeta vuelve a su lugar.
4. **Contexto técnico sin infraestructura**: el cliente manda `pathname`, `href` y `userAgent` truncados en el body del POST; el server valida los límites (422 si se exceden), agrega `user_id` (de la sesión, jamás del body) y `created_at`.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `deploy/sql/migrations/019_feedback_reports.sql` | New | Tabla `feedback_reports`: reporte + estado (5 valores) + comentario admin + timestamps; idempotente, patrón 017 |
| `src/models/feedback.py` | New | Modelos Pydantic: creación, item del tablero (con `author_email`, `status`, `admin_comment`), cambio de estado, comentario |
| `src/services/feedback_service.py` | New | SQL + lógica (patrón `window_comments.py`): crear, listar tablero, mover, comentar |
| `src/api/routers/feedback.py` | New | Crear (auth), leer tablero (auth), mover (admin), comentar (admin) |
| `src/main.py` | Modified | Registrar el router + instanciar el service en el lifespan (`app.state.feedback_service`) — cambios mínimos y aditivos |
| `dashboard/app/(app)/layout.tsx` | Modified | Montar el widget flotante global (una línea, junto a `OnboardingGate`) |
| `dashboard/components/feedback/` (widget + tablero) | New | Botón flotante + dialog de envío; componente Kanban con modo lectura/gestión, dnd (`@dnd-kit`, ya instalado) y fallback "Mover a…" |
| `dashboard/app/(app)/feedback/page.tsx` | New | Página del tablero, visible para todo usuario autenticado |
| `dashboard/components/AppSidebar.tsx` | Modified | Entrada de navegación al tablero para TODOS los usuarios (no en `adminRoutes`: el tablero es de todos; lo que cambia por rol es la interactividad) |
| `dashboard/lib/feedback.ts` (+ tests) | New | Cliente API del dominio feedback con `credentials: 'include'` |
| `dashboard/messages/{es,en}.json` | Modified | Strings del widget, del tablero y de las cinco columnas (paridad es/en obligatoria) |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| En prod hay 4 cuentas y CERO admins (auditoría 2026-08-17; superadmin solo local): nadie puede mover tarjetas ni comentar hasta promover una cuenta | High (es el estado actual) | Dependencia de rollout explícita: el usuario promueve su propia cuenta a admin desde `/admin/users` (UI ya existente) — sin código nuevo; se verifica como criterio de éxito. El tablero en modo lectura y el envío funcionan igual sin admin |
| El tablero expone a todos los testers el email de quien reportó y el texto completo de cada reporte | Med (por diseño) | Decisión consciente del usuario para una beta cerrada de cuentas conocidas — la transparencia ES el objetivo. El widget lo dice antes de enviar ("tu reporte será visible para los demás testers"). Si la beta se abre a desconocidos, revisar |
| Drag & drop excluye teclado, lectores de pantalla y touch | Med | Fallback obligatorio sin arrastre (menú "Mover a…") en scope, no opcional; `@dnd-kit` además trae `KeyboardSensor` |
| UI optimista que muestra una tarjeta movida cuando el backend la rechazó (403 por rol degradado, 422, red) | Med | Requisito explícito: revertir a la columna original con aviso; test del componente que simula el rechazo |
| Dos admins mueven la misma tarjeta a la vez | Low (hoy habrá UN admin) | Último escribe gana; sin bloqueo optimista en v1 — documentado, no mitigado, porque el costo supera el riesgo a esta escala |
| `Descartado` se confunde con `Hecho` y un tester cree que su bug se arregló | Med | Separación visual (columna aparte, fuera del flujo, estilo distinto) Y semántica (string i18n propio, `aria-label` propio); criterio de éxito específico |
| El tester espera que "canal o ventana abierta" viaje siempre, pero solo viaja lo que la URL codifica | Med | El proposal promete URL + ruta, no estado interno; el body libre del tester cubre el resto; se documenta en la UI del widget |
| Un widget flotante global puede tapar controles existentes (walls densos, overlays de mapas/globo) | Med | Posición fija en esquina con `z-index` coordinado con los overlays existentes; QA visual del usuario (canvas+MCP rotos) como tarea explícita |
| Texto libre (cuerpo del reporte, comentario del admin) renderizado para todos los testers (XSS almacenado) | Low | React escapa por defecto; se renderiza como texto plano, nunca `dangerouslySetInnerHTML`; longitud acotada por Pydantic + `CHECK` |
| Crecimiento de la tabla sin límite | Low | Texto acotado, ~4 testers, sin adjuntos; retención/limpieza queda para cuando exista el problema |

## Rollback Plan

1. **Código**: revertir el commit — todos los cambios de backend son aditivos (router nuevo, service nuevo, dos líneas en `main.py`) y los de frontend también (componentes nuevos, una línea en el layout, una entrada de navegación, una página nueva). Nada existente cambia de comportamiento.
2. **Migración**: la 019 es aditiva e idempotente; revertir el código deja la tabla `feedback_reports` huérfana pero inerte (nadie la consulta). Si se quiere limpiar: `DROP TABLE feedback_reports;` manual — no hay FKs entrantes desde otras tablas, solo la FK saliente a `users`.
3. **Sin estado compartido**: el change no toca ingesta, walls, eventos ni auth — apagarlo no degrada ninguna funcionalidad existente. `@dnd-kit` ya estaba instalado para los walls; no se agrega ni se quita ninguna dependencia.

## Dependencies

- **Promover al menos una cuenta a admin en prod** (hoy hay cero) — la cuenta del propio usuario, vía `/admin/users` — previa al cierre del change. Sin esto, el tablero es de solo lectura para todo el mundo.
- Migraciones auto-aplicadas activas en el servicio api de Railway (`RUN_MIGRATIONS_ON_STARTUP`) — ya operativo desde la migración 015+.
- `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities` — ya presentes en `dashboard/package.json`.
- Ninguna dependencia externa nueva (sin librerías, sin servicios, sin storage).

## Success Criteria

- [ ] Un beta tester autenticado, desde cualquier página del dashboard, envía un reporte (tipo + texto) en un solo flujo (abrir widget → escribir → enviar → confirmación) sin salir de la página en la que está, y recibe 201 con un ack mínimo.
- [ ] El reporte guardado en `feedback_reports` contiene, sin que el tester haya tecleado nada de esto: ruta, URL completa, user agent y timestamp del server, y nace en estado `Nuevo` — verificable con un SELECT tras un envío de prueba.
- [ ] Un body de 2001 chars responde 422 y no crea fila (nunca se trunca); una ruta/URL/UA por encima de 300/2000/400 que llegue al backend responde 422 — cubierto por tests de integración.
- [ ] Un viewer autenticado obtiene 200 en la lectura del tablero y ve TODOS los reportes (propios y ajenos) con su columna y el email del autor; el mismo viewer obtiene **403** al intentar mover una tarjeta o escribir el comentario del admin; sin sesión, todo es 401 — cubierto por tests de integración, no solo por inspección.
- [ ] Un admin mueve una tarjeta de `Nuevo` a `En progreso`; la fila cambia en la base y un tester que recarga su tablero la ve en `En progreso`. Un estado fuera de los cinco valores responde 422.
- [ ] Un admin escribe un comentario en una tarjeta y luego lo edita; el tester ve la versión editada (una sola, sin historial). El comentario puede vaciarse.
- [ ] En el tablero, un tester (viewer) no encuentra ningún control de mover ni de comentar, y arrastrar una tarjeta no cambia nada — test del componente en modo lectura.
- [ ] En modo gestión, mover una tarjeta funciona tanto por drag & drop como por el menú "Mover a…" (accesible por teclado); si el backend rechaza el movimiento, la tarjeta vuelve a su columna original con aviso — test del componente que simula el rechazo.
- [ ] `Descartado` es una columna visual y semánticamente distinta de `Hecho` (posición separada del flujo, estilo propio, string i18n propio en es y en) — QA visual del usuario + test de paridad i18n verde.
- [ ] La migración 019 se auto-aplica en el deploy sin intervención manual (mismo mecanismo verificado de la 015 en adelante) y un segundo arranque es no-op.
- [ ] Rollout: la cuenta del usuario está promovida a admin en prod (visible en `/admin/users`) y desde ella se completa una transición real y un comentario real en el tablero de producción.
- [ ] QA visual del usuario: el botón flotante es visible y no tapa controles en las vistas densas (walls, globe, live), en desktop.

## Open Questions (para el design)

- [ ] **Modelo del estado**: columna `status` con `CHECK` de cinco valores + `status_changed_at`/`updated_at`, versus timestamps múltiples. El design debe argumentar contra el rationale de `src/models/beta.py`, no omitirlo (ver Approach §1).
- [ ] **Transiciones**: cualquiera→cualquiera para el admin, o máquina de estados estricta. El usuario no lo restringió; el design decide y justifica (ver Approach §2).
- [ ] **Una página o dos**: un solo `/feedback` con `canManage` por rol (recomendado: una sola fuente de verdad visual para admin y testers), o una `/admin/feedback` separada además del tablero de lectura. Si el design elige dos, debe justificar la duplicación.
- [ ] **Forma del ack de creación**: qué campos mínimos devuelve el 201 (id + estado, ¿algo más?) — decisión de contrato del design.
