# Delta for Signal Analysis — b-value, tremor, fusión RSAM multi-canal y uptime

Delta sobre `openspec/specs/signal-analysis/spec.md` (archivado el 2026-08-28
desde `analiticas-profesionales-senal`). Todo lo de acá es **ADDED**: cuatro
bloques nuevos de lógica PURA (mismo input → mismo output, sin I/O), que son
la base de cálculo de los paneles de `/analytics`. Ningún requirement del spec
base se modifica: `rsam_sample()` / `rsam_series()`
(`src/services/swarm_rsam.py:28-94`) siguen siendo la ÚNICA fórmula de
amplitud, y todo lo nuevo se apoya en su salida en vez de recalcularla.

El **requisito transversal de verificación por mutación** del spec base
(valores esperados concretos calculados a mano; una mutación que no muta no
prueba nada; confirmar con `rg` que la mutación quedó escrita ANTES de correr
los tests) aplica íntegro a este delta. Ningún escenario de este documento se
satisface con "devuelve un número", "es mayor que cero" o "no es `NaN`".

> Reconciliado con `design.md` el 2026-09-04 (tabla en `tasks.md`). Cambios
> respecto de la primera versión: nombres de constantes y campos alineados al
> design (`bValueMinEvents`/`MIN_EVENTS`, `tremorBaselineFactor`,
> `tremorMinDurationPeriods`, `n_above_mc`, `min_events`, `bins[{m, …}]`,
> `baseline_rsam`); el requirement de agregación RSAM por buckets multi-día se
> reemplazó por la fusión multi-canal de 24 h en el frontend (decisión del
> usuario: sin persistir RSAM, ventana 24 h, mismo endpoint); el requirement
> de uptime se redactó sobre el rollup horario del design.

## Lo que el código dice hoy (verificado 2026-09-04)

| Afirmación del proposal | Estado en el código |
|---|---|
| "RSAM (`swarm_rsam.py`) ya existe" | Cierto. `rsam_sample`, `RsamAccumulator`, `rsam_series` en `src/services/swarm_rsam.py`. `rsam_series` devuelve `list[float]` (nunca `None`; la cola parcial se descarta). |
| "agregar muestras de `RsamAccumulator`/`rsam_series` en una ventana temporal seleccionable" | **Parcialmente falso.** `RsamAccumulator` retiene UNA hora en memoria (`EVENTS_WINDOW_SECONDS = 3600`, línea 23) y vive en el PROCESO del ingestor (`seedlink_ingestor.py:102,205`), no en el API. Lo único que sale de ahí es el snapshot `metrics:latest:{SCNL}` en Redis con TTL de 60 s (`metrics_store.py:19-20`). No hay serie histórica de RSAM en ningún lado. La serie sobre ventana absoluta sale de `rsam_series()` ON-DEMAND desde FDSN (`GET /stations/{channel}/rsam`, `main.py:3001`, ventana ≤ 24 h), y el spec base cerró que NO se persisten muestras. **Decisión del usuario (2026-09-04): la tendencia reusa ese endpoint, 24 h, sin persistir.** |
| "no existe cálculo de b-value" | Cierto (`rg -i "b.value\|gutenberg" src` sin resultados). |
| "no hay caracterización de tremor" | Cierto. |
| "`SeismicEvent.mag` (`src/models/event.py:9-22`)" | Cierto: `mag: float` obligatorio, `prof_km: Optional[float]`. Persistido en `seismic_events` (`deploy/sql/migrations/014_seismic_events.sql`) vía `EventStore` (`src/services/event_store.py`). |

## Decisiones tomadas en esta spec (el proposal las dejó implícitas)

