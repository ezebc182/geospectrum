# Mutation log — feedback-beta-testers

## Baseline (tarea 1.1) — 2026-09-03 12:04 UTC, rama `feat/feedback-kanban-beta` recién creada desde `main` (b5624e7), working tree sin tocar

Comando: `./venv/bin/python -m pytest tests/ -q -p no:cacheprovider --no-cov`

Resultado REAL: **9 failed, 1069 passed, 2 skipped, 8 warnings in 125.57s (0:02:05)**

Fallos preexistentes (NO atribuibles a este change — fallan también corriendo el
archivo solo, con `RuntimeError: Event loop is closed`; es la trampa documentada de
`with TestClient(main.app)` que dispara el lifespan real):

- `tests/unit/test_ws_events.py::TestSnapshot::test_el_snapshot_llega_primero_y_con_su_sobre`
- `tests/unit/test_ws_events.py::TestSnapshot::test_sin_base_manda_un_snapshot_vacio_en_vez_de_cerrar`
- `tests/unit/test_ws_events.py::TestSnapshot::test_un_fallo_del_snapshot_no_tumba_la_conexion`
- `tests/unit/test_ws_events.py::TestStream::test_los_eventos_nuevos_llegan_con_su_propio_sobre`
- `tests/unit/test_ws_events.py::TestStream::test_se_suscribe_al_canal_del_worker`
- `tests/unit/test_ws_events.py::TestEventsRecent::test_devuelve_los_eventos_de_la_tabla`
- `tests/unit/test_ws_events.py::TestEventsRecent::test_sin_base_devuelve_503_y_NO_lista_vacia`
- `tests/unit/test_ws_events.py::TestEventsRecent::test_pasa_los_filtros_al_store`
- `tests/unit/test_ws_events.py::TestEventsRecent::test_rechaza_una_ventana_absurda`

Ningún otro fallo previo. Todo fallo nuevo que aparezca fuera de esa lista sí es de este change.

## Mutaciones críticas (M1–M18 del design)

Mecánica: `sd -s` (modo literal), `rm -rf src/**/__pycache__` entre corridas, `rg` que
confirme que el archivo cambió, test rojo, reversión, verde. Una mutación que no pone rojo
ningún test NO se anota como pasada: se arregla el test.

### Backend M1–M13 (+M10') — tarea 2.9, 2026-09-03 12:25–12:30 UTC

Mecánica REAL usada (dos correcciones sobre la del encabezado, ambas ganadas a fuego):

1. **`sd 1.0.0 -s` NO matchea un literal que contenga `\n`**: sale con exit 0 y deja el
   archivo intacto. Las primeras corridas de M1/M2/M4 dieron "5 passed" con el archivo SIN
   mutar — exactamente la trampa "una mutación que no muta no prueba nada". Se reemplazó la
   sustitución por un `str.replace` exacto en Python que **falla ruidosamente si el patrón
   no está** (`!! LA MUTACION NO APLICO`) e imprime cuántas ocurrencias reemplazó; la
   confirmación es `rg -U -n -F -e "<TO>"` (multilínea + literal). Runner:
   `scratchpad/mutate.sh` (fuera del repo).
2. **La reversión se verifica byte a byte contra un snapshot** (`cmp`) tomado del estado
   verde, no "a ojo". Incidente: la primera versión del runner nombraba el snapshot por
   `basename`, y `src/models/feedback.py` y `src/api/routers/feedback.py` colisionan
   (ambos `feedback.py`): el snapshot del router pisó al del modelo, M8 reportó
   "REVERT FALLÓ" espuriamente y la reversión-por-copia de M9 dejó el CONTENIDO DEL ROUTER
   dentro del modelo. Se detectó por el `cmp`, se restauró el modelo, se re-keyó el
   snapshot por path completo, se re-verificó verde (94 passed) y se repitió M8. Los
   resultados ROJOS de M5–M9 son válidos (los tests corren antes de la reversión).

Purga de `__pycache__` antes y después de cada corrida (trampa del `.pyc` del mismo segundo).
Comando de tests: `./venv/bin/python -m pytest <archivos> -q -p no:cacheprovider --no-cov -p no:logging -k "<expr>"`.

