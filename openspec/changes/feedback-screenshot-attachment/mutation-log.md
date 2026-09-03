# Mutation log: feedback-screenshot-attachment

## Baseline (2026-09-03, ANTES de tocar cualquier archivo)

Comando: `./venv/bin/python -m pytest tests/ -q -p no:cacheprovider --no-cov`

Resultado real de HOY (rama `feat/feedback-screenshot-attachment`, recién
creada desde `main` en `3456b04`):

```
9 failed, 1181 passed, 2 skipped, 8 warnings in 121.33s (0:02:01)
```

**No usar el `1181 passed` de `feedback-beta-testers` como referencia** —
que hoy coincida con ese número es casualidad de esta corrida, no una
suposición: se corrió fresco, en esta rama, después del merge de
`feedback-beta-testers` (#46) y del commit `3456b04`.

### Fallos preexistentes (NO atribuibles a este change)

Los 9 fallos están confinados a `tests/unit/test_ws_events.py`, sin relación
con `feedback` ni con este change:

- `TestSnapshot::test_el_snapshot_llega_primero_y_con_su_sobre`
- `TestSnapshot::test_sin_base_manda_un_snapshot_vacio_en_vez_de_cerrar`
- `TestSnapshot::test_un_fallo_del_snapshot_no_tumba_la_conexion`
- `TestStream::test_los_eventos_nuevos_llegan_con_su_propio_sobre`
- `TestStream::test_se_suscribe_al_canal_del_worker`
- `TestEventsRecent::test_devuelve_los_eventos_de_la_tabla`
- `TestEventsRecent::test_sin_base_devuelve_503_y_NO_lista_vacia`
- `TestEventsRecent::test_pasa_los_filtros_al_store`
- `TestEventsRecent::test_rechaza_una_ventana_absurda`

Inspeccionado uno (`TestSnapshot::test_el_snapshot_llega_primero_y_con_su_sobre`)
en corrida aislada: mismo resultado, con un `RuntimeError: Event loop is
closed` en el teardown de una conexión Redis async (`redis.asyncio`) — pinta
a un problema de entorno/fixture de ese suite (Redis no disponible o
teardown desordenado), no a una regresión de código de producto. Cualquier
fallo futuro en `tests/unit/test_ws_events.py` durante este change NO cuenta
como regresión propia — ya estaba roto en la baseline.

### Fallos que SÍ importan a este change

Ninguno de los 9 toca `feedback`, `screenshot_key`, migraciones, o
`src/services/feedback_service.py` / `src/models/feedback.py` /
`src/api/routers/feedback.py`. Baseline limpia para el propósito de este
change: cualquier fallo nuevo en `tests/integration/test_feedback_*` o
`tests/unit/test_feedback_*` / `tests/unit/test_screenshot_storage.py` es
atribuible a este change.

## Tabla de mutaciones

| # | Archivo | Mutación | Salida de `rg` (confirma el cambio) | Test que se puso rojo | Revertido |
|---|---|---|---|---|---|
| M1 | `src/api/routers/feedback.py` | quitar `Depends(get_current_user)` de `create_upload_url` | `56:async def create_upload_url(\n57:    storage: ScreenshotStorageService = ...` (sin `current_user`) | `test_upload_url_sin_sesion_da_401`: `201 == 401` (esperaba 401, dio 201) | revertido: sí |
| M2 | `src/api/routers/feedback.py` | quitar `if not storage.enabled: raise HTTPException(503, ...)` | bloque ausente, `create_upload_url()` se llama directo tras el docstring | `test_upload_url_r2_sin_configurar_da_503`: `AttributeError: 'NoneType' object has no attribute 'generate_presigned_url'` (500, no 503) | revertido: sí |
| M3 | `src/models/feedback.py` | `_SCREENSHOT_KEY_PATTERN = re.compile(r".*")` (vacía el regex real) | `32:_SCREENSHOT_KEY_PATTERN = re.compile(r".*")` | `test_create_con_key_invalida_422_cero_filas` (3 casos: path-traversal, bucket-ajeno, uuid-invalido) — los 3 pasaron a 201 en vez de 422 | revertido: sí |
| M4 | `src/services/screenshot_storage.py` | `ExpiresIn=300` → `expires_in: int = 999999` en `create_upload_url` | `56:    def create_upload_url(self, *, expires_in: int = 999999)` | `test_upload_url_firma_con_expires_in_300`: `X-Amz-Expires` en la URL firmada pasó a `999999`, no `300` | revertido: sí |
| M5 | `src/api/routers/feedback.py` | `create_report` (POST /feedback) chequea `storage.enabled` antes de insertar | `47-48: feedback_service = Depends(...)\n    storage: ScreenshotStorageService = Depends(...)` + `if not storage.enabled: raise 503` en el handler | `test_create_sin_screenshot_key_sigue_201_con_r2_deshabilitado`: `503 == 201` (esperaba 201, dio 503) | revertido: sí |
| M6 | `src/api/routers/feedback.py` | quitar `if screenshot_key is None: raise HTTPException(404, ...)` en `get_screenshot_url` | bloque ausente, `storage.create_download_url(screenshot_key)` se llama directo con `screenshot_key=None` | `test_screenshot_url_reporte_sin_key_da_404`: excepción al intentar firmar con key `None` (no 404 limpio) | revertido: sí |
| M7 | `src/services/feedback_service.py` | `_ITEM_COLUMNS`: `r.screenshot_key` → `NULL AS screenshot_key` (SELECT literal, no la columna real) | `25:    NULL AS screenshot_key, u.email AS author_email` | **Gap detectado**: la mutación NO rompió ningún test existente (79 tests, todos verdes) — ningún test afirmaba el VALOR de `screenshot_key` en `GET /feedback`/`PUT status`/`PUT comment`, solo su presencia como clave. Se agregaron 3 tests nuevos (`test_get_list_expone_el_valor_real_de_screenshot_key`, `test_put_status_expone_el_valor_real_de_screenshot_key`, `test_put_comment_expone_el_valor_real_de_screenshot_key`) que siembran un reporte CON key y afirman el valor exacto en la respuesta; confirmados rojo (`screenshot_key` llegaba `None` en vez del UUID sembrado) con la mutación activa | revertido: sí |
| M8 | `dashboard/lib/screenshot.ts` | pendiente (Fase 3) | — | — | — |
| M9 | `dashboard/lib/screenshot.ts` | pendiente (Fase 3) | — | — | — |
| M10 | `dashboard/lib/screenshot.ts` | pendiente (Fase 3) | — | — | — |
| M11 | `dashboard/components/feedback/FeedbackWidget.tsx` | pendiente (Fase 3) | — | — | — |
| M12 | `dashboard/components/feedback/FeedbackWidget.tsx` | pendiente (Fase 3) | — | — | — |
| M13 | `dashboard/components/feedback/FeedbackCard.tsx` | pendiente (Fase 4) | — | — | — |
| M14 | `dashboard/components/feedback/FeedbackCardDetail.tsx` | pendiente (Fase 4) | — | — | — |

Mecánica (idéntica a `feedback-beta-testers`): `sd -s` en modo LITERAL (sin
`-s` los paréntesis se leen como regex y la mutación no muta), `rm -rf
**/__pycache__` entre corridas (mismo segundo sirve el `.pyc` viejo), `rg`
que confirma el cambio ANTES de correr el test mutado, test rojo con la
aserción exacta, reversión verificada por `cmp` contra un snapshot tomado
antes de mutar, verde posterior. Si una mutación no pone rojo ningún test,
se arregla el test — nunca se anota como "pasada".

## Fase 1 — Migración 020 (CERRADA, 2026-09-03)

- **1.2 (RED)**: `tests/integration/test_feedback_screenshot_migration.py`
  creado; `4 failed in 3.54s`, los cuatro por
  `psycopg2.errors.UndefinedColumn: column "screenshot_key" of relation
  "feedback_reports" does not exist` — razón correcta, no error de setup.
- **1.3 (GREEN)**: `deploy/sql/migrations/020_feedback_screenshot.sql`
  creado (`ALTER TABLE feedback_reports ADD COLUMN IF NOT EXISTS
  screenshot_key TEXT NULL;`). Suite del archivo: `4 passed in 3.25s`,
  incluyendo la segunda ejecución REAL de `apply_migrations` (no-op,
  `screenshot_key` sobrevive intacta).
- **Mutación 020**: NO aplica (declarado en tasks.md 1.3) — se verifica por
  ejecución real doble del aplicador (mismo criterio que 019); mutar `ADD
  COLUMN IF NOT EXISTS` no agrega información que el escenario (d) de 1.2 no
  dé ya.
- **1.4 (gate)**: `ruff format` reformateó el archivo de test (1 file
  reformatted); `ruff check` limpio; `rm -rf
  tests/integration/__pycache__` + rerun ⇒ `4 passed in 4.55s` (sin .pyc
  viejo sirviéndose).

Estado al cerrar: baseline registrada; `feedback_reports` tiene la columna
`screenshot_key` en la base del testcontainer; idempotencia probada por
doble ejecución real del aplicador. Listo para Fase 2.

## Fase 2 — Backend: modelos, ScreenshotStorageService, router (CERRADA, 2026-09-03)

- **2.1**: `boto3==1.43.88` (+ `botocore`, `jmespath`, `s3transfer`)
  instalado en el venv y pineado en `requirements.txt`.
- **2.2 (RED) → 2.3 (GREEN)**: `tests/unit/test_screenshot_storage.py` (8
  tests) creado antes de `src/services/screenshot_storage.py`; rojo por
  módulo inexistente, verde tras crear el servicio: `8 passed in 0.88s`.
- **2.4**: 4 variables `Optional[str] = None` en `src/config/settings.py`
  (`s3_endpoint_url`, `s3_bucket`, `s3_access_key_id`,
  `s3_secret_access_key`).
- **2.5 (RED) → 2.6 (GREEN)**: casos nuevos en
  `tests/unit/test_feedback_models.py` (regex, `ScreenshotUploadUrl`,
  `ScreenshotDownloadUrl`); rojo por `ImportError`, verde tras extender
  `src/models/feedback.py`: `51 passed in 2.07s`.
- **2.7**: `FeedbackService` extendido (`_ITEM_COLUMNS`, `create()`,
  `get_screenshot_key()`); importa sin error.
- **2.8–2.10 (RED) → 2.11 (GREEN)**: `tests/integration/test_feedback_screenshot_api.py`
  (18 tests) creado antes del router; `8 failed, 10 passed` con el router
  ausente (los 4 `upload_url` por 404 genérico; 2 `screenshot_url` se
  fortalecieron con `detail != "Not Found"` porque el 404 genérico de
  FastAPI coincidía "por accidente" con el esperado). Tras crear los dos
  endpoints nuevos y wirear `app.state.screenshot_storage` en `src/main.py`:
  `18 passed in 13.95s`. `tests/integration/test_feedback_api.py` necesitó
  agregar `screenshot_key` a `ITEM_KEYS` (extensión legítima del contrato
  existente, no una regresión): `61 passed`.
- **2.12**: M1–M7 ejecutadas y verificadas (tabla arriba). M7 encontró un
  gap real de cobertura (ver tabla) — corregido antes de registrar la
  mutación.
- **Fix colateral fuera de tasks.md pero atribuible a este change**:
  `tests/integration/test_feedback_migration.py::test_la_tabla_existe_con_las_doce_columnas_del_design`
  rompió en la corrida de suite completa (`EXPECTED_COLUMNS` no incluía
  `screenshot_key` — la migración 020 vive en el mismo directorio que la
  019 y el fixture `_migrated` aplica el glob completo, así que ese test
  ahora ve la columna nueva). Se agregó `screenshot_key` a
  `EXPECTED_COLUMNS` con comentario explicativo; `18 passed` en el archivo
  tras el fix.
- **2.13 (gate de fase)**: `./venv/bin/ruff format` + `./venv/bin/ruff
  check` limpios sobre los 9 archivos tocados/nuevos (`src/services/
  screenshot_storage.py`, `src/models/feedback.py`, `src/api/routers/
  feedback.py`, `src/config/settings.py`, `src/services/feedback_service.py`,
  `tests/unit/test_screenshot_storage.py`, `tests/unit/test_feedback_models.py`,
  `tests/integration/test_feedback_screenshot_api.py`,
  `tests/integration/test_feedback_api.py`,
  `tests/integration/test_feedback_migration.py`) — el único hallazgo de
  `ruff check` (F811 en `src/main.py:2718`, `search_stations` redefinido) es
  PREEXISTENTE en HEAD antes de este change (confirmado con `git stash` +
  `ruff check src/main.py`), no introducido acá.
  Suite del change (`test_screenshot_storage.py` + `test_feedback_models.py`
  + `test_feedback_screenshot_migration.py` + `test_feedback_screenshot_api.py`
  + `test_feedback_api.py`): `145 passed in 27.96s`.
  Suite COMPLETA (`./venv/bin/python -m pytest tests/ -q -p no:cacheprovider
  --no-cov`), tras el fix de `test_feedback_migration.py`:
  ```
  9 failed, 1232 passed, 2 skipped, 8 warnings in 431.83s (0:07:11)
  ```
  Los 9 fallos son EXACTAMENTE los mismos 9 de la baseline de 1.1 (mismos
  nombres, todos en `tests/unit/test_ws_events.py`) — cero regresiones
  nuevas. El delta contra la baseline (1181 passed → 1232 passed) es +51,
  los tests nuevos de esta Fase 2 (8 de `test_screenshot_storage.py` + 4 de
  `test_feedback_screenshot_migration.py`, ya contados en Fase 1, + los
  nuevos de `test_feedback_models.py`, `test_feedback_screenshot_api.py` y
  los 3 agregados a `test_feedback_api.py`/`test_feedback_migration.py` por
  el fix de M7 y el gap de `EXPECTED_COLUMNS`).

Estado al cerrar Fase 2: los tres endpoints existentes exponen
`screenshot_key`; los dos endpoints nuevos responden la matriz de auth
completa; R2 sin configurar degrada a 503 solo en presign sin afectar
create/list/put; 7 mutaciones críticas verificadas con RED real y reversión
byte-limpia. Listo para Fase 3 (frontend).
