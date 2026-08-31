# Registro de verificación por mutación

Este archivo es **criterio de aceptación** del change `watchdog-servicios-railway`,
no documentación opcional.

## Por qué existe

Este repo produjo **tres tests verdes que no podían fallar nunca** en changes
anteriores (variable equivocada, mock que fabrica símbolos, esperado igual al
fallback — ver `openspec/changes/archive/2026-08-28-analiticas-profesionales-senal/mutation-log.md`).
En este change el riesgo es peor: un test de `check_seedlink` o
`_heartbeat_loop` que no puede fallar de verdad deja pasar exactamente el tipo
de "falso vivo" que el watchdog existe para detectar, o — peor — deja que un
heartbeat roto tumbe la ingesta real de eventos sísmicos (el ingestor que
"salía con exit 0", ya vivido una vez en este proyecto).

Un test que no puede ponerse rojo no prueba nada, y la única forma de saber si
puede es romperlo a propósito.

## Protocolo — sin atajos

1. Aplicar la mutación.
2. **Confirmar con `rg` que el archivo cambió.** Este repo ya tuvo un `sd`
   multilínea que falló en silencio: no cambió nada y el verde se leyó como si
   probara algo. **Una mutación que no muta no prueba nada.**
3. Correr el test.
4. Registrar la fila acá: qué se rompió, la salida del `rg`, qué test se puso rojo.
5. Revertir y confirmar que vuelve a verde.

**Una mutación sin la salida del `rg` registrada NO cuenta como verificada.**

## Baseline registrada

Corrida el 2026-08-30, ANTES de tocar cualquier archivo de este change.

**Resultado exacto**: `9 failed, 658 passed, 2 skipped, 8 warnings, 330 errors in 53.13s`

**Causa raíz de los 330 errors (verificada, no asumida)**: Docker no está
disponible en este entorno de ejecución en el momento de la corrida. Se
confirmó con el traceback real de un test representativo
(`tests/unit/test_user_management.py::test_deactivate_sets_timestamp_and_leaves_the_rest_of_the_row_intact`):

```
requests.exceptions.HTTPError: 503 Server Error: Service Unavailable for url: http+docker://localhost/version
```

