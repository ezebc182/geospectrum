# Mutation log: analytics-professional-panels

## Baseline (2026-09-04, ANTES de tocar cualquier archivo)

Rama `feat/analytics-professional-panels`, planificación commiteada en
`2a0461a` (sobre `dfa0b52`, último merge de `feedback-screenshot-attachment`
#47). Corrida fresca de HOY — NO se reutilizan los `1232`/`1129` de
`feedback-screenshot-attachment` como suposición: coinciden porque main no
se movió en tests desde entonces, y se verificó corriendo.

### Backend

Comando: `./venv/bin/python -m pytest tests/ -q -p no:cacheprovider --no-cov`

```
9 failed, 1232 passed, 2 skipped, 8 warnings in 225.38s (0:03:45)
```

### Frontend

Comando: `cd dashboard && ./node_modules/.bin/vitest run` (Node v22.16.0 de nvm)

```
Test Files  102 passed (102)
     Tests  1129 passed (1129)
  Duration  101.85s
```

### Fallos preexistentes (NO atribuibles a este change)

Los 9 fallos del backend están confinados a `tests/unit/test_ws_events.py`,
los mismos 9 que la baseline de `feedback-screenshot-attachment` (2026-09-03):

- `TestSnapshot::test_el_snapshot_llega_primero_y_con_su_sobre`
- `TestSnapshot::test_sin_base_manda_un_snapshot_vacio_en_vez_de_cerrar`
- `TestSnapshot::test_un_fallo_del_snapshot_no_tumba_la_conexion`
- `TestStream::test_los_eventos_nuevos_llegan_con_su_propio_sobre`
- `TestStream::test_se_suscribe_al_canal_del_worker`
- `TestEventsRecent::test_devuelve_los_eventos_de_la_tabla`
- `TestEventsRecent::test_sin_base_devuelve_503_y_NO_lista_vacia`
- `TestEventsRecent::test_pasa_los_filtros_al_store`
- `TestEventsRecent::test_rechaza_una_ventana_absurda`

Causa visible en la salida: `RuntimeError: Event loop is closed` en el
teardown de una conexión Redis async, y `Connect call failed
('127.0.0.1', 5433)` — el suite espera un Postgres/Redis local que en esta
máquina no está levantado (preferencia del usuario: nada corre en local).
Ninguno toca `station_uptime`, `analytics`, `gutenberg_richter`, `tremor`
ni las migraciones. Cualquier fallo futuro en `test_ws_events.py` durante
este change NO cuenta como regresión propia.

### Fallos que SÍ importan a este change

Cualquier fallo nuevo en `tests/integration/test_station_uptime_*`,
`tests/unit/test_station_uptime*`, `tests/unit/test_gutenberg_richter.py`,
`tests/unit/test_tremor.py`, `tests/unit/test_analytics_*`,
`tests/integration/test_analytics_api.py` o en los tests de no-regresión
listados en tasks.md (3.7) es atribuible a este change.

## Tabla de mutaciones

Mecánica (idéntica a `feedback-screenshot-attachment`): snapshot con `cp`
ANTES de mutar; `sd -s` (literal) o `Edit`; `rg` que confirma el cambio
ANTES de correr; `rm -rf` de `__pycache__` entre mutación y reversión; test
ROJO por la razón predicha; reversión por `cmp` byte a byte contra el
snapshot; verde.

| # | Archivo | Mutación | Salida de `rg` (confirma el cambio) | Test que se puso rojo | Revertido |
|---|---|---|---|---|---|
| M5 | `src/services/station_uptime.py` | `ON CONFLICT (channel, bucket_start) DO UPDATE SET columns_count = EXCLUDED.columns_count` → `ON CONFLICT (channel, bucket_start) DO NOTHING` (`sd -s`) | `58:ON CONFLICT (channel, bucket_start) DO NOTHING` | `tests/integration/test_station_uptime_rollup.py::test_la_hora_parcial_se_reescribe_no_se_acumula` — `assert rows == [(CHANNEL, h, 900), (CHANNEL, h1, 550)]` → `AssertionError: ... 450)] == [... 550)]` (1 failed in 4.30s) | `cp` del snapshot + `cmp` ⇒ `CMP_IDENTICAL`; `rm -rf` de `__pycache__`; 16 passed |
| M6 | `src/services/station_uptime.py` | `WHERE endtime >= GREATEST(now() - interval '7 days', COALESCE((SELECT max(bucket_start) …), '-infinity'))` → `WHERE endtime >= now() - interval '2 hours'` (Edit, multilínea) | `53:WHERE endtime >= now() - interval '2 hours'` y `cmp` contra el snapshot ⇒ `ARCHIVO_DIFIERE_DEL_SNAPSHOT` | `tests/integration/test_station_uptime_rollup.py::test_un_hueco_de_cinco_horas_se_rellena_solo` — `assert rows == [(CHANNEL, last_written, 900)] + [(CHANNEL, hour, 10) for hour in gap_hours]` → `AssertionError` en la línea 166 (la lista devuelta es más corta: las horas del hueco anteriores a `now() - 2 h` no tienen fila) (1 failed in 3.95s) | `cp` del snapshot + `cmp` ⇒ `CMP_IDENTICAL`; `rm -rf` de `__pycache__`; 16 passed |

Nota operativa (2026-09-05): `git diff --stat` NO sirve para confirmar una
mutación sobre un archivo NUEVO (untracked) — imprime vacío aunque el
archivo haya cambiado. Para archivos nuevos la confirmación es `rg` de la
línea mutada + `cmp` contra el snapshot (que también es lo que prueba la
reversión).

## Fase 1 — RED observados (2026-09-05)

- 1.2: con `021_station_uptime_hourly.sql` movida fuera del directorio, la
  suite de migración muere en `test_tabla_con_columnas_y_tipos_exactos`
  (`assert rows`, `information_schema.columns` devuelve `[]`; no lanza
  `UndefinedTable` como predecía la task). Restaurada ⇒ 6 passed.
- 1.5/1.6: con `src/services/station_uptime.py` movido fuera del árbol,
  `ModuleNotFoundError: No module named 'src.services.station_uptime'`
  (2 errors during collection). Restaurado ⇒ 10 passed (tras corregir la
  expectativa del caso (b): segunda corrida upsertea `1` fila, no `2`).

## Fase 1 — gate

`./venv/bin/python -m pytest tests/integration/test_station_uptime_migration.py tests/integration/test_station_uptime_rollup.py tests/unit/test_station_uptime_loop.py -q -p no:cacheprovider --no-cov`
⇒ `16 passed in 4.60s`. `ruff check` limpio en los archivos nuevos;
`ruff format --check` limpio. `git diff --stat -- src/services/watchdog.py
src/services/seedlink_ingestor.py src/services/swarm_rsam.py` vacío.
`src/main.py` arrastra un F811 PREEXISTENTE (`search_stations`, línea 2748,
ajeno a este change).

### Suite completa (gate real, 2026-09-05)

`./venv/bin/python -m pytest tests/ -q -p no:cacheprovider --no-cov -rf`

Primera corrida: `11 failed, 1246 passed` — 2 fallos NUEVOS en
`tests/unit/test_live_channels.py` (`test_fetch_active_channels_devuelve_solo_los_frescos`,
`test_fetch_active_channels_no_duplica_canales`) que NO aparecían aislados.
Causa: `test_station_uptime_rollup.py` y `test_live_channels.py` crean
`spectrogram_columns` a mano con `CREATE TABLE IF NOT EXISTS` en el mismo
testcontainer, y el fixture del rollup la creaba SIN `freqs`/`power_db`;
al correr primero (integration < unit), fijaba un esquema que rompía el
INSERT del otro. Fix: el fixture del rollup crea la tabla con el esquema
completo de la real y siembra arrays dummy. Verificado en los DOS órdenes
(15 passed cada uno).

Segunda corrida: `9 failed, 1248 passed, 2 skipped in 104.69s` — los 9 son
los preexistentes; +16 = los tests de la Fase 1.
