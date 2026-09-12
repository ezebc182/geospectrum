# Delta for Dashboard UI — Fase 2: fundaciones de interpretación

Delta sobre `openspec/specs/dashboard-ui/spec.md`, acotado **exclusivamente a la
Fase 2** de `analytics-redesign` (ver tabla de fases en `proposal.md:156-162`).
Las fases 3, 4 y 5 (cableado a paneles, uptime, tabla de eventos) **no se
especifican acá** y ningún requirement de este archivo las anticipa.

Alcance de esta fase, en una frase: **se construyen las piezas de la capa de
interpretación —una lib pura de reglas, sus tipos, las claves i18n del glosario
y dos componentes de presentación— y NADA se cablea a ningún panel todavía.**

Es la fase que las fases 3 y 4 consumen. Todo lo que entrega es **aditivo**: no
modifica ningún componente existente, no cambia ninguna clave i18n existente, no
toca el backend y no cambia un solo píxel de `/analytics`. Revertirla es borrar
archivos nuevos (`proposal.md:213`).

---

## Lo que el código dice hoy (verificado 2026-09-11)

Esta tabla existe porque **el proposal contiene una afirmación que el código
desmiente parcialmente**, y una spec que la repitiera mandaría a re-implementar
cosas que ya funcionan.

| Afirmación | Estado real en el código |
|---|---|
| "El frontend descarta `mc_at_catalog_floor`" | **PARCIALMENTE FALSO.** `BValueChart.tsx:135-137` ya renderiza `bValue.mcAtFloor` cuando el flag es `true`. Lo que falta no es el dato: es la **severidad**, el porqué explicado, y que la advertencia salga de una regla testeable en vez de un `&&` inline. |
| "El frontend descarta `sigma_b`" | **PARCIALMENTE FALSO.** `BValueChart.tsx:99` ya muestra `± σ` vía `formatB`, con la clave `bValue.sigma` = `"± {sigma}"`. Lo que falta es el **factor 1.96** y el rótulo de intervalo derivado: hoy se muestra σ pelado, que un lector puede confundir con un IC. |
| "El frontend descarta `mag_type_counts`" | **FALSO en cuanto a mostrar** (`BValueChart.tsx:105,204-208` lista los conteos), **VERDADERO en cuanto a advertir**: nadie compara el largo del diccionario contra 1 ni dice que Gutenberg-Richter asume una sola escala. |
| "El frontend descarta `n_total` / `min_events`" | **VERDADERO con `status === 'ok'`.** `BValueChart.tsx:130` muestra solo `n_above_mc`. `n_total` y `min_events` solo aparecen dentro de los mensajes `insufficient`/`degenerate` (`bValue.insufficient` usa `{n}`/`{min}`). Con `status: 'ok'` y `n_above_mc` apenas por encima de `min_events`, nadie se entera de que la muestra es chica. |
| "El frontend descarta `baseline_rsam`/`threshold_rsam`" | **PARCIALMENTE FALSO.** `TremorPanel.tsx:155` lee `baseline_rsam` y dibuja el umbral (`TremorPanel.tsx:13`). Lo que falta es la **limitación de dominio** de `tremor.py:26-28` en texto leíble. |
| "El frontend descarta `tremor_fraction`, `parameters`, `onset_ratio`, `fi_sign`" | **FALSO.** Los cuatro se renderizan (`TremorPanel.tsx:165,168-170,272-273` y las claves `tremor.fraction`, `tremor.parameters`, `tremor.fiSign.*`, `tremor.columns.onsetRatio`). Lo que falta es **explicar qué significan**, no mostrarlos. |
| El límite de dominio está escrito y es citable | Cierto: `src/services/tremor.py:30-32` — *"Lo que esto NO afirma: 'tremor volcánico'. […] la interpretación es del sismólogo. La UI lo llama 'episodio sostenido'."* |
| Los tipos del frontend ya traen todos los metadatos | Cierto: `dashboard/lib/analytics.ts` declara `BValueOk` (con `b`, `a`, `sigma_b`), `BValueNotEstimable` (sin ellos), `TremorResponse`, `StationUptimeResponse` con `overall: Record<string, number \| null>`. La unión de b-value está **discriminada por `status`**: leer `b` sin narrow no compila. |
| Hay exactamente dos locales | Cierto: `dashboard/lib/locale.ts:17-19` (`APP_LOCALES = ['es','en']`, default `'es'`) y dos archivos, `messages/es.json` y `messages/en.json`. |
| La paridad ES/EN está blindada por test | Cierto: `dashboard/messages/parity.test.ts` exige el mismo set de claves aplanadas en ambas direcciones **y ningún valor vacío**. Una clave nueva en un solo idioma rompe la suite. |
| Radix viene del paquete unificado | Cierto: `package.json:34` declara `"radix-ui": "^1.6.2"`, y `components/ui/tooltip.tsx` importa `{ Tooltip as TooltipPrimitive } from "radix-ui"`. **No existe** un `components/ui/popover.tsx`. |
| Las constantes sismológicas son fuente única | Cierto: `dashboard/lib/seismic-constants.json` — `bValueMinEvents: 50`, `magnitudeBinWidth: 0.1`, `mcCorrection: 0.2`, `tremorBaselineFactor: 2.0`, `tremorMinDurationPeriods: 3`. `tremor.py` las lee del MISMO archivo. |
| `chart-chrome.test.ts` descubre por contenido | Cierto (Fase 1, ya en main): raíces `components/` y `components/analytics/`, `.tsx` no-test que **importan `recharts`**, con piso de 7 archivos. |

