# Design: Paneles profesionales de análisis en /analytics

> **Reconciliación spec ↔ design (2026-09-04, en `tasks.md`)**: specs y design se
> escribieron en paralelo. Los puntos donde este documento cambió para respetar el
> comportamiento observable de las specs están marcados con `[R#]` y listados en la
> tabla "Reconciliación" de `tasks.md`. Los puntos donde las specs cambiaron para
> seguir el mecanismo de acá también están ahí.

## Technical Approach

Cinco paneles nuevos sobre `/analytics`, todos ADITIVOS: un router nuevo, tres módulos de
lógica pura, UNA migración de tabla plana, UN loop de fondo opt-in, y componentes Recharts /
Leaflet propios de Analytics. Nada de lo existente cambia de contrato (`/report`,
`/stations/{channel}/rsam`, `MagnitudeTimeChart`, `DepthDistributionChart`, `EventsTable`).

El diseño se apoya en cuatro hechos del código que el proposal describe de forma imprecisa
(detalle en "Lo que el proposal dice y el código desmiente", al final):

1. **El catálogo de eventos para estadística ya está en la base.** `seismic_events`
   (migración `deploy/sql/migrations/014_seismic_events.sql`) guarda ~1 año de eventos
   globales con `mag >= source_min_magnitude` (1.0), sin retención (`db/migrations/002…`
   lo documenta: "1,1 MB por año, sin retención"). `/report`, en cambio, trae
   `settings.window_minutes` (default 60 min) de las fuentes EN VIVO — inútil para un
   b-value. El b-value y el mapa de hipocentros leen `seismic_events` vía
   `app.state.event_store` (`src/services/event_store.py`), NO `/report`.
2. **La serie temporal de "qué canal transmitía cuándo" ya existe.** `spectrogram_columns`
   (hypertable, `db/migrations/001_spectrogram_columns.sql`) tiene una fila por canal cada
   `COLUMN_INTERVAL_SECONDS = 4` (`src/services/seedlink_ingestor.py:58`) con 7 días de
   retención (`db/migrations/002`). El uptime de estaciones se DERIVA de ahí y se consolida
   por hora en una tabla plana — no hace falta que nadie "registre transiciones".
3. **RSAM on-demand es una decisión CERRADA del usuario.** Design archivado
   `openspec/changes/archive/2026-08-28-analiticas-profesionales-senal/design.md`,
   Decision 4: no se persiste RSAM, no se toca el ingestor. `RsamAccumulator` vive en la RAM
   del proceso `seedlink_ingestor` (última hora, `swarm_rsam.py:36-75`) y es INALCANZABLE
   desde el `api`. La tendencia RSAM de Analytics reusa `GET /stations/{channel}/rsam`
   (`src/main.py:3001-3103`, con cache eterno FDSN) tal cual está.
4. **No hay plugin de clustering instalado** (`dashboard/package.json`: `leaflet`,
   `react-leaflet`, `leaflet-polylinedecorator`; `leaflet-rotatedmarker` en `node_modules`
   es transitivo). El mapa de hipocentros resuelve la densidad con el renderer canvas
   nativo de Leaflet y un tope server-side honesto, no con un plugin nuevo.

Todo el frontend de gráficos usa Recharts 2.15 (`dashboard/package.json`) con el patrón de
`dashboard/components/MagnitudeTimeChart.tsx` (`useFormatter`/`useTranslations` de next-intl,
ejes `stroke="#9ca3af"`, grilla `#374151`, tooltip custom oscuro, `ResponsiveContainer`).

## Architecture Decisions

### Decision 1: b-value por máxima verosimilitud (Aki 1965 + corrección de bin de Utsu), Mc por máxima curvatura + 0,2, guarda N ≥ 50 sobre Mc

**Choice**: `src/services/gutenberg_richter.py`, lógica pura sobre una lista de magnitudes:

```
Mc  = MAXC + mcCorrection            # bin de máximo conteo del histograma NO acumulado
                                     # (Wiemer & Wyss 2000) + 0,2 (Woessner & Wiemer 2005)
M*  = { Mi : Mi >= Mc }              # catálogo completo (sobre Mc)
N   = |M*|
b   = log10(e) / ( mean(M*) - (Mc - ΔM/2) )       # Aki 1965; ΔM/2 = corrección de Utsu
σ_b = 2.30 · b² · sqrt( Σ(Mi - mean)² / (N·(N-1)) )   # Shi & Bolt 1982
a   = log10(N) + b · Mc
status = "ok" si N >= bValueMinEvents, si no "insufficient"  (sin b, sin a, sin σ)
```

`ΔM = magnitudeBinWidth = 0.1`, `mcCorrection = 0.2`, `bValueMinEvents = 50` viven en
`dashboard/lib/seismic-constants.json` (Decision 7). El endpoint devuelve SIEMPRE el
histograma (acumulado y no acumulado por bin) y `n_above_mc`, `min_events`; devuelve `b`,
`a`, `sigma_b` SOLO cuando `status == "ok"`. El frontend no calcula nada de esto.

**[R6] `Mc` es entrada opcional, no solo estimada.** `fit_b_value(mags, mc=None)`: con
`mc=None` se estima por `estimate_mc_maxc()` (lo de arriba); con `mc` explícito se usa tal
cual y `mc_at_catalog_floor` se calcula igual (informa si ese Mc coincide con el piso del
catálogo). La spec de `signal-analysis` exige que el estimador acepte Mc como entrada (sus
escenarios sintéticos fijan `Mc = 2.0`); la estimación automática es la función aparte
`estimate_mc_maxc()` con sus propios escenarios. El endpoint expone `mc` como query param
opcional con la misma semántica.

**[R8] "Insuficiente" NO lleva la clave `b` en el body (ni `null`).** La spec lo exige como
comportamiento observable ("el campo no existe en ese resultado"), y `Optional[float] =
None` serializaría `"b": null`. El contrato es una unión discriminada por `status`:
`BValueOk` (con `b`, `a`, `sigma_b`) y `BValueNotEstimable` (sin esos campos). Ver
"Interfaces / Contracts".

**[R9] Tercer estado `"degenerate"`.** Si `n_above_mc >= bValueMinEvents` pero TODAS las
magnitudes sobre Mc son iguales (varianza cero), la MLE da `b = log10(e) / (ΔM/2) = 8.69`
— un número serializable y absurdo — y σ_b = 0. La spec exige que ese caso nunca sea
`"ok"`. `status = "degenerate"` comparte el modelo `BValueNotEstimable` con
`"insufficient"`; la UI no muestra número para ningún `status !== "ok"` y elige el mensaje
por status.

**`method`**: la respuesta lleva `method: "aki-utsu-mle"` (identificador fijo del método;
la spec lo pide para que un consumidor futuro — el PDF de `analytics-report-export` — sepa
qué está citando).

**Alternatives considered**:

- **Mínimos cuadrados sobre log10(N≥M) vs M** — descartada. Pesa igual todos los bins,
  incluidos los de magnitud alta con 1-2 eventos, que dominan la pendiente por puro ruido;
  necesita elegir además un corte superior arbitrario; y no tiene una fórmula cerrada de
  incertidumbre. En un catálogo regional chico (el riesgo #1 del proposal) el LS es el
  método que MÁS miente. La MLE de Aki tiene forma cerrada, σ conocida y es el estándar
  (Aki 1965; Utsu 1965; Marzocchi & Sandri 2003 comparan ambos y descartan LS).
- **Mc por goodness-of-fit (GFT, Wiemer & Wyss 2000)** — diferida. Más robusta que MAXC
  pero iterativa y necesita ~200+ eventos para converger; con los catálogos de un área de
  interés de 30 días, MAXC+0,2 es lo que la literatura recomienda como primer paso. Queda
  como refinamiento (Open Questions) si la observación en prod muestra Mc sistemáticamente
  subestimado.
- **Sin guarda de N (mostrar b con σ grande)** — descartada: el proposal lo fija como
  criterio de éxito ("nunca muestra un número"). Un `b = 1.4 ± 0.6` sobre 12 eventos se lee
  como un número, no como una advertencia.
- **N mínimo de 100 o 200** — considerado. 50 es el piso que Wiemer & Wyss (2000) y
  Utsu (1965) citan para que σ_b sea utilizable (con N=50 y una σ típica de M, σ_b ≈ 0,15);
  200 dejaría el panel en "insuficiente" para casi toda área regional durante meses, que es
  exactamente lo contrario de lo que se quiere validar en observación. Es UNA constante en
  el JSON: subirla no es un cambio de código.

**Dos avisos que el número solo no cuenta (se devuelven como flags, la UI los muestra)**:

- `mc_at_catalog_floor: true` cuando el bin MAXC es el más bajo del catálogo: el pico del
  histograma está en el piso de ingesta (`source_min_magnitude = 1.0`,
  `src/config/settings.py`) y Mc real puede ser MENOR — el b-value sigue siendo válido
  sobre `M ≥ Mc` pero Mc está truncado por nosotros, no por la red.
- `mag_type_counts: {Mw: 12, ML: 340, mb: 8, …}`: Gutenberg-Richter asume UNA escala de
  magnitud y el catálogo fusionado USGS+EMSC+INPRES mezcla varias
  (`SeismicEvent.mag_tipo`, `src/models/event.py:18`). No se filtra por tipo en este
  change (partiría aún más el N); se expone para que el que lee sepa qué está mirando.

### Decision 2: Uptime de estaciones = rollup horario en tabla plana (`station_uptime_hourly`), alimentado por un loop del `api` desde `spectrogram_columns`; ni Redis, ni continuous aggregate, ni transiciones del watchdog

**Choice**:

| Aspecto | Decisión |
|---|---|
| Definición | `uptime(canal, hora) = min(1, columns_count / EXPECTED_COLUMNS_PER_HOUR)` con `EXPECTED = 3600 / COLUMN_INTERVAL_SECONDS = 900`, importado de `seedlink_ingestor.py` (no redeclarado). Vale para los DOS ingestores: `seedlink_ingestor_geofon.py:35` reusa la clase `SeedLinkIngestor`, así que escribe con la misma cadencia |
| Granularidad | Bucket de 1 hora (`date_trunc('hour', endtime)`); por día se agrega en la query de lectura (`sum(columns_count) / (24·900)`) |
| Persistencia | `deploy/sql/migrations/021_station_uptime_hourly.sql`: `station_uptime_hourly(channel TEXT, bucket_start TIMESTAMPTZ, columns_count INTEGER, PRIMARY KEY (channel, bucket_start))`. Postgres plano, sin hypertable, sin retención (107 canales × 24 × 365 ≈ 940 k filas/año, decenas de MB) |
| Escritor | `src/services/station_uptime.py::run_uptime_rollup_loop(pool, interval_seconds, stop_event)` arrancado en el lifespan de `src/main.py` con `settings.uptime_rollup_enabled` (default `False`; `True` SOLO en el servicio `api` de Railway — mismo molde que `fdsn_warmup_enabled` / `disk_alert_enabled`, `src/main.py:458-505`) |
| Cadencia | Cada 600 s (`uptime_rollup_interval_seconds`). Cada corrida hace UN `INSERT … SELECT … GROUP BY channel, date_trunc('hour', endtime) … ON CONFLICT (channel, bucket_start) DO UPDATE SET columns_count = EXCLUDED.columns_count` sobre `endtime >= GREATEST(now() - interval '7 days', COALESCE((SELECT max(bucket_start) FROM station_uptime_hourly), '-infinity'))` |
| Auto-reparación | Ese `GREATEST(…)` es lo que hace que una caída del `api` de N horas (N < 7 días) se rellene sola en la primera corrida siguiente, y que el PRIMER deploy ya muestre 7 días de historia (la raw retenida) en vez de arrancar en cero |
| Lectura | `GET /analytics/station-uptime?days=7&bucket=hour\|day&channel=…` (Decision 6), `days ∈ [1, 365]` (la tabla no tiene retención) |
| **[R12] `null` ≠ `0`** | La tabla solo tiene filas donde hubo ≥ 1 columna, así que la LECTURA tiene que distinguir "estación muda" de "nadie miró". Regla: una **hora observada** es un `bucket_start` con al menos una fila para CUALQUIER canal (el pipeline estaba vivo). Para un canal **presente en la ventana** (≥ 1 fila suya en la ventana), `ratio = min(1, count/900)` en cada hora observada, con `count = 0` si no tiene fila en esa hora (⇒ `0.0`, muda); en una hora NO observada `ratio = null`. Un canal pedido SIN ninguna fila en toda la ventana ⇒ todos sus buckets `null` y `overall = null` (no se lo miró; no se lo acusa). `bucket=day`: `ratio = sum(count) / (900 × horas_observadas_del_día)`, `null` si el día no tiene ninguna hora observada; `expected` viaja en la respuesta como `900 × horas observadas` para que la UI pueda decir "sobre 18 h observadas". `overall` usa la misma regla sobre toda la ventana. Es la Decisión 4/5 de la spec de `signal-analysis` ("uptime contra tiempo OBSERVADO, hueco = `null`") implementada sobre esta tabla, sin tocar el rollup |

Costo medido con los números del repo: por corrida normal se leen ~2 h × 107 canales × 900
filas ≈ 190 k filas por el índice `idx_spectrogram_columns_channel_endtime` (existe desde la
001); el backfill de 7 días tras una caída escanea ≈ 16 M filas UNA vez — aceptable para un
job de fondo cada 10 min, y se mide en tasks antes de subir la cadencia.

**Alternatives considered**:

- **Redis (extender `WatchdogStateStore`)** — descartada. `watchdog:state:{componente}`
  guarda `{status, since}` del ÚLTIMO estado y a propósito sin TTL
  (`src/services/watchdog.py:220-268`): es la clave de deduplicación de un incidente, no
  una serie temporal. Convertirla en historia obliga a inventar un esquema de sorted sets
  con rangos por tiempo, sin garantía de persistencia (Redis de Railway) y para un panel
  que quiere SEMANAS. Y lo más importante: el watchdog vigila SERVICIOS (`api`, `ui`,
  `seedlink` como un todo, `events`), no estaciones — `check_seedlink` solo distingue
  "todos mudos" de "alguno vivo" (`watchdog.py:131-181`). Un uptime POR ESTACIÓN no puede
  salir de ahí ni extendiéndolo.
- **Que el watchdog registre transiciones a Postgres** — descartada para este change. Es un
  servicio Railway aparte con acceso de solo lectura a la base (memoria
  `watchdog-servicios-railway-implementado`), corre cada 5 min con umbral de 10 min, y
  produce transiciones de SERVICIO. Persistir esas transiciones es barato
  (`evaluate_and_notify` ya las conoce, `watchdog.py:338-407`) pero responde otra pregunta
  ("¿cuánto estuvo caída la API?"), no la del proposal. Queda en Open Questions.
- **Continuous aggregate de TimescaleDB** — descartada por tres razones concretas:
  (a) NO es testeable en la suite: `tests/conftest.py:26,67` aplica SOLO
  `deploy/sql/migrations` sobre `postgres:16-alpine`, sin la extensión `timescaledb`; nada
  de `db/migrations` corre en tests (lo documenta la propia 014). Un cagg sería la primera
  pieza de este repo con lógica de negocio imposible de verificar contra una base real —
  exactamente lo que `verificar-contra-base-no-con-mocks` prohíbe.
  (b) Un cagg materializa solo sobre raw RETENIDA: con retención de 7 días hay que afinar
  `start_offset`/`refresh policy` para que la materialización no se pierda con el drop del
  chunk — la misma clase de sutileza Timescale que produjo la caída del 2026-08-28
  (`db/migrations/002`, "lo que costó aplicarla").
  (c) No compra nada que la tabla plana no dé: el volumen es minúsculo y el `GROUP BY` de
  2 horas cada 10 min es trivial.
- **Derivar en lectura, sin tabla** — descartada: horizonte de 7 días (retención) y un
  `GROUP BY` sobre ~16 M filas POR REQUEST del panel. Sirve para prototipar, no para un panel
  que además va a ser fuente del PDF semanal de `analytics-report-export`.
- **Escribir desde el ingestor SeedLink** — descartada por la Decision 4 archivada: el
  proceso más frágil del sistema no gana escrituras nuevas por una feature de lectura
  (`ingestor-salia-con-codigo-cero`). El rollup corre en el `api`, que ya tiene loops de
  fondo con el mismo molde.
- **Registrar transiciones up/down por canal** (en vez de conteos) — descartada: exige un
  poller con umbral de "mudo" (otro `STALE_AFTER_SECONDS` a justificar) y pierde el matiz
  de una hora al 60 %. El conteo de columnas ES el dato de entrega; el ratio es el uptime.

**Consecuencia para el proposal**: `src/services/watchdog.py` NO se modifica en este change
(el proposal lo lista como "Modified"). Ver la sección final.

### Decision 3: La tendencia RSAM de Analytics reusa `GET /stations/{channel}/rsam` — sin endpoint nuevo, sin persistencia, ventana ≤ 24 h

**Choice**: `RsamTrendChart` (Recharts `LineChart`) pide en paralelo, desde el cliente,
`seismicAPI.getStationRsam(channel, window, 600)` (`dashboard/lib/api.ts:165-175`) para
hasta 4 canales elegidos en un `StationPicker` alimentado por
`GET /spectrograms/station-catalog` (`src/main.py:2579`, `StationCatalogEntry` en
`dashboard/lib/types.ts:331`). Período fijo 600 s (`RSAM_PERIOD_SECONDS`, el de SWARM):
24 h ⇒ 144 puntos por canal. `Promise.allSettled`: un canal sin datos FDSN (404, ver
`helicorder-loader-y-error-honesto`) degrada SOLO su serie, no el panel.

**Por qué no un endpoint de agregación nuevo**: el proposal habla de "agregar muestras de
`RsamAccumulator`/`rsam_series`". `RsamAccumulator` vive en la RAM del proceso
`seedlink_ingestor` (`seedlink_ingestor.py:102,205`) y retiene UNA hora; lo único que sale
de ahí es el número instantáneo `rsam` del snapshot de métricas en Redis
(`_publish_metrics` → `MetricsStore.set_snapshot`, con TTL). No hay muestras que agregar
desde el `api`. `rsam_series` (`swarm_rsam.py:100-117`) ya está expuesto por el endpoint
existente, con cache en memoria (`spectrogram_cache_ttl_seconds`) y cache eterno en DB
(`fdsn_result_cache`, migración 016): la segunda vez que alguien mira la misma ventana
responde en milisegundos. Un endpoint batch server-side haría los mismos N fetches FDSN y
sumaría un semáforo de concurrencia que hoy nadie necesita.

**Alternatives considered**:

- **Persistir RSAM desde el ingestor en una hypertable para tendencias multi-día** —
  descartada: revierte una decisión cerrada del usuario con argumento explícito ("si duele
  en uso real, la persistencia se evalúa DESPUÉS con datos"). Este change es la
  oportunidad de juntar esos datos: el panel de 24 h va a mostrar si 24 h alcanzan. Queda en
  Open Questions con el criterio de reapertura.
- **Reusar `RsamChart.tsx`** (`dashboard/components/RsamChart.tsx`, canvas, ventana de
  2 min del helicorder, período adaptativo) — descartada: es un componente de detalle de
  estación pensado para alinear píxeles con el helicorder (`MARGIN_LEFT = 56`), sin ejes
  formateados ni multi-serie. El proposal exige Recharts y el patrón de
  `MagnitudeTimeChart`. Conviven: mismo endpoint, dos consumidores.

**Límite explícito en UI**: el selector de ventana del panel de señal ofrece 6 h / 12 h /
24 h (tope `MAX_WAVEFORM_WINDOW_HOURS = 24`, `src/main.py:2770`), separado del selector de
DÍAS de los paneles de catálogo (Decision 8). El warm-up de FDSN precalienta claves
`waveform:*`, no `rsam:*` (`src/services/fdsn_warmup.py:43-45`): la primera carga de un
canal tarda segundos y el panel lo dice con un loader por serie, no con un spinner global.

### Decision 4: Tremor = lógica pura sobre la MISMA traza FDSN (RSAM + espectro por período), en `GET /analytics/tremor/{channel}`; etiqueta "episodio sostenido", nunca "tremor detectado"

**Choice [R2]**: `src/services/tremor.py` tiene DOS capas, porque la spec de
`signal-analysis` exige que la CLASIFICACIÓN sea una función pura sobre la serie RSAM (la
misma forma que `samples` de `/rsam`) y que NUNCA reciba la forma de onda — así queda una
sola fórmula de amplitud, y el clasificador se testea con listas de números, sin FDSN ni
FFT:

```
# Capa 1 — clasificación PURA sobre la serie RSAM (spec signal-analysis):
classify_episodes(samples: list[tuple[datetime, float | None]]) -> TremorClassification
    baseline    = median(valores no nulos)          # None si no hay ninguno
    threshold   = tremorBaselineFactor × baseline   # 2.0 × mediana
    elevada[i]  = value[i] is not None and value[i] >= threshold
    episode     = corrida de ≥ tremorMinDurationPeriods (3 ⇒ 30 min) muestras CONSECUTIVAS elevadas;
                  un None NO es elevado NI cero: corta la corrida
    por episodio: start, end (t de la primera y última muestra), samples (cantidad),
                  mean_ratio (media de value/baseline), peak_rsam, peak_ratio, onset_ratio
    tremor_fraction = muestras dentro de algún episodio / muestras no nulas  (0.0 si no hay)

# Capa 2 — enriquecimiento espectral sobre la MISMA traza (lo que el proposal llama
# "caracterización"); es la que llama el endpoint:
characterize(signal, fs, start) -> TremorResult      # start = starttime de la traza, para los t
    period      = RSAM_PERIOD_SECONDS (600 s, importado de swarm_rsam.py)
    rsam[i]     = rsam_series(signal, fs, period)              # la MISMA fórmula del muro
    t[i]        = centro de la ventana i (como /rsam)
    cls         = classify_episodes(zip(t, rsam))              # capa 1
    por período: (freqs, power_db) = window_spectrum_db(block, fs)     # signal_spectrum.py:22
                 dominant_hz = dominant_frequency_hz(freqs, power_db)  # swarm_spectra.py:96
                 fi          = frequency_index(freqs, power_db)        # swarm_spectra.py:113
    por episodio (además de lo de la capa 1): duration_s, mean_dominant_hz, mean_fi,
                 band  = "low" (< tremorLowBandMaxHz) | "mid" (< tremorMidBandMaxHz) | "high" | "undefined"
                 fi_sign = "lp_like" (fi < 0) | "vt_like" (fi ≥ 0) | "undefined" (fi None)
```

`rsam_series` devuelve `list[float]` (nunca `None`), así que en producción la capa 1 no ve
`None`; la regla del `None` existe porque la firma de la spec lo admite y porque un caller
futuro (una serie persistida con huecos) no debe reinterpretar un hueco como silencio.

El endpoint calca el patrón fetch+cache de `get_station_rsam` (`src/main.py:3021-3103`):
validar SCNL de 4 partes, normalizar tz, ventana ≤ 24 h, `cache` en memoria por clave,
`fdsn_result_cache` en DB, `get_spectrogram_service().get_waveform_data(...)`, `trace =
max(stream, key=npts)`, congelar en DB solo si `trace_covers_window`. Todo eso es
importable desde `src/services` (`get_spectrogram_service`, `spectrogram_service.py:912`;
`trace_covers_window`, `fdsn_result_cache.py:40`), así que vive en el router nuevo sin
tocar `main.py`.

**Alternatives considered**:

- **Consumir `rsam` + `fi` de `spectrogram_columns` / snapshot de métricas** — descartada.
  Las columnas guardan `power_db` por bin (sirve para `frequency_index`) pero NO la
  amplitud: RSAM no se reconstruye desde un espectrograma en dB. Mezclar RSAM on-demand
  (FDSN) con FI de la base cruzaría dos fuentes con dos relojes para la misma ventana.
  Calcular todo sobre la única traza en mano es lo coherente con "el número del muro y el
  del gráfico salen de la MISMA fórmula" (Decision 4 archivada).
- **Umbral absoluto tipo SWARM (`EVENT_THRESHOLD = 50` cuentas)** — descartada como
  criterio de episodio: las cuentas dependen del instrumento y de la ganancia; un factor
  sobre la mediana de la propia ventana es portable entre los 107 canales. Se documenta la
  limitación: un tremor que ocupe MÁS de la mitad de la ventana sube la mediana y no se
  detecta como episodio — el panel muestra `baseline_rsam` para que eso sea visible, y la
  ventana de 24 h la acota.
- **Clasificador "es tremor volcánico: sí/no"** — descartada. Con una estación, sin
  localización ni contexto volcánico, un booleano así es una afirmación que el sistema no
  puede sostener. Lo que SÍ puede afirmar: amplitud sostenida durante X min, banda dominante,
  signo de FI (la propia docstring de `frequency_index` dice "negativo = LP/fluidos,
  positivo = VT/fractura") y si el inicio fue emergente (`onset_ratio` bajo) o impulsivo
  (un sismo grande dura minutos y arranca en pico). La UI lo llama "episodio sostenido
  (candidato a tremor)" y muestra los parámetros; la interpretación es del sismólogo.
- **Ventanas STFT solapadas como el espectrograma** — descartada: RSAM se define sobre
  ventanas contiguas no solapadas (`rsam_series`, docstring); los bloques espectrales usan
  los MISMOS cortes para que cada punto del gráfico tenga un FI asociado sin interpolar.

Costo: 1 fetch FDSN (cacheado) + 144 FFT de 600 s (12 k muestras a 20 Hz, 60 k a 100 Hz):
milisegundos cada una, sin threadpool (mismo criterio "medir antes de paralelizar").

### Decision 5: Mapa de hipocentros propio, Leaflet con `preferCanvas: true`, sin plugin de clustering; tope server-side honesto y color por profundidad

**Choice**: `dashboard/components/analytics/HypocenterMap.tsx`, imperativo con
`import('leaflet')` (mismo patrón que `StationMiniMap.tsx` y el mapa de `/live`; no
`react-leaflet`, que está en `package.json` pero NINGÚN mapa del repo usa), creado con
`L.map(container, { preferCanvas: true })`. Un `L.circleMarker` por evento:
`fillColor = getDepthColor(prof_km)` (`dashboard/lib/utils.ts:65`, los MISMOS cortes que
`DepthDistributionChart`), radio por magnitud, `bindPopup` solo al click. **[R26]** Un
evento con `prof_km === null` NO pasa por `getDepthColor` (que con `0` daría el color de
"< 70 km", una mentira): `markerStyle(ev)` le da un estilo "sin profundidad" distinguible
(relleno transparente, borde gris punteado) y el popup dice "sin profundidad"; se cuenta en
`total` como cualquier otro. Una sola capa base
(`BASE_LAYERS.greyscale`, `dashboard/lib/map-layers.ts` — CARTO Positron, verificado con
curl en su momento, y el fondo claro es el que deja leer colores por profundidad). Encuadre
inicial con `areaViewBounds(areaGeometry, bbox)` (`dashboard/lib/area-view-bounds.ts:45`,
lib pura) sobre el área activa. Sin ciudades, sin placas, sin selector de capas, sin
refresco periódico, sin ningún import de `AdvancedSeismicMap.tsx` ni
`SeismicMapWithCities.tsx` (criterio de éxito del proposal).

Datos: `GET /analytics/hypocenters?days=30&min_mag=&limit=2000` (Decision 6) sobre
`seismic_events`, **ordenado por magnitud DESC** y con `limit` ≤ 5000 (los mismos límites de
`/events/recent`, `src/main.py:2496-2499`). La respuesta trae `total` y `truncated`; si
`truncated`, la UI dice "Mostrando 2000 de 8 431 — subí la magnitud mínima" (i18n). Ordenar
por magnitud garantiza que el recorte se lleva microsismicidad, nunca el M6.

**Alternatives considered**:

- **`leaflet.markercluster`** — descartada con evidencia:
  (a) no está instalado; (b) es UMD y sufre el MISMO gotcha que `leaflet-polylinedecorator`
  (`leaflet-plugins-umd-esm-namespace`: hay que publicar `window.L` antes del `import()` y
  leer el namespace que quedó decorado, con throw explícito) — una segunda copia de ese
  workaround; (c) agrupa `L.Marker` (un nodo DOM por marcador, lo caro) y sus burbujas
  TAPAN la codificación profundidad/magnitud, que es la razón de ser de un mapa de
  hipocentros; (d) el problema que resuelve — miles de nodos DOM — no existe con
  `circleMarker` sobre canvas.
- **Agregación server-side (grilla/hexbin)** — descartada: pierde el hipocentro individual,
  agrega esquema y lógica de zoom-dependiente. Si algún día hace falta, se apoya en
  `truncated` de este contrato, no lo reemplaza.
- **SVG renderer (el default, que usa `/live`)** — descartada: `AdvancedSeismicMap`
  crea `L.map(container)` sin `preferCanvas` (`AdvancedSeismicMap.tsx:224`) y funciona con
  ~centenas de eventos de `/report`; con 5 000 nodos SVG el zoom se vuelve pesado. La
  memoria `leaflet-render-cost-vertices-not-features` lo cuantifica: el costo lo manda el
  vértice, y un `circleMarker` es UN vértice — 5 000 marcadores son 5 k vértices contra los
  269 k del PB2002 crudo que `/live` ya tolera; en canvas, menos todavía.
- **Reusar `AdvancedSeismicMap` con props** — descartada por el proposal (comportamiento
  "todo en vivo", cities, placas, `onBoundsChange`, selector de capas) y por lo que la
  memoria registra tres veces: ese componente acumula efectos con refs
  (`react-effect-ref-dependency-trap`); sumarle un modo más es sumarle superficie de bugs.

**Corte de profundidad (SHOULD, recortable en tasks)**: `DepthSectionChart` (Recharts
`ScatterChart`: X = longitud del área, Y = `prof_km` con `reversed`, color por magnitud) al
lado del mapa. Es el único gráfico que muestra el HIPOCENTRO (el mapa muestra epicentros con
la profundidad en color) y cuesta un componente sobre los mismos datos. Si `sdd-tasks` ve el
change inabarcable, es lo primero que se cae — el contrato del endpoint no cambia.

### Decision 6: Un router `src/api/routers/analytics.py` (prefijo `/analytics`), público, con área opcional por sesión; `EventStore.between()` nuevo con filtro de dos etapas

**Choice**: cuatro endpoints en un router (molde `src/api/routers/stations.py`: `APIRouter`,
DI vía `request.app.state`, guard explícito del 503 — "no delegar en asserts que `python -O`
elimina"):

| Endpoint | Fuente | Auth | Nota |
|---|---|---|---|
| `GET /analytics/b-value?days=30&min_mag=&mc=` | `app.state.event_store` | `get_current_user_optional` → área activa (o default) vía `app.state.area_service` | 503 si `event_store is None` (patrón `/events/recent`); `days ∈ [1, 365]` (`Query(ge=1, le=365)` ⇒ 422 fuera de rango); `mc` opcional [R6] |
| `GET /analytics/hypocenters?days=30&min_mag=&limit=2000` | ídem | ídem | `ORDER BY mag DESC, hora_utc DESC`, `total` + `truncated`; `days ∈ [1, 365]`, `limit ∈ [1, 5000]` |
| `GET /analytics/station-uptime?days=7&bucket=hour\|day&channel=…` | `app.state.db_pool` → `station_uptime_hourly` | pública | `days ∈ [1, 365]`; `days > 14` fuerza `bucket=day` (tope de puntos); `channel` repetible; sin `channel` ⇒ todos los canales con filas en la ventana; clave = `channel` de 4 partes tal como lo guarda `spectrogram_columns` (`trace.id`) |
| `GET /analytics/tremor/{channel}?start&end` | FDSN (+ caches) | pública | ventana ≤ 24 h, mismas validaciones que `/rsam` (SCNL de 4 partes ⇒ si no 422; `end ≤ start` ⇒ 422; > 24 h ⇒ 422; sin datos ⇒ 404) |

Política de auth = la de `/report`, `/events/recent`, `/stations/*`: los datos sísmicos son
públicos; la sesión solo PERSONALIZA (área). La resolución de área copia
`src/main.py:820-836`: `try` alrededor de `area_service.get_active(user.id)` /
`get_default()`, `area_to_filter_dict()` (`geo_filter.py:237`), y si falla se degrada a
global con `logger.exception` — nunca 500 por el recorte.

`EventStore.between(start, end, min_magnitude, bbox, limit, order)` es un método nuevo en
`src/services/event_store.py` (donde viven `_COLUMNS` y `_row_to_event`, para no
desincronizar el SELECT): la etapa 1 (bbox) va en SQL (`lat BETWEEN … AND lon BETWEEN …`,
cubierta por `seismic_events_hora_mag_idx` en el rango de `hora_utc`), la etapa 2
(`point_in_area`, Shapely) en Python sobre el resultado — el mismo fast-path de dos etapas
de `geo_filter.point_in_area`. Un área que cruza el antimeridiano declara bbox `-180..180`
(`antimeridiano-recorte-solo-sirve-convexo`): la etapa 1 no filtra nada y la 2 hace el
trabajo — correcto, solo más lento, y acotado por `limit`.

**Alternatives considered**:

- **Endpoints en `src/main.py` junto a `/rsam`** — descartada: `main.py` tiene 3 200+ líneas
  y el proposal pide "`src/api/` (o router equivalente)"; los routers existen desde
  `areas.py` y el patrón `app.state` + `Depends` está probado. Lo único que obligaría a
  `main.py` sería depender de un global de módulo (`column_writer`, `cache` no —
  `src.services.cache` es importable); el uptime usa `app.state.db_pool` (mismo DSN) y el
  tremor importa lo suyo de `src/services`. Sin dependencia, sin razón.
- **Calcular b-value en el cliente sobre `/report`** — descartada (ventana de 60 min).
- **Un endpoint único `/analytics/summary`** — descartada: cinco fuentes con cinco costos
  distintos (una es FDSN de segundos) en una respuesta hace que el más lento arrastre a los
  demás y que un 404 de FDSN tumbe el b-value. Paneles independientes, SWR independiente.

### Decision 7: Las constantes nuevas tienen UNA fuente: `dashboard/lib/seismic-constants.json`

**Choice**: se agregan al JSON existente (`{"helicorderPointsVariants", "pVelocityKmS",
"vpVsRatio", "codaA", "codaB"}`) las claves `bValueMinEvents: 50`, `magnitudeBinWidth: 0.1`,
`mcCorrection: 0.2`, `tremorBaselineFactor: 2.0`, `tremorMinDurationPeriods: 3`,
`tremorLowBandMaxHz: 2.0`, `tremorMidBandMaxHz: 5.0`. `gutenberg_richter.py` y `tremor.py`
las cargan con el patrón EXACTO de `src/services/signal_picks.py:29-40` (`Path(...).parents[2]
/ "dashboard" / "lib" / "seismic-constants.json"`, acceso por clave sin `.get` — "la clave
ausente debe reventar acá"). El frontend importa el JSON (`import constants from
'@/lib/seismic-constants.json'`, como `lib/signal-picks.ts:12`) para dibujar los bins del
histograma, la línea de umbral del tremor y la leyenda de bandas con los MISMOS números.

**Por qué van al JSON y no a una constante Python**: cada una tiene un consumidor en los dos
lados (bin del histograma ↔ bin del ajuste; umbral dibujado ↔ umbral aplicado; bandas de la
leyenda ↔ bandas de la clasificación). Es el caso exacto de `Decision 9` del design archivado
y de `escala-magnitud-tres-fuentes-de-verdad`: una constante duplicada no falla, DERIVA.
`RSAM_PERIOD_SECONDS`, `FI_LOW_BAND_HZ`, `COLUMN_INTERVAL_SECONDS` NO se copian al JSON: ya
tienen su fuente en Python y el frontend no los necesita (el período viaja en la respuesta
como `period_seconds`, igual que hoy).

Recordatorio de deploy: los cuatro Dockerfiles de `deploy/docker/` (`Dockerfile`,
`Dockerfile.seedlink`, `Dockerfile.seedlink-geofon`, `Dockerfile.events-worker`) ya copian
`dashboard/lib/seismic-constants.json` con un `COPY` explícito porque `signal_picks.py` lo lee
(`dockerfiles-no-copian-dashboard`, verificado 2026-09-04). Este change no agrega ningún
archivo nuevo fuera de `src/`, así que no hay COPY nuevo que escribir; `Dockerfile.watchdog`
no lo copia y no lo necesita.

### Decision 8: Frontend — paneles independientes con SWR propio, dos selectores de ventana (días para catálogo, horas para señal), libs puras testeables

**Choice**: `dashboard/app/(app)/analytics/page.tsx` conserva `useSWR('/report')` para los
tres bloques existentes y agrega:

- Estado de página: `catalogDays` (7 / 30 / 90 / 365, default 30) y `signalWindow`
  (6 h / 12 h / 24 h, default 24 h) + `channels: string[]` (≤ 4) del `StationPicker`.
- Cada panel nuevo tiene su `useSWR` con clave que incluye sus parámetros
  (`['/analytics/b-value', days]`, …); `useAreaRefresh(() => Promise.all([mutate(), …]))`
  revalida TODAS las claves que dependen del área (b-value, hipocentros) — el hook exige
  devolver el `Promise.all` para que el indicador cubra a todas (docstring de
  `lib/use-area-refresh.ts`). Uptime, RSAM y tremor NO dependen del área y no se revalidan.
- **[R21]** `catalogDays` alimenta a b-value, hipocentros Y uptime (`days` del endpoint;
  el diagrama de abajo lo refleja); `signalWindow` + `channels` alimentan a RSAM y tremor.
  Ningún panel nuevo tiene `refreshInterval`.
- **[R27]** `mergeSeriesByTime` deja `null` (no `undefined`, no `0`) donde un canal no tiene
  muestra en un `t`: es lo que la spec fija como "hueco", y Recharts lo corta igual con
  `connectNulls={false}`.
- Un panel que falla muestra SU tarjeta de error (`role="alert"`, como `RsamChart.tsx`),
  nunca el `loadError` de página. `BValueChart` con `status === "insufficient"` renderiza el
  histograma (dato honesto) y una tarjeta explícita con `n_above_mc` / `min_events`, SIN
  línea de ajuste ni número.
- Lógica de forma en libs puras (`dashboard/lib/*.ts`), como `helicorder-layout.ts` o
  `progressive-disclosure.ts`: los componentes Recharts solo mapean filas a `<Line>`/`<Bar>`.
  Motivo: ningún test del repo renderiza Recharts (`rg recharts --glob '*.test.tsx'` no
  encuentra nada) y `ResponsiveContainer` mide 0×0 en jsdom — lo verificable es la
  transformación, no el SVG.
- i18n: claves nuevas bajo `analytics.*` en `dashboard/messages/es.json` y `en.json` con
  paridad (los tests de componentes cargan los JSON reales, p. ej.
  `components/SpectrumView.test.tsx`).

**Alternatives considered**: un solo selector de ventana para todo — descartada: el tope de
24 h de FDSN y los 30-365 días de catálogo son dos escalas distintas; un selector único
obligaría a mentir en uno de los dos extremos ("365 días" de RSAM que devuelve 24 h).

## Data Flow

### Vista general

```
                     ┌──────────────── /analytics (page.tsx) ────────────────┐
                     │ catalogDays ─┬─► BValueChart      ─► GET /analytics/b-value      │
                     │              ├─► HypocenterMap    ─► GET /analytics/hypocenters  │
                     │              │   (+DepthSection)                                  │
                     │              └─► StationUptime    ─► GET /analytics/station-uptime│
                     │ signalWindow ┬─► RsamTrendChart   ─► GET /stations/{ch}/rsam ×N  │
                     │ + channels   └─► TremorPanel      ─► GET /analytics/tremor/{ch}  │
                     └────────────────────────────────────────────────────────┘
                                          │
     ┌────────────────────────────────────┼──────────────────────────────────┐
     ▼                                    ▼                                  ▼
 seismic_events (1 año)          FDSN + cache eterno (016)         station_uptime_hourly (021)
 EventStore.between()            get_waveform_data()                      ▲ rollup cada 600 s
 bbox SQL + point_in_area        rsam_series / tremor.py                  │ (loop del api)
                                                                 spectrogram_columns (7 días)
                                                                          ▲ cada 4 s
                                                              seedlink_ingestor (sin cambios)
```

### Secuencia: rollup de uptime (toca el pipeline SeedLink → Timescale; requerido por config.yaml)

```
seedlink_ingestor        TimescaleColumnWriter        spectrogram_columns     api lifespan          station_uptime_hourly
      │  tick 4 s              │                            │                    │                          │
      ├─ add_column ──────────►│ flush por lote ───────────►│                    │                          │
      │                        │                            │                    │                          │
      │                        │                            │   cada 600 s       │                          │
      │                        │                            │◄── INSERT…SELECT   │                          │
      │                        │                            │    channel,        │                          │
      │                        │                            │    date_trunc(h),  │                          │
      │                        │                            │    count(*)        │                          │
      │                        │                            │    WHERE endtime ≥ │                          │
      │                        │                            │    GREATEST(now-7d,│                          │
      │                        │                            │      max(bucket))  │                          │
      │                        │                            │    GROUP BY 1,2 ───┼── ON CONFLICT DO UPDATE ─►│
      │                        │                            │                    │                          │
      │                        │  retención 7 d (drop chunk)│                    │   (sin retención)        │
      │                        │  ──────────────────────────X                    │                          │
      │                        │                            │                    │                          │
                                                       GET /analytics/station-uptime ───────────────────────►│
                                                            bucket=hour: ratio = min(1, count/900); hora sin │
                                                                         fila de NINGÚN canal ⇒ null [R12]   │
                                                            bucket=day : sum(count)/(900·horas observadas)   │
```

Invariante: el rollup NUNCA lee más atrás de 7 días (no hay raw) ni más atrás del último
bucket ya escrito (idempotencia + costo). El bucket de la hora en curso se reescribe en cada
corrida hasta que cierra: `columns_count` de una hora parcial crece monótonamente y la UI lo
marca como "en curso" si `bucket_start + 1h > now`.

### Secuencia: b-value con guarda de N

```
BValueChart ── GET /analytics/b-value?days=30 ──► router
                                                   │ get_current_user_optional → área (o default; falla ⇒ global, log)
                                                   │ event_store.between(now-30d, now, min_mag, bbox, limit=None)
                                                   │ point_in_area() sobre el resultado (etapa 2)
                                                   │ gutenberg_richter.fit_b_value(mags, mc=<query o None>)
                                                   │    ├─ histograma no acumulado por ΔM=0.1
                                                   │    ├─ Mc = query mc, o MAXC + 0.2 ; mc_at_catalog_floor
                                                   │    ├─ N = |M ≥ Mc|
                                                   │    ├─ N < 50 ─► status="insufficient" (SIN claves b/a/sigma_b)
                                                   │    ├─ todas iguales ─► status="degenerate" (ídem)
                                                   │    └─ si no ─► status="ok": b, σ_b, a
                                                   ▼
                     200 BValueOk { status:"ok", method, n_total, n_above_mc, min_events, mc,
                                    mc_at_catalog_floor, b, a, sigma_b, bins[{m, count, cumulative}],
                                    mag_type_counts, window_start, window_end, area_slug }
                     200 BValueNotEstimable { status:"insufficient"|"degenerate", method, n_total,
                                    n_above_mc, min_events, mc, mc_at_catalog_floor, bins, mag_type_counts,
                                    window_start, window_end, area_slug }      ← sin b/a/sigma_b
```

## File Changes

### Backend

| File | Action | Description |
|------|--------|-------------|
| `deploy/sql/migrations/021_station_uptime_hourly.sql` | Create | Tabla plana `station_uptime_hourly`, idempotente (`IF NOT EXISTS`), índice `(bucket_start)` para la lectura por rango; comentario con rollback |
| `src/config/settings.py` | Modify | `uptime_rollup_enabled: bool = False`, `uptime_rollup_interval_seconds: int = 600` en el bloque de loops opt-in (junto a `fdsn_warmup_*`/`disk_alert_*`, mismo comentario "SOLO en el servicio api") |
| `src/services/station_uptime.py` | Create | `EXPECTED_COLUMNS_PER_HOUR` (derivada de `COLUMN_INTERVAL_SECONDS`), `rollup_once(pool)`, `run_uptime_rollup_loop(pool, interval_seconds, stop_event)` (molde `disk_alert.py:75-94`), `build_uptime_series(rows, start, end, bucket, channels, now)` (pura, [R12]), `fetch_uptime(pool, start, end, bucket, channels, now)` |
| `src/services/gutenberg_richter.py` | Create | Carga del JSON (patrón `signal_picks.py:29-40`), `METHOD`, `magnitude_bins()`, `estimate_mc_maxc()`, `fit_b_value(mags, mc=None) -> BValueFit` con guarda y estado `degenerate` [R6][R8][R9] |
| `src/services/tremor.py` | Create | Carga del JSON, `classify_episodes(samples)` (pura sobre la serie RSAM, [R2]) y `characterize(signal, fs, start) -> TremorResult` (importa `rsam_series`, `RSAM_PERIOD_SECONDS`, `window_spectrum_db`, `dominant_frequency_hz`, `frequency_index`) |
| `src/services/event_store.py` | Modify | `between(start, end, *, min_magnitude, bbox, limit, order_by_magnitude)` reutilizando `_COLUMNS`/`_row_to_event` |
| `src/models/analytics.py` | Create | Pydantic: `MagnitudeBin`, `BValueOk`, `BValueNotEstimable`, `BValueResponse` (unión discriminada), `HypocentersResponse`, `UptimeBucket`, `StationUptimeResponse`, `TremorParameters`, `TremorEpisode`, `TremorResponse` |
| `src/api/routers/analytics.py` | Create | Los 4 endpoints (Decision 6); helpers `_get_event_store`, `_get_db_pool`, `_resolve_area` |
| `src/main.py` | Modify | Aditivo: `app.include_router(analytics_router.router)` (l. 593-598) y arranque/parada del `uptime_rollup` en el lifespan con el molde exacto de `disk_alert_task` (l. 482-505, 520-524) |
| `dashboard/lib/seismic-constants.json` | Modify | 7 claves nuevas (Decision 7) |
| `.env.example` | Modify | `UPTIME_ROLLUP_ENABLED`, `UPTIME_ROLLUP_INTERVAL_SECONDS` documentadas |

`src/services/watchdog.py`, `src/services/swarm_rsam.py`, `src/services/seedlink_ingestor.py`:
**sin cambios** (el proposal listaba los dos primeros como "Modified/Extended" — ver la
sección final).

### Frontend

| File | Action | Description |
|------|--------|-------------|
| `dashboard/lib/analytics.ts` | Create | Tipos TS espejo de `src/models/analytics.py` + fetchers `getBValue(days)`, `getHypocenters(days, minMag, limit)`, `getStationUptime(days, bucket, channels)`, `getTremor(channel, window)` (`credentials: 'include'`, molde `lib/feedback.ts`) |
| `dashboard/lib/b-value-plot.ts` (+ `.test.ts`) | Create | `toFmdRows(bins)` (log10 seguro para 0), `fittedLinePoints(a, b, mc, maxM)`, `insufficientMessageArgs(result)` |
| `dashboard/lib/uptime-series.ts` (+ `.test.ts`) | Create | `rankStations(buckets)` (peor primero), `stationTimeline(buckets, channel)`, `isBucketInProgress(bucket, now)` |
| `dashboard/lib/tremor-episodes.ts` (+ `.test.ts`) | Create | `episodesToReferenceAreas(episodes, samples)`, `bandLabelKey(band)`, `thresholdLine(baseline)` — lee `tremorBaselineFactor` del JSON |
| `dashboard/lib/hypocenter-markers.ts` (+ `.test.ts`) | Create | `markerRadius(mag)`, `markerStyle(ev)` (usa `getDepthColor`; `prof_km === null` ⇒ estilo "sin profundidad" SIN pasar por `getDepthColor` [R26]), `truncationNotice(total, shown)` |
| `dashboard/lib/rsam-trend.ts` (+ `.test.ts`) | Create | `mergeSeriesByTime(responses)` → filas `{t, [channel]: value \| null}` para `LineChart` multi-serie (hueco = `null` [R27]); `signalWindowFromHours(h, now)` |
| `dashboard/components/analytics/AnalyticsWindowSelector.tsx` | Create | Selector de días (catálogo) y de horas (señal), dos controles separados |
| `dashboard/components/analytics/StationPicker.tsx` | Create | Hasta 4 canales del `station-catalog` (`getStationCatalog`), badge `is_live` |
| `dashboard/components/analytics/RsamTrendChart.tsx` (+ `.test.tsx`) | Create | Recharts `LineChart` multi-serie, loader/error POR serie |
| `dashboard/components/analytics/TremorPanel.tsx` (+ `.test.tsx`) | Create | `ComposedChart` (RSAM + `ReferenceLine` umbral + `ReferenceArea` por episodio) + tabla de episodios con `start`/`end`/`duration_s`/`mean_ratio`/`band`/`fi_sign`/`onset_ratio` + `tremor_fraction` y `parameters` visibles + estado "sin episodios" / "sin datos para este canal" (404) |
| `dashboard/components/analytics/StationUptimeChart.tsx` (+ `.test.tsx`) | Create | `BarChart` ranking (% por estación, peor primero; `overall === null` ⇒ "sin observaciones", nunca `0 %`) + timeline de la estación seleccionada (`ratio === null` ⇒ sin barra + "sin observación"; `0` ⇒ barra de altura cero con "0 %"; `in_progress` marcado) |
| `dashboard/components/analytics/BValueChart.tsx` (+ `.test.tsx`) | Create | `ComposedChart` FMD (Bar no acumulado + Scatter acumulado, Y log) + `Line` del ajuste SOLO si `status === "ok"`; tarjeta "insuficiente" |
| `dashboard/components/analytics/HypocenterMap.tsx` (+ `.test.tsx`) | Create | Leaflet canvas (Decision 5), `<link>` CSS como `StationMiniMap`, aviso de truncado |
| `dashboard/components/analytics/DepthSectionChart.tsx` | Create (SHOULD) | `ScatterChart` lon × prof_km (Y `reversed`) |
| `dashboard/app/(app)/analytics/page.tsx` | Modify | Estado de ventanas/canales, grilla con los paneles nuevos, `useAreaRefresh` con `Promise.all` de las claves dependientes del área |
| `dashboard/messages/es.json`, `dashboard/messages/en.json` | Modify | `analytics.*` nuevas con paridad |

## Interfaces / Contracts

```python
# src/models/analytics.py

class MagnitudeBin(BaseModel):
    m: float            # borde inferior del bin (múltiplo de magnitudeBinWidth)
    count: int          # no acumulado
    cumulative: int     # N(M >= m)

class _BValueBase(BaseModel):
    method: Literal["aki-utsu-mle"]
    n_total: int
    n_above_mc: int
    min_events: int                 # bValueMinEvents del JSON — la UI no lo hardcodea
    mc: Optional[float]             # None si el catálogo está vacío
    mc_at_catalog_floor: bool
    bins: list[MagnitudeBin]
    mag_type_counts: dict[str, int] # "unknown" para mag_tipo None
    window_start: datetime
    window_end: datetime
    area_slug: Optional[str]        # None ⇒ global (área no resuelta)

class BValueOk(_BValueBase):        # [R8] unión discriminada: "insufficient" NO lleva b
    status: Literal["ok"]
    b: float
    a: float
    sigma_b: float

class BValueNotEstimable(_BValueBase):
    status: Literal["insufficient", "degenerate"]   # [R9]

BValueResponse = Annotated[Union[BValueOk, BValueNotEstimable], Field(discriminator="status")]

# src/services/gutenberg_richter.py devuelve el mismo par (BValueFit = dataclass con los
# mismos campos menos window/area); el router solo agrega ventana y área.

class HypocentersResponse(BaseModel):
    eventos: list[SeismicEvent]     # ORDER BY mag DESC, recortado a `limit`
    total: int                      # antes del recorte
    truncated: bool
    window_start: datetime
    window_end: datetime
    area_slug: Optional[str]

class UptimeBucket(BaseModel):
    bucket_start: datetime
    columns_count: int              # 0 si el canal no tiene fila en el bucket
    observed_hours: int             # horas del bucket con fila de ALGÚN canal (1 en bucket=hour)
    expected: int                   # 900 × observed_hours  [R12]
    ratio: Optional[float]          # min(1, count/expected); None si observed_hours == 0
    in_progress: bool               # bucket_start + bucket > now

class StationUptimeResponse(BaseModel):
    bucket: Literal["hour", "day"]
    window_start: datetime
    window_end: datetime
    expected_columns_per_hour: int            # 900, derivado de COLUMN_INTERVAL_SECONDS
    stations: dict[str, list[UptimeBucket]]   # clave: channel de 4 partes (trace.id); TODOS los buckets de la ventana, siempre
    overall: dict[str, Optional[float]]       # ratio agregado por channel; None si no se observó nunca [R12]

class TremorEpisode(BaseModel):
    start: datetime                 # t de la primera muestra del episodio
    end: datetime                   # t de la última muestra del episodio
    samples: int                    # cantidad de muestras del episodio (spec)
    duration_s: int                 # samples × period_seconds
    mean_ratio: float               # media de rsam/baseline dentro del episodio (spec)
    peak_rsam: float
    peak_ratio: float               # peak / baseline
    onset_ratio: float              # rsam[start] / peak — bajo = emergente
    mean_dominant_hz: Optional[float]
    mean_fi: Optional[float]
    band: Literal["low", "mid", "high", "undefined"]
    fi_sign: Literal["lp_like", "vt_like", "undefined"]

class TremorParameters(BaseModel):
    baseline_factor: float          # tremorBaselineFactor del JSON
    min_duration_periods: int       # tremorMinDurationPeriods del JSON

class TremorResponse(BaseModel):
    channel: str
    sampling_rate: float
    period_seconds: int
    baseline_rsam: Optional[float]  # None si no hay muestras (spec: "sin datos" explícito)
    threshold_rsam: Optional[float] # baseline × tremorBaselineFactor
    tremor_fraction: float          # muestras en episodio / muestras no nulas; 0.0 sin datos [R4]
    parameters: TremorParameters    # [R4]
    samples: list[dict]             # {t, rsam, dominant_hz, fi} — t = CENTRO de la ventana; `rsam` == `value` de /rsam para la misma ventana
    episodes: list[TremorEpisode]
```

```python
# src/services/gutenberg_richter.py — firmas

_C = json.loads(_CONSTANTS_PATH.read_text(encoding="utf-8"))   # patrón signal_picks.py
BIN_WIDTH: float = _C["magnitudeBinWidth"]
MC_CORRECTION: float = _C["mcCorrection"]
MIN_EVENTS: int = _C["bValueMinEvents"]

METHOD = "aki-utsu-mle"

def magnitude_bins(mags: Sequence[float]) -> list[MagnitudeBin]: ...
def estimate_mc_maxc(bins: Sequence[MagnitudeBin]) -> tuple[Optional[float], bool]:
    """(Mc, mc_at_catalog_floor). None si no hay bins."""
def fit_b_value(mags: Sequence[float], mc: Optional[float] = None) -> BValueFit:
    """Aki-Utsu MLE con σ de Shi & Bolt. `mc=None` ⇒ estimate_mc_maxc() [R6].
    status='insufficient' si n_above_mc < MIN_EVENTS; 'degenerate' si todas las magnitudes
    sobre Mc son iguales [R9]; en ambos casos b/a/sigma_b NO existen en el resultado [R8].
    Nunca lanza por catálogo vacío: devuelve status='insufficient', n_total=0.
    Determinista y sin I/O."""
```

```python
# src/services/tremor.py — firmas [R2]

BASELINE_FACTOR: float = _C["tremorBaselineFactor"]
MIN_DURATION_PERIODS: int = _C["tremorMinDurationPeriods"]
LOW_BAND_MAX_HZ: float = _C["tremorLowBandMaxHz"]
MID_BAND_MAX_HZ: float = _C["tremorMidBandMaxHz"]

def classify_episodes(samples: Sequence[tuple[datetime, Optional[float]]]) -> TremorClassification:
    """PURA sobre la serie RSAM (spec signal-analysis). baseline = mediana de los no nulos;
    None corta la corrida; episodio = ≥ MIN_DURATION_PERIODS consecutivas ≥ baseline × factor.
    Serie vacía o toda None ⇒ episodes=[], baseline=None, tremor_fraction=0.0, sin lanzar."""

def characterize(signal: np.ndarray, fs: float, start: datetime) -> TremorResult:
    """rsam_series() + classify_episodes() + espectro por período (band, fi_sign, …)."""
```

```python
# src/services/station_uptime.py — firmas

from src.services.seedlink_ingestor import COLUMN_INTERVAL_SECONDS
EXPECTED_COLUMNS_PER_HOUR: int = 3600 // COLUMN_INTERVAL_SECONDS   # 900, DERIVADA

_ROLLUP_SQL = """
INSERT INTO station_uptime_hourly (channel, bucket_start, columns_count)
SELECT channel, date_trunc('hour', endtime), count(*)
FROM spectrogram_columns
WHERE endtime >= GREATEST(
    now() - interval '7 days',
    COALESCE((SELECT max(bucket_start) FROM station_uptime_hourly), '-infinity'::timestamptz)
)
GROUP BY 1, 2
ON CONFLICT (channel, bucket_start) DO UPDATE SET columns_count = EXCLUDED.columns_count
"""

async def rollup_once(pool: asyncpg.Pool) -> int: ...          # filas upserteadas
async def run_uptime_rollup_loop(pool, interval_seconds, stop_event) -> None: ...
async def fetch_uptime(pool, start, end, bucket, channels, now) -> StationUptimeResponse:
    """SELECT de las filas de la ventana (+ canales pedidos) y delega en build_uptime_series."""

def build_uptime_series(
    rows: Sequence[tuple[str, datetime, int]],   # (channel, bucket_start, columns_count) de la tabla
    start: datetime, end: datetime,
    bucket: Literal["hour", "day"],
    channels: Optional[Sequence[str]],           # None ⇒ los canales presentes en rows
    now: datetime,
) -> StationUptimeResponse:
    """PURA [R12]: rellena TODOS los buckets de la ventana; hora observada = bucket_start con
    fila de algún canal; canal sin filas en la ventana ⇒ todo None; count ausente en hora
    observada ⇒ 0.0; bucket=day ⇒ sum(count)/(900 × horas observadas del día)."""
```

```python
# src/services/event_store.py — método nuevo

async def between(
    self,
    start: datetime,
    end: datetime,
    *,
    min_magnitude: Optional[float] = None,
    bbox: Optional[tuple[float, float, float, float]] = None,   # minlat, maxlat, minlon, maxlon
    limit: Optional[int] = None,
    order_by_magnitude: bool = False,
) -> list[SeismicEvent]:
    """Etapa 1 del filtro de área en SQL (bbox); la etapa 2 (polígono) la hace el caller
    con point_in_area(). `order_by_magnitude=True` ⇒ ORDER BY mag DESC, hora_utc DESC —
    para que un `limit` recorte microsismicidad, nunca el evento grande."""
```

```typescript
// dashboard/lib/analytics.ts — fetchers (tipos espejo omitidos)

export async function getBValue(days: number, minMag?: number, mc?: number): Promise<BValueResponse>;
export async function getHypocenters(days: number, minMag?: number, limit?: number): Promise<HypocentersResponse>;
export async function getStationUptime(days: number, bucket: 'hour' | 'day', channels?: string[]): Promise<StationUptimeResponse>;
export async function getTremor(channel: string, window: TimeWindow): Promise<TremorResponse>;
```

```sql
-- deploy/sql/migrations/021_station_uptime_hourly.sql (forma; el comentario de cabecera
-- explica el porqué, como la 014 y la 017)
CREATE TABLE IF NOT EXISTS station_uptime_hourly (
    channel       TEXT        NOT NULL,
    bucket_start  TIMESTAMPTZ NOT NULL,
    columns_count INTEGER     NOT NULL CHECK (columns_count >= 0),
    PRIMARY KEY (channel, bucket_start)
);
CREATE INDEX IF NOT EXISTS idx_station_uptime_hourly_bucket
    ON station_uptime_hourly (bucket_start);
-- Rollback: DROP TABLE IF EXISTS station_uptime_hourly;
```

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit (backend) — b-value | Los escenarios de la spec de `signal-analysis` con `mc` explícito: catálogo sintético `round(10^(6.0−1.0·M))` por bin de 2.0 a 6.0 (N=48 617) con `mc=2.0` ⇒ `b ∈ [0.90, 1.10]` (MLE a mano: 0.9963) y `n_above_mc=48617`; catálogo `round(10^(8.0−1.5·M))` ⇒ `b ∈ [1.40, 1.60]` (1.4853) — los dos esperan valores DISTINTOS; recorte a `M ≥ 3.5` con `mc=3.5` (construido desde `MIN_EVENTS` importado) ⇒ `insufficient` sin atributo `b`; 1 000 eventos con exactamente `MIN_EVENTS−1` sobre `mc=3.0` ⇒ `insufficient` con `n_above_mc = MIN_EVENTS−1` (NO 1 000); vacío ⇒ `insufficient`, `n_total=0`, sin excepción; `MIN_EVENTS+10` eventos todos `3.0` con `mc=3.0` ⇒ `degenerate`; con `mc=None` sobre el catálogo b=1.0 ⇒ `mc = 2.0 + 0.2` y `mc_at_catalog_floor=True`; `mag_type_counts` cuenta `None` como `"unknown"`; la tolerancia del test de b=1.0 se calibra para que M2 lo mate (ver tabla) | pytest puro, `tests/unit/test_gutenberg_richter.py` (molde `test_signal_picks_formulas.py`) |
| Unit (backend) — tremor, capa 1 (`classify_episodes`) | Los escenarios de la spec con listas de `(t, value)`: 100 × 40.0 ⇒ sin episodios, `baseline=40.0`, `tremor_fraction=0.0`; pico aislado en la muestra 50 (`40·factor·10`) ⇒ sin episodios; meseta muestras 20-39 a `40·factor·2` ⇒ UN episodio con `start=t[20]`, `end=t[39]`, `samples=20`, `tremor_fraction=0.20`, `mean_ratio = 2·factor`; misma meseta con `None` en la 30 ⇒ DOS episodios (20-29, 31-39) y `tremor_fraction = 19/99 ± 0.001` (no 19/100); serie vacía o toda `None` ⇒ `episodes=[]`, `baseline=None`, `tremor_fraction=0.0`, sin lanzar | `tests/unit/test_tremor.py` |
| Unit (backend) — tremor, capa 2 (`characterize`) | Señal sintética: ruido + 40 min de amplitud ×3 con tono a 1.5 Hz ⇒ UN episodio, `band="low"`, `duration_s=2400`, `samples=4`; misma amplitud por 20 min ⇒ CERO episodios (bajo `tremorMinDurationPeriods`); tono a 8 Hz ⇒ `band="high"`; `onset_ratio` bajo para rampa, ≈1 para escalón; `samples[i].rsam == rsam_series(signal, fs)[i]` elemento a elemento | `tests/unit/test_tremor.py` |
| Unit (backend) — uptime (`build_uptime_series`, pura) | `EXPECTED_COLUMNS_PER_HOUR == 3600 // COLUMN_INTERVAL_SECONDS` (contra el import, no contra 900 literal); canal con 900 filas/hora en 2 h ⇒ 2 buckets `ratio=1.0`; 450 ⇒ `0.5`; `count > 900` ⇒ clamp `1.0`; hora en la que OTRO canal tiene fila y este no ⇒ `0.0` (NO `None`); hora sin fila de ningún canal ⇒ `None` (NO `0.0` — el test distingue con `is None`); canal pedido sin ninguna fila en la ventana ⇒ todos `None` y `overall[ch] is None`; `bucket=day` con 18 horas observadas ⇒ `expected = 900·18`; ventana de 2 h produce EXACTAMENTE 2 buckets aunque falten filas; `in_progress` solo para el bucket que contiene `now` | `tests/unit/test_station_uptime.py` |
| Unit (backend) — constantes | Los tres módulos leen `dashboard/lib/seismic-constants.json` (molde `test_fdsn_warmup.py:67-80`: comparar contra el archivo leído en el test, no contra literales) | ídem |
| Integration (backend) — migración + rollup | La 021 aplica tras la 020 por orden de glob; segundo `apply` no-op; sembrar `spectrogram_columns` (la tabla se crea a mano en el test — la 001 de Timescale NO corre en la suite; documentarlo en el test) con 900 filas en la hora H y 450 en H+1 ⇒ `rollup_once` deja `{H: 900, H+1: 450}`; segundo `rollup_once` idempotente; agregar 100 filas a H+1 y volver a correr ⇒ 550 (sobrescribe, no acumula) | testcontainer Postgres, `tests/integration/test_station_uptime_rollup.py` |
| Integration (backend) — `EventStore.between` | Filas con lat/lon dentro y fuera del bbox, `order_by_magnitude` + `limit=2` devuelve las dos mayores; `min_magnitude` filtra en SQL | `tests/integration/test_event_store.py` (extender) |
| Integration (backend) — router | `GET /analytics/b-value` sin `event_store` ⇒ 503; con base sembrada con el catálogo sintético b=1.0 a escala reducida (`round(10^(4.0−M))` por bin de 2.0 a 4.0, 483 eventos, un solo INSERT batch) en el área default ⇒ 200 `status="ok"`, `b ∈ [0.90, 1.10]`, `bins` con los conteos sembrados, `method="aki-utsu-mle"`; con `MIN_EVENTS−1` eventos ⇒ `insufficient` y **`"b" not in body`** (no `is None`); `days=0` y `days=366` ⇒ 422; `hypocenters?limit=5` con 8 eventos ⇒ `truncated=True`, `total=8`, los 5 de mayor magnitud; evento con `prof_km NULL` viaja con `null`; `station-uptime?days=30` ⇒ `bucket="day"` forzado; hora sin filas ⇒ `ratio: null` en el JSON; sesión con área custom recorta (`MIN_EVENTS+100` en Japón y `MIN_EVENTS−10` en los Andes ⇒ `insufficient` con `n_above_mc = MIN_EVENTS−10`; molde `test_areas_api.py` + `test_api.py::test_report_*`); sin cookie ⇒ 200 con el área default (no 401) | `tests/integration/test_analytics_api.py`; OJO `with TestClient(app)` dispara el lifespan real — seguir el patrón de `test_deps.py` (sin `with`) o de `test_feedback_api.py` según lo que el test necesite (`testclient-con-with-dispara-lifespan-real`) |
| Unit (backend) — endpoint tremor | Sin red: `patch` de `get_spectrogram_service().get_waveform_data` como en `test_station_rsam_endpoint.py`; SCNL de 3 partes ⇒ 422; ventana > 24 h ⇒ 422; sin datos ⇒ 404; `t` es el CENTRO de la ventana (misma aserción que el test de `/rsam`) | `tests/unit/test_analytics_tremor_endpoint.py` |
| Unit (frontend) — libs | `toFmdRows` no produce `-Infinity` para count 0; `fittedLinePoints` pasa por `(mc, a - b·mc)`; `rankStations` ordena peor primero y estable; `episodesToReferenceAreas` usa los `t` de las muestras; `truncationNotice` solo cuando `truncated`; `mergeSeriesByTime` alinea por `t` y deja `undefined` (no 0) donde falta un canal | Vitest, `dashboard/lib/*.test.ts` |
| Component (frontend) | `BValueChart` con `status="insufficient"` NO renderiza ningún nodo con `data-testid="b-value-number"` ni el texto de `t('bValueLabel')`, y SÍ el `data-testid="b-value-insufficient"` con `n_above_mc`/`min_events` interpolados; con un body malformado `{status:"insufficient", b: 1.2}` tampoco muestra `1.2`; con `status="ok"` y `b=0.9963` renderiza `1.00` (2 decimales) y `± σ`; `HypocenterMap` monta sin lanzar en jsdom, muestra el aviso de truncado y dibuja 3 marcadores de los cuales el de `prof_km: null` tiene el estilo "sin profundidad"; `RsamTrendChart` con un canal rechazado muestra error solo en esa serie; `StationUptimeChart` con `[1.0, 0.0, null, 1.0]` muestra "0 %" para el segundo y "sin observación" para el tercero; `TremorPanel` con `episodes: []` muestra "sin episodios", con 2 episodios lista 2 filas con `start`/`end` en UTC, y con un 404 muestra "sin datos para este canal" | Vitest + Testing Library; para Leaflet el `waitFor` largo de `vitest.setup.ts` (`waitfor-1000ms-no-alcanza-para-leaflet`); Recharts NO se asserta por SVG |
| Manual (usuario) | URL exacta `/analytics`: (1) b-value en área "global" 30 días ⇒ número; en un área chica ⇒ tarjeta "insuficiente"; (2) mapa: 5 000 puntos con zoom fluido, popup al click, aviso de truncado; (3) uptime el DÍA del deploy ya muestra hasta 7 días hacia atrás; (4) tremor sobre un canal con evento conocido ⇒ el M grande NO aparece como episodio (dura < 30 min) | `qa-visual-lo-hace-el-usuario`: pasar URL y qué mirar |

### Verificación por mutación — OBLIGATORIA en tasks

| # | Mutación | Test que debe morir |
|---|---|---|
| M1 | `bValueMinEvents: 50 → 5` en el JSON | el test de 49 eventos deja de dar `insufficient` ⇒ el backend lee el JSON (no una copia) |
| M2 | Quitar `- BIN_WIDTH / 2` de la fórmula de b (sin corrección de Utsu) | el catálogo sintético b=1.0 (mean 2.3859) devuelve `0.4343 / 0.3859 = 1.1254` en vez de `0.9963` (verificado con Python el 2026-09-04): la tolerancia de la spec `[0.90, 1.10]` lo deja AFUERA; una tolerancia de ±0.15 lo taparía — no aflojarla |
| M3 | `status = "ok"` incondicional | 49 eventos ⇒ `b` deja de ser `None` |
| M4 | `ORDER BY mag DESC` → `ORDER BY hora_utc DESC` en `between(order_by_magnitude=True)` | `hypocenters?limit=5` deja de traer las 5 mayores |
| M5 | Quitar `ON CONFLICT … DO UPDATE` (dejar `DO NOTHING`) | el rollup que pasa de 450 a 550 en la hora parcial deja de actualizar |
| M6 | `GREATEST(now() - 7 days, max(bucket))` → solo `now() - 2 hours` | el test que siembra un hueco de 5 h y corre `rollup_once` deja de rellenarlo |
| M7 | `tremorMinDurationPeriods: 3 → 1` en el JSON | los 20 min de amplitud alta pasan a ser episodio; y el pico aislado de la spec pasa a ser un episodio de una muestra |
| M8 | En `BValueChart`, renderizar el número aunque `status !== "ok"` | el test `b-value-number` ausente en `insufficient` falla |
| M9 | `preferCanvas: true` → `false` en `HypocenterMap` | no hay test automatizable barato: se verifica a mano con 5 000 puntos (zoom); dejarlo documentado como QA, no fingir un test |
| M10 | `tremorBaselineFactor: 2.0 → 6.0` en el JSON (el triple) | la meseta a `40·factor_original·2 = 160` queda bajo `40·6 = 240`: el escenario de la meseta deja de dar un episodio (spec) |
| M11 | En `classify_episodes`, tratar `None` como `0.0` en vez de cortar la corrida | `tremor_fraction` da `19/100` en vez de `19/99` (spec, tolerancia ±0.001) |
| M12 | En `build_uptime_series`, devolver `0.0` en vez de `None` para una hora sin filas de ningún canal | el test "hora no observada es `None`" muere (la mutación que la spec nombra explícitamente) |
| M13 | En `fit_b_value`, contar `n_above_mc` sobre el catálogo COMPLETO (sin filtrar por Mc) | 1 000 eventos con `MIN_EVENTS−1` sobre Mc pasan a `ok` |
| M14 | En `HypocenterMap`/`markerStyle`, pasar `prof_km ?? 0` a `getDepthColor` | el evento sin profundidad toma el color de "< 70 km"; el test de estilo "sin profundidad" muere |

Recordatorios operativos de la memoria: mutar con `sd` y verificar `git diff --stat` ANTES de
correr (`sd-s-no-matchea-saltos-de-linea`); `rm -rf` de `__pycache__` entre mutación y
reversión en el mismo segundo (`mutacion-sd-mismo-segundo-pyc-viejo`); `sd` sin `-s` trata
paréntesis como regex.

### Comandos verificados del entorno

```
./venv/bin/python -m pytest tests/unit/test_gutenberg_richter.py tests/unit/test_tremor.py tests/unit/test_station_uptime.py
./venv/bin/python -m pytest tests/integration/test_station_uptime_rollup.py tests/integration/test_analytics_api.py   # Docker arriba
cd dashboard && ./node_modules/.bin/vitest run lib/b-value-plot.test.ts components/analytics   # NUNCA npx
cd dashboard && ./node_modules/.bin/tsc --noEmit                                               # NUNCA next build
```

## Migration / Rollout

1. **Deploy backend (Railway `api`)**: la 021 se auto-aplica al arranque
   (`run_migrations_on_startup=True` solo en `api`; `scripts/apply_migrations.py` aplica
   `deploy/sql/migrations` y luego `db/migrations`, con advisory lock). Aditiva e
   idempotente; ninguna fila existente cambia.
2. **Variables**: `UPTIME_ROLLUP_ENABLED=true` SOLO en el servicio `api` (los otros servicios
   comparten imagen y base y no deben competir por el upsert — mismo motivo que
   `run_migrations_on_startup`). Sin la variable, el panel de uptime responde 200 con
   `stations: {}` y la UI muestra "sin historial todavía" — degrada, no rompe.
3. **Primera corrida**: como `station_uptime_hourly` está vacía, el `GREATEST(…)` cae a
   `now() - 7 days` y el primer rollup materializa toda la raw retenida: el panel muestra una
   semana de historia el mismo día del deploy. Medir la duración de esa primera corrida en
   los logs (un `logger.info` con filas y ms es parte de `rollup_once`).
4. **Deploy frontend (Vercel)**: aditivo; los paneles nuevos degradan a su tarjeta de error
   si el backend viejo todavía responde 404 en `/analytics/*` (ventana de deploy cruzado).
5. **Rollback**: `git revert` del PR. El único estado persistente nuevo es
   `station_uptime_hourly` (limpieza opcional: `DROP TABLE`); apagar `UPTIME_ROLLUP_ENABLED`
   detiene la escritura sin tocar nada más. `seismic_events`, `spectrogram_columns`, Redis y
   el watchdog no cambian (el proposal afirmaba un rollback sobre `watchdog.py` que ya no
   aplica).
6. **Prod se prueba en prod** (`no-levantar-stack-local-probar-en-prod`): tras el merge,
   `curl https://api.geospectrum.org/analytics/b-value?days=30` (200 anónimo, área default)
   y `…/analytics/station-uptime?days=1` prueban que el router y el rollup arrancaron.
   Aviso ÚNICO de riesgo de lifespan: un `create_task` nuevo en el lifespan que lance al
   arrancar tumba el `api` entero — por eso el loop calca `disk_alert` (try/except por
   ciclo) y se cubre con `test_watchdog_loop.py` como molde.

## Open Questions

- [ ] **RSAM multi-día**: la Decision 3 deja la tendencia en 24 h por la decisión cerrada
  de no persistir. Criterio de reapertura, con datos de este change: si el uso real del panel
  pide sistemáticamente "la semana" (y `analytics-report-export` es semanal, así que es
  probable), la persistencia de UNA muestra RSAM por canal cada 600 s (107 × 144 = 15 k
  filas/día) desde el `api` (NO desde el ingestor: mismo molde que el rollup de uptime,
  leyendo FDSN por canal ganador) es el camino que no viola la Decision 4 archivada. No se
  diseña acá.
- [ ] **Uptime de SERVICIOS (api/ui/seedlink/events)**: persistir las transiciones que
  `evaluate_and_notify` ya calcula es barato, pero exige darle escritura a la base al
  servicio `watchdog` (hoy solo lectura) y no es "uptime de estaciones". Decidir en
  `analytics-report-export` si el PDF semanal lo necesita.
- [ ] **Mc por GFT**: si en observación `mc_at_catalog_floor` sale `true` casi siempre
  (probable en áreas dentro de EE. UU., donde USGS baja de M1), MAXC+0,2 está mostrando el
  piso de ingesta, no el de la red; GFT sobre `M ≥ 1.0` no lo arregla — habría que bajar
  `source_min_magnitude`, que es una decisión de ingesta, no de este panel.
- [ ] **Filtro por `mag_tipo`** en el b-value: se expone `mag_type_counts` sin filtrar. Si el
  sismólogo pide "solo ML", es un query param nuevo sobre el mismo endpoint, sin rediseño.
- [ ] **`DepthSectionChart`**: SHOULD. `sdd-tasks` decide si entra en esta entrega o en la
  siguiente; el contrato de `/analytics/hypocenters` no depende de él.
- [x] **Tolerancia del test de b (M2)**: resuelto en la reconciliación — sin corrección de
  Utsu el catálogo sintético da `1.1254` (sesgo +13 %, no +5 %); `[0.90, 1.10]` lo detecta.

## Lo que el proposal dice y el código desmiente

| Proposal | Código | Consecuencia en este design |
|---|---|---|
| "`src/api/` (o router equivalente)" para endpoints nuevos, como si `/rsam` viviera ahí | `/stations/{channel}/rsam`, `/report`, `/events/*` están en `src/main.py` (l. 773, 1095, 2496, 3001); los routers de `src/api/routers/` cubren areas/comments/feedback/picks/stations(metrics)/walls | Router nuevo `analytics.py`; nada se mueve de `main.py` |
| "Nuevo endpoint backend que agrega muestras de `RsamAccumulator`/`rsam_series`" | `RsamAccumulator` es RAM del ingestor (1 h); `rsam_series` YA está expuesto con doble cache; persistir está cerrado por decisión de usuario | Sin endpoint RSAM nuevo (Decision 3) |
| `src/services/swarm_rsam.py` "Modified/Extended" | No necesita cambios: `rsam_series` y `RSAM_PERIOD_SECONDS` se importan | Sin cambios en el archivo |
| "El watchdog solo guarda el estado actual … necesita extenderse con historial de transiciones" (`watchdog.py` "Modified") | Cierto que solo guarda el último estado, pero vigila SERVICIOS, no estaciones; la serie por canal ya existe en `spectrogram_columns` (4 s, 7 días) | Uptime derivado por rollup (Decision 2); `watchdog.py` sin cambios; el "rollback del cambio a watchdog.py" del proposal no aplica |
| b-value "sobre `SeismicEvent.mag`" (implícito: los `eventos` de `/report`, lo que hoy usa la página) | `/report` = `settings.window_minutes` (60 min) de fuentes en vivo; `seismic_events` tiene ~1 año | Catálogo desde `EventStore.between()` (Decision 6) |
| No menciona `RsamChart.tsx` | Existe (`dashboard/components/RsamChart.tsx`, canvas, detalle de estación) | Convive; el de Analytics es un componente Recharts distinto (Decision 3) |
| Migraciones: notas previas decían "017 fue la última auto-aplicada" | La última en `deploy/sql/migrations` es la **020** (`020_feedback_screenshot.sql`); `db/migrations` va por la 002 | La nueva es la **021** en `deploy/sql/migrations` |
| Riesgo "costo de query de la agregación de uptime" sin ventana definida | Rollup incremental de ≤ 2 h por corrida, backfill acotado a 7 días, lectura sobre tabla plana indexada | Riesgo mitigado por diseño; queda medir la primera corrida |
| "Estrategia de clustering a definir (marker clustering de Leaflet o server-side)" | Ningún plugin instalado; `react-leaflet` instalado y sin uso; el gotcha UMD ya costó un bug silencioso | Ni plugin ni server-side: canvas + tope honesto (Decision 5) |
| Implícito: la suite de tests cubre lo que toque Timescale | `tests/conftest.py` aplica SOLO `deploy/sql/migrations` sobre `postgres:16-alpine` sin extensión | Todo lo nuevo va en Postgres plano; el test del rollup crea `spectrogram_columns` a mano y lo documenta |
