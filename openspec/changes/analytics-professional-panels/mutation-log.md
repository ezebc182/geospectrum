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

## Fase 2 — mutaciones de la lógica pura (2026-09-05)

Mecánica: snapshot `cp` de los 4 archivos en el scratchpad ANTES de mutar;
`sd -s` (literal) o un `str.replace` de Python con `assert count == 1` para
el patrón multilínea (M12); confirmación por `rg` + `cmp` contra el snapshot
(`ARCHIVO_DIFIERE_DEL_SNAPSHOT`) y, para el JSON (tracked), también `git
diff --stat`; `PYTHONDONTWRITEBYTECODE=1` + `rm -rf src/services/__pycache__`
antes de cada corrida (no queda `.pyc` que servir); reversión por `cp` +
`cmp` ⇒ `REVERT_CMP_IDENTICAL`; verde.

| # | Archivo | Mutación | Salida de `rg` (confirma el cambio) | Test que se puso rojo | Revertido |
|---|---|---|---|---|---|
| M1 | `dashboard/lib/seismic-constants.json` | `"bValueMinEvents": 50` → `5` (`sd -s`) | `7:  "bValueMinEvents": 5,` + `git diff --stat` ⇒ `8 insertions(+), 1 deletion(-)` | `tests/unit/test_gutenberg_richter.py::TestConstantsFromSharedJson::test_la_guarda_de_n_es_al_menos_50` — `assert MIN_EVENTS >= 50` → `AssertionError: assert 5 >= 50` (1 failed, 15 passed). **No** murió 2.2(c) como predecía tasks.md: ese test construye `M_cut` DESDE `MIN_EVENTS` importado (regla de la spec), así que con 5 recorta a `M ≥ 5.8` (n = 4) y sigue dando `insufficient`. Lo que prueba que el backend lee el JSON es que `MIN_EVENTS` bajó a 5 (una copia hardcodeada habría dejado el `≥ 50` verde y la mutación NO habría matado nada) | `cp` + `cmp` ⇒ `REVERT_CMP_IDENTICAL`; 16 passed |
| M2 | `src/services/gutenberg_richter.py` | `b = log10(e) / (mean - (mc - BIN_WIDTH / 2))` → `/ (mean - mc)` (`sd -s`) | `195:    b = math.log10(math.e) / (mean - mc)` + `cmp` ⇒ difiere | `TestFitBValueOk::test_catalogo_b_1_0_recupera_b_cerca_de_1` — `assert 0.90 <= result.b <= 1.10` → `AssertionError: assert 1.125370822075077 <= 1.1` (exactamente el 1.1254 de R29). También `test_catalogo_b_1_5…` (`1.7917 <= 1.6`) y `TestMcAutomatico` (`1.1258 <= 1.1`) (3 failed, 13 passed) | `cp` + `cmp` ⇒ `REVERT_CMP_IDENTICAL`; 16 passed |
| M3 | `src/services/gutenberg_richter.py` | `if n_above < MIN_EVENTS:` → `if n_above < 0:` (guarda de N salteada; `sd -s`) | `187:    if n_above < 0:` + `cmp` ⇒ difiere | `TestFitBValueNotEstimable::test_recorte_por_debajo_del_minimo_es_insuficiente_sin_b` y `test_n_se_cuenta_despues_de_filtrar_por_mc` — `assert 'ok' == 'insufficient'`; `test_catalogo_vacio…` — `ZeroDivisionError` (3 failed, 13 passed) | `cp` + `cmp` ⇒ `REVERT_CMP_IDENTICAL`; 16 passed |
| M13 | `src/services/gutenberg_richter.py` | `above = [m for m in mags if m >= mc - _EPS]` → `above = list(mags)` (`sd -s`) | `174:        above = list(mags)` + `cmp` ⇒ difiere | `TestFitBValueNotEstimable::test_n_se_cuenta_despues_de_filtrar_por_mc` — `assert 'ok' == 'insufficient'` (1 000 eventos pasan a `ok`); también `TestMcAutomatico` (`1.8409 <= 1.1`) (2 failed, 14 passed) | `cp` + `cmp` ⇒ `REVERT_CMP_IDENTICAL`; 16 passed |
| M7 | `dashboard/lib/seismic-constants.json` | `"tremorMinDurationPeriods": 3` → `1` (`sd -s`) | `11:  "tremorMinDurationPeriods": 1,` + `git diff --stat` | `tests/unit/test_tremor.py::TestClassifyEpisodes::test_un_pico_aislado_no_es_tremor` — `assert result.episodes == []` → `Left contains one more item: TremorEpisodeCore(… samples=1, mean_ratio=20.0, peak_rsam=800.0 …)` (el pico aislado pasa a episodio, como predecía tasks.md); también `test_cotas_de_la_spec` (`assert 1 >= 3`) y `TestCharacterize::test_veinte_minutos_no_alcanzan` (3 failed, 13 passed) | `cp` + `cmp` ⇒ `REVERT_CMP_IDENTICAL`; 16 passed |
| M10 | `dashboard/lib/seismic-constants.json` | `"tremorBaselineFactor": 2.0` → `6.0` (`sd -s`) | `10:  "tremorBaselineFactor": 6.0,` + `git diff --stat` | `TestCharacterize::test_cuarenta_minutos_elevados_son_un_episodio_de_banda_baja` — `assert len(result.episodes) == 1` → `assert 0 == 1` (RSAM ≈ 2 de la señal sintética queda bajo `6 × 0.5 = 3`); también `test_tono_a_8_hz…` (`[] == ['high']`) y `test_la_rampa…` (3 failed, 13 passed). **No** murió 2.4(c) (la meseta) como predecía tasks.md: esa meseta se construye a `40 · BASELINE_FACTOR · 2` (texto literal de la tarea 2.4(c)), así que con 6.0 vale 480 y sigue sobre 240. El escenario de mutación de la spec supone la meseta fija en 160; la tarea la ata a la constante — son incompatibles para ESTA mutación. Lo que la mata es la capa 2 (amplitudes físicas fijas), que igual prueba que el módulo lee el JSON y aplica el factor | `cp` + `cmp` ⇒ `REVERT_CMP_IDENTICAL`; 16 passed |
| M11 | `src/services/tremor.py` | `values = [v for _, v in samples if v is not None]` → `[v if v is not None else 0.0 for _, v in samples]` (`sd -s`) | `125:    values = [v if v is not None else 0.0 for _, v in samples]` + `cmp` ⇒ difiere | `TestClassifyEpisodes::test_un_hueco_parte_el_episodio_en_dos` — `assert 0.19 == 0.1919191919191919 ± 1.0e-03` (19/100 en vez de 19/99, la predicción exacta); también `test_serie_vacia_o_toda_none…` (`assert 0.0 is None`) (2 failed, 14 passed) | `cp` + `cmp` ⇒ `REVERT_CMP_IDENTICAL`; 16 passed |
| M12 | `src/services/station_uptime.py` | en `_ratio`, `if not channel_present or observed_hours == 0: return None` → `observed_hours == 0` devuelve `0.0` (Python `str.replace`, multilínea) | `168:    if observed_hours == 0:` / `169:        return 0.0` + `cmp` ⇒ difiere | `tests/unit/test_station_uptime.py::test_hora_sin_filas_de_ningun_canal_es_none_no_cero` — `assert second.ratio is None` → `assert 0.0 is None`; también `test_bucket_day_con_dia_sin_horas_observadas_es_none` (`(0.0, 0, 0) == (None, 0, 0)`) y `test_filas_fuera_de_la_ventana_se_ignoran` (3 failed, 10 passed) | `cp` + `cmp` ⇒ `REVERT_CMP_IDENTICAL`; 13 passed |
| extra 2.6 | `src/services/tremor.py` | `duration_s=ep.samples * period` → `duration_s=ep.samples` (`sd -s`) — no está en el design; compensa que los tests de la capa 2 se escribieron DESPUÉS de `characterize` (RED de 2.6 no observado aparte) | `255:                duration_s=ep.samples,` + `cmp` ⇒ difiere | `TestCharacterize::test_cuarenta_minutos_elevados_son_un_episodio_de_banda_baja` — `assert episode.duration_s == 2400` → `assert 4 == 2400` (1 failed, 15 passed) | `cp` + `cmp` ⇒ `REVERT_CMP_IDENTICAL`; 16 passed |