---

## Decisiones tomadas en esta spec

| # | Tema | Decisión | Por qué |
|---|------|----------|---------|
| 1 | **Qué entra al glosario v1** | **Exactamente 5 términos**: `b-value`, `Mc`, `RSAM`, `FI`, `uptime ratio`. Cierra la Open Question 3 del proposal. | Criterio: **entra lo que es una ETIQUETA VISIBLE en la UI**. `sigma_b`, `onset_ratio`, `fi_sign` y `tremor_fraction` NO son etiquetas: son magnitudes que aparecen dentro de una fila o de una frase, y se explican **dentro del texto de su propia advertencia**. Un glosario que crece con cada campo del backend deja de ser un glosario y pasa a ser documentación. |
| 2 | **Umbral de "estación que tengo que mirar HOY"** | **Ratio fijo `< 0.9`.** No percentil, no top-N. Cierra la Open Question 2. | Un umbral fijo es **estable**: significa lo mismo la semana que viene. Un percentil siempre marca al 10 % peor aunque la red esté perfecta, y un top-N siempre muestra N filas aunque no haya nada mal. Con umbral fijo, **si la red mejora la lista se vacía sola, y una lista vacía ES información**. En Fase 2 esto se encarna solo como regla en la lib; la presentación es Fase 4. |
| 3 | **Cuántos canales hay de verdad** | **107**, no 118. Cierra la Open Question 1. | La cifra "118" del pedido original nunca se verificó (el único match en el repo era un conteo de archivos de test). El número importa para la Fase 4 (recorte del ranking), no para esta fase, pero se deja escrito acá para que no se re-arrastre el 118. |
| 4 | **`b ± 1.96σ` se calcula en la UI y se rotula como derivado** | La lib expone la aritmética; la clave i18n dice explícitamente "intervalo derivado bajo supuesto de normalidad". El copy MUST NOT contener "intervalo de confianza" atribuido al backend. | `sigma_b` es σ de Shi & Bolt (1982), no un IC. Hoy `BValueChart.tsx:99` muestra σ pelado: no miente, pero tampoco desambigua. Rotularlo es lo que evita que un lector lo lea como IC del 95 %. |
| 5 | **La lib es PURA: sin React, sin i18n resuelto, sin formato** | La lib devuelve objetos con `messageKey` + `values`, **nunca strings traducidos**. Quien traduce es el componente. | Es la condición para que sea testeable por mutación con listas de datos, que es el estándar del repo. Además, una lib que importara `useTranslations` no sería pura y no podría testearse sin renderizar. |
| 6 | **Severidad graduada, con una sola advertencia fuerte** | Tres niveles: `critical`, `warning`, `info`. **`mc_at_catalog_floor === true` es el único `critical` de esta fase.** Todo lo demás informa. | Mitigación explícita del riesgo "si todo advierte, nada advierte" (`proposal.md:196`). Es el metadato que invalida la lectura del b-value; el resto matiza. |
| 7 | **Orden determinista de la lista de advertencias** | Por severidad descendente y, a igual severidad, por orden de declaración del catálogo de reglas. Nunca por orden de iteración de un objeto. | Un orden que dependa de `Object.keys` es un test flaky esperando pasar. Determinista = asserteable. |
| 8 | **El límite de dominio se codifica, no se pide de palabra** | Un test MUST verificar que **ninguna** de las claves i18n nuevas de esta fase contiene los términos de diagnóstico de fenómeno prohibidos, en los dos idiomas. | `proposal.md:193` lo marca como riesgo **High**. Un riesgo alto que solo vive en una tabla de riesgos no está mitigado. Convertirlo en un test es la única mitigación real. |
| 9 | **Los componentes nuevos NO importan `recharts`** | El componente de advertencia y el de término de glosario son texto y primitivas de Radix, no gráficos. | Consecuencia directa: quedan **fuera** del conjunto que descubre `chart-chrome.test.ts` (cuyo filtro es "importa recharts"), así que no pueden hacerlo fallar ni subir el piso de 7. Se deja escrito para que nadie "arregle" el descubrimiento creyendo que los perdió. |
| 10 | **Nada se cablea** | Ningún panel existente se modifica en esta fase. | Es lo que hace la fase mergeable sola y su rollback trivial. Si un PR de Fase 2 toca `BValueChart.tsx`, salió del alcance. |
| 11 | **Sin `forceMount` en el glosario** | El componente de término MUST NOT usar `forceMount`. | Lección ya pagada en este repo: `forceMount` deja contenido inactivo visible al lector de pantalla. |
| 12 | **Verificación por mutación, documentada** | Toda regla del catálogo MUST tener una mutación que la mate, registrada en el `mutation-log.md` de la fase. | Estándar del repo, y ya mordió acá: `chart-chrome.test.ts` estuvo verde una fase entera protegiendo cero. |

---

## ADDED Requirements

