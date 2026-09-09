# Delta for Dashboard UI — Fase 1: deuda de tematización de los dos paneles heredados

Delta sobre `openspec/specs/dashboard-ui/spec.md`, acotado **exclusivamente a la
Fase 1** de `analytics-redesign` (ver tabla de fases en `proposal.md:156-162`).
Las fases 2 a 5 (interpretación, uptime, tabla de eventos) **no se especifican
acá** y ningún requirement de este archivo las anticipa.

Alcance de esta fase, en una frase: **`MagnitudeTimeChart` y
`DepthDistributionChart` dejan de tener cromo fijo, ganan test propio, y
`chart-chrome.test.ts` deja de ser una whitelist para pasar a descubrir los
archivos** — de modo que la red de seguridad quede puesta ANTES de que las fases
2-5 toquen los paneles.

Es la fase sin dependencias y mergeable sola. No cambia ni un byte de backend, no
agrega claves i18n, no cambia el layout de la página ni la estructura de tabs.

---

## Lo que el código dice hoy (verificado 2026-09-09)

| Afirmación | Estado en el código |
|---|---|
| `MagnitudeTimeChart` hardcodea cromo | Cierto. `CartesianGrid stroke="#374151"` (L50), `XAxis stroke="#9ca3af"` (L59), `YAxis stroke="#9ca3af"` (L66). No importa `@/lib/chart-theme`. |
| `MagnitudeTimeChart` tiene tooltip propio | Cierto: `Tooltip content={...}` (L68-82) con markup nuestro sobre `bg-gray-900 ... text-white` y `text-gray-400` (L73, L78). **No usa `contentStyle`** ⇒ las tres props de tooltip de `chart-theme.ts` NO aplican acá. |
| `MagnitudeTimeChart` tiene hex que CODIFICAN dato | Cierto y **debe quedarse así**: `ReferenceLine stroke="#ef4444"` / `"#f59e0b"` (L83-84) son los umbrales M5.0/M4.0 de la escala de severidad, y `Cell fill={entry.color}` (L87) sale de `getMagnitudeColor`. |
| `DepthDistributionChart` hardcodea cromo | Cierto. `CartesianGrid stroke="#374151"` (L41), `XAxis stroke="#9ca3af"` (L42), `YAxis stroke="#9ca3af"` (L43). |
| `DepthDistributionChart` estila el tooltip por defecto | Cierto: `contentStyle={{ backgroundColor: '#1f2937', border: 'none', borderRadius: '8px' }}` (L45) + `labelStyle={{ color: '#fff' }}` (L46), **sin `itemStyle`** — exactamente el defecto que `chart-theme.ts:45-62` documenta. |
| `DepthDistributionChart` tiene hex que codifican dato | Cierto y **debe quedarse así**: los `color` de los cuatro bins (L21-24) son la escala de profundidad, alineada con `getDepthColor` (`dashboard/lib/utils.ts:64`). |
| Ninguno de los dos tiene test propio | Cierto: no existen `MagnitudeTimeChart.test.tsx` ni `DepthDistributionChart.test.tsx`. Son los únicos dos paneles de `/analytics` sin test. |
| `chart-chrome.test.ts` es ciego a los dos | Cierto, **por dos causas acumuladas**: (a) whitelist `PANELES` (L25-31) con solo los 5 paneles de Fase 5; (b) `join(__dirname, archivo)` (L40), y `__dirname` es `dashboard/components/analytics/`, mientras los dos paneles viven en `dashboard/components/`. **Agregar los dos nombres al array NO alcanza**: `readFileSync` tiraría `ENOENT`. |
| Ambos se consumen desde `/analytics` | Cierto: `dashboard/app/(app)/analytics/page.tsx:10-11` (imports) y `:122`/`:126` (render). |
| Solo 7 archivos del dashboard importan Recharts | Cierto (medido con `rg -l "from 'recharts'" dashboard/components/`): los 5 de la whitelist + los 2 heredados. El universo a descubrir es exactamente el conjunto correcto. |
| `chart-theme.ts` existe y exporta 5 constantes | Cierto: `CHART_GRID_STROKE`, `CHART_AXIS_STROKE`, `CHART_TOOLTIP_CONTENT_STYLE`, `CHART_TOOLTIP_LABEL_STYLE`, `CHART_TOOLTIP_ITEM_STYLE`, todas `hsl(var(--token))`, sin `useTheme`. |

