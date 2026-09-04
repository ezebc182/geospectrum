# Delta for Dashboard UI — Paneles profesionales en /analytics

Delta sobre `openspec/specs/dashboard-ui/spec.md`. Todo lo de acá es
**ADDED**: dos selectores de ventana temporal en `/analytics` (días para el
catálogo, horas para la señal), un selector de canales, cinco paneles nuevos
(tendencia RSAM, uptime, b-value, tremor, mapa de hipocentros), un corte de
profundidad opcional (SHOULD) y un componente de mapa NUEVO e independiente
de los de `/live`. Ningún requirement del spec base se modifica:
`MagnitudeTimeChart`, `DepthDistributionChart` y `EventsTable` siguen
alimentándose de `/report` exactamente como hoy.

> Reconciliado con `design.md` el 2026-09-04 (tabla en `tasks.md`). Cambios
> respecto de la primera versión: un selector → dos (`catalogDays` 7/30/90/365
> y `signalWindow` 6/12/24 h, decisión del usuario de acotar RSAM a 24 h);
> `/analytics/rsam` → `GET /stations/{channel}/rsam` × N; `/analytics/uptime`
> → `/analytics/station-uptime` con `ratio` en `[0, 1]`; nombres de campos del
> design (`n_above_mc`, `min_events`, `bins`, `baseline_rsam`); redondeo de
> `b` fijado en 2 decimales; `DepthSectionChart` agregado como SHOULD.

## Lo que el código dice hoy (verificado 2026-09-04)

| Afirmación del proposal | Estado en el código |
|---|---|
| "`/analytics` usa solo `MagnitudeTimeChart` y `DepthDistributionChart` sobre `eventos` de `/report`" | Cierto (`dashboard/app/(app)/analytics/page.tsx:15-71`): `useSWR('/report', reportFetcher, { refreshInterval: 60000 })`, más `EventsTable` paginada y `useAreaRefresh`. **No hay selector de ventana**: `/report` no acepta una y la página no la tiene. |
| "Recharts, con el patrón de estilos oscuro/i18n de `MagnitudeTimeChart.tsx` / `DepthDistributionChart.tsx`" | Cierto: `recharts ^2.15.0` en `package.json`; ambos charts usan `useTranslations('charts')`, `ResponsiveContainer`, `CartesianGrid stroke="#374151"`, ejes `stroke="#9ca3af"`, tooltip sobre `bg-gray-900`. Colores de profundidad centralizados en `getDepthColor` (`dashboard/lib/utils.ts:65`) con los MISMOS cortes (`70/150/300 km`) que los bins de `DepthDistributionChart`. |
| "`dashboard/components/analytics/` (o similar, nuevo directorio)" | No existe hoy. |
| "Leaflet (ya instalado), sin reutilizar `AdvancedSeismicMap.tsx` / `SeismicMapWithCities.tsx`" | `leaflet ^1.9.4` y `react-leaflet ^5.0.0` en `package.json`, **pero ningún componente usa react-leaflet**: los tres mapas existentes (`AdvancedSeismicMap`, `SeismicMapWithCities`, `StationMiniMap`) usan `import('leaflet')` dinámico sobre un `div` propio. No hay ningún plugin de clustering instalado. |
| (no lo dice el proposal) | Ya existe `dashboard/components/RsamChart.tsx`: serie RSAM de UN canal sobre `<canvas>` (no Recharts), acoplada a `TimeWindow` del detalle de estación y a `useTranslations('station')`. No es reutilizable tal cual para un trend multi-canal; la tendencia de Analytics es un componente nuevo. `dashboard/lib/api.ts:165` ya expone `seismicAPI.getStationRsam(channel, window, periodSeconds)` con `RsamResponse.samples: {t, value}[]`. |
| Paridad i18n | `dashboard/messages/parity.test.ts` exige el MISMO set de claves aplanadas en `es.json` y `en.json`, sin valores vacíos. Toda clave nueva de este change entra en esa red. El namespace `analytics` existe con 3 claves (`title`, `loadError`, `fullEventsTable`). |