### Requirement: Lib pura de reglas de confiabilidad

MUST existir en `dashboard/lib/` un módulo puro (sin React, sin `next-intl`, sin
acceso a red, sin `Date.now()` implícito) que reciba una respuesta ya tipada de
`dashboard/lib/analytics.ts` y devuelva una lista tipada de advertencias.

La lib MUST ser una función total: para **toda** entrada que satisfaga los tipos
de `analytics.ts` devuelve un array (posiblemente vacío) y MUST NOT lanzar.

La lib MUST NOT producir texto traducido. Cada advertencia MUST llevar una clave
de mensaje y, si el mensaje interpola, un objeto de valores ya formateados como
primitivas (`string | number`). Quién traduce es la capa de componente.

La lib MUST NOT leer `mc_at_catalog_floor`, `sigma_b` ni ningún otro campo
inventando defaults: si un campo requerido por una regla no existe en el miembro
de la unión recibido, esa regla no dispara.

Los identificadores van en inglés y los comentarios en español.

#### Scenario: Una respuesta sin ningún problema no produce advertencias

- GIVEN una respuesta de b-value con `status: 'ok'`, `mc_at_catalog_floor: false`, un solo tipo de magnitud y `n_above_mc` holgadamente por encima de `min_events`
- WHEN se evalúan las reglas
- THEN el resultado es un array vacío
- AND no se lanza ninguna excepción

#### Scenario: La lib no traduce

- GIVEN cualquier advertencia producida por la lib
- WHEN se inspecciona el objeto devuelto
- THEN contiene una clave de mensaje y, si corresponde, valores de interpolación
- AND no contiene ninguna frase en español ni en inglés

#### Scenario: La lista de advertencias tiene orden determinista

- GIVEN una respuesta que dispara simultáneamente una regla `critical` y dos `info`
- WHEN se evalúan las reglas dos veces sobre la misma entrada
- THEN ambas corridas devuelven exactamente la misma secuencia
- AND la advertencia `critical` aparece antes que las `info`

---

### Requirement: Tipos de la capa de advertencias

MUST existir un tipo de advertencia con, como mínimo: un identificador de regla
estable, una severidad, la clave de mensaje y los valores de interpolación
opcionales.

La severidad MUST ser una unión cerrada de exactamente tres valores:
`'critical' | 'warning' | 'info'`. MUST NOT ser `string`.

El identificador de regla MUST ser una unión cerrada de literales, no `string`:
un typo en un id tiene que ser un error de compilación, no una advertencia que
nunca dispara.

Los tipos MUST reflejar que la respuesta de b-value es una **unión discriminada
por `status`**: una regla que necesite `sigma_b` MUST estar escrita de modo que
no compile si se la aplica a un miembro que no lo declara.

#### Scenario: La severidad es una unión cerrada

- GIVEN el tipo de advertencia
- WHEN se intenta construir una advertencia con severidad `'grave'`
- THEN el código no compila

#### Scenario: Un campo exclusivo de `BValueOk` no se lee sin narrow

- GIVEN una respuesta tipada como `BValueResponse`
- WHEN una regla intenta leer `sigma_b` sin discriminar por `status === 'ok'`
- THEN el código no compila

---

### Requirement: Catálogo de reglas de advertencia de b-value

Las reglas de b-value MUST ser exactamente las siguientes, con estos
disparadores, umbrales y severidades. Ninguna otra regla de b-value entra en
esta fase.

| Id | Campo(s) disparador(es) | Condición exacta | Severidad | Qué comunica el mensaje |
|---|---|---|---|---|
| `mc-at-catalog-floor` | `mc_at_catalog_floor` | `=== true` | `critical` | Mc coincide con el piso de ingesta del catálogo, no con la sensibilidad real de la red; el b-value resultante no es confiable. |
| `mixed-magnitude-scales` | `mag_type_counts` | `Object.keys(...).length > 1` | `warning` | Gutenberg-Richter asume **una** escala de magnitud; el catálogo fusionado mezcla más de una. Enumera las escalas y sus conteos. |
| `unknown-magnitude-type` | `mag_type_counts` | existe la clave `"unknown"` con conteo `> 0` | `info` | Hay eventos sin tipo de magnitud declarado; se cuentan en el ajuste sin saber en qué escala están. |
| `small-sample-above-mc` | `n_above_mc`, `min_events` | `status === 'ok'` **y** `n_above_mc < min_events * 1.5` | `warning` | La muestra sobre Mc supera el mínimo pero por poco margen; la incertidumbre del ajuste es alta. |
| `most-events-below-mc` | `n_total`, `n_above_mc` | `n_total > 0` **y** `n_above_mc / n_total < 0.5` | `info` | Más de la mitad del catálogo de la ventana queda bajo Mc y no participa del ajuste. |
| `derived-sigma-interval` | `sigma_b` | `status === 'ok'` (siempre que haya estimación) | `info` | `b ± 1.96σ` es un intervalo **derivado en la UI** bajo supuesto de normalidad a partir de la σ de Shi & Bolt (1982); **no** es un intervalo de confianza calculado por el backend. |

