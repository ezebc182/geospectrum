# Tasks: Paneles profesionales de análisis en /analytics

## Reconciliación spec ↔ design aplicada antes de escribir estas tareas

Specs y design se escribieron en paralelo (dos sub-agentes). Regla aplicada:
**el design gana en mecanismo y shapes** (SQL, rutas, Pydantic/TS types,
nombres de constantes), **la spec gana en comportamiento observable** (qué
es `null` y qué es `0`, qué clave NO está en un body, qué nunca es `"ok"`).
Cada fila dice qué artefacto se editó. Los puntos donde el design cambió
están marcados `[R#]` dentro de `design.md`.

| # | Drift detectado | Resolución | Dónde quedó |
|---|---|---|---|
| R1 | **RSAM trend**: spec `backend-api` exigía `GET /analytics/rsam` con ventana ≥ 7 días y una función de bucketing multi-día; design reusa `GET /stations/{channel}/rsam` × N canales, 24 h, sin persistir | **DECIDIDO POR EL USUARIO**: 24 h, sin persistencia, sin endpoint nuevo. Se eliminó el requirement `/analytics/rsam` y el de "Agregación temporal RSAM por buckets"; se agregó el requirement de reuso/no-regresión y el de `mergeSeriesByTime` (frontend). El requirement base "MUST NOT persistir RSAM" queda intacto | `specs/backend-api/spec.md` (Decisión 4, "Tendencia RSAM — reuso"), `specs/signal-analysis/spec.md` ("Fusión multi-canal") |
| R2 | **Tremor**: spec exige clasificador PURO sobre la serie RSAM (`list[(t, value\|null)]`, MUST NOT recibir forma de onda); design `characterize(signal, fs)` recibe la onda y calcula espectro por período | **Dos capas**: `classify_episodes(samples)` pura (spec) + `characterize(signal, fs, start)` que corre `rsam_series` y enriquece con banda/FI (design). La clasificación no cambia por la capa 2 | `design.md` Decision 4 y firmas; `specs/signal-analysis/spec.md` regla 1 |
| R3 | Constantes: spec `N_MIN`, `TREMOR_RATIO`, `MIN_TREMOR_SAMPLES` (placeholders); design `bValueMinEvents`, `tremorBaselineFactor`, `tremorMinDurationPeriods` en el JSON | **Design gana** (una sola fuente en `seismic-constants.json`, patrón `signal_picks.py`); Python `MIN_EVENTS`, `BASELINE_FACTOR`, `MIN_DURATION_PERIODS` | las tres specs |
| R4 | Respuesta de tremor: spec `baseline`, `parameters`, `tremor_fraction`, episodios `{start,end,samples,mean_ratio}`, `samples[{t,value}]`; design `baseline_rsam`, `threshold_rsam`, episodios con `peak/onset/band/fi_sign`, `samples[{t,rsam,dominant_hz,fi}]` | **Design gana en nombres**, **spec gana en campos obligatorios**: se agregaron al design `tremor_fraction`, `parameters{baseline_factor,min_duration_periods}`, `samples` y `mean_ratio` por episodio; `baseline_rsam`/`threshold_rsam` pasan a `Optional` para el caso "sin datos" | `design.md` contratos; `specs/backend-api/spec.md` |
| R5 | Ruta del tremor: spec `GET /analytics/tremor?channel=`; design `GET /analytics/tremor/{channel}` | Design gana (mismo molde que `/stations/{channel}/rsam`) | `specs/backend-api/spec.md` |
| R6 | b-value: spec exige que el estimador ACEPTE `Mc` como entrada (sus escenarios fijan `Mc = 2.0`); design `fit_b_value(mags)` solo con Mc automático | `fit_b_value(mags, mc=None)`: `None` ⇒ `estimate_mc_maxc()`; endpoint con `mc` opcional. Los escenarios de la spec quedan testeables end-to-end | `design.md` Decision 1, firmas, Decision 6 |
| R7 | Campos del b-value: spec `n`, `n_min`, `histogram[{mag,…}]`, `method`; design `n_total`, `n_above_mc`, `min_events`, `bins[{m,…}]`, `mc_at_catalog_floor`, `mag_type_counts` (sin `method`) | Design gana en nombres; se agrega `method: "aki-utsu-mle"` (spec) | `design.md` contratos; specs `signal-analysis`, `backend-api`, `dashboard-ui` |
| R8 | `b` en "insuficiente": spec "el campo NO existe (ni `null`)"; design `b: Optional[float] = None` (serializa `"b": null`) | **Spec gana** (observable): unión discriminada `BValueOk` / `BValueNotEstimable`; el test afirma `"b" not in body` | `design.md` Decision 1, contratos |
| R9 | "Todas las magnitudes iguales": spec exige que nunca sea `"ok"`; design no lo contemplaba (MLE daría `b = 8.69`) | Tercer estado `status = "degenerate"` (mismo modelo que `insufficient`); la UI no muestra número para `status !== "ok"` | `design.md` Decision 1; specs `signal-analysis`, `backend-api`, `dashboard-ui` |
| R10 | Mutación de la guarda: spec "`N_MIN` → 1"; design M1 "`bValueMinEvents` 50 → 5" | Se unifica en M1 (50 → 5, en el JSON; prueba que el backend lee el JSON) | `specs/signal-analysis/spec.md` escenario de mutación |
| R11 | Uptime: spec función pura sobre `[(t, up: bool)]` → `uptime_pct ∈ [0,100]`; design rollup horario `columns_count / 900` → `ratio ∈ [0,1]` | **Design gana en mecanismo y shape** (`ratio`, tabla `station_uptime_hourly`); el requirement de la spec se reescribió como `build_uptime_series(rows, …)` pura sobre las filas del rollup | `specs/signal-analysis/spec.md` ("Serie de disponibilidad por buckets a partir del rollup") |
| R12 | `null` vs `0` en uptime: spec Decisión 4/5 ("hueco = `null`, uptime contra tiempo OBSERVADO"); design solo escribe filas donde hubo columnas y el read no distinguía "muda" de "nadie miró" | **Spec gana** (observable): "hora observada" = hora con fila de ALGÚN canal; canal presente sin fila en hora observada ⇒ `0.0`; hora no observada ⇒ `null`; canal sin filas en la ventana ⇒ todo `null`; `bucket=day` sobre `900 × horas observadas`. El rollup NO cambia | `design.md` Decision 2 (fila `[R12]`), contratos `UptimeBucket`/`StationUptimeResponse`, diagrama |
| R13 | Reglas del registro de uptime: spec hablaba de `check_seedlink`, `stale_after`, ciclo del watchdog, ntfy; design: rollup en el `api`, `watchdog.py` sin cambios | Design gana en mecanismo: reglas reescritas sobre el loop del `api` (`UPTIME_ROLLUP_ENABLED`, try/except por ciclo, `watchdog.py` intacto, idempotencia `DO UPDATE`, backfill 7 d) | `specs/backend-api/spec.md` ("Rollup persistente") |
| R14 | Ruta y shape del uptime: spec `/analytics/uptime?start&end&bucket_seconds&channels` → `channels[{channel, uptime_pct, samples[]}]`; design `/analytics/station-uptime?days&bucket&channel` → `stations{ch: [UptimeBucket]}, overall{}` | Design gana; se agrega `expected_columns_per_hour` a la respuesta y `observed_hours` al bucket (para que la UI pueda decir "sobre N h observadas") | `specs/backend-api/spec.md`; `design.md` contratos |
| R15 | Ventana mínima de uptime ≥ 7 días (spec) vs backfill de 7 días del rollup (design) | **Sin drift real**: el rollup da 7 días desde el primer deploy y la tabla no tiene retención; se fija `days ∈ [1, 365]` como máximo (faltaba en el design) | `design.md` Decision 2 y 6 |
| R16 | Clave de canal del uptime: spec la dejaba al design (`NET.STA.CHAN` del watchdog vs 4 partes de `spectrogram_columns`) | 4 partes (`trace.id`), la clave de la fuente | `specs/backend-api/spec.md` Decisión 9 |
| R17 | Parámetros de b-value/hipocentros: spec `start`/`end` ISO obligatorios; design `days` | Design gana (`days ∈ [1, 365]`, `Query(ge=1, le=365)` ⇒ 422); tremor conserva `start`/`end` con la validación de `/rsam` | `specs/backend-api/spec.md` Decisión 3 |
| R18 | Orden de hipocentros: spec `hora_utc DESC` ("los 4 más recientes"); design `mag DESC` ("el recorte se lleva microsismicidad, nunca el M6") | **Design gana**: el criterio del design corrige una mentira de truncado que la spec no había visto; escenario reescrito ("los 5 de mayor magnitud") | `specs/backend-api/spec.md` |
| R19 | Respuesta de hipocentros: spec `start`/`end`; design `window_start`/`window_end` + `area_slug` | Design gana | `specs/backend-api/spec.md` |
| R20 | Migración: spec "siguiente número libre después de 020"; design **021** | Sin drift: verificado que la última es `020_feedback_screenshot.sql` | — |
| R21 | Selector de ventana: spec UN selector con presets ≥ `24 h` y `7 d` para los cinco paneles; design DOS (`catalogDays` 7/30/90/365, `signalWindow` 6/12/24 h) y el diagrama dejaba al uptime "sin ventana" | Design gana en los dos selectores (consecuencia de R1); se aclara que uptime sigue a `catalogDays` (diagrama corregido) | `specs/dashboard-ui/spec.md` Decisión 1; `design.md` Decision 8 y diagrama |
| R22 | Fuente del panel RSAM en la UI: spec `/analytics/rsam` | `/stations/{channel}/rsam` × N vía `StationPicker` + `Promise.allSettled`; error POR SERIE | `specs/dashboard-ui/spec.md` |
| R23 | Panel de uptime en la UI: spec `uptime_pct` | `ratio` de la respuesta; se conserva "0 %" vs "sin observación" y se agrega "en curso" (`in_progress`) | `specs/dashboard-ui/spec.md` |
| R24 | Panel de b-value en la UI: spec `n`/`n_min`/`histogram`, redondeo abierto (`0.99` o `1.00`) | Nombres del design; redondeo fijado en 2 decimales (`0.9963` ⇒ `1.00`); se combinan los `data-testid` del design con la regla "buscar por la etiqueta i18n" de la spec | `specs/dashboard-ui/spec.md` Decisión 8 |
| R25 | Panel de tremor en la UI: spec pide `tremor_fraction` y `parameters` visibles; design solo tabla con banda/FI | Se agregan al `TremorPanel` (son campos del contrato tras R4) | `design.md` File Changes; `specs/dashboard-ui/spec.md` |
| R26 | `prof_km = null` en el mapa: spec exige estilo distinguible sin pasar por `getDepthColor`; design no lo decía | Agregado a `markerStyle(ev)` (relleno transparente, borde gris punteado; popup "sin profundidad"); mutación M14 | `design.md` Decision 5 y File Changes |
| R27 | Hueco en `mergeSeriesByTime`: design `undefined`; spec Decisión 4 `null` | `null` (Recharts lo corta igual con `connectNulls={false}`; el test usa `toBeNull()`) | `design.md` Decision 8 y File Changes |
| R28 | `DepthSectionChart`: SHOULD en el design, ausente en las specs | Requirement SHOULD agregado; va ÚLTIMO en estas tareas (Fase 5, recortable) | `specs/dashboard-ui/spec.md` |
| R29 | Tolerancia del test de b (design Open Question / M2): design decía "sin Utsu ≈ 1.05, bajar a ±0.02" | **Verificado con Python**: sin Utsu da `1.1254` (mean 2.3859); `[0.90, 1.10]` de la spec lo detecta. Open Question cerrada | `design.md` M2 y Open Questions |
| R30 | Escenario "N por debajo del mínimo": spec decía "recortar a `M ≥ 3.5`" (eso son 316+… eventos, muy por encima de 50) | **Verificado con Python**: el recorte que baja de 50 es `M ≥ 5.0` (n = 45); el test lo construye desde `MIN_EVENTS` | `specs/signal-analysis/spec.md` |
| R31 | Escenario de integración del b-value: sembrar 48 617 eventos en Postgres para un test de router | Catálogo reducido `round(10^(4.0−M))`, M 2.0..4.0 = **483 eventos** (verificado), un INSERT batch | `specs/backend-api/spec.md`; `design.md` Testing |
| R32 | Status codes (200 para insuficiente, 503 sin store, 404 tremor sin datos, 422 bordes), auth (`get_current_user_optional` + área en b-value/hipocentros; públicos uptime/tremor), i18n bajo `analytics.*`, no-regresión de `/report` y de los 3 componentes existentes | **Sin drift** — coinciden en spec y design | — |
| R33 | `rsam_series` devuelve `list[float]` (nunca `None`); la spec del tremor exige tratar `null` | Sin conflicto: la capa pura acepta `Optional` por contrato (un caller futuro con huecos); en prod no llega `None`. Documentado en el design | `design.md` Decision 4 |