## Decisiones tomadas en esta spec (el proposal las dejó implícitas)

| # | Tema | Decisión | Por qué |
|---|------|----------|---------|
| 1 | **La ventana se elige en la página, no en `/report`, y son DOS** | `/analytics` incorpora `catalogDays` (presets `7 / 30 / 90 / 365`, default `30`) que alimenta a b-value, hipocentros y uptime, y `signalWindow` (`6 h / 12 h / 24 h`, default `24 h`) que alimenta a RSAM y tremor, más un `StationPicker` de hasta 4 canales. Los tres paneles existentes siguen con `/report` y su ventana fija del servidor | `/report` no admite ventana y el proposal exige no tocarlo. Un selector único obligaría a mentir en un extremo ("365 días" de RSAM que devuelve 24 h): el tope de FDSN y los meses de catálogo son dos escalas distintas |
| 2 | **Cada panel carga y falla solo** | Cada panel nuevo tiene su propio fetch (`useSWR` por endpoint), su propio estado de carga y su propio estado de error. La página MUST NOT reemplazar el layout entero por el `loadError` actual cuando falla UN endpoint nuevo | Hoy `page.tsx:33-39` reemplaza toda la página por un error si `/report` falla. Replicar eso con 6 fuentes haría que un 503 de uptime tape el b-value que sí llegó |
| 3 | **`null` se dibuja como hueco, `0` como cero** | En RSAM trend y uptime, un `null` produce una interrupción visible (línea cortada / barra ausente con marca "sin observación"), nunca un punto en `0` | Ver Decisión 4 de `signal-analysis`: un "0 %" de uptime que en realidad es "no medimos" acusa de caída a una estación que no se observó |
| 4 | **b-value no estimable: sin número, con explicación** | Con `status !== "ok"` el panel muestra un estado textual con `n_above_mc` y `min_events` ("n = 23, mínimo 50"; para `degenerate`, "todas las magnitudes iguales") y NO renderiza ningún valor de `b` ni línea de ajuste | Criterio de éxito literal del proposal: "nunca muestra un número cuando el N está bajo el mínimo" |
| 5 | **Independencia del mapa verificable por import** | El componente nuevo MUST NOT importar `AdvancedSeismicMap`, `SeismicMapWithCities` ni `StationMiniMap`, ni `use-area-refresh`, ni ningún cliente WebSocket/SSE. Un `rg` sobre el archivo lo verifica | Criterio de éxito del proposal. Sí PUEDE compartir helpers puros de presentación (`getDepthColor`, `getMagnitudeColor`, `formatMagnitude`, `areaViewBounds`, `BASE_LAYERS`) — un color de profundidad distinto entre el mapa y el histograma de al lado sería una mentira nueva |
| 6 | **Codificación visual del mapa** | Color del marcador = profundidad con `getDepthColor` (mismos cortes que `DepthDistributionChart`); tamaño = magnitud; evento con `prof_km = null` se dibuja con un estilo distinguible ("sin profundidad", sin pasar por `getDepthColor`) y se cuenta en el total | Una sola fuente de verdad para los cortes de profundidad; `getDepthColor(0)` daría el color de "< 70 km" |
| 7 | **Sin refresco automático en los paneles nuevos** | Los paneles nuevos NO tienen `refreshInterval` ni suscripción WebSocket: se recargan al cambiar la ventana, los canales, el área (`useAreaRefresh`, sólo los que dependen del área) o por acción explícita del usuario | Es lo contrario de `/live`; es exactamente lo que el proposal pide para el mapa y aplica a los cinco paneles |
| 8 | **Redondeo de `b`** | Dos decimales (`0.9963` ⇒ `1.00`), con `± σ` a dos decimales al lado | La spec anterior lo dejaba abierto; el test tiene que fijar uno |

