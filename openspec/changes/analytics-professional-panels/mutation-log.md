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
