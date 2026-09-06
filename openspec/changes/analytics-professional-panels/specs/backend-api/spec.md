# Delta for Backend API — Endpoints de analítica profesional y rollup de uptime

Delta sobre `openspec/specs/backend-api/spec.md`. Todo lo de acá es
**ADDED**: un rollup persistente nuevo de disponibilidad por canal, un router
`/analytics/*` con CUATRO endpoints de lectura, y un requirement de reuso
(no de cambio) sobre `GET /stations/{channel}/rsam`. Ningún requirement del
spec base se modifica: `GET /report`, `GET /events*` y `GET
/stations/{channel}/rsam` conservan su contrato tal cual — ver el requirement
de no-regresión al final. En particular, el requirement base "Serie temporal
RSAM sobre ventana absoluta" ("MUST NOT persistir muestras de RSAM", "MUST NOT
modificar `seedlink_ingestor.py`") queda **intacto**: este change NO persiste
RSAM ni agrega un endpoint RSAM nuevo.

> Reconciliado con `design.md` el 2026-09-04 (tabla en `tasks.md`). Los
> cambios respecto de la primera versión de esta spec: `/analytics/rsam`
> eliminado (la tendencia reusa `/stations/{channel}/rsam`, ventana ≤ 24 h,
> decisión del usuario); `/analytics/uptime` → `/analytics/station-uptime`
> con la forma del design; `/analytics/tremor` → `/analytics/tremor/{channel}`;
> parámetros `days` en vez de `start`/`end` para los endpoints de catálogo;
> nombres de campos del design; orden de hipocentros por magnitud.

## Lo que el código dice hoy (verificado 2026-09-04)

| Afirmación del proposal | Estado en el código |
|---|---|
| "El watchdog solo persiste el ESTADO ACTUAL vía `WatchdogStateStore.get_state`/`set_state` (líneas 220-256, Redis)" | Cierto (`src/services/watchdog.py:220-267`, key `watchdog:state:{componente}`, sin TTL). **Pero** el watchdog vigila 4 SERVICIOS (`COMPONENTS = ("api", "ui", "seedlink", "events")`, línea 46), NO estaciones. No existe estado por estación/canal en ningún lado: `check_seedlink` (línea 131) sólo decide "todos mudos vs. alguno activo" con `fetch_active_channels(minutes)` (`timescale_service.py:88`). El "uptime histórico de ESTACIONES" del proposal no tiene ni siquiera un "último estado" del cual partir. |
| (no lo dice el proposal) | `spectrogram_columns` (`db/migrations/001`) SÍ es evidencia histórica por canal — una fila por columna de espectrograma cada `COLUMN_INTERVAL_SECONDS = 4` (`seedlink_ingestor.py:58`) con `endtime` — pero con **retención de 7 días** (`db/migrations/002`), chunks de 1 día, y vive en `db/migrations/`, que `tests/conftest.py:26` NO aplica (sólo `deploy/sql/migrations`). El design deriva el uptime de ahí con un rollup horario a una tabla plana en `deploy/sql/migrations/` (testeable, sin retención). |
| "nuevo endpoint que agrega muestras de `RsamAccumulator`/`rsam_series` en una ventana seleccionable" | Ver delta de `signal-analysis`: el accumulator retiene 1 h en el proceso del ingestor. `GET /stations/{channel}/rsam` (`main.py:3001`) ya calcula la serie ON-DEMAND desde FDSN con ventana ≤ 24 h (`MAX_WAVEFORM_WINDOW_HOURS`), cache eterno en `fdsn_result_cache` (016), y el spec base dice: "El sistema MUST NOT persistir muestras de RSAM, MUST NOT modificar `seedlink_ingestor.py`". **Decisión del usuario (2026-09-04): la tendencia de Analytics reusa ese endpoint tal cual, ventana de 24 h, sin persistir nada.** |
| "`src/api/` (o router equivalente)" | Existe `src/api/routers/` con `areas.py, comments.py, feedback.py, picks.py, stations.py, walls.py`; el resto de los endpoints viven en `src/main.py` con `@app.get`. El router nuevo es `src/api/routers/analytics.py`. |
| `SeismicEvent.mag`, `lat`/`lon`/`prof_km` | Ciertos. Persistidos en `seismic_events` (`deploy/sql/migrations/014`), leídos por `EventStore.recent(hours ≤ 168, min_magnitude, limit ≤ 5000)` y expuestos por `GET /events/recent` (`main.py:2496`). No hay filtro geográfico en `EventStore`; el recorte por área lo hace `point_in_area()` en Python (`report_service.build_report`, `src/services/geo_filter`). No hay limpieza de `seismic_events`. |
| `/report` como fuente de `/analytics` | `GET /report` (`main.py:773`) acepta SOLO `sources`; la ventana es `settings.window_minutes` fija del servidor. **No hay forma de pedirle una ventana desde el cliente.** Los paneles de catálogo leen `seismic_events` con `EventStore.between()` (nuevo). |

