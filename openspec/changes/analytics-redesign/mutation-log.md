# Mutation log: analytics-redesign — Fase 1 (tematización)

## Baseline (2026-09-09, ANTES de mutar)

Rama `chore/pendientes-sesion-anterior`, árbol limpio, HEAD `48a106b`
(`docs(analytics): spec y tareas de la Fase 1 del rediseno`). Grupos 1-3 de
`tasks-fase-1-tematizacion.md` ya aplicados y commiteados.

Comando (Node v22.16.0 de nvm, `dashboard/`):
`export PATH="$HOME/.nvm/versions/node/v22.16.0/bin:$PATH" && ./node_modules/.bin/vitest run`

```
Test Files  124 passed (124)
     Tests  1362 passed (1362)
```

Ese verde **no era evidencia de nada** hasta esta fase: `chart-chrome.test.ts`
estuvo verde una fase entera protegiendo cero de los dos paneles heredados.
Lo que sigue es la evidencia.

## Protocolo aplicado a cada mutación

1. Mutar con `Edit` (no `sd`: `sd -s` con `\n` en el patrón no matchea y sale
   exit 0 dejando el archivo intacto; `sd` sin `-s` come los paréntesis como
   regex).
2. `git diff --stat` **antes** de correr los tests. Sin archivo listado, la
   mutación no se aplicó y el resultado es basura.
3. `./node_modules/.bin/vitest run <archivos>` con el PATH de nvm exportado.
   Nunca `npx`, nunca `next build`.
4. Anotar el `it` exacto y el mensaje.
5. `git checkout -- <archivo>` + `git status --porcelain` vacío.

## Tabla de mutaciones

| # | Archivo | Mutación | `git diff --stat` | Test(s) rojo(s) | Revertido |
|---|---------|----------|-------------------|-----------------|-----------|
| 4.1 | `dashboard/components/MagnitudeTimeChart.tsx` | `<CartesianGrid ... stroke={CHART_GRID_STROKE}>` → `stroke="#374151"` | `1 file changed, 1 insertion(+), 1 deletion(-)` ✅ | **2 rojos.** (a) `MagnitudeTimeChart.test.tsx > el cromo del gráfico sale de los tokens del tema, no de hex fijos` → `AssertionError: expected '#374151' to be 'hsl(var(--border))'` (línea 127, `expect(gridProps[0].stroke).toBe(CHART_GRID_STROKE)`). (b) `chart-chrome.test.ts > MagnitudeTimeChart.tsx no hardcodea hex en grilla, ejes ni tooltip` → `expected [ 'stroke="#374151"' ] to deeply equal []` | `git status --porcelain` vacío ✅ |
| 4.2 | `dashboard/components/DepthDistributionChart.tsx` | `<XAxis dataKey="name" stroke={CHART_AXIS_STROKE}>` → `stroke="#9ca3af"` | `1 file changed, 1 insertion(+), 1 deletion(-)` ✅ | **2 rojos.** (a) `DepthDistributionChart.test.tsx > el cromo del gráfico sale de los tokens del tema, no de hex fijos` → `expected '#9ca3af' to be 'hsl(var(--muted-foreground))'` (línea 130). (b) `chart-chrome.test.ts > DepthDistributionChart.tsx no hardcodea hex en grilla, ejes ni tooltip` → `expected [ 'stroke="#9ca3af"' ] to deeply equal []` | `git status --porcelain` vacío ✅ |
| 4.3 | `dashboard/components/DepthDistributionChart.tsx` | quitar `itemStyle={CHART_TOOLTIP_ITEM_STYLE}` de la `<Tooltip>` (quedan `contentStyle` y `labelStyle`) | `1 file changed, 1 deletion(-)` ✅ | **2 rojos.** (a) `chart-chrome.test.ts > DepthDistributionChart.tsx usa las tres props si estila el tooltip por defecto` → `DepthDistributionChart.tsx estila el contenedor del tooltip pero no las filas: expected '...' to match /itemStyle=\{CHART_TOOLTIP_ITEM_STYLE\}/`. (b) `DepthDistributionChart.test.tsx > pasa las tres props del tooltip apuntando a las constantes del tema` → `sin itemStyle cada fila hereda el color de la serie: expected undefined to be { Object (color) }` | `git status --porcelain` vacío ✅ |
| 4.4 | `dashboard/components/analytics/chart-chrome.test.ts` | comentar la raíz `['', COMPONENTS_DIR]` en `descubrirPaneles()` (queda solo `components/analytics/`) | `1 file changed, 1 insertion(+), 1 deletion(-)` ✅ | **1 rojo, el correcto.** `chart-chrome.test.ts > descubre al menos los paneles conocidos` → `el descubrimiento devolvió 5 archivos (piso 7). Encontrados: analytics/BValueChart.tsx, analytics/DepthSectionChart.tsx, analytics/RsamTrendChart.tsx, analytics/StationUptimeChart.tsx, analytics/TremorPanel.tsx: expected 5 to be greater than or equal to 7`. Falla por **no alcanzar el piso**, no por reportar cero fallos sobre cero archivos, y el mensaje **lista los 5** encontrados, como exigía la tarea 2.2 | `git status --porcelain` vacío ✅ |