| # | Tema | Decisión | Por qué |
|---|------|----------|---------|
| 1 | **Cota inferior del N mínimo del b-value** | La constante es `bValueMinEvents` en `dashboard/lib/seismic-constants.json` (leída en Python como `MIN_EVENTS` en `gutenberg_richter.py`, expuesta como `min_events` en la respuesta); el design la fija en **50**, y MUST ser ≥ 50 y estar declarada UNA sola vez, importada por el estimador y por el endpoint | Aki (1965): el error estándar de b es `b/√N`. Con N=50 y b≈1 eso es ±0.14 — ya es el límite de lo publicable; con N=20 es ±0.22, un número que no dice nada. El proposal marca este riesgo como High; una guarda que se pueda setear en 5 no es una guarda |
| 2 | **N se cuenta DESPUÉS de filtrar por Mc** | El N que se compara contra `MIN_EVENTS` es `n_above_mc` (eventos con `mag ≥ Mc`), no `n_total` | Contar el catálogo entero y luego ajustar sobre 20 eventos completos es exactamente el "número engañoso" que el proposal quiere evitar |
| 3 | **"Insuficiente" es un resultado, no un error** | El estimador devuelve un valor tipado con `status = "insufficient"` (con `n_above_mc` y `min_events`), nunca una excepción ni `None` pelado ni `NaN` | La UI tiene que poder EXPLICAR por qué no hay número ("n=23, mínimo 50"). Una excepción obliga al endpoint a inventar ese detalle |
| 4 | **Huecos de datos son `null`, nunca `0`** | En toda serie por instantes o buckets (fusión RSAM multi-canal, uptime), un punto sin observación vale `null` | Un `0` de RSAM se lee como "silencio sísmico" y un `0` de uptime como "estación caída"; ambos serían mentiras cuando lo cierto es "no medimos". Misma regla que la UI honesta del umbral de frescura |
| 5 | **Uptime se mide contra tiempo OBSERVADO, no contra tiempo calendario** | `ratio = columns_count / (EXPECTED_COLUMNS_PER_HOUR · horas_observadas)` dentro del bucket; una hora es "observada" si ALGÚN canal tiene fila en ella; sin horas observadas → `null` | Si el pipeline que observa (ingestor + rollup) estuvo apagado media hora, esa media hora no es "estación caída" |
| 6 | **Tremor se clasifica sobre la serie RSAM ya calculada** | La entrada del clasificador (`classify_episodes`) es `list[(t, value \| null)]` con la forma exacta de `samples` de `GET /stations/{channel}/rsam`; MUST NOT recibir la forma de onda. El enriquecimiento espectral (banda, signo de FI) es una capa APARTE (`characterize`) que llama al clasificador y no altera qué es episodio | El proposal lo pide explícito ("no reemplaza RSAM, se apoya en ella") y evita dos fórmulas de amplitud divergentes |
| 7 | **Un pico aislado NO es tremor** | Un episodio exige amplitud elevada SOSTENIDA durante al menos `tremorMinDurationPeriods` muestras consecutivas (design: 3 ⇒ 30 min; MUST ser ≥ 3) | Un pico de una muestra es un evento (lo que ya cuenta `events_last_hour`), no tremor. Con `tremorMinDurationPeriods = 1` el clasificador sería un duplicado del contador de eventos |

## Resuelto por el design (reconciliación 2026-09-04)

1. **Método del b-value**: máxima verosimilitud (Aki 1965) con corrección de
   binning de Utsu (`Mc − ΔM/2`), σ de Shi & Bolt (1982), `a = log10(N) +
   b·Mc`. Identificador `method = "aki-utsu-mle"`. Los escenarios de abajo
   tienen el valor esperado de la MLE calculado a mano (y los de LSQ como
   referencia de por qué NO se eligió: el LSQ acumulado dio `1.21` para un
   `b` real de `1.0` en un catálogo truncado).
2. **Mc**: `fit_b_value(mags, mc=None)` — `mc` explícito se usa tal cual;
   `None` ⇒ `estimate_mc_maxc()` (bin de máximo conteo + `mcCorrection =
   0.2`), función aparte con sus propios escenarios.
3. **Valores**: `bValueMinEvents = 50`, `magnitudeBinWidth = 0.1`,
   `mcCorrection = 0.2`, `tremorBaselineFactor = 2.0`,
   `tremorMinDurationPeriods = 3`, `tremorLowBandMaxHz = 2.0`,
   `tremorMidBandMaxHz = 5.0`, todos en `seismic-constants.json`; la línea
   base del tremor es la **mediana** de las muestras no nulas de la ventana.
4. **Serie RSAM**: `GET /stations/{channel}/rsam` por canal, 24 h, período
   600 s; sin serie de más de 24 h en este change.

## ADDED Requirements

### Requirement: Estimación del b-value de Gutenberg-Richter con guarda de N mínimo