---

## Decisiones tomadas en esta spec

| # | Tema | Decisión | Por qué |
|---|------|----------|---------|
| 1 | **Qué es cromo y qué es dato** | Cromo = grilla, ejes, ticks, contenedor/etiqueta/filas del tooltip. Dato = `Cell fill`, colores de bin de profundidad, `stroke` de las `ReferenceLine` de M4.0/M5.0. Solo el cromo migra. | Es la regla ya establecida por `chart-theme.ts:15-16` y por el comentario de `chart-chrome.test.ts:15-16`. Meter la escala semántica adentro de `chart-theme.ts` rompería la fuente de verdad de magnitud/profundidad. |
| 2 | **Los dos paneles migran distinto porque su tooltip es distinto** | `DepthDistributionChart` MUST pasar las **tres** props (`contentStyle`, `labelStyle`, `itemStyle`) porque usa el renderer por defecto. `MagnitudeTimeChart` MUST NOT: tiene `content` propio y se arregla con clases Tailwind tematizadas. | Regla de `chart-chrome.test.ts:67-69` y de `chart-theme.ts:45-58`. Pasarle `contentStyle` a un tooltip con `content` propio es código muerto que además haría fallar la regla del test. |
| 3 | **El tooltip propio de `MagnitudeTimeChart` se arregla con tokens de Tailwind, no con hex ni con grises huérfanos** | `bg-gray-900 / border-gray-700 / text-white / text-gray-400` (L73, L78) pasan a las clases tematizadas de la app (`bg-popover`, `border-border`, `text-popover-foreground`, `text-muted-foreground`) o, en su defecto, a pares `X dark:Y`. | La regla de "gris huérfano" ya existe (`chart-chrome.test.ts:88-102`): `text-gray-400` sin pareja `dark:` da 2,54:1 en claro y falla AA. Al entrar al descubrimiento, este archivo queda sujeto a esa regla. |
| 4 | **El descubrimiento se define por criterio, no por lista** | El conjunto cubierto por `chart-chrome.test.ts` MUST derivarse de un escaneo del sistema de archivos sobre `dashboard/components/` y `dashboard/components/analytics/`, filtrando por **archivos `.tsx` que importan `recharts`**, excluyendo archivos de test. | Es el criterio que el proposal fija (`proposal.md:201`) y el que hace que un panel nuevo quede cubierto sin que nadie se acuerde de un array. Medido hoy: da exactamente 7 archivos. |
| 5 | **El descubrimiento tiene piso** | El test MUST fallar si el conjunto descubierto queda por debajo de los 7 archivos conocidos hoy. | Sin piso, un `glob` mal escrito que devuelve `[]` deja el test en verde con cero paneles cubiertos — el modo de fallo exacto que esta fase viene a cerrar. Es la diferencia entre un test que protege y uno que no puede fallar. |
| 6 | **Verificación por mutación, obligatoria y documentada** | Cada test nuevo o modificado de esta fase MUST demostrarse capaz de fallar introduciendo a mano el defecto que dice proteger, y el resultado se deja escrito. | Estándar del repo. Ya mordió acá: `chart-chrome.test.ts` está verde hoy y no protege nada de lo que dice proteger. |
| 7 | **Sin claves i18n nuevas** | Esta fase MUST NOT agregar ni renombrar claves en `dashboard/messages/`. | Es tematización pura. Las claves nuevas son de las fases 2-4. |
| 8 | **QA visual del usuario** | La fase MUST entregar URL exacta y lista de qué mirar, en los dos temas. | Convención del proyecto; además jsdom no hace layout ni resuelve `hsl(var(--token))`, así que el contraste real **no** es verificable por unit test. |

---

## ADDED Requirements

### Requirement: Cromo tematizado en `MagnitudeTimeChart`

`dashboard/components/MagnitudeTimeChart.tsx` MUST tomar el color de su grilla y
de sus ejes de `@/lib/chart-theme` (`CHART_GRID_STROKE`, `CHART_AXIS_STROKE`) y
MUST NOT contener ningún literal hexadecimal en atributos de cromo (`stroke` de
grilla/ejes, `backgroundColor`, `borderColor`, `color`).