El factor `1.96` MUST vivir como constante con nombre en la lib, no como número
mágico repetido. El intervalo derivado MUST calcularse como `b - 1.96 * sigma_b`
y `b + 1.96 * sigma_b`.

El umbral `1.5` de `small-sample-above-mc` MUST vivir como constante con nombre.
MUST NOT hardcodearse `50`: el mínimo viaja en `min_events` de la respuesta, que
el backend toma de `bValueMinEvents` de `seismic-constants.json` (fuente única).

Con `status` distinto de `'ok'`, las reglas `small-sample-above-mc` y
`derived-sigma-interval` MUST NOT disparar: el body no trae `b` ni `sigma_b`, y
el propio panel ya muestra el mensaje de `insufficient`/`degenerate`.

#### Scenario: El piso de catálogo es la advertencia fuerte

- GIVEN una respuesta de b-value con `mc_at_catalog_floor: true`
- WHEN se evalúan las reglas
- THEN la lista contiene una advertencia con id `mc-at-catalog-floor` y severidad `critical`
- AND al poner el mismo campo en `false` esa advertencia desaparece y ninguna otra la reemplaza

#### Scenario: Dos escalas de magnitud violan el supuesto

- GIVEN `mag_type_counts` igual a `{ "ml": 120, "mw": 30 }`
- WHEN se evalúan las reglas
- THEN aparece `mixed-magnitude-scales` con severidad `warning`
- AND los valores de interpolación permiten nombrar las dos escalas y sus conteos

#### Scenario: Una sola escala no advierte

- GIVEN `mag_type_counts` igual a `{ "ml": 150 }`
- WHEN se evalúan las reglas
- THEN no aparece `mixed-magnitude-scales`

#### Scenario: `unknown` es una escala más para la regla de mezcla

- GIVEN `mag_type_counts` igual a `{ "ml": 100, "unknown": 8 }`
- WHEN se evalúan las reglas
- THEN aparecen **ambas**: `mixed-magnitude-scales` (son dos claves) y `unknown-magnitude-type`
- AND `mixed-magnitude-scales` precede a `unknown-magnitude-type` por severidad

#### Scenario: `unknown` en cero no advierte

- GIVEN `mag_type_counts` igual a `{ "ml": 100, "unknown": 0 }`
- WHEN se evalúan las reglas
- THEN no aparece `unknown-magnitude-type`
- AND sí aparece `mixed-magnitude-scales`, porque el diccionario tiene dos claves declaradas

#### Scenario: `mag_type_counts` vacío no advierte ni explota

- GIVEN `mag_type_counts` igual a `{}`
- WHEN se evalúan las reglas
- THEN no aparece ninguna regla de escalas de magnitud
- AND la evaluación no lanza

#### Scenario: Muestra justo por encima del mínimo

- GIVEN `status: 'ok'`, `min_events: 50` y `n_above_mc: 60`
- WHEN se evalúan las reglas
- THEN aparece `small-sample-above-mc` con severidad `warning`

#### Scenario: Muestra holgada no advierte

- GIVEN `status: 'ok'`, `min_events: 50` y `n_above_mc: 75`
- WHEN se evalúan las reglas
- THEN no aparece `small-sample-above-mc`
- AND con `n_above_mc: 74` sí aparece, porque el corte es `< min_events * 1.5`

#### Scenario: `min_events` en cero no divide ni advierte por sorpresa

- GIVEN `min_events: 0` y `n_above_mc: 3`
- WHEN se evalúan las reglas
- THEN `small-sample-above-mc` no dispara
- AND no se produce `NaN` ni `Infinity` en ningún valor de interpolación

#### Scenario: Casi todo el catálogo queda bajo Mc

- GIVEN `n_total: 400` y `n_above_mc: 120`
- WHEN se evalúan las reglas
- THEN aparece `most-events-below-mc` con severidad `info`

#### Scenario: Un catálogo vacío no divide por cero

- GIVEN `n_total: 0` y `n_above_mc: 0`
- WHEN se evalúan las reglas
- THEN no aparece `most-events-below-mc`
- AND la evaluación devuelve un array sin `NaN` y no lanza

#### Scenario: El intervalo derivado se calcula con 1.96

- GIVEN `status: 'ok'`, `b: 1.0` y `sigma_b: 0.1`
- WHEN se evalúan las reglas
- THEN aparece `derived-sigma-interval`
- AND los extremos del intervalo son `0.804` y `1.196` (a la precisión de punto flotante del cálculo)

#### Scenario: Con `sigma_b` en cero el intervalo colapsa pero sigue rotulado

- GIVEN `status: 'ok'`, `b: 0.9` y `sigma_b: 0`
- WHEN se evalúan las reglas
- THEN aparece `derived-sigma-interval` con ambos extremos iguales a `0.9`
- AND el mensaje sigue rotulándolo como intervalo derivado

#### Scenario: Sin estimación no hay reglas que dependan de `b`

- GIVEN una respuesta con `status: 'insufficient'`
- WHEN se evalúan las reglas
- THEN no aparecen `derived-sigma-interval` ni `small-sample-above-mc`
- AND sí pueden aparecer `mc-at-catalog-floor` y las de escalas de magnitud, que no dependen de `b`

---

### Requirement: Catálogo de reglas de advertencia de tremor