## Resuelto por el design (reconciliación 2026-09-04)

1. **Clustering**: ninguno. `L.circleMarker` sobre `L.map(..., { preferCanvas:
   true })`, tope server-side (`limit`, `truncated`) y aviso visible.
2. **Canales por defecto** del trend RSAM y del tremor: los elegidos en
   `StationPicker` (hasta 4, alimentado por `GET /spectrograms/station-catalog`,
   badge `is_live`); sin selección, el panel muestra su estado "elegí un canal".
   Uptime: todos los canales con filas en la ventana, ranking peor-primero,
   timeline del seleccionado.
3. **Presets y default**: Decisión 1. La ventana NO persiste en la URL en este
   change.
4. **Layout**: `dashboard/components/analytics/` con los nombres del design
   (`AnalyticsWindowSelector`, `StationPicker`, `RsamTrendChart`, `TremorPanel`,
   `StationUptimeChart`, `BValueChart`, `HypocenterMap`, `DepthSectionChart`).
5. **Episodios de tremor**: `ReferenceArea` sombreada sobre el propio gráfico
   RSAM del `TremorPanel` (con `ReferenceLine` del umbral) + tabla de episodios.

## ADDED Requirements

### Requirement: Selectores de ventana temporal y de canales en /analytics

`/analytics` MUST mostrar un selector de días de catálogo (`catalogDays`,
presets `7 / 30 / 90 / 365`, default `30`), un selector de ventana de señal
(`signalWindow`, presets `6 h / 12 h / 24 h`, default `24 h`) y un selector
de hasta 4 canales (`StationPicker`). Cambiar `catalogDays` MUST volver a
pedir b-value, hipocentros y uptime con ese `days`; cambiar `signalWindow` o
los canales MUST volver a pedir RSAM (una request por canal) y tremor con
`start`/`end` absolutos derivados; ninguno de los tres MUST afectar a
`MagnitudeTimeChart`, `DepthDistributionChart` ni `EventsTable` (Decisión 1).

#### Scenario: Cambiar a 7 días re-pide los paneles de catálogo

- GIVEN `/analytics` cargada con `catalogDays = 30`
- WHEN el usuario elige el preset `7`
- THEN se emiten peticiones nuevas a `/analytics/b-value?days=7`,
  `/analytics/hypocenters?days=7` y `/analytics/station-uptime?days=7`
- AND NO se emite una petición nueva a `/report`, a
  `/stations/{channel}/rsam` ni a `/analytics/tremor/*`

Nota de falsabilidad: la verificación MUST observar las peticiones (mock de
`fetch` con contador por URL), no el resultado visual.

#### Scenario: Cambiar a 6 h re-pide sólo los paneles de señal

- GIVEN `/analytics` con dos canales elegidos y `signalWindow = 24 h`
- WHEN el usuario elige `6 h`
- THEN se emiten exactamente 2 peticiones a `/stations/{channel}/rsam` (una
  por canal) y 1 a `/analytics/tremor/{channel}` con `end − start = 6 h`
- AND NO se emite ninguna a `/analytics/b-value`, `/analytics/hypocenters`,
  `/analytics/station-uptime` ni `/report`

#### Scenario: El cambio de área sigue refrescando lo que depende del área

- GIVEN `/analytics` cargada
- WHEN el usuario cambia el área activa (evento que ya dispara
  `useAreaRefresh`)
- THEN se revalida `/report` (comportamiento actual) Y `/analytics/b-value`
  Y `/analytics/hypocenters`
- AND NO se revalidan uptime, RSAM ni tremor (no dependen del área)
- AND el handler devuelve el `Promise.all` de las tres revalidaciones (el
  indicador cubre a todas)

### Requirement: Panel de tendencia RSAM (Recharts)