## Decisiones tomadas en esta spec (el proposal las dejó implícitas)

| # | Tema | Decisión | Por qué |
|---|------|----------|---------|
| 1 | **Prefijo y aditividad** | Todos los endpoints nuevos cuelgan de `/analytics/*`. Ninguno modifica `GET /report` ni ningún endpoint existente | El proposal exige que "ningún endpoint nuevo rompa `/report`"; un prefijo propio lo hace verificable con un `rg` |
| 2 | **Autenticación y recorte por área** | Los endpoints que leen EVENTOS (`/analytics/b-value`, `/analytics/hypocenters`) usan `get_current_user_optional` (`src/api/deps.py:142`) y recortan al área activa EXACTAMENTE como `/report`: con sesión, el área activa del usuario; sin sesión, el preset por defecto; si el área no se puede resolver, degradan a global sin 500 (`logger.exception`). Los endpoints por CANAL (`/analytics/tremor/{channel}`, `/analytics/station-uptime`) no recortan por área (un canal no pertenece a un área) y son públicos como `GET /stations/{channel}/rsam` | Consistencia con lo que ya existe: `/report` es público con personalización opcional por decisión documentada (AOI-1), y los endpoints de estación no tienen `Depends` de auth |
| 3 | **Ventana por `days` en los endpoints de catálogo y de uptime; ventana absoluta en el de señal** | `/analytics/b-value`, `/analytics/hypocenters` y `/analytics/station-uptime` aceptan `days: int` (`Query(ge=1, le=365)`, default 30 / 30 / 7); la ventana es `[now − days, now]`. `/analytics/tremor/{channel}` acepta `start`/`end` ISO-8601 con las MISMAS reglas de borde que `GET /stations/{channel}/rsam` (`main.py:3028-3040`): naive ⇒ UTC; `end ≤ start` ⇒ 422; ventana > 24 h ⇒ 422 con `{"detail": ...}` | El catálogo y la tabla de uptime se miran "hacia atrás desde ahora" (y `seismic_events` no tiene retención); la señal se pide sobre la misma ventana absoluta que el detalle de estación, con la validación que ya existe y ya está testeada |
| 4 | **Ventanas mínimas soportadas** | `/analytics/station-uptime` MUST aceptar al menos **7 días**; `/analytics/b-value` y `/analytics/hypocenters` al menos **30 días** (el máximo es 365 en los tres). La tendencia RSAM y el tremor están acotados a **24 h** por el tope de FDSN (`MAX_WAVEFORM_WINDOW_HOURS`), a propósito | `analytics-report-export` manda un reporte SEMANAL: el uptime tiene que cubrir 7 días (el rollup del design los da desde el primer deploy). El b-value con 30 días es lo mínimo para juntar `bValueMinEvents` eventos en un área regional. RSAM multi-día queda como pregunta abierta del design, con criterio de reapertura basado en datos de este change |
| 5 | **Huecos son `null`** | En la serie de uptime, un bucket no observado ⇒ `ratio: null`, nunca `0` | Ver Decisión 4 de `signal-analysis` |
| 6 | **"Insuficiente" es 200** | `/analytics/b-value` responde `200` con `status = "insufficient"` (o `"degenerate"`), no 4xx | Es un estado válido del dato, no un error del cliente ni del servidor; la UI lo tiene que renderizar, no capturar |
| 7 | **Sin base ⇒ 503** | Los endpoints que leen Postgres responden `503` con `{"detail": ...}` si su store/pool no está en `app.state` (mismo criterio que `GET /events/recent`, `main.py:2513-2518`), nunca una lista vacía | "No sabemos" no es "no hay" |
| 8 | **La historia de uptime vive en `deploy/sql/migrations/`** | La migración nueva es la **021** (`021_station_uptime_hourly.sql`; la última hoy es `020_feedback_screenshot.sql`), idempotente (`IF NOT EXISTS`), con bloque de rollback comentado como las 20 anteriores | Es el único directorio que `tests/conftest.py` aplica; ponerla en `db/migrations/` sería elegir no poder testearla (mismo argumento que dejó escrito `014_seismic_events.sql`) |
| 9 | **Clave de canal** | El uptime se persiste y se expone con el `channel` de 4 partes (`NET.STA.LOC.CHA`, `trace.id`) tal como lo guarda `spectrogram_columns`; el endpoint devuelve siempre esa misma clave | Es la clave que ya existe en la fuente; traducir a `NET.STA.CHAN` (la de `build_expected_channels`, `watchdog.py:410`) inventaría una segunda identidad |