Los colores que **codifican dato** MUST permanecer sin cambio: el `fill` de cada
`Cell` (que sale de `getMagnitudeColor`) y el `stroke` de las dos `ReferenceLine`
de M4.0 y M5.0, que son escala de severidad y no cromo.

El tooltip de este panel usa `content` propio, por lo que el componente MUST NOT
pasar `contentStyle`, `labelStyle` ni `itemStyle`. El markup propio del tooltip
MUST usar clases de color tematizadas (o pares `clase dark:clase`), sin grises de
Tailwind huérfanos y sin hex.

#### Scenario: La grilla y los ejes salen de tokens del tema

- GIVEN el panel renderizado con al menos un evento
- WHEN se inspeccionan las props que llegan a `CartesianGrid`, `XAxis` y `YAxis`
- THEN cada `stroke` coincide con `hsl(var(--...))`
- AND ningún `stroke` de cromo es un literal `#rrggbb`

#### Scenario: El color de la magnitud no se tematiza

- GIVEN dos eventos de magnitudes distintas (por ejemplo M2.0 y M6.5)
- WHEN se inspeccionan los `fill` de las `Cell`
- THEN cada uno es exactamente el hex que devuelve `getMagnitudeColor` para su magnitud
- AND las `ReferenceLine` de M4.0 y M5.0 conservan sus colores de severidad

#### Scenario: El tooltip propio no queda gris sobre gris en un tema

- GIVEN el panel renderizado
- WHEN se renderiza el contenido del tooltip para un punto
- THEN el markup no contiene ningún hex
- AND ninguna clase de color gris aparece sin su pareja `dark:` en el mismo `className`

#### Scenario: El panel no adopta el renderer por defecto de tooltip

- GIVEN el código fuente del panel
- WHEN se buscan `contentStyle`, `labelStyle` e `itemStyle`
- THEN no aparece ninguna de las tres, porque el tooltip se dibuja con `content` propio

---

### Requirement: Cromo tematizado en `DepthDistributionChart`

`dashboard/components/DepthDistributionChart.tsx` MUST tomar el color de su
grilla y de sus ejes de `@/lib/chart-theme` y MUST NOT contener literales
hexadecimales en atributos de cromo.

Como este panel usa el renderer de tooltip **por defecto** de Recharts, MUST
pasar las tres props del tema: `contentStyle={CHART_TOOLTIP_CONTENT_STYLE}`,
`labelStyle={CHART_TOOLTIP_LABEL_STYLE}` e `itemStyle={CHART_TOOLTIP_ITEM_STYLE}`.
El `border: 'none'` actual MUST desaparecer en favor del borde tematizado que ya
trae `CHART_TOOLTIP_CONTENT_STYLE`, y el `borderRadius` MUST provenir de la misma
constante en vez de repetirse a mano.

Los cuatro colores de bin de profundidad (L21-24) MUST permanecer sin cambio: son
la escala de profundidad, alineada con `getDepthColor`.

#### Scenario: Las tres props del tooltip llegan tematizadas

- GIVEN el panel renderizado
- WHEN se inspeccionan las props que llegan a `Tooltip`
- THEN `contentStyle.backgroundColor`, `contentStyle.color`, `labelStyle.color` e `itemStyle.color` coinciden con `hsl(var(--...))`
- AND `contentStyle.border` no contiene ningún hex

#### Scenario: Sin `itemStyle` las filas heredarían el color de la serie

- GIVEN el código fuente del panel
- WHEN se verifica que estila el tooltip por defecto (`contentStyle` presente)
- THEN también están presentes `labelStyle` e `itemStyle` apuntando a las constantes del tema

#### Scenario: Los colores de profundidad no se tematizan

- GIVEN eventos repartidos en los cuatro rangos de profundidad
- WHEN se inspeccionan los `fill` de las `Cell`
- THEN cada barra conserva el hex de su bin, en el mismo orden que los cortes de `getDepthColor`

#### Scenario: Un evento sin profundidad no entra en ningún bin

- GIVEN un evento con `prof_km` nulo
- WHEN se calculan los bins
- THEN ese evento no incrementa el `count` de ninguno de los cuatro rangos

---