## Fase 2 — RED observados (2026-09-05)

- 2.2: `ModuleNotFoundError: No module named 'src.services.gutenberg_richter'`
  (1 error during collection). Módulo creado ⇒ 16 passed.
- 2.4: `ModuleNotFoundError: No module named 'src.services.tremor'`. Capa 1
  creada ⇒ 10 passed.
- 2.6: **RED no observado por separado** — `characterize` se escribió en el
  mismo archivo que la capa 1, antes de sus 6 tests, que pasaron de una
  (16 passed). Compensado con la mutación "extra 2.6" de arriba y con M7/M10,
  que matan tests de la capa 2.
- 2.7: `ImportError: cannot import name 'build_uptime_series' from
  'src.services.station_uptime'`. Función creada ⇒ 13 passed.

## Fase 2 — gate (2026-09-05)

`PYTHONDONTWRITEBYTECODE=1 ./venv/bin/python -m pytest tests/unit/test_gutenberg_richter.py tests/unit/test_tremor.py tests/unit/test_station_uptime.py tests/unit/test_station_uptime_loop.py -q -p no:cacheprovider --no-cov`
⇒ `49 passed` (16 + 16 + 13 + 4). `ruff check` ⇒ `All checks passed!`;
`ruff format --check` ⇒ `6 files already formatted`. `git diff --stat --
dashboard/lib/seismic-constants.json` ⇒ `8 insertions(+), 1 deletion(-)`,
SOLO las 7 claves nuevas (la coma de `codaB` es la línea que cambia).
`git diff --stat -- src/services/watchdog.py src/services/swarm_rsam.py
src/services/seedlink_ingestor.py` vacío. Vecinos que leen el JSON o el
endpoint de RSAM (`test_fdsn_warmup.py`, `test_signal_picks_formulas.py`,
`test_station_rsam_endpoint.py`) verdes. La suite completa la corre el
orchestrator (gate de fase); la Fase 2 no tiene tests de integración.