## Resuelto por el design (reconciliación 2026-09-04)

1. **Forma de la historia de uptime**: rollup horario (`station_uptime_hourly(channel,
   bucket_start, columns_count)`) derivado de `spectrogram_columns`, escrito por un
   loop del servicio `api` (`run_uptime_rollup_loop`, opt-in por
   `UPTIME_ROLLUP_ENABLED`), cada 600 s, con backfill acotado a 7 días
   (`GREATEST(now() − 7 d, max(bucket_start))`). Ni Redis, ni continuous
   aggregate, ni transiciones del watchdog, ni escritura desde el ingestor.
2. **Fuente de la serie RSAM**: `GET /stations/{channel}/rsam`, sin cambios, ≤ 24 h.
   No se persiste RSAM. No hay sección MODIFIED sobre el spec base.
3. **Máximos**: `days ≤ 365` en los tres endpoints de catálogo/uptime; `limit ≤ 5000`
   (default 2000) en hipocentros; `channel` repetible sin tope en uptime (la tabla
   tiene ~107 canales); tremor mono-canal.
4. **`Mc`**: query param opcional `mc`; ausente ⇒ estimación por máxima curvatura + 0,2
   (`estimate_mc_maxc`, design Decision 1).

## ADDED Requirements

### Requirement: Rollup persistente de disponibilidad por canal

El sistema MUST persistir en Postgres (`deploy/sql/migrations/021_station_uptime_hourly.sql`,
Decisión 8) un conteo horario de columnas de espectrograma por canal,
suficiente para reconstruir, para cada canal con datos y para cualquier
hora desde el primer rollup, cuántas columnas entregó ese canal en esa hora.

Reglas normativas:

1. La evidencia de "canal vivo" MUST ser la MISMA que hoy lee `check_seedlink`:
   filas de `spectrogram_columns`. El sistema MUST NOT inventar una segunda
   definición de "canal vivo" (un poller nuevo con su propio umbral).
   `uptime(canal, hora) = min(1, columns_count / EXPECTED_COLUMNS_PER_HOUR)`,
   con `EXPECTED_COLUMNS_PER_HOUR = 3600 // COLUMN_INTERVAL_SECONDS` derivada
   del import (`seedlink_ingestor.py`), nunca un `900` literal.
2. El registro MUST sobrevivir a la retención de 7 días de
   `spectrogram_columns` y a un flush de Redis: la tabla no tiene retención.
3. Un fallo del rollup (Postgres caído, tabla ausente) MUST NOT tumbar el
   servicio `api` ni afectar ningún otro loop del lifespan — se loguea
   `warning` y el siguiente ciclo vuelve a intentar (molde
   `run_disk_alert_loop`, `disk_alert.py:75-94`: try/except que envuelve
   TODO el ciclo).
4. `src/services/watchdog.py`, `WatchdogStateStore` y las keys
   `watchdog:state:{componente}` MUST quedar sin cambios: la historia es
   ADITIVA al estado actual, no lo reemplaza.
5. El rollup MUST ser desactivable por configuración
   (`UPTIME_ROLLUP_ENABLED`, default `false`) sin afectar nada más
   (rollback del proposal: "dejar de escribir el historial"). Encendido
   SOLO en el servicio `api` de Railway.
6. El rollup MUST ser idempotente (`ON CONFLICT (channel, bucket_start) DO
   UPDATE`): una hora parcial se REESCRIBE con el conteo actual, no se
   acumula.