## Convenciones no negociables de este change

- Identificadores en INGLÉS, comentarios y docstrings en ESPAÑOL.
- Backend: `./venv/bin/python -m pytest` (venv en `venv/`, NO `.venv/`). Tests
  de integración usan testcontainers: Docker levantado ANTES de correrlos.
- Frontend: exportar el PATH del Node v22 de nvm antes de cualquier comando;
  `./node_modules/.bin/vitest` (nunca `npx vitest`); `./node_modules/.bin/tsc
  --noEmit`. **Nunca `next build`** (comparte `.next` con el server de dev).
- Verificar contra la base, no con mocks: todo test de integración que
  afirme algo sobre una fila lo hace con SELECT (molde
  `tests/integration/test_feedback_screenshot_migration.py`,
  `test_feedback_api.py`).
- **Valores esperados calculados a mano** (requisito transversal del spec
  base de `signal-analysis`): ningún test afirma "es un número" o "no es
  NaN". Los números de las specs fueron verificados con Python el
  2026-09-04 (R29–R31).
- **Mutaciones críticas** (M1–M14 del design, tabla "Verificación por
  mutación"): mecánica idéntica a `feedback-screenshot-attachment` —
  snapshot con `cp` ANTES de mutar; `sd -s` (modo literal) o `Edit` para
  patrones multilínea; `rg` que confirma el cambio ANTES de correr; `rm -rf
  **/__pycache__` entre mutación y reversión (mismo segundo sirve el `.pyc`
  viejo); test ROJO por la razón predicha; reversión por `cmp` byte a byte
  contra el snapshot; verde. Registrar cada una en
  `openspec/changes/analytics-professional-panels/mutation-log.md`. Si una
  mutación no pone rojo ningún test, se arregla el test — nunca se anota
  como "pasada". M9 (`preferCanvas`) NO tiene test: es QA visual (7.6), y
  así se registra.
- **Preferencia permanente del usuario: NADA corre en local.** Sin `docker
  compose`, sin `uvicorn`, sin stack levantado. `pytest` con testcontainers
  efímeros SÍ corre. La verificación de proceso real es en prod tras el
  merge (Fase 7). Aviso ÚNICO de riesgo: el rollup agrega un `create_task`
  al lifespan del `api`; un loop que lance al arrancar tumba el `api` —
  por eso calca `disk_alert` (try/except por ciclo) y se cubre en 1.6.
- **Archivos protegidos** (no se tocan): `src/services/watchdog.py`,
  `src/services/swarm_rsam.py`, `src/services/seedlink_ingestor.py`,
  `dashboard/components/MagnitudeTimeChart.tsx`,
  `dashboard/components/DepthDistributionChart.tsx`,
  `dashboard/components/EventsTable.tsx`,
  `dashboard/components/AdvancedSeismicMap.tsx`,
  `dashboard/components/SeismicMapWithCities.tsx`. Se verifica por `git
  diff --stat` en los gates.
- Toda verificación registra el resultado REAL obtenido, nunca "debería
  funcionar".
- **No commitear** hasta que el usuario lo pida; sin ninguna atribución a IA
  en commits ni PRs.
- **Orden de fases a propósito**: la Fase 1 (rollup de uptime) es la única
  persistencia nueva y va PRIMERA para que la historia se acumule mientras
  se construye el resto. Es mergeable/deployable sola (1.9).

---

## Phase 1: Baseline, migración 021 y rollup de uptime (persistencia primero)

**Estado al cerrar la fase**: baseline registrada; `station_uptime_hourly`
existe en la base del testcontainer (idempotencia por doble ejecución real);
`rollup_once` y `run_uptime_rollup_loop` probados contra Postgres real;
loop wireado en el lifespan del `api` detrás de `UPTIME_ROLLUP_ENABLED`;
mutaciones M5 y M6 registradas. Deployable solo.

- [x] 1.1 Registrar la baseline ANTES de tocar cualquier archivo.
      *Archivos*: crea `openspec/changes/analytics-professional-panels/mutation-log.md`.
      *Qué*: correr `./venv/bin/python -m pytest tests/ -q -p no:cacheprovider --no-cov`
      y `cd dashboard && ./node_modules/.bin/vitest run 2>&1 | tail -5` y
      anotar los conteos exactos (passed/failed/skipped) fechados — el
      número real de HOY, NO el `1232`/`1129` de
      `feedback-screenshot-attachment` (main se movió). Listar fallos
      preexistentes (los 9 de `test_ws_events.py` son conocidos; confirmar).
      Dejar armada la tabla de mutaciones (columnas `#`, archivo, mutación,
      salida de `rg`, test que se puso rojo, revertido).
      *Aceptación*: el archivo existe con la baseline de HOY.
      *Verificación*: `bat openspec/changes/analytics-professional-panels/mutation-log.md`.
      *Mutación*: no aplica.
- [x] 1.2 (RED) Test de la migración 021 ANTES de crearla.
      *Resultado real (2026-09-05)*: RED observado con la 021 fuera del
      directorio — `test_tabla_con_columnas_y_tipos_exactos` muere en
      `assert rows` (information_schema devuelve `[]`, no lanza
      `UndefinedTable`); 11 s con el container ya arriba.
      *Archivos*: crea `tests/integration/test_station_uptime_migration.py`
      (molde `tests/integration/test_feedback_screenshot_migration.py`:
      fixture `_migrated` de `tests/conftest.py`).
      *Qué*: (a) tras aplicar el glob completo (…020 + 021) existe la tabla
      `station_uptime_hourly` con columnas `channel text NOT NULL`,
      `bucket_start timestamptz NOT NULL`, `columns_count integer NOT NULL`
      (`information_schema.columns`) y PK `(channel, bucket_start)`; (b) un
      INSERT con `columns_count = -1` viola el CHECK; (c) existe el índice
      `idx_station_uptime_hourly_bucket`; (d) **segunda ejecución** de
      `apply_migrations(dsn)` termina sin error y una fila insertada entre
      corridas sobrevive intacta (escenario "Segunda aplicación de la
      migración 021 es no-op").
      *Aceptación*: falla HOY por tabla inexistente, no por error de setup.
      *Verificación*: `./venv/bin/python -m pytest tests/integration/test_station_uptime_migration.py -q` ⇒ rojo por `UndefinedTable`.
      *Mutación*: no aplica (es el test).
- [x] 1.3 (GREEN) Crear la migración 021.
      *Archivos*: crea `deploy/sql/migrations/021_station_uptime_hourly.sql`.
      *Qué*: el SQL EXACTO del design ("Interfaces / Contracts"): `CREATE
      TABLE IF NOT EXISTS station_uptime_hourly (channel TEXT NOT NULL,
      bucket_start TIMESTAMPTZ NOT NULL, columns_count INTEGER NOT NULL
      CHECK (columns_count >= 0), PRIMARY KEY (channel, bucket_start))`,
      `CREATE INDEX IF NOT EXISTS idx_station_uptime_hourly_bucket ON
      station_uptime_hourly (bucket_start)`, comentario de cabecera en
      español (por qué tabla plana y no cagg/Redis/watchdog — resumen de
      Decision 2) y `-- Rollback: DROP TABLE IF EXISTS station_uptime_hourly;`.
      *Aceptación*: 1.2 pasa completo.
      *Verificación*: mismo comando de 1.2 ⇒ verde.
      *Mutación*: NO — se verifica por ejecución real doble (mismo criterio
      que la 020).
- [x] 1.4 Config: `uptime_rollup_enabled` / `uptime_rollup_interval_seconds`.
      *Estado (2026-09-05)*: `settings.py` HECHO y verificado (`False 600`).
      La parte de `.env.example` se DESCARTA: el usuario confirmó que
      `DISK_ALERT_*` no está ahí, y `rg` verifica que ninguna variable
      opt-in de Railway (`DISK_ALERT_ENABLED`, `FDSN_WARMUP_ENABLED`,
      `WATCHDOG_ENABLED`) se documenta fuera de los comentarios de
      `settings.py`. Esa es la convención del repo; el requisito de abajo
      era inventado.
      *Archivos*: modifica `src/config/settings.py`.
      *Qué*: `uptime_rollup_enabled: bool = False`,
      `uptime_rollup_interval_seconds: int = 600` en el bloque de loops
      opt-in (junto a `fdsn_warmup_*` / `disk_alert_*`, líneas 78-102),
      con el MISMO comentario de "SOLO en el servicio api de Railway (los
      otros servicios comparten imagen y base y no deben competir por el
      upsert)". En `.env.example`, `UPTIME_ROLLUP_ENABLED` y
      `UPTIME_ROLLUP_INTERVAL_SECONDS` documentadas al lado de las de
      `DISK_ALERT_*`.
      *Aceptación*: `./venv/bin/python -c "from src.config.settings import settings; print(settings.uptime_rollup_enabled, settings.uptime_rollup_interval_seconds)"` ⇒ `False 600`.
      *Verificación*: el comando de arriba; `rg -n "UPTIME_ROLLUP" .env.example` ⇒ 2 matches.
      *Mutación*: NO — declaración de config; la protege 1.8 (lifespan).
- [x] 1.5 (RED) Tests de integración de `rollup_once` contra Postgres real.
      *Nota (2026-09-05)*: el caso (b) afirma `upserted == 1` en la segunda
      corrida, no `2`: el piso `max(bucket_start)` hace que SOLO se relea
      la hora parcial (invariante del design "nunca relee más atrás del
      último bucket"). Verificado contra Postgres.
      *Archivos*: crea `tests/integration/test_station_uptime_rollup.py`.
      *Qué*: fixture que crea `spectrogram_columns` A MANO en el
      testcontainer (SOLO las columnas que el rollup lee: `channel TEXT,
      endtime TIMESTAMPTZ`; documentar en el docstring que la 001 de
      Timescale NO corre en la suite y que el rollup solo depende de esas
      dos columnas + el índice). Casos con SELECT posterior: (a) 900 filas
      de `GE.KBU..BHZ` en la hora `H` y 450 en `H+1` ⇒ `rollup_once` deja
      `{H: 900, H+1: 450}` y devuelve `2`; (b) segundo `rollup_once` sin
      cambios es idempotente (mismas filas, mismo conteo); (c) agregar 100
      filas a `H+1` y volver a correr ⇒ `550` (sobrescribe, no acumula —
      escenario "reescribe la hora parcial"); (d) tabla con último
      `bucket_start` hace 5 h y raw en las 5 horas intermedias ⇒ tras
      `rollup_once` las 5 horas tienen fila (escenario "hueco se rellena
      solo"); (e) raw de hace 8 días NO produce fila (tope de 7 días); (f)
      dos canales en la misma hora ⇒ dos filas.
      *Aceptación*: rojo por módulo inexistente.
      *Verificación*: `./venv/bin/python -m pytest tests/integration/test_station_uptime_rollup.py -q`.
      *Mutación*: no aplica (es el test; sus mutaciones van en 1.9).
- [x] 1.6 (RED) Test unitario del loop: aislamiento por ciclo y parada limpia.
      *Archivos*: crea `tests/unit/test_station_uptime_loop.py` (molde
      `tests/unit/test_disk_alert.py` / `test_watchdog_loop.py`).
      *Qué*: con `rollup_once` parcheado para lanzar en el primer ciclo y
      devolver `3` en el segundo, `run_uptime_rollup_loop(pool,
      interval_seconds=0.01, stop_event)` (a) NO propaga la excepción, (b)
      loguea `warning` con `caplog`, (c) llega al segundo ciclo, (d)
      termina en < 1 s al setear `stop_event` (escenario "fallo de Postgres
      no tumba el loop"). También `EXPECTED_COLUMNS_PER_HOUR == 3600 //
      COLUMN_INTERVAL_SECONDS` comparando contra el import de
      `src.services.seedlink_ingestor`, NO contra `900`.
      *Aceptación*: rojo por módulo inexistente.
      *Verificación*: `./venv/bin/python -m pytest tests/unit/test_station_uptime_loop.py -q`.
      *Mutación*: no aplica (es el test).
- [x] 1.7 (GREEN) Crear `src/services/station_uptime.py` (rollup + loop).
      *Archivos*: crea `src/services/station_uptime.py`.
      *Qué*: `EXPECTED_COLUMNS_PER_HOUR = 3600 // COLUMN_INTERVAL_SECONDS`
      (import de `seedlink_ingestor`, derivada, no redeclarada);
      `_ROLLUP_SQL` EXACTO del design (`INSERT … SELECT channel,
      date_trunc('hour', endtime), count(*) … WHERE endtime >=
      GREATEST(now() - interval '7 days', COALESCE((SELECT max(bucket_start)
      FROM station_uptime_hourly), '-infinity'::timestamptz)) GROUP BY 1, 2
      ON CONFLICT (channel, bucket_start) DO UPDATE SET columns_count =
      EXCLUDED.columns_count`); `async def rollup_once(pool) -> int` que
      ejecuta el upsert y loguea `info` con filas y ms (la primera corrida
      en prod se mide con ese log, Migration/Rollout §3); `async def
      run_uptime_rollup_loop(pool, interval_seconds, stop_event)` calcado
      de `disk_alert.py:75-94` (try/except que envuelve TODO el ciclo,
      `asyncio.wait_for(stop_event.wait(), timeout=interval_seconds)`).
      `build_uptime_series` y `fetch_uptime` NO van acá todavía (Fase 2/3).
      *Aceptación*: 1.5 y 1.6 verdes.
      *Verificación*: `./venv/bin/python -m pytest tests/integration/test_station_uptime_rollup.py tests/unit/test_station_uptime_loop.py -q`.
      *Mutación*: las lleva 1.9 (M5, M6).
- [x] 1.8 Wiring en el lifespan de `src/main.py`.
      *Desvío menor (2026-09-05)*: sin el `elif` "sin db_pool" — `db_pool`
      se crea incondicionalmente en el lifespan (`main.py:364`) antes de
      llegar acá, así que esa rama sería código muerto.
      *Archivos*: modifica `src/main.py` (líneas ~482-505 y ~520-524).
      *Qué*: molde EXACTO de `disk_alert_task`: `uptime_rollup_task:
      Optional[asyncio.Task] = None`, `uptime_rollup_stop =
      asyncio.Event()`; si `settings.uptime_rollup_enabled` y hay
      `app.state.db_pool`, `create_task(run_uptime_rollup_loop(pool,
      interval_seconds=settings.uptime_rollup_interval_seconds,
      stop_event=uptime_rollup_stop))` + `logger.info` con la cadencia;
      `elif settings.uptime_rollup_enabled:` ⇒ `logger.warning` "sin
      db_pool, rollup apagado"; en el shutdown, `stop.set()`, `cancel()`,
      `await` con `suppress(CancelledError)`. Aditivo, sin tocar nada más.
      *Aceptación*: `./venv/bin/python -c "import src.main"` sin error;
      `rg -n "uptime_rollup" src/main.py` ⇒ arranque Y parada presentes.
      *Verificación*: los dos comandos + `./venv/bin/python -m pytest tests/unit/test_station_rsam_endpoint.py -q` (el módulo sigue importando y el endpoint vecino no cambió).
      *Mutación*: NO — cableado sin lógica; el aislamiento del loop lo
      prueba 1.6 y el arranque real lo prueba 7.3 en prod.
- [x] 1.9 **Mutaciones críticas del rollup** + gate de fase.
      *Archivos*: `src/services/station_uptime.py` (mutar y REVERTIR).
      | # | Mutación | Test que DEBE morir |
      |---|---|---|
      | M5 | `ON CONFLICT … DO UPDATE SET …` → `ON CONFLICT … DO NOTHING` | caso (c) de 1.5: `H+1` queda en `450`, no `550` |
      | M6 | `GREATEST(now() - interval '7 days', COALESCE(...))` → `now() - interval '2 hours'` | caso (d) de 1.5: quedan 3 horas sin fila |
      *Aceptación*: 2 filas en `mutation-log.md` con `rg`, rojo con la
      aserción exacta, reversión por `cmp`, verde. Luego `ruff format` +
      `ruff check` limpios sobre los archivos nuevos/tocados; `git diff
      --stat -- src/services/watchdog.py src/services/seedlink_ingestor.py`
      vacío.
      *Verificación*: `./venv/bin/python -m pytest tests/integration/test_station_uptime_migration.py tests/integration/test_station_uptime_rollup.py tests/unit/test_station_uptime_loop.py -q && ./venv/bin/ruff check src/services/station_uptime.py src/config/settings.py src/main.py tests/integration/test_station_uptime_migration.py tests/integration/test_station_uptime_rollup.py tests/unit/test_station_uptime_loop.py`.
      *Nota de rollout*: esta fase es un PR mergeable por sí sola ("feat:
      rollup horario de uptime por canal"). Si el usuario lo aprueba,
      deployar YA con `UPTIME_ROLLUP_ENABLED=true` SOLO en el servicio
      `api` de Railway (7.3): cada día que pasa antes del panel es un día
      más de historia. Sin la variable, la tabla queda vacía y nada rompe.

---

## Phase 2: Backend — lógica pura (b-value, tremor, serie de uptime) + constantes

**Estado al cerrar la fase**: las 7 constantes nuevas en
`seismic-constants.json`; `gutenberg_richter.py`, `tremor.py` y
`build_uptime_series` implementados por TDD contra los escenarios de la spec
de `signal-analysis` con valores calculados a mano; mutaciones M1, M2, M3,
M7, M10, M11, M12, M13 registradas.

- [x] 2.1 Constantes nuevas en el JSON compartido.
      *Archivos*: modifica `dashboard/lib/seismic-constants.json`.
      *Qué*: agregar `bValueMinEvents: 50`, `magnitudeBinWidth: 0.1`,
      `mcCorrection: 0.2`, `tremorBaselineFactor: 2.0`,
      `tremorMinDurationPeriods: 3`, `tremorLowBandMaxHz: 2.0`,
      `tremorMidBandMaxHz: 5.0` (Decision 7). NO copiar
      `RSAM_PERIOD_SECONDS` ni `COLUMN_INTERVAL_SECONDS` (ya tienen fuente
      en Python).
      *Aceptación*: `./venv/bin/python -c "import json; c=json.load(open('dashboard/lib/seismic-constants.json')); print(c['bValueMinEvents'], c['tremorMinDurationPeriods'])"` ⇒ `50 3`; los tests existentes que leen el JSON (`test_fdsn_warmup.py`, `lib/signal-picks.test.ts`, `lib/helicorder-layout.test.ts`) siguen verdes.
      *Verificación*: el comando + `./venv/bin/python -m pytest tests/unit/test_fdsn_warmup.py tests/unit/test_signal_picks_formulas.py -q`.
      *Mutación*: las lleva 2.9 (M1, M7, M10 mutan ESTE archivo).
- [x] 2.2 (RED) Tests del b-value con los escenarios de la spec.
      *Archivos*: crea `tests/unit/test_gutenberg_richter.py` (molde
      `tests/unit/test_signal_picks_formulas.py`; helper que construye el
      catálogo sintético `round(10^(a − b·M))` por bin).
      *Qué*: (a) catálogo `a=6.0, b=1.0`, M 2.0..6.0 (N=48 617) con
      `mc=2.0` ⇒ `status == "ok"`, `method == "aki-utsu-mle"`,
      `n_above_mc == 48617`, `0.90 <= b <= 1.10` (esperado a mano 0.9963;
      la tolerancia deja AFUERA el 1.1254 sin Utsu — R29); (b) catálogo
      `a=8.0, b=1.5` (N=342 402) ⇒ `1.40 <= b <= 1.60` (1.4853); (c) recorte
      a `M >= M_cut` construido DESDE `MIN_EVENTS` importado (con 50 es
      `M_cut=5.0`, n=45) con `mc=M_cut` ⇒ `insufficient`, `not hasattr(r,
      "b")`, `n_above_mc == 45`, `min_events == MIN_EVENTS`; (d) 1 000
      eventos con exactamente `MIN_EVENTS−1` sobre `mc=3.0` ⇒
      `insufficient`, `n_above_mc == MIN_EVENTS−1`, `n_total == 1000`; (e)
      vacío con `mc=None` y con `mc=2.0` ⇒ `insufficient`, `n_total == 0`,
      `mc is None` en el primero, sin excepción; (f) `MIN_EVENTS+10` todos
      `3.0` con `mc=3.0` ⇒ `degenerate`, sin `b`; (g) catálogo b=1.0 con
      `mc=None` ⇒ `mc == 2.2` (MAXC 2.0 + 0.2), `mc_at_catalog_floor is
      True`, `b` en `[0.90, 1.10]`; (h) `magnitude_bins` devuelve `count`
      exacto por bin y `cumulative` = N(M ≥ m); (i) `mag_type_counts`
      (función auxiliar sobre `SeismicEvent`) cuenta `None` como
      `"unknown"`; (j) `MIN_EVENTS`, `BIN_WIDTH`, `MC_CORRECTION` iguales a
      lo leído del JSON en el propio test (molde `test_fdsn_warmup.py:67-80`).
      *Aceptación*: rojo por módulo inexistente.
      *Verificación*: `./venv/bin/python -m pytest tests/unit/test_gutenberg_richter.py -q`.
      *Mutación*: no aplica (es el test).
- [x] 2.3 (GREEN) Crear `src/services/gutenberg_richter.py`.
      *Archivos*: crea `src/services/gutenberg_richter.py`.
      *Qué*: carga del JSON con el patrón EXACTO de `signal_picks.py:29-40`
      (acceso por clave sin `.get`); `METHOD = "aki-utsu-mle"`;
      `magnitude_bins(mags)`; `estimate_mc_maxc(bins) -> (mc, at_floor)`;
      `fit_b_value(mags, mc=None) -> BValueFit` (dataclass o par de
      dataclasses `BValueOkFit` / `BValueNotEstimableFit` — lo que haga que
      el atributo `b` NO exista en el segundo): Aki `b = log10(e) /
      (mean(M*) − (Mc − ΔM/2))`, Shi & Bolt `σ_b = 2.30 · b² ·
      sqrt(Σ(Mi−mean)² / (N·(N−1)))`, `a = log10(N) + b·Mc`; guardas en este
      orden: vacío ⇒ insufficient; `n_above_mc < MIN_EVENTS` ⇒ insufficient;
      varianza cero ⇒ degenerate. Determinista, sin I/O. Docstring en
      español con las referencias (Aki 1965, Utsu 1965, Shi & Bolt 1982,
      Wiemer & Wyss 2000).
      *Aceptación*: 2.2 verde completo.
      *Verificación*: mismo comando de 2.2.
      *Mutación*: las lleva 2.9 (M1, M2, M3, M13).
- [x] 2.4 (RED) Tests del clasificador de tremor (capa 1, pura).
      *Archivos*: crea `tests/unit/test_tremor.py`.
      *Qué*: helper `series(values)` que produce `[(t0 + i·600 s, v)]`.
      Escenarios de la spec: (a) 100 × 40.0 ⇒ `episodes == []`,
      `tremor_fraction == 0.0`, `baseline_rsam == 40.0`, `threshold_rsam ==
      40.0 · BASELINE_FACTOR`; (b) pico aislado en la 50 (`40 ·
      BASELINE_FACTOR · 10`) ⇒ sin episodios; (c) meseta 20-39 a `40 ·
      BASELINE_FACTOR · 2` ⇒ 1 episodio, `start == t[20]`, `end == t[39]`,
      `samples == 20`, `mean_ratio == 2 · BASELINE_FACTOR` (±1e-9),
      `tremor_fraction == 0.20`; (d) misma meseta con `None` en la 30 ⇒ 2
      episodios (20-29, 31-39), `tremor_fraction ≈ 19/99` (±0.001 — NO
      19/100); (e) vacía y toda `None` ⇒ `[]`, `baseline_rsam is None`,
      `threshold_rsam is None`, `0.0`, sin excepción; (f) `parameters ==
      {baseline_factor: BASELINE_FACTOR, min_duration_periods:
      MIN_DURATION_PERIODS}`; (g) constantes iguales al JSON leído en el
      test. Los valores esperados se derivan de la definición (mediana), en
      el test, no copiados.
      *Aceptación*: rojo por módulo inexistente.
      *Verificación*: `./venv/bin/python -m pytest tests/unit/test_tremor.py -q`.
      *Mutación*: no aplica (es el test).
- [x] 2.5 (GREEN) Crear `src/services/tremor.py` — capa 1.
      *Archivos*: crea `src/services/tremor.py`.
      *Qué*: carga del JSON (mismo patrón); `classify_episodes(samples) ->
      TremorClassification` con la lógica EXACTA del design Decision 4
      (mediana de los no nulos; `None` corta la corrida y no cuenta en el
      denominador; corrida ≥ `MIN_DURATION_PERIODS`; por episodio `start`,
      `end`, `samples`, `mean_ratio`, `peak_rsam`, `peak_ratio`,
      `onset_ratio`). Sin numpy obligatorio: es una lista de floats.
      *Aceptación*: 2.4 verde.
      *Verificación*: mismo comando de 2.4.
      *Mutación*: las lleva 2.9 (M7, M10, M11).
- [x] 2.6 (RED→GREEN) `characterize(signal, fs, start)` — capa 2.
      *Archivos*: modifica `tests/unit/test_tremor.py`; modifica
      `src/services/tremor.py`.
      *Qué (RED primero)*: señal sintética `fs=20`, 4 h (288 000 muestras):
      ruido uniforme de amplitud 1 + 40 min (4 períodos alineados a los
      cortes de 600 s) de amplitud ×3 con tono a 1.5 Hz ⇒ 1 episodio,
      `samples == 4`, `duration_s == 2400`, `band == "low"`; 20 min ⇒ 0
      episodios; tono a 8 Hz ⇒ `band == "high"`; rampa vs escalón ⇒
      `onset_ratio` menor en la rampa; `samples[i]["rsam"] ==
      rsam_series(signal, fs)[i]` para todo `i` y `len(samples) == 24`; `t`
      es el CENTRO de la ventana (`start + (i + 0.5)·600 s`). Luego
      implementar: `rsam_series` + `classify_episodes` + por período
      `window_spectrum_db` → `dominant_frequency_hz` / `frequency_index`
      (imports de `swarm_spectra.py:96,113`, `signal_spectrum.py:22`);
      `band` por `LOW_BAND_MAX_HZ`/`MID_BAND_MAX_HZ`, `"undefined"` si
      `mean_dominant_hz is None`; `fi_sign` por signo de `mean_fi`.
      *Aceptación*: `test_tremor.py` verde completo.
      *Verificación*: `./venv/bin/python -m pytest tests/unit/test_tremor.py -q`.
      *Mutación*: cubierta por M7/M10 (la capa 2 delega en la 1).
- [x] 2.7 (RED) Tests de `build_uptime_series` (pura).
      *Archivos*: crea `tests/unit/test_station_uptime.py`.
      *Qué*: filas `(channel, bucket_start, count)` y ventana explícita;
      escenarios de la spec: (a) 900 en 2 h ⇒ 2 buckets `ratio == 1.0`,
      `expected == EXPECTED_COLUMNS_PER_HOUR`, `overall == 1.0`; (b) 450 ⇒
      `0.5`, 950 ⇒ `1.0` (clamp); (c) filas solo en la 1.ª hora de 2 ⇒
      2.º bucket `ratio is None`, `observed_hours == 0` (NO `0.0` — `is
      None`); (d) `IU.MAJO.00.BHZ` en H y H+1, `GE.KBU..BHZ` solo en H ⇒
      `GE.KBU..BHZ[H+1].ratio == 0.0` (no None); (e) `channels=["XX.NOPE..BHZ"]`
      ⇒ todos `None`, `overall is None`; (f) `bucket="day"` con 18 horas
      observadas ⇒ `observed_hours == 18`, `expected == 900·18`, `ratio ==
      1.0`; (g) ventana de 2 h con filas solo en una ⇒ EXACTAMENTE 2
      buckets; (h) `in_progress` solo en el bucket que contiene `now`; (i)
      `channels=None` ⇒ los canales presentes en `rows`.
      *Aceptación*: rojo por función inexistente.
      *Verificación*: `./venv/bin/python -m pytest tests/unit/test_station_uptime.py -q`.
      *Mutación*: no aplica (es el test).
- [x] 2.8 (GREEN) `build_uptime_series` en `station_uptime.py`.
      *Archivos*: modifica `src/services/station_uptime.py`.
      *Qué*: la firma del design; devuelve los modelos de `src/models/analytics.py`
      (creados en 3.1 — si esta tarea se ejecuta antes, devolver dataclasses
      internas y mapear en 3.1; NO duplicar lógica). Regla `[R12]` completa.
      *Aceptación*: 2.7 verde.
      *Verificación*: mismo comando de 2.7.
      *Mutación*: la lleva 2.9 (M12).
- [x] 2.9 **Mutaciones críticas de la lógica pura** + gate de fase.
      *Archivos*: `dashboard/lib/seismic-constants.json`,
      `src/services/gutenberg_richter.py`, `src/services/tremor.py`,
      `src/services/station_uptime.py` (mutar y REVERTIR; `rm -rf
      src/services/__pycache__` entre corridas).
      | # | Mutación | Test que DEBE morir |
      |---|---|---|
      | M1 | `bValueMinEvents: 50 → 5` en el JSON | 2.2(c): 45 eventos pasan a `ok` ⇒ el backend lee el JSON, no una copia |
      | M2 | Quitar `- BIN_WIDTH / 2` de la fórmula de b | 2.2(a): `b = 1.1254` queda fuera de `[0.90, 1.10]` |
      | M3 | `status = "ok"` incondicional (saltear la guarda de N) | 2.2(c)/(d): aparece `b` donde no debe |
      | M13 | Contar `n_above_mc` sobre el catálogo completo | 2.2(d): 1 000 eventos pasan a `ok` |
      | M7 | `tremorMinDurationPeriods: 3 → 1` en el JSON | 2.4(b): el pico aislado pasa a ser episodio |
      | M10 | `tremorBaselineFactor: 2.0 → 6.0` en el JSON | 2.4(c): la meseta (160) queda bajo 240 ⇒ sin episodio |
      | M11 | En `classify_episodes`, tratar `None` como `0.0` | 2.4(d): `tremor_fraction` da 19/100, fuera de ±0.001 |
      | M12 | En `build_uptime_series`, `None` → `0.0` para hora no observada | 2.7(c): `is None` falla |
      *Aceptación*: 8 filas en `mutation-log.md` con `rg`, rojo con la
      aserción exacta, reversión por `cmp` contra snapshot, verde. Luego
      `ruff format` + `ruff check` limpios sobre los 3 módulos y 3 tests.
      *Verificación*: `./venv/bin/python -m pytest tests/unit/test_gutenberg_richter.py tests/unit/test_tremor.py tests/unit/test_station_uptime.py tests/unit/test_station_uptime_loop.py -q && ./venv/bin/ruff check src/services/gutenberg_richter.py src/services/tremor.py src/services/station_uptime.py tests/unit/test_gutenberg_richter.py tests/unit/test_tremor.py tests/unit/test_station_uptime.py && git diff --stat -- dashboard/lib/seismic-constants.json` (el diff del JSON debe ser SOLO las 7 claves nuevas, sin la mutación).

---

## Phase 3: Backend — modelos, `EventStore.between`, router `/analytics` (TDD + mutación)

**Estado al cerrar la fase**: los 4 endpoints responden con los contratos
del design; `curl` contra un testcontainer prueba 200/422/503/404; los
archivos protegidos sin cambios; M4 registrada.

- [x] 3.1 (RED→GREEN) Modelos Pydantic de `src/models/analytics.py`.
      *Resultado real (2026-09-06)*: RED por `ModuleNotFoundError`; GREEN 41
      passed. Además se cerró el mapeo que 2.8 dejó pendiente:
      `build_uptime_series` devuelve `StationUptimeResponse`/`UptimeBucket`
      (firma del design) y los dataclasses `UptimeBucketData`/`UptimeSeriesData`
      desaparecen — `test_station_uptime.py` sigue verde sin tocarlo.
      *Archivos*: crea `tests/unit/test_analytics_models.py`; crea
      `src/models/analytics.py`; modifica `src/services/station_uptime.py`.
      *Qué (RED primero)*: `BValueOk` requiere `b`, `a`, `sigma_b` y
      `status == "ok"`; `BValueNotEstimable` rechaza `status == "ok"` y NO
      declara `b` (`"b" not in BValueNotEstimable.model_fields`); el
      `TypeAdapter(BValueResponse)` discrimina por `status` y al serializar
      un `BValueNotEstimable` el dict NO contiene `"b"`; `UptimeBucket.ratio`
      admite `None`; `StationUptimeResponse.overall` admite `None` por
      canal; `TremorResponse.baseline_rsam` admite `None`; `TremorEpisode`
      exige `samples`, `mean_ratio`, `band`, `fi_sign` con los `Literal`
      del design. Luego crear el módulo con los modelos EXACTOS de
      "Interfaces / Contracts" (`MagnitudeBin`, `_BValueBase`, `BValueOk`,
      `BValueNotEstimable`, `BValueResponse`, `HypocentersResponse`,
      `UptimeBucket`, `StationUptimeResponse`, `TremorParameters`,
      `TremorEpisode`, `TremorResponse`).
      *Aceptación*: el test pasa completo.
      *Verificación*: `./venv/bin/python -m pytest tests/unit/test_analytics_models.py -q`.
      *Mutación*: NO — la ausencia de `b` se vuelve a afirmar end-to-end en 3.5.
- [x] 3.2 (RED) Tests de integración de `EventStore.between`.
      *Resultado real (2026-09-06)*: RED observado — 8 tests de `TestBetween`
      mueren por `AttributeError: 'EventStore' object has no attribute
      'between'` (no por setup). Además de (a)–(f): combinación de los tres
      filtros (la consulta real del b-value) y lista vacía.
      *Archivos*: modifica `tests/integration/test_event_store.py`
      (fixture `event_store` existente).
      *Qué*: sembrar eventos con lat/lon dentro y fuera de un bbox, dentro
      y fuera de la ventana, magnitudes distintas y uno con `prof_km=None`:
      (a) `between(start, end)` respeta la ventana; (b) `bbox=(minlat,
      maxlat, minlon, maxlon)` filtra en SQL; (c) `min_magnitude` filtra;
      (d) `order_by_magnitude=True, limit=2` devuelve las DOS mayores en
      orden descendente (desempate `hora_utc DESC`); (e)
      `order_by_magnitude=False` ⇒ `hora_utc DESC`; (f) `prof_km` nulo
      sobrevive.
      *Aceptación*: rojo por método inexistente.
      *Verificación*: `./venv/bin/python -m pytest tests/integration/test_event_store.py -q -k between`.
      *Mutación*: no aplica (es el test).
- [x] 3.3 (GREEN) `EventStore.between` en `src/services/event_store.py`.
      *Resultado real (2026-09-06)*: `test_event_store.py` entero ⇒ 25 passed
      (17 previos + 8 nuevos). M4 ya observada (ver `mutation-log.md`, Fase
      3) junto con 5 mutaciones extra por rama (bbox, `min_magnitude`, borde
      inferior de ventana, `limit`, desempate); 3.8 la repite contra
      `hypocenters?limit=5` cuando exista el router.
      *Archivos*: modifica `src/services/event_store.py`.
      *Qué*: la firma EXACTA del design (keyword-only `min_magnitude`,
      `bbox`, `limit`, `order_by_magnitude`), reusando `_COLUMNS` y
      `_row_to_event`; `WHERE hora_utc BETWEEN $1 AND $2` + `lat BETWEEN …
      AND lon BETWEEN …` si hay bbox + `mag >= …` si hay mínimo; `ORDER BY
      mag DESC, hora_utc DESC` o `hora_utc DESC`; `LIMIT` opcional.
      Docstring: etapa 1 del filtro de área (bbox); la etapa 2
      (`point_in_area`) la hace el caller. Los métodos existentes NO cambian
      (`test_event_store.py` entero sigue verde).
      *Aceptación*: 3.2 verde y el resto del archivo verde.
      *Verificación*: `./venv/bin/python -m pytest tests/integration/test_event_store.py -q`.
      *Mutación*: la lleva 3.8 (M4).
- [x] 3.4 (RED) Tests unitarios del endpoint de tremor (sin red).
      *Resultado real (2026-09-06)*: RED observado — los 9 tests que
      parchean mueren con `AttributeError: module 'src.api.routers' has no
      attribute 'analytics'` y los 5 de validación reciben `404` (ruta
      inexistente) donde esperan 422. La "traza constante" es la senoidal
      del molde de `/rsam` (RSAM constante): una DC pura da RSAM 0 tras el
      demean y `classify_episodes` ya la guarda como "sin señal". Además de
      lo pedido: el cache de `tremor:` no colisiona con el de `rsam:` y los
      tres casos del cache eterno en DB (cubierta/parcial/hit). GREEN 14.
      *Archivos*: crea `tests/unit/test_analytics_tremor_endpoint.py`
      (molde `tests/unit/test_station_rsam_endpoint.py`: `TestClient(app)`
      SIN `with`, `patch` de `get_spectrogram_service` — OJO: el router
      importa `get_spectrogram_service` desde `src.services.spectrogram_service`,
      así que el `patch` apunta a `src.api.routers.analytics.get_spectrogram_service`,
      no a `src.main.…`).
      *Qué*: SCNL de 3 partes ⇒ 422; sin `start`/`end` ⇒ 422; `end <= start`
      ⇒ 422; ventana de 25 h ⇒ 422 con `{"detail"}`; stream vacío ⇒ 404 con
      `{"detail"}` distinto de `"Not Found"`; traza constante ⇒ 200 con
      `episodes == []`, `tremor_fraction == 0.0`; traza sintética con
      meseta ⇒ `episodes` con 1 elemento y `parameters` iguales al JSON;
      **"tremor y tendencia comparten la serie"**: con la MISMA traza
      parcheada, `GET /analytics/tremor/{ch}` y `GET
      /stations/{ch}/rsam?period_seconds=600` devuelven `samples[i].rsam ==
      samples[i].value` y `samples[i].t` iguales para todo `i`.
      *Aceptación*: rojo por router inexistente (404 genérico).
      *Verificación*: `./venv/bin/python -m pytest tests/unit/test_analytics_tremor_endpoint.py -q`.
      *Mutación*: no aplica (es el test).
- [x] 3.5 (RED) Tests de integración del router (`b-value`, `hypocenters`,
      `station-uptime`).
      *Resultado real (2026-09-06)*: RED observado — 28 tests con `404`
      donde esperan 200/422/503 (no por setup). Desvíos documentados: (1) el
      seed de áreas NO tiene preset "andes" (tiene `global` y `japon`), así
      que el escenario "fuera del área activa" usa `japon` como área activa
      con `MIN_EVENTS+100` en los Andes (afuera) y `MIN_EVENTS−10` en Tokio
      (adentro) — misma falsabilidad, sin fabricar un área; (2) `EventStore`
      usa `self.pool.fetch()` sin `acquire`, y `TestClient` sin `with` corre
      cada request en un loop nuevo ⇒ `_LazyPool` (molde feedback) extendido
      con `fetch`/`fetchrow`/`execute` e inyectado como `store._pool`; la
      query es la real. Sembrado por `executemany` de psycopg2 (el `upsert`
      dedupearía 483 eventos en el mismo punto). Extra: "el filtro de canal
      no cambia qué es hora observada" (protege el SELECT de [R12]). GREEN 28.
      *Archivos*: crea `tests/integration/test_analytics_api.py` (molde
      `tests/integration/test_areas_api.py` para sesión + área;
      `test_api.py::test_report_*` para el área default; `_login_as` /
      `_auth_service_mock` de `test_feedback_api.py`).
      *Qué*: **b-value**: sin `event_store` ⇒ 503; base sembrada con el
      catálogo reducido `round(10^(4.0−M))` M 2.0..4.0 (483 eventos, un
      `executemany`) dentro del área default y la ventana, `?days=30&mc=2.0`
      ⇒ 200 `status == "ok"`, `method == "aki-utsu-mle"`, `0.90 <= b <=
      1.10`, `bins` con los conteos sembrados, `n_above_mc == 483`,
      `area_slug` del preset default; `MIN_EVENTS−1` eventos ⇒ 200
      `insufficient`, **`"b" not in body`**, `min_events == MIN_EVENTS`
      (importado); usuario con área custom "Andes" (`test_areas_api.py`) y
      `MIN_EVENTS+100` eventos en Japón + `MIN_EVENTS−10` en los Andes ⇒
      `insufficient` con `n_above_mc == MIN_EVENTS−10`; sin cookie ⇒ 200
      (no 401); `days=0` y `days=366` ⇒ 422. **hypocenters**: 10 en área +
      5 fuera + 3 fuera de ventana ⇒ `total == 10`, `truncated is False`;
      8 eventos con `limit=5` ⇒ 5 devueltos = los 5 de mayor magnitud en
      orden descendente, `total == 8`, `truncated is True`; `prof_km NULL`
      viaja como `null`; `limit=5001` ⇒ 422; adapters USGS/EMSC/INPRES
      parcheados para lanzar ⇒ sigue 200 (no consulta fuentes).
      **station-uptime**: sin `db_pool` ⇒ 503; filas sembradas
      directamente en `station_uptime_hourly` (900 en todas las horas de 7
      días para `GE.KBU..BHZ`) con `?days=7&bucket=day&channel=GE.KBU..BHZ`
      ⇒ 200, los días cerrados `ratio == 1.0`, `expected == 900·24`,
      `overall == 1.0`, `expected_columns_per_hour == 900` (comparado con
      el import); sin filas de ningún canal en el 3.er día ⇒ ese bucket
      `ratio` es `null` en el JSON y `observed_hours == 0`; `IU.MAJO.00.BHZ`
      en H y H+1 y `GE.KBU..BHZ` solo en H, `bucket=hour` ⇒ `GE.KBU..BHZ`
      en H+1 tiene `ratio == 0.0` (no null); `?days=30&bucket=hour` ⇒
      `bucket == "day"`; `days=366` ⇒ 422; filas de hace 10 días sin raw en
      `spectrogram_columns` ⇒ `ratio` numérico (sobrevive la retención).
      *Aceptación*: rojo por router inexistente. Fortalecer los 404/422
      "accidentales" con `detail != "Not Found"` como en
      `feedback-screenshot-attachment` 2.10.
      *Verificación*: `./venv/bin/python -m pytest tests/integration/test_analytics_api.py -q`.
      *Mutación*: no aplica (es el test).
- [x] 3.6 (GREEN) Crear `src/api/routers/analytics.py` y montarlo.
      *Resultado real (2026-09-06)*: 3.4 + 3.5 ⇒ 42 passed. Desvíos: (1)
      `hypocenters` NUNCA pone `LIMIT` en SQL (ni sin polígono): `total`
      tiene que contarse ANTES del corte y un `LIMIT` obligaría a una
      segunda query de conteo; el catálogo pesa ~1 MB/año. (2) `fetch_uptime`
      trae las filas de TODOS los canales de la ventana aunque se pidan
      pocos: "hora observada" es hora con fila de CUALQUIER canal ([R12]) y
      filtrar por `channel` en SQL convertiría `0.0` en `null` (test extra
      de 3.5 lo prueba). (3) `MAX_TREMOR_WINDOW_HOURS = 24` se declara en el
      router como espejo de `MAX_WAVEFORM_WINDOW_HOURS` (importarlo de
      `main` sería circular). (4) `samples[i].t` del tremor se formatea con
      la MISMA expresión que `/rsam` (`str(UTCDateTime)`) y `rsam` con el
      mismo `round(·, 2)` para la igualdad byte a byte del spec; los
      episodios llevan datetimes ISO de Pydantic. `response_model` en los 4.
      *Archivos*: crea `src/api/routers/analytics.py`; modifica
      `src/main.py` (línea ~598: `app.include_router(analytics_router.router)`);
      modifica `src/services/station_uptime.py` (`fetch_uptime`).
      *Qué*: `APIRouter(prefix="/analytics", tags=["analytics"])`, molde
      `stations.py`: `_get_event_store(request)` y `_get_db_pool(request)`
      con guard EXPLÍCITO del 503 (nada de asserts); `_resolve_area(request,
      user)` copiando `main.py:820-836` (`try` alrededor de
      `area_service.get_active(user.id)` / `get_default()`,
      `area_to_filter_dict`, `logger.exception` y `None` si falla) que
      devuelve `(area_filter, area_slug)`. Endpoints: `GET /b-value`
      (`days: int = Query(30, ge=1, le=365)`, `min_mag`, `mc`;
      `between(..., bbox=bbox_of(area_geometry))` + `point_in_area` en
      Python; `fit_b_value(mags, mc)`; `mag_type_counts`; `response_model=BValueResponse`);
      `GET /hypocenters` (`days`, `min_mag`, `limit: int = Query(2000, ge=1,
      le=5000)`; `between(order_by_magnitude=True)` SIN limit en SQL cuando
      hay polígono (la etapa 2 puede descartar), recorte en Python tras
      `point_in_area`, `total` antes del corte); `GET /station-uptime`
      (`days: int = Query(7, ge=1, le=365)`, `bucket`, `channel: list[str] =
      Query(None)`; `days > 14 ⇒ bucket="day"`; `fetch_uptime` hace el
      SELECT de la ventana y delega en `build_uptime_series`); `GET
      /tremor/{channel}` calcando `get_station_rsam` (`main.py:3021-3103`:
      validación SCNL de 4 partes, tz naive ⇒ UTC, `end <= start` ⇒ 422, > 24
      h ⇒ 422, `cache` en memoria por clave `tremor:{channel}:{start}~{end}`,
      `fdsn_result_cache` en DB, `get_spectrogram_service().get_waveform_data`,
      `trace = max(stream, key=npts)`, 404 si no hay traza, congelar solo si
      `trace_covers_window`), luego `characterize(signal, fs, start)`.
      *Aceptación*: 3.4 y 3.5 verdes completos.
      *Verificación*: `./venv/bin/python -m pytest tests/unit/test_analytics_tremor_endpoint.py tests/integration/test_analytics_api.py -q`.
      *Mutación*: la lleva 3.8.
- [x] 3.7 No-regresión de los contratos existentes.
      *Resultado real (2026-09-06)*: batería ⇒ `86 passed` sin tocar ningún
      test; `git diff --stat main` de los 3 protegidos vacío; `rg` de
      `analytics/rsam|rsam_samples|INSERT INTO rsam` en `src/` sin matches;
      `report()` sigue con `sources` + `current_user` únicamente.
      *Qué*: correr la batería previa de `/rsam`, `/report`, eventos y áreas
      SIN tocar ningún test; `git diff --stat main -- src/services/watchdog.py
      src/services/swarm_rsam.py src/services/seedlink_ingestor.py` vacío;
      `rg -n "analytics/rsam|INSERT INTO rsam" src/` sin matches; firma de
      `report()` en `src/main.py` intacta (`rg -n "async def report\(" -A 4
      src/main.py`).
      *Aceptación*: todo verde, diff vacío, sin matches.
      *Verificación*: `./venv/bin/python -m pytest tests/unit/test_station_rsam_endpoint.py tests/integration/test_api.py tests/integration/test_areas_api.py tests/integration/test_event_store.py tests/unit/test_watchdog_loop.py -q`.
      *Mutación*: no aplica.
- [x] 3.8 **Mutación crítica del router/store** + gate de fase.
      *Resultado real (2026-09-06)*: M4 a nivel endpoint observada (segundo
      intento — el primero NO mató nada: el test de `limit=5` tenía el orden
      temporal invertido y `hora_utc DESC` devolvía los mismos cinco; se
      arregló el test, nunca se anotó como pasada) + 5 mutaciones extra
      (XR1–XR5, una por rama crítica del router; XR1 también necesitó un
      segundo intento: con el preset `japon` — un rectángulo — la etapa 2
      nunca decide distinto que el bbox, por eso el área activa pasó a ser un
      triángulo custom "Andes"). Gate: suite completa sin `-x` ⇒ `9 failed,
      1384 passed, 2 skipped` (+42 sobre 1342; los 9 son `test_ws_events.py`);
      `ruff check`/`format --check` limpios en los 7 archivos; protegidos sin
      diff. Detalle en `mutation-log.md`.
      *Archivos*: `src/services/event_store.py` (mutar y REVERTIR).
      | # | Mutación | Test que DEBE morir |
      |---|---|---|
      | M4 | `ORDER BY mag DESC, hora_utc DESC` → `ORDER BY hora_utc DESC` con `order_by_magnitude=True` | 3.2(d) y 3.5 `hypocenters?limit=5`: dejan de venir los 5 mayores |
      *Aceptación*: 1 fila más en `mutation-log.md`; `ruff format` + `ruff
      check` limpios en `analytics.py`, `models/analytics.py`,
      `event_store.py`, `station_uptime.py`, `main.py` y los tests nuevos;
      suite backend COMPLETA contra la baseline de 1.1 (delta = solo tests
      nuevos, cero regresiones).
      *Verificación*: `./venv/bin/python -m pytest tests/ -q -p no:cacheprovider --no-cov` + `./venv/bin/ruff check src/api/routers/analytics.py src/models/analytics.py src/services/event_store.py src/services/station_uptime.py src/main.py tests/unit/test_analytics_models.py tests/unit/test_analytics_tremor_endpoint.py tests/integration/test_analytics_api.py`.

---

## Phase 4: Frontend — tipos, fetchers y libs puras (TDD)

**Estado al cerrar la fase**: `dashboard/lib/analytics.ts` con tipos espejo
y 4 fetchers; 5 libs puras con tests que afirman `null` ≠ `0`, orden y
bordes; ningún componente todavía.

- [x] 4.1 Baseline frontend + tipos y fetchers.
      *Resultado real (2026-09-06)*: baseline de HOY en `mutation-log.md`
      (`102 files / 1135 tests`, `tsc` exit 0). RED observado: `Failed to
      resolve import "./analytics"`. GREEN 15 passed. Desvíos: (1) el
      `request<T>` NO devuelve `null` en 401 como `feedback.ts`: los cuatro
      endpoints son públicos (`get_current_user_optional`), así que un 401
      es una anomalía y se lanza como cualquier `!ok`; (2) `getTremor`
      devuelve `TremorResult = {kind:'data', data} | {kind:'no-data',
      detail}`; (3) `getStationUptime` con `[]` manda la URL sin `channel=`
      (= todos), documentado en el test; (4) `TremorSample` tipado (no
      `dict`): `t` con 6 decimales como `/rsam`, `dominant_hz`/`fi`
      `number | null`. Mutaciones extra MF9/MF10 (no exigidas) en el log.
      *Archivos*: crea `dashboard/lib/analytics.ts`; crea
      `dashboard/lib/analytics.test.ts` (molde `lib/feedback.test.ts` /
      `lib/walls.test.ts` con `mockFetch`).
      *Qué*: registrar en `mutation-log.md` la baseline de HOY de `vitest
      run` y `tsc --noEmit` (si no quedó en 1.1). Tipos TS espejo de
      `src/models/analytics.py` (`BValueResponse = BValueOk |
      BValueNotEstimable` discriminado por `status`; `UptimeBucket.ratio:
      number | null`; etc.). Fetchers `getBValue(days, minMag?, mc?)`,
      `getHypocenters(days, minMag?, limit?)`, `getStationUptime(days,
      bucket, channels?)` (repite `channel=` por canal), `getTremor(channel,
      window)` con `credentials: 'include'` y el `request<T>` local de
      `lib/feedback.ts`; 404 en `getTremor` ⇒ resultado tipado `{kind:
      'no-data'}` (no excepción), otros `!ok` ⇒ `ApiStatusError`. Tests
      (RED primero): URL exacta con query params, `channel` repetido,
      404 → `no-data`, 503 → error.
      *Aceptación*: test verde; `tsc --noEmit` exit 0.
      *Verificación*: `cd dashboard && ./node_modules/.bin/vitest run lib/analytics.test.ts && ./node_modules/.bin/tsc --noEmit`.
      *Mutación*: NO — contrato con fetch mockeado; la lógica vive en las libs.
- [x] 4.2 (RED→GREEN) `dashboard/lib/b-value-plot.ts`.
      *Resultado real (2026-09-06)*: RED `Failed to resolve import
      "./b-value-plot"` (los 5 libs en UNA corrida antes de crear ninguno);
      GREEN 16 passed. Extras sobre lo pedido: `maxBinMagnitude(bins)`
      (`null` sin bins) para el `maxM` de la recta; `fittedLinePoints` con
      `maxM <= mc` corre el 2.º punto un bin a la derecha (nunca longitud
      cero) y con un parámetro no finito devuelve `[]`; `formatB` devuelve
      `{b, sigma}` o `null` si algo no es finito (nunca "NaN").
      `notEstimableMessageArgs` acepta `BValueResponse` y devuelve `null`
      con `status === "ok"`. Mutaciones MF6/MF7 en el log (no exigidas).
      *Archivos*: crea `dashboard/lib/b-value-plot.test.ts`; crea
      `dashboard/lib/b-value-plot.ts`.
      *Qué*: `toFmdRows(bins)` ⇒ `{m, count, cumulative, log10Cumulative:
      number | null}` con `null` (NO `-Infinity`) para `cumulative === 0`;
      `fittedLinePoints(a, b, mc, maxM)` ⇒ dos puntos, el primero
      EXACTAMENTE `(mc, a − b·mc)`; `notEstimableMessageArgs(result)` ⇒
      `{n: n_above_mc, min: min_events}` y `kind: 'insufficient' |
      'degenerate'`; `formatB(b, sigma)` ⇒ `"1.00"`/`"0.00"` para
      `0.9963`/`0.0047` (Decisión 8 de la spec). Importa `magnitudeBinWidth`
      del JSON para el ancho de barra (test: igual al JSON leído).
      *Aceptación*: test verde.
      *Verificación*: `cd dashboard && ./node_modules/.bin/vitest run lib/b-value-plot.test.ts`.
      *Mutación*: NO — cubierto por M8 en el componente (5.7).
- [x] 4.3 (RED→GREEN) `dashboard/lib/uptime-series.ts`.
      *Resultado real (2026-09-06)*: RED por import; GREEN 13 passed.
      `rankStations` ⇒ `B, D, A, C` con el fixture de la spec, estable con
      empates y varios `null`; `stationTimeline` lleva `bucket_start` a ms
      epoch, ordena por `t`, descarta un `bucket_start` imparseable (una
      fila `t: NaN` rompe el eje) y afirma `toBeNull()` en el hueco;
      `percentLabel(NaN)` ⇒ `null`. Mutaciones MF3 (null primero) y MF4
      (`null` ⇒ "0 %") en el log, ambas muertas por la aserción predicha.
      *Archivos*: crea `dashboard/lib/uptime-series.test.ts`; crea
      `dashboard/lib/uptime-series.ts`.
      *Qué*: `rankStations(overall)` ⇒ peor primero, estable, los `null` al
      final con `kind: 'unobserved'` (spec: `{A:0.9, B:0.3, C:null, D:0.6}`
      ⇒ `B, D, A, C`); `stationTimeline(response, channel)` ⇒ filas `{t,
      ratio: number | null, inProgress, observedHours, expected}` sin
      convertir `null` en `0` (test con `toBeNull()`); `percentLabel(ratio)`
      ⇒ `"0 %"` para `0` y `null` para `null` (el componente elige la
      etiqueta i18n "sin observación").
      *Aceptación*: test verde.
      *Verificación*: `cd dashboard && ./node_modules/.bin/vitest run lib/uptime-series.test.ts`.
      *Mutación*: NO — M12 protege el backend; acá el test `toBeNull()` es la aserción.
- [x] 4.4 (RED→GREEN) `dashboard/lib/tremor-episodes.ts`.
      *Resultado real (2026-09-06)*: RED por import; GREEN 11 passed.
      Desvío documentado: `x1`/`x2` y `t` van en **ms epoch** (no el string
      crudo): `samples[i].t` llega con 6 decimales (`str(UTCDateTime)`, dato
      REAL de prod) y `episodes[].start/end` como ISO de Pydantic — en un eje
      X numérico de Recharts tienen que compartir dominio, y como strings el
      mismo instante en dos formatos no colapsaría. El test afirma
      `x1 === Date.UTC(...)` exacto y acepta `Z` y `+00:00`. Las claves i18n
      son relativas al namespace `analytics` (`tremor.band.low`).
      `TREMOR_BASELINE_FACTOR` se exporta SOLO para la leyenda; MF8
      (recalcular `baseline × factor`) muere con `expected 80 to be 123`.
      *Archivos*: crea `dashboard/lib/tremor-episodes.test.ts`; crea
      `dashboard/lib/tremor-episodes.ts`.
      *Qué*: `episodesToReferenceAreas(episodes)` ⇒ `{x1: start, x2: end}`
      por episodio (2 episodios ⇒ 2 áreas con esos bordes exactos);
      `bandLabelKey(band)` / `fiSignLabelKey(fiSign)` ⇒ claves i18n;
      `thresholdLine(response)` ⇒ `response.threshold_rsam` tal cual (NO
      recalcular `baseline × factor` en el cliente; test: con
      `threshold_rsam: 123` devuelve `123` aunque `baseline_rsam × factor`
      dé otra cosa); `samplesToRows(samples)` ⇒ `{t, rsam, dominantHz, fi}`.
      *Aceptación*: test verde.
      *Verificación*: `cd dashboard && ./node_modules/.bin/vitest run lib/tremor-episodes.test.ts`.
      *Mutación*: no aplica.
- [x] 4.5 (RED→GREEN) `dashboard/lib/hypocenter-markers.ts`.
      *Resultado real (2026-09-06)*: RED por import; GREEN 13 passed. Dato
      REAL de prod incorporado: `hypocenters` devuelve `prof_km` NEGATIVO
      (`-35.0`, EMSC/USGS, sobre el nivel del mar) además de `null`. Regla:
      negativo ES profundidad (superficial, color de `< 70 km`); SOLO
      `null`/no finito es "sin profundidad" (test explícito para `-35` y
      para `NaN`). M14 ya observada acá como MF5 (la guarda de `null`
      salteada ⇒ `expected 'depth' to be 'no-depth'`); 5.7 la repite sobre
      el componente. `popupArgs` lleva además `magType` e `id`.
      *Archivos*: crea `dashboard/lib/hypocenter-markers.test.ts`; crea
      `dashboard/lib/hypocenter-markers.ts`.
      *Qué*: `markerRadius(mag)` monótona creciente con un mínimo visible;
      `markerStyle(ev)` ⇒ con `prof_km: 50` `fillColor === getDepthColor(50)`;
      con `prof_km: null` ⇒ `kind: 'no-depth'`, `fillOpacity: 0`,
      `dashArray` definido y `fillColor !== getDepthColor(0)` (R26 / M14);
      `truncationNotice(total, shown)` ⇒ `{total, shown}` solo si `total >
      shown`, si no `null`; `popupArgs(ev)` ⇒ profundidad `null` ⇒ `depth:
      null` (el componente muestra "sin profundidad").
      *Aceptación*: test verde.
      *Verificación*: `cd dashboard && ./node_modules/.bin/vitest run lib/hypocenter-markers.test.ts`.
      *Mutación*: la lleva 5.7 (M14).
- [x] 4.6 (RED→GREEN) `dashboard/lib/rsam-trend.ts`.
      *Resultado real (2026-09-06)*: RED por import; GREEN 12 passed. Los 3
      escenarios de la spec + `t` en ms epoch (el mismo instante como `Z` y
      `+00:00` es UNA fila — test), `value` no finito ⇒ `null`, `t`
      imparseable descartado, orden por `t` aunque un canal venga
      desordenado. `signalWindowFromHours` devuelve `{start, end}` ISO Y
      `{startMs, endMs}` (la forma `TimeWindow` de los fetchers); lanza con
      `h > 24`, `h <= 0` y `NaN`. MF1 (hueco ⇒ `0`) muere con `expected +0
      to be null` (R27); MF2b (canal rechazado en `channels`) con `expected
      true to be false` sobre `'B' in row`.
      *Archivos*: crea `dashboard/lib/rsam-trend.test.ts`; crea
      `dashboard/lib/rsam-trend.ts`.
      *Qué*: `mergeSeriesByTime(settled)` sobre resultados de
      `Promise.allSettled` etiquetados por canal ⇒ filas `{t, [channel]:
      number | null}` ordenadas por `t`: escenarios de la spec (dos canales
      alineados ⇒ 3 filas completas; `B` sin `t1` ⇒ 3 filas y `B: null` en
      `t1` con `toBeNull()`; un canal rechazado ⇒ sus claves ausentes y
      `errors: {B: reason}`); `signalWindowFromHours(h, now)` ⇒ `{start,
      end}` ISO UTC con `end − start === h·3600·1000`; `h > 24` lanza.
      *Aceptación*: test verde.
      *Verificación*: `cd dashboard && ./node_modules/.bin/vitest run lib/rsam-trend.test.ts`.
      *Mutación*: no aplica (R27 se afirma con `toBeNull()`).
- [x] 4.7 Gate de fase.
      *Resultado real (2026-09-06)*: los 6 archivos ⇒ `80 passed`; `tsc
      --noEmit` exit 0 (un error propio corregido antes: `thresholdLine`
      tomaba `Pick<>` y el test pasaba el objeto entero); suite completa
      `108 files / 1215 tests passed` (baseline 102 / 1135: +6 archivos,
      +80 tests, cero regresiones). ESLint: `dashboard/` NO tiene archivo de
      config (solo `next lint`, que pediría crearla de forma interactiva) —
      no se corrió, no se finge. Archivos protegidos sin diff (solo
      untracked nuevos en `dashboard/lib/`).
      *Verificación*: `cd dashboard && ./node_modules/.bin/vitest run lib/analytics.test.ts lib/b-value-plot.test.ts lib/uptime-series.test.ts lib/tremor-episodes.test.ts lib/hypocenter-markers.test.ts lib/rsam-trend.test.ts && ./node_modules/.bin/tsc --noEmit`.
      *Mutación*: no aplica.

---

## Phase 5: Frontend — componentes, página y i18n (TDD + mutación)

**Estado al cerrar la fase**: `/analytics` con los dos selectores, el
picker y los 5 paneles (más el corte SHOULD si entra), cada uno con su
carga/error; los 3 paneles existentes intactos; M8 y M14 registradas.
Recharts NO se asserta por SVG (design Decision 8).

- [ ] 5.1 Claves i18n `analytics.*` (es/en) ANTES de los componentes.
      *Archivos*: modifica `dashboard/messages/es.json`,
      `dashboard/messages/en.json`.
      *Qué*: bajo el namespace `analytics` existente, sub-bloques `window`
      (`catalogDays`, `signalWindow`, presets), `picker` (`title`, `max4`,
      `live`, `chooseChannel`), `rsam` (`title`, `loading`, `errorFor`,
      `noData`), `uptime` (`title`, `ranking`, `timeline`, `noObservation`,
      `noObservations`, `inProgress`, `noHistoryYet`, `zeroPercent`,
      `observedHours`), `bValue` (`title`, `bValueLabel`, `sigma`,
      `nAboveMc`, `mc`, `mcAtFloor`, `insufficient` con `{n}`/`{min}`,
      `degenerate`, `magTypes`, `method`), `tremor` (`title`,
      `sustainedEpisode`, `noEpisodes`, `noDataForChannel`, `fraction`,
      `parameters`, `band.low/mid/high/undefined`,
      `fiSign.lp_like/vt_like/undefined`, columnas de la tabla), `map`
      (`title`, `total`, `truncated` con `{shown}`/`{total}`, `noDepth`,
      `popup.*`), `depthSection` (`title`, `omittedNoDepth`), `error`,
      `loading`. Paridad exacta ES/EN.
      *Aceptación*: `parity.test.ts` verde.
      *Verificación*: `cd dashboard && ./node_modules/.bin/vitest run messages/parity.test.ts`.
      *Mutación*: NO — `parity.test.ts` es el guardián.
- [ ] 5.2 (RED→GREEN) `AnalyticsWindowSelector.tsx` y `StationPicker.tsx`.
      *Archivos*: crea `dashboard/components/analytics/AnalyticsWindowSelector.tsx`
      (+ `.test.tsx`); crea `dashboard/components/analytics/StationPicker.tsx`
      (+ `.test.tsx`).
      *Qué (RED primero)*: selector con DOS grupos de botones (`7/30/90/365`
      y `6h/12h/24h`), cada uno con `aria-pressed` en el activo y callbacks
      separados (`onCatalogDaysChange`, `onSignalWindowChange`); picker
      alimentado por `seismicAPI.getStationCatalog` (mock), permite hasta 4
      canales (el 5.º click no agrega y muestra `max4`), badge `is_live`,
      `onChange(channels)`. Textos SOLO vía `t(...)` con los JSON reales
      (molde `SpectrumView.test.tsx`).
      *Aceptación*: tests verdes.
      *Verificación*: `cd dashboard && ./node_modules/.bin/vitest run components/analytics/AnalyticsWindowSelector.test.tsx components/analytics/StationPicker.test.tsx`.
      *Mutación*: no aplica.
- [ ] 5.3 (RED→GREEN) `RsamTrendChart.tsx`.
      *Archivos*: crea `dashboard/components/analytics/RsamTrendChart.tsx`
      (+ `.test.tsx`).
      *Qué (RED primero)*: con `getStationRsam` mockeado (resuelve `A`,
      rechaza `B`): renderiza la leyenda de `A`, un `role="alert"` etiquetado
      con `B` (error POR SERIE), y la fila fusionada pasa `null` al `<Line>`
      de `A` donde falta (aserción sobre las props del `LineChart` mockeado
      con `vi.mock('recharts', …)` que captura `data` — NO sobre SVG); sin
      canales ⇒ estado `chooseChannel`; loader por serie mientras carga;
      `connectNulls={false}` (prop capturada). Patrón visual de
      `MagnitudeTimeChart` (`useFormatter` UTC, `#374151`, `#9ca3af`,
      tooltip oscuro). NO importa `RsamChart.tsx` (`rg` en el test o en 6.2).
      *Aceptación*: test verde.
      *Verificación*: `cd dashboard && ./node_modules/.bin/vitest run components/analytics/RsamTrendChart.test.tsx`.
      *Mutación*: no aplica.
- [ ] 5.4 (RED→GREEN) `StationUptimeChart.tsx`.
      *Archivos*: crea `dashboard/components/analytics/StationUptimeChart.tsx`
      (+ `.test.tsx`).
      *Qué (RED primero)*: con `ratio` `[1.0, 0.0, null, 1.0]` el 2.º bucket
      lleva la etiqueta `zeroPercent` y el 3.º `noObservation` (NO `0 %`);
      `overall: null` ⇒ `noObservations` en el ranking, nunca `0 %`/`NaN %`;
      orden del ranking `B, D, A, C` con el fixture de la spec; bucket
      `in_progress` marcado; `stations: {}` ⇒ `noHistoryYet`; error ⇒
      `role="alert"`. Barras (`BarChart`) ranking + timeline del canal
      seleccionado.
      *Aceptación*: test verde.
      *Verificación*: `cd dashboard && ./node_modules/.bin/vitest run components/analytics/StationUptimeChart.test.tsx`.
      *Mutación*: no aplica.
- [ ] 5.5 (RED→GREEN) `BValueChart.tsx`.
      *Archivos*: crea `dashboard/components/analytics/BValueChart.tsx`
      (+ `.test.tsx`).
      *Qué (RED primero)*: `status: "ok"`, `b: 0.9963`, `sigma_b: 0.0047` ⇒
      `data-testid="b-value-number"` con `1.00` y `± 0.00`, `getByText(t('analytics.bValue.bValueLabel'))`
      presente, `mcAtFloor` visible si `mc_at_catalog_floor`; `status:
      "insufficient"`, `n_above_mc: 23`, `min_events: 50` ⇒
      `data-testid="b-value-insufficient"` con `23` y `50`,
      `queryByTestId("b-value-number")` es `null`,
      `queryByText(t('…bValueLabel'))` es `null`, sin `<Line>` de ajuste
      (prop capturada); body malformado `{status: "insufficient", b: 1.2}`
      ⇒ NO aparece `1.2`; `status: "degenerate"` ⇒ texto `degenerate` y no
      `insufficient`; el histograma (`bins`) se pasa al `ComposedChart` en
      los tres casos; `mag_type_counts` listado.
      *Aceptación*: test verde.
      *Verificación*: `cd dashboard && ./node_modules/.bin/vitest run components/analytics/BValueChart.test.tsx`.
      *Mutación*: la lleva 5.7 (M8).
- [ ] 5.6 (RED→GREEN) `TremorPanel.tsx` y `HypocenterMap.tsx`.
      *Archivos*: crea `dashboard/components/analytics/TremorPanel.tsx`
      (+ `.test.tsx`); crea `dashboard/components/analytics/HypocenterMap.tsx`
      (+ `.test.tsx`).
      *Qué (RED primero)* — tremor: `episodes: []` ⇒ `noEpisodes`, cero
      `ReferenceArea` (prop capturada); 2 episodios ⇒ 2 filas con `start`/
      `end` formateados en UTC y 2 `ReferenceArea` con esos bordes;
      `ReferenceLine` en `threshold_rsam` (no recalculado);
      `tremor_fraction` y `parameters` visibles; `getTremor` ⇒ `no-data` ⇒
      `noDataForChannel` sin crash; título `sustainedEpisode`. — mapa:
      monta sin lanzar en jsdom (`import('leaflet')` real, `waitFor` con el
      timeout largo de `vitest.setup.ts`), `L.map` llamado con
      `preferCanvas: true` (spy sobre el módulo), 3 eventos ⇒ 3
      `circleMarker`, el de `prof_km: null` con el estilo `no-depth` (spy
      sobre `L.circleMarker` capturando opciones), `total` visible,
      `truncated: true` ⇒ aviso con `2000`/`5000`, popup con "sin
      profundidad" para el nulo (molde `map-locale-popups.test.tsx`), sin
      `setInterval`/`refreshInterval` (timers falsos, 120 s ⇒ 0 fetch
      nuevos), encuadre con `areaViewBounds`, capa `BASE_LAYERS.greyscale`,
      `<link>` CSS como `StationMiniMap`. Test estático: `rg -c
      "AdvancedSeismicMap|SeismicMapWithCities|StationMiniMap|use-area-refresh|/ws/|EventSource"
      dashboard/components/analytics/HypocenterMap.tsx` ⇒ 0.
      *Aceptación*: tests verdes.
      *Verificación*: `cd dashboard && ./node_modules/.bin/vitest run components/analytics/TremorPanel.test.tsx components/analytics/HypocenterMap.test.tsx`.
      *Mutación*: la lleva 5.7 (M14); M9 es QA (7.6).
- [ ] 5.7 **Mutaciones críticas del frontend**.
      *Archivos*: `dashboard/components/analytics/BValueChart.tsx`,
      `dashboard/lib/hypocenter-markers.ts` (mutar y REVERTIR).
      | # | Mutación | Test que DEBE morir |
      |---|---|---|
      | M8 | En `BValueChart`, renderizar `b-value-number` aunque `status !== "ok"` (leer `b` del body sin mirar `status`) | 5.5: `insufficient` muestra número; el body malformado muestra `1.2` |
      | M14 | En `markerStyle`, `getDepthColor(ev.prof_km ?? 0)` | 4.5 y 5.6: el evento sin profundidad toma el color de `< 70 km` |
      *Aceptación*: 2 filas más en `mutation-log.md` con `rg`, rojo,
      reversión por `cmp`, verde.
      *Verificación*: `cd dashboard && ./node_modules/.bin/vitest run components/analytics lib/hypocenter-markers.test.ts`.
- [ ] 5.8 (RED→GREEN) Página `/analytics` — estado, grilla, `useAreaRefresh`.
      *Archivos*: modifica `dashboard/app/(app)/analytics/page.tsx`; crea
      `dashboard/app/(app)/analytics/page.test.tsx` (molde
      `app/(app)/feedback/page.test.tsx`; `fetch` mockeado con contador por
      URL; mocks estables de router — `mock-de-router-inestable-cuelga-tests`).
      *Qué (RED primero)*: (a) carga inicial ⇒ exactamente 1 petición a
      `/report` sin params nuevos + 1 a `/analytics/b-value?days=30` + 1 a
      `/analytics/hypocenters?days=30…` + 1 a `/analytics/station-uptime?days=30…`
      y 0 a RSAM/tremor (sin canales); (b) elegir `7` ⇒ nuevas a los tres
      de catálogo con `days=7`, 0 nuevas a `/report`; (c) con 2 canales y
      `6 h` ⇒ 2 a `/stations/{ch}/rsam` y 1 a `/analytics/tremor/…` con `end
      − start = 6 h`, 0 a catálogo; (d) `/analytics/station-uptime` 503 ⇒
      `role="alert"` del panel de uptime y `MagnitudeTimeChart`/
      `DepthDistributionChart`/`EventsTable` renderizados (NO el `loadError`
      de página); (e) evento de área (`lib/area-events`) ⇒ revalida
      `/report`, `/analytics/b-value`, `/analytics/hypocenters` y NO uptime/
      RSAM/tremor; el handler devuelve `Promise.all` de las tres. Luego
      implementar: `useState` de `catalogDays` (30), `signalWindow` (24),
      `channels` ([]); `useSWR` por panel con clave que incluye params y
      `refreshInterval` SOLO en `/report` (60 s, intacto); grilla con los
      paneles nuevos debajo de los existentes; el `isLoading`/`error`
      globales siguen aplicando SOLO a `/report`.
      *Aceptación*: test verde; los 3 componentes existentes sin cambios
      (`git diff --stat -- dashboard/components/MagnitudeTimeChart.tsx
      dashboard/components/DepthDistributionChart.tsx
      dashboard/components/EventsTable.tsx` vacío).
      *Verificación*: `cd dashboard && ./node_modules/.bin/vitest run "app/(app)/analytics/page.test.tsx" components/EventsTable.test.tsx components/EventsTable.pagination.test.tsx`.
      *Mutación*: NO — los contadores de fetch son la aserción; una
      regresión que agregue `refreshInterval` a un panel nuevo muere en (d)/
      timers falsos de 5.6.
- [ ] 5.9 (SHOULD, ÚLTIMA — recortable) `DepthSectionChart.tsx`.
      *Archivos*: crea `dashboard/lib/depth-section.ts` (+ `.test.ts`);
      crea `dashboard/components/analytics/DepthSectionChart.tsx`
      (+ `.test.tsx`); modifica `dashboard/app/(app)/analytics/page.tsx`
      (montarlo al lado del mapa sobre los MISMOS `eventos`); modifica
      `es.json`/`en.json` si faltara alguna clave de 5.1.
      *Qué (RED primero)*: `toDepthSectionPoints(eventos)` ⇒ omite
      `prof_km: null` y devuelve `{points, omitted}` (3 eventos, 1 nulo ⇒ 2
      puntos, `omitted: 1`); componente `ScatterChart` con `YAxis reversed`,
      color por `getMagnitudeColor`, texto `omittedNoDepth` con `1`. Se
      decide entrar o no en la entrega al llegar acá: si el change viene
      pesado, se deja `[ ]` y se anota en el cierre (7.7) como seguimiento;
      el contrato de `/analytics/hypocenters` no depende de esto.
      *Aceptación*: tests verdes o tarea explícitamente diferida.
      *Verificación*: `cd dashboard && ./node_modules/.bin/vitest run lib/depth-section.test.ts components/analytics/DepthSectionChart.test.tsx`.
      *Mutación*: no aplica.
- [ ] 5.10 Gate de fase.
      *Verificación*: `cd dashboard && ./node_modules/.bin/vitest run && ./node_modules/.bin/tsc --noEmit` — suite COMPLETA contra la baseline de 4.1 (delta = solo tests nuevos) y `git diff --stat -- dashboard/components/AdvancedSeismicMap.tsx dashboard/components/SeismicMapWithCities.tsx dashboard/components/MagnitudeTimeChart.tsx dashboard/components/DepthDistributionChart.tsx dashboard/components/EventsTable.tsx dashboard/components/RsamChart.tsx` vacío.
      *Mutación*: no aplica.

---

## Phase 6: i18n — paridad y auditoría de strings

**Estado al cerrar la fase**: ningún literal hardcodeado nuevo, paridad
es/en verde incluyendo todas las claves de `analytics.*`, tipos limpios.

- [ ] 6.1 Paridad es/en de las claves nuevas.
      *Archivos*: `dashboard/messages/es.json`, `dashboard/messages/en.json`
      (solo si falta algo tras 5.1–5.9).
      *Qué*: correr `parity.test.ts`; `rg -c '"bValueLabel"|"noObservation"|"noEpisodes"|"truncated"|"noDepth"|"degenerate"' dashboard/messages/es.json dashboard/messages/en.json` ⇒ mismo conteo en ambos.
      *Aceptación*: paridad verde y conteos iguales.
      *Verificación*: `cd dashboard && ./node_modules/.bin/vitest run messages/parity.test.ts`.
      *Mutación*: NO — `parity.test.ts` es el guardián.
- [ ] 6.2 Auditoría: sin literales hardcodeados ni imports prohibidos.
      *Archivos*: `dashboard/components/analytics/*.tsx` (sin `*.test.tsx`),
      `dashboard/app/(app)/analytics/page.tsx`.
      *Qué*: `rg -n ">[A-Za-zÁ-ú][^<{]*<" dashboard/components/analytics --glob '!*.test.tsx'`
      sin matches de texto de usuario; `rg -n "from '@/components/RsamChart'|AdvancedSeismicMap|SeismicMapWithCities|StationMiniMap|use-area-refresh|EventSource|/ws/" dashboard/components/analytics --glob '!*.test.tsx'`
      ⇒ 0 matches (la página SÍ puede importar `use-area-refresh`; los
      componentes no).
      *Aceptación*: sin matches.
      *Verificación*: los dos `rg`.
      *Mutación*: no aplica (auditoría estática).
- [ ] 6.3 Tipos.
      *Verificación*: `cd dashboard && ./node_modules/.bin/tsc --noEmit; echo $?` ⇒ `0`. Nunca `next build`.
      *Mutación*: no aplica.

---

## Phase 7: Verificación, deploy, QA visual en prod y cierre

**Estado al cerrar la fase**: change verificado contra los Success Criteria
del proposal con evidencia real de HOY; desplegado; primera corrida del
rollup medida; QA visual hecha por el usuario en producción. **Ninguna
tarea de esta fase corre el stack en local.** Las tareas **(USUARIO)** las
ejecuta el usuario; el agente no las marca `[x]` por su cuenta.

- [ ] 7.1 Suite backend COMPLETA contra la baseline de HOY.
      *Qué*: `./venv/bin/python -m pytest tests/ -q -p no:cacheprovider --no-cov`
      y comparar contra 1.1 — el delta debe ser exactamente los tests nuevos
      (1.2, 1.5, 1.6, 2.2, 2.4, 2.6, 2.7, 3.1, 3.2, 3.4, 3.5), cero
      regresiones; `./venv/bin/ruff check .` sin hallazgos nuevos respecto
      de HEAD (el F811 de `search_stations` en `main.py` es preexistente).
      *Verificación*: los dos comandos; conteos en `mutation-log.md` fechados.
      *Mutación*: no aplica.
- [ ] 7.2 Suite frontend completa.
      *Verificación*: `cd dashboard && ./node_modules/.bin/vitest run && ./node_modules/.bin/tsc --noEmit`. **Nunca `next build`.**
      *Mutación*: no aplica.
- [ ] 7.3 Deploy (solo cuando el usuario lo pida) — en UNO o DOS PRs.
      *Qué*: commits convencionales (sin atribución a IA) en la rama
      `feat/analytics-professional-panels`; PR; merge. Opción A (recomendada,
      ver 1.9): PR 1 = Fase 1 sola (rollup) apenas cierre, PR 2 = el resto.
      Tras el merge del backend: en Railway, logs del servicio `api`
      muestran la 021 aplicada tras la 020 y un restart posterior no-op;
      setear `UPTIME_ROLLUP_ENABLED=true` SOLO en `api`; el `logger.info`
      de `rollup_once` de la PRIMERA corrida reporta filas y ms (anotar el
      número — Migration/Rollout §3; si supera ~60 s, bajar la cadencia NO,
      investigar el índice). Vercel toma el dashboard.
      *Aceptación*: `curl -s "https://api.geospectrum.org/analytics/b-value?days=30"`
      ⇒ 200 con `status` y `method` (anónimo, área default);
      `curl -s "https://api.geospectrum.org/analytics/station-uptime?days=1"`
      ⇒ 200 con `expected_columns_per_hour: 900` y `stations` no vacío tras
      la primera corrida; `curl -s -o /dev/null -w "%{http_code}"
      "https://api.geospectrum.org/analytics/b-value?days=0"` ⇒ 422 —
      prueba que el router está montado y el lifespan (con el loop nuevo)
      completó sin tumbar el `api`.
      *Mutación*: no aplica.
- [ ] 7.4 **(USUARIO) QA visual — `https://geospectrum-dashboard.vercel.app/analytics`
      (o `geospectrum.org/analytics` si el dominio ya apunta)**, con sesión.
      Qué mirar, en orden:
      (a) **Selectores**: dos grupos separados (días / horas) y el picker;
      cambiar `30 → 7` refresca SOLO b-value, mapa y uptime (los tres
      paneles viejos no parpadean); cambiar `24 h → 6 h` refresca SOLO RSAM
      y tremor.
      (b) **b-value** con área "global" y 30 días ⇒ número con `± σ`,
      histograma con barras + puntos acumulados en Y log y la recta; luego
      elegir un área chica (o `7` días) ⇒ tarjeta "insuficiente" con `n` y
      `50`, SIN número, histograma todavía visible; si aparece el aviso de
      `mc_at_catalog_floor`, es esperado en áreas con USGS.
      (c) **Mapa de hipocentros**: colores por profundidad iguales a los
      del histograma de al lado; radio por magnitud; click abre popup con
      M, profundidad (o "sin profundidad"), hora UTC y lugar; con `365`
      días y `min_mag` bajo ⇒ aviso "Mostrando 2000 de N"; **zoom y pan
      fluidos con 2 000+ puntos (esto ES la verificación de M9
      `preferCanvas`)**; sin ciudades, sin placas, sin selector de capas;
      dejar la pestaña 2 minutos ⇒ no se refresca sola.
      (d) **Uptime**: el DÍA del deploy ya muestra hasta 7 días hacia atrás
      (backfill); el ranking pone las peores primero; elegir una estación
      muestra su timeline; el bucket actual marcado "en curso"; buscar una
      hora "sin observación" (gris, sin barra) vs una en "0 %" (barra de
      altura cero) — si TODO es 100 % o TODO es null, sospechar del
      `UPTIME_ROLLUP_ENABLED`.
      (e) **RSAM trend**: elegir 2-4 canales del picker (uno de GEOFON,
      uno de IRIS); la primera carga tarda segundos por canal con loader
      POR SERIE (no spinner global); un canal sin datos FDSN muestra su
      error sin tirar las otras líneas; eje de tiempo en UTC.
      (f) **Tremor**: sobre un canal con un sismo grande conocido en las
      últimas 24 h ⇒ el sismo NO aparece como episodio (dura < 30 min);
      la línea de umbral está a 2× la mediana; título dice "episodio
      sostenido (candidato a tremor)", nunca "tremor detectado";
      `tremor_fraction` y parámetros visibles.
      (g) **No-regresión**: `MagnitudeTimeChart`, `DepthDistributionChart`
      y la tabla paginada se ven y se comportan como antes; cambiar el área
      en el header refresca todo lo que depende del área.
      (h) Cambiar el idioma a `en`: ningún texto en español en los paneles
      nuevos.
      *Aceptación*: sin hallazgos bloqueantes, o hallazgos registrados como
      seguimiento fuera de este change.
- [ ] 7.5 **(USUARIO) Observación del rollup en prod (primeros días).**
      *Qué*: en Railway, confirmar que el `api` no reinicia por el loop;
      que el log de `rollup_once` aparece cada 10 min con filas ≈ 2 h × N
      canales; que `SELECT count(*), min(bucket_start), max(bucket_start)
      FROM station_uptime_hourly` (vía `railway ssh`) crece hora a hora y el
      mínimo se queda en `now − 7 d` del primer rollup. Este es el dato que
      decide si `analytics-report-export` tiene 7 días de uptime el día
      que arranque.
      *Aceptación*: tabla creciendo; sin reinicios atribuibles al loop.
- [ ] 7.6 Registrar M9 como QA (no como test).
      *Qué*: en `mutation-log.md`, fila M9 con "verificado a mano en 7.4(c):
      zoom fluido con N puntos en canvas" y la fecha; NO fingir un test
      automatizado.
      *Aceptación*: fila presente con evidencia del usuario.
- [ ] 7.7 Cierre.
      *Qué*: repasar los cinco Success Criteria del proposal citando
      evidencia (paneles con datos reales: 7.3/7.4; mapa verificablemente
      distinto de `/live`: 6.2 + 5.6; b-value nunca muestra número bajo el
      mínimo: 2.9-M1/M3/M13 + 5.7-M8 + 7.4(b); `/report` y los paneles
      existentes intactos: 3.7 + 5.8 + 5.10; `analytics-report-export` puede
      arrancar citando `/analytics/b-value`, `/analytics/hypocenters`,
      `/analytics/station-uptime`, `/analytics/tremor/{channel}` y
      `/stations/{channel}/rsam` como fuentes). Anotar si 5.9 entró o quedó
      diferida. Cerrar `mutation-log.md` con fecha y conteo total (14:
      M1–M14, con M9 como QA). Dejar el change listo para `sdd-verify` /
      archive; en el archive, la tabla de reconciliación de arriba es la
      fuente para actualizar los specs base (`signal-analysis`,
      `backend-api`, `dashboard-ui`).
      *Mutación*: no aplica.