El sistema MUST proveer una función pura `fit_b_value(mags, mc=None)` que,
dada una lista de magnitudes y opcionalmente una magnitud de completitud
`Mc` (ancho de bin `ΔM = magnitudeBinWidth`), devuelva UNO de dos resultados
tipados:

- `status = "ok"` con `b`, `a`, `sigma_b` (floats), `n_total`, `n_above_mc`
  (eventos con `mag ≥ Mc`), `mc`, `mc_at_catalog_floor`, `min_events`,
  `method` y `bins`;
- `status = "insufficient"` o `status = "degenerate"` con los mismos campos
  SALVO `b`, `a`, `sigma_b`, que NO existen en ese resultado (ni `b = null`
  ni `b = NaN`: el atributo/clave no está).

Reglas normativas:

1. `n_above_mc` MUST contarse sobre los eventos con `mag ≥ Mc` (Decisión 2).
2. El resultado MUST ser `insufficient` siempre que `n_above_mc <
   MIN_EVENTS` (Decisión 1), y MUST NOT computar ni exponer `b` en ese caso.
3. El resultado MUST ser `degenerate` cuando `n_above_mc ≥ MIN_EVENTS` pero
   todas las magnitudes sobre `Mc` son iguales (la MLE daría `log10(e) /
   (ΔM/2) = 8.69`, un número absurdo pero serializable).
4. `MIN_EVENTS` MUST leerse de `bValueMinEvents` del JSON (una sola
   declaración) y ser ≥ 50.
5. Con `mc=None` la función MUST estimar `Mc` con `estimate_mc_maxc()`; con
   `mc` explícito MUST usarlo tal cual.
6. La función MUST ser determinista: misma lista, mismo `Mc`, mismo resultado.
7. La función MUST NOT hacer I/O ni depender de la fecha actual.

#### Scenario: Un catálogo sintético con b = 1.0 recupera b ≈ 1.0

- GIVEN el catálogo sintético construido así: para cada bin `M` de `2.0` a
  `6.0` en pasos de `0.1`, `round(10^(6.0 − 1.0·M))` eventos con magnitud
  exactamente `M` (los primeros cinco conteos son `10000, 7943, 6310, 5012,
  3981`; los últimos cinco `3, 2, 2, 1, 1`; total `N = 48617`)
- AND `mc = 2.0`, `ΔM = 0.1`
- WHEN se estima el b-value
- THEN `status` es `"ok"` y `method` es `"aki-utsu-mle"`
- AND `n_above_mc` es `48617`
- AND `b` está en `[0.90, 1.10]`

Cálculo a mano: media de las magnitudes `= 2.3859`. MLE con corrección de
binning: `log10(e) / (2.3859 − (2.0 − 0.05)) = 0.4343 / 0.4359 = 0.9963`.
(LSQ incremental: `0.9986`; LSQ acumulado: `1.0686`.) Un stub que devuelva la
constante `1.0` NO es distinguible con este escenario solo — por eso existe
el siguiente. **Calibración obligatoria (design M2)**: sin la corrección de
Utsu la MLE da `0.4343 / (2.3859 − 2.0) = 1.125`; el test MUST usar una
tolerancia que deje ese valor AFUERA (`[0.90, 1.10]` lo deja afuera; `±0.15`
no).

#### Scenario: Un catálogo sintético con b = 1.5 recupera b ≈ 1.5

- GIVEN el catálogo construido con la misma regla pero `round(10^(8.0 −
  1.5·M))` eventos por bin (primeros conteos `100000, 70795, 50119, 35481,
  25119`; los bins con conteo `0` se omiten; `N = 342402`)
- AND `mc = 2.0`, `ΔM = 0.1`
- WHEN se estima el b-value
- THEN `status` es `"ok"`
- AND `b` está en `[1.40, 1.60]`

Cálculo a mano: media `= 2.2424`; MLE `= 0.4343 / (2.2424 − 1.95) = 1.4853`.

Nota de falsabilidad: este escenario y el anterior esperan valores DISTINTOS
(`≈1.0` vs `≈1.5`). Una implementación que devolviera siempre el mismo número
pasa uno y falla el otro.

#### Scenario: N por debajo del mínimo devuelve "insuficiente" sin b