7. El rollup MUST NOT leer más atrás de 7 días ni más atrás del último
   `bucket_start` ya escrito; en una tabla vacía MUST materializar los 7
   días de raw retenida en la primera corrida.
8. La migración MUST ser idempotente.

#### Scenario: Una hora con 900 columnas queda como 900 y una parcial como su conteo

- GIVEN `spectrogram_columns` con 900 filas de `GE.KBU..BHZ` con `endtime` en
  la hora `H` y 450 filas en la hora `H+1`
- WHEN corre `rollup_once`
- THEN `station_uptime_hourly` tiene `(GE.KBU..BHZ, H, 900)` y
  `(GE.KBU..BHZ, H+1, 450)` (verificado con SELECT)
- AND `rollup_once` devuelve la cantidad de filas upserteadas

#### Scenario: El rollup reescribe la hora parcial, no acumula

- GIVEN el estado del escenario anterior
- AND se agregan 100 filas más en `H+1`
- WHEN corre `rollup_once` de nuevo
- THEN la fila de `H+1` tiene `columns_count = 550` (no `1000`, no `450`)

Nota de falsabilidad: la mutación es `DO UPDATE` → `DO NOTHING`: la fila
queda en `450` y el escenario muere.

#### Scenario: Un hueco de horas se rellena solo

- GIVEN `station_uptime_hourly` con el último `bucket_start` hace 5 h
- AND `spectrogram_columns` con filas en las 5 horas intermedias
- WHEN corre `rollup_once`
- THEN las 5 horas intermedias tienen fila en `station_uptime_hourly`

Nota de falsabilidad: la mutación es reemplazar `GREATEST(now() − 7 d,
max(bucket_start))` por `now() − 2 h`: quedan 3 horas sin fila.

#### Scenario: Un fallo de Postgres no tumba el loop ni el api

- GIVEN un pool cuya `execute` lanza en el primer ciclo y funciona en el
  segundo
- WHEN corre `run_uptime_rollup_loop` con `interval_seconds` corto y
  `stop_event`
- THEN el primer ciclo termina con un `warning` logueado y SIN excepción
  propagada
- AND el segundo ciclo escribe filas
- AND el loop termina limpio al setear `stop_event`

#### Scenario: Desactivar el rollup no afecta al resto

- GIVEN `UPTIME_ROLLUP_ENABLED=false` (default)
- WHEN arranca el lifespan del `api`
- THEN no se crea la task del rollup y no se escribe ninguna fila
- AND los demás loops opt-in (`fdsn_warmup`, `disk_alert`) se comportan
  igual que antes de este change

#### Scenario: Segunda aplicación de la migración 021 es no-op

- GIVEN una base donde la 021 ya fue aplicada y tiene filas
- WHEN `apply_migrations` la vuelve a correr
- THEN termina sin error y las filas existentes quedan intactas

#### Scenario: La historia sobrevive a la retención de espectrogramas

- GIVEN filas de `station_uptime_hourly` de hace 10 días
- AND `spectrogram_columns` ya no tiene ninguna fila de esa fecha
- WHEN se pide `GET /analytics/station-uptime?days=14`
- THEN la respuesta contiene `ratio` numéricos (no `null`) para esas horas

#### Scenario: El watchdog no cambia de forma

- GIVEN el diff completo de este change
- WHEN se inspecciona `src/services/watchdog.py`
- THEN no tiene cambios y su batería de tests sigue en verde sin modificar

### Requirement: Serie de uptime por canal — GET /analytics/station-uptime

`GET /analytics/station-uptime` MUST aceptar `days` (Decisión 3, default 7,
`[1, 365]`), `bucket` opcional (`hour` | `day`, default `hour`; `days > 14`
MUST forzar `day`) y `channel` opcional repetible (default: todos los
canales con filas en la ventana), y MUST responder `200` con:

```
{
  "bucket": "hour" | "day",
  "window_start": "<ISO UTC>", "window_end": "<ISO UTC>",
  "expected_columns_per_hour": 900,
  "stations": {
    "<NET.STA.LOC.CHA>": [
      { "bucket_start": "<ISO UTC>", "columns_count": <int>, "observed_hours": <int>,
        "expected": <int>, "ratio": <float | null>, "in_progress": <bool> }, ...
    ]
  },
  "overall": { "<NET.STA.LOC.CHA>": <float | null> }
}
```