Las reglas de tremor MUST ser exactamente las siguientes. Ninguna otra entra en
esta fase.

| Id | Campo(s) disparador(es) | Condición exacta | Severidad | Qué comunica el mensaje |
|---|---|---|---|---|
| `median-baseline-masking` | `tremor_fraction` | `> 0.5` | `warning` | La línea base es la **mediana** de la ventana: si un episodio ocupa más de la mitad, la mediana sube y el episodio puede quedar sin detectar. Limitación documentada en `src/services/tremor.py:26-28`. |
| `no-baseline` | `baseline_rsam` | `=== null` | `info` | No hay muestras no nulas en la ventana: sin mediana no hay umbral, y por eso no se dibuja línea de umbral. |
| `emergent-onset` | `episodes[].onset_ratio` | existe al menos un episodio con `onset_ratio < 0.3` | `info` | Al menos un episodio arranca muy por debajo de su pico (arranque emergente y no impulsivo). Explica qué es `onset_ratio`, que no está en el glosario. |
| `undefined-band` | `episodes[].band` | existe al menos un episodio con `band === 'undefined'` | `info` | No se pudo determinar la banda dominante de al menos un episodio; su clasificación espectral no está disponible. |

El umbral `0.5` de `median-baseline-masking` y el `0.3` de `emergent-onset` MUST
vivir como constantes con nombre.

`no-baseline` MUST distinguir `baseline_rsam === null` de `baseline_rsam === 0`.
Un `0` es un hecho medido ("se miró y la amplitud es cero") y MUST NOT disparar
`no-baseline`: es la misma invariante `null ≠ 0` que declara
`dashboard/lib/analytics.ts` y `src/models/analytics.py:11-15`.

#### Scenario: Un episodio que ocupa media ventana enmascara la mediana

- GIVEN `tremor_fraction: 0.62`
- WHEN se evalúan las reglas de tremor
- THEN aparece `median-baseline-masking` con severidad `warning`
- AND con `tremor_fraction: 0.5` exacto no aparece, porque el corte es estrictamente `> 0.5`

#### Scenario: Sin línea base no hay umbral

- GIVEN `baseline_rsam: null` y `threshold_rsam: null`
- WHEN se evalúan las reglas de tremor
- THEN aparece `no-baseline` con severidad `info`

#### Scenario: Una línea base en cero NO es "sin dato"

- GIVEN `baseline_rsam: 0` y `threshold_rsam: 0`
- WHEN se evalúan las reglas de tremor
- THEN NO aparece `no-baseline`

#### Scenario: Sin episodios, las reglas por episodio no disparan

- GIVEN `episodes: []`
- WHEN se evalúan las reglas de tremor
- THEN no aparecen `emergent-onset` ni `undefined-band`
- AND la evaluación no lanza

#### Scenario: Un solo episodio emergente alcanza para advertir

- GIVEN dos episodios con `onset_ratio` `0.8` y `0.12`
- WHEN se evalúan las reglas de tremor
- THEN aparece `emergent-onset` una sola vez, no una por episodio

---

### Requirement: Regla de umbral de uptime "qué mirar hoy"

MUST existir una regla que, dado el mapa `overall` de
`StationUptimeResponse`, separe los canales en dos grupos por un **umbral fijo**
de ratio: los que MUST revisarse hoy (`ratio < 0.9`) y el resto.

El umbral `0.9` MUST vivir como una constante exportada con nombre, en la lib,
para que Fase 4 lo consuma sin redefinirlo. MUST NOT ser un percentil ni un
top-N (decisión 2 de esta spec).

Los canales con `overall[canal] === null` (nunca observados) MUST tratarse como
un **tercer grupo explícito**, ni "a revisar" ni "sano": `null` significa "nadie
miró", no "ratio bajo". Convertir `null` en `0` acá reintroduciría, del lado del
frontend, exactamente el bug que el backend evita a propósito.

El grupo "a revisar" MUST venir ordenado de peor a mejor ratio, de forma
determinista ante empates (desempate por nombre de canal ascendente).

Esta fase MUST NOT renderizar nada de esto: entrega la regla y su test. El
recorte a 10, el "ver todas" y la línea "N canales ≥ 90 %" son **Fase 4**.

#### Scenario: El corte es estrictamente menor que 0.9

- GIVEN `overall` con `{ "A": 0.89, "B": 0.9, "C": 0.91 }`
- WHEN se aplica la regla de umbral
- THEN `A` queda en el grupo a revisar
- AND `B` y `C` quedan en el grupo sano

#### Scenario: Un canal nunca observado no se confunde con uno caído

- GIVEN `overall` con `{ "A": null, "B": 0.0 }`
- WHEN se aplica la regla de umbral
- THEN `B` queda en el grupo a revisar
- AND `A` queda en el grupo de nunca observados, separado de los otros dos

#### Scenario: El orden del grupo a revisar es determinista

- GIVEN `overall` con `{ "Z": 0.5, "A": 0.5, "M": 0.2 }`
- WHEN se aplica la regla de umbral
- THEN el grupo a revisar es exactamente `["M", "A", "Z"]`

#### Scenario: Una red sana devuelve un grupo vacío