| # | archivo | mutación | salida del rg | test que se puso rojo | revertido |
|---|---------|----------|---------------|-----------------------|-----------|
| M1 | `src/api/routers/feedback.py` | en `set_status`: `Depends(require_min_role(UserRole.ADMIN))` → `Depends(get_current_user)` | `61: current_user: CurrentUser = Depends(get_current_user),` (bajo `payload: FeedbackStatusUpdate,`) | `test_status_matriz_de_roles[viewer-403]` y `[moderador-403]`: `assert 200 == 403` (2 failed, 3 passed) | revertido: sí |
| M2 | `src/api/routers/feedback.py` | ídem en `set_admin_comment` | `74: current_user: CurrentUser = Depends(get_current_user),` (bajo `payload: FeedbackAdminCommentUpdate,`) | `test_comment_matriz_de_roles[viewer-403]` y `[moderador-403]`: `assert 200 == 403` | revertido: sí |
| M3 | `src/api/routers/feedback.py` | `require_min_role(UserRole.ADMIN)` → `require_role(UserRole.ADMIN)` en ambos PUT (+ import) | `61:` y `74: Depends(require_role(UserRole.ADMIN))`, `15: from src.api.deps import get_current_user, require_role` | `test_status_matriz_de_roles[superadmin-200]` y `test_comment_matriz_de_roles[superadmin-200]`: `{"detail":"insufficient role"}` `assert 403 == 200` | revertido: sí |
| M4 | `src/api/routers/feedback.py` | `GET /feedback` con `Depends(require_min_role(UserRole.ADMIN))` | `50: current_user: CurrentUser = Depends(require_min_role(UserRole.ADMIN)),` sobre `) -> dict:` | `test_get_todos_los_roles_leen_200[viewer]`, `[moderador]`, `test_get_viewer_ve_el_tablero_completo_con_autores_y_orden`: `assert 403 == 200` (3 failed) | revertido: sí |
| M5 | `src/services/feedback_service.py` | `status_changed_at = CASE WHEN status <> $2 THEN now() ELSE status_changed_at END` → `status_changed_at = now()` | `92: status_changed_at = now()` | `test_status_repetir_el_mismo_estado_es_no_op_y_no_toca_el_timestamp`: `assert datetime(…12:26:06.999077) == datetime(…12:26:06.950585)` (T1 leído de la base cambió) | revertido: sí |
| M6 | `src/services/feedback_service.py` | `WHEN admin_comment IS DISTINCT FROM $2::text THEN now()` → `WHEN TRUE THEN now()` | `121: WHEN TRUE THEN now()` | `test_comment_repetir_el_mismo_texto_no_toca_el_timestamp`: `assert datetime(…12:26:16.867540) == datetime(…12:26:16.721004)` | revertido: sí |
| M7 | `src/services/feedback_service.py` | eliminada la rama `WHEN $2::text IS NULL THEN NULL` | ocurrencias de la rama tras mutar: 0 | `test_comment_vaciar_pone_ambas_columnas_en_null[null|vacio|solo-espacios]`: `asyncpg.exceptions.CheckViolationError: … violates check constraint "feedback_reports_comment_pair"` (500 en vez de 200 — el CHECK de par también lo atrapa, como anticipó el design) | revertido: sí (por copia del snapshot: un TO vacío no es reversible por replace) |
| M8 | `src/models/feedback.py` | `FeedbackStatus = Literal[…5 valores…]` → `FeedbackStatus = str` | `25: FeedbackStatus = str` | unit `test_status_update_rechaza_valores_fuera_del_enum[resolved|Hecho]`: `DID NOT RAISE ValidationError`; integración `test_status_fuera_del_enum_da_422_y_fila_intacta[resolved|etiqueta-castellano]`: `CheckViolationError … "feedback_reports_status_check"` (fila con `resolved` rechazada por la base, 500 en vez de 422) | revertido: sí (segunda corrida, snapshot re-keyado) |
| M9 | `src/models/feedback.py` | eliminado el `field_validator` `_empty_is_none` completo | ocurrencias del bloque tras mutar: 0 | unit `test_comment_update_normaliza_vacio_a_none[vacio|solo-espacios]`: `assert '' is None` / `assert '   ' is None`; integración `test_comment_vaciar_pone_ambas_columnas_en_null[vacio|solo-espacios]`: `CheckViolationError` (admin_comment `''` viola `BETWEEN 1 AND 2000`) | revertido: sí (por copia del snapshot) |
| M10 | `src/models/feedback.py` | (a) `route … max_length=300` → `301`; (b) `url … max_length=2000` → `2001`; (c) `user_agent … max_length=400` → `401` — tres corridas separadas | `34: route: … max_length=301)` / `35: url: … max_length=2001)` / `36: user_agent: str = Field(max_length=401)` | (a) unit `test_create_rechaza_contexto_sobredimensionado[route-301]` `DID NOT RAISE` + integración `test_post_payload_invalido_da_422_sin_fila[route-301]` `CheckViolationError "feedback_reports_route_check"`; (b) ídem `[url-2001]` con `"feedback_reports_url_check"`; (c) ídem `[user-agent-401]` con `"feedback_reports_user_agent_check"` — 2 failed en cada corrida | revertido: sí (×3) |
| M10' | `src/models/feedback.py` | `user_agent: str = Field(max_length=400)` → `Field(default="", max_length=400)` | `36: user_agent: str = Field(default="", max_length=400)` | unit `test_create_rechaza_contexto_ausente[user_agent]`: `DID NOT RAISE`; integración `test_post_contexto_ausente_da_422_sin_fila[user_agent]`: `assert 201 == 422` (la fila SE CREÓ con UA vacío) | revertido: sí |
| M11 | `src/models/feedback.py` | `body … max_length=2000` → `2001` | `33: body: str = Field(min_length=1, max_length=2001)` | unit `test_create_rechaza_body_invalido[2001]`: `DID NOT RAISE`; integración `test_post_payload_invalido_da_422_sin_fila[body-2001]`: `CheckViolationError "feedback_reports_body_check"` | revertido: sí |
| M12 | `src/models/feedback.py` + `src/services/feedback_service.py` | campo `status: str = "new"` agregado a `FeedbackReportCreate` + INSERT con columna `status` y `$7 = payload.status` | `33: status: str = "new"`; `57: INSERT INTO feedback_reports (…, user_agent, status)` `58: VALUES ($1, …, $6, $7)` | unit `test_create_no_expone_user_id_created_at_ni_status`: `AssertionError: status` (hasattr); integración `test_post_status_inyectado_en_el_body_se_ignora` (test AGREGADO en 2.9 para que la mutación sea observable por SELECT): `assert 'done' == 'new'` | revertido: sí (ambos archivos) |
| M13 | `src/models/feedback.py` + `src/api/routers/feedback.py` | campo `user_id: Optional[UUID] = None` en `FeedbackReportCreate` + `create(payload.user_id, payload)` | `33: user_id: Optional[UUID] = None`; `44: row = await feedback_service.create(payload.user_id, payload)` | unit `test_create_no_expone_…`: `AssertionError: user_id`; integración `test_post_user_id_inyectado_en_el_body_se_ignora`: `assert UUID('67ec85ea…') == UUID('601f9736…')` (la fila quedó con el user_id de B); `test_post_viewer_crea_y_recibe_ack_minimo`: `NotNullViolationError` en `user_id` | revertido: sí (ambos archivos) |
| M14 | `dashboard/components/feedback/FeedbackWidget.tsx` | (a) `route: pathname.slice(0, MAX_ROUTE),` → `route: pathname,`; (b) `url: window.location.href.slice(0, MAX_URL),` → `url: window.location.href,`; (c) `user_agent: navigator.userAgent.slice(0, MAX_USER_AGENT),` → `user_agent: navigator.userAgent,` — tres corridas separadas | `106: route: pathname,` / `107: url: window.location.href,` / `108: user_agent: navigator.userAgent,` | `trunca route a 300, url a 2000 y user_agent a 400 exactos; el body viaja completo`: (a) `expected '/rrr…' to have a length of 300 but got 301`; (b) `expected 'http://localhost:3000/x?q=uuu…' to have a length of 2000 but got 2126`; (c) `expected 'aaa…' to have a length of 400 but got 401` — 1 failed / 12 passed en cada corrida | revertido: sí (×3, `cmp` idéntico al snapshot) |
| M15 | `dashboard/components/feedback/FeedbackWidget.tsx` | `if (isBlank \|\| isTooLong) return;` → `if (isBlank) return;` **y** `body,` → `body: body.slice(0, MAX_BODY),` en el payload (las dos a la vez: el guard solo no alcanza para que un slice sea observable) | `95: if (isBlank) return;` y `105: body: body.slice(0, MAX_BODY),` | `un body de 2001 NO llega a submitFeedback y NO se recorta`: `expected "spy" to not be called at all, but actually been called 1 times` — 1 failed / 12 passed | revertido: sí (ambas sustituciones, `cmp` idéntico) |
| M16 | | | | | |
| M17 | | | | | |
| M18 | | | | | |

