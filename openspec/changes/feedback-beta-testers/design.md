# Design: Panel de Feedback para Beta Testers (tablero Kanban)

> **Historial**: design original 2026-09-01 para el alcance binario (estado derivado de
> `resolved_at`, `GET` solo-admin, endpoint `resolve`, página `/admin/feedback` con filtros).
> **Reescrito el 2026-09-03** para el proposal enmendado: cinco estados, tablero visible para
> todo usuario autenticado, admin mueve y comenta. Las decisiones que siguen vigentes se
> conservaron y se **re-verificaron contra el código** el 2026-09-03 (archivo y línea citados).

## Technical Approach

Este change no introduce ningún patrón nuevo salvo el tablero con drag & drop — y hasta eso
reusa `@dnd-kit` (`core ^6.3.1`, `sortable ^10.0.0`, `utilities ^3.2.2`, ya en
`dashboard/package.json`, usados en `app/(app)/spectrograms/page.tsx` y
`components/SortableSpectrogramCard.tsx`). Cada pieza calca un precedente verificado:

1. **Base**: migración `deploy/sql/migrations/019_feedback_reports.sql` con el molde de
   `017_window_comments.sql` (UUID + `gen_random_uuid()`, FK a `users` `ON DELETE CASCADE`,
   `CHECK` de longitud, `created_at DEFAULT now()`), idempotente, auto-aplicada por
   `scripts/apply_migrations.py` (glob ordenado + `pg_advisory_lock`, gateado por
   `RUN_MIGRATIONS_ON_STARTUP` en `src/main.py:345-350`). **El estado es una columna
   `status` con `CHECK` de cinco valores**, no un timestamp derivado — la Decision 1 argumenta
   por qué el criterio de `src/models/beta.py` no traslada a cinco estados bidireccionales.
2. **Backend**: router dedicado `src/api/routers/feedback.py` con el molde de `comments.py`
   (`APIRouter` + service resuelto desde `request.app.state.*`), modelos en
   `src/models/feedback.py`, SQL en `src/services/feedback_service.py` con el patrón "pool
   prestado" de `src/services/window_comments.py`. Autorización 100% con los `Depends`
   existentes de `src/api/deps.py`: `get_current_user` (l.40) para crear y leer,
   `require_min_role(UserRole.ADMIN)` (l.219) para mover y comentar.
3. **Frontend**: widget cliente montado en `dashboard/app/(app)/layout.tsx` (precedente
   `OnboardingGate`, `NotificationBell`), **una sola página `/feedback`** para todos con un
   flag `canManage` derivado de `useAuth().user.role`, tablero Kanban con `@dnd-kit` +
   fallback "Mover a…", datos con `useSWR` (patrón `UsersPanel.tsx`), helper con el molde de
   `lib/walls.ts`, i18n es/en con paridad forzada por `messages/parity.test.ts`.

### Valores de contrato fijados (compartidos con `specs/`)

Para que specs y design no deriven, estos valores son **los mismos en ambos artefactos**:

| Contrato | Valor |
|---|---|
| Enum de estado en la API | `new \| in_analysis \| in_progress \| done \| discarded` (snake_case inglés; las etiquetas humanas "Nuevo / En análisis / En progreso / Hecho / Descartado" son i18n del cliente) |
| Estado inicial | `new` (default de la columna, no lo manda el cliente) |
| Transiciones admin | cualquiera → cualquiera; estado desconocido ⇒ **422**; mismo estado ⇒ **200 no-op idempotente** (`status_changed_at` NO cambia) |
| Comentario del admin | 1..2000 chars; `null` o vacío (tras `strip`) **borra** el comentario; `PUT` idempotente (mismo texto ⇒ `admin_comment_updated_at` NO cambia) |
| Límites de contexto | `route` ≤300, `url` ≤2000, `user_agent` ≤400 — el cliente **trunca**, el backend responde **422** si aun así exceden |
| Body del reporte | 1..2000, **nunca se trunca** (422 por exceso) |
| Ack del POST | `201` + `{ "id": UUID, "created_at": datetime }` (el estado inicial es `new` por contrato, no viaja en el ack) |

## Architecture Decisions

### Decision 1: Columna `status` con `CHECK` de cinco valores + timestamps de auditoría específicos — NO el criterio "timestamps, no columnas de estado" de `beta.py`

**Choice**:

```sql
-- 019: reportes de feedback de beta testers (change feedback-beta-testers).
--
-- El estado ES una columna (status) y no se deriva de timestamps. El criterio
-- de beta_signups/invitations ("timestamps, no columnas de estado que puedan
-- desincronizarse", src/models/beta.py) es correcto para un estado BINARIO:
-- un instante de aprobación existe o no existe, y esa columna es a la vez el
-- estado y el cuándo. Con CINCO estados y movimientos en ambos sentidos
-- (done → in_progress es legítimo), cinco timestamps nullable obligarían a
-- derivar el estado de "cuál es el más reciente" en SQL, en Pydantic y en TS
-- — tres derivaciones que pueden divergir — y a PERDER información al mover
-- hacia atrás (¿se limpia done_at?). Esa es exactamente la desincronización
-- que el criterio quería evitar. Acá: una columna dice EN QUÉ columna está la
-- tarjeta, otra dice DESDE CUÁNDO. Sin historial de transiciones (fuera de
-- alcance, proposal). TEXT + CHECK y no un ENUM de Postgres: mismo patrón que
-- `type` acá y que el resto del repo; agregar un valor es un ALTER del CHECK
-- en una migración aditiva, sin ALTER TYPE.

CREATE TABLE IF NOT EXISTS feedback_reports (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type                     TEXT NOT NULL CHECK (type IN ('bug', 'suggestion')),
    body                     TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
    -- Contexto técnico capturado por el cliente: columnas acotadas, no JSONB
    -- (shape fijo y conocido; un JSONB libre no valida nada).
    route                    TEXT NOT NULL CHECK (char_length(route) <= 300),
    url                      TEXT NOT NULL CHECK (char_length(url) <= 2000),
    user_agent               TEXT NOT NULL DEFAULT '' CHECK (char_length(user_agent) <= 400),
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Tablero Kanban: columna actual + desde cuándo está ahí.
    status                   TEXT NOT NULL DEFAULT 'new'
                             CHECK (status IN ('new', 'in_analysis', 'in_progress', 'done', 'discarded')),
    status_changed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- UN comentario opcional del admin, reemplazable, sin historial. Ambas
    -- columnas van juntas: las dos NULL (sin comentario) o las dos con valor.
    admin_comment            TEXT NULL
                             CHECK (admin_comment IS NULL OR char_length(admin_comment) BETWEEN 1 AND 2000),
    admin_comment_updated_at TIMESTAMPTZ NULL,
    CONSTRAINT feedback_reports_comment_pair
        CHECK ((admin_comment IS NULL) = (admin_comment_updated_at IS NULL))
);
```