Esto coincide con la trampa ya documentada en la memoria del proyecto ("Tests
de integración usan testcontainer — lo que los rompe es Docker caído"): los
330 `errors` son tests que dependen de un testcontainer (Postgres/Redis) y
fallan en el `setup` del fixture, no en una aserción — no son regresiones de
código. Se intentó levantar Docker Desktop (`open -a Docker`) y esperar su
arranque (~4 minutos de espera efectiva entre varios intentos), pero
`docker info` seguía sin responder (quedó colgado, no devolvió ni 200 ni 503)
al momento de cerrar esta tarea — no se pudo confirmar Docker arriba dentro
del tiempo disponible para la Fase 0/1.

**Por qué esto no bloquea la Fase 0/1**: las tareas 1.1-1.4 de esta fase
(settings + test de defaults) son puramente `tests/unit/`, no dependen de
Postgres ni Redis ni de ningún testcontainer — se verifican de forma aislada
en la sección "Verificación de las tareas 1.1-1.4" más abajo, ejecutando el
archivo de test específico, no la suite completa.

**Los 9 `failed` (no `error`) son independientes de Docker** y preexistentes a
este change — no se investigaron en detalle porque no son responsabilidad de
esta fase (no se tocó ningún archivo relacionado); quedan para que quien siga
con las Fases 2+ los tenga presentes como preexistentes y no los confunda con
una regresión introducida por el watchdog.

| Suite | Comando | Resultado |
|---|---|---|
| Backend (baseline completa, Docker caído) | `./venv/bin/python -m pytest tests/ -q` | `9 failed, 658 passed, 2 skipped, 8 warnings, 330 errors in 53.13s` |

## Registro

| # | Archivo | Mutación | Salida del `rg` | Test que se puso rojo | Revertido |
|---|---|---|---|---|---|
| 1 | `src/services/watchdog.py` | `check_api`: `if response.status_code != 200` → `if response.status_code == 200` | `rg -n "status_code" src/services/watchdog.py` mostró línea 71 con `==` (check_api) y línea 93 intacta con `!=` (check_ui) | `test_check_api_up_en_200`, `test_check_api_down_en_500`, `test_check_ui_independiente_de_check_api` (3 failed, 2 passed, 9 deselected) | Sí — `pytest tests/unit/test_watchdog_checks.py -q` volvió a `14 passed` |
| 2 | `src/services/watchdog.py` | `check_ui`: `if response.status_code != 200` → `if response.status_code == 200` | `rg -n "status_code" src/services/watchdog.py` mostró línea 93 con `==` (check_ui) y línea 71 intacta con `!=` (check_api) | `test_check_ui_up_en_200` (1 failed, 2 passed, 11 deselected) | Sí — `pytest tests/unit/test_watchdog_checks.py -q` volvió a `14 passed` |
| 3 | `src/services/watchdog.py` | `check_seedlink`: condición "todos mudos" (`if not (expected & active_channels)`) → "algún mudo" (`if muted`) | `rg -n "if muted:\|if not \(expected" src/services/watchdog.py` mostró `if muted:` en la línea 126 (antes `if not (expected & active_channels):`) | `test_check_seedlink_un_canal_mudo_otros_activos_marca_up` — específicamente ese, y SOLO ese (1 failed, 3 passed, 10 deselected), confirmando que el test distingue las dos fórmulas | Sí — `pytest tests/unit/test_watchdog_checks.py -q` volvió a `14 passed` |
| 4 | `src/services/watchdog.py` | `check_events`: `if raw is None` → `if raw is not None` (invierte "key ausente marca down") | `rg -n "if raw is" src/services/watchdog.py` mostró `if raw is not None:` en la línea 165 | `test_check_events_heartbeat_ausente_marca_down` (ahora explota con `TypeError: fromisoformat: argument must be str` al intentar parsear `None`) y `test_check_events_heartbeat_reciente_marca_up` (2 failed, 1 passed, 11 deselected) | Sí — `pytest tests/unit/test_watchdog_checks.py -q` volvió a `14 passed` |
| 5 | `src/services/watchdog.py` | `WatchdogStateStore.get_state`: se quitó el `try/except` que envuelve `self._client.get(...)` (queda solo `raw = await self._client.get(...)`, sin degradar a `None` ante un fallo de Redis) | `rg -n "async def get_state" -A5 src/services/watchdog.py` mostró el cuerpo reducido a 2 líneas (`raw = await self._client.get(...)` + `return json.loads(...)`), sin `try:`/`except Exception:`/`logger.warning` | `test_get_state_degradado_si_redis_falla` — específicamente ese, y SOLO ese (1 failed, 3 passed), confirmando que el `ConnectionError` del stub propaga en vez de degradarse a `None` | Sí — `pytest tests/unit/test_watchdog_state_store.py -q` volvió a `4 passed` |
| 6 | `src/services/watchdog.py` | `evaluate_and_notify`: se quitó la comparación de transición `if previous_status == current_status: return` (queda notificando en TODOS los ciclos, no solo en la transición) | `rg -n "previous_status" src/services/watchdog.py` no devolvió ninguna coincidencia (la línea de comparación y la variable desaparecieron por completo del archivo) | `test_caida_sostenida_no_repite_notificacion` y `test_recuperacion_sin_caida_previa_no_notifica` — exactamente los dos previstos por tasks.md 3.6, más `test_ciclo_completo_caida_y_recuperacion_contra_store_real` (test propio, mismo mecanismo); los otros 4 tests (que sí esperan notificación en su escenario) siguieron verdes, confirmando que los tests están bien aislados entre sí (3 failed, 4 passed) | Sí — `pytest tests/unit/test_watchdog_evaluate_and_notify.py -q` volvió a `7 passed` |
| 7 | `src/services/events_ingestor.py` | **CRÍTICO — protege contra el incidente del ingestor con exit 0.** `EventsIngestor._heartbeat_loop`: se quitó el `try/except` interno que envuelve ÚNICAMENTE la escritura `await self._redis_client.set(...)` (quedó la llamada sin protección alguna dentro del `while True`, dejando que cualquier excepción de Redis propague fuera del loop) | `rg -n "try:\|except" src/services/events_ingestor.py` mostró la ausencia de `try:`/`except` en el bloque de `_heartbeat_loop` (líneas ~159-168), reemplazado por un comentario `# MUTACIÓN CRÍTICA TEMPORAL` y la llamada a `.set(...)` sin envolver; el resto del archivo (el `try/except BaseException` de `run()`, línea ~188) permaneció intacto | `test_heartbeat_con_excepcion_en_redis_no_tumba_el_gather` se puso ROJO: `AssertionError: El gather() terminó solo...` — el stub de Redis lanzó `ConnectionError` en la primera llamada de `set()`, la excepción propagó fuera de `_heartbeat_loop()`, canceló las corrutinas `ForeverRunning` de EMSC/USGS dentro del mismo `asyncio.gather()`, y el `_GatheringFuture` terminó con `exception=ConnectionError('Redis caído (simulado)')` — exactamente el modo de falla que este test existe para bloquear (1 failed, 4 passed, los otros 4 tests del archivo permanecieron verdes, confirmando aislamiento) | Sí — `pytest tests/unit/test_events_ingestor_heartbeat.py -q` volvió a `5 passed`, confirmado con `rg -n "try:\|except" src/services/events_ingestor.py` mostrando el `try/except` restaurado en su lugar original |
| 8 | `src/services/watchdog.py` | **Mutación de aislamiento entre chequeos del loop, no marcada con número explícito en tasks.md pero exigida por el prompt de la Fase 5 ("mejor sobrar rigor que faltar").** `run_watchdog_loop`: se quitó el `try/except Exception` individual que envuelve el bloque de `check_seedlink` + su `evaluate_and_notify` dentro del ciclo (quedaron las dos líneas `seedlink_result = await check_seedlink(...)` / `await evaluate_and_notify("seedlink", ...)` sin protección, dejando que una excepción no anticipada de ese chequeo propague fuera del `while` en vez de quedar aislada a ese chequeo) | `rg -n "try:\|except" src/services/watchdog.py` mostró la ausencia del par `try:`/`except Exception:` alrededor del bloque de `check_seedlink` (antes en las líneas ~411-421), reemplazado por un comentario `# MUTACIÓN CRÍTICA TEMPORAL (verificación de aislamiento...)` y las dos llamadas sin envolver; los bloques de `check_api`, `check_ui` y `check_events` permanecieron intactos con su `try/except` propio | `test_run_watchdog_loop_excepcion_en_un_chequeo_no_aborta_el_ciclo` se puso ROJO: el `ConnectionError` simulado por el stub de `check_seedlink` propagó sin capturar, atravesó el `while` y terminó abortando la corrutina completa dentro del `asyncio.wait_for(..., timeout=5.0)` del test, en vez de quedar contenido y permitir que `api`/`ui`/`events` llegaran igual a `evaluate_and_notify` en el mismo ciclo — exactamente el modo de falla que este test existe para bloquear (1 failed, 2 passed: `test_run_watchdog_loop_corre_los_4_chequeos_y_para_con_stop_event` y `test_main_no_arranca_el_loop_si_watchdog_enabled_es_false` permanecieron verdes, confirmando que la mutación no contaminó tests que no dependen de ese bloque) | Sí — `pytest tests/unit/test_watchdog_loop.py -q` volvió a `3 passed`, confirmado con `rg -n "try:\|except" src/services/watchdog.py` mostrando el `try/except` restaurado en su lugar original alrededor del bloque de `check_seedlink` |
| 9 | `src/services/watchdog.py` | **Bugfix post-deploy, no una mutación planificada en tasks.md — verificación retroactiva de un fix real de producción.** `_notify_ntfy`: se revirtió `"Title": title.encode("utf-8")` → `"Title": title` (el bug original visto en Railway el 2026-08-31: httpx exige headers ASCII puro por defecto y `title`/`label` pueden traer tildes, ej. "sísmicos", "CAÍDO") | `rg -n '"Title": title,'` mostró la línea 301 con el `str` sin codificar (fix revertido) | `test_notify_ntfy_arma_el_payload_correcto_por_componente_caida` — los 4 casos parametrizados (api/ui/seedlink/events), todos con `UnicodeEncodeError: 'ascii' codec can't encode character '\xcd'` — el mismo error visto en el traceback real de producción (4 failed, 4 passed: los 4 casos de "recuperación", que no llevan tilde en su título, siguieron verdes) — confirma que `post_mock` (que ahora construye un `httpx.Request` real dentro de `_fake_post` para forzar la validación de headers) sí atrapa el bug; el mock original solo capturaba el `dict` de kwargs sin pasar por `normalize_header_value`, por eso nunca lo detectó antes del deploy | Sí — `pytest tests/unit/test_watchdog_evaluate_and_notify.py -q` volvió a `16 passed`, confirmado con `rg -n '"Title": title.encode'` mostrando el fix restaurado |
| 10 | `src/services/watchdog.py` | **Bugfix post-deploy, no una mutación planificada en tasks.md — verificación retroactiva de un fix real de producción.** `evaluate_and_notify`, rama `if previous is None`: se movió `await store.set_state(...)` del `else` (solo cuando `current_status == "up"`) a únicamente esa rama, dejando la rama `down` sin persistir estado (bug original visto en producción el 2026-08-31: seedlink cayó como PRIMER chequeo de su historia — 74/74 canales mudos, coincidiendo con una reconexión normal de `seedlink_ingestor` — notificó `down` pero nunca persistió el `since`; el siguiente ciclo volvió a ver `previous is None`, repitió la notificación `down` idéntica en vez de detectar la recuperación, confirmado por el usuario recibiendo la misma alerta dos veces) | `rg -n "if current_status == .down.:" -A 3 src/services/watchdog.py` mostró el `set_state` movido al `else`, fuera de la rama `down` | `test_primera_caida_de_la_historia_persiste_estado_para_poder_recuperar` (nuevo, agregado junto con este fix) — específicamente ese, único test que ejercita "primer chequeo de la vida de un componente ya viene down" (1 failed, 16 passed) — ningún test previo de la Fase 3 cubría este escenario: `test_ciclo_completo_caida_y_recuperacion_contra_store_real` arranca su ciclo con un `up` inicial, nunca con un `down` inicial | Sí — `pytest tests/unit/test_watchdog_evaluate_and_notify.py -q` volvió a `17 passed`, confirmado con `rg` mostrando el `set_state` restaurado antes del `if current_status == "down"` |

## Cierre (Fase 7, tarea 7.3)

**Fecha**: 2026-08-30.

**Conteo total: 8 mutaciones verificadas**, las 8 previstas por el plan
original de este change (check_api, check_ui, check_seedlink, check_events,
`WatchdogStateStore.get_state`, `evaluate_and_notify`, la crítica de
`EventsIngestor._heartbeat_loop`, y la de aislamiento entre chequeos de
`run_watchdog_loop`), todas con su salida de `rg` confirmando el cambio real
en el archivo, el/los test(s) que se pusieron rojos, y confirmación de
revertido con la suite vuelta a verde. Ninguna quedó pendiente.

La mutación #7 (`_heartbeat_loop`) es la más importante de todo el change:
protege contra repetir el incidente "el ingestor salía con exit 0" — confirmó
que, sin el `try/except` interno, una excepción de Redis al escribir el
heartbeat cancela las corrutinas de EMSC/USGS dentro del mismo `gather()`.</content>