### Requirement: Test propio para cada uno de los dos paneles heredados

MUST existir `dashboard/components/MagnitudeTimeChart.test.tsx` y
`dashboard/components/DepthDistributionChart.test.tsx`, siguiendo el patrón ya
establecido por los paneles de Fase 5 (`DepthSectionChart.test.tsx`): mockear
`recharts` capturando props y assertear la **transformación de datos y las props
que llegan al gráfico**, no el SVG.

Cada test MUST cubrir, como mínimo: la transformación de eventos a datos del
gráfico, el cromo tematizado, la preservación de los colores que codifican dato,
y el comportamiento con entrada degenerada (lista vacía, evento sin profundidad
en el caso del histograma).

Los tests MUST NOT intentar medir layout, recortes, tamaños ni contraste
efectivo: **jsdom no hace layout** y no resuelve `hsl(var(--token))` contra la
cascada, así que cualquier assert de ese tipo sería verde falso.

Los nombres de identificadores van en inglés y los comentarios en español, como
el resto del repo.

#### Scenario: El panel con lista vacía no explota

- GIVEN una lista de eventos vacía
- WHEN se renderiza el panel
- THEN el componente renderiza sin lanzar
- AND no se afirma nada sobre dimensiones ni visibilidad

#### Scenario: El test falla si se reintroduce el defecto

- GIVEN el test nuevo en verde
- WHEN se reemplaza a mano el token de grilla por un hex fijo en el componente
- THEN el test del panel falla
- AND al revertir la mutación vuelve a verde

---

### Requirement: `chart-chrome.test.ts` cubre por descubrimiento, no por whitelist

`dashboard/components/analytics/chart-chrome.test.ts` MUST determinar el conjunto
de paneles a verificar escaneando el sistema de archivos sobre
`dashboard/components/` **y** `dashboard/components/analytics/`, quedándose con
los archivos `.tsx` que importan `recharts` y descartando los archivos de test.
MUST NOT quedar ninguna lista literal de nombres de panel como fuente del
conjunto.

La resolución de rutas MUST dejar de asumir que todos los paneles viven junto al
propio archivo de test: hoy `join(__dirname, archivo)` apunta a
`components/analytics/` y por eso los dos paneles heredados eran inalcanzables
incluso si se los nombraba.

El test MUST fallar si el conjunto descubierto tiene menos archivos que los
conocidos al momento de escribir esta spec (7), para que un patrón de búsqueda
roto no produzca una suite vacía en verde.

Las reglas ya vigentes (sin hex de cromo, consumo de `@/lib/chart-theme`, las
tres props si se estila el tooltip por defecto, sin grises de Tailwind huérfanos,
sin borde fijo dentro de un string CSS) MUST aplicarse **sin cambios** al
conjunto descubierto — esta fase amplía la cobertura, no relaja los criterios.

#### Scenario: Los dos paneles heredados quedan dentro del conjunto

- GIVEN el test convertido a descubrimiento
- WHEN se enumera el conjunto de archivos que verifica
- THEN incluye `MagnitudeTimeChart.tsx` y `DepthDistributionChart.tsx` de `dashboard/components/`
- AND sigue incluyendo los cinco paneles de `dashboard/components/analytics/`

#### Scenario: Un panel nuevo queda cubierto sin tocar el test

- GIVEN un panel de analytics nuevo que importa `recharts` en cualquiera de los dos directorios
- WHEN se corre la suite sin modificar `chart-chrome.test.ts`
- THEN el panel nuevo aparece en el conjunto verificado
- AND si ese panel hardcodea un hex de cromo, el test falla

#### Scenario: Un descubrimiento vacío o incompleto no pasa

- GIVEN el criterio de descubrimiento alterado de modo que devuelva menos archivos de los conocidos
- WHEN se corre la suite
- THEN el test falla por no alcanzar el piso, en vez de reportar cero fallos sobre cero archivos

#### Scenario: El descubrimiento no arrastra archivos que no son paneles

- GIVEN el conjunto descubierto
- WHEN se lo compara con la lista de archivos que hoy importan `recharts`
- THEN coincide exactamente, sin archivos de test y sin componentes que no dibujan gráficos

---

### Requirement: Verificación por mutación documentada para toda la fase