Nota: `.env.example` figura como `M` en `git status` desde ANTES de la Fase 2
(primer `git status` de la sesión) y no se tocó — el entorno deniega hasta
leerlo.

### Fase 2 — gate real (2026-09-05)

`./venv/bin/python -m pytest tests/ -q -p no:cacheprovider --no-cov -rf`
⇒ `9 failed, 1293 passed, 2 skipped in 88.52s`. Los 9 son los preexistentes
de `test_ws_events.py`; +45 = los tests de la Fase 2 (16 + 16 + 13).
Vitest `lib/signal-picks.test.ts` + `lib/helicorder-layout.test.ts`
⇒ `43 passed`: el JSON de constantes sigue sirviendo a sus lectores viejos.
Decisión del orquestador sobre M10: se mantiene la meseta derivada de la
constante en 2.4(c); la mutación la matan los tests de la capa 2, y el
escenario del spec se alinea en el archive.

## Fase 3 (3.1–3.3) — RED observados (2026-09-06)

Rama `feat/analytics-panels-fase3` desde main `8929332` (#48 y #49 ya en
main).

- 3.1: `ModuleNotFoundError: No module named 'src.models.analytics'`
  (1 error during collection). Módulo creado ⇒ 41 passed. En la misma tarea
  se cerró el mapeo que 2.8 dejó pendiente: `build_uptime_series` devuelve
  `StationUptimeResponse`/`UptimeBucket` (firma del design) y los
  dataclasses `UptimeBucketData`/`UptimeSeriesData` se eliminan;
  `test_station_uptime.py` (13) y `test_station_uptime_loop.py` (4) verdes
  sin tocarlos.
- 3.2: `AttributeError: 'EventStore' object has no attribute 'between'` en
  los 8 tests de `TestBetween` (no por setup). Método creado ⇒
  `test_event_store.py` entero 25 passed (17 previos + 8).

## Fase 3 (3.1–3.3) — mutaciones (2026-09-06)

Mecánica: snapshot `cp` en el scratchpad ANTES de mutar; `sd -s` (literal,
patrón de UNA línea); `rg -F` + `cmp` ⇒ `ARCHIVO_DIFIERE_DEL_SNAPSHOT`
antes de correr; `PYTHONDONTWRITEBYTECODE=1` + `rm -rf` de `__pycache__`;
reversión por `cp` + `cmp` ⇒ `REVERT_CMP_IDENTICAL`; verde final 66 passed
(25 + 41) y `cmp` de los dos archivos contra el snapshot idéntico.