**Ninguna mutación quedó en verde.** Las cuatro hicieron fallar exactamente lo
que dicen proteger.

## Desvío respecto de la predicción del plan (4.1)

La tarea 4.1 predecía que la mutación de `MagnitudeTimeChart` podía disparar
**dos** reglas de `chart-chrome.test.ts`: "no hardcodea hex" **y** "consume los
tokens compartidos", esta última "solo si el import queda sin usar".

**Disparó solo "no hardcodea hex".** La regla "consume los tokens compartidos"
quedó VERDE, y es lo correcto: el archivo importa `CHART_AXIS_STROKE` y
`CHART_GRID_STROKE` en la misma sentencia (`MagnitudeTimeChart.tsx:8`), y los
dos ejes siguen usando `CHART_AXIS_STROKE`, así que la línea
`from '@/lib/chart-theme'` sigue presente y el regex de esa regla matchea.

No es un hueco de cobertura: la regla de import es una red de segundo orden
(atrapa un panel que jamás importó el tema), no un detector de hex — para eso
está la primera regla, que sí disparó. El "Y falla `chart-chrome.test.ts`" del
criterio de aceptación **se cumple**: el descubrimiento alcanzó el archivo de
`components/` (imposible con la whitelist anterior), que es lo que la mutación
venía a probar.

## Verde al revertir (2026-09-09)

Suite completa, árbol restaurado:

```
Test Files  124 passed (124)
     Tests  1362 passed (1362)
  Duration  22.70s
```

`git status --porcelain` limpio salvo este archivo nuevo.

---

# Fase 2 (fundaciones de interpretación) — BLOQUE A

## Baseline (2026-09-12, ANTES de mutar)

Rama `feat/analytics-redesign-fase2`, base `41e7f5b` (Fase 1 mergeada).

**El baseline de "1362 verdes" de la Fase 1 estaba mal leído.** La suite de
`main` en `41e7f5b` corre así:

```
Test Files  1 failed | 123 passed (124)
     Tests  14 failed | 1362 passed (1376)
```

Son **1376 tests, de los cuales 14 están EN ROJO en `main`**, todos en
`components/analytics/chart-chrome.test.ts`. El "1362" del log de la Fase 1 era
el conteo de VERDES, no el total: los 14 rojos existían y no se registraron.