Fase 1 no lleva mutaciones (1.3 y 1.4 son SQL declarativo verificado por ejecución real
doble y por `CHECK` probados con SQL directo; ver justificación en `tasks.md`).

### Gate de Fase 2 (tarea 2.10) — 2026-09-03 12:36 UTC

Suite completa (`./venv/bin/python -m pytest tests/ -q -p no:cacheprovider --no-cov`):
**9 failed, 1181 passed, 2 skipped** — los 9 fallos son los mismos 9 de `test_ws_events.py`
de la baseline; 1181 = 1069 (baseline) + 18 (Fase 1) + 94 (Fase 2: 33 unit + 61 API). Cero
regresiones. Ojo: `-p no:logging` deshabilita `caplog` y hace ERROR a
`test_events_ingestor_heartbeat.py::…::test_sin_redis_client…` — es el flag, no el código
(5/5 con los flags de la baseline).

### Baseline frontend (tarea 3.1) — 2026-09-03 12:50 UTC, antes de tocar `dashboard/`

`node -v` ⇒ v22.16.0 (PATH de nvm exportado); `node_modules/` presente (`npm ci` previo).

- `./node_modules/.bin/vitest run` ⇒ **Test Files 95 passed (95), Tests 1026 passed (1026)** en 46,82 s. Cero fallos preexistentes.
- `./node_modules/.bin/tsc --noEmit` ⇒ exit **0**, sin salida.