Cada test creado o modificado en esta fase MUST demostrarse capaz de fallar. La
demostración MUST hacerse introduciendo en el código el defecto real que el test
dice prevenir, corriendo la suite, observando el rojo, y revirtiendo.

Como mínimo MUST demostrarse:

1. Un hex de cromo a mano en `MagnitudeTimeChart.tsx` hace fallar tanto su test
   propio como `chart-chrome.test.ts`.
2. Un hex de cromo a mano en `DepthDistributionChart.tsx` hace fallar tanto su
   test propio como `chart-chrome.test.ts`.
3. Quitar `itemStyle` de `DepthDistributionChart.tsx` hace fallar la regla de las
   tres props.
4. Restringir el descubrimiento a un solo directorio hace fallar el piso de
   archivos.

Antes de dar por válida una mutación, MUST verificarse que la mutación
**efectivamente modificó el archivo** (`git diff --stat` no vacío): una mutación
que no muta no prueba nada. El resultado de las cuatro mutaciones MUST quedar
escrito en el registro de la fase.

#### Scenario: Una mutación que no cambió el archivo se descarta

- GIVEN una mutación aplicada con una herramienta de reemplazo
- WHEN `git diff --stat` no muestra cambios en el archivo objetivo
- THEN la mutación se considera inválida y el verde resultante no cuenta como evidencia

#### Scenario: Las cuatro mutaciones producen rojo

- GIVEN la suite del dashboard en verde
- WHEN se aplica cada una de las cuatro mutaciones listadas, de a una
- THEN en cada caso falla al menos el test indicado
- AND al revertir, la suite vuelve a verde

---

### Requirement: La fase entrega instrucciones de QA visual al usuario

El contraste real de `hsl(var(--token))` **no** es verificable por unit test:
jsdom no resuelve la cascada ni hace layout. Por eso la fase MUST entregar al
usuario, al cerrarse, la URL exacta y la lista concreta de qué mirar.

La entrega MUST incluir: la URL `/analytics` del entorno donde se probó, la
instrucción de mirar los dos paneles heredados (magnitud vs tiempo y
distribución de profundidades) en tema **claro y oscuro**, y los cuatro puntos a
confirmar: (1) la grilla se distingue del fondo sin dominarlo, (2) los rótulos de
los ejes se leen, (3) el tooltip de profundidades muestra etiqueta **y** filas
legibles sobre su fondo, (4) los colores de magnitud y de profundidad siguen
siendo los de siempre.

#### Scenario: El cierre de la fase entrega URL y checklist

- GIVEN la fase implementada y con la suite en verde
- WHEN se reporta al usuario
- THEN el reporte contiene la URL exacta y los cuatro puntos a mirar en ambos temas
- AND no se declara la fase terminada apoyándose solo en los unit tests

---

## MODIFIED Requirements

Ninguno. Esta fase no cambia comportamiento observable de producto: los dos
paneles siguen mostrando exactamente los mismos datos, con la misma
transformación y la misma escala de colores de dato. Lo único que cambia es de
dónde sale el color del cromo.

## REMOVED Requirements

Ninguno.

---

## Fuera de alcance de esta fase (explícito)

- **Todo el backend.** `src/services/station_uptime.py`, `src/services/tremor.py`
  y `src/models/analytics.py` MUST quedar con `git diff` vacío. La invariante de
  tres casos de `_ratio()` es correcta y está blindada por tests; tocarla es una
  regresión.
- **Las fases 2 a 5**: lib de reglas de advertencia, glosario, prosa
  interpretativa, `<Cell>` por ratio en uptime, distinción visual `null` vs `0.0`,
  leyenda de la tira de cuadraditos, recorte del ranking, ordenamiento de
  `EventsTable`. Nada de eso entra acá.
- **Claves i18n nuevas.**
- **Layout, grillas, tipografía y estructura de tabs de `/analytics`.**
- **La escala semántica de magnitud y de profundidad**: no se mueve a
  `chart-theme.ts`. Está afuera a propósito.
- **El molde original arreglado "de paso" en otros archivos**: si aparece otro
  componente con cromo fijo que no importa `recharts`, queda para su propio
  change; el criterio de descubrimiento de esta fase es explícitamente "paneles
  de gráfico".
- **El favicon del sitio.**