**Causa, diagnosticada (no es de esta fase):** el archivo tiene **bloques
`it.each` DUPLICADOS**. Las copias de las líneas 201 y 222 repiten las de 151 y
172 pero con la firma VIEJA de un solo argumento — `(archivo)` en vez de
`(archivo, ruta)` — y llaman `fuente(archivo)`, es decir le pasan la ETIQUETA
(`analytics/BValueChart.tsx`) a `readFileSync` en lugar de la ruta absoluta. De
ahí los 14 `ENOENT: no such file or directory`. Es residuo del squash de la
Fase 1 (PR #56).

**No se arregla acá**: la tarea 10.2 de esta fase exige `git diff` VACÍO en
`chart-chrome.test.ts`. Arreglarlo es un fix aparte, de una línea por bloque
(borrar los dos bloques duplicados), y queda anotado como pendiente.

Comando (Node v22.16.0 de nvm, desde `dashboard/`):
`export PATH="$HOME/.nvm/versions/node/v22.16.0/bin:$PATH" && ./node_modules/.bin/vitest run`

## Protocolo aplicado

Idéntico al de la Fase 1, con **una corrección aprendida en el camino**:

0. **Commitear el estado VERDE antes de mutar.** Sobre un archivo NUEVO sin
   trackear, `git diff --stat` sale VACÍO aunque la mutación se haya aplicado:
   el chequeo de "diff no vacío" es CIEGO ahí y `git checkout --` tampoco
   revierte. Las dos primeras mutaciones se re-corrieron después de commitear.
1. Mutar con `Edit` (nunca `sd` con `\n` en el patrón).
2. `git diff --stat` **no vacío** antes de correr.
3. `./node_modules/.bin/vitest run <archivos>` con el PATH de nvm.
4. Anotar el `it` exacto y el mensaje.
5. `git checkout -- <archivo>` + `git status --porcelain` limpio.

## Tabla de mutaciones — BLOQUE A (14)

| # | Archivo | Mutación | `git diff --stat` | Test(s) rojo(s) | Revertido |
|---|---------|----------|-------------------|-----------------|-----------|
| 1.3 | `lib/analytics-warnings.ts` | `NORMAL_95_FACTOR = 1.96` → `2` | 1 insert/1 delete ✅ | **2 rojos.** (a) `constantes de la lib de advertencias > los cinco umbrales tienen el valor que fija la spec` → `expected 2 to be 1.96`. (b) `derivedBInterval > deriva b ± 1.96σ…` → `expected 0.8 to be close to 0.804`. El caso "el cálculo sale de la constante" quedó VERDE **a propósito**: compara contra la constante importada, así que muta con ella — es el que prueba que el código la USA, no su valor | ✅ |
| 2.3 | `lib/analytics-warnings.ts` | `mc_at_catalog_floor === true` → `=== false` | 1/1 ✅ | **6 rojos**, encabezados por `mc_at_catalog_floor true emite critical…` → `expected undefined to be defined`; también cayeron el caso sano, el de array vacío, el de `status insufficient`, el de orden y el de "critical es escaso" | ✅ |
| 2.4 | `lib/analytics-warnings.ts` | `severity: 'critical'` → `'warning'` en `mc-at-catalog-floor` | 1/1 ✅ | **3 rojos, los dos obligatorios incluidos.** (a) `mc_at_catalog_floor true emite critical…` → `expected 'warning' to be 'critical'`. (b) `critical es escaso: mc-at-catalog-floor es la ÚNICA regla que puede emitirlo` → `expected [] to deeply equal [ 'b-value.mc-at-catalog-floor' ]`. (c) el de orden | ✅ |
| 2.5 | `lib/analytics-warnings.ts` | `scaleEntries.length > 1` → `> 0` | 1/1 ✅ | **3 rojos**, con el exigido: `una sola escala no advierte` → `expected [ …(2) ] to not include 'b-value.mixed-magnitude-scales'` | ✅ |
| 2.6 | `lib/analytics-warnings.ts` | quitar el `.sort()` por severidad | 1/1 ✅ | **PRIMERA CORRIDA: VERDE.** Ver el desvío documentado abajo. Tras endurecer el test: **1 rojo**, `el orden es por severidad, no por orden de declaración de las reglas` → `expected 3 to be less than 2` | ✅ |
| 3.3 | `lib/analytics-warnings.ts` | `tremor_fraction > TREMOR_BASELINE_MASK_FRACTION` → `> 0.9` | 1/1 ✅ | **1 rojo.** `el corte de median-baseline-masking es estrictamente > 0.5` → `expected undefined to be 'warning'` | ✅ |
| 3.4 | `lib/analytics-warnings.ts` | `>` → `>=` en `median-baseline-masking` | 1/1 ✅ | **1 rojo.** Mismo `it`, otra mitad → `expected [ 'tremor.median-baseline-masking' ] to not include 'tremor.median-baseline-masking'` (el `0.5` exacto empieza a emitir) | ✅ |
| 3.5 | `lib/analytics-warnings.ts` | `baseline_rsam === null` → `!baseline_rsam` | 1/1 ✅ | **1 rojo.** `una línea base en CERO no es "sin dato": no emite no-baseline` → `expected [ 'tremor.no-baseline' ] to not include 'tremor.no-baseline'`. Es la mutación que prueba que `null ≠ 0` está protegido | ✅ |
| 4.3 | `lib/analytics-warnings.ts` | `UPTIME_ATTENTION_THRESHOLD = 0.9` → `0.95` | 1/1 ✅ | **2 rojos.** (a) `los cinco umbrales…` → `expected 0.95 to be 0.9` (el mensaje dice el valor esperado, no "expected true"). (b) `el corte es estrictamente < 0.9` → `expected [] to include 'B'` | ✅ |
| 4.4 | `lib/analytics-warnings.ts` | en `partitionUptimeChannels`, tratar `ratio === null` como `0` | 4 insert/2 delete ✅ | **3 rojos, los dos obligatorios incluidos.** (a) `un canal nunca observado (null) va a un tercer grupo…` → `expected [] to deeply equal [ 'A' ]`. (b) `un null NUNCA suma a channels-below-threshold` → `expected [ 'uptime.channels-below-threshold' ] to not include…`. (c) el de conteos | ✅ |
| 5.3 | `lib/glossary.ts` | borrar `fi: 'fi'` del `Record` (unión intacta) | 1 delete ✅ | **2 rojos, y uno NO es vitest.** (a) `tsc --noEmit` → `lib/glossary.ts(31,14): error TS2741: Property 'fi' is missing in type … but required in type 'Record<GlossaryTermId, string>'` — la única mutación de la fase verificada por el compilador. (b) 3 casos de `glossary.test.ts`, incluido `tiene exactamente 5 términos…` | ✅ |
| 6.3 | `messages/es.json` | agregar `"…esto indica tremor volcanico en curso."` a `warnings.tremor.median-baseline-masking` | 1/1 ✅ | **1 rojo, nombrando clave Y término**, como exigía la tarea: `ninguna clave nueva diagnostica un fenómeno de dominio…` → `es:analytics.warnings.tremor.median-baseline-masking contiene "volcanic"`. Nota: matcheó por `volcanic` (la variante sin tilde de "volcanico"), no por la frase completa — la lista cubre las dos formas | ✅ |
| 6.4 | `messages/en.json` | agregar `An imminent change is expected.` a `glossary.rsam.definition`, **solo en EN** | 1/1 ✅ | **1 rojo.** `en:analytics.glossary.rsam.definition contiene "imminent"`. Es el escenario "El test cubre los dos idiomas" de la spec, que la 2.13 (solo español) no cubría | ✅ |
| 6.5 | `messages/en.json` | renombrar `glossary.uptimeRatio` → `uptimeRatioRenamed` solo en EN | 1/1 ✅ | **2 rojos en `parity.test.ts`, SIN modificarlo.** `toda clave de ES existe en EN` → lista `analytics.glossary.uptimeRatio.term/.definition/.note`; y la dirección inversa lista las `…RatioRenamed` | ✅ |
| 6.6a | `messages/es.json` + `en.json` | agregar una **sexta** entrada (`sigmaB`) en los DOS idiomas | 4+4 inserts ✅ | **1 rojo.** `el set de entradas del JSON coincide con el catálogo TS, en las DOS direcciones` → `hay entradas en es.json que no están en GLOSSARY_MESSAGE_KEYS`. `parity.test.ts` queda VERDE, **y es correcto**: la paridad se cumple, lo que se viola es el corte de cinco | ✅ |
| 6.6b | `messages/es.json` | la misma sexta entrada **en un solo idioma** | 4 inserts ✅ | **2 rojos.** El de arriba **más** `parity.test.ts > toda clave de ES existe en EN` → `analytics.glossary.sigmaB.term, analytics.glossary.sigmaB.definition` | ✅ |

**Ninguna mutación del BLOQUE A quedó en verde** — pero una lo estuvo en su
primera corrida, y esa es la parte que importa del registro.

## Desvío: la mutación 2.6 quedó VERDE y el test hubo que arreglarlo

La tarea 2.6 predecía que quitar el `sort` por severidad haría fallar el caso de
orden, y avisaba: *"si queda verde, el orden lo estaba dando el orden de los
`if` por casualidad y el contrato no está protegido"*.

**Quedó verde.** La causa era el caso de prueba, no el código: disparaba
`mc-at-catalog-floor` (critical), `mixed-magnitude-scales` (warning) y dos
`info`, y en ese conjunto el **orden de declaración de las reglas ya coincide
con el orden por severidad**. El array salía igual con `sort` y sin él.

El arreglo fue elegir un caso donde los dos órdenes **discrepan**:
`unknown-magnitude-type` (`info`) se declara ANTES que `small-sample-above-mc`
(`warning`), así que disparando las dos el `info` saldría primero sin el `sort`.
Con ese caso, la mutación 2.6 pasa a rojo (`expected 3 to be less than 2`).

Es exactamente la lección del repo: **un test verde no prueba nada hasta que una
mutación lo pone en rojo.** Si no se hubiera corrido la mutación, el contrato de
orden determinista habría quedado "cubierto" por un test incapaz de fallar.

## Verde al revertir (2026-09-12)

Suite completa desde `dashboard/`, árbol limpio:

```
Test Files  1 failed | 126 passed (127)
     Tests  14 failed | 1406 passed (1420)
```

**1406 verdes** contra los **1362** de `main`: +44 tests, cero regresiones. Los
14 rojos son los MISMOS 14 de `main` (`chart-chrome.test.ts`, bloques `it.each`
duplicados con la firma vieja), anteriores a esta rama y fuera de su alcance.

`./node_modules/.bin/tsc --noEmit` sin errores.
