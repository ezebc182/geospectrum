# Tasks: Panel de Feedback para Beta Testers (tablero Kanban)

> **Versión 2026-09-03.** Reemplaza íntegramente el `tasks.md` del 2026-09-01
> (modelo binario por `resolved_at`, endpoint `resolve`, página
> `/admin/feedback`). Se conservaron sus hábitos — baseline antes de tocar
> nada, TDD por tarea, mutaciones críticas explícitas con justificación de las
> tareas que no las llevan, arranque real del proceso antes del PR, tareas del
> USUARIO para el QA visual y la promoción a admin — y se reescribió todo el
> contenido para el modelo de cinco estados del proposal enmendado.

## Reconciliación specs ↔ design aplicada antes de escribir estas tareas

Specs y design se escribieron en paralelo. Regla aplicada: **el design gana en
shapes** (SQL, rutas, Pydantic, tipos TS), **la spec gana en comportamiento
observable**. Los cambios se aplicaron en los archivos de `specs/`; en el
design solo se agregó UNA nota de "reconciliado" (punto 3).

| # | Drift detectado | Resolución | Dónde quedó |
|---|---|---|---|
| 1 | Ack del `POST /feedback`: spec `{id, status:"new"}` vs design `{id, created_at}` | **Design gana**: `{id, created_at}`; `status = new` es contrato, no viaja | `specs/feedback/spec.md` (tabla, requirement "Envío", escenario del ack) |
| 2 | Item del tablero: design trae `admin_comment_updated_at`; la spec lo omitía | **Agregado a la spec**: nullable, en par con `admin_comment`; se setea cuando el texto CAMBIA, intacto al reenviar el mismo texto (incluso con espacios exteriores) | `specs/feedback/spec.md` (tabla, "Persistencia", "Lectura", "Comentario" + escenario nuevo "Reenviar el mismo comentario no toca su timestamp") |
| 3 | `status_changed_at`: spec `null` hasta el primer movimiento vs design `NOT NULL DEFAULT now()` (y Pydantic `datetime`, TS `string`) | **Spec gana** (observable): columna `TIMESTAMPTZ NULL` sin default; `Optional[datetime]` / `string \| null` | `design.md` Decision 1, nota de una línea "Reconciliado 2026-09-03" |
| 4 | Endpoints de mover/comentar: spec decía "path definitivo en el design" y llamaba `admin_comment` al campo del request | **Design gana**: `PUT /feedback/{report_id}/status` `{"status"}` y `PUT /feedback/{report_id}/comment` `{"comment"}`; el campo del item de respuesta sigue siendo `admin_comment` | `specs/feedback/spec.md` (requirements "Mover" y "Comentario", escenarios reescritos con `{"comment": ...}`) |
| 5 | Shape del `GET`: spec "lista" vs design `{"reports": [...]}` | **Design gana**: envuelto en `{"reports"}`; tablero vacío ⇒ `{"reports": []}` | `specs/feedback/spec.md` ("Lectura", escenario "tablero vacío") |
| 6 | `user_agent` ausente: spec ⇒ 422 (los tres campos de contexto son obligatorios) vs design `Field(default="", max_length=400)` | **Spec gana** (observable): `user_agent: str = Field(max_length=400)` SIN default — obligatorio pero admite `""`. El `DEFAULT ''` de la columna queda para escrituras que no pasan por la API | Anotado en la spec (bloque de reconciliación) y en la tarea 2.2; el design NO se tocó |
| 7 | Menú "Mover a…": spec "lista los cinco estados" vs design "los otros cuatro" | **Spec gana** (observable): cinco estados, el actual marcado y `aria-disabled` — elegirlo no emite petición | `specs/dashboard-ui/spec.md` (tabla de decisiones + requirement "Modo gestión") |

Sin drift (verificado): enum de estado, transiciones cualquiera→cualquiera,
mismo estado ⇒ 200 no-op, límites 300/2000/400 con truncado en cliente + 422 en
backend, body 1..2000 sin truncar, orden `created_at DESC`, 404/422 por id,
matriz 401/403, una sola página `/feedback`.

## Convenciones no negociables de este change

- Identificadores en INGLÉS, comentarios y docstrings en ESPAÑOL.
- Backend: `./venv/bin/python -m pytest` (el venv está en `venv/`, NO en
  `.venv/`). Los tests de integración usan testcontainers: Docker levantado
  ANTES de correrlos, o el fallo es Docker, no el código.
- Frontend: `dashboard/node_modules/` **NO existe en este checkout** (verificado
  2026-09-03) ⇒ `npm ci` primero (tarea 3.1). Node del shell es v12: exportar
  el PATH del v22 de nvm antes. `./node_modules/.bin/vitest` (nunca `npx
  vitest`, baja un vitest ajeno) y `./node_modules/.bin/tsc --noEmit`.
  **Nunca `next build`** (comparte `.next` con el server de dev y lo rompe).
- Verificar contra la base, no con mocks: todo test de integración que afirme
  "no se creó fila" / "el timestamp no cambió" lo hace con un SELECT
  (psycopg2 sobre el DSN del testcontainer, molde
  `tests/integration/test_window_comments_api.py`).
- **Mutaciones críticas**: el design fija 18 (M1–M18). Las lleva la tarea que
  hace pasar el test que cada una debe matar: **2.9** (M1–M13, backend),
  **3.8** (M14–M15, widget), **4.9** (M16–M18, tablero). Las demás tareas
  dicen explícitamente por qué no llevan mutación. Mecánica: `sd -s` para
  mutar (modo literal — sin `-s`, `sd` interpreta los paréntesis como regex y
  la mutación no muta), `rm -rf src/**/__pycache__` entre corridas (mutar y
  revertir en el mismo segundo sirve el `.pyc` viejo), `rg` que confirma que
  el archivo cambió, test rojo, reversión, verde. Cada mutación se registra
  en `openspec/changes/feedback-beta-testers/mutation-log.md`. **Si una
  mutación no pone rojo ningún test, el test está mal: se arregla el test, no
  se anota la mutación como "pasada".**
- Toda verificación registra el resultado REAL obtenido, nunca "debería
  funcionar".
- **No commitear** hasta que el usuario lo pida; sin ninguna atribución a IA
  en commits ni PRs.

---

## Phase 1: Baseline y migración 019

**Estado al cerrar la fase**: baseline registrada; la tabla
`feedback_reports` existe en la base del testcontainer con el shape
reconciliado; la idempotencia probada por doble ejecución REAL del aplicador.

- [x] 1.1 Registrar la baseline ANTES de tocar cualquier archivo.
      *Evidencia 2026-09-03*: `./venv/bin/python -m pytest tests/ -q -p no:cacheprovider --no-cov` ⇒ **9 failed, 1069 passed, 2 skipped en 125,57 s**; los 9 fallos son preexistentes en `tests/unit/test_ws_events.py` (`Event loop is closed`, fallan también solos) y quedaron listados en `mutation-log.md`.
      *Archivos*: crea `openspec/changes/feedback-beta-testers/mutation-log.md`.
      *Qué*: correr `./venv/bin/python -m pytest tests/ -q` y anotar el conteo
      exacto (`passed`/`failed`/`skipped`/`errors`) fechado, listando fallos
      preexistentes si los hay; dejar armada la tabla de mutaciones con
      columnas `#`, `archivo`, `mutación`, `salida del rg`, `test que se puso
      rojo`, `revertido`.
      *Aceptación*: el archivo existe con la baseline; ningún fallo previo
      podrá atribuirse después a este change.
      *Verificación*: `bat openspec/changes/feedback-beta-testers/mutation-log.md`.
      *Mutación*: no aplica (no hay código).