### Widget M14–M15 — tarea 3.8, 2026-09-03 12:59 UTC

Runner: `scratchpad/mutate-ts.sh` (fuera del repo), misma mecánica del backend adaptada a
vitest: `str.replace` exacto que falla si el patrón no está, snapshot previo, `git diff --stat`
ANTES de los tests, `rg -U -F` del texto mutado, vitest, reversión por replace inverso y `cmp`
contra el snapshot. Ojo: `FeedbackWidget.tsx` es un archivo NUEVO, así que `git diff --stat`
solo muestra "227 insertions" (con `git add -N`) antes y después — no distingue la mutación;
la prueba de que el archivo cambió es el `rg` del texto mutado, y la de la reversión es el
`cmp`. Las cuatro corridas (M14a/b/c, M15) pusieron rojo EXACTAMENTE el test previsto y
ningún otro.

### Gate de Fase 3 (tarea 3.8) — 2026-09-03 13:00 UTC

- `vitest run lib/feedback.test.ts components/feedback/FeedbackWidget.test.tsx messages/parity.test.ts` ⇒ **3 files, 33 passed** (16 + 13 + 4).
- `tsc --noEmit` ⇒ exit **0**.
- Suite completa del dashboard ⇒ **Test Files 97 passed (97), Tests 1055 passed (1055)** = 1026 (baseline) + 16 (helper) + 13 (widget). Cero regresiones; los tests nuevos no emiten stderr.

### Desvíos del design registrados en Fase 2

- **`$2::text` en el SQL del comentario** (`set_admin_comment`): asyncpg falló con
  `AmbiguousParameterError: could not determine data type of parameter $2` porque la primera
  aparición de `$2` es `WHEN $2 IS NULL` (sin tipo inferible). El cast explícito es la única
  diferencia con el SQL "exacto" del design; la semántica (borrar ⇒ par en NULL, mismo texto ⇒
  timestamp intacto) es la misma y la protegen M6 y M7.
- **Tests endurecidos durante 2.8/2.9** (no son cambios de comportamiento):
  `test_status_uuid_inexistente_da_404` y `test_comment_uuid_inexistente_da_404` afirman
  `detail != "Not Found"` — sin eso pasaban CON EL ROUTER AUSENTE (el 404 era el de FastAPI).
  Se agregó `test_post_status_inyectado_en_el_body_se_ignora` para que M12 sea observable por
  SELECT y no solo por `hasattr` en el unit test.
- Los tests de integración van en `tests/integration/test_feedback_api.py` con
  `TestClient(app)` SIN `with` (no dispara el lifespan; la suite completa no suma ningún
  "Event loop is closed" nuevo).