- GIVEN `overall` donde todos los canales tienen ratio `>= 0.9`
- WHEN se aplica la regla de umbral
- THEN el grupo a revisar es un array vacío
- AND eso no es un error: una lista vacía es el resultado correcto

#### Scenario: Un `overall` vacío no explota

- GIVEN `overall` igual a `{}`
- WHEN se aplica la regla de umbral
- THEN los tres grupos son arrays vacíos

---

### Requirement: Glosario v1 de exactamente cinco términos

MUST existir en `dashboard/messages/es.json` y `dashboard/messages/en.json` un
grupo de claves de glosario con **exactamente cinco** entradas, ni una más:

| Término | Qué explica la entrada (sin diagnosticar fenómenos) |
|---|---|
| `b-value` | Pendiente de la relación de Gutenberg-Richter entre magnitud y frecuencia de ocurrencia. Valores cercanos a 1 son típicos en catálogos tectónicos. Se estima por máxima verosimilitud (Aki-Utsu) sobre los eventos por encima de Mc. |
| `Mc` | Magnitud de completitud: magnitud a partir de la cual el catálogo se considera completo. Los eventos por debajo existen pero no están todos registrados, por eso no entran al ajuste. |
| `RSAM` | Real-time Seismic Amplitude Measurement: amplitud media de la señal en ventanas sucesivas de duración fija. Mide cuánta energía llega, sin decir de dónde viene. |
| `FI` | Índice de frecuencia: logaritmo del cociente entre la energía en una banda alta y una banda baja. Negativo = predominan las bajas frecuencias; positivo = predominan las altas. |
| `uptime ratio` | Fracción de columnas efectivamente escritas sobre las esperadas en las horas **observadas**. Sin ninguna hora observada el valor es "sin dato", que no es lo mismo que cero. |

Cada término MUST tener, como mínimo, una clave de rótulo corto y una clave de
definición, y MUST existir en **los dos** locales (`es` y `en`) con las dos
claves — lo exige `dashboard/messages/parity.test.ts`, que compara los sets de
claves aplanadas en ambas direcciones y rechaza valores vacíos.

Las claves nuevas MUST ser **aditivas**: esta fase MUST NOT renombrar, mover ni
borrar ninguna clave existente de `analytics.*`.

`sigma_b`, `onset_ratio`, `fi_sign` y `tremor_fraction` MUST NOT tener entrada de
glosario: se explican dentro del texto de su propia advertencia (decisión 1).

#### Scenario: El glosario tiene exactamente cinco términos en los dos idiomas

- GIVEN los dos archivos de mensajes
- WHEN se cuentan las entradas del grupo de glosario
- THEN hay exactamente cinco en `es.json` y exactamente cinco en `en.json`
- AND los cinco identificadores coinciden entre ambos

#### Scenario: Un término agregado sin traducir rompe la suite

- GIVEN una entrada de glosario nueva presente solo en `es.json`
- WHEN se corre `dashboard/messages/parity.test.ts`
- THEN el test falla indicando la clave ausente en `en.json`

#### Scenario: No se cuela un término fuera del corte

- GIVEN el grupo de glosario
- WHEN se buscan entradas para `sigma_b`, `onset_ratio`, `fi_sign` o `tremor_fraction`
- THEN no existe ninguna

---

### Requirement: Toda clave nueva explica la métrica y no diagnostica el fenómeno

Ningún texto agregado por esta fase —glosario, mensajes de advertencia o prosa—
MUST afirmar un fenómeno de dominio. El límite lo fija
`src/services/tremor.py:30-32`: se puede afirmar amplitud sostenida, banda
dominante y signo del FI; **la interpretación es del sismólogo**.

MUST existir un test automático que recorra **todas** las claves nuevas de esta
fase, en los dos locales, y falle si alguna contiene un término de diagnóstico de
fenómeno. Como mínimo MUST prohibirse, sin distinguir mayúsculas:
`tremor volcánico` / `volcanic tremor`, `erupción` / `eruption`, `enjambre` /
`swarm`, `precursor`, `inminente` / `imminent`, `predice` / `predicts`.

Los mensajes de advertencia MUST estar redactados en modo "esto significa X" y
MUST NOT estar redactados en modo "está pasando X".

Además, ninguna clave nueva MUST llamar "intervalo de confianza" / "confidence
interval" al intervalo derivado de `sigma_b`; el test MUST cubrir también ese
par de frases.

#### Scenario: Una clave que diagnostica no pasa el test

- GIVEN una clave de advertencia cuyo texto en español dice "esto indica tremor volcánico"
- WHEN se corre el test de límite de dominio
- THEN el test falla nombrando la clave y el término prohibido

#### Scenario: Una clave que explica sí pasa

- GIVEN una clave cuyo texto dice "la línea base es la mediana de la ventana; un episodio que ocupe más de la mitad la eleva y puede no detectarse"
- WHEN se corre el test de límite de dominio
- THEN el test pasa

#### Scenario: Llamar IC al intervalo derivado no pasa

- GIVEN la clave del intervalo derivado redactada como "intervalo de confianza del 95 %"
- WHEN se corre el test de límite de dominio
- THEN el test falla

#### Scenario: El test cubre los dos idiomas

- GIVEN un término prohibido presente solo en el texto en inglés
- WHEN se corre el test de límite de dominio
- THEN el test falla igual