- [x] 1.2 (RED) Test de la migración ANTES de crearla.
      *Evidencia 2026-09-03*: `./venv/bin/python -m pytest tests/integration/test_feedback_migration.py -q` sin la 019 ⇒ 17 rojos, 16 por `psycopg2.errors.UndefinedTable: relation "feedback_reports" does not exist` y 1 por `KeyError: 'status'` (information_schema vacío, misma causa). El aplicador se prueba de verdad pero apuntado solo a `deploy/sql/migrations/` (monkeypatch de `MIGRATION_DIRS`): `db/migrations/` exige TimescaleDB y el testcontainer es `postgres:16-alpine`.
      *Archivos*: crea `tests/integration/test_feedback_migration.py`.
      *Qué*: usando el fixture `_migrated` de `tests/conftest.py:51` (aplica
      el glob real de `scripts/apply_migrations.py`, no un `CREATE TABLE`
      copiado a mano): (a) la tabla `feedback_reports` existe con las
      columnas `id, user_id, type, body, route, url, user_agent, created_at,
      status, status_changed_at, admin_comment, admin_comment_updated_at`;
      (b) `status` tiene default `new` y `status_changed_at` es nullable SIN
      default (`information_schema.columns`: `column_default IS NULL`,
      `is_nullable = 'YES'` — punto 3 de la reconciliación); (c) **segunda
      ejecución** de `apply_migrations(dsn)` termina sin error y una fila
      insertada entre corridas sobrevive (escenario "Segunda aplicación de la
      migración es no-op"); (d) los `CHECK` rechazan por SQL directo:
      `type='question'`, `body` de 2001, `route` de 301, `url` de 2001,
      `user_agent` de 401, `status='pending'`, `admin_comment` de 2001, y el
      par roto (`admin_comment` con texto y `admin_comment_updated_at NULL`,
      y viceversa).
      *Aceptación*: falla HOY por tabla inexistente, no por error de setup.
      *Verificación*: `./venv/bin/python -m pytest tests/integration/test_feedback_migration.py -q` ⇒ rojo por la razón correcta.
      *Mutación*: no aplica (es el test).
- [x] 1.3 (GREEN) Crear la migración.
      *Evidencia 2026-09-03*: `deploy/sql/migrations/019_feedback_reports.sql` creada con el SQL de la Decision 1 y `status_changed_at TIMESTAMPTZ NULL` sin default; mismo comando de 1.2 ⇒ **17 passed in 4.11s**.
      *Archivos*: crea `deploy/sql/migrations/019_feedback_reports.sql`.
      *Qué*: el SQL EXACTO de la Decision 1 del design con la corrección
      reconciliada: `status_changed_at TIMESTAMPTZ NULL` (sin `DEFAULT
      now()`). Todo lo demás igual: `CREATE TABLE IF NOT EXISTS`, `id UUID
      DEFAULT gen_random_uuid()`, FK `ON DELETE CASCADE`, `CHECK` de `type`,
      de longitudes (1..2000 / ≤300 / ≤2000 / ≤400), `status TEXT NOT NULL
      DEFAULT 'new' CHECK (IN 5 valores)`, `admin_comment` con `CHECK` 1..2000
      o `NULL`, `CONSTRAINT feedback_reports_comment_pair`. Sin índices
      (decisión por volumen). Comentario de cabecera en español con el
      argumento contra `beta.py` (copiar el del design).
      *Aceptación*: 1.2 pasa completo.
      *Verificación*: `./venv/bin/python -m pytest tests/integration/test_feedback_migration.py -q` ⇒ verde.
      *Mutación*: NO — la migración se verifica por ejecución real doble y
      por los `CHECK` probados con SQL directo en 1.2; mutar SQL declarativo
      no agrega información que el test (d) ya no dé.
- [x] 1.4 Test de cascada.
      *Evidencia 2026-09-03*: `test_borrar_usuario_borra_sus_reportes_en_cascada` (2 reportes del usuario borrado desaparecen, 1 de otro usuario sobrevive, cero huérfanos por LEFT JOIN) ⇒ **18 passed in 4.53s**.
      *Archivos*: `tests/integration/test_feedback_migration.py` (mismo archivo).
      *Qué*: `test_borrar_usuario_borra_sus_reportes_en_cascada`: insertar un
      usuario y dos reportes por SQL, `DELETE FROM users WHERE id=...`,
      verificar cero filas con ese `user_id`.
      *Aceptación*: verde; escenario "Borrar el usuario borra sus reportes en cascada" cubierto.
      *Verificación*: mismo comando de 1.3.
      *Mutación*: NO — la protección es el `ON DELETE CASCADE` declarativo
      verificado por ejecución real.
- [x] 1.5 Gate de fase.
      *Evidencia 2026-09-03*: tras `ruff format` + `ruff check` (limpios) y `rm -rf tests/integration/__pycache__`: `./venv/bin/python -m pytest tests/integration/test_feedback_migration.py -q` ⇒ **18 passed in 6.06s**. `src/` sin tocar.
      *Qué*: correr el archivo de migración completo y confirmar verde antes
      de tocar `src/`.
      *Verificación*: `./venv/bin/python -m pytest tests/integration/test_feedback_migration.py -q`.
      *Mutación*: no aplica.

---

## Phase 2: Backend — modelos, service y router (TDD + M1–M13)

**Estado al cerrar la fase**: los cuatro endpoints responden con la matriz de
permisos completa contra testcontainer; idempotencia probada comparando
timestamps; 13 mutaciones registradas. El backend es usable por `curl`.

- [x] 2.1 (RED) Tests unitarios de los modelos Pydantic.
      *Evidencia 2026-09-03*: `./venv/bin/python -m pytest tests/unit/test_feedback_models.py -q` ⇒ `ModuleNotFoundError: No module named 'src.models.feedback'` (1 error en colección — rojo por la razón correcta). 33 casos escritos.
      *Archivos*: crea `tests/unit/test_feedback_models.py` (molde
      `tests/unit/test_locale_models.py`: `pytest.raises(ValidationError)`).
      *Qué*:
      - `FeedbackReportCreate`: acepta `bug` y `suggestion`; rechaza `type`
        ausente o `"question"`; rechaza `body` `""`, solo espacios
        `"   \n\t  "` (exige un `field_validator`, `min_length` solo no lo
        caza), 2001; acepta 2000 exactos; rechaza `route` 301, `url` 2001,
        `user_agent` 401; acepta 300/2000/400 y `user_agent=""`; **rechaza
        `route`/`url`/`user_agent` AUSENTES** (punto 6 de la reconciliación);
        no expone `user_id` ni `created_at` ni `status` como atributos.
      - `FeedbackStatusUpdate`: acepta los cinco valores; rechaza
        `"resolved"`, `"Hecho"`, ausente.
      - `FeedbackAdminCommentUpdate`: `None`, `""`, `"   "` ⇒ `comment is None`;
        `" x "` ⇒ `"x"`; 2001 ⇒ error; 2000 exactos ⇒ OK.
      - `FeedbackReportItem`: `status_changed_at` y `admin_comment_updated_at`
        aceptan `None`.
      *Aceptación*: la suite falla por módulo inexistente.
      *Verificación*: `./venv/bin/python -m pytest tests/unit/test_feedback_models.py -q`.
      *Mutación*: no aplica (es el test; sus mutaciones van en 2.9).
- [x] 2.2 (GREEN) Crear los modelos.
      *Evidencia 2026-09-03*: `src/models/feedback.py` con `user_agent: str = Field(max_length=400)` sin default, `status_changed_at: Optional[datetime] = None`, `field_validator("body")` que rechaza el vacío sin alterar el texto; mismo comando de 2.1 ⇒ **33 passed in 0.15s**.
      *Archivos*: crea `src/models/feedback.py`.
      *Qué*: el contrato de "Interfaces / Contracts" del design con DOS
      correcciones reconciliadas: `user_agent: str = Field(max_length=400)`
      (sin `default=""`) y `status_changed_at: Optional[datetime] = None` en
      `FeedbackReportItem`. Agregar el `field_validator` de body-no-solo-
      espacios (rechaza sin alterar el texto persistido). `FeedbackStatus` y
      `FeedbackType` como `Literal`. `FeedbackReportCreated {id, created_at}`.
      *Aceptación*: 2.1 verde.
      *Verificación*: mismo comando de 2.1.
      *Mutación*: las lleva 2.9 (M8, M9, M10, M11).
- [x] 2.3 Crear el service.
      *Evidencia 2026-09-03*: `./venv/bin/python -c "import src.services.feedback_service"` ⇒ `import ok`. **Desvío registrado**: el SQL del comentario lleva `$2::text` (asyncpg: `AmbiguousParameterError: could not determine data type of parameter $2` con el `WHEN $2 IS NULL` pelado del design); semántica idéntica, protegida por M6/M7.
      *Archivos*: crea `src/services/feedback_service.py`.
      *Qué*: `FeedbackService` con pool prestado (molde
      `src/services/window_comments.py`): `create(user_id, payload)` (INSERT
      sin `status` ni timestamps — los pone la base — `RETURNING id,
      created_at`), `list_all()` (JOIN `users` ⇒ `author_email`, `ORDER BY
      created_at DESC`), `set_status(report_id, status)` y
      `set_admin_comment(report_id, comment)` con el SQL EXACTO del design
      (`CASE WHEN status <> $2 THEN now() ELSE status_changed_at END`; `CASE
      WHEN $2 IS NULL THEN NULL WHEN admin_comment IS DISTINCT FROM $2 THEN
      now() ELSE admin_comment_updated_at END`), `_row_to_item()`,
      `FeedbackReportNotFoundError` cuando `fetchrow` devuelve `None`.
      *Aceptación*: importa sin error; se verifica de punta a punta en 2.4–2.8
      (verificar contra la base, no con mocks — sin tests unitarios propios).
      *Verificación*: `./venv/bin/python -c "import src.services.feedback_service"`.
      *Mutación*: las lleva 2.9 (M5, M6, M7, M12, M13).
- [x] 2.4 (RED) Integración — bloque `POST /feedback`.
      *Evidencia 2026-09-03*: los cuatro bloques (2.4–2.7) se escribieron en un solo archivo y se corrieron juntos antes del router: **58 failed, 2 passed** — `assert 404 == 201` (×5), `404 == 401` (×2), `404 == 422` (×12), `404 == 200`… Los 2 que pasaban eran los de "UUID inexistente ⇒ 404" (el 404 de FastAPI por ruta ausente): se endurecieron con `detail != "Not Found"` para que también mueran sin router. Helper propio `_insert_user(dsn, email, role)`.
      *Archivos*: crea `tests/integration/test_feedback_api.py`.
      *Qué*: molde `test_window_comments_api.py` (`TestClient`, `_login_as`,
      `_auth_service_mock` que deriva el rol del `CurrentUser`). OJO: el
      `_insert_user(dsn, email)` de ese archivo NO recibe rol — escribir acá
      un `_insert_user(dsn, email, role)` propio. Fixture que setea
      `app.state.feedback_service = FeedbackService(_LazyPool(dsn))`. Casos:
      201 con `viewer` y body EXACTO `{id, created_at}` (sin otras claves) +
      SELECT: `user_id` = sesión, `status='new'`, `status_changed_at IS
      NULL`, `admin_comment IS NULL`, `admin_comment_updated_at IS NULL`,
      `created_at` = el del ack; 401 sin cookie y cero filas; 401 con cuenta
      desactivada (`UserAuthState(is_active=False)`) y cero filas; 422 sin
      fila: body `""`, solo espacios, 2001, `type` inválido, `url` 2001,
      `route` 301, `user_agent` 401, sin `url`, sin `route`, sin
      `user_agent`; 201 con body de 2000 exactos y SELECT con el texto
      completo; **`user_id` de B inyectado en el body ⇒ 201 y fila con
      `user_id` = A**; `created_at` del pasado inyectado ⇒ ignorado; contexto
      con query params persistido tal cual. Todo 4xx con clave `detail`.
      *Aceptación*: rojo por router inexistente (404), no por setup.
      *Verificación*: `./venv/bin/python -m pytest tests/integration/test_feedback_api.py -q -k post`.
      *Mutación*: no aplica (es el test).
- [x] 2.5 (RED) Integración — bloque `GET /feedback`.
      *Evidencia 2026-09-03*: ver 2.4 (misma corrida roja por 404). Cubre 401 sin sesión con `"TEXTO-QUE-NO-DEBE-FILTRARSE" not in resp.text`, desactivado 401, 200 para los cuatro roles, orden C/B/A por `created_at DESC`, `author_email`, par comentario/timestamp solo en B, `set(item) == ITEM_KEYS` (sin `user_id`), viewer == admin campo a campo, `{"reports": []}`.
      *Archivos*: `tests/integration/test_feedback_api.py`.
      *Qué*: matriz completa: sin sesión 401 (body sin datos de reportes);
      desactivado 401; **`viewer` 200**, `moderador` 200, `admin` 200,
      `superadmin` 200. Con reportes de A (`new`), B (`in_progress` con
      comentario) y C (`discarded`) sembrados por SQL: el viewer A ve los
      TRES con `author_email` correcto, `admin_comment` solo en B,
      `admin_comment_updated_at` no nulo solo en B, todos los campos del
      item, orden `created_at DESC`, sin `user_id` en ningún item; el payload
      del `viewer` y el del `admin` son iguales campo a campo; base vacía ⇒
      `{"reports": []}`.
      *Aceptación*: rojo por 404.
      *Verificación*: `... -k get`.
      *Mutación*: no aplica (es el test).
- [x] 2.6 (RED) Integración — bloque `PUT /feedback/{report_id}/status`.
      *Evidencia 2026-09-03*: ver 2.4 (misma corrida roja). Idempotencia comparando `status_changed_at` leído por psycopg2 (`== t1` exacto; hacia atrás `t2 > t1`), terminales reversibles, 422 ×3 con fila intacta, 404/422 por id, matriz `none/viewer/moderador/admin/superadmin` ⇒ 401/403/403/200/200 con SELECT, mover no toca comentario/body/type, `DELETE` ⇒ 404/405.
      *Archivos*: `tests/integration/test_feedback_api.py`.
      *Qué*: `admin` mueve `new → in_progress` ⇒ 200 con item completo,
      SELECT `status_changed_at` no nulo (T1); **repetir `in_progress` ⇒ 200
      y `status_changed_at == T1` exacto** (leído de la base); `in_progress →
      new` (hacia atrás) ⇒ 200 y T2 > T1; `discarded → in_analysis` y `done →
      new` ⇒ 200; `"resolved"`, `"Hecho"`, `status` ausente ⇒ 422 y fila
      intacta (`new`, `status_changed_at IS NULL`); UUID inexistente ⇒ 404;
      `"no-es-un-uuid"` ⇒ 422; matriz: sin sesión 401, `viewer` 403,
      `moderador` 403 (SELECT confirma `new` intacto), `admin` 200,
      **`superadmin` 200**; mover NO toca `admin_comment` ni
      `admin_comment_updated_at`; `body`/`type` quedan como se crearon.
      *Aceptación*: rojo por 404/405.
      *Verificación*: `... -k status`.
      *Mutación*: no aplica (es el test).
- [x] 2.7 (RED) Integración — bloque `PUT /feedback/{report_id}/comment`.
      *Evidencia 2026-09-03*: ver 2.4 (misma corrida roja). C1 intacto al repetir `"hola"` y `"  hola  "`, C2 > C1 al editar y `'"v1"' not in board.text`, vaciar con `null`/`""`/`"   "` ⇒ par NULL, vaciar un null ⇒ 200, 2001 ⇒ 422 con `("previo", c1)` intactos, 2000 exactos OK, comentar no mueve (`status_changed_at == t1` sembrado), matriz 401/403/403/200/200 con SELECT.
      *Archivos*: `tests/integration/test_feedback_api.py`.
      *Qué*: `{"comment": "hola"}` ⇒ 200, `admin_comment="hola"`,
      `admin_comment_updated_at = C1`; **repetir `"hola"` ⇒ C1 intacto**;
      `"  hola  "` ⇒ `"hola"` y C1 intacto; `"chau"` ⇒ C2 > C1; `null` ⇒
      ambas columnas `NULL`; `""` y `"   "` ⇒ ambas `NULL`; vaciar un `null`
      ⇒ 200; 2001 ⇒ 422 y fila con `"previo"` y su timestamp intactos; 2000
      exactos ⇒ 200; comentar NO cambia `status` ni `status_changed_at`
      (tarjeta en `in_analysis` con T1 sembrado); el viewer ve el comentario
      en el `GET` siguiente y `"v1"` no aparece tras editar a `"v2"`; UUID
      inexistente 404; id malformado 422; matriz 401/403/403/200/200 con
      SELECT de fila intacta en los rechazos.
      *Aceptación*: rojo por 404/405.
      *Verificación*: `... -k comment`.
      *Mutación*: no aplica (es el test).
- [x] 2.8 (GREEN) Router + registro en `main.py`.
      *Evidencia 2026-09-03*: router creado con las cuatro firmas del design; `main.py` +6 líneas aditivas (dos imports, `app.state.feedback_service = FeedbackService(db_pool)` junto a `window_comment_service`, `include_router`) — `git diff --stat` ⇒ `1 file changed, 6 insertions(+)`. Dos ajustes del TEST en el camino (psycopg2 devuelve `uuid` como `str` y no adapta `uuid.UUID`) y el desvío `$2::text` de 2.3. `./venv/bin/python -m pytest tests/integration/test_feedback_api.py -q` ⇒ **61 passed in 11.11s** (60 + el test de `status` inyectado agregado en 2.9).
      *Archivos*: crea `src/api/routers/feedback.py`; modifica `src/main.py`.
      *Qué*: `APIRouter(prefix="/feedback", tags=["feedback"])` con las cuatro
      firmas del design (`_get_feedback_service(request)` leyendo
      `request.app.state.feedback_service`, molde `comments.py:23-24`);
      `FeedbackReportNotFoundError` ⇒ `HTTPException(404)`; `GET` devuelve
      `{"reports": [item.model_dump(mode="json"), ...]}`. En `main.py`, tres
      cambios aditivos: import del router junto a los otros, `app.state.
      feedback_service = FeedbackService(db_pool)` en el lifespan junto a
      `window_comment_service`, `app.include_router(feedback_router.router)`.
      *Aceptación*: 2.4, 2.5, 2.6 y 2.7 verdes completos.
      *Verificación*: `./venv/bin/python -m pytest tests/integration/test_feedback_api.py -q`.
      *Mutación*: las lleva 2.9 (M1–M4).
- [x] 2.9 **Mutaciones críticas del backend M1–M13** (registrar cada una en
      `mutation-log.md` con la mecánica del encabezado).
      *Evidencia 2026-09-03*: 14 filas en `mutation-log.md` (M1–M13 + M10', con M10 en tres corridas a/b/c), TODAS rojas con la aserción exacta anotada y reversión verificada por `cmp` contra snapshot; `rg -c "revertido: sí"` ⇒ 14. Dos lecciones nuevas registradas en el log: **`sd 1.0.0 -s` no matchea literales con `\n`** (M1/M2/M4 dieron "verde" con el archivo sin mutar hasta que se cambió a un replace exacto que falla si el patrón no está) y el snapshot por `basename` colisionó entre los dos `feedback.py` (se re-keyó por path). Se agregó `test_post_status_inyectado_en_el_body_se_ignora` para que M12 muera por SELECT.
      *Archivos*: `src/api/routers/feedback.py`, `src/services/feedback_service.py`,
      `src/models/feedback.py` (mutar y REVERTIR).
      | # | Mutación | Test que DEBE morir |
      |---|---|---|
      | M1 | `require_min_role(UserRole.ADMIN)` → `get_current_user` en `PUT …/status` | viewer ⇒ 403 en mover (2.6) |
      | M2 | Ídem en `PUT …/comment` | viewer ⇒ 403 en comentar (2.7) |
      | M3 | `require_min_role` → `require_role` en ambos `PUT` | superadmin ⇒ 200 (2.6/2.7) |
      | M4 | `GET /feedback` con `require_min_role(ADMIN)` | viewer ⇒ 200 con TODOS (2.5) |
      | M5 | `CASE WHEN status <> $2 THEN now() ELSE status_changed_at END` → `now()` | `status_changed_at == T1` tras repetir (2.6) |
      | M6 | `admin_comment IS DISTINCT FROM $2` → `TRUE` | C1 intacto tras repetir (2.7) |
      | M7 | Quitar `WHEN $2 IS NULL THEN NULL` | vaciar ⇒ ambas `NULL` (2.7; el CHECK de par lo vuelve 500) |
      | M8 | `FeedbackStatus` Literal → `str` | `"resolved"` ⇒ 422 (2.1 y 2.6) |
      | M9 | Quitar `_empty_is_none` | `""` ⇒ `None` (2.1) y `PUT comment ""` ⇒ `NULL` (2.7) |
      | M10 | `max_length=300` → `301` en `route` (repetir con `url` 2001 y `user_agent` 401); **M10'**: `Field(max_length=400)` → `Field(default="", max_length=400)` en `user_agent` | 301/2001/401 ⇒ 422 (2.1, 2.4); M10': UA ausente ⇒ 422 (2.1, 2.4) |
      | M11 | `max_length=2000` → `2001` en `body` | body 2001 ⇒ 422 y cero filas (2.4) |
      | M12 | INSERT con `status` tomado de un campo agregado al payload | SELECT tras POST ⇒ `status='new'` (2.4) |
      | M13 | `current_user.id` → `payload.user_id` (agregando el campo) | fila con `user_id` de la sesión aunque el body traiga otro (2.4) |
      *Aceptación*: 14 filas en `mutation-log.md` (M1–M13 + M10'), cada una
      con `rg` que muestra el cambio, el test rojo, la reversión y el verde.
      *Verificación*: `rg -c "revertido: sí" openspec/changes/feedback-beta-testers/mutation-log.md` ⇒ ≥ 14.
- [x] 2.10 Gate de fase.
      *Evidencia 2026-09-03*: suite del change ⇒ **112 passed in 15.90s** (33 unit + 18 migración + 61 API). `ruff format` + `ruff check` limpios en los 6 archivos nuevos; `src/main.py` NO se reformateó (ruff quería tocar 17 líneas preexistentes — se restauró de HEAD y se reaplicaron solo las 6 líneas aditivas) y su único hallazgo (`F811 search_stations` l.2706) es preexistente en HEAD. Suite COMPLETA (`./venv/bin/python -m pytest tests/ -q -p no:cacheprovider --no-cov`) ⇒ **9 failed, 1181 passed, 2 skipped**: los 9 fallos son los mismos de `test_ws_events.py` de la baseline; 1181 = 1069 + 18 + 94, cero regresiones. (Una corrida con `-p no:logging` mostró 1 error espurio por `fixture 'caplog' not found`: es el flag, no el código — el archivo pasa 5/5 con los flags de la baseline.)
      *Qué*: suite de este change verde y `ruff` limpio sobre los archivos
      nuevos/tocados (sin hallazgos nuevos respecto de HEAD).
      *Verificación*: `./venv/bin/python -m pytest tests/unit/test_feedback_models.py tests/integration/test_feedback_migration.py tests/integration/test_feedback_api.py -q && ./venv/bin/ruff check src/models/feedback.py src/services/feedback_service.py src/api/routers/feedback.py src/main.py tests/unit/test_feedback_models.py tests/integration/test_feedback_api.py tests/integration/test_feedback_migration.py`.
      *Mutación*: no aplica.

---

## Phase 3: Frontend — helper `lib/feedback.ts`, widget flotante, montaje global

**Estado al cerrar la fase**: cualquier usuario autenticado ve el botón
flotante en todo `(app)` y envía un reporte con contexto capturado y truncado
en cliente; el tablero todavía no existe.

> Los tests de componente del repo renderizan con `NextIntlClientProvider` y
> el `es.json` REAL (`WallManager.test.tsx:2-47`), no con mocks de
> `useTranslations`: por eso cada superficie agrega sus strings es/en en su
> propia fase (3.5, 4.2) y la Fase 5 cierra con la paridad y la auditoría.

- [x] 3.1 Preparar el entorno del dashboard.
      *Evidencia 2026-09-03 12:50 UTC*: `node -v` ⇒ v22.16.0; `node_modules/` ya presente (`npm ci` previo). Baseline en `mutation-log.md`: `vitest run` ⇒ **95 files / 1026 passed**, `tsc --noEmit` ⇒ exit 0.
      *Qué*: exportar el PATH del Node v22 de nvm, `cd dashboard && npm ci`
      (lockfile: `@dnd-kit/core 6.3.1`, `swr 2.3.6`), y registrar la baseline
      frontend en `mutation-log.md`: `./node_modules/.bin/vitest run` y
      `./node_modules/.bin/tsc --noEmit` ANTES de tocar nada.
      *Aceptación*: `node -v` ⇒ v22; `vitest` y `tsc` corren; conteos anotados.
      *Verificación*: `cd dashboard && node -v && ./node_modules/.bin/vitest run 2>&1 | tail -5`.
      *Mutación*: no aplica.
- [x] 3.2 (RED) Test del helper ANTES del helper.
      *Evidencia 2026-09-03*: 16 casos escritos; `vitest run lib/feedback.test.ts` ⇒ `Error: Failed to resolve import "./feedback"` (1 file failed — rojo por módulo inexistente).
      *Archivos*: crea `dashboard/lib/feedback.test.ts` (molde
      `dashboard/lib/walls.test.ts`, `mockFetch`).
      *Qué*: `submitFeedback` hace `POST /feedback` con el payload
      serializado y `credentials: 'include'`, devuelve `{id, created_at}`;
      `listFeedbackReports` hace `GET /feedback` y **desenvuelve `{reports}`**;
      `updateFeedbackStatus(id, 'done')` hace `PUT /feedback/{id}/status` con
      body `{"status":"done"}`; `updateFeedbackComment(id, null)` hace `PUT
      /feedback/{id}/comment` con body `{"comment":null}` (y con texto, el
      texto); para las cuatro: 401 ⇒ `null`, `!ok` con `{"detail"}` ⇒
      `ApiStatusError` con `status` y `detail`. `FEEDBACK_SWR_KEY === '/feedback'`
      y `FLOW_STATUSES` en el orden `new, in_analysis, in_progress, done`.
      *Aceptación*: rojo por módulo inexistente.
      *Verificación*: `cd dashboard && ./node_modules/.bin/vitest run lib/feedback.test.ts`.
      *Mutación*: no aplica (es el test).
- [x] 3.3 (GREEN) Crear el helper.
      *Evidencia 2026-09-03*: `dashboard/lib/feedback.ts` con tipos (`FeedbackReport.status_changed_at: string | null`), `FLOW_STATUSES`, `FEEDBACK_SWR_KEY` y las cuatro funciones; mismo comando de 3.2 ⇒ **16 passed**.
      *Archivos*: crea `dashboard/lib/feedback.ts`.
      *Qué*: el contrato TS del design con `status_changed_at: string | null`
      (reconciliación 3) y `admin_comment_updated_at: string | null`;
      `request<T>` local calcado de `walls.ts:13-31` (`credentials:
      'include'`, `cache: 'no-store'`, 401 ⇒ `null`, `ApiStatusError` de
      `./auth`).
      *Aceptación*: 3.2 verde.
      *Verificación*: mismo comando de 3.2.
      *Mutación*: NO — tests de contrato con fetch mockeado (molde
      `walls.test.ts`); la lógica de decisión de producción vive en el backend.
- [x] 3.4 (RED) Test del widget ANTES del componente.
      *Evidencia 2026-09-03*: 13 casos (botón/dialog/contador, contexto + type literal, truncado 300/2000/400 con body de 1500 intacto, body 2001 no enviado ni recortado + `aria-invalid`, vacío y solo espacios, doble click, 201 + link + `mutate('/feedback')` + reabrir vacío, rechazo→reintento, 401⇒`null`⇒error de sesión). `vitest run components/feedback/FeedbackWidget.test.tsx` ⇒ `Failed to resolve import "./FeedbackWidget"` (rojo por componente inexistente). Mocks estables vía `vi.hoisted` (`pathnameState` mutado, no re-mockeado); UA con `Object.defineProperty(navigator, 'userAgent')`; href con `history.replaceState`. El "outcome como dato" no es observable desde el DOM: se verifica por lectura del código (`type Outcome = { kind: … }`).
      *Archivos*: crea `dashboard/components/feedback/FeedbackWidget.test.tsx`.
      *Qué*: Testing Library + `NextIntlClientProvider` con `es.json`
      (molde `WallManager.test.tsx`); mocks con referencias ESTABLES de
      `next/navigation` (`usePathname`), `@/lib/feedback` y `swr`
      (`useSWRConfig().mutate`) — un mock de router inestable cuelga tests.
      Casos: botón flotante con `aria-label` traducido; click abre el dialog
      con dos opciones de tipo, textarea `maxLength=2000` + contador, leyenda
      de contexto adjuntado y **aviso de transparencia** ("visible para los
      demás testers"); al enviar, `submitFeedback` recibe `route` = pathname,
      `url` = `window.location.href` con query params, `user_agent` =
      `navigator.userAgent`, `type` como literal `bug`/`suggestion`;
      **truncado**: con `href` de 2001 y UA de 401 y pathname de 301, el
      payload lleva 2000/400/300 exactos y el `body` completo; body de 2001
      NO llega a `submitFeedback` y NO se recorta; textarea vacío o solo
      espacios ⇒ cero llamadas; **doble click** con promesa pendiente ⇒ una
      sola llamada y control deshabilitado con indicación de envío; 201 ⇒
      confirmación visible + link a `/feedback` + `mutate('/feedback')`
      llamado + formulario vacío al reabrir; rechazo ⇒ error visible, texto
      intacto, sin confirmación; reintento exitoso ⇒ recién entonces la
      confirmación. El outcome se guarda como dato (`kind`), no como string.
      *Aceptación*: rojo por componente inexistente.
      *Verificación*: `cd dashboard && ./node_modules/.bin/vitest run components/feedback/FeedbackWidget.test.tsx`.
      *Mutación*: no aplica (es el test).
- [x] 3.5 Strings i18n del widget y del sidebar.
      *Evidencia 2026-09-03*: `feedback.widget.*` (18 claves: button, title, typeLabel, types.bug/suggestion, placeholder, counter, contextNotice, visibilityNotice, submit, sending, sent, viewBoard, close, error, sessionExpired, retry, tooLong) + `nav.feedback` en ambos JSON; `git diff --stat` ⇒ +27/-1 por archivo (solo adiciones); `vitest run messages/parity.test.ts` ⇒ **4 passed**.
      *Archivos*: modifica `dashboard/messages/es.json`, `dashboard/messages/en.json`.
      *Qué*: namespace `feedback.widget.*` (botón, título, tipos, placeholder,
      contador, leyenda de contexto, aviso de transparencia, enviando /
      enviado / error / reintentar / "Ver en el tablero") y `nav.feedback`.
      Español primero, inglés espejo.
      *Aceptación*: `parity.test.ts` verde.
      *Verificación*: `cd dashboard && ./node_modules/.bin/vitest run messages/parity.test.ts`.
      *Mutación*: NO — los protege `parity.test.ts`.
- [x] 3.6 (GREEN) Crear el widget.
      *Evidencia 2026-09-03*: componente con botón `fixed right-6 bottom-6 z-[1050]`, `ui/dialog.tsx`, `role="radiogroup"` con dos `role="radio"`, `<textarea maxLength={2000}>` con clases de `ui/input.tsx`, captura/truncado en el submit, body sin truncar (guard `isTooLong` + `aria-invalid`), `Outcome` como dato (`failed` con status | `sessionExpired`), `useRef` contra el doble click, `mutate(FEEDBACK_SWR_KEY)` tras el 201 y `<Link href="/feedback">`. Mismo comando de 3.4 ⇒ **13 passed**.
      *Archivos*: crea `dashboard/components/feedback/FeedbackWidget.tsx`.
      *Qué*: `'use client'`; botón `fixed bottom-6 right-6 z-[1050]` (entre
      Leaflet `z-[1000]` y los overlays `z-[1100]`); `ui/dialog.tsx`; dos
      botones tipo radio; `<textarea>` nativo con las clases de `ui/input.tsx`
      (no existe `ui/textarea.tsx`, no se agrega); estados `idle → open →
      sending → sent | error`; captura en el SUBMIT con `.slice(0, 300)`,
      `.slice(0, 2000)`, `.slice(0, 400)`; body sin truncar; tras 201
      `mutate(FEEDBACK_SWR_KEY)` de `useSWRConfig()` y `<Link
      href="/feedback">` — el widget NO navega solo.
      *Aceptación*: 3.4 verde.
      *Verificación*: mismo comando de 3.4.
      *Mutación*: las lleva 3.8 (M14, M15).
- [x] 3.7 Montar el widget en el layout.
      *Evidencia 2026-09-03*: import + `<FeedbackWidget />` bajo `<OnboardingGate />` dentro de `SidebarInset`; `rg -n "FeedbackWidget" "dashboard/app/(app)/layout.tsx"` ⇒ líneas 3 y 56; `rg -l "FeedbackWidget" dashboard/app | wc -l` ⇒ **1**. `tsc --noEmit` ⇒ exit 0.
      *Archivos*: modifica `dashboard/app/(app)/layout.tsx`.
      *Qué*: una línea `<FeedbackWidget />` junto a `<OnboardingGate />`
      (l.52) dentro de `SidebarInset`. Único punto de montaje.
      *Aceptación*: `rg -l "FeedbackWidget" dashboard/app | wc -l` ⇒ 1 — el
      escenario "presente en cualquier vista del grupo (app)" queda
      garantizado por construcción y se confirma en 6.7.
      *Verificación*: `rg -n "FeedbackWidget" "dashboard/app/(app)/layout.tsx"`.
      *Mutación*: NO — una línea de montaje verificada por `rg`.
- [x] 3.8 **Mutaciones críticas del widget M14–M15** + gate de fase.
      *Evidencia 2026-09-03 12:59–13:00 UTC*: M14 en tres corridas (route/url/UA) y M15 (guard + `.slice` en el body, las dos a la vez) — las cuatro rojas con la aserción exacta en `mutation-log.md`, reversión verificada por `cmp` contra snapshot. Gate: los tres archivos ⇒ **33 passed**; `tsc --noEmit` exit 0; suite completa ⇒ **97 files / 1055 passed** (1026 + 16 + 13).
      *Archivos*: `dashboard/components/feedback/FeedbackWidget.tsx` (mutar y REVERTIR).
      | # | Mutación | Test que DEBE morir |
      |---|---|---|
      | M14 | Quitar `.slice(0, 300)` del `route` (repetir con url/UA) | payload con route de 301 (3.4) |
      | M15 | Agregar `.slice(0, 2000)` al `body` | body de 2001 NO se envía (3.4) |
      *Aceptación*: 2 filas más en `mutation-log.md`; luego verde de
      `lib/feedback.test.ts`, `FeedbackWidget.test.tsx`, `parity.test.ts` y
      `tsc --noEmit` exit 0.
      *Verificación*: `cd dashboard && ./node_modules/.bin/vitest run lib/feedback.test.ts components/feedback/FeedbackWidget.test.tsx messages/parity.test.ts && ./node_modules/.bin/tsc --noEmit`.

---

## Phase 4: Frontend — tablero Kanban `/feedback`

**Estado al cerrar la fase**: todo usuario autenticado ve el tablero de cinco
columnas; el admin mueve por drag & drop y por "Mover a…", comenta, y un
rechazo del backend revierte la tarjeta.

- [x] 4.1 (RED) Tests del tablero ANTES de los componentes.
      *Evidencia 2026-09-03*: 19 casos (estructura de columnas, lectura sin controles, XSS inerte, gestión con "Mover a…", detalle, editor, y `resolveDrop` como función pura para la decisión del `onDragEnd` — el drag con puntero no es confiable en jsdom). `vitest run components/feedback/FeedbackBoard.test.tsx` ⇒ `Failed to resolve import "./FeedbackBoard"` (rojo por componente inexistente). Render con `IntlTestProvider` (config REAL: es.json + timeZone); dos ajustes del harness durante GREEN: el `ToastProvider` del provider monta un `region` propio (se filtra por `data-status`) y el body también vive en el dialog del detalle (se busca la copia dentro de un `article`).
      *Archivos*: crea `dashboard/components/feedback/FeedbackBoard.test.tsx`.
      *Qué*: render con `NextIntlClientProvider` + `es.json`. Con `reports`
      en los cinco estados y `canManage=false`: cinco columnas; las cuatro
      del flujo en orden DOM Nuevo, En análisis, En progreso, Hecho; la
      columna Descartado FUERA de esa secuencia (contenedor propio) con
      `aria-label` **distinto** del de Hecho; cada tarjeta en la columna de
      su `status`, con tipo, resumen, `author_email`, fecha y
      `admin_comment` diferenciado; orden T3, T2, T1 dentro de una columna;
      **`queryByRole` de "Mover a…" y del editor de comentario ⇒ `null`**;
      NO hay `DndContext` montado (sin atributos `aria-roledescription` de
      dnd-kit en las tarjetas); body `<script>alert(1)</script>` y comentario
      `<img onerror=...>` aparecen como texto literal; lista vacía ⇒ cinco
      columnas con mensaje de estado vacío, sin error. Con `canManage=true`:
      "Mover a…" lista **cinco** estados con el actual `aria-disabled`
      (reconciliación 7); elegir Hecho ⇒ `onMove(id, 'done')` una vez; elegir
      el actual ⇒ cero llamadas; detalle abre con `body` completo, `route`,
      `url` (link `target="_blank" rel="noopener noreferrer"`), `user_agent`;
      editor de comentario: guardar ⇒ `onComment(id, 'Reproducido')`, vaciar
      ⇒ `onComment(id, null)`.
      *Aceptación*: rojo por componentes inexistentes.
      *Verificación*: `cd dashboard && ./node_modules/.bin/vitest run components/feedback/FeedbackBoard.test.tsx`.
      *Mutación*: no aplica (es el test).
- [x] 4.2 Strings i18n del tablero.
      *Evidencia 2026-09-03*: `feedback.status.*` (5), `feedback.board.*` (20: title, subtitle, refresh, refreshing, loading, loadError, empty, count (plural ICU), flowGroup, moveTo, dragHandle, openDetail, detailTitle, technicalContext, route, url, userAgent, createdAt, movedAt, close), `feedback.comment.*` (5) y `feedback.errors.*` (4) en ambos JSON; `git diff --stat` ⇒ +42 por archivo, solo adiciones; `vitest run messages/parity.test.ts` ⇒ **4 passed**. Las etiquetas de tipo reutilizan `feedback.widget.types.*`.
      *Archivos*: modifica `dashboard/messages/es.json`, `dashboard/messages/en.json`.
      *Qué*: `feedback.status.{new,in_analysis,in_progress,done,discarded}`
      (Nuevo/En análisis/En progreso/Hecho/Descartado — New/In analysis/In
      progress/Done/Discarded), `feedback.board.*` (título, actualizar,
      vacío, contador, `moveTo`, detalle, contexto técnico, fecha de
      movimiento), `feedback.comment.*` (etiqueta, guardar, vaciar,
      contador), `feedback.errors.*` (`moveFailed`, `forbidden`,
      `commentFailed`, `sessionExpired`).
      *Aceptación*: `parity.test.ts` verde.
      *Verificación*: `cd dashboard && ./node_modules/.bin/vitest run messages/parity.test.ts`.
      *Mutación*: NO — los protege `parity.test.ts`; la distinción
      Descartado/Hecho la protege M18.
- [x] 4.3 (GREEN) Columna y tarjeta.
      *Evidencia 2026-09-03*: `FeedbackColumn` (`<section aria-label>` por estado, `useDroppable({id: status, disabled: !canManage})`, variante `discarded` con borde punteado, contador plural, mensaje de vacío) y `FeedbackCard` (`useDraggable` con `data.status`; **asa de arrastre propia** con `setActivatorNodeRef` + `attributes`/`listeners` para que el drag no compita con "Ver detalle" ni con el menú; badge de tipo, `line-clamp-3` del body como texto plano, autor, fecha `useFormatter`, `admin_comment` en bloque `data-slot="admin-comment"`; con `canManage`, Radix "Mover a…" con los CINCO estados y el actual `disabled` ⇒ `aria-disabled="true"`). Los casos de columna/tarjeta de 4.1 pasan (ver 4.5).
      *Archivos*: crea `dashboard/components/feedback/FeedbackColumn.tsx`,
      `dashboard/components/feedback/FeedbackCard.tsx`.
      *Qué*: `FeedbackColumn` con `useDroppable({ id: status })`, encabezado
      i18n + contador, `aria-label` propio por estado. `FeedbackCard` con
      `useDraggable({ id, disabled: !canManage })` (patrón
      `SortableSpectrogramCard.tsx:36-88`: `attributes`/`listeners`/
      `setNodeRef`/`CSS.Translate`), badge de tipo, `line-clamp` del body
      como texto plano, `author_email`, fecha con `useFormatter`,
      `admin_comment` si existe; si `canManage`, `ui/dropdown-menu.tsx`
      "Mover a…" con los cinco estados y el actual deshabilitado.
      *Aceptación*: los casos de tarjeta/columna de 4.1 pasan.
      *Verificación*: mismo comando de 4.1.
      *Mutación*: las lleva 4.9 (M16, M18).
- [x] 4.4 (GREEN) Detalle.
      *Evidencia 2026-09-03*: `ui/dialog.tsx` con body `whitespace-pre-wrap`, `dl` de contexto (route texto, url `<a target="_blank" rel="noopener noreferrer">`, user agent), `status_changed_at` solo si no es null; con `canManage`, `CommentEditor` (textarea `maxLength=2000` + contador, "Guardar" manda el texto `trim`, "Vaciar" manda `null`) montado con `key={admin_comment}` para que un rollback reinicie el borrador al valor vigente. Los casos de detalle/comentario de 4.1 pasan (ver 4.5).
      *Archivos*: crea `dashboard/components/feedback/FeedbackCardDetail.tsx`.
      *Qué*: `ui/dialog.tsx` con body completo (`whitespace-pre-wrap`, texto
      plano), `route`, `url` como link `target="_blank" rel="noopener
      noreferrer"`, `user_agent`, `status_changed_at` **solo si no es null**;
      si `canManage`, textarea `maxLength=2000` precargado con
      `admin_comment` + "Guardar" + "Vaciar" (manda `null`).
      *Aceptación*: los casos de detalle/comentario de 4.1 pasan.
      *Verificación*: mismo comando de 4.1.
      *Mutación*: NO — la lógica que protege (guardar/vaciar) se prueba por
      llamadas a `onComment` en 4.1; no hay decisión de producción propia.
- [x] 4.5 (GREEN) Tablero.
      *Evidencia 2026-09-03*: `FeedbackBoard` agrupa por `status` y ordena cada columna por `created_at` DESC; cuatro columnas del flujo dentro de `role="group"` "Flujo de trabajo", `Separator` vertical y `discarded` aparte con variante propia; con `canManage` envuelve en `ManagedBoard` (`DndContext` + `PointerSensor {distance: 5}` + `KeyboardSensor`, `pointerWithin`); sin `canManage` no monta nada de dnd-kit. `resolveDrop` exportada: sin `over`, misma columna o id que no es estado ⇒ `null`. `vitest run components/feedback/FeedbackBoard.test.tsx` ⇒ **19 passed**; `rg -c "dangerouslySetInnerHTML" dashboard/components/feedback/ "dashboard/app/(app)/feedback/"` ⇒ sin matches (un comentario que mencionaba la palabra se reescribió para que el gate sea limpio). `FEEDBACK_STATUSES` e `isFeedbackStatus` agregados a `lib/feedback.ts` (aditivo).
      *Archivos*: crea `dashboard/components/feedback/FeedbackBoard.tsx`.
      *Qué*: props `reports`, `canManage`, `onMove(id, status)`,
      `onComment(id, text)`; agrupa por `status` (`reduce`) en
      `FLOW_STATUSES` y renderiza `discarded` como columna separada
      (separador + clase propia). Con `canManage`, envuelve en `<DndContext
      sensors collisionDetection={pointerWithin} onDragEnd>` con
      `useSensors(useSensor(PointerSensor, { activationConstraint: {
      distance: 5 } }), useSensor(KeyboardSensor))`
      (`spectrograms/page.tsx:141`); `onDragEnd` sin `over` o con la misma
      columna ⇒ no llama `onMove`. Sin `canManage`, NO monta `DndContext`.
      *Aceptación*: 4.1 verde completo y `rg -n "dangerouslySetInnerHTML"
      dashboard/components/feedback/ "dashboard/app/(app)/feedback/"` ⇒ cero.
      *Verificación*: mismo comando de 4.1 + el `rg`.
      *Mutación*: las lleva 4.9 (M16).
- [x] 4.6 (RED) Test de la página ANTES de crearla.
      *Evidencia 2026-09-03*: 14 casos (viewer/moderador lectura, admin/superadmin gestión, GET una vez, "Actualizar" ⇒ segundo GET, error de carga, vacío, mover con éxito sin refetch, 403/401/red revierten con su aviso, comentario 422 vuelve a "v1", éxito y vaciar). `vitest run "app/(app)/feedback/page.test.tsx"` ⇒ `Failed to resolve import "./page"` (rojo por página inexistente). **Desvío deliberado**: SWR es el REAL (`SWRConfig` con caché nueva por test) y se mockean `@/hooks/use-auth` (misma referencia, mutada) y `@/lib/feedback`: con SWR mockeado la reversión probaría el mock y M17 no podría morir.
      *Archivos*: crea `dashboard/app/(app)/feedback/page.test.tsx`.
      *Qué*: mocks estables de `@/hooks/use-auth`, `@/lib/feedback` y `swr`.
      Con `user.role='viewer'` ⇒ `FeedbackBoard` recibe `canManage=false`;
      con `'admin'` y `'superadmin'` ⇒ `true`; `listFeedbackReports` se llama
      una vez al montar; "Actualizar" revalida; **rechazo**: `onMove` con
      `updateFeedbackStatus` que rechaza con `ApiStatusError(403)` ⇒ la
      tarjeta vuelve a su columna (los `reports` mostrados son los
      originales) y aparece el aviso "sin permisos"; `updateFeedbackStatus`
      que resuelve `null` (401) ⇒ también revierte con aviso de sesión;
      éxito ⇒ la tarjeta se reconcilia con el item devuelto sin refetch;
      comentario rechazado con 422 ⇒ el comentario mostrado vuelve a "v1" con
      aviso. El aviso se renderiza desde `outcome` como dato (`kind` +
      status).
      *Aceptación*: rojo por página inexistente.
      *Verificación*: `cd dashboard && ./node_modules/.bin/vitest run "app/(app)/feedback/page.test.tsx"`.
      *Mutación*: no aplica (es el test).
- [x] 4.7 (GREEN) Página del tablero.
      *Evidencia 2026-09-03*: `ADMIN_ROLES` local + `canManage = user !== null && ADMIN_ROLES.includes(user.role)`; `useSWR(FEEDBACK_SWR_KEY, listFeedbackReports)`; `onMove`/`onComment` con el `mutate` EXACTO del design (promesa que resuelve `replaceById(reports, item)`, `optimisticData` como función, `rollbackOnError: true`, `populateCache: true`, `revalidate: false`) — el `null` del helper (401) se convierte en `SessionExpiredError` para que SWR revierta; `outcome` como dato (`kind` + status) traducido al renderizar (403 ⇒ `errors.forbidden`); "Actualizar" ⇒ `mutate()`. Mismo comando de 4.6 ⇒ **14 passed**. `tsc` obligó a volver al `mutate` del design: la firma de SWR tipa `data` como `Promise<Data>` (la variante `populateCache` como función no compila).
      *Archivos*: crea `dashboard/app/(app)/feedback/page.tsx`.
      *Qué*: `'use client'`; `const { user } = useAuth()`; `const ADMIN_ROLES
      = ['admin', 'superadmin']` local (mismo patrón que `AppSidebar.tsx:41`;
      consolidar queda fuera del change); `canManage = user !== null &&
      ADMIN_ROLES.includes(user.role)`; `useSWR(FEEDBACK_SWR_KEY,
      listFeedbackReports)`; `onMove` con el `mutate` EXACTO del design
      (`optimisticData: moveLocally(...)`, `rollbackOnError: true`,
      `populateCache: true`, `revalidate: false`) y `.catch` que setea
      `outcome`; `onComment` con el mismo esquema; botón "Actualizar" ⇒
      `mutate()`.
      *Aceptación*: 4.6 verde.
      *Verificación*: mismo comando de 4.6.
      *Mutación*: las lleva 4.9 (M17).
- [x] 4.8 Entrada de navegación.
      *Evidencia 2026-09-03*: no existía test del sidebar; se creó `components/AppSidebar.test.tsx` (mocks estables de `next/navigation`, `use-auth`, `use-live-events`, `use-mobile` — jsdom no trae `matchMedia` — bajo `TooltipProvider` + `SidebarProvider`). RED: `Unable to find … role "link" and name "Feedback"` (3 failed); tras agregar `{ href: '/feedback', label: t('feedback'), icon: MessageSquare }` en `routes` ⇒ **3 passed** (viewer y moderador ven Feedback y no Accesos; admin ve ambas y Feedback NO está en el grupo Administración). `rg -n "'/feedback'" dashboard/components/AppSidebar.tsx` ⇒ l.64, dentro de `routes`.
      *Archivos*: modifica `dashboard/components/AppSidebar.tsx` (+ test del
      sidebar existente o caso nuevo según el molde).
      *Qué*: `{ href: '/feedback', label: t('feedback'), icon: MessageSquare }`
      en `routes` (l.54), **NO** en `adminRoutes` (l.67). Test: con rol
      `viewer` la entrada "Feedback" SE renderiza (a diferencia de
      `/admin/access`).
      *Aceptación*: test verde; `rg -n "'/feedback'" dashboard/components/AppSidebar.tsx`
      muestra la línea dentro de `routes`.
      *Verificación*: `cd dashboard && ./node_modules/.bin/vitest run components/AppSidebar`.
      *Mutación*: NO — el test positivo con viewer ya falla si la entrada
      cae en `adminRoutes`; es la misma aserción que una mutación daría.
- [x] 4.9 **Mutaciones críticas del tablero M16–M18** + gate de fase.
      *Evidencia 2026-09-03 13:15–13:22 UTC*: M16 roja (3 tests: lectura del tablero + viewer/moderador de la página), M18 roja (3 tests del tablero), reversión por `cmp`. **M17 tal como está escrita es INERTE**: 14/14 verdes con la línea quitada porque `swr 2.3.6` revierte por defecto (`rollbackOnErrorOption !== false`, verificado en `node_modules`); se registró y se agregó **M17'** (`true → false`), roja en exactamente los 3 tests de reversión (403/401/red). Total en `mutation-log.md`: 20 filas (M1–M18 + M10' + M17'). Gate: 6 archivos del change ⇒ **69 passed**; `tsc --noEmit` exit 0; suite completa ⇒ **100 files / 1091 passed** (1055 + 19 + 14 + 3), cero regresiones, sin stderr nuevo.
      *Archivos*: `FeedbackCard.tsx`, `feedback/page.tsx`, `FeedbackColumn.tsx`
      (mutar y REVERTIR).
      | # | Mutación | Test que DEBE morir |
      |---|---|---|
      | M16 | Renderizar "Mover a…" sin `canManage &&` | lectura: `queryByRole` ⇒ `null` (4.1) |
      | M17 | Quitar `rollbackOnError: true` | 403 ⇒ la tarjeta vuelve a su columna (4.6) |
      | M18 | `aria-label` de Descartado = el de Hecho | `aria-label` distintos (4.1) |
      *Aceptación*: 3 filas más en `mutation-log.md` (total 19 con M10');
      luego verde de toda la suite frontend y `tsc --noEmit` exit 0.
      *Verificación*: `cd dashboard && ./node_modules/.bin/vitest run && ./node_modules/.bin/tsc --noEmit`.

---

## Phase 5: i18n — paridad y auditoría de strings

**Estado al cerrar la fase**: ningún literal hardcodeado, ningún valor crudo
del enum visible, paridad es/en verde.

- [ ] 5.1 Paridad es/en de todo el namespace.
      *Archivos*: `dashboard/messages/es.json`, `dashboard/messages/en.json`
      (solo si falta algo).
      *Qué*: correr `parity.test.ts`; verificar que `feedback.*` y
      `nav.feedback` existen en ambos con `rg -c '"feedback"'` en cada JSON.
      *Aceptación*: paridad verde, mismas claves en ambos idiomas.
      *Verificación*: `cd dashboard && ./node_modules/.bin/vitest run messages/parity.test.ts`.
      *Mutación*: NO — `parity.test.ts` ES el guardián.
- [ ] 5.2 Auditoría: sin literales ni enum crudo.
      *Archivos*: `dashboard/components/feedback/*.tsx`, `dashboard/app/(app)/feedback/page.tsx`.
      *Qué*: (a) `rg -n ">[A-Za-zÁ-ú][^<{]*<" dashboard/components/feedback
      "dashboard/app/(app)/feedback"` — todo texto visible sale de `t(...)`;
      (b) agregar en `FeedbackBoard.test.tsx` un render con `en.json` que
      afirme que `queryByText(/in_analysis|in_progress|discarded/)` es `null`
      y que aparecen "In analysis", "Discarded" (el enum crudo NUNCA se ve).
      *Aceptación*: (a) sin matches que sean texto de usuario; (b) verde.
      *Verificación*: `cd dashboard && ./node_modules/.bin/vitest run components/feedback/FeedbackBoard.test.tsx`.
      *Mutación*: NO — es una auditoría estática más un test de presentación
      sin decisión de producción.
- [ ] 5.3 Tipos.
      *Qué*: `tsc --noEmit` exit 0 sobre el dashboard completo (nunca `next build`).
      *Verificación*: `cd dashboard && ./node_modules/.bin/tsc --noEmit; echo $?`.
      *Mutación*: no aplica.

---

## Phase 6: Verificación real, deploy y rollout

**Estado al cerrar la fase**: change verificado contra los Success Criteria
del proposal con evidencia real; desplegado; QA visual y promoción a admin
hechos por el usuario. Las tareas **(USUARIO)** las ejecuta el usuario — el
agente no las marca `[x]` por su cuenta.

- [ ] 6.1 Suite backend COMPLETA contra la baseline.
      *Qué*: `./venv/bin/python -m pytest tests/ -q` y comparar con 1.1: el
      delta debe ser exactamente los tests nuevos de este change, cero
      regresiones. `./venv/bin/ruff check .` sin hallazgos nuevos respecto de
      HEAD (con `git stash` si hay duda de qué es preexistente).
      *Verificación*: los dos comandos; conteos registrados en `mutation-log.md`.
      *Mutación*: no aplica.
- [ ] 6.2 **Arranque real del api local** (736 verdes no salvaron a un
      proceso que moría al arrancar).
      *Qué*: TimescaleDB local en 5433, sin uvicorn zombis previos
      (`pgrep -fl uvicorn`); arrancar con el MISMO entrypoint del deploy
      (`deploy/docker/Dockerfile:88`): `./venv/bin/python -m uvicorn
      src.main:app --host 0.0.0.0 --port 8000` con `RUN_MIGRATIONS_ON_STARTUP`
      activo. Verificar en una pasada: (a) el lifespan completa sin traceback
      y `app.state.feedback_service` se instancia; (b) el log de
      `apply_migrations` muestra la 019; (c) `curl -s -o /dev/null -w
      "%{http_code}" -X POST localhost:8000/feedback -H 'Content-Type:
      application/json' -d '{}'` ⇒ **401** (404 = router sin registrar, 422 =
      auth ausente: tres dígitos, tres bugs distintos); (d) `curl ... -X PUT
      localhost:8000/feedback/00000000-0000-0000-0000-000000000000/status -d
      '{"status":"done"}'` ⇒ 401; (e) reiniciar el proceso ⇒ segundo arranque
      sin error (019 no-op en real, no solo en test).
      *Aceptación*: los cinco resultados reales anotados en `mutation-log.md`.
      *Verificación*: los `curl` de arriba.
      *Mutación*: no aplica.
- [ ] 6.3 Suite frontend completa tras cualquier retoque.
      *Verificación*: `cd dashboard && ./node_modules/.bin/vitest run && ./node_modules/.bin/tsc --noEmit`. **Nunca `next build`.**
      *Mutación*: no aplica.
- [ ] 6.4 Deploy (solo cuando el usuario lo pida).
      *Qué*: commit convencional (sin atribución a IA) en rama propia, PR,
      merge; verificar en Railway que el servicio api redeploya y sus logs
      muestran la 019 aplicada sin error, y que un restart posterior es
      no-op; Vercel toma el dashboard. Si Railway falla con error transitorio,
      redeployar a mano (no reintenta solo). `railway logs` sin TTY da vacío:
      verificar con `curl` al `POST /feedback` de prod ⇒ 401.
      *Aceptación*: `curl -s -o /dev/null -w "%{http_code}" -X POST
      https://<api-prod>/feedback -d '{}'` ⇒ 401.
      *Mutación*: no aplica.
- [ ] 6.5 **(USUARIO) Dependencia de rollout — promover un admin.** En prod
      hay 4 cuentas y CERO admins. Promover su propia cuenta a `admin` desde
      `/admin/users` (UI existente; efectivo en el request siguiente, sin
      re-login). Sin esto el tablero es de solo lectura para todos: bloquea
      el CIERRE del change, no el deploy.
      *Aceptación*: la cuenta aparece como `admin` en `/admin/users`.
- [ ] 6.6 **(USUARIO) Transición y comentario reales en prod.** Desde la
      cuenta promovida: mover una tarjeta real de Nuevo a En progreso (una
      vez por drag & drop, otra por "Mover a…" con teclado), escribir un
      comentario, editarlo y vaciarlo; luego, desde una segunda cuenta
      (viewer), recargar `/feedback` y confirmar que ve la tarjeta en su
      columna con el comentario vigente y CERO controles de gestión.
      Verificación de base vía `railway ssh` (la base no tiene URL pública):
      `SELECT status, status_changed_at, admin_comment,
      admin_comment_updated_at, route, url, user_agent, created_at FROM
      feedback_reports ORDER BY created_at DESC LIMIT 5;` — ruta, URL
      completa, UA y `created_at` del server sin que el tester haya tecleado
      nada de eso.
      *Aceptación*: Success Criteria 2, 5 y 6 del proposal con evidencia real.
- [ ] 6.7 **(USUARIO) QA visual** (canvas+MCP rotos; esto NO lo verifica el
      agente). En desktop: (a) `/spectrograms` (pestaña walls, wall de humo),
      `/globe`, `/live` y una vista con mapa — el botón flotante es visible y
      NO tapa ningún control operable; punto explícito: convivencia con los
      toasts en la misma esquina; (b) flujo completo desde una vista de
      análisis con canal y ventana en la URL: abrir → escribir → enviar →
      confirmación, sin salir de la página; (c) en `/feedback`, Descartado se
      ve claramente separado de Hecho (posición, estilo, etiqueta).
      *Aceptación*: Success Criteria 1, 9 y 12 del proposal; si algo tapa
      controles, mover el botón es un cambio de dos clases Tailwind (Open
      Question del design).
- [ ] 6.8 Cierre.
      *Qué*: repasar los doce Success Criteria del proposal uno por uno
      citando la evidencia (2.4–2.7 para la matriz 401/403/422 y la
      idempotencia; 1.2/6.2/6.4 para la migración auto-aplicada y no-op;
      4.1/4.6 para modo lectura y reversión; 6.5–6.7 para rollout y QA);
      cerrar `mutation-log.md` con fecha y conteo (19 mutaciones: M1–M18 +
      M10'); dejar el change listo para `sdd-verify`/archive.
      *Mutación*: no aplica.
