# Tasks: Captura de pantalla opcional en el panel de feedback

## Reconciliación specs ↔ design aplicada antes de escribir estas tareas

Specs y design se escribieron en paralelo (dos sub-agentes). Regla aplicada:
**el design gana en shapes** (SQL, rutas, Pydantic/TS types), **la spec gana
en comportamiento observable** — mismo criterio que `feedback-beta-testers`.
Los cambios se aplicaron en `specs/feedback/spec.md`; el design no necesitó
tocarse.

| # | Drift detectado | Resolución | Dónde quedó |
|---|---|---|---|
| 1 | `POST /feedback/upload-url`: spec decía **200** con body `{"upload_url", "screenshot_key"}`; design fija **201** con `{key, upload_url, expires_at}` | **Design gana** (shape): 201, campos `key`/`upload_url`/`expires_at` | `specs/feedback/spec.md` (requirement "Emisión de URL prefirmada para subida", los dos escenarios de éxito) |
| 2 | Endpoint de lectura `GET /feedback/{id}/screenshot-url`: el design lo define completo (Decision 4: 200 `{url, expires_at}`, 404 si no existe el reporte o `screenshot_key` es null, auth `get_current_user`, expiración 5 min); la spec de `feedback` NO tenía NINGÚN requirement para este endpoint — el sub-agente de specs corrió antes de que el design cerrara este quinto endpoint | **Agregado a la spec** (no existía, no es una corrección de shape sino una ausencia total) | `specs/feedback/spec.md` (nuevo requirement "Emisión de URL prefirmada de lectura para la captura" + 4 escenarios) |
| 3 | Migración 020, columna `screenshot_key TEXT NULL` | **Sin drift** — verificado, coincide en spec y design | — |
| 4 | `screenshot_key` en `GET /feedback`, `PUT .../status`, `PUT .../comment`: el design lo fija explícito en la tabla de Decision 3 ("todos incluyen el campo, mismo SELECT"); la spec solo lo mencionaba para `POST /feedback`, dejando implícita la lectura | **Aclarado en la spec**: se agregó una oración explícita de que los tres endpoints de lectura/actualización exponen `screenshot_key` | `specs/feedback/spec.md` (requirement "Persistencia de la captura opcional", párrafo nuevo) |

Sin drift verificado en el resto: cap 1920px/2MB, momento de captura (al
abrir, no al submit), degradación silenciosa en el widget, detector de WebGL
genérico, thumbnail/lightbox condicionales, formato de key
`feedback-screenshots/{uuid4}.png` generado en el servidor, expiración de 5
minutos en ambos presigns (subida y lectura).

## Convenciones no negociables de este change

- Identificadores en INGLÉS, comentarios y docstrings en ESPAÑOL.
- Backend: `./venv/bin/python -m pytest` (venv en `venv/`, NO `.venv/`). Tests
  de integración usan testcontainers: Docker levantado ANTES de correrlos.
- Frontend: exportar el PATH del Node v22 de nvm antes de cualquier comando;
  `./node_modules/.bin/vitest` (nunca `npx vitest`); `./node_modules/.bin/tsc
  --noEmit`. **Nunca `next build`** (comparte `.next` con el server de dev).
- Verificar contra la base, no con mocks: todo test de integración que
  afirme algo sobre una fila lo hace con SELECT (molde
  `tests/integration/test_feedback_migration.py`, `test_feedback_api.py`).
- **Mutaciones críticas**: mecánica idéntica a `feedback-beta-testers` —
  `sd -s` (modo literal, sin `-s` los paréntesis se leen como regex y la
  mutación no muta), `rm -rf **/__pycache__` entre corridas (mismo segundo
  sirve el `.pyc` viejo), `rg` que confirma el cambio, test rojo, reversión
  por `cmp` contra snapshot, verde. Registrar cada una en
  `openspec/changes/feedback-screenshot-attachment/mutation-log.md`. Si una
  mutación no pone rojo ningún test, se arregla el test — nunca se anota como
  "pasada".
- **Preferencia permanente del usuario para este proyecto: NADA corre en
  local.** Sin `docker compose`, sin `uvicorn` local, sin stack levantado a
  mano. `pytest` con testcontainers efímeros SÍ corre (Docker corre para
  eso, no es "correr el stack"). La verificación de proceso real y el
  aprovisionamiento manual de recursos cloud (bucket R2, secrets de Railway)
  pasan a Fase 6 como tareas de post-deploy o del usuario — nunca como tarea
  local previa.
- Toda verificación registra el resultado REAL obtenido, nunca "debería
  funcionar".
- **No commitear** hasta que el usuario lo pida; sin ninguna atribución a IA
  en commits ni PRs.

---

## Phase 1: Baseline y migración 020

**Estado al cerrar la fase**: baseline registrada; `feedback_reports` tiene
la columna `screenshot_key` en la base del testcontainer; idempotencia
probada por doble ejecución real del aplicador.

- [x] 1.1 Registrar la baseline ANTES de tocar cualquier archivo.
      *Archivos*: crea `openspec/changes/feedback-screenshot-attachment/mutation-log.md`.
      *Qué*: correr `./venv/bin/python -m pytest tests/ -q -p no:cacheprovider --no-cov`
      y anotar el conteo exacto (passed/failed/skipped) fechado — el número
      real de HOY, NO el `1181 passed` de `feedback-beta-testers` (main se
      movió desde entonces). Listar cualquier fallo preexistente. Dejar
      armada la tabla de mutaciones (columnas `#`, archivo, mutación, salida
      de `rg`, test que se puso rojo, revertido).
      *Aceptación*: el archivo existe con la baseline de HOY; ningún fallo
      previo podrá atribuirse después a este change.
      *Verificación*: `bat openspec/changes/feedback-screenshot-attachment/mutation-log.md`.
      *Mutación*: no aplica.
      *Evidencia (2026-09-03)*: `./venv/bin/python -m pytest tests/ -q -p
      no:cacheprovider --no-cov` ⇒ `9 failed, 1181 passed, 2 skipped, 8
      warnings in 121.33s`. Los 9 fallos están confinados a
      `tests/unit/test_ws_events.py` (RuntimeError "Event loop is closed" en
      teardown de una conexión Redis async — infra/fixture del suite, no
      relacionado con `feedback`), confirmado inspeccionando uno en corrida
      aislada. Que el `1181` coincida con el de `feedback-beta-testers` es
      casualidad de esta corrida (rama recién creada desde `main` en
      `3456b04`), no un supuesto reusado. Registrado en `mutation-log.md`.