- GIVEN el catálogo del primer escenario recortado a los bins `M ≥ M_cut`,
  donde `M_cut` es el menor bin tal que el conteo de `mag ≥ M_cut` queda por
  debajo de `MIN_EVENTS` (con `MIN_EVENTS = 50` es `M_cut = 5.0`: conteos
  `10, 8, 6, 5, 4, 3, 3, 2, 2, 1, 1` ⇒ `n = 45`; con `M_cut = 4.9` ya son
  `58`. Verificado con Python el 2026-09-04. El test lo construye desde la
  constante importada, no copia esta cuenta)
- AND `mc = M_cut`
- WHEN se estima el b-value
- THEN `status` es `"insufficient"`
- AND el resultado NO tiene atributo `b` (`hasattr(result, "b")` es falso,
  o el equivalente del tipo elegido)
- AND `n_above_mc` es el conteo real de eventos con `mag ≥ M_cut`
- AND `min_events` es el valor de `MIN_EVENTS`

Nota: el test MUST construir el subconjunto a partir de la constante
importada, no de un número copiado a mano — si `bValueMinEvents` cambia, el
test tiene que seguir probando lo mismo.

#### Scenario: N se cuenta después de filtrar por Mc

- GIVEN un catálogo de `1000` eventos de los cuales exactamente `MIN_EVENTS
  − 1` tienen `mag ≥ 3.0` y el resto `mag < 3.0`
- AND `mc = 3.0`
- WHEN se estima el b-value
- THEN `status` es `"insufficient"`
- AND `n_above_mc` es `MIN_EVENTS − 1` (NO `1000`) y `n_total` es `1000`

Nota de falsabilidad: contar antes de filtrar daría `n_above_mc = 1000 ≥
MIN_EVENTS` y un `b` calculado sobre `MIN_EVENTS − 1` eventos — el "número
engañoso" del proposal (design M13).

#### Scenario: Catálogo vacío devuelve "insuficiente" con n = 0

- GIVEN una lista de magnitudes vacía (con `mc=None` y con `mc=2.0`)
- WHEN se estima el b-value
- THEN `status` es `"insufficient"`
- AND `n_total` y `n_above_mc` son `0`, `mc` es `null` con `mc=None`
- AND la función NO lanza excepción

#### Scenario: Todas las magnitudes iguales no producen un b

- GIVEN `MIN_EVENTS + 10` eventos, TODOS con `mag = 3.0`
- AND `mc = 3.0`, `ΔM = 0.1`
- WHEN se estima el b-value
- THEN `status` es `"degenerate"` (nunca `"ok"`)
- AND el resultado NO tiene atributo `b`

Nota de falsabilidad: con MLE, `mean(M) − (Mc − ΔM/2) = 0.05` y `b = 8.69` —
un número perfectamente serializable y absurdo. Ese camino debe quedar
cerrado.

#### Scenario: Mc automático cae en el pico del histograma y avisa el piso

- GIVEN el catálogo sintético `b = 1.0` (pico en el bin `2.0`, el más bajo)
- WHEN se estima con `mc=None`
- THEN `mc` es `2.0 + 0.2 = 2.2` (bin de máximo conteo + `mcCorrection`)
- AND `mc_at_catalog_floor` es `true`
- AND `status` es `"ok"` y `b` sigue en `[0.90, 1.10]`

#### Scenario: Mutación de bValueMinEvents pone el test de guarda en rojo

- GIVEN `bValueMinEvents` mutada en el JSON a un valor por debajo del recorte
  del escenario "N por debajo del mínimo" (design M1: `50 → 5`)
- AND confirmado por `rg` que el archivo contiene el valor mutado
- WHEN se corre ese escenario
- THEN queda en ROJO (el estimador devuelve `"ok"` con un `b`) — prueba que
  el backend lee el JSON, no una copia

### Requirement: Caracterización de tremor volcánico sobre la serie RSAM

El sistema MUST proveer una función pura `classify_episodes(samples)` que
reciba una serie RSAM — `list[(t: datetime UTC, value: float | null)]`, con
la MISMA forma que `samples` de `GET /stations/{channel}/rsam` — y devuelva:

- `episodes`: lista (posiblemente vacía) de episodios, cada uno con `start`,
  `end` (timestamps de la primera y última muestra del episodio), `samples`
  (cantidad de muestras), `mean_ratio` (media de `value / baseline` dentro
  del episodio), `peak_rsam`, `peak_ratio` y `onset_ratio`
  (`value[start] / peak`);
- `baseline_rsam`: la mediana de las muestras no nulas (float, o `null` si
  no hay ninguna);
- `threshold_rsam`: `baseline_rsam × tremorBaselineFactor` (o `null`);
- `tremor_fraction`: fracción de muestras NO nulas que caen dentro de algún
  episodio, en `[0.0, 1.0]`;
- `parameters`: `{baseline_factor, min_duration_periods}` con los que se
  clasificó.

Reglas normativas:

1. La función MUST NOT recibir la forma de onda ni recalcular amplitud: su
   única fuente de amplitud es la serie RSAM de entrada (Decisión 6). El
   enriquecimiento espectral (`band`, `fi_sign`, `mean_dominant_hz`,
   `mean_fi`, `duration_s`) lo agrega `characterize(signal, fs, start)`
   SOBRE los episodios que devuelve esta función, sin cambiarlos.
2. Una muestra pertenece a un episodio cuando `value ≥ baseline_rsam ·
   tremorBaselineFactor` y forma parte de una corrida de al menos
   `tremorMinDurationPeriods` muestras consecutivas que cumplen lo mismo
   (Decisión 7).
3. Una muestra `null` MUST NOT contarse como elevada NI como cero: corta la
   corrida (dos tramos elevados separados por un `null` son dos episodios) y
   no cuenta en el denominador de `tremor_fraction`.
4. `tremorBaselineFactor` y `tremorMinDurationPeriods` MUST leerse del JSON
   (una sola declaración); `tremorMinDurationPeriods` MUST ser ≥ 3;
   `tremorBaselineFactor` MUST ser > 1.
5. La función MUST ser determinista y sin I/O.

#### Scenario: Una serie constante no tiene tremor

- GIVEN una serie de `100` muestras, todas con `value = 40.0`
- WHEN se clasifica
- THEN `episodes` es la lista vacía
- AND `tremor_fraction` es `0.0`
- AND `baseline_rsam` es `40.0` y `threshold_rsam` es `40.0 ·
  tremorBaselineFactor`

Nota: con cualquier `tremorBaselineFactor > 1`, `40.0 ≥ 40.0 · factor` es
falso para toda muestra.

#### Scenario: Un pico aislado NO es tremor

- GIVEN una serie de `100` muestras con `value = 40.0` salvo la muestra `50`,
  que vale `40.0 · tremorBaselineFactor · 10`
- WHEN se clasifica
- THEN `episodes` es la lista vacía
- AND `tremor_fraction` es `0.0`

Nota de falsabilidad: la mutación de verificación es `tremorMinDurationPeriods
= 1` (design M7): este escenario MUST quedar en rojo (aparece un episodio de
una muestra).

#### Scenario: Una meseta sostenida es un único episodio con sus bordes exactos

- GIVEN una serie de `100` muestras con `value = 40.0`, salvo las muestras
  `20` a `39` inclusive (20 muestras consecutivas) que valen `40.0 ·
  tremorBaselineFactor · 2`
- WHEN se clasifica
- THEN `episodes` tiene exactamente `1` elemento
- AND ese episodio tiene `start` igual al `t` de la muestra `20` y `end` igual
  al `t` de la muestra `39`
- AND `samples` es `20` y `mean_ratio` es `2 · tremorBaselineFactor`
- AND `tremor_fraction` es `0.20`

Nota sobre la línea base: con 80 de 100 muestras en `40.0`, la MEDIANA es
`40.0` (la media no lo sería). El test MUST calcular la expectativa desde la
definición (mediana), no copiarla de acá.

#### Scenario: Un hueco (null) parte un episodio en dos

- GIVEN la serie del escenario anterior, pero con la muestra `30` en `null`
- WHEN se clasifica
- THEN `episodes` tiene exactamente `2` elementos
- AND el primero cubre las muestras `20` a `29` y el segundo `31` a `39`
- AND `tremor_fraction` se calcula sobre `99` muestras no nulas (`19 / 99 =
  0.1919...`, tolerancia ±0.001)