`/analytics` MUST renderizar un panel nuevo con la tendencia RSAM de los
canales elegidos sobre `signalWindow`, alimentado por una request por canal
a `GET /stations/{channel}/rsam` (`period_seconds = 600`, `Promise.allSettled`)
fusionadas con `mergeSeriesByTime` (delta de `signal-analysis`), construido
con Recharts y con el patrón visual e i18n de
`MagnitudeTimeChart`/`DepthDistributionChart` (`useTranslations`,
`ResponsiveContainer`, grilla `#374151`, ejes `#9ca3af`, tooltip oscuro).

Reglas normativas:

1. Un `null` MUST dibujarse como interrupción de la línea (Decisión 3,
   `connectNulls={false}`), nunca como un punto en `0`.
2. El eje de tiempo MUST mostrarse en UTC con el formateador de locale
   (`useFormatter`), como `MagnitudeTimeChart`.
3. El panel MUST tener estados propios de carga, error y "sin datos" POR
   SERIE: un canal que rechazó (404 de FDSN) muestra su error sin tumbar las
   otras series ni el resto de la página (Decisión 2).
4. El panel MUST NOT importar `RsamChart.tsx` del detalle de estación; es un
   componente nuevo.
5. El panel MUST NOT pedir ventanas mayores a 24 h (tope de `signalWindow`).

#### Scenario: Una serie con hueco se dibuja cortada

- GIVEN filas fusionadas donde el canal `A` vale `[10, 20, null, 40]`
- WHEN se renderiza el panel
- THEN la capa de adaptación entrega `null` (no `0`) al `<Line>` del canal
  `A` en la tercera fila (verificable sobre la función pura y sobre las
  props del componente; Recharts NO se asserta por SVG)

#### Scenario: Un canal rechazado no oculta a los demás

- GIVEN `getStationRsam` resuelve para `A` y rechaza para `B`
- WHEN se renderiza `/analytics`
- THEN el panel muestra la serie `A` y un estado de error etiquetado con `B`
- AND `MagnitudeTimeChart`, `DepthDistributionChart` y `EventsTable` se
  renderizan con normalidad

### Requirement: Panel de uptime histórico

`/analytics` MUST renderizar un panel nuevo con el uptime por canal sobre
`catalogDays`, alimentado por `GET /analytics/station-uptime`, con Recharts
(ranking en barras, peor primero, y timeline por bucket del canal
seleccionado) y el mismo patrón visual e i18n.

Reglas normativas:

1. Un bucket con `ratio: null` MUST ser visualmente distinto de `0.0`
   (Decisión 3): sin barra y con indicación de "sin observación"; `0.0` es
   una barra de altura cero con tooltip "0 %".
2. El panel MUST mostrar `overall[channel]` como porcentaje por canal, o
   "sin observaciones" si es `null`; nunca `0 %` ni `NaN %` para `null`.