---

### Requirement: Componente de advertencia reutilizable

MUST existir en `dashboard/components/analytics/` un componente que reciba una
advertencia (o una lista) producida por la lib y la renderice.

El componente MUST distinguir visualmente las tres severidades y MUST NOT
apoyarse **solo** en el color para hacerlo: MUST aportar también un elemento
textual o iconográfico, y el texto de severidad MUST estar disponible para
lectores de pantalla.

El componente MUST resolver la traducción a partir de la clave y los valores que
trae la advertencia, usando `next-intl`. MUST NOT contener texto literal de
producto en el propio componente.

El componente MUST usar clases de color tematizadas (o pares `clase dark:clase`)
y MUST NOT contener literales hexadecimales ni grises de Tailwind huérfanos — la
misma regla que la Fase 1 fijó para los paneles.

Con una lista vacía de advertencias el componente MUST no renderizar contenedor
vacío ni espaciado fantasma.

El componente MUST NOT importar `recharts`: no es un panel de gráfico y por lo
tanto queda deliberadamente fuera del conjunto que descubre
`chart-chrome.test.ts`.

#### Scenario: Cada severidad se distingue sin depender solo del color

- GIVEN una advertencia de cada una de las tres severidades
- WHEN se renderizan
- THEN cada una expone su severidad de forma accesible al lector de pantalla
- AND la distinción no depende únicamente de la clase de color

#### Scenario: Lista vacía no deja hueco

- GIVEN una lista de advertencias vacía
- WHEN se renderiza el componente
- THEN no aparece ningún contenedor ni separador en el DOM

#### Scenario: El texto sale de i18n

- GIVEN una advertencia con clave y valores de interpolación
- WHEN se renderiza
- THEN el texto mostrado es el de la clave resuelta con esos valores
- AND el componente no contiene ese texto escrito a mano

---

### Requirement: Componente de término de glosario reutilizable

MUST existir en `dashboard/components/analytics/` un componente que, dado el
identificador de uno de los cinco términos, renderice el rótulo del término y
permita revelar su definición desde cualquier panel.

La primitiva de revelado MUST venir del paquete unificado `radix-ui`, no de un
`@radix-ui/react-*` suelto. El repo ya expone `components/ui/tooltip.tsx`
construido así; no existe `components/ui/popover.tsx`.

El componente MUST ser accesible con teclado y MUST poder abrirse sin hover, para
no quedar inutilizable en touch.

El componente MUST NOT usar `forceMount`: deja contenido inactivo visible al
lector de pantalla. Si hace falta mantener el nodo montado, MUST reaplicarse
`hidden` cuando está cerrado.

El identificador de término MUST estar tipado como unión cerrada de los cinco
literales: pedir un término inexistente MUST ser un error de compilación, no un
texto faltante en tiempo de ejecución.

Un mismo término MUST poder invocarse desde más de un panel sin duplicar su
definición: una entrada de i18n, N invocaciones.

#### Scenario: El término se abre con teclado

- GIVEN el componente renderizado para `b-value`
- WHEN el disparador recibe foco y se lo activa por teclado
- THEN la definición queda disponible
- AND al cerrarlo, el foco vuelve al disparador

#### Scenario: Un término inexistente no compila

- GIVEN el componente
- WHEN se lo invoca con el identificador `'sigma_b'`
- THEN el código no compila, porque no es uno de los cinco términos del glosario v1

#### Scenario: El contenido cerrado no queda expuesto

- GIVEN el componente cerrado
- WHEN se inspecciona el árbol accesible
- THEN la definición no es alcanzable por el lector de pantalla

#### Scenario: El mismo término desde dos lugares comparte definición

- GIVEN dos instancias del componente con el identificador `Mc`
- WHEN se abren ambas
- THEN las dos muestran exactamente el mismo texto, resuelto de la misma clave

---

### Requirement: Verificación por mutación de toda regla del catálogo

Cada regla del catálogo (6 de b-value, 4 de tremor, 1 de umbral de uptime) MUST
demostrarse capaz de fallar. La demostración MUST hacerse invirtiendo el
comparador o corriendo el umbral en la lib, corriendo la suite, observando el
rojo, y revirtiendo.

Como mínimo MUST demostrarse:

1. Invertir la condición de `mc-at-catalog-floor` (`=== true` → `=== false`) hace
   fallar su test.
2. Cambiar `> 1` por `> 0` en `mixed-magnitude-scales` hace fallar el escenario
   de una sola escala.
3. Cambiar el factor `1.96` por `1.0` hace fallar el escenario del intervalo
   derivado.
4. Cambiar `< 0.9` por `<= 0.9` en el umbral de uptime hace fallar el escenario
   del corte estricto.
5. Tratar `baseline_rsam === 0` como "sin dato" (`!baseline_rsam` en vez de
   `=== null`) hace fallar el escenario de la línea base en cero.
6. Cambiar `>` por `>=` en `median-baseline-masking` hace fallar el escenario del
   `0.5` exacto.
7. Agregar un término prohibido a una clave i18n nueva hace fallar el test de
   límite de dominio.