- [x] 1.2 (RED) Test de la migración 020 ANTES de crearla.
      *Archivos*: crea `tests/integration/test_feedback_screenshot_migration.py`
      (molde `tests/integration/test_feedback_migration.py`: fixture `_migrated`
      de `tests/conftest.py`, monkeypatch de `MIGRATION_DIRS` apuntado solo a
      `deploy/sql/migrations/`).
      *Qué*: (a) tras aplicar el glob completo (019 + 020), la tabla
      `feedback_reports` tiene la columna `screenshot_key` de tipo `text`,
      nullable, sin default (`information_schema.columns`); (b) un INSERT sin
      `screenshot_key` deja la columna en `NULL`; (c) un INSERT con
      `screenshot_key = 'feedback-screenshots/' || gen_random_uuid() ||
      '.png'` la persiste tal cual (la migración no valida forma — eso es
      trabajo de Pydantic en 2.x, no de SQL); (d) **segunda ejecución** de
      `apply_migrations(dsn)` termina sin error y una fila insertada entre
      corridas sobrevive con su `screenshot_key` intacto (escenario "Segunda
      aplicación de la migración 020 es no-op").
      *Aceptación*: falla HOY por columna inexistente, no por error de setup.
      *Verificación*: `./venv/bin/python -m pytest tests/integration/test_feedback_screenshot_migration.py -q` ⇒ rojo por la razón correcta.
      *Mutación*: no aplica (es el test).
      *Evidencia (2026-09-03)*: `./venv/bin/python -m pytest
      tests/integration/test_feedback_screenshot_migration.py -q` ⇒ `4
      failed in 3.54s`, los cuatro por
      `psycopg2.errors.UndefinedColumn: column "screenshot_key" of relation
      "feedback_reports" does not exist` — razón correcta, no error de
      setup/fixture.
- [x] 1.3 (GREEN) Crear la migración 020.
      *Archivos*: crea `deploy/sql/migrations/020_feedback_screenshot.sql`.
      *Qué*: `ALTER TABLE feedback_reports ADD COLUMN IF NOT EXISTS
      screenshot_key TEXT NULL;` — idempotente, sin CHECK de formato (la
      forma se valida en Pydantic al crear vía API, no en SQL: una fila
      sembrada directo en la base por un script de mantenimiento no debe
      quedar bloqueada por un CHECK de regex). Comentario de cabecera en
      español citando el proposal.
      *Aceptación*: 1.2 pasa completo.
      *Verificación*: `./venv/bin/python -m pytest tests/integration/test_feedback_screenshot_migration.py -q` ⇒ verde.
      *Mutación*: NO — se verifica por ejecución real doble (mismo criterio
      que la 019); mutar `ADD COLUMN IF NOT EXISTS` no agrega información
      que (d) del test 1.2 ya no dé.
      *Evidencia (2026-09-03)*: `deploy/sql/migrations/020_feedback_screenshot.sql`
      creado; `./venv/bin/python -m pytest
      tests/integration/test_feedback_screenshot_migration.py -q` ⇒ `4
      passed in 3.25s`, incluyendo
      `test_segunda_aplicacion_de_la_migracion_020_es_no_op` (segunda
      ejecución REAL de `apply_migrations`, no mockeada).
- [x] 1.4 Gate de fase.
      *Qué*: `ruff format` + `ruff check` sobre el archivo de test nuevo;
      `rm -rf tests/integration/__pycache__`; correr la migración completa
      una vez más antes de tocar `src/`.
      *Verificación*: `./venv/bin/python -m pytest tests/integration/test_feedback_screenshot_migration.py -q`.
      *Mutación*: no aplica.
      *Evidencia (2026-09-03)*: `./venv/bin/ruff format
      tests/integration/test_feedback_screenshot_migration.py` ⇒ `1 file
      reformatted`; `./venv/bin/ruff check
      tests/integration/test_feedback_screenshot_migration.py` ⇒ `All
      checks passed!`; `rm -rf tests/integration/__pycache__` seguido de
      `./venv/bin/python -m pytest
      tests/integration/test_feedback_screenshot_migration.py -q` ⇒ `4
      passed in 4.55s` (pycache limpio, sin .pyc viejo sirviéndose).

---

## Phase 2: Backend — modelos, ScreenshotStorageService, router (TDD + mutaciones críticas)

**Estado al cerrar la fase**: los tres endpoints existentes exponen
`screenshot_key`; los dos endpoints nuevos (presign de subida y de lectura)
responden con la matriz de auth completa; R2 sin configurar degrada a 503
solo en presign sin afectar create/list; mutaciones registradas. Usable por
`curl` contra un testcontainer.

- [x] 2.1 `boto3` como dependencia nueva.
      *Archivos*: modifica `requirements.txt`.
      *Qué*: agregar `boto3` (pineada a la versión resuelta por
      `./venv/bin/pip install boto3` en este venv) — no está en el repo hoy,
      verificado. Instalar en el venv del proyecto.
      *Aceptación*: `./venv/bin/python -c "import boto3"` no lanza.
      *Verificación*: `./venv/bin/pip show boto3 && ./venv/bin/python -c "import boto3; print('ok')"`.
      *Mutación*: no aplica (es instalación de dependencia).
      *Evidencia (2026-09-03)*: `./venv/bin/pip install boto3` ⇒ instaló
      `boto3-1.43.88` (+ `botocore-1.43.88`, `jmespath-1.1.0`,
      `s3transfer-0.19.2`); pineado en `requirements.txt` con comentario de
      cabecera. `./venv/bin/python -c "import boto3; print('ok')"` ⇒ `ok`.
- [x] 2.2 (RED) Tests unitarios de `ScreenshotStorageService`.
      *Archivos*: crea `tests/unit/test_screenshot_storage.py`.
      *Qué*: las 4 variables presentes ⇒ `enabled is True` sin abrir ningún
      socket (no requiere R2 real: `boto3.client(...)` no valida
      credenciales al construirse); falta 1 de las 4 (las 4 combinaciones,
      parametrizado) ⇒ `enabled is False`, construcción SIN excepción;
      `create_upload_url()` con `enabled=False` — decidir en el propio test
      si el service debe lanzar o si esa responsabilidad es 100% del router
      (el design no lo especifica: el router siempre chequea `enabled` antes
      de llamar, así que el service puede asumir la precondición; el test
      documenta esa asunción explícitamente en un comentario).
      *Aceptación*: falla por módulo inexistente.
      *Verificación*: `./venv/bin/python -m pytest tests/unit/test_screenshot_storage.py -q`.
      *Mutación*: no aplica (es el test; sus mutaciones van en 2.9).
      *Evidencia (2026-09-03)*: `tests/unit/test_screenshot_storage.py`
      creado; `ImportError: cannot import name 'ScreenshotStorageService'`
      (módulo `src.services.screenshot_storage` no existe) — colección con 1
      error, razón correcta.
- [x] 2.3 (GREEN) Crear `ScreenshotStorageService`.
      *Archivos*: crea `src/services/screenshot_storage.py`.
      *Qué*: firmas EXACTAS del design (`__init__` con las 4
      `Optional[str]`, cliente `boto3` perezoso construido solo si las 4 no
      son `None`, `region_name="auto"`; `enabled` property;
      `create_upload_url(expires_in=300) -> tuple[str, str, datetime]`
      (key generada con `uuid4()` server-side, `generate_presigned_url
      ("put_object", ...)`); `create_download_url(key, expires_in=300) ->
      tuple[str, datetime]` (`generate_presigned_url("get_object", ...)`)).
      Docstrings en español citando que ambos métodos asumen `self.enabled`
      ya chequeado por el caller.
      *Aceptación*: 2.2 verde.
      *Verificación*: mismo comando de 2.2.
      *Mutación*: las lleva 2.11 (ver tabla).
      *Evidencia (2026-09-03)*: `src/services/screenshot_storage.py` creado
      con las firmas exactas del design. `./venv/bin/python -m pytest
      tests/unit/test_screenshot_storage.py -q` ⇒ `8 passed in 0.88s`.
- [x] 2.4 Config en `settings.py`.
      *Archivos*: modifica `src/config/settings.py`.
      *Qué*: 4 variables `Optional[str] = None` (`s3_endpoint_url`,
      `s3_bucket`, `s3_access_key_id`, `s3_secret_access_key`), comentario en
      español EXACTO del design (por qué no fail-fast, por qué degrada como
      `resend_api_key`/`EmailService`, no como `auth_secret_key`).
      *Aceptación*: `./venv/bin/python -c "from src.config.settings import settings; print(settings.s3_bucket)"` ⇒ `None` sin configurar env vars.
      *Verificación*: el comando de arriba.
      *Mutación*: NO — es declaración de config sin lógica; la protege 2.9/2.10 (degradación observada end-to-end).
      *Evidencia (2026-09-03)*: 4 variables agregadas a
      `src/config/settings.py`. Comando de verificación ⇒ `None`.
- [x] 2.5 (RED) Tests unitarios de los modelos Pydantic nuevos/extendidos.
      *Archivos*: modifica `tests/unit/test_feedback_models.py`.
      *Qué*: `FeedbackReportCreate.screenshot_key`: `None` ⇒ OK; formato
      exacto `feedback-screenshots/{uuid4}.png` ⇒ OK; `"../../etc/passwd"`,
      `"otro-bucket/imagen.jpg"`, `"feedback-screenshots/no-es-un-uuid.png"`,
      sin extensión `.png`, con extensión `.jpg` ⇒ todas rechazadas.
      `FeedbackReportItem.screenshot_key` acepta `None` y el formato válido.
      `ScreenshotUploadUrl {key, upload_url, expires_at}` y
      `ScreenshotDownloadUrl {url, expires_at}`: construcción válida no
      lanza; campos faltantes lanzan `ValidationError`.
      *Aceptación*: falla por atributo/clase inexistente.
      *Verificación*: `./venv/bin/python -m pytest tests/unit/test_feedback_models.py -q`.
      *Mutación*: no aplica (es el test; sus mutaciones van en 2.11).
      *Evidencia (2026-09-03)*: casos nuevos agregados a
      `tests/unit/test_feedback_models.py`; `ImportError: cannot import name
      'ScreenshotDownloadUrl' from 'src.models.feedback'` — colección con 1
      error, razón correcta.
- [x] 2.6 (GREEN) Extender `src/models/feedback.py`.
      *Archivos*: modifica `src/models/feedback.py`.
      *Qué*: `_SCREENSHOT_KEY_PATTERN` (regex EXACTO del design) y
      `field_validator` en `FeedbackReportCreate.screenshot_key: Optional[str]
      = None`; mismo campo agregado a `FeedbackReportItem`; clases nuevas
      `ScreenshotUploadUrl` y `ScreenshotDownloadUrl` con los tipos EXACTOS
      del design (`key`/`upload_url`/`expires_at: datetime` — reconciliación
      1: NO `screenshot_key` en la respuesta del presign de subida).
      *Aceptación*: 2.5 verde.
      *Verificación*: mismo comando de 2.5.
      *Mutación*: las lleva 2.11 (M3).
      *Evidencia (2026-09-03)*: `_SCREENSHOT_KEY_PATTERN`, el `field_validator`
      en `FeedbackReportCreate`, el campo en `FeedbackReportItem`, y
      `ScreenshotUploadUrl`/`ScreenshotDownloadUrl` agregados a
      `src/models/feedback.py`. `./venv/bin/python -m pytest
      tests/unit/test_feedback_models.py -q` ⇒ `51 passed in 2.07s`.
- [x] 2.7 Extender `FeedbackService` para leer/escribir `screenshot_key`.
      *Archivos*: modifica `src/services/feedback_service.py`.
      *Qué*: `create()` inserta `screenshot_key` (o `NULL` si no vino);
      `_ITEM_COLUMNS`/el SELECT de `_row_to_item()` incluye la columna en las
      cuatro consultas (`create`, `list_all`, `set_status`,
      `set_admin_comment`) — reconciliación 4: los tres endpoints existentes
      exponen el campo sin excepción. Nuevo método
      `get_screenshot_key(report_id) -> Optional[str]` que hace `SELECT
      screenshot_key FROM feedback_reports WHERE id=$1` y lanza
      `FeedbackReportNotFoundError` si `fetchrow` es `None` (lo consume el
      endpoint de lectura para decidir 404 vs firmar).
      *Aceptación*: importa sin error; se verifica de punta a punta en
      2.8–2.10 (verificar contra la base, no con mocks).
      *Verificación*: `./venv/bin/python -c "import src.services.feedback_service"`.
      *Mutación*: las lleva 2.11 (M4).
      *Evidencia (2026-09-03)*: `_ITEM_COLUMNS`/`_row_to_item` incluyen
      `screenshot_key`; `create()` inserta la columna; `get_screenshot_key()`
      agregado. `./venv/bin/python -c "import
      src.services.feedback_service"` ⇒ sin error.
- [x] 2.8 (RED) Integración — `POST /feedback/upload-url`.
      *Archivos*: crea `tests/integration/test_feedback_screenshot_api.py`
      (molde `test_feedback_api.py`: `TestClient`, `_login_as`,
      `_auth_service_mock`). Fixture que instancia `app.state.
      screenshot_storage` con un `ScreenshotStorageService` cuyo cliente
      `boto3` apunta a credenciales/endpoint FALSOS pero presentes (las 4
      variables no-`None` ⇒ `enabled=True`; `generate_presigned_url` firma
      localmente sin abrir socket, así que no hace falta un R2 real de test
      — ver Decision 1 del design, "cómputo local").
      *Qué*: sesión válida (cualquier rol, viewer incluido) ⇒ 201 con
      `{key, upload_url, expires_at}` donde `key` matchea
      `feedback-screenshots/{uuid}.png`; dos llamadas sucesivas del mismo
      usuario devuelven `key` distintos; sin cookie de sesión ⇒ 401, sin
      generar ninguna key (verificable indirectamente: no hay estado
      persistido, así que se afirma solo el código y el body de error);
      cuenta desactivada ⇒ 401.
      *Aceptación*: rojo por router inexistente (404).
      *Verificación*: `./venv/bin/python -m pytest tests/integration/test_feedback_screenshot_api.py -q -k upload_url`.
      *Mutación*: no aplica (es el test).
      *Evidencia (2026-09-03)*: `tests/integration/test_feedback_screenshot_api.py`
      creado (18 tests de la Fase 2 completa); `8 failed, 10 passed` al
      correr el archivo completo antes del router — los 4 tests de
      `upload_url` fallaron por 404 genérico de FastAPI (ruta inexistente).
- [x] 2.9 (RED) Integración — degradación con R2 sin configurar.
      *Archivos*: mismo archivo de 2.8.
      *Qué*: fixture alternativa con `app.state.screenshot_storage =
      ScreenshotStorageService(None, None, None, None)` (`enabled=False`):
      `POST /feedback/upload-url` ⇒ 503 con `{"detail": ...}`, sin
      traceback ni 500; EN LA MISMA corrida, `POST /feedback` con
      `screenshot_key=None` sigue respondiendo 201 (el create NO depende de
      `storage.enabled` — el criterio de éxito más importante del proposal);
      `POST /feedback` con un `screenshot_key` de formato VÁLIDO también
      sigue respondiendo 201 aunque R2 esté `enabled=False` (el create
      persiste el texto sin tocar R2, ver Requirement "R2 mal configurado no
      bloquea el resto del feedback"); `GET /feedback` y los dos `PUT`
      siguen respondiendo su código normal con R2 `enabled=False`.
      *Aceptación*: rojo por router inexistente.
      *Verificación*: `... -k degrad`.
      *Mutación*: no aplica (es el test).
      *Evidencia (2026-09-03)*: casos de degradación (`test_upload_url_r2_sin_configurar_da_503`
      y matriz de `create`/`GET`/`PUT` con R2 deshabilitado) incluidos en el
      mismo archivo de 2.8; `test_upload_url_r2_sin_configurar_da_503` rojo
      por router inexistente en la corrida conjunta de 2.8.
- [x] 2.10 (RED) Integración — create con/sin key y lectura de screenshot-url.
      *Archivos*: mismo archivo de 2.8.
      *Qué*: `POST /feedback` sin `screenshot_key` ⇒ 201, SELECT confirma
      `screenshot_key IS NULL`; con key de formato válido ⇒ 201, SELECT la
      persiste tal cual SIN llamar a R2 (se puede verificar con un stub que
      cuenta invocaciones a `create_download_url`/cliente boto3 y afirma
      cero); con key de formato inválido (los mismos casos de 2.5) ⇒ 422 y
      CERO filas creadas (SELECT COUNT). `GET
      /feedback/{id}/screenshot-url`: reporte con `screenshot_key` no nulo
      ⇒ 200 `{url, expires_at}`; reporte con `screenshot_key IS NULL` ⇒ 404;
      UUID inexistente ⇒ 404; sin sesión ⇒ 401.
      *Aceptación*: rojo por router inexistente.
      *Verificación*: `... -k "create or screenshot_url"`.
      *Mutación*: no aplica (es el test).
      *Evidencia (2026-09-03)*: `test_screenshot_url_reporte_con_key_devuelve_200`
      y `test_screenshot_url_sin_sesion_da_401` rojo por 404 genérico de
      router ausente. Nota: `test_screenshot_url_reporte_sin_key_da_404` y
      `test_screenshot_url_uuid_inexistente_da_404` pasaban "por accidente"
      (FastAPI ya responde 404 genérico para una ruta sin registrar, que
      coincide con el código esperado) — se fortalecieron con
      `resp.json()["detail"] != "Not Found"` (mismo criterio que
      `test_feedback_api.py::test_status_uuid_inexistente_da_404`) para que
      SÍ estuvieran rojas por la razón correcta antes del GREEN; confirmado
      rojo tras el fix. Los tests de `create con/sin key` (2.6/2.7 ya GREEN)
      pasaban de antes — correcto, no son parte del gap de router.
- [x] 2.11 (GREEN) Router: `POST /feedback/upload-url`, `GET
      /feedback/{id}/screenshot-url`, extender `POST /feedback` existente.
      *Archivos*: modifica `src/api/routers/feedback.py`; modifica
      `src/main.py`.
      *Qué*: `_get_screenshot_storage(request)` (molde
      `_get_feedback_service`); `POST /upload-url` con las firmas EXACTAS
      del design (`503` si `not storage.enabled`, si no
      `storage.create_upload_url()` ⇒ `201`); `GET
      /{report_id}/screenshot-url` (usa `feedback_service.
      get_screenshot_key`, `404` si no existe el reporte o la key es
      `None`, si no `storage.create_download_url(key)` ⇒ `200`).
      `FeedbackReportCreate` ya trae `screenshot_key` desde 2.6, sin cambios
      adicionales en el handler de create (el INSERT ya lo persiste desde
      2.7). En `main.py`: import + `app.state.screenshot_storage =
      ScreenshotStorageService(settings.s3_endpoint_url, settings.s3_bucket,
      settings.s3_access_key_id, settings.s3_secret_access_key)` (aditivo,
      junto a `feedback_service`).
      *Aceptación*: 2.8, 2.9 y 2.10 verdes completos.
      *Verificación*: `./venv/bin/python -m pytest tests/integration/test_feedback_screenshot_api.py -q`.
      *Mutación*: la lleva 2.12.
      *Evidencia (2026-09-03)*: `POST /upload-url`, `GET
      /{report_id}/screenshot-url` y `_get_screenshot_storage` agregados a
      `src/api/routers/feedback.py`; `app.state.screenshot_storage` wireado
      en `src/main.py` (mismo patrón que `feedback_service`).
      `./venv/bin/python -m pytest
      tests/integration/test_feedback_screenshot_api.py -q` ⇒ `18 passed in
      13.95s`. También se agregó `screenshot_key` a `ITEM_KEYS` en
      `tests/integration/test_feedback_api.py` (la extensión legítima de
      `FeedbackReportItem` rompía el `set(item) == ITEM_KEYS` de 3 tests
      preexistentes); tras el fix, `61 passed`.
- [x] 2.12 **Mutaciones críticas del backend** (registrar cada una en
      `mutation-log.md` con la mecánica del encabezado).
      *Archivos*: `src/api/routers/feedback.py`,
      `src/services/screenshot_storage.py`, `src/models/feedback.py`
      (mutar y REVERTIR).
      | # | Mutación | Test que DEBE morir |
      |---|---|---|
      | M1 | Quitar `Depends(get_current_user)` en `POST /feedback/upload-url` | sin sesión ⇒ debe seguir dando 401, no 201 (2.8) |
      | M2 | Quitar `if not storage.enabled: raise HTTPException(503, ...)` | R2 sin configurar ⇒ debe dar 503, no `AttributeError`/500 al llamar boto3 con cliente `None` (2.9) |
      | M3 | Quitar `_validate_screenshot_key` (o vaciar el regex) | `screenshot_key` con formato inválido ⇒ debe dar 422, no persistir basura (2.10) |
      | M4 | `ExpiresIn=300` → `ExpiresIn=999999` en `create_upload_url` | test de contrato del SDK: la URL firmada debe llevar el parámetro de expiración de 300s, no uno mayor (verificable inspeccionando la URL firmada devuelta — contiene `X-Amz-Expires=300` como querystring; no requiere R2 real) (2.8) |
      | M5 | Hacer que el handler de `POST /feedback` chequee `storage.enabled` antes de insertar | `POST /feedback` con `screenshot_key=None` y R2 sin configurar debe seguir dando 201 (2.9) |
      | M6 | Quitar el 404 cuando `screenshot_key is None` en `GET .../screenshot-url` | debe dar 404, no intentar `create_download_url(None)` (2.10) |
      | M7 | Quitar `screenshot_key` del SELECT/`_row_to_item` en `list_all`/`set_status`/`set_admin_comment` | `GET /feedback` y los dos `PUT` deben seguir exponiendo `screenshot_key` en el item (2.10, extendiendo un caso existente de `test_feedback_api.py` si hace falta agregarlo ahí) |
      *Aceptación*: 7 filas en `mutation-log.md`, cada una con `rg` que
      muestra el cambio, el test rojo con la aserción exacta, la reversión
      verificada por `cmp` contra snapshot, y el verde posterior.
      *Verificación*: `rg -c "revertido: sí" openspec/changes/feedback-screenshot-attachment/mutation-log.md` ⇒ ≥ 7.
      *Evidencia (2026-09-03)*: M1–M7 ejecutadas una a la vez con `Edit`
      (`sd -s` con patrón multilínea no matcheaba — gotcha ya conocido),
      cada una confirmada con `rg` antes del test, rojo con la razón exacta,
      revertida por `cmp` byte-a-byte (exit 0) contra el snapshot tomado
      ANTES de mutar, y verde posterior. M7 detectó un HUECO real de
      cobertura: ningún test afirmaba el VALOR de `screenshot_key` devuelto
      por `GET /feedback`/`PUT status`/`PUT comment` (solo su presencia como
      clave) — la mutación (reemplazar la columna real por `NULL AS
      screenshot_key` en `_ITEM_COLUMNS`) pasó 79 tests sin romper ninguno.
      Se fortaleció el test (3 casos nuevos que siembran `screenshot_key` y
      afirman el valor exacto en las 3 respuestas) ANTES de registrar la
      mutación como pasada — confirmados rojo con la mutación activa, luego
      verdes tras revertir. Detalle completo en `mutation-log.md`.
- [x] 2.13 Gate de fase.
      *Qué*: suite del change (migración 020 + modelos + storage + API)
      verde; `ruff format` + `ruff check` limpios sobre los archivos nuevos
      y tocados, sin hallazgos nuevos respecto de HEAD.
      *Verificación*: `./venv/bin/python -m pytest tests/unit/test_screenshot_storage.py tests/unit/test_feedback_models.py tests/integration/test_feedback_screenshot_migration.py tests/integration/test_feedback_screenshot_api.py tests/integration/test_feedback_api.py -q && ./venv/bin/ruff check src/services/screenshot_storage.py src/models/feedback.py src/api/routers/feedback.py src/main.py src/config/settings.py tests/unit/test_screenshot_storage.py tests/integration/test_feedback_screenshot_api.py tests/integration/test_feedback_screenshot_migration.py`.
      *Mutación*: no aplica.
      *Evidencia (2026-09-03)*: suite del change: `145 passed in 27.96s`.
      `ruff format` + `ruff check` limpios sobre los 9 archivos
      tocados/nuevos de esta fase; el único hallazgo de `ruff check .` en
      todo el repo (F811 en `src/main.py:2718`, `search_stations`
      redefinido) es PREEXISTENTE en HEAD (confirmado con `git stash` +
      `ruff check src/main.py` antes de esta fase). Suite COMPLETA
      (`./venv/bin/python -m pytest tests/ -q -p no:cacheprovider --no-cov`):
      `9 failed, 1232 passed, 2 skipped, 8 warnings in 431.83s` — los 9
      fallos son EXACTAMENTE los mismos de la baseline de 1.1 (mismos
      nombres, todos `tests/unit/test_ws_events.py`), cero regresiones
      nuevas; delta neto +51 sobre la baseline de 1181. Detalle completo en
      `mutation-log.md`.

---

## Phase 3: Frontend — captura, presign, subida, aviso WebGL, wiring del widget

**Estado al cerrar la fase**: `modern-screenshot` instalado; abrir el widget
dispara captura + presign + subida en paralelo sin bloquear el tipeo; una
vista con WebGL muestra el aviso; el submit incluye `screenshot_key` si la
subida terminó a tiempo, y funciona igual si no.

- [x] 3.1 Instalar `modern-screenshot` y registrar baseline frontend.
      *Archivos*: modifica `dashboard/package.json` (y lockfile).
      *Qué*: exportar el PATH de Node v22 de nvm; `cd dashboard && npm
      install modern-screenshot` (dependencia NUEVA, no asumir presente);
      registrar en `mutation-log.md` la baseline: `./node_modules/.bin/vitest
      run` y `./node_modules/.bin/tsc --noEmit` ANTES de tocar nada — el
      número real de HOY, no el `1093 passed` del change base (movió desde
      entonces).
      *Aceptación*: `rg '"modern-screenshot"' dashboard/package.json` ⇒
      match; baseline anotada.
      *Verificación*: `cd dashboard && ./node_modules/.bin/vitest run 2>&1 | tail -5`.
      *Mutación*: no aplica.
      *Evidencia (2026-09-03)*: `npm install modern-screenshot` ⇒
      `modern-screenshot@4.7.0` agregado a `dependencies`. Baseline fresca:
      `100 files / 1094 tests passed`; `tsc --noEmit` ⇒ exit 0. Registrado en
      `mutation-log.md`.
- [x] 3.2 (RED) Test del helper de screenshot ANTES de crearlo.
      *Archivos*: crea `dashboard/lib/screenshot.test.ts` (molde
      `dashboard/lib/walls.test.ts`, `mockFetch`).
      *Qué*: `detectWebglCanvas()`: con `document.querySelectorAll('canvas')`
      mockeado devolviendo un canvas cuyo `getContext('webgl')` retorna un
      objeto no-null ⇒ `true`; con `getContext` devolviendo `null` para
      `'webgl'` y `'webgl2'` ⇒ `false`; sin ningún canvas en el DOM ⇒
      `false`. `uploadScreenshot(blob)`: presign responde 503 ⇒ devuelve
      `null` SIN lanzar; presign responde 201 pero el `PUT` a la
      `upload_url` rechaza (network error o `!ok`) ⇒ `null` sin lanzar;
      ambos éxito ⇒ devuelve el `key` del presign, y el `PUT` se hizo con el
      blob y `Content-Type: image/png`. `captureScreenshot()`: mock de
      `modern-screenshot` que lanza ⇒ devuelve `null` sin propagar la
      excepción; mock que resuelve un blob mayor a 2MB tras "comprimir" (el
      propio mock simula el resultado final) ⇒ `null` (descartado por
      tamaño, no se sube).
      *Aceptación*: falla por módulo inexistente.
      *Verificación*: `cd dashboard && ./node_modules/.bin/vitest run lib/screenshot.test.ts`.
      *Mutación*: no aplica (es el test; sus mutaciones van en 3.6).
      *Evidencia (2026-09-03)*: `dashboard/lib/screenshot.test.ts` creado (11
      tests: 4 de `detectWebglCanvas`, 4 de `uploadScreenshot`, 3 de
      `captureScreenshot`); jsdom no soporta WebGL real (`getContext('webgl')`
      es `null` por default), así que `detectWebglCanvas` se testea mockeando
      `document.querySelectorAll` con canvases stub cuyo `getContext` propio
      se spyea por id (patrón nuevo para este archivo, no existía un molde de
      WebGL en el repo — sí existía el molde de `getContext('2d')` con
      `vi.spyOn(HTMLCanvasElement.prototype, 'getContext')` en
      `HelicorderCanvas.test.tsx`, pero acá conviene un canvas por escenario
      en vez de un prototype-spy global). `modern-screenshot` se mockea con
      `vi.mock` + `vi.hoisted` (referencia estable, mismo criterio que los
      mocks de router). `./node_modules/.bin/vitest run lib/screenshot.test.ts`
      ⇒ rojo por `Failed to resolve import "./screenshot"` — razón correcta
      (módulo inexistente).
- [x] 3.3 (GREEN) Crear `dashboard/lib/screenshot.ts`.
      *Archivos*: crea `dashboard/lib/screenshot.ts`.
      *Qué*: las tres funciones con las firmas EXACTAS del design
      (`captureScreenshot(): Promise<Blob | null>`,
      `detectWebglCanvas(): boolean`, `uploadScreenshot(blob):
      Promise<string | null>`). `captureScreenshot` usa `modern-screenshot`
      sobre el contenedor de la app, redimensiona/comprime a máx. 1920px de
      lado largo y 2MB finales; si tras comprimir sigue excediendo 2MB,
      devuelve `null` sin subir nada; cualquier excepción de la librería se
      captura y devuelve `null`. `uploadScreenshot` llama a
      `requestScreenshotUploadUrl()` de `lib/feedback.ts` (tarea 3.4) y hace
      el `PUT` directo a `upload_url`; cualquier fallo en cualquier paso
      devuelve `null` sin lanzar.
      *Aceptación*: 3.2 verde.
      *Verificación*: mismo comando de 3.2.
      *Mutación*: las lleva 3.6 (M9, M10).
      *Evidencia (2026-09-03)*: `dashboard/lib/screenshot.ts` creado con las
      tres firmas exactas del design (`captureScreenshot`,
      `detectWebglCanvas`, `uploadScreenshot`), `MAX_SIDE_PX=1920` y
      `MAX_BYTES=2MB` como constantes del módulo.
      `./node_modules/.bin/vitest run lib/screenshot.test.ts` ⇒ `11 passed`.
- [x] 3.4 (RED→GREEN) Extender `dashboard/lib/feedback.ts`.
      *Archivos*: modifica `dashboard/lib/feedback.ts`; modifica
      `dashboard/lib/feedback.test.ts`.
      *Qué (RED primero)*: agregar al test existente: `FeedbackPayload`
      admite `screenshot_key?: string`; `FeedbackReport` (el tipo leído de
      `GET /feedback`) incluye `screenshot_key: string | null`;
      `requestScreenshotUploadUrl()` hace `POST /feedback/upload-url` y
      devuelve `{key, upload_url, expires_at}`, 401 ⇒ `null`, `!ok` ⇒
      `ApiStatusError`; `getScreenshotDownloadUrl(reportId)` hace `GET
      /feedback/{id}/screenshot-url` y devuelve `{url, expires_at}`, mismo
      manejo de 401/error. Correr en rojo (funciones inexistentes), luego
      implementar en `feedback.ts` con el mismo `request<T>` local ya usado
      (`credentials: 'include'`, `cache: 'no-store'`).
      *Aceptación*: el archivo de test extendido pasa completo.
      *Verificación*: `cd dashboard && ./node_modules/.bin/vitest run lib/feedback.test.ts`.
      *Mutación*: NO — tests de contrato con fetch mockeado (molde
      `walls.test.ts`); la lógica de decisión vive en el backend y en
      `screenshot.ts` (mutaciones de 3.6).
      *Evidencia (2026-09-03)*: 6 casos nuevos agregados a
      `dashboard/lib/feedback.test.ts` (3 de `requestScreenshotUploadUrl`, 3
      de `getScreenshotDownloadUrl`); también se agregó `screenshot_key:
      null` al fixture `REPORT` del mismo archivo (necesario para que el tipo
      siga siendo un `FeedbackReport` válido tras extender la interfaz).
      Rojo inicial: `6 failed` por `getScreenshotDownloadUrl is not a
      function`/import inexistente. Tras extender `feedback.ts`
      (`FeedbackPayload.screenshot_key?`, `FeedbackReport.screenshot_key`,
      `ScreenshotUploadUrl`, `ScreenshotDownloadUrl`,
      `requestScreenshotUploadUrl()`, `getScreenshotDownloadUrl()`):
      `./node_modules/.bin/vitest run lib/feedback.test.ts` ⇒ `22 passed`.
      Efecto colateral esperado: `screenshot_key: string | null` en
      `FeedbackReport` rompió `tsc` en dos fixtures `buildReport()`
      preexistentes (`app/(app)/feedback/page.test.tsx`,
      `components/feedback/FeedbackBoard.test.tsx`) que no incluían el campo
      nuevo — se les agregó `screenshot_key: null` al default del builder,
      mismo patrón ya usado ahí para `admin_comment_updated_at`.
- [x] 3.5 (RED→GREEN) Aviso WebGL, captura al abrir, wiring del submit en
      `FeedbackWidget.tsx`.
      *Archivos*: modifica `dashboard/components/feedback/FeedbackWidget.tsx`;
      modifica `dashboard/components/feedback/FeedbackWidget.test.tsx`.
      *Qué (RED primero, casos nuevos agregados al archivo existente)*: al
      abrir el dialog se dispara `captureScreenshot` (mock) sin bloquear el
      render del formulario — el tester puede tipear antes de que la
      promesa resuelva; si `detectWebglCanvas()` (mock) devuelve `true`, el
      dialog muestra el aviso de "puede no incluir el contenido 3D"
      (string nuevo del namespace `feedback.widget.*`); si devuelve `false`,
      el aviso NO aparece; el aviso NUNCA deshabilita ni retrasa el botón de
      enviar; si `uploadScreenshot` (mock) resuelve una key ANTES del click
      de enviar, el `submitFeedback` recibe `screenshot_key` con esa key; si
      resuelve `null` o no terminó a tiempo, `submitFeedback` se llama SIN
      el campo (o `undefined`) y el submit igual completa con 201 mockeado
      — sin ningún mensaje de error de captura visible. Implementar en el
      componente: efecto al abrir el dialog que dispara captura + presign +
      subida en paralelo (no `await` bloqueante del render), estado
      `screenshotKey: string | null`, detección WebGL al montar el dialog.
      *Aceptación*: los casos nuevos y los preexistentes del archivo pasan
      completo.
      *Verificación*: `cd dashboard && ./node_modules/.bin/vitest run components/feedback/FeedbackWidget.test.tsx`.
      *Mutación*: las lleva 3.6 (M11, M12).
      *Evidencia (2026-09-03)*: 6 casos nuevos agregados a
      `FeedbackWidget.test.tsx` con `vi.mock('@/lib/screenshot', ...)`
      (referencias estables vía `vi.hoisted`, mismo patrón que
      `submitFeedbackMock`). Rojo inicial: 3 de los 6 fallaron
      (`captureScreenshotMock`/`uploadScreenshotMock` nunca llamados; el
      aviso WebGL no aparecía) — razón correcta, el wiring no existía.
      **Desviación real encontrada durante la implementación**: la primera
      versión disparaba la captura dentro de `handleOpenChange`, pero el
      harness de test (y `AppSidebar` en producción) controla `open` como
      prop externa y NUNCA llama a `handleOpenChange` para abrir — solo lo
      hace para cerrar (`Dialog.onOpenChange`). Con la captura en
      `handleOpenChange`, `captureScreenshotMock` quedaba en 0 llamadas
      siempre que el caller controlara `openProp` (el caso real de
      producción). Se movió la lógica a un `useEffect` sobre el booleano
      derivado `dialogOpen` (`openProp ?? isOpen`), con un `ref` que
      SOLAMENTE evita repetir la captura en re-renders mientras el dialog
      sigue abierto (se resetea a `false` al cerrar) — no es el patrón de
      "efecto que lee un ref/estado como dependencia" de la lección de
      memoria: la dependencia del efecto es el booleano derivado, el ref es
      un guard interno de una sola dirección. Tras el fix:
      `./node_modules/.bin/vitest run components/feedback/FeedbackWidget.test.tsx`
      ⇒ `19 passed` (13 preexistentes + 6 nuevos). Un test tuvo `act()`
      warning por una promesa resuelta después del assert final
      (`resolveUpload(null)` sin esperar su efecto) — corregido agregando
      `await waitFor(() => expect(uploadScreenshotMock).toHaveResolved())`
      al final del test; sin warnings tras el fix.
- [x] 3.6 Strings i18n del aviso WebGL y estado de captura + mutaciones
      críticas del frontend (subida/degradación) + gate de fase.
      *Archivos*: modifica `dashboard/messages/es.json`,
      `dashboard/messages/en.json`; `dashboard/lib/screenshot.ts`,
      `dashboard/components/feedback/FeedbackWidget.tsx` (mutar y
      REVERTIR).
      *Qué*: agregar `feedback.widget.webglNotice` (es/en) — el resto del
      flujo no muestra ningún mensaje de usuario (degrada en silencio, por
      diseño). Correr `parity.test.ts`. Luego mutaciones:
      | # | Mutación | Test que DEBE morir |
      |---|---|---|
      | M8 | En `detectWebglCanvas`, invertir el resultado (`!result`) | vista con canvas WebGL debe mostrar el aviso, vista sin WebGL no debe mostrarlo (3.2, 3.5) |
      | M9 | En `uploadScreenshot`, quitar el `try/catch` que atrapa el fallo del `PUT` | un `PUT` que rechaza debe devolver `null`, no propagar la excepción (3.2) |
      | M10 | En `captureScreenshot`, quitar el chequeo de tamaño (2MB) | un blob que excede el límite tras comprimir debe descartarse (`null`), no subirse (3.2) |
      | M11 | En `FeedbackWidget`, hacer que el submit espere (`await`) a `uploadScreenshot` antes de habilitar el botón enviar | el submit debe seguir habilitado y funcionar aunque la captura/subida no haya terminado (3.5) |
      | M12 | Mostrar el aviso WebGL como bloqueante (deshabilita el botón enviar mientras esté visible) | el envío debe proceder igual con el aviso visible (3.5) |
      *Aceptación*: `parity.test.ts` verde; 5 filas más en `mutation-log.md`
      (M8–M12) con `rg`, rojo, reversión por `cmp`, verde; luego
      `lib/screenshot.test.ts`, `lib/feedback.test.ts`,
      `FeedbackWidget.test.tsx`, `parity.test.ts` verdes y `tsc --noEmit`
      exit 0.
      *Verificación*: `cd dashboard && ./node_modules/.bin/vitest run lib/screenshot.test.ts lib/feedback.test.ts components/feedback/FeedbackWidget.test.tsx messages/parity.test.ts && ./node_modules/.bin/tsc --noEmit`.
      *Evidencia (2026-09-03)*: `feedback.widget.webglNotice` agregado a
      `messages/es.json` y `messages/en.json`.
      `./node_modules/.bin/vitest run messages/parity.test.ts` ⇒ `4 passed`.
      M8–M12 ejecutadas una a la vez con `Edit`, cada una confirmada con `rg`
      antes del test, RED con la razón exacta (test que el propio tasks.md
      predijo), revertida por `cmp` byte-a-byte (exit 0, `cmp: byte-identical`)
      contra un snapshot tomado ANTES de mutar, y verde posterior. Detalle
      completo (mutación exacta, salida de `rg`, test que murió) en
      `mutation-log.md`.
      Suite del change tras revertir todas las mutaciones:
      `./node_modules/.bin/vitest run lib/screenshot.test.ts lib/feedback.test.ts
      components/feedback/FeedbackWidget.test.tsx messages/parity.test.ts` ⇒
      `56 passed`. `tsc --noEmit` ⇒ exit 0.
      **Gate de fase completo**: `./node_modules/.bin/vitest run` (suite
      COMPLETA del dashboard) ⇒ `101 files / 1117 tests passed` (baseline de
      3.1 era 100/1094 — delta +1 archivo, +23 tests, exactamente los tests
      nuevos de esta fase: 11 de `screenshot.test.ts`, 6 de
      `feedback.test.ts`, 6 de `FeedbackWidget.test.tsx`). Cero regresiones.
      `tsc --noEmit` ⇒ exit 0.

---

## Phase 4: Frontend — thumbnail y lightbox en el tablero admin

**Estado al cerrar la fase**: una tarjeta con `screenshot_key` muestra
thumbnail y abre un lightbox con la imagen completa; sin `screenshot_key`,
el layout es idéntico al de antes de este change; un fallo de la URL de
lectura degrada a un estado roto de imagen, no a un crash.

- [x] 4.1 (RED) Tests de thumbnail y lightbox ANTES de implementarlos.
      *Archivos*: modifica `dashboard/components/feedback/FeedbackCard.test.tsx`
      si existe como archivo propio, o los casos correspondientes dentro de
      `FeedbackBoard.test.tsx` (verificar cuál de los dos monta
      `FeedbackCard` de forma aislada en el sibling change antes de decidir
      dónde agregar — mismo criterio de "molde existente" del resto de las
      tareas); crea/modifica también un archivo de test para
      `FeedbackCardDetail.tsx` si no cubre ya lightbox.
      *Qué*: tarjeta con `screenshot_key` no nulo ⇒ renderiza un thumbnail
      (mock de `getScreenshotDownloadUrl` resolviendo `{url, expires_at}`);
      tarjeta con `screenshot_key = null` ⇒ CERO elementos relacionados a
      imagen, y el layout (estructura de nodos) es idéntico al snapshot de
      una tarjeta sin este change; click/Enter en el thumbnail abre un
      lightbox con la imagen a tamaño completo; el lightbox vuelve a llamar
      `getScreenshotDownloadUrl` al abrirse (no reusa la URL del thumbnail
      — decisión de la Open Question del design: re-pedir siempre, nunca
      cachear la firmada); si `getScreenshotDownloadUrl` falla (401/500), el
      thumbnail muestra un estado de imagen rota (`alt` descriptivo, sin
      lanzar ni tirar el render del resto de la tarjeta); el lightbox es
      cerrable (Escape/botón) y devuelve el foco al thumbnail que lo abrió;
      en el detalle (`FeedbackCardDetail`), sin `screenshot_key` no existe
      ningún control de imagen ni botón de lightbox.
      *Aceptación*: rojo por comportamiento/elemento inexistente.
      *Verificación*: `cd dashboard && ./node_modules/.bin/vitest run components/feedback/FeedbackCard.test.tsx components/feedback/FeedbackBoard.test.tsx` (ajustar rutas según dónde queden los casos).
      *Mutación*: no aplica (es el test).
      *Evidencia (2026-09-03)*: confirmado que NO existía `FeedbackCard.test.tsx`
      (solo `FeedbackBoard.test.tsx` monta `FeedbackCard` indirectamente) ni
      `FeedbackCardDetail.test.tsx`. Casos de thumbnail agregados a
      `FeedbackBoard.test.tsx` (mock `vi.hoisted` de
      `getScreenshotDownloadUrl` sobre `@/lib/feedback`, mismo patrón que
      `FeedbackWidget.test.tsx`): thumbnail con `screenshot_key`, cero
      elementos de imagen sin `screenshot_key`, click/Enter abre lightbox,
      lightbox re-pide la URL (segunda llamada distinta a la del thumbnail),
      Escape cierra y devuelve foco, fallo de `getScreenshotDownloadUrl`
      degrada a `screenshotUnavailable` sin crashear el resto de la tarjeta.
      Creado `FeedbackCardDetail.test.tsx` (sin cobertura propia hasta
      ahora): mismos casos aislados sobre el detalle, más el caso "sin
      `screenshot_key` no hay ningún control de imagen". `vitest run
      components/feedback/FeedbackBoard.test.tsx
      components/feedback/FeedbackCardDetail.test.tsx` ⇒ 9 tests rojos por
      elemento/rol inexistente (`getByRole('button', {name:
      screenshotThumbnailAlt})` no encontrado), 24 verdes (los preexistentes
      + los 2 casos "sin key" que pasan trivialmente porque hoy no se
      renderiza nada) — razón correcta, no error de setup.
- [x] 4.2 (GREEN) Thumbnail condicional en `FeedbackCard.tsx`.
      *Archivos*: modifica `dashboard/components/feedback/FeedbackCard.tsx`.
      *Qué*: cuando `report.screenshot_key` no es `null`/`undefined`,
      renderizar un elemento clickeable/operable por teclado que, al
      montarse en viewport o al recibir foco, llama
      `getScreenshotDownloadUrl(report.id)` y usa la `url` resultante como
      `src` de un `<img>`; al activarse (click/Enter), abre el lightbox de
      4.3. Sin `screenshot_key`, no renderiza nada nuevo — cero cambio de
      DOM respecto de antes de este change.
      *Aceptación*: los casos de thumbnail de 4.1 pasan.
      *Verificación*: mismo comando de 4.1.
      *Mutación*: las lleva 4.5 (M13).
      *Evidencia (2026-09-03)*: `ScreenshotThumbnail` (definido en
      `FeedbackCardDetail.tsx`, exportado, importado en `FeedbackCard.tsx`)
      renderizado condicional en `FeedbackCard.tsx` solo cuando
      `report.screenshot_key !== null`. Pide `getScreenshotDownloadUrl` en un
      `useEffect` al montarse; sin `screenshot_key` el componente ni se monta
      (guard en el caller). `vitest run
      components/feedback/FeedbackBoard.test.tsx` ⇒ verde tras el fix.
- [x] 4.3 (GREEN) Lightbox en `FeedbackCardDetail.tsx`.
      *Archivos*: modifica `dashboard/components/feedback/FeedbackCardDetail.tsx`.
      *Qué*: reusar `ui/dialog.tsx` (no existe primitivo de imagen/carousel
      en `dashboard/components/ui/` — verificado, decisión de esta fase
      alineada con la Open Question del design: `Dialog` + `<img
      max-width/max-height>` alcanza, sin componente `Lightbox` dedicado).
      Al activarse desde el thumbnail o desde un control propio del
      detalle, pide `getScreenshotDownloadUrl` de nuevo (nunca cachea la
      URL firmada del thumbnail) y muestra la imagen a tamaño completo
      dentro del `Dialog`; cierre con Escape/click afuera devuelve el foco.
      Sin `screenshot_key`, ningún control de imagen ni botón de lightbox
      en el árbol.
      *Aceptación*: los casos de lightbox y detalle de 4.1 pasan.
      *Verificación*: mismo comando de 4.1.
      *Mutación*: las lleva 4.5 (M14).
      *Evidencia (2026-09-03)*: `ScreenshotLightbox` (privado a
      `FeedbackCardDetail.tsx`) reusa `ui/dialog.tsx`; re-pide
      `getScreenshotDownloadUrl(reportId)` en un `useEffect` sobre `open`
      (verificado por test: segunda llamada con el mismo `reportId`,
      distinta invocación que la del thumbnail — nunca reusa el `url` del
      estado del thumbnail). Se agregó `screenshot_key !== null &&
      <ScreenshotThumbnail .../>` en `FeedbackCardDetail.tsx` también (el
      propio detalle muestra su thumbnail que abre el mismo lightbox).
      **Desviación real encontrada**: Radix `Dialog` sin `DialogTrigger
      asChild` no conoce el elemento que "abrió" el diálogo (el thumbnail se
      abre por estado propio, no por composición), así que el foco por
      default al cerrar volvía a `<body>`, no al thumbnail — verificado con
      un test aislado (`console.log(document.activeElement)`) antes de
      corregir. Fix: `onCloseAutoFocus` en `DialogContent` con
      `event.preventDefault()` + `triggerRef.current?.focus()`, pasando el
      `buttonRef` del thumbnail como `triggerRef` al lightbox. También hizo
      falta un `onKeyDown` explícito (Enter/Space) en el botón del
      thumbnail: `fireEvent.keyDown` de jsdom no dispara la acción-por-default
      de un `<button>` nativo como sí hace un browser real.
- [x] 4.4 Manejo de fallo de la URL de lectura.
      *Archivos*: mismos de 4.2/4.3 si el manejo de error no quedó ya
      cubierto ahí.
      *Qué*: si `getScreenshotDownloadUrl` rechaza o devuelve `null` (401),
      el thumbnail muestra un estado de imagen rota con `alt` traducido
      (`feedback.board.screenshotUnavailable` o similar) en vez de lanzar;
      el resto de la tarjeta (comentario, estado, autor) sigue
      renderizando con normalidad.
      *Aceptación*: caso de 4.1 ("fallo degrada a imagen rota, no crash")
      pasa.
      *Verificación*: mismo comando de 4.1.
      *Mutación*: NO — el propio test de 4.1 ya es la aserción de "no
      lanza"; una mutación que rompiera esto haría fallar ese test sin
      necesidad de mutar explícitamente (documentado, no repetido).
      *Evidencia (2026-09-03)*: manejado ya en `ScreenshotThumbnail` (estado
      `failed`, seteado tanto si `getScreenshotDownloadUrl` devuelve `null`
      como si la promesa rechaza — `.catch()`) y en `ScreenshotLightbox`
      (mismo criterio, degrada a `screenshotUnavailable` en vez de romper el
      diálogo). Cubierto por los tests de 4.1 en ambos archivos; sin código
      adicional más allá del ya escrito en 4.2/4.3.
- [x] 4.5 **Mutaciones críticas del tablero** + gate de fase.
      *Archivos*: `FeedbackCard.tsx`, `FeedbackCardDetail.tsx` (mutar y
      REVERTIR).
      | # | Mutación | Test que DEBE morir |
      |---|---|---|
      | M13 | Renderizar el thumbnail sin el guard `screenshot_key != null` (mostrarlo siempre) | tarjeta sin `screenshot_key` debe seguir sin thumbnail (4.1) |
      | M14 | En el lightbox, cachear la URL del thumbnail en vez de re-pedir `getScreenshotDownloadUrl` al abrir | debe volver a llamar el endpoint al abrir, no reusar la URL del thumbnail (4.1) |
      *Aceptación*: 2 filas más en `mutation-log.md`; luego verde de
      `FeedbackCard.test.tsx`/`FeedbackBoard.test.tsx` y `tsc --noEmit`
      exit 0.
      *Verificación*: `cd dashboard && ./node_modules/.bin/vitest run && ./node_modules/.bin/tsc --noEmit`.
      *Evidencia (2026-09-03)*: M13 (quitar el guard en `FeedbackCard.tsx`) y
      M14 (lightbox cachea `cachedThumbnailUrl` en vez de re-llamar
      `getScreenshotDownloadUrl`) ejecutadas una a la vez, snapshot antes de
      mutar, `rg` confirma el cambio, RED con la razón exacta predicha,
      revertidas por `cmp` byte-a-byte (exit 0), verde posterior. Detalle
      completo en `mutation-log.md`. **Gate de fase**: suite COMPLETA del
      dashboard ⇒ `102 files / 1129 tests passed` (baseline de cierre de
      Fase 3: 101/1117 — delta +1 archivo, +12 tests, exactamente los
      nuevos de esta fase). `tsc --noEmit` ⇒ exit 0. Cero regresiones.

---

## Phase 5: i18n — paridad y auditoría de strings

**Estado al cerrar la fase**: ningún literal hardcodeado nuevo, paridad
es/en verde incluyendo las claves de esta fase.

- [x] 5.1 Paridad es/en de las claves nuevas.
      *Archivos*: `dashboard/messages/es.json`, `dashboard/messages/en.json`
      (solo si falta algo tras 3.6/4.4).
      *Qué*: correr `parity.test.ts`; confirmar con `rg` que
      `feedback.widget.webglNotice` y cualquier clave de
      thumbnail/lightbox/error existen en ambos JSON.
      *Aceptación*: paridad verde.
      *Verificación*: `cd dashboard && ./node_modules/.bin/vitest run messages/parity.test.ts`.
      *Mutación*: NO — `parity.test.ts` es el guardián.
      *Evidencia (2026-09-03)*: `./node_modules/.bin/vitest run
      messages/parity.test.ts` ⇒ `4 passed`. `rg -c` confirma
      `webglNotice`, `screenshotThumbnailAlt`, `screenshotUnavailable` y
      `screenshotLightboxTitle` presentes 4 veces en `es.json` y 4 en
      `en.json` (una por clave, ambos idiomas parejos).
- [x] 5.2 Auditoría: sin literales hardcodeados en los archivos nuevos/tocados.
      *Archivos*: `dashboard/lib/screenshot.ts`,
      `dashboard/components/feedback/FeedbackWidget.tsx`,
      `dashboard/components/feedback/FeedbackCard.tsx`,
      `dashboard/components/feedback/FeedbackCardDetail.tsx`.
      *Qué*: `rg` sobre texto visible en JSX de estos cuatro archivos
      (excluidos `*.test.tsx`) buscando cadenas de usuario fuera de `t(...)`
      — mismo patrón de auditoría del change base.
      *Aceptación*: sin matches que sean texto de usuario.
      *Verificación*: `rg -n ">[A-Za-zÁ-ú][^<{]*<" dashboard/components/feedback`.
      *Mutación*: no aplica (auditoría estática).
      *Evidencia (2026-09-03)*: `rg -n ">[A-Za-zÁ-ú][^<{]*<" lib/screenshot.ts
      components/feedback/FeedbackWidget.tsx
      components/feedback/FeedbackCard.tsx
      components/feedback/FeedbackCardDetail.tsx` ⇒ sin matches, cero
      literales de usuario fuera de `t(...)`.
- [x] 5.3 Tipos.
      *Qué*: `tsc --noEmit` exit 0 sobre el dashboard completo. Nunca
      `next build`.
      *Verificación*: `cd dashboard && ./node_modules/.bin/tsc --noEmit; echo $?`.
      *Mutación*: no aplica.
      *Evidencia (2026-09-03)*: `./node_modules/.bin/tsc --noEmit` ⇒ `exit
      0`, sin salida.

---

## Phase 6: Verificación, deploy y rollout

**Estado al cerrar la fase**: change verificado contra los Success Criteria
del proposal con evidencia real de HOY; desplegado; QA visual, provisión de
R2/Railway y verificación end-to-end en prod hechas por el usuario.
**Ninguna tarea de esta fase corre el stack en local** — preferencia
permanente del usuario. Las tareas **(USUARIO)** las ejecuta el usuario; el
agente no las marca `[x]` por su cuenta.

- [ ] 6.1 Suite backend COMPLETA contra la baseline de HOY.
      *Qué*: `./venv/bin/python -m pytest tests/ -q -p no:cacheprovider
      --no-cov` y comparar contra la baseline registrada en 1.1 — el delta
      debe ser exactamente los tests nuevos de este change, cero
      regresiones. `./venv/bin/ruff check .` sin hallazgos nuevos respecto
      de HEAD.
      *Verificación*: los dos comandos; conteos registrados en
      `mutation-log.md` con la fecha real de la corrida (no asumir que los
      números del change base siguen vigentes).
      *Mutación*: no aplica.
- [ ] 6.2 Suite frontend completa.
      *Qué*: `./node_modules/.bin/vitest run` y `./node_modules/.bin/tsc
      --noEmit` tras cualquier retoque posterior a la Fase 5.
      *Verificación*: `cd dashboard && ./node_modules/.bin/vitest run &&
      ./node_modules/.bin/tsc --noEmit`. **Nunca `next build`.**
      *Mutación*: no aplica.
- [ ] 6.3 Deploy (solo cuando el usuario lo pida).
      *Qué*: commit convencional (sin atribución a IA) en rama propia, PR,
      merge; verificar en Railway que el servicio `api` redeploya y sus
      logs muestran la 020 aplicada sin error tras la 019, y que un
      restart posterior es no-op; Vercel toma el dashboard.
      *Aceptación*: `curl -s -o /dev/null -w "%{http_code}" -X POST
      https://<api-prod>/feedback/upload-url` (sin cookie) ⇒ 401 — prueba
      que el router nuevo está montado y el lifespan completó, sin
      necesidad de arrancar nada en local.
      *Mutación*: no aplica.
- [ ] 6.4 **(USUARIO) Dependencia de rollout — bucket R2 + secrets en
      Railway.** Crear manualmente el bucket R2 y el token de API en el
      dashboard de Cloudflare; cargar `S3_ENDPOINT_URL`, `S3_BUCKET`,
      `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` en los secrets del
      servicio `api` de Railway. Sin esto, `POST /feedback/upload-url`
      sigue respondiendo 503 en prod y el widget nunca adjunta captura —
      bloquea que la feature funcione de punta a punta, NO bloquea que el
      código esté mergeado y el resto del feedback funcione.
      *Aceptación*: `curl -s -X POST https://<api-prod>/feedback/upload-url
      -H "Cookie: session=<...>"` ⇒ 201 con `{key, upload_url, expires_at}`
      en vez de 503.
- [ ] 6.5 **(USUARIO) Verificación end-to-end real en prod.** Con el bucket
      ya cargado: abrir el widget en una vista con `SeismicGlobe.tsx`
      (`/live`) y confirmar que aparece el aviso WebGL; abrir el widget en
      una vista de espectrograma pura y confirmar que NO aparece; enviar un
      reporte con captura exitosa y confirmar que `FeedbackCard.tsx`
      muestra el thumbnail en `/feedback`; abrir el lightbox desde
      `FeedbackCardDetail.tsx` y ver la imagen completa; reintentar una URL
      prefirmada de subida ya usada/expirada (más de 5 minutos) y confirmar
      que R2 la rechaza; simular R2 mal configurado (revertir
      temporalmente un secret o probar antes de 6.4) y confirmar que el
      envío de un reporte sin captura sigue dando 201.
      *Aceptación*: Success Criteria del proposal (captura exitosa visible
      en el tablero, R2 mal configurado no rompe el envío, URL expirada
      rechazada, aviso WebGL correcto) con evidencia real citada en el
      cierre.
- [ ] 6.6 **(USUARIO) QA visual.** En desktop y en una vista táctil si hay
      dispositivo a mano: (a) el spinner/estado de "capturando" (si lo
      hay) no es intrusivo ni tapa el formulario; (b) el aviso WebGL es
      legible y no se confunde con un error bloqueante; (c) el thumbnail en
      la tarjeta no rompe el layout de tarjetas sin captura contiguas en el
      mismo tablero; (d) el lightbox es usable con teclado (Tab/Escape) y
      no atrapa el foco de forma permanente.
      *Aceptación*: sin hallazgos bloqueantes, o hallazgos registrados como
      seguimiento fuera de este change.
- [ ] 6.7 Cierre.
      *Qué*: repasar los siete Success Criteria del proposal uno por uno
      citando la evidencia (2.9/2.10 para "no bloquea el envío"; 2.8 y 4.1
      para captura exitosa visible en el tablero; 3.5 para el aviso WebGL;
      2.12-M4 para la expiración de 5 minutos; 1.2/6.1/6.3 para la
      migración auto-aplicada y no-op; 6.4/6.5 para rollout real); cerrar
      `mutation-log.md` con fecha y conteo total de mutaciones (14: M1–M14);
      dejar el change listo para `sdd-verify`/archive.
      *Mutación*: no aplica.