3. Un bucket `in_progress` MUST marcarse como "en curso".
4. Estados propios de carga/error/sin datos (`stations: {}` ⇒ "sin
   historial todavía") (Decisión 2).

#### Scenario: null y 0 se distinguen en pantalla

- GIVEN una respuesta con `ratio` `[1.0, 0.0, null, 1.0]` para un canal
- WHEN se renderiza el panel
- THEN el segundo bucket muestra "0 %" (o el texto i18n equivalente) en su
  tooltip/etiqueta
- AND el tercero muestra la etiqueta de "sin observación" y NO "0 %"

#### Scenario: Resumen null no se muestra como 0 %

- GIVEN un canal con `overall = null`
- WHEN se renderiza
- THEN el ranking muestra "sin observaciones" para ese canal, nunca `0 %` ni
  `NaN %`

#### Scenario: El ranking ordena peor primero

- GIVEN `overall = { A: 0.9, B: 0.3, C: null, D: 0.6 }`
- WHEN se renderiza
- THEN el orden de barras es `B, D, A` y `C` aparece al final con "sin
  observaciones" (función pura `rankStations`, orden estable)

### Requirement: Panel de b-value con estado de datos no estimables

`/analytics` MUST renderizar un panel nuevo alimentado por `GET
/analytics/b-value`. Con `status = "ok"` MUST mostrar `b` (dos decimales,
Decisión 8) con `± sigma_b`, `n_above_mc`, `mc` (y el aviso de
`mc_at_catalog_floor` si aplica), y un gráfico Recharts de la distribución
frecuencia-magnitud a partir de `bins` (barras no acumuladas + puntos
acumulados en Y logarítmica) con la recta de ajuste `log10 N = a − b·M`.
Con `status !== "ok"` MUST mostrar un estado textual con `n_above_mc` y
`min_events` (y el motivo para `degenerate`), y MUST NOT renderizar ningún
valor de `b` ni recta (Decisión 4). El histograma se muestra en ambos casos
(dato honesto).

#### Scenario: Con datos suficientes se ve el número y la recta

- GIVEN una respuesta `{ status: "ok", b: 0.9963, sigma_b: 0.0047, a: 6.0,
  n_above_mc: 48617, mc: 2.0, bins: [...] }`
- WHEN se renderiza el panel
- THEN el nodo `data-testid="b-value-number"` contiene `1.00` asociado a la
  etiqueta i18n de b-value, y `± 0.00` al lado
- AND la función pura `toFmdRows(bins)` entrega tantas filas como entradas
  de `bins` y `fittedLinePoints(a, b, mc, maxM)` pasa por `(mc, a − b·mc)`

#### Scenario: Con datos insuficientes no aparece ningún número de b

- GIVEN una respuesta `{ status: "insufficient", n_above_mc: 23, min_events:
  50, mc: 2.0, bins: [...] }`
- WHEN se renderiza el panel
- THEN el nodo `data-testid="b-value-insufficient"` contiene `23` y `50`
- AND NO existe ningún nodo `data-testid="b-value-number"` ni el texto de
  `t('bValueLabel')`
- AND no se renderiza recta de ajuste

Nota de falsabilidad: el test MUST buscar por la etiqueta i18n del valor de
b (`queryByText(t('bValueLabel'))` ⇒ `null`) y por el `data-testid`, no por
la ausencia de "0.99" — un stub que mostrara `b = 0` pasaría un test escrito
al revés. La mutación es design M8.

#### Scenario: Un b en el body con status insufficient se ignora

- GIVEN una respuesta malformada `{ status: "insufficient", b: 1.2,
  n_above_mc: 5, min_events: 50, bins: [] }`
- WHEN se renderiza el panel
- THEN se muestra el estado insuficiente y NO el `1.2`

Nota: el backend no debe mandarlo (delta de `backend-api`), pero la UI es la
última línea del criterio de éxito "nunca muestra un número".

#### Scenario: Degenerate tiene su propio mensaje

- GIVEN una respuesta `{ status: "degenerate", n_above_mc: 60, min_events:
  50, mc: 3.0, bins: [...] }`
- WHEN se renderiza
- THEN se muestra el texto i18n de "todas las magnitudes iguales" y NO el de
  "insuficiente" ni ningún número de b

### Requirement: Panel de tremor volcánico

`/analytics` MUST renderizar la caracterización de tremor del primer canal
elegido (`GET /analytics/tremor/{channel}`) mostrando: el gráfico RSAM con
la `ReferenceLine` en `threshold_rsam` y una `ReferenceArea` por episodio
(entre `start` y `end`), la tabla de episodios (`start`, `end` en UTC,
`duration_s`, `mean_ratio`, `band`, `fi_sign`, `onset_ratio`), la
`tremor_fraction` de la ventana, los `parameters` usados, y un estado
explícito de "sin episodios en la ventana" cuando `episodes` es `[]`. La
etiqueta MUST decir "episodio sostenido (candidato a tremor)", nunca
"tremor detectado".

Reglas normativas:

1. Los intervalos sombreados MUST coincidir con `episodes[i].start`/`end`
   de la respuesta (función pura `episodesToReferenceAreas`).
2. La línea de umbral MUST dibujarse en `threshold_rsam` de la respuesta,
   no en un valor recalculado en el cliente.
3. Estados propios de carga/error/404 ("sin datos para este canal") y "elegí
   un canal" sin selección (Decisión 2).

#### Scenario: Sin episodios se ve el estado "sin episodios"

- GIVEN una respuesta con `episodes: []` y `tremor_fraction: 0.0`
- WHEN se renderiza
- THEN el DOM contiene el texto i18n de "sin episodios"
- AND no hay ninguna fila de episodio ni `ReferenceArea`

#### Scenario: Dos episodios se listan con sus bordes

- GIVEN una respuesta con dos episodios de `start`/`end` distintos
- WHEN se renderiza
- THEN se listan exactamente `2` filas con esos timestamps formateados en
  UTC y `episodesToReferenceAreas` devuelve 2 áreas con esos bordes

#### Scenario: Canal sin datos muestra el 404 como estado, no como crash

- GIVEN `/analytics/tremor/{channel}` responde 404
- WHEN se renderiza
- THEN el panel muestra el estado "sin datos para este canal"
- AND el resto de la página no se ve afectado

### Requirement: Mapa de hipocentros propio de Analytics

`/analytics` MUST renderizar un componente de mapa NUEVO
(`dashboard/components/analytics/HypocenterMap.tsx`), con Leaflet, que
dibuje los `eventos` de `GET /analytics/hypocenters` para `catalogDays` y
el área activa.

Reglas normativas:

1. El componente MUST NOT importar `AdvancedSeismicMap`,
   `SeismicMapWithCities`, `StationMiniMap`, ni `use-area-refresh`, ni
   ningún cliente WebSocket/SSE de eventos (Decisión 5). MAY importar
   helpers puros de presentación (`getDepthColor`, `getMagnitudeColor`,
   `formatMagnitude`, `areaViewBounds`, `BASE_LAYERS`).
2. Color del marcador por profundidad con `getDepthColor`; tamaño por
   magnitud; `prof_km = null` con estilo distinguible sin pasar por
   `getDepthColor` (Decisión 6).
3. El mapa MUST NOT refrescarse solo (sin `refreshInterval`, sin
   suscripción en vivo — Decisión 7); se actualiza al cambiar ventana o
   área.
4. El mapa MUST mostrar `total` y, si `truncated = true`, un aviso visible
   con `total` y la cantidad dibujada, sugiriendo subir `min_mag`.
5. TODOS los eventos de la respuesta MUST quedar representados como
   marcador individual (`L.circleMarker`, un vértice cada uno); ninguno se
   descarta en silencio.
6. El popup de un evento MUST mostrar magnitud, profundidad (o "sin
   profundidad"), hora UTC y lugar, con formateo por locale como los mapas
   existentes (`map-locale-popups.test.tsx` ya cubre el patrón).
7. Leaflet MUST cargarse con `import('leaflet')` dinámico (SSR-safe) sobre
   `L.map(container, { preferCanvas: true })`, mismo patrón de `<link>` CSS
   que `StationMiniMap`.
8. `AdvancedSeismicMap.tsx` y `SeismicMapWithCities.tsx` MUST quedar sin
   cambios en este change.

#### Scenario: El componente no comparte comportamiento live

- GIVEN el archivo fuente del componente nuevo
- WHEN se buscan con `rg` las cadenas `AdvancedSeismicMap`,
  `SeismicMapWithCities`, `StationMiniMap`, `use-area-refresh`, `/ws/` y
  `EventSource`
- THEN ninguna aparece

#### Scenario: Un evento sin profundidad se dibuja distinto y se cuenta

- GIVEN una respuesta con `3` eventos, uno con `prof_km: null`
- WHEN se renderiza el mapa
- THEN hay `3` marcadores
- AND `markerStyle(ev)` para el de `prof_km: null` devuelve el estilo "sin
  profundidad" (no el color de `<70 km`, que es lo que daría
  `getDepthColor(0)` si alguien convirtiera `null` en `0` — design M14)
- AND el total mostrado es `3`

#### Scenario: Truncado se avisa

- GIVEN una respuesta con `truncated: true`, `total: 5000` y `2000` eventos
- WHEN se renderiza
- THEN el mapa muestra `2000` marcadores y un aviso con `2000` y `5000`
  (`truncationNotice(total, shown)` devuelve los args de i18n; con
  `truncated: false` devuelve `null`)

#### Scenario: Cambiar la ventana re-pide y redibuja; el tiempo no

- GIVEN el mapa renderizado con `catalogDays = 30`
- WHEN pasan 120 s sin interacción (timers falsos)
- THEN no se emitió ninguna petición nueva a `/analytics/hypocenters`
- AND WHEN el usuario cambia a `7`
- THEN se emite exactamente una petición nueva con `days=7`

#### Scenario: Los mapas de /live no cambian

- GIVEN el diff completo del change
- WHEN se inspeccionan `AdvancedSeismicMap.tsx` y `SeismicMapWithCities.tsx`
- THEN no tienen cambios

### Requirement: Corte de profundidad (SHOULD)

`/analytics` SHOULD renderizar, junto al mapa, un `DepthSectionChart`
(Recharts `ScatterChart`, X = longitud, Y = `prof_km` con eje invertido,
color por magnitud con `getMagnitudeColor`) sobre los MISMOS `eventos` de
`GET /analytics/hypocenters`, omitiendo los de `prof_km = null` y
declarando cuántos omitió. Es el único gráfico que muestra el hipocentro
(el mapa muestra epicentros con la profundidad en color). Si el change se
vuelve inabarcable, es lo primero que se recorta; el contrato del endpoint
no cambia.

#### Scenario: Los eventos sin profundidad se omiten y se declaran

- GIVEN `3` eventos, uno con `prof_km: null`
- WHEN se renderiza el corte
- THEN la función pura entrega `2` puntos y el panel muestra "1 sin
  profundidad"

### Requirement: Paridad de claves i18n de los paneles nuevos

Toda cadena visible de los paneles nuevos (títulos, ejes, estados de carga /
error / sin datos / no estimable / sin episodios / sin observación / en
curso / elegí un canal, avisos de truncado, etiquetas del popup, nombres de
banda y de signo de FI) MUST estar en `es.json` y `en.json` bajo claves
nuevas del namespace `analytics.*`, y `dashboard/messages/parity.test.ts`
MUST seguir en verde. El componente MUST NOT contener texto visible
hardcodeado en un solo idioma.

#### Scenario: La paridad sigue en verde

- GIVEN el diff completo del change
- WHEN se corre `parity.test.ts`
- THEN pasa: mismas claves aplanadas en ES y EN, sin valores vacíos

#### Scenario: El estado no estimable está traducido

- GIVEN la UI en `en`
- WHEN se renderiza el panel de b-value con `status = "insufficient"`
- THEN el texto del estado sale de `en.json` (no aparece la cadena en
  español)

### Requirement: No-regresión de los paneles existentes

`MagnitudeTimeChart.tsx`, `DepthDistributionChart.tsx` y `EventsTable.tsx`
MUST quedar sin cambios en este change, y `/analytics` MUST seguir
renderizándolos desde `/report` con `refreshInterval` de 60 s y
`useAreaRefresh`, como hoy.

#### Scenario: Los tres componentes existentes no cambian

- GIVEN el diff completo del change
- WHEN se inspeccionan los tres archivos
- THEN no tienen cambios
- AND sus tests existentes (`EventsTable.test.tsx`,
  `EventsTable.pagination.test.tsx` y los que existan) siguen en verde

#### Scenario: /report se sigue pidiendo igual

- GIVEN `/analytics` cargada
- WHEN se observan las peticiones iniciales
- THEN hay exactamente una petición a `/report` sin parámetros nuevos