Dos intentos INVÁLIDOS que se registran para no repetirlos: (1) la primera
tanda pasó `"$T -k Between"` como UN argumento a pytest ("file or directory
not found") — las 6 mutaciones se aplicaron y revirtieron sin que ningún
test corriera; se rehízo entera; (2) el primer XM1 usó un patrón con `\n`
en `sd -s`, que no matchea y sale 0 (`CMP_IDENTICAL` lo delató); (3) el
primer X3 (`hora_utc <= $2 AND $1 IS NOT NULL`) mató los 8 tests por
`IndeterminateDatatypeError` de asyncpg — rojo por la razón EQUIVOCADA, no
cuenta; se rehízo con `$1::timestamptz`.

| # | Archivo | Mutación | Salida de `rg` (confirma el cambio) | Test que se puso rojo | Revertido |
|---|---|---|---|---|---|
| M4 | `src/services/event_store.py` | `order = "mag DESC, hora_utc DESC" if order_by_magnitude else "hora_utc DESC"` → `order = "hora_utc DESC"` | `274:        order = "hora_utc DESC"` | `TestBetween::test_por_magnitud_devuelve_las_mayores_con_desempate_por_hora` — `assert ['chico', 'grande_nuevo'] == ['grande_nuevo', 'grande_viejo']` (el `limit=2` se lleva el M6.3 viejo y devuelve el M4.5, la mentira de truncado de R18) (1 failed, 7 passed) | `cp` + `cmp` ⇒ `REVERT_CMP_IDENTICAL` |
| X1 | `src/services/event_store.py` | `if bbox is not None:` → `if False and bbox is not None:` | `263:        if False and bbox is not None:` | `test_el_bbox_filtra_en_sql` — `assert {'andes','atlantico','borde','tokio'} == {'andes','borde'}`; `test_los_filtros_se_combinan` — `['lejos','ok'] == ['ok']` (2 failed, 6 passed) | ídem |
| X2 | `src/services/event_store.py` | `if min_magnitude is not None:` → `if False and min_magnitude is not None:` | `270:        if False and min_magnitude is not None:` | `test_filtra_por_magnitud_minima` — `{'chico','grande','justo'} == {'grande','justo'}`; `test_los_filtros_se_combinan` — `['ok','chico'] == ['ok']` (2 failed, 6 passed) | ídem |
| X3 | `src/services/event_store.py` | `conditions = ["hora_utc BETWEEN $1 AND $2"]` → `["hora_utc <= $2 AND $1::timestamptz IS NOT NULL"]` (sin borde inferior) | `261:        conditions = ["hora_utc <= $2 AND $1::timestamptz IS NOT NULL"]` | `test_respeta_la_ventana` — `{'borde','dentro','fuera'} == {'borde','dentro'}`; `test_los_filtros_se_combinan` — `['viejo','ok'] == ['ok']` (2 failed, 6 passed) | ídem |
| X4 | `src/services/event_store.py` | `if limit is not None:` → `if False and limit is not None:` | `276:        if False and limit is not None:` | `test_por_magnitud_…` — `Left contains 2 more items, first extra item: 'medio'`; `test_por_defecto_ordena_por_hora_descendente` — `['chico','grande_nuevo','medio','grande_viejo'] == ['chico']` (2 failed, 6 passed) | ídem |
| X5 | `src/services/event_store.py` | `"mag DESC, hora_utc DESC"` → `"mag DESC, hora_utc ASC"` (desempate) | `274:        order = "mag DESC, hora_utc ASC" if …` | `test_por_magnitud_…` — `At index 0 diff: 'grande_viejo' != 'grande_nuevo'` (1 failed, 7 passed) | ídem |
| XM1 | `src/models/analytics.py` | `BValueOk.b: float` → `b: Optional[float] = None` | `54:    b: Optional[float] = None` | `tests/unit/test_analytics_models.py::TestBValueOk::test_exige_b_a_y_sigma_b[b]` — `DID NOT RAISE ValidationError` (1 failed, 40 passed). `test_status_ok_sin_b_es_error_no_degradacion` NO muere con esta mutación porque `a`/`sigma_b` siguen siendo obligatorios: la protege `[b]` de arriba | ídem |

M4 se repite en 3.8 contra `hypocenters?limit=5` cuando exista el router
(el design la pide a nivel endpoint). 3.1 no exigía mutación; XM1 es extra.

## Fase 3 (3.1–3.3) — gate real (2026-09-06)

`./venv/bin/python -m pytest tests -q --ignore=dashboard -p no:cacheprovider --no-cov -rf`
⇒ `9 failed, 1342 passed, 2 skipped, 8 warnings in 77.74s`. Los 9 son los
preexistentes de `test_ws_events.py` (Postgres local en 5433 ausente);
+49 sobre la baseline de la Fase 2 (1293) = 41 de
`test_analytics_models.py` + 8 de `TestBetween`. `ruff check` y `ruff
format --check` limpios en los 5 archivos tocados. `git diff --stat main --
src/services/watchdog.py src/services/swarm_rsam.py
src/services/seedlink_ingestor.py` vacío. (Una corrida previa con `-x` frenó
en el primer fallo de `test_ws_events.py` con `1 failed, 1340 passed`: no
es comparable y por eso se repitió sin `-x`.)

## Fase 3 (3.4–3.8) — RED observados (2026-09-06)

Rama `feat/analytics-panels-fase3` sobre `8faccbe` (3.1–3.3).

- 3.4 + 3.5 en UNA corrida antes de crear el router: `42 failed`. Los 9
  unitarios que parchean el singleton FDSN mueren con `AttributeError:
  module 'src.api.routers' has no attribute 'analytics'` (target del patch
  `src.api.routers.analytics.get_spectrogram_service`); los 5 de validación
  del tremor y los 28 de integración reciben `404` (ruta inexistente) donde
  esperan 200/422/503. Ninguno por setup. Router + `fetch_uptime` +
  `include_router` ⇒ `42 passed`.
- 3.7: batería de no-regresión (`test_station_rsam_endpoint.py`,
  `test_api.py`, `test_areas_api.py`, `test_event_store.py`,
  `test_watchdog_loop.py`) ⇒ `86 passed` sin tocar ningún test; `rg` de
  `analytics/rsam|rsam_samples|INSERT INTO rsam` en `src/` sin matches;
  `report()` sigue con `sources` + `current_user`.

## Fase 3 (3.4–3.8) — mutaciones (2026-09-06)

Mecánica: snapshot `cp` de `event_store.py`, `routers/analytics.py` y
`station_uptime.py` en el scratchpad; `sd -s` (literal, UNA línea); `rg -F`
+ `cmp` ⇒ `ARCHIVO_DIFIERE_DEL_SNAPSHOT` ANTES de correr;
`PYTHONDONTWRITEBYTECODE=1` + `rm -rf` de `__pycache__` de `services/` y
`routers/`; reversión por `cp` + `cmp` ⇒ `REVERT_CMP_IDENTICAL`; `cmp`
final de los 3 archivos idéntico; verde final 28 + 14.

Dos primeros intentos INVÁLIDOS, registrados para no repetirlos:

1. **M4 (1er intento) NO mató el test del endpoint** (`1 failed, 16 passed`:
   solo murió `TestBetween`). Causa: el test de `hypocenters?limit=5`
   sembraba `hours_ago = 1 + (7.0 − mag)·24` — el M7.0 era el más NUEVO, así
   que `ORDER BY hora_utc DESC` devolvía los mismos cinco que `mag DESC`. El
   test no podía fallar. Fix: `hours_ago = 1 + (mag − 3.5)·24` (los grandes
   son los viejos). Nunca se anotó como pasada.
2. **XR1 (1er intento) NO mató nada** (`3 passed`). Causa: el área activa
   era el preset `japon`, cuyo polígono ES su bbox (rectángulo,
   verificado en `deploy/sql/seeds/areas_of_interest.json`); los eventos "de
   afuera" estaban en los Andes, fuera del bbox, y la etapa 1 en SQL ya los
   descartaba — la etapa 2 (`point_in_area`) nunca decidía. Con un preset
   rectangular NINGUNA mutación de la etapa 2 es falsable. Fix: área custom
   "Andes" TRIANGULAR creada con `AreaService.create` + `set_active` (lo
   que dice la spec) y los eventos "de afuera" en `BBOX_CORNER`
   (`(−26, −71.5)`: dentro del bbox, fuera del triángulo).

| # | Archivo | Mutación | Salida de `rg` (confirma el cambio) | Test que se puso rojo | Revertido |
|---|---|---|---|---|---|
| M4 (endpoint) | `src/services/event_store.py` | `order = "mag DESC, hora_utc DESC" if order_by_magnitude else "hora_utc DESC"` → `order = "hora_utc DESC"` | `274:        order = "hora_utc DESC"` | `tests/integration/test_analytics_api.py::test_hypocenters_limit_trunca_lo_declara_y_se_queda_con_los_grandes` — `assert [3.5, 4.0, 4.5, 5.0, 5.5] == [7.0, 6.5, 6.0, 5.5, 5.0]` (la mentira de truncado de R18, a nivel HTTP); también `TestBetween::test_por_magnitud_…` (`['chico', 'grande_nuevo'] == …`) (2 failed, 15 passed) | `cp` + `cmp` ⇒ `REVERT_CMP_IDENTICAL` |
| XR1 | `src/api/routers/analytics.py` | `if area_filter is None:` → `if area_filter is None or True:` (se saltea la etapa 2, `point_in_area`) | `144:    if area_filter is None or True:` | `test_b_value_eventos_fuera_del_area_activa_no_cuentan` — `assert 'ok' == 'insufficient'` (la esquina del bbox entra: 2·MIN_EVENTS+90); `test_hypocenters_ventana_de_30_dias_recortada_al_area` — `assert 15 == 10` (2 failed, 1 passed) | ídem |
| XR2 | `src/api/routers/analytics.py` | `truncated=total > limit,` → `truncated=False,` | `224:        truncated=False,` | `test_hypocenters_limit_trunca_…` — `assert False is True` (1 failed) | ídem |
| XR3 | `src/api/routers/analytics.py` | `kind: UptimeBucketKind = "day" if days > MAX_HOURLY_DAYS else bucket` → `kind: UptimeBucketKind = bucket` | `250:    kind: UptimeBucketKind = bucket` | `test_station_uptime_days_mayor_a_14_fuerza_bucket_day` — `assert 'hour' == 'day'` (1 failed) | ídem |
| XR4 | `src/services/station_uptime.py` | en `fetch_uptime`, `rows = [… for r in records]` → `[… for r in records if channels is None or r["channel"] in channels]` (el SELECT filtrado por canal, que rompe [R12]) | `255:    rows = [(r["channel"], r["bucket_start"], r["columns_count"]) for r in records if channels is None or r["channel"] in channels]` | `test_station_uptime_el_filtro_de_canal_no_cambia_que_es_hora_observada` — `assert None == 0.0` (el canal mudo pasa de "se miró" a "nadie miró") (1 failed, 1 passed) | ídem |
| XR5 | `src/api/routers/analytics.py` | `"t": str(trace.stats.starttime + (i + 0.5) * period),` → `… + i * period),` (t en el borde izquierdo) | `334:            "t": str(trace.stats.starttime + i * period),` | `tests/unit/test_analytics_tremor_endpoint.py::test_traza_estacionaria_no_tiene_episodios` — `'2019-04-18T20:00:00.000000Z'.startswith('2019-04-18T20:05:00')` es False; `test_tremor_y_tendencia_comparten_la_serie` — `At index 0 diff: '…20:00:00.000000Z' != '…20:05:00.000000Z'` (2 failed) | ídem |

## Fase 3 (3.4–3.8) — gate real (2026-09-06)

`PYTHONDONTWRITEBYTECODE=1 ./venv/bin/python -m pytest tests -q --ignore=dashboard -p no:cacheprovider --no-cov -rf`
⇒ `9 failed, 1384 passed, 2 skipped, 8 warnings in 91.15s`. Los 9 son los
preexistentes de `test_ws_events.py`; +42 sobre el gate de 3.1–3.3 (1342)
= 14 de `test_analytics_tremor_endpoint.py` + 28 de `test_analytics_api.py`.
`ruff check` y `ruff format --check` limpios en `routers/analytics.py`,
`models/analytics.py`, `event_store.py`, `station_uptime.py` y los 3 tests;
`src/main.py` conserva SOLO el F811 preexistente de `search_stations`
(ajeno). `git diff --stat main -- src/services/watchdog.py
src/services/swarm_rsam.py src/services/seedlink_ingestor.py` vacío.

## Fase 4 — baseline frontend (2026-09-06)

Rama `feat/analytics-panels-fase4` desde main `ab947e5` (#51, Fase 3).
Node v22.16.0 de nvm; `./node_modules/.bin/vitest run` y `./node_modules/.bin/tsc --noEmit`.

```
Test Files  102 passed (102)
     Tests  1135 passed (1135)
  Duration  40.79s
TSC_EXIT=0
```

(+6 tests sobre los 1129 de la baseline del 2026-09-04: main se movió en
tests desde entonces; se registra el número de HOY.)

## Fase 4 — RED observados (2026-09-06)

- 4.1: `Failed to resolve import "./analytics" from "lib/analytics.test.ts"`
  (1 failed, no tests). Módulo creado ⇒ 15 passed.
- 4.2–4.6 en UNA corrida antes de crear ningún lib: los 5 archivos mueren
  con `Failed to resolve import "./b-value-plot" | "./hypocenter-markers" |
  "./rsam-trend" | "./tremor-episodes" | "./uptime-series"` (5 failed, no
  tests). Libs creados ⇒ 16 + 13 + 11 + 13 + 12 = 65 passed. Un error de
  `tsc` propio (`thresholdLine` con `Pick<>` vs. el objeto entero del test)
  corregido en el lib, no en el test.

## Fase 4 — mutaciones del frontend (2026-09-06)

Ninguna exigida por tasks.md (las del design que tocan el frontend, M8 y
M14, van en 5.7 sobre los componentes); se hizo UNA por rama crítica de
cada lib, con la mecánica de siempre: snapshot `cp` en el scratchpad; `sd
-s` (literal, UNA línea); `rg -F` + `cmp` ⇒ `ARCHIVO_DIFIERE_DEL_SNAPSHOT`
ANTES de correr; test ROJO por la aserción predicha; `cp` + `cmp` ⇒
`REVERT_CMP_IDENTICAL`; verde. Vitest no tiene el problema del `.pyc`
(transforma en memoria por corrida).

Dos intentos INVÁLIDOS, registrados para no repetirlos:

1. **MF2 y MF4 (1er intento) NO se aplicaron**: patrón con `\n` en `sd -s`
   ⇒ `CMP_IDENTICAL` y el test verde. Es el gotcha de
   `sd-s-no-matchea-saltos-de-linea`; el `cmp` del script lo delató. Se
   rehicieron con patrones de UNA línea.
2. **MF2 (2.º intento, quitar el `continue` del canal rechazado) murió por
   la razón EQUIVOCADA**: `TypeError: Cannot read properties of undefined
   (reading 'samples')` — el código lee `result.value` después del
   `continue`, así que la mutación crashea antes de llegar a la aserción.
   No cuenta. Se reemplazó por MF2b (empujar el canal rechazado a
   `channels`), que deja el crash fuera y mata la aserción `'B' in row`.

| # | Archivo | Mutación | Salida de `rg` (confirma el cambio) | Test que se puso rojo | Revertido |
|---|---|---|---|---|---|
| MF1 | `dashboard/lib/rsam-trend.ts` | fila sin muestra del canal: `: null` → `: 0` | `75:        row[channel] = values.has(channel) ? (values.get(channel) as number \| null) : 0;` + `cmp` ⇒ difiere | `mergeSeriesByTime > B sin t1 ⇒ siguen siendo 3 filas y B es null (no 0) en t1` — `AssertionError: expected +0 to be null` (la mutación que R27 nombra) (1 failed, 11 passed) | `cp` + `cmp` ⇒ `REVERT_CMP_IDENTICAL`; 12 passed |
| MF2b | `dashboard/lib/rsam-trend.ts` | `errors[channel] = reasonMessage(result.reason);` → `…; channels.push(channel);` (el canal rechazado entra en `channels` ⇒ sus claves aparecen como `null` en las filas) | `54:      errors[channel] = reasonMessage(result.reason); channels.push(channel);` | `mergeSeriesByTime > un canal rechazado ⇒ sus claves ausentes de las filas y errors[B] con la razón` — `AssertionError: expected true to be false` sobre `'B' in row` (1 failed, 11 passed) | ídem; 12 passed |
| MF3 | `dashboard/lib/uptime-series.ts` | en el comparador de `rankStations`, `if (a.ratio === null) return 1;` → `return -1;` (los `null` primero) | `42:    if (a.ratio === null) return -1;` | `rankStations > ordena peor primero…` — `expected [ 'D', 'C', 'B', 'A' ] to deeply equal [ 'B', 'D', 'A', 'C' ]`; también `es estable…` y `0.0 es observado…` (3 failed, 10 passed) | ídem; 13 passed |
| MF4 | `dashboard/lib/uptime-series.ts` | `percentLabel`: `if (ratio === null \|\| !Number.isFinite(ratio)) return null;` → `if (ratio === null) ratio = 0; if (!Number.isFinite(ratio)) return null;` | `83:  if (ratio === null) ratio = 0; if (!Number.isFinite(ratio)) return null;` | `percentLabel > null ⇒ null (…), nunca "0 %" ni "NaN %"` — `AssertionError: expected '0 %' to be null` (1 failed, 12 passed) | ídem; 13 passed |
| MF5 (= M14 en el lib) | `dashboard/lib/hypocenter-markers.ts` | guarda de `markerStyle`: `if (ev.prof_km === null \|\| !Number.isFinite(ev.prof_km))` → `if (ev.prof_km !== null && !Number.isFinite(ev.prof_km))` (el `null` cae en `getDepthColor(null)`, que como `null < 70` da el rojo de "< 70 km" — el mismo efecto que `prof_km ?? 0`) | `49:  if (ev.prof_km !== null && !Number.isFinite(ev.prof_km)) {` | `markerStyle > prof_km null ⇒ kind "no-depth", …, NO el color de <70 km (R26/M14)` — `AssertionError: expected 'depth' to be 'no-depth'` (1 failed, 12 passed) | ídem; 13 passed |
| MF6 | `dashboard/lib/b-value-plot.ts` | `log10Cumulative: bin.cumulative > 0 ? Math.log10(bin.cumulative) : null,` → `log10Cumulative: Math.log10(bin.cumulative),` | `34:    log10Cumulative: Math.log10(bin.cumulative),` | `toFmdRows > cumulative 0 ⇒ log10Cumulative null, NUNCA -Infinity` — `AssertionError: expected -Infinity to be null` (1 failed, 15 passed) | ídem; 16 passed |
| MF7 | `dashboard/lib/b-value-plot.ts` | primer punto de la recta `{ m: mc, log10N: a - b * mc }` → `{ m: mc, log10N: a }` | `56:    { m: mc, log10N: a },` | `fittedLinePoints > el primer punto es EXACTAMENTE (mc, a − b·mc)…` — `expected { m: 2, log10N: 6 } to deeply equal { m: 2, log10N: 4 }`; también `con b=1.5 la pendiente cambia` (`expected 8 to be close to 5`) (2 failed, 14 passed) | ídem; 16 passed |
| MF8 | `dashboard/lib/tremor-episodes.ts` | `thresholdLine`: `return response.threshold_rsam;` → `return response.baseline_rsam === null ? null : response.baseline_rsam * response.parameters.baseline_factor;` (recalcular en el cliente) | `50:  return response.baseline_rsam === null ? null : …` | `thresholdLine > devuelve threshold_rsam TAL CUAL, aunque baseline × factor dé otra cosa` — `AssertionError: expected 80 to be 123` (1 failed, 10 passed) | ídem; 11 passed |
| MF9 | `dashboard/lib/analytics.ts` | `getTremor`: `if (response.status === 404) return { kind: 'no-data', … }` → `=== -1` (el 404 pasa a lanzar) | `266:  if (response.status === -1) return { kind: 'no-data', detail: await readDetail(response) };` | `getTremor > 404 (sin datos FDSN) ⇒ {kind: "no-data"} con el detail, NO una excepción` — `ApiStatusError: Sin datos FDSN para GE.KBU..BHZ` (1 failed, 14 passed) | ídem; 15 passed |
| MF10 | `dashboard/lib/analytics.ts` | `query()`: `search.append(key, item)` → `search.set(key, item)` (solo queda el último `channel=`) | `223:      for (const item of value) search.set(key, item);` | `getStationUptime > repite channel= por cada canal pedido, en orden y URL-encoded` — `AssertionError: expected '/analytics/station-uptime?days=30&buc…' to be '…'` (la URL pierde `channel=GE.KBU..BHZ`) (1 failed, 14 passed) | ídem; 15 passed |

`cmp` final de los 6 libs contra sus snapshots: idéntico (todas las
reversiones `REVERT_CMP_IDENTICAL`).

## Fase 4 — gate real (2026-09-06)

`./node_modules/.bin/vitest run lib/analytics.test.ts lib/b-value-plot.test.ts lib/uptime-series.test.ts lib/tremor-episodes.test.ts lib/hypocenter-markers.test.ts lib/rsam-trend.test.ts`
⇒ `6 files, 80 passed`. `./node_modules/.bin/tsc --noEmit` ⇒ exit 0.

`./node_modules/.bin/vitest run` (suite completa) ⇒

```
Test Files  108 passed (108)
     Tests  1215 passed (1215)
  Duration  39.40s
```

+6 archivos / +80 tests sobre la baseline de hoy (102 / 1135), cero
regresiones. ESLint: no hay archivo de configuración en `dashboard/` (solo
el script `next lint`, que pediría crearla de forma interactiva); no se
corrió y no se anota como corrido. `git status`: solo los 12 archivos nuevos
en `dashboard/lib/` más `.env.example` y el proposal del asistente, que
estaban modificados desde antes y no se tocan ni se stagean.

## Fase 5 — mutaciones críticas del frontend (tarea 5.7, 2026-09-07)

Las dos que nombra `tasks.md`. `M14` ya se había verificado a nivel lib en
Fase 4 (fila `MF5`); acá se repite con la forma LITERAL que pide la tarea
(`getDepthColor(ev.prof_km ?? 0)`, que exige además desactivar la guarda de
`markerStyle` — con la guarda viva el `??` es código muerto y la mutación no
mutaría nada) y se comprueba que mata TAMBIÉN el test del componente de 5.6,
no solo el del lib.

| # | Archivo | Mutación | Salida de `rg` (confirma el cambio) | Test que se puso rojo | Revertido |
|---|---|---|---|---|---|
| M8 | `dashboard/components/analytics/BValueChart.tsx` | leer `b` del body sin mirar `status` y renderizar el número igual: `const estimate = data.status === 'ok' ? formatB(data.b, data.sigma_b) : null;` → `const loose = data as unknown as {b?: number; sigma_b?: number}; const estimate = loose.b !== undefined ? formatB(loose.b, loose.sigma_b ?? 0) : null;` **y** `{notEstimable ? (` → `{false ? (` (las dos: con solo la primera la mutación SOBREVIVIÓ — el ternario de `notEstimable` seguía tapando la rama del número, o sea que `estimate` por sí solo es inalcanzable fuera de `ok`) | `98:  const loose = data as unknown as { b?: number; …` + `110:      {false ? (`; `git diff --stat` ⇒ `2 insertions(+), 2 deletions(-)` | `insufficient: tarjeta con 23 y 50, SIN número, SIN etiqueta de b-value y SIN recta`, `body malformado {status: insufficient, b: 1.2} ⇒ el 1.2 NO aparece`, `degenerate: su propio texto, NO el de insuficiente, sin número` y `el estado no estimable sale de en.json con la UI en inglés` — `Unable to find an element by: [data-testid="b-value-insufficient"]` / `[data-testid="b-value-degenerate"]` (4 failed, 4 passed) | `cp` + `cmp` ⇒ `REVERT_CMP_IDENTICAL`; 8 passed |
| M14 | `dashboard/lib/hypocenter-markers.ts` | `markerStyle`: guarda `if (ev.prof_km === null \|\| !Number.isFinite(ev.prof_km)) {` → `if (false) {` y `const color = getDepthColor(ev.prof_km);` → `const color = getDepthColor(ev.prof_km ?? 0);` (el evento sin profundidad toma el color de `< 70 km`) | `49:  if (false) {` + `61:  const color = getDepthColor(ev.prof_km ?? 0);`; `git diff --stat` ⇒ `2 insertions(+), 2 deletions(-)` | 4.5: `markerStyle > prof_km null ⇒ kind "no-depth", …, NO el color de <70 km (R26/M14)` y `markerStyle > prof_km NaN se trata como sin profundidad, no como 0`; 5.6: `HypocenterMap > el evento con prof_km null lleva el estilo no-depth, NO el color de <70 km (M14)` — las tres `AssertionError: expected 'depth' to be 'no-depth'` (3 failed, 21 passed) | ídem; `components/analytics` + `lib/hypocenter-markers.test.ts` ⇒ 8 files, 68 passed |

Entre cada corrida se borró `node_modules/.vite` (la caché de transform de
vitest sirve el módulo viejo si la mutación y la reversión caen en el mismo
segundo — la trampa `mutacion-sd-mismo-segundo-pyc-viejo` del proyecto, que en
JS es la caché de Vite y no el `.pyc`).

**Lección de M8**: una mutación "obvia" que no cambia lo observable no prueba
nada. La primera versión tocaba únicamente el cálculo de `estimate` y los 8
tests siguieron verdes — no porque los tests fueran flojos, sino porque el
`notEstimable ? … : …` ya blinda la rama. La mutación válida es la que
realmente pone el número en pantalla con `status !== "ok"`, y ESA muere.