8. Agregar una sexta entrada al glosario hace fallar el test de conteo, y
   agregarla en un solo idioma hace fallar además `parity.test.ts`.

Antes de dar por válida una mutación MUST verificarse que el archivo
efectivamente cambió (`git diff --stat` no vacío): una mutación que no muta no
prueba nada. Las mutaciones MUST aplicarse con edición directa, no con `sd -s`
sobre patrones con saltos de línea, que sale con exit 0 dejando el archivo
intacto.

El resultado de las ocho mutaciones MUST quedar escrito en el registro de la
fase.

#### Scenario: Una mutación que no cambió el archivo se descarta

- GIVEN una mutación aplicada sobre la lib
- WHEN `git diff --stat` no muestra cambios
- THEN la mutación se considera inválida y el verde resultante no cuenta como evidencia

#### Scenario: Las ocho mutaciones producen rojo

- GIVEN la suite del dashboard en verde
- WHEN se aplica cada una de las ocho mutaciones listadas, de a una
- THEN en cada caso falla al menos el test indicado
- AND al revertir, la suite vuelve a verde

---

### Requirement: La fase no altera la página ni el backend

Al cerrar la fase, `git diff` MUST estar vacío en `src/services/station_uptime.py`,
`src/services/tremor.py`, `src/models/analytics.py` y en todos los componentes de
panel existentes (`BValueChart.tsx`, `TremorPanel.tsx`, `StationUptimeChart.tsx`,
`RsamTrendChart.tsx`, `DepthSectionChart.tsx`, `MagnitudeTimeChart.tsx`,
`DepthDistributionChart.tsx`, `EventsTable.tsx`) y en
`dashboard/app/(app)/analytics/page.tsx`.

La suite completa del dashboard MUST quedar en verde, con la cantidad de tests
**estrictamente mayor** que el baseline de Fase 1 (1362): esta fase solo agrega.

`chart-chrome.test.ts` MUST seguir descubriendo exactamente 7 archivos: los
componentes nuevos de esta fase no importan `recharts` y por lo tanto no entran
al conjunto ni mueven el piso.

Como nada se cablea, esta fase **no produce cambio visual** y por lo tanto MUST
NOT pedirle al usuario un QA visual de producto. Lo que MUST entregar en su lugar
es el registro de mutaciones y la lista de piezas disponibles para la Fase 3.

#### Scenario: Ningún panel existente quedó tocado

- GIVEN la fase implementada
- WHEN se corre `git diff --stat` contra la base de la rama
- THEN no aparece ningún componente de panel existente ni ningún archivo de `src/`

#### Scenario: La suite crece y no decrece

- GIVEN la suite en verde antes de la fase con 1362 tests
- WHEN se corre la suite después de la fase
- THEN la cantidad de tests es mayor
- AND no hay ningún test previo en rojo ni saltado

#### Scenario: El descubrimiento de cromo no se mueve

- GIVEN los componentes nuevos de esta fase
- WHEN se corre `chart-chrome.test.ts`
- THEN el conjunto descubierto sigue siendo de 7 archivos
- AND el test pasa sin modificaciones

---

## MODIFIED Requirements

Ninguno. Esta fase es enteramente aditiva: no cambia el comportamiento de ningún
panel, no redefine ninguna clave i18n existente y no altera ningún contrato. Lo
único que hace es poner en el árbol piezas que todavía nadie consume.

## REMOVED Requirements

Ninguno.

---

## Fuera de alcance de esta fase (explícito)

- **Cablear las advertencias a los paneles.** `BValueChart`, `TremorPanel` y
  `StationUptimeChart` MUST quedar con `git diff` vacío. La regla de umbral de
  uptime se entrega **sin** presentación: el recorte a 10, el "ver todas" y la
  línea "N canales ≥ 90 %" son **Fase 4**.
- **Prosa interpretativa por panel.** Esta fase entrega el glosario y los
  mensajes de advertencia; la prosa que acompaña a cada panel es Fase 3.
- **Todo el backend.** `src/services/station_uptime.py`, `src/services/tremor.py`
  y `src/models/analytics.py` no se tocan. La invariante de tres casos de
  `_ratio()` es correcta y está blindada por 8 tests; tocarla es una regresión,
  y es el riesgo #1 declarado del change.
- **Métricas que el backend no calcula**: intervalo de confianza formal, bondad
  de ajuste (R², KS, test de Utsu), error de Mc, SNR. `b ± 1.96σ` no es una
  excepción: es aritmética sobre un valor que el backend ya devuelve, rotulada
  como derivada.
- **Codificación visual del uptime** (`<Cell>` por ratio, distinción `null` vs
  `0.0`, leyenda de la tira de cuadraditos) — Fase 4.
- **Ordenamiento y jerarquía visual de `EventsTable`** — Fase 5.
- **Layout, grillas, tipografía y estructura de tabs de `/analytics`**, y el
  `keepMounted` heredado de `analytics-professional-panels`.
- **Ampliar el glosario más allá de los cinco términos.** Un sexto término es un
  pedido nuevo, no un ajuste de esta fase.
- **Interpretación generada por LLM.** El asistente conversacional
  (`asistente-sismico-conversacional`) es otra iniciativa; lo de acá es estático
  y determinista.
- **El favicon del sitio.**