Nota de falsabilidad: tratar `null` como `0` (design M11) no corta la corrida
de forma distinta pero SÍ cuenta la muestra en el denominador: la
`tremor_fraction` saldría `19/100 = 0.19` y el escenario queda en rojo por la
tolerancia.

#### Scenario: Una serie vacía devuelve un resultado explícito de "sin datos"

- GIVEN una serie vacía, o una serie donde TODAS las muestras son `null`
- WHEN se clasifica
- THEN `episodes` es la lista vacía
- AND `baseline_rsam` y `threshold_rsam` son `null`
- AND `tremor_fraction` es `0.0`
- AND la función NO lanza excepción

#### Scenario: Mutación de tremorBaselineFactor pone la meseta en rojo

- GIVEN `tremorBaselineFactor` mutada a un valor mayor que `2 ·
  factor_original` (design M10: `2.0 → 6.0`)
- AND confirmado por `rg` que el archivo contiene el valor mutado
- WHEN se corre el escenario de la meseta sostenida
- THEN queda en ROJO (`episodes` vacío, porque `40·2·2 = 160 < 40·6 = 240`)

#### Scenario: La capa espectral no cambia qué es episodio

- GIVEN una señal sintética a `fs = 20 Hz` de 4 h: ruido de amplitud 1 con
  40 min (4 períodos de 600 s) de amplitud ×3 y tono a 1.5 Hz
- WHEN se corre `characterize(signal, fs, start)`
- THEN `episodes` tiene exactamente `1` elemento con `samples = 4`,
  `duration_s = 2400`, `band = "low"`
- AND `samples[i].rsam == rsam_series(signal, fs)[i]` para todo `i`
- AND con 20 min (2 períodos) en vez de 40 ⇒ `episodes` vacío
- AND con tono a 8 Hz ⇒ `band = "high"`

### Requirement: Fusión multi-canal de series RSAM por instante (frontend)

El sistema MUST proveer una función pura `mergeSeriesByTime(responses)`
(`dashboard/lib/rsam-trend.ts`) que reciba las respuestas de `GET
/stations/{channel}/rsam` de hasta 4 canales (mismo `period_seconds`, misma
ventana) y devuelva filas `{ t, [channel]: value | null }` ordenadas por `t`
para un `LineChart` multi-serie, donde:

1. Cada `t` presente en al menos un canal produce exactamente UNA fila.
2. `value` es el `value` que devolvió el endpoint para ese canal y ese `t`,
   sin promediar ni recalcular (Decisión 4 del spec base: una sola fórmula).
3. Un canal sin muestra en un `t` vale `null` en esa fila, nunca `0`
   (Decisión 4).
4. La función MUST NOT recalcular amplitud ni agregar por estación.

#### Scenario: Dos canales alineados producen filas completas

- GIVEN dos respuestas con los mismos 3 `t` y valores `10, 20, 30` y `1, 2,
  3`
- WHEN se fusionan
- THEN hay exactamente `3` filas, la primera es `{t: t0, "A": 10, "B": 1}`

#### Scenario: Un instante que falta en un canal es null y no se saltea

- GIVEN la misma entrada pero el canal `B` sin la muestra de `t1`
- WHEN se fusionan
- THEN sigue habiendo `3` filas
- AND la fila de `t1` tiene `"B": null`
- AND `null` NO es `0` (el test MUST usar `toBeNull()`, no `toBeFalsy()`)

#### Scenario: Un canal rechazado no borra a los demás

- GIVEN tres canales pedidos con `Promise.allSettled`, de los cuales uno
  rechazó (404)
- WHEN se fusionan los dos que resolvieron
- THEN las filas tienen las dos claves de los canales resueltos y ninguna
  del rechazado; el componente muestra el error SOLO en esa serie

### Requirement: Serie de disponibilidad por buckets a partir del rollup

El sistema MUST proveer una función pura `build_uptime_series(rows, start,
end, bucket, channels, now)` (`src/services/station_uptime.py`) que reciba
las filas `(channel, bucket_start, columns_count)` de `station_uptime_hourly`
dentro de una ventana `[start, end)`, un `bucket` (`hour` | `day`), la lista
de canales pedidos (o `None` ⇒ los presentes en `rows`) y `now`, y devuelva
por canal `[UptimeBucket]` donde:

1. Una **hora observada** es un `bucket_start` con al menos una fila de
   CUALQUIER canal (Decisión 5).
2. Para un canal presente en la ventana (≥ 1 fila suya), en cada hora
   observada `ratio = min(1.0, columns_count / EXPECTED_COLUMNS_PER_HOUR)`,
   con `columns_count = 0` si el canal no tiene fila en esa hora ⇒ `0.0`.
3. En una hora NO observada `ratio = null` (Decisión 4).
4. Un canal pedido SIN ninguna fila en la ventana ⇒ todos sus buckets
   `null` y `overall = null`.
5. `bucket = day`: `ratio = sum(columns_count) / (EXPECTED_COLUMNS_PER_HOUR
   · horas_observadas_del_día)`, `null` si el día no tiene ninguna hora
   observada; `expected = EXPECTED_COLUMNS_PER_HOUR · horas_observadas` y
   `observed_hours` viajan en el bucket.
6. La lista cubre TODOS los buckets de la ventana, alineados desde el
   `date_trunc` de `start`, sin saltear los vacíos.
7. `in_progress` es `true` sólo para el bucket que contiene `now`.
8. `EXPECTED_COLUMNS_PER_HOUR = 3600 // COLUMN_INTERVAL_SECONDS`, derivada
   del import, nunca `900` literal.
9. `overall[channel]` usa la misma regla sobre toda la ventana.

#### Scenario: Un canal siempre activo da 1.0 en todos los buckets

- GIVEN filas de `GE.KBU..BHZ` con `columns_count = 900` en las 2 horas de
  una ventana de 2 h
- AND `bucket = hour`
- WHEN se construye la serie
- THEN hay `2` buckets, ambos con `ratio = 1.0` y `expected = 900`
- AND `overall["GE.KBU..BHZ"]` es `1.0`

#### Scenario: Media hora de columnas da 0.5 y el exceso se clampea a 1.0

- GIVEN una fila con `columns_count = 450` y otra hora con `columns_count =
  950`
- WHEN se construye la serie
- THEN los buckets tienen `ratio = 0.5` y `ratio = 1.0` respectivamente

#### Scenario: Una hora sin filas de ningún canal es null, no 0

- GIVEN filas sólo en la primera hora de una ventana de `2 h`
- AND `bucket = hour`
- WHEN se construye la serie
- THEN el segundo bucket tiene `ratio = null` y `observed_hours = 0`
- AND el test distingue `null` de `0.0` (`is None`)

Nota de falsabilidad: la mutación de verificación (design M12) es hacer que
una hora no observada devuelva `0.0`. Un dashboard que muestre "0 %" para
las horas en que el pipeline estaba apagado está acusando de caída a una
estación que no se miró.

#### Scenario: Un canal mudo en una hora observada vale 0.0

- GIVEN filas de `IU.MAJO.00.BHZ` en las horas `H` y `H+1`, y de
  `GE.KBU..BHZ` sólo en `H`
- WHEN se construye la serie sobre `[H, H+2)`
- THEN `GE.KBU..BHZ` tiene `ratio = 0.0` en `H+1` (no `null`: SÍ hubo
  observación, otro canal entregó)

#### Scenario: Un canal pedido sin ninguna fila queda en null

- GIVEN las filas del escenario anterior y `channels = ["XX.NOPE..BHZ"]`
- WHEN se construye la serie
- THEN `XX.NOPE..BHZ` está en el resultado con todos sus buckets `ratio =
  null` y `overall = null`

#### Scenario: Un día con 18 horas observadas se mide sobre 18

- GIVEN un día con filas en 18 de sus 24 horas, todas con `columns_count =
  900`
- AND `bucket = day`
- WHEN se construye la serie
- THEN ese bucket tiene `observed_hours = 18`, `expected = 900 · 18` y
  `ratio = 1.0` (no `0.75`)

#### Scenario: La constante deriva del import

- WHEN se inspecciona `EXPECTED_COLUMNS_PER_HOUR`
- THEN es igual a `3600 // COLUMN_INTERVAL_SECONDS` importado de
  `src/services/seedlink_ingestor.py` (el test compara contra el import, no
  contra `900`)