Reglas normativas:

1. La construcción de la serie MUST ser la función pura del delta de
   `signal-analysis` ("Serie de disponibilidad por buckets a partir del
   rollup"): todos los buckets de la ventana presentes; hora no observada
   (sin fila de NINGÚN canal) ⇒ `ratio: null`; canal presente en la ventana
   sin fila en una hora observada ⇒ `ratio: 0.0`; `ratio ∈ [0.0, 1.0]`.
2. El endpoint MUST aceptar `days` de al menos 7 (Decisión 4) y MUST
   responder 422 con `{"detail": ...}` para `days` fuera de `[1, 365]`.
3. Un `channel` pedido sin ninguna fila en la ventana MUST aparecer igual en
   `stations` con todos sus buckets en `ratio: null` y `overall: null` — no
   404, porque una request multi-canal no puede fallar entera por un canal,
   y porque "no lo miramos" no es "estaba caído".
4. Sin `db_pool` en `app.state` ⇒ 503 (Decisión 7).
5. `expected_columns_per_hour` MUST ser el valor derivado del import, no un
   literal del router.

#### Scenario: Ventana de 7 días con buckets diarios

- GIVEN filas de `GE.KBU..BHZ` con `columns_count = 900` en TODAS las horas
  de los últimos 7 días
- WHEN se pide `GET /analytics/station-uptime?days=7&bucket=day&channel=GE.KBU..BHZ`
- THEN la respuesta es 200
- AND `stations["GE.KBU..BHZ"]` tiene exactamente `7` elementos (más el del
  día en curso si `now` no está en un borde de día, marcado `in_progress`)
- AND todos los cerrados tienen `ratio = 1.0` y `expected = 900 · 24`
- AND `overall["GE.KBU..BHZ"]` es `1.0`

#### Scenario: Un día sin observaciones aparece como null

- GIVEN las mismas filas pero sin NINGUNA fila (de ningún canal) en el
  tercer día
- WHEN se pide la misma ventana
- THEN el bucket del tercer día tiene `ratio: null` y `observed_hours: 0`
- AND los otros siguen en `1.0`

#### Scenario: Un canal mudo en una hora observada da 0.0, no null

- GIVEN filas de `GE.KBU..BHZ` en la hora `H` y de `IU.MAJO.00.BHZ` en `H`
  y `H+1`
- WHEN se pide `bucket=hour` sobre `[H, H+2)`
- THEN `stations["GE.KBU..BHZ"][1].ratio` es `0.0` (hubo observación: otro
  canal entregó) y NO `null`

#### Scenario: days > 14 fuerza bucket=day

- WHEN se pide `GET /analytics/station-uptime?days=30&bucket=hour`
- THEN la respuesta es 200 con `"bucket": "day"`

#### Scenario: Ventana inválida es rechazada

- WHEN se pide `days=0` o `days=366`
- THEN la respuesta es 422 con `{"detail": ...}`

#### Scenario: Sin base configurada responde 503

- GIVEN `app.state` sin `db_pool`
- WHEN se pide `GET /analytics/station-uptime?days=7`
- THEN la respuesta es 503 con `{"detail": ...}`, no `200` con `stations: {}`

### Requirement: Tendencia RSAM — reuso de GET /stations/{channel}/rsam

La tendencia RSAM de `/analytics` MUST alimentarse de `GET
/stations/{channel}/rsam` (una request por canal, desde el cliente, con
`period_seconds = 600`), sin endpoint nuevo, sin persistencia de muestras y
con la ventana acotada a 24 h que ese endpoint ya impone.

Reglas normativas:

1. Este change MUST NOT agregar un endpoint `/analytics/rsam` ni ningún otro
   que devuelva series RSAM.
2. Este change MUST NOT persistir muestras RSAM ni modificar
   `seedlink_ingestor.py` (requirement base intacto).
3. `GET /stations/{channel}/rsam` MUST seguir existiendo con su contrato y
   su límite de 24 h intactos.

#### Scenario: El endpoint de estación no cambia

- GIVEN el diff completo de este change
- WHEN se corre la batería existente de `GET /stations/{channel}/rsam`
  (`tests/unit/test_station_rsam_endpoint.py`)
- THEN sigue en verde sin modificar ningún test, y una ventana de 25 h sigue
  dando 422 ahí

#### Scenario: No hay endpoint RSAM nuevo

- GIVEN el diff completo del change
- WHEN se busca `rg -n "analytics/rsam|rsam_samples|INSERT INTO rsam" src/`
- THEN no hay matches

### Requirement: b-value sobre el catálogo persistido — GET /analytics/b-value

`GET /analytics/b-value` MUST aceptar `days` (Decisión 3, default 30,
`[1, 365]`), `min_mag` opcional y `mc` opcional (ausente ⇒ estimación
automática), leer los eventos de `seismic_events` con `hora_utc` en la
ventana recortados al área activa (Decisión 2), y responder `200` con UNO de:

```
{ "status": "ok", "method": "aki-utsu-mle",
  "n_total": <int>, "n_above_mc": <int>, "min_events": <int>,
  "mc": <float>, "mc_at_catalog_floor": <bool>,
  "b": <float>, "a": <float>, "sigma_b": <float>,
  "bins": [ { "m": <float>, "count": <int>, "cumulative": <int> }, ... ],
  "mag_type_counts": { "<mag_tipo | unknown>": <int> },
  "window_start": ..., "window_end": ..., "area_slug": <str | null> }
```
o
```
{ "status": "insufficient" | "degenerate", "method": "aki-utsu-mle",
  "n_total": <int>, "n_above_mc": <int>, "min_events": <int>,
  "mc": <float | null>, "mc_at_catalog_floor": <bool>,
  "bins": [ ... ], "mag_type_counts": { ... },
  "window_start": ..., "window_end": ..., "area_slug": <str | null> }
```

Reglas normativas:

1. El cálculo MUST ser la función pura del delta de `signal-analysis`
   (`fit_b_value`); el endpoint MUST NOT reimplementar la estimación ni la
   guarda.
2. Con `status != "ok"` el body MUST NOT contener las claves `b`, `a` ni
   `sigma_b` (ni con `null`).
3. `min_events` MUST ser el valor de `bValueMinEvents` leído del JSON (la
   misma constante que usa la función pura, no un literal en el endpoint).
4. El recorte por área MUST usar el mismo `point_in_area()` que
   `build_report` como etapa final; una etapa previa por bbox en SQL
   (`EventStore.between`) es una optimización, no un criterio distinto.
5. `days` fuera de `[1, 365]` ⇒ 422.
6. Sin `event_store` en `app.state` ⇒ 503.

#### Scenario: Un catálogo suficiente devuelve b y el histograma

- GIVEN `seismic_events` sembrado con el catálogo sintético `b = 1.0` del
  delta de `signal-analysis` a escala reducida (`round(10^(4.0 − M))`
  eventos por bin de `2.0` a `4.0`: `100, 79, 63, …, 1`, total `483`
  eventos, verificado con Python), todo dentro del área activa y de la
  ventana
- WHEN se pide `GET /analytics/b-value?days=30&mc=2.0`
- THEN la respuesta es 200 con `status = "ok"` y `method = "aki-utsu-mle"`
- AND `b` está en `[0.90, 1.10]`
- AND `n_above_mc` es la cantidad sembrada con `mag ≥ 2.0`
- AND `bins` tiene una entrada por bin con `count` igual al sembrado

#### Scenario: Un catálogo chico devuelve "insuficiente" sin b

- GIVEN `seismic_events` con `bValueMinEvents − 1` eventos de `mag ≥ mc` en
  la ventana
- WHEN se pide `GET /analytics/b-value`
- THEN la respuesta es 200 con `status = "insufficient"`
- AND el body NO contiene la clave `b` (`"b" not in body`, no `is None`)
- AND `n_above_mc` es `bValueMinEvents − 1` y `min_events` es
  `bValueMinEvents`

#### Scenario: Los eventos fuera del área activa no cuentan

- GIVEN un usuario con área activa "Andes"
- AND `seismic_events` con `bValueMinEvents + 100` eventos en Japón y
  `bValueMinEvents − 10` en los Andes, todos en la ventana
- WHEN ese usuario pide `GET /analytics/b-value`
- THEN `status` es `"insufficient"` y `n_above_mc` es `bValueMinEvents − 10`

Nota de falsabilidad: sin recorte, `n_above_mc` sería `2·bValueMinEvents +
90` y `status = "ok"`.

#### Scenario: Sin sesión se usa el área por defecto, igual que /report

- GIVEN una petición sin cookie de sesión
- WHEN se pide `GET /analytics/b-value`
- THEN la respuesta es 200 (no 401)
- AND el recorte usado es el del área por defecto (`AreaService.get_default`)
  y `area_slug` es su slug

#### Scenario: Ventana de 30 días aceptada, fuera de rango rechazada

- WHEN se pide `days=30`
- THEN la respuesta es 200
- AND WHEN se pide `days=0` o `days=366`
- THEN la respuesta es 422 con `{"detail": ...}`

### Requirement: Caracterización de tremor — GET /analytics/tremor/{channel}

`GET /analytics/tremor/{channel}` MUST aceptar `channel` en el path (formato
`NET.STA.LOC.CHA`, 4 partes) y `start`, `end` (Decisión 3, ventana ≤ 24 h),
y responder `200` con el resultado del clasificador del delta de
`signal-analysis` más el enriquecimiento espectral del design:

```
{ "channel": ..., "sampling_rate": <float>, "period_seconds": 600,
  "baseline_rsam": <float | null>, "threshold_rsam": <float | null>,
  "tremor_fraction": <float>,
  "parameters": { "baseline_factor": <float>, "min_duration_periods": <int> },
  "samples": [ { "t": ..., "rsam": <float>, "dominant_hz": <float | null>, "fi": <float | null> }, ... ],
  "episodes": [ { "start": ..., "end": ..., "samples": <int>, "duration_s": <int>,
                  "mean_ratio": <float>, "peak_rsam": <float>, "peak_ratio": <float>,
                  "onset_ratio": <float>, "mean_dominant_hz": <float | null>,
                  "mean_fi": <float | null>, "band": ..., "fi_sign": ... }, ... ] }
```

Reglas normativas:

1. `samples[i].rsam` MUST ser EXACTAMENTE el `value` que devuelve `GET
   /stations/{channel}/rsam` para el mismo canal y ventana con
   `period_seconds = 600`, y `samples[i].t` el mismo `t` (centro de la
   ventana): misma `rsam_series()`, misma traza. El endpoint MUST NOT
   calcular amplitud por otra vía.
2. `episodes` MUST ser la salida de `classify_episodes` aplicada a
   `samples` (capa pura), enriquecida con los campos espectrales.
3. `parameters` MUST ser los valores leídos del JSON con los que se
   clasificó.
4. SCNL que no sea de 4 partes ⇒ 422; `end ≤ start` ⇒ 422; ventana > 24 h ⇒
   422; canal sin datos FDSN en toda la ventana ⇒ 404 con `{"detail": ...}`
   (request mono-canal, mismo criterio que `GET /stations/{channel}/rsam`).
5. El endpoint MUST reusar el mismo camino fetch + cache que `/rsam`
   (`get_spectrogram_service().get_waveform_data`, `fdsn_result_cache` con
   `trace_covers_window`), sin tocar `main.py`.

#### Scenario: Tremor y tendencia comparten la serie

- GIVEN un canal y una ventana, con `get_waveform_data` parcheado para
  devolver la misma traza a ambos
- WHEN se pide `GET /analytics/tremor/{channel}` y `GET
  /stations/{channel}/rsam?period_seconds=600` con los mismos `start`/`end`
- THEN `tremor.samples[i].rsam == rsam.samples[i].value` y
  `tremor.samples[i].t == rsam.samples[i].t` para todo `i`

#### Scenario: Una señal constante no tiene episodios

- GIVEN un canal cuya forma de onda es constante en toda la ventana
- WHEN se pide `GET /analytics/tremor/{channel}`
- THEN `episodes` es `[]` y `tremor_fraction` es `0.0`

#### Scenario: Canal sin datos responde 404

- GIVEN un canal sin datos FDSN en la ventana
- WHEN se pide `GET /analytics/tremor/{channel}`
- THEN la respuesta es 404 con `{"detail": ...}`

#### Scenario: Validaciones de borde iguales a /rsam

- WHEN se pide con `channel = "GE.KBU.BHZ"` (3 partes)
- THEN 422
- AND WHEN se pide con una ventana de 25 h
- THEN 422 con `{"detail": ...}`

### Requirement: Hipocentros para el mapa de Analytics — GET /analytics/hypocenters

`GET /analytics/hypocenters` MUST aceptar `days` (Decisión 3, default 30,
`[1, 365]`), `min_mag` opcional y `limit` opcional (default 2000, máximo
5000), leer `seismic_events` recortado al área activa (Decisión 2) y
responder `200` con:

```
{ "eventos": [ { "id", "hora_utc", "lat", "lon", "prof_km": <float | null>,
                 "mag", "mag_tipo", "lugar", ... }, ... ],
  "total": <int>, "truncated": <bool>,
  "window_start": ..., "window_end": ..., "area_slug": <str | null> }
```

Reglas normativas:

1. `total` MUST ser la cantidad de eventos que cumplen el filtro ANTES de
   aplicar `limit`; `truncated` MUST ser `true` si y sólo si `total >
   len(eventos)`.
2. Los eventos con `prof_km = null` MUST incluirse con `prof_km = null` (la
   UI decide cómo dibujarlos); el endpoint MUST NOT descartarlos ni
   inventarles profundidad.
3. `eventos` MUST venir ordenado por `mag` descendente (desempate `hora_utc`
   descendente): un `limit` recorta microsismicidad, nunca el evento grande.
4. El endpoint MUST NOT consultar USGS/EMSC/INPRES en vivo: lee la tabla,
   como `GET /events/recent`.
5. `limit` fuera de `[1, 5000]` o `days` fuera de `[1, 365]` ⇒ 422.
6. Sin `event_store` ⇒ 503.

#### Scenario: Ventana de 30 días recortada al área

- GIVEN `seismic_events` con 10 eventos en el área activa dentro de la
  ventana, 5 fuera del área y 3 dentro del área pero fuera de la ventana
- WHEN se pide `GET /analytics/hypocenters?days=30`
- THEN la respuesta es 200 con `total = 10`, `truncated = false` y `10`
  elementos en `eventos`

#### Scenario: El limit trunca, lo declara y se queda con los grandes

- GIVEN 8 eventos que cumplen el filtro con magnitudes distintas
- WHEN se pide con `limit = 5`
- THEN `eventos` tiene `5` elementos, `total` es `8` y `truncated` es `true`
- AND los 5 devueltos son los 5 de mayor magnitud, en orden descendente

Nota de falsabilidad: la mutación es `ORDER BY mag DESC` → `ORDER BY
hora_utc DESC` en `EventStore.between(order_by_magnitude=True)`: el
escenario deja de traer los 5 mayores.

#### Scenario: Un evento sin profundidad viaja con null

- GIVEN un evento en la ventana con `prof_km = NULL`
- WHEN se pide el endpoint
- THEN ese evento está en `eventos` con `prof_km: null`

#### Scenario: No se consultan fuentes externas

- GIVEN USGS/EMSC/INPRES inalcanzables (los adapters lanzan)
- WHEN se pide `GET /analytics/hypocenters`
- THEN la respuesta es 200 con los eventos de la tabla

### Requirement: No-regresión de los contratos existentes

El diff completo de este change MUST NOT modificar el comportamiento de `GET
/report`, `GET /events`, `GET /events/search`, `GET /events/recent`, `GET
/stations/{channel}/waveform`, `GET /stations/{channel}/spectra` ni `GET
/stations/{channel}/rsam`, ni los archivos `src/services/watchdog.py`,
`src/services/swarm_rsam.py` y `src/services/seedlink_ingestor.py`.

#### Scenario: La batería existente sigue en verde sin cambios

- GIVEN el diff completo del change
- WHEN se corre `./venv/bin/python -m pytest` sobre la suite previa al change
- THEN todos los tests que existían antes siguen en verde
- AND ningún test previo fue modificado ni borrado para lograrlo

#### Scenario: /report no aprendió parámetros nuevos

- GIVEN el diff completo del change
- WHEN se inspecciona la firma de `report()` en `src/main.py`
- THEN sigue aceptando únicamente `sources` y `current_user`

#### Scenario: Los tres archivos protegidos no cambian

- GIVEN el diff completo del change
- WHEN se corre `git diff --stat main -- src/services/watchdog.py src/services/swarm_rsam.py src/services/seedlink_ingestor.py`
- THEN no hay salida