**El archivo sigue siendo `019`**: verificado el 2026-09-03 con `eza deploy/sql/migrations/`
— la última es `018_comment_anchor_time.sql`, no existe ningún `019_*`, y nada de este
change se aplicó todavía (working tree sin commitear). `collect_migration_files()` ordena
por nombre (`sorted(directory.glob("*.sql"))`), así que la 019 entra sola en el próximo
arranque; el fixture `_migrated` de los tests de integración aplica el mismo glob.

> **Reconciliado 2026-09-03 (la spec gana en comportamiento observable)**: `status_changed_at` es `TIMESTAMPTZ NULL` **sin `DEFAULT`** — nace `null` y el primer movimiento lo setea (el `CASE WHEN status <> $2 THEN now() ELSE status_changed_at END` de `set_status` funciona igual con `NULL`); en consecuencia `FeedbackReportItem.status_changed_at: Optional[datetime] = None` y en TS `status_changed_at: string | null`. El SQL de arriba y los contratos de abajo se leen con esa corrección.

**Alternatives considered**:

- **Cinco timestamps nullable (`in_analysis_at`, `in_progress_at`, `done_at`, `discarded_at`)
  derivando el estado del más reciente** — extensión literal del criterio de `beta.py`.
  Descartada con argumento, no ignorada: (a) la derivación "el timestamp más reciente gana"
  hay que escribirla en SQL (`GREATEST` + `CASE`), en el modelo Pydantic y en el tipo TS, tres
  lugares que pueden divergir; (b) un movimiento hacia atrás (`done → in_progress`, corregir
  un error) exige borrar `done_at` (se pierde el dato) o dejarlo (y entonces el "más
  reciente" miente); (c) `discarded` y `done` son terminales distintos: con timestamps, una
  tarjeta con ambos seteados no tiene columna. El criterio de `beta.py` sirve porque en
  binario **el timestamp ES el estado**; con cinco valores deja de serlo.
- **`status` + `updated_at` genérico** — descartada: un `updated_at` único dice que ALGO
  cambió, no QUÉ. El tablero necesita "desde cuándo está en esta columna" (`status_changed_at`)
  y "cuándo editó el comentario el admin" (`admin_comment_updated_at`); un genérico se pisa
  con cada edición de comentario y deja de servir para lo primero. Dos timestamps
  específicos valen más que uno genérico, y son los que los tests de idempotencia comparan.
- **`CREATE TYPE feedback_status AS ENUM`** — descartada: el repo modela enums como
  `TEXT + CHECK` (`type` en esta misma tabla, `role` en `users`); un ENUM de Postgres
  agrega un tipo que no valida nada más que el CHECK y complica el ALTER futuro.
- **Tabla `feedback_status_transitions` (historial)** — fuera de alcance explícito del
  proposal ("se guarda el estado actual y cuándo cambió por última vez").
- **Índices** (`(status, created_at)`, FK `user_id`) — descartados por volumen medido: ~4
  cuentas, decenas de filas como techo. Un seq scan es más barato que mantener el índice;
  agregarlo mañana es una migración aditiva trivial.

**Rationale**: molde 017 columna por columna; `user_agent DEFAULT ''` (un UA ausente no es un
estado a distinguir — evita three-valued logic); `ON DELETE CASCADE` (un reporte es un
registro ligado a la cuenta; el hard-delete de `DELETE /account` se lo lleva, la
desactivación soft no). El `CHECK` de par `admin_comment`/`admin_comment_updated_at`
convierte en error de base la desincronización que el criterio de `beta.py` temía.

### Decision 2: Cuatro endpoints — `GET`/`POST /feedback` para cualquier autenticado, `PUT /feedback/{id}/status` y `PUT /feedback/{id}/comment` para admin+

**Choice**:

| Endpoint | Auth (`src/api/deps.py`) | Request | Response |
|---|---|---|---|
| `POST /feedback` | `Depends(get_current_user)` | `FeedbackReportCreate` | `201` + `FeedbackReportCreated` `{id, created_at}` |
| `GET /feedback` | `Depends(get_current_user)` | — | `200` + `{"reports": [FeedbackReportItem, ...]}` ordenado `created_at DESC` |
| `PUT /feedback/{report_id}/status` | `Depends(require_min_role(UserRole.ADMIN))` | `FeedbackStatusUpdate` `{status}` | `200` + `FeedbackReportItem` completo; `404` si no existe; `422` estado desconocido |
| `PUT /feedback/{report_id}/comment` | `Depends(require_min_role(UserRole.ADMIN))` | `FeedbackAdminCommentUpdate` `{comment}` | `200` + `FeedbackReportItem` completo; `404` si no existe; `422` >2000 |

- `user_id` sale de `current_user.id`; `FeedbackReportCreate` **no tiene el campo**.
- `created_at`, `status_changed_at` y `admin_comment_updated_at` los pone la base (`now()`)
  — el reloj del cliente no manda (lección `utcnow-naive-desplaza-la-hora`).
- `GET` devuelve la lista **plana**; el cliente agrupa por `status` (un `reduce`). El `JOIN
  users` trae `author_email` como `window_comments.list_for_window`.
- Los dos `PUT` devuelven el item completo (no un ack) para que el cliente **reconcilie la
  tarjeta en su lugar** tras el optimista, sin refetch del tablero.
- Los 401/403 salen gratis: `get_current_user` responde 401 sin cookie, token inválido o
  cuenta desactivada (`deps.py:119`, `is_active`); `require_min_role` responde 403 a
  viewer/moderador con sesión válida (`deps.py:241`). El rol se lee **fresco de la base** en
  cada request, así que promover al usuario a admin en `/admin/users` habilita mover y
  comentar en el request siguiente, sin re-login.

**SQL del movimiento (idempotente, en `FeedbackService.set_status`)**:

```sql
WITH updated AS (
    UPDATE feedback_reports
       SET status = $2,
           -- El "desde cuándo" solo avanza si la tarjeta CAMBIA de columna:
           -- soltar la tarjeta en la misma columna es un no-op.
           status_changed_at = CASE WHEN status <> $2 THEN now() ELSE status_changed_at END
     WHERE id = $1
 RETURNING *
)
SELECT u.id, u.type, u.body, u.route, u.url, u.user_agent, u.created_at,
       u.status, u.status_changed_at, u.admin_comment, u.admin_comment_updated_at,
       usr.email AS author_email
  FROM updated u
  JOIN users usr ON usr.id = u.user_id
```

`fetchrow` devuelve `None` ⇒ `FeedbackReportNotFoundError` ⇒ `404` en el router (patrón
`WindowCommentNotFoundError`). El valor de `$2` ya pasó por el `Literal` de Pydantic; el
`CHECK` de la base es la segunda línea, no la primera.

**SQL del comentario (idempotente, en `FeedbackService.set_admin_comment`)** — `$2` ya
normalizado por Pydantic (`strip`; vacío ⇒ `NULL`):

```sql
UPDATE feedback_reports
   SET admin_comment = $2,
       admin_comment_updated_at = CASE
           WHEN $2 IS NULL THEN NULL                                   -- borrar: par en NULL
           WHEN admin_comment IS DISTINCT FROM $2 THEN now()           -- texto nuevo
           ELSE admin_comment_updated_at                               -- mismo texto: no-op
       END
 WHERE id = $1
RETURNING ...  -- mismo SELECT + JOIN users que arriba
```

**Alternatives considered**:

- **Un solo `PATCH /feedback/{id}` con `status` y `comment` opcionales** — descartada: son dos
  sub-recursos con semánticas distintas (mover vs. comentar), cada uno con su 422 propio, su
  test de idempotencia propio y su mutación crítica propia; un `PATCH` mezclado necesita
  "al menos un campo" como validación extra, deja ambiguo qué falló en un 422 y obliga al
  cliente a mandar `comment` para no borrarlo sin querer (o a inventar semántica de
  "ausente ≠ null"). Dos `PUT` de reemplazo total son exactamente idempotentes por
  definición HTTP y el repo ya usa `PUT` para reemplazo (`walls.py:59`, `picks.py:94`,
  `areas.py:127`); `PATCH` aparece solo para parciales reales (`areas.py:155`,
  `main.py:2099`).
- **`POST /feedback/{id}/move`** (verbo de acción, como el `approve` de beta-signups) —
  descartada: el `approve` es una acción one-way sin payload; mover tiene payload (el
  destino) y es un reemplazo del valor de `status`. `PUT …/status` lo dice sin inventar
  vocabulario.
- **`GET` devuelve `{"columns": {"new": [...], ...}}` agrupado** — descartada: agrupar es
  presentación; la lista plana es el shape de `comments.py` (`{"comments": [...]}`) y
  permite al cliente contar, filtrar y agrupar sin re-pedir.
- **`GET` admin-only con una vista "mis reportes" para testers** — descartada por decisión
  del usuario (no negociable): todos leen TODO el tablero, con email del autor.
- **`PUT` devuelven `{"ok": true}`** — descartada: obliga al cliente a refetch para
  reconciliar la tarjeta; devolver el item cuesta un `JOIN` que ya se hace igual.

**Rationale**: cada verbo copia el precedente más cercano; los `Depends` son los mismos que
~10 endpoints admin de `main.py`; la idempotencia vive en el SQL (`CASE`), no en un
`SELECT` previo — un solo round-trip y ninguna ventana de carrera entre leer y escribir.

### Decision 3: Auth con los `Depends` existentes — cuentas desactivadas y rol fresco (vigente, re-verificada)

**Choice**: `get_current_user` para `POST`/`GET`, `require_min_role(UserRole.ADMIN)` para los
dos `PUT`. Cero código de auth nuevo.

**Consecuencias verificadas contra `src/api/deps.py` el 2026-09-03**: round-trip a la base en
CADA request; 401 si `not state.is_active or state.role is None` (l.119); rol sobrescrito con
el de la base (habilita la dependencia de rollout: hoy CERO admins en prod). Reportes de
cuentas desactivadas (soft) siguen visibles con su `author_email` — son registro histórico;
solo el hard-delete arrastra vía `CASCADE`.

**Alternatives considered**: `require_role(UserRole.ADMIN)` (igualdad exacta, l.189) dejaría
afuera al superadmin — descartada; excluir del `GET` los reportes de cuentas desactivadas —
descartada (esconder feedback ya enviado no compra nada).

### Decision 4: Sin rate limit ni honeypot en `POST /feedback` (vigente)

Honeypot + rate limit de `POST /beta-signups` existen porque ese endpoint es **público y
anónimo**. `POST /feedback` exige cookie `session`: un bot sin sesión recibe 401 antes de
tocar la base; un "atacante" con sesión es una de ~4 cuentas conocidas y el remedio es
desactivarla en `/admin/users`. El `CHECK (1..2000)` acota el daño por reporte.

### Decision 5: Una sola página `/feedback` para todos, con `canManage` derivado del rol de la sesión — NO dos páginas

**Choice**: `dashboard/app/(app)/feedback/page.tsx` (`'use client'`), entrada en `routes`
(NO en `adminRoutes`) de `AppSidebar.tsx` con `nav.feedback`. La página lee
`const { user } = useAuth()` y calcula
`const canManage = user !== null && ADMIN_ROLES.includes(user.role)` — **el mismo mecanismo,
literal, de `AppSidebar.tsx:41-50` y `admin/access/page.tsx:29-95`** (`ADMIN_ROLES =
['admin', 'superadmin']`, const local del módulo). El rol llega al cliente por
`GET /auth/me` → `UserPublic.role` (`dashboard/lib/types.ts:146-152`), hidratado una vez por
`AuthProvider` (`hooks/use-auth.tsx`). `canManage` es UX: el juez es el 403 del backend, y
el componente lo trata como un rechazo más (Decision 7).

**Alternatives considered**:

- **Dos páginas (`/feedback` lectura + `/admin/feedback` gestión)** — descartada: duplica el
  Kanban entero (columnas, tarjetas, detalle) para cambiar tres cosas (sensores de dnd, menú
  "Mover a…", editor de comentario); dos páginas divergen en la primera iteración y el admin
  pierde la vista "lo que ven los testers", que es el objetivo de la transparencia. El
  proposal ya recomendaba una sola fuente de verdad visual.
- **Extraer `ADMIN_ROLES` a `lib/roles.ts` y refactorizar sidebar + access** — descartada
  para este change: el patrón vigente en el repo es la const local (dos precedentes);
  consolidar es deuda menor y "funcionalidad antes que deuda técnica" es preferencia
  documentada del usuario. Queda anotado como limpieza opcional posterior.
- **Server Component con `fetch` en Next** — descartada: todas las páginas autenticadas son
  client components contra FastAPI con `credentials: 'include'`; SSR con forwarding de
  cookie sería un patrón nuevo sin necesidad.

### Decision 6: Kanban con `@dnd-kit/core` (`useDroppable` por columna + `useDraggable` por tarjeta) — no `sortable` — más fallback "Mover a…"

**Choice**: componentes en `dashboard/components/feedback/`:

- `FeedbackBoard.tsx` — recibe `reports`, `canManage`, callbacks `onMove(id, status)` y
  `onComment(id, text)`. Agrupa por `status` (`reduce`) en el orden fijo
  `['new','in_analysis','in_progress','done']` y renderiza `discarded` como **quinta columna
  separada** (separador visual + clase propia + `aria-label` propio: no es "otro Hecho").
  Cuando `canManage`, envuelve las columnas en `<DndContext sensors={sensors}
  collisionDetection={pointerWithin} onDragEnd={...}>` con
  `useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  useSensor(KeyboardSensor))` — el `PointerSensor` con `distance: 5` es literalmente el de
  `spectrograms/page.tsx:141` (evita que un click para abrir el detalle arranque un drag).
  Cuando **no** `canManage`, **no monta `DndContext`**: las columnas son divs planos y
  arrastrar no hace nada — no hay un "modo deshabilitado" que un cliente pueda forzar desde
  DevTools sin igual comerse el 403.
- `FeedbackColumn.tsx` — `useDroppable({ id: status })`; encabezado con etiqueta i18n
  (`feedback.status.<status>`) y contador.
- `FeedbackCard.tsx` — `useDraggable({ id: report.id, disabled: !canManage })` (patrón
  `attributes`/`listeners`/`setNodeRef`/`CSS.Translate.toString(transform)` de
  `SortableSpectrogramCard.tsx:36-88`). Muestra badge de tipo, primeras líneas del `body`
  (texto plano, `line-clamp`), `author_email`, fecha (`useFormatter`), y el `admin_comment` si
  existe. Click abre `FeedbackCardDetail`. Si `canManage`: menú **"Mover a…"** con
  `ui/dropdown-menu.tsx` (Radix, `z-[1100]`, accesible por teclado) listando los otros cuatro
  estados — el fallback de accesibilidad que el proposal exige.
- `FeedbackCardDetail.tsx` — `ui/dialog.tsx` con body completo (`whitespace-pre-wrap`, texto
  plano, jamás `dangerouslySetInnerHTML`), contexto técnico (route como texto, url como link
  `target="_blank" rel="noopener noreferrer"`, user agent), `status_changed_at`; si
  `canManage`, editor del comentario del admin (textarea `maxLength=2000` + "Guardar" +
  "Borrar comentario" que manda `null`).

**Alternatives considered**:

- **`@dnd-kit/sortable` + `SortableContext` por columna** (lo que usan los walls) —
  descartada: sortable ordena dentro de una lista y el proposal fija el orden dentro de cada
  columna (por fecha, fijo). Lo único que se mueve es la tarjeta ENTRE columnas: droppable
  por columna + draggable por tarjeta es el modelo mínimo y no tienta a implementar orden
  manual "porque ya está".
- **Drag & drop solo, sin menú** — descartada: excluye teclado, lectores de pantalla y
  touch; `KeyboardSensor` mitiga pero no reemplaza un menú explícito.
- **Menú solo, sin drag** — descartada: el usuario pidió Kanban con arrastre; el menú es el
  fallback, no el reemplazo.
- **`DragOverlay`** — no en v1: la tarjeta se traslada con `transform`; el overlay es pulido
  visual que se agrega sin tocar contrato si el QA lo pide.

### Decision 7: Datos con `useSWR` + actualización optimista con `rollbackOnError`, y el reporte nuevo aparece revalidando la key del tablero

**Choice**: en `page.tsx`, `useSWR(FEEDBACK_SWR_KEY, listFeedbackReports)` con
`FEEDBACK_SWR_KEY = '/feedback'` exportada desde `lib/feedback.ts`. Mover:

```ts
await mutate(
  updateFeedbackStatus(id, status).then((updated) => replaceById(reports, updated)),
  {
    optimisticData: moveLocally(reports, id, status),
    rollbackOnError: true,   // 403/422/red ⇒ la tarjeta vuelve a su columna
    populateCache: true,     // el item que devuelve el PUT reemplaza al optimista
    revalidate: false,
  },
).catch((err) => setOutcome({ kind: 'moveFailed', status: err instanceof ApiStatusError ? err.status : null }));
```

Es la API estándar de `swr ^2.2.5` (verificada en `package.json:41`) y hace exactamente lo
que el proposal pide: nunca una UI optimista que mienta. El aviso se renderiza desde un
`outcome` **como dato** (`kind` + status), nunca como string ya traducido — patrón de
`UsersPanel.tsx:78,151` para que el cambio de idioma en caliente no deje texto viejo. Un
`ApiStatusError` con `status === 403` muestra el mensaje "sin permisos" (rol degradado en
caliente); `updateFeedbackStatus` que resuelve `null` (401) se trata como fallo también
(la sesión venció: revertir y avisar). El comentario usa el mismo `mutate` optimista.

**Dónde aparece el reporte del tester tras enviar (Open Question 4 del proposal)**: el
widget, tras el 201, llama `mutate(FEEDBACK_SWR_KEY)` de `useSWRConfig()` (mutate global por
key). Si el tablero está montado (el tester envió desde `/feedback`), la key tiene
suscriptores y se revalida: la tarjeta aparece en `Nuevo` sin recargar. Si no hay tablero
montado, la llamada es un no-op sin fetch — costo cero. La confirmación del widget incluye
un link "Ver en el tablero" (`<Link href="/feedback">`) — el tester decide si va; el widget
**no navega solo** (criterio de éxito: "sin salir de la página en la que está").

**Alternatives considered**:

- **`mutate()` de revalidación tras cada acción, sin optimista** — descartada: un spinner por
  arrastre hace que el Kanban se sienta roto; el optimista con rollback es un flag de SWR.
- **Revertir a mano con `setState` local** — descartada: dos fuentes de verdad (cache SWR +
  estado local) es la clase de bug que el propio SWR resuelve con `rollbackOnError`.
- **`router.push('/feedback')` tras enviar** — descartada: saca al tester de lo que estaba
  mirando; contradice el criterio de éxito.
- **Realtime (WebSocket/SSE)** — fuera de alcance del proposal; botón "Actualizar" que hace
  `mutate()` + revalidación al foco (default de SWR) alcanza para 4 testers.

### Decision 8: Widget flotante — componente cliente en el layout de `(app)`, captura en el submit (vigente, ajustada)

**Choice**: `dashboard/components/feedback/FeedbackWidget.tsx` (`'use client'`), montado UNA
vez en `dashboard/app/(app)/layout.tsx` dentro de `SidebarInset` junto a `<OnboardingGate />`
(verificado: el layout hoy monta `LocaleSync`, `NotificationBell`, `OnboardingGate` — "lo
global va en el layout").

- **Botón**: `fixed bottom-6 right-6 z-[1050]` — entre los panes de Leaflet (`z-[1000]`) y
  los overlays (`ui/dialog.tsx:44`, `dropdown-menu.tsx:32`, `sheet.tsx:41`: `z-[1100]`). El
  viewport de toasts es `fixed bottom-0 right-0 z-[100]` (`ui/toast.tsx:96`): colisión
  transitoria aceptada y punto explícito del QA visual del usuario.
- **Dialog** (`ui/dialog.tsx`): dos botones tipo radio para `bug | suggestion`, `<textarea>`
  nativo con las clases de `ui/input.tsx` (no existe `ui/textarea.tsx`; no se agrega un
  primitivo para un solo uso), `maxLength={2000}` + contador, y dos leyendas fijas i18n:
  "se adjunta el contexto de la página actual (ruta, URL, navegador)" y **"tu reporte será
  visible para los demás testers"** (Risk del proposal: transparencia dicha antes de enviar).
- **Captura en el SUBMIT**: `usePathname()` → `route.slice(0, 300)`, `window.location.href`
  → `.slice(0, 2000)`, `navigator.userAgent` → `.slice(0, 400)`. El body **no se trunca**:
  el `maxLength` del textarea y la validación local (1..2000) lo acotan; si igual llega un
  422 se muestra el error con el texto preservado.
- **Estados**: `idle → open → sending → sent | error` (texto preservado en `error`; submit
  deshabilitado en `sending` para evitar doble envío). En `sent`: confirmación + link al
  tablero + `mutate(FEEDBACK_SWR_KEY)`.

### Decision 9: Helper `dashboard/lib/feedback.ts` con el molde de `walls.ts` (vigente, ampliada)

`request<T>` local calcado de `lib/walls.ts:13-31` (`credentials: 'include'`,
`cache: 'no-store'`, 401 ⇒ `null`, otros `!ok` ⇒ `ApiStatusError` de `./auth` con el
`detail`). Funciones: `submitFeedback`, `listFeedbackReports`, `updateFeedbackStatus`,
`updateFeedbackComment`. Tests `lib/feedback.test.ts` con el `mockFetch` de `walls.test.ts`,
corridos con `./node_modules/.bin/vitest` (nunca `npx`).

### Decision 10: i18n — namespace `feedback.*` único + `nav.feedback`

Un solo namespace `feedback` (widget, tablero, estados, errores) porque TODO lo ve cualquier
usuario autenticado — ya no hay superficie "admin" separada; las keys de gestión
(`feedback.board.moveTo`, `feedback.comment.*`) viven en el mismo namespace y simplemente no
se renderizan sin `canManage`. Etiquetas de estado en `feedback.status.{new,in_analysis,
in_progress,done,discarded}`; entrada de sidebar en `nav.feedback` (el namespace que
`AppSidebar` ya consume). Los valores que viajan al API (`type`, `status`) son SIEMPRE los
literales en inglés; la traducción es de presentación. `messages/parity.test.ts` fuerza la
paridad es/en.

## Data Flow

```
  Tester (cualquier página de (app))                     Cualquier usuario autenticado
       │ click botón flotante (FeedbackWidget, layout)         │ /feedback (sidebar, routes)
       ▼                                                       ▼
  Dialog: type + body(1..2000)                          useSWR('/feedback', listFeedbackReports)
       │ submit: route/url/UA capturados y                     │ GET /feedback ── get_current_user ──► 401
       │ truncados (300/2000/400)                              │                (viewer: 200, ve TODO)
       ▼                                                       ▼
  lib/feedback.ts submitFeedback ── POST /feedback ──►  FeedbackBoard (agrupa por status)
       │                    get_current_user (401)           ├─ Nuevo → En análisis → En progreso → Hecho
       │                    Pydantic 422 (body/límites)      └─ Descartado (separado)
       ▼                              │                        │
  201 {id, created_at}                ▼                        │ canManage = ADMIN_ROLES.includes(user.role)
       │                 FeedbackService.create():             │ (UX; el juez es el backend)
       │                 INSERT user_id=SESIÓN,                ▼
       │                 status='new' (DEFAULT),        ┌──────────────────────────────────────┐
       │                 created_at=now() BASE          │ drag (DndContext solo si canManage)  │
       ▼                                                │ o menú "Mover a…" (dropdown)         │
  sent + link "Ver en el tablero"                       └──────────────────────────────────────┘
       │                                                       │ mutate(optimisticData, rollbackOnError)
       └── mutate('/feedback') ──► si el tablero está          ▼
           montado, la tarjeta aparece en Nuevo        PUT /feedback/{id}/status {status}
                                                        ── require_min_role(ADMIN) ──► 401 / 403
                                                        ── Literal[5 estados] ────────► 422
                                                               │
                                                               ▼
                                                        UPDATE … status_changed_at = CASE WHEN status <> $2
                                                        THEN now() ELSE status_changed_at END … RETURNING + JOIN users
                                                               │ 404 si no hay fila
                                                               ▼
                                                        200 FeedbackReportItem ──► populateCache (reconcilia)
                                                        error ──► rollback + aviso (outcome como dato)

  Comentario del admin: mismo camino con PUT /feedback/{id}/comment {comment|null}
  (strip; ""→null; par admin_comment/admin_comment_updated_at en NULL al borrar).
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `deploy/sql/migrations/019_feedback_reports.sql` | Create | Tabla `feedback_reports`: reporte + `status` (CHECK 5 valores, DEFAULT `new`) + `status_changed_at` + `admin_comment`/`admin_comment_updated_at` con CHECK de par; idempotente, sin índices extra |
| `src/models/feedback.py` | Create | `FeedbackType`, `FeedbackStatus`, `FeedbackReportCreate`, `FeedbackReportCreated`, `FeedbackReportItem`, `FeedbackStatusUpdate`, `FeedbackAdminCommentUpdate` |
| `src/services/feedback_service.py` | Create | `FeedbackService` (pool prestado): `create()`, `list_all()`, `set_status()`, `set_admin_comment()`, `_row_to_item()`; `FeedbackReportNotFoundError` |
| `src/api/routers/feedback.py` | Create | Router `prefix="/feedback"` con los cuatro endpoints y `_get_feedback_service(request)` (molde `comments.py:23-24`) |
| `src/main.py` | Modify | Aditivo: import del router (junto a l.125-129), `app.state.feedback_service = FeedbackService(db_pool)` (junto a l.388), `app.include_router(feedback_router.router)` (junto a l.576-580) |
| `dashboard/lib/feedback.ts` | Create | Tipos `FeedbackType`, `FeedbackStatus`, `FEEDBACK_STATUSES`, `FeedbackReport`, `FeedbackPayload`; `FEEDBACK_SWR_KEY`; `submitFeedback`, `listFeedbackReports`, `updateFeedbackStatus`, `updateFeedbackComment` |
| `dashboard/lib/feedback.test.ts` | Create | Vitest del helper (molde `walls.test.ts`): credentials, 401 ⇒ null, 403/422 ⇒ `ApiStatusError` con detail, verbos/paths exactos |
| `dashboard/components/feedback/FeedbackWidget.tsx` | Create | Botón flotante `z-[1050]` + Dialog; captura y truncado en el submit; estados idle/open/sending/sent/error; `mutate(FEEDBACK_SWR_KEY)` tras 201 |
| `dashboard/components/feedback/FeedbackWidget.test.tsx` | Create | Truncado 300/2000/400 en el payload; body de 2001 NO se envía ni se trunca; texto preservado en error |
| `dashboard/components/feedback/FeedbackBoard.tsx` | Create | Kanban: agrupa por status, 4 columnas de flujo + `Descartado` separada; `DndContext` solo si `canManage`; `onDragEnd` → `onMove` |
| `dashboard/components/feedback/FeedbackColumn.tsx` | Create | `useDroppable`, encabezado i18n + contador, `aria-label` propio |
| `dashboard/components/feedback/FeedbackCard.tsx` | Create | `useDraggable` (disabled sin `canManage`), resumen, autor, fecha, comentario admin; menú "Mover a…" (dropdown) solo con `canManage` |
| `dashboard/components/feedback/FeedbackCardDetail.tsx` | Create | Dialog de detalle: body completo, contexto técnico, editor de comentario (solo `canManage`) |
| `dashboard/components/feedback/FeedbackBoard.test.tsx` | Create | Modo lectura: cero controles de mover/comentar; modo gestión: "Mover a…" llama `onMove`; rechazo (403 simulado) ⇒ la tarjeta vuelve + aviso; `Descartado` con `aria-label` distinto de `Hecho` |
| `dashboard/app/(app)/feedback/page.tsx` | Create | Página del tablero: `useAuth` → `canManage`, `useSWR` + `mutate` optimista con `rollbackOnError`, botón "Actualizar", outcome como dato |
| `dashboard/app/(app)/layout.tsx` | Modify | Una línea: `<FeedbackWidget />` junto a `<OnboardingGate />` |
| `dashboard/components/AppSidebar.tsx` | Modify | Entrada `{ href: '/feedback', label: t('feedback'), icon: MessageSquare }` en `routes` (para TODOS; NO en `adminRoutes`) |
| `dashboard/messages/es.json`, `en.json` | Modify | Namespace `feedback.*` (widget, board, status.*, comment.*, errors.*) + `nav.feedback` (paridad forzada por `parity.test.ts`) |
| `tests/unit/test_feedback_models.py` | Create | Pydantic: body 0/2001 ⇒ error; type/status fuera del enum ⇒ error; route/url/UA en el límite y +1; comment `""`/espacios ⇒ `None`, 2001 ⇒ error |
| `tests/integration/test_feedback_api.py` | Create | Punta a punta contra testcontainer (molde `test_window_comments_api.py`): matriz 401/403/422, idempotencia por timestamps, `status='new'` por SELECT, `author_email`, 404 |

## Interfaces / Contracts

```python
# src/models/feedback.py

from datetime import datetime
from typing import Literal, Optional
from uuid import UUID

from pydantic import BaseModel, Field, field_validator

FeedbackType = Literal["bug", "suggestion"]
# Mismo orden que las columnas del tablero; `discarded` es terminal aparte de `done`.
FeedbackStatus = Literal["new", "in_analysis", "in_progress", "done", "discarded"]


class FeedbackReportCreate(BaseModel):
    """Payload de POST /feedback. SIN user_id (sesión) ni timestamp (base) ni status
    (siempre nace en 'new')."""

    type: FeedbackType
    body: str = Field(min_length=1, max_length=2000)          # NUNCA se trunca: 422
    # Límites espejo de los CHECK de la 019: la validación de forma ADELANTA el
    # error a un 422 legible, no reemplaza a la base (criterio window_comment.py).
    route: str = Field(min_length=1, max_length=300)
    url: str = Field(min_length=1, max_length=2000)
    user_agent: str = Field(default="", max_length=400)


class FeedbackReportCreated(BaseModel):
    """Ack mínimo del POST. El estado inicial es 'new' por contrato."""

    id: UUID
    created_at: datetime


class FeedbackReportItem(BaseModel):
    """Tarjeta del tablero: la ve CUALQUIER usuario autenticado (decisión del usuario)."""

    id: UUID
    type: FeedbackType
    body: str
    route: str
    url: str
    user_agent: str
    author_email: str
    created_at: datetime
    status: FeedbackStatus
    status_changed_at: datetime
    admin_comment: Optional[str] = None
    admin_comment_updated_at: Optional[datetime] = None


class FeedbackStatusUpdate(BaseModel):
    """Body de PUT /feedback/{id}/status. Un valor fuera del Literal ⇒ 422 de FastAPI."""

    status: FeedbackStatus


class FeedbackAdminCommentUpdate(BaseModel):
    """Body de PUT /feedback/{id}/comment. `null`, "" o solo espacios BORRAN el comentario."""

    comment: Optional[str] = Field(default=None, max_length=2000)

    @field_validator("comment", mode="before")
    @classmethod
    def _empty_is_none(cls, value: object) -> object:
        if isinstance(value, str):
            stripped = value.strip()
            return stripped or None
        return value
```

```python
# src/api/routers/feedback.py — firmas

router = APIRouter(prefix="/feedback", tags=["feedback"])

def _get_feedback_service(request: Request) -> FeedbackService:
    return request.app.state.feedback_service

@router.post("", response_model=FeedbackReportCreated, status_code=201)
async def create_report(
    payload: FeedbackReportCreate,
    current_user: CurrentUser = Depends(get_current_user),
    feedback_service: FeedbackService = Depends(_get_feedback_service),
) -> FeedbackReportCreated: ...

@router.get("")
async def list_reports(
    current_user: CurrentUser = Depends(get_current_user),      # viewer: 200, ve TODO
    feedback_service: FeedbackService = Depends(_get_feedback_service),
) -> dict:  # {"reports": [FeedbackReportItem.model_dump(mode="json"), ...]}, created_at DESC
    ...

@router.put("/{report_id}/status", response_model=FeedbackReportItem)
async def set_status(
    report_id: UUID,
    payload: FeedbackStatusUpdate,
    current_user: CurrentUser = Depends(require_min_role(UserRole.ADMIN)),
    feedback_service: FeedbackService = Depends(_get_feedback_service),
) -> FeedbackReportItem:  # 404 FeedbackReportNotFoundError
    ...

@router.put("/{report_id}/comment", response_model=FeedbackReportItem)
async def set_admin_comment(
    report_id: UUID,
    payload: FeedbackAdminCommentUpdate,
    current_user: CurrentUser = Depends(require_min_role(UserRole.ADMIN)),
    feedback_service: FeedbackService = Depends(_get_feedback_service),
) -> FeedbackReportItem:  # 404 FeedbackReportNotFoundError
    ...
```

```typescript
// dashboard/lib/feedback.ts — contrato del helper (molde walls.ts)

export type FeedbackType = 'bug' | 'suggestion';
export type FeedbackStatus = 'new' | 'in_analysis' | 'in_progress' | 'done' | 'discarded';
/** Orden de las columnas del flujo; `discarded` se renderiza aparte. */
export const FLOW_STATUSES: readonly FeedbackStatus[] = ['new', 'in_analysis', 'in_progress', 'done'];
export const FEEDBACK_SWR_KEY = '/feedback';

export interface FeedbackPayload {
  type: FeedbackType;
  body: string;        // 1..2000, NUNCA truncado
  route: string;       // usePathname().slice(0, 300)
  url: string;         // window.location.href.slice(0, 2000)
  user_agent: string;  // navigator.userAgent.slice(0, 400)
}

export interface FeedbackReport {
  id: string;
  type: FeedbackType;
  body: string;
  route: string;
  url: string;
  user_agent: string;
  author_email: string;
  created_at: string;
  status: FeedbackStatus;
  status_changed_at: string;
  admin_comment: string | null;
  admin_comment_updated_at: string | null;
}

export async function submitFeedback(payload: FeedbackPayload): Promise<{ id: string; created_at: string } | null>;
export async function listFeedbackReports(): Promise<FeedbackReport[] | null>;        // desenvuelve {reports}
export async function updateFeedbackStatus(id: string, status: FeedbackStatus): Promise<FeedbackReport | null>;
export async function updateFeedbackComment(id: string, comment: string | null): Promise<FeedbackReport | null>;
```

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit (backend) | `FeedbackReportCreate`: body `""`/2001 ⇒ error, 2000 OK; `type` fuera del enum; route 301 / url 2001 / UA 401 ⇒ error, en el límite OK; UA ausente ⇒ `""`. `FeedbackStatusUpdate`: `"resolved"`/`"Nuevo"` ⇒ error. `FeedbackAdminCommentUpdate`: `""`, `"   "`, `None` ⇒ `None`; `" x "` ⇒ `"x"`; 2001 ⇒ error | pytest sobre modelos, sin base (`tests/unit/test_feedback_models.py`) |
| Integration (backend) — matriz de auth | Para cada fila: sin sesión ⇒ **401**; viewer ⇒ `POST` 201, `GET` **200 con TODOS los reportes (propios y ajenos) + `author_email`**, `PUT status` **403**, `PUT comment` **403**; moderador ⇒ igual que viewer en los `PUT` (403); admin ⇒ 200 en los `PUT`; superadmin ⇒ 200 (jerárquico, no igualdad) | testcontainer, molde `test_window_comments_api.py` (`_insert_user` con parámetro `role`, `_login_as` con `CurrentUser` del rol; `_auth_service_mock` ya deriva el rol del `CurrentUser` decodificado) |
| Integration (backend) — 422 | body 2001 ⇒ 422 **y cero filas** (SELECT count); route/url/UA por encima del límite ⇒ 422 sin fila; `PUT status` con `"resolved"` ⇒ 422 y `status`/`status_changed_at` intactos en la base; `PUT comment` 2001 ⇒ 422 | ídem, verificación por SELECT con psycopg2 (verificar contra la base, no con mocks) |
| Integration (backend) — creación | 201 con `{id, created_at}`; SELECT muestra `user_id` = usuario de la SESIÓN aunque el body traiga un `user_id` ajeno (campo ignorado), `status = 'new'`, `status_changed_at` ≈ `created_at`, `admin_comment IS NULL` | ídem |
| Integration (backend) — idempotencia REAL | `PUT status` `new→in_progress` cambia `status_changed_at` (T1 > T0); repetir `in_progress` ⇒ 200 y `status_changed_at == T1` (comparar timestamps, no solo el 200); `in_progress→new` (hacia atrás) ⇒ 200 y T2 > T1. `PUT comment "hola"` ⇒ `admin_comment_updated_at = C1`; repetir `"hola"` ⇒ `C1` intacto; `"hola "` (espacios) ⇒ sigue `C1` (normalizado); `"chau"` ⇒ C2 > C1; `null` y `""` ⇒ ambas columnas `NULL` | ídem |
| Integration (backend) — 404 | `PUT status`/`comment` con UUID inexistente ⇒ 404; UUID malformado ⇒ 422 (path param) | ídem |
| Integration (backend) — migración | `_migrated` aplica la 019 por glob; segundo `apply_migrations` no-op; el `CHECK` de par rechaza `admin_comment` sin `admin_comment_updated_at` (INSERT directo) | ídem |
| Unit (frontend) | `lib/feedback.ts`: `credentials: 'include'`; `PUT` a `/feedback/{id}/status` con `{status}` y a `/feedback/{id}/comment` con `{comment: null}` al borrar; 401 ⇒ `null`; 403/422 ⇒ `ApiStatusError` con `status` y `detail`; `listFeedbackReports` desenvuelve `{reports}` | Vitest, `mockFetch` de `walls.test.ts` |
| Component (frontend) | `FeedbackWidget`: payload con route/url/UA truncados a 300/2000/400 (inputs de 301/2001/401); body de 2001 no llega a `submitFeedback` y no se recorta; error de red preserva el texto; 201 ⇒ estado `sent` + `mutate(FEEDBACK_SWR_KEY)` llamado. `FeedbackBoard` lectura: `queryByRole` de "Mover a…"/editor de comentario ⇒ `null`; NO se monta `DndContext`. Gestión: "Mover a…" llama `onMove(id, 'done')`; `onMove` que rechaza (403 simulado) ⇒ la tarjeta vuelve a su columna y aparece el aviso; columna `Descartado` con `aria-label` distinto de `Hecho`; `Descartado` no es la 5ª del flujo (orden del DOM) | Vitest + `@testing-library/react` (jsdom, `vitest.setup.ts`), molde `WallManager.test.tsx` |
| i18n | Paridad es/en de `feedback.*` y `nav.feedback` | `messages/parity.test.ts` (ya existe, falla si un idioma queda desparejo) |
| Types | `cd dashboard && ./node_modules/.bin/tsc --noEmit` (nunca `next build`) | config `verify.build_command` |
| Manual (usuario) | QA visual: botón no tapa controles en walls densos / globo / live; drag real con mouse; menú "Mover a…" con teclado; `Descartado` claramente separado; flujo tester→tablero con dos cuentas; tras promover su cuenta a admin, una transición y un comentario reales en prod (SELECT de verificación) | el QA visual lo hace el usuario (canvas+MCP rotos); URL exacta y qué mirar en tasks.md |

> **Entorno (verificado 2026-09-03)**: `dashboard/node_modules/` NO existe en este checkout —
> `vitest` y `tsc --noEmit` exigen `npm ci` previo (versiones lockeadas: `@dnd-kit/core 6.3.1`,
> `swr 2.3.6`, ambas con las APIs citadas: `useDroppable`/`useDraggable`/`pointerWithin`/
> `KeyboardSensor` y `useSWRConfig`/`optimisticData`/`rollbackOnError`/`populateCache`).
> Node del shell es v12: exportar el PATH del v22 de nvm antes (trampa documentada).

### Mutaciones críticas que la fase de tasks DEBE exigir (un test que no muere con la mutación no prueba nada)

| # | Mutación | Test que debe morir |
|---|---|---|
| M1 | Quitar `Depends(require_min_role(UserRole.ADMIN))` en `PUT …/status` (dejar `get_current_user`) | viewer ⇒ 403 en mover |
| M2 | Ídem en `PUT …/comment` | viewer ⇒ 403 en comentar |
| M3 | `require_min_role` → `require_role` (igualdad) | superadmin ⇒ 200 en mover |
| M4 | `GET /feedback` con `require_min_role(ADMIN)` | viewer ⇒ 200 con TODOS los reportes |
| M5 | `CASE WHEN status <> $2 THEN now() ELSE status_changed_at END` → `now()` pelado | idempotencia: `status_changed_at == T1` tras repetir |
| M6 | `admin_comment IS DISTINCT FROM $2` → `TRUE` | idempotencia del comentario: `C1` intacto tras repetir |
| M7 | Quitar `WHEN $2 IS NULL THEN NULL` (dejar `now()`) | borrar ⇒ ambas columnas `NULL` (el CHECK de par también lo atrapa: 500 en vez de 200) |
| M8 | `FeedbackStatus` Literal → `str` | `"resolved"` ⇒ 422 |
| M9 | Quitar `_empty_is_none` | `""` ⇒ `None` (unit) y `PUT comment ""` ⇒ columnas `NULL` (integración) |
| M10 | `max_length=300` → `301` en `route` (y análogos url/UA) | 301 ⇒ 422 |
| M11 | `max_length=2000` → `2001` en `body` | body 2001 ⇒ 422 y cero filas |
| M12 | Quitar `DEFAULT 'new'` / insertar `status` desde el payload | SELECT tras POST ⇒ `status = 'new'` |
| M13 | `current_user.id` → `payload.user_id` (agregar el campo) | SELECT ⇒ `user_id` de la sesión aunque el body traiga otro |
| M14 | Quitar `.slice(0, 300)` en el widget | payload con route de 301 |
| M15 | Truncar `body` en el widget (`.slice(0, 2000)`) | body de 2001 NO se envía |
| M16 | Renderizar "Mover a…" sin `canManage &&` | lectura: `queryByRole` ⇒ debe ser `null` |
| M17 | Quitar `rollbackOnError: true` | rechazo ⇒ la tarjeta vuelve a su columna |
| M18 | `aria-label` de `Descartado` = el de `Hecho` | test de semántica distinta |

## Migration / Rollout

1. **Deploy backend**: la 019 se auto-aplica al arranque del servicio api
   (`RUN_MIGRATIONS_ON_STARTUP`, mecanismo verificado desde la 015). Segundo arranque no-op.
   Sin pasos manuales de base.
2. **Deploy frontend**: Vercel, aditivo (widget + página + entrada de sidebar + strings).
3. **Dependencia de rollout (bloqueante para el cierre, no para el deploy)**: en prod hay 4
   cuentas y CERO admins — el usuario promueve su cuenta a admin vía `/admin/users`; efectivo
   en el request siguiente por el round-trip de rol de `get_current_user`. Sin esto el
   tablero es de solo lectura para todo el mundo (sigue funcionando: enviar y leer).
4. **Rollback**: revertir el commit (todo aditivo). La tabla `feedback_reports` queda
   huérfana e inerte; limpieza opcional `DROP TABLE feedback_reports;` (sin FKs entrantes).

## Open Questions

- [ ] **Esquina definitiva del botón flotante**: inferior derecha con offset (`bottom-6
  right-6`) colisiona transitoriamente con el viewport de toasts; se somete al QA visual del
  usuario en walls/globe/live. Mover es un cambio de dos clases Tailwind. No bloquea.
- [ ] **Consolidar `ADMIN_ROLES`** (hoy const local en `AppSidebar.tsx`, `admin/access/page.tsx`
  y ahora `feedback/page.tsx`) en `lib/roles.ts`: limpieza opcional posterior, fuera de este
  change por la preferencia "funcionalidad antes que deuda técnica". No bloquea.
- [ ] **`DragOverlay`** para la tarjeta en vuelo: pulido visual que se agrega sin tocar
  contrato si el QA lo pide. No bloquea.
