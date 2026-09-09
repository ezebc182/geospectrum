# Tasks — Fase 1: deuda de tematización de los dos paneles heredados

Change: `analytics-redesign`, **Fase 1 solamente** (`proposal.md:158`).
Spec fuente: `openspec/changes/analytics-redesign/specs/dashboard-ui/spec-fase-1-tematizacion.md`
(6 requirements, 19 escenarios). Las fases 2-5 **no** se tocan acá.

**No se corrió `sdd-design`** porque la única decisión técnica con margen era el
mecanismo de descubrimiento de archivos. Está resuelta abajo, con medición.

---

## Decisión técnica cerrada: cómo descubre archivos `chart-chrome.test.ts`

**Elegido: (a) `fs` — `readdirSync` de los dos directorios, filtrando por contenido.
Rutas ancladas con `import.meta.dirname` + `..`, NO con `__dirname`.**

### Por qué NO `import.meta.glob` (alternativa b)

No es una preferencia de estilo: **no existe en este runtime**. Medido con una sonda
real corrida bajo `./node_modules/.bin/vitest` en `components/analytics/`:

```
HAS_GLOB= undefined
```

`import.meta.glob` es una transformación **de build** del plugin de Vite, no una API de
runtime. La config del repo (`dashboard/vitest.config.ts`) define un `defineConfig` pelado
con `esbuild.jsx` + alias + `environment: 'jsdom'`, **sin plugins de Vite**, así que la
transformación nunca se aplica y `import.meta.glob` llega como `undefined`. Un test escrito
sobre eso explota en runtime (o peor: con `?.` silencioso, itera un set vacío). Descartada.

Además `import.meta.glob` devuelve **módulos**, no texto: este test lee el FUENTE con
`readFileSync` a propósito (comentario de `chart-chrome.test.ts:10-13` — las props de cromo se
pierden en los mocks de Recharts, así que assertear el DOM no probaría nada). Traer módulos
sería la herramienta equivocada aunque estuviera disponible; habría que usar el modificador
`as: 'raw'`, que suma otra dependencia del pipeline de build.

### Por qué `readdirSync` y no `fs.globSync`

`fs.globSync` **sí** existe en el Node del repo (`v22.16.0`, verificado: `globSync: function`),
pero en Node 22 sigue marcada como experimental y emite warning. `readdirSync` de dos
directorios explícitos es más simple, sin dependencia de estabilidad de API, y expresa mejor
el criterio: **dos directorios conocidos, archivos `.tsx`, que importen `recharts`, sin tests**.

### Anclaje de rutas: `import.meta.dirname`, no `__dirname`

El riesgo anotado de que `__dirname` no exista en Vitest con ESM **es falso acá** — verificado
con la misma sonda:

```
DIRNAME_TYPE= string  VAL= .../dashboard/components/analytics
IMPORT_META_DIRNAME=  .../dashboard/components/analytics
```

Vite inyecta el shim de `__dirname`, así que funciona. **Aun así se usa `import.meta.dirname`**:
es la forma ESM nativa, no depende del shim de interop CJS de Vite (que puede desaparecer entre
majors), y deja explícito que el archivo es un módulo ESM. El defecto real nunca fue que
`__dirname` no existiera: fue que **apunta al directorio del test** (`components/analytics/`)
mientras los dos paneles heredados viven un nivel arriba (`components/`). El fix es que el test
resuelva **dos raíces explícitas**, `join(import.meta.dirname, '..')` y `import.meta.dirname`,
en vez de asumir que todo panel es vecino suyo.

### Criterio de descubrimiento, literal

```
raíces      = [ <dir del test>/.. , <dir del test> ]        // components/ y components/analytics/
candidatos  = readdirSync(raíz, { withFileTypes: true })    // NO recursivo: son 2 niveles conocidos
              → solo ficheros, extensión .tsx
              → excluir los que terminen en .test.tsx
filtro      = el contenido del archivo matchea /from 'recharts'/
piso        = el conjunto resultante MUST tener >= 7 archivos
```

Medido hoy con `rg -l "from 'recharts'" dashboard/components/`: exactamente 7 archivos
(`MagnitudeTimeChart.tsx`, `DepthDistributionChart.tsx` en `components/`;
`RsamTrendChart.tsx`, `StationUptimeChart.tsx`, `BValueChart.tsx`, `TremorPanel.tsx`,
`DepthSectionChart.tsx` en `components/analytics/`). El criterio da el conjunto exacto,
sin arrastrar basura (riesgo de `proposal.md:201` cerrado por medición).

---

## Preflight (una vez, antes de tocar nada)

Node del shell es v12. En **cada** shell de esta fase:

```
export PATH="$HOME/.nvm/versions/node/v22.16.0/bin:$PATH"
```

Correr siempre `./node_modules/.bin/vitest` desde `dashboard/`. **NUNCA `npx`** (baja un
vitest ajeno de internet). **NUNCA `next build`** (comparte `.next` con el server de dev y lo rompe).

---

## Phase 1: Migración del cromo (código de producción)

- [x] **1.1** Migrar el cromo de `dashboard/components/MagnitudeTimeChart.tsx`: importar
  `CHART_GRID_STROKE` y `CHART_AXIS_STROKE` de `@/lib/chart-theme`; reemplazar
  `stroke="#374151"` (L50, `CartesianGrid`) por `stroke={CHART_GRID_STROKE}` y los dos
  `stroke="#9ca3af"` (L59 `XAxis`, L66 `YAxis`) por `stroke={CHART_AXIS_STROKE}`.
  **NO tocar** `ReferenceLine stroke="#ef4444"` / `"#f59e0b"` (L83-84) ni `Cell fill={entry.color}` (L87).
  **NO agregar** `contentStyle`/`labelStyle`/`itemStyle`: este panel tiene `content` propio
  (L68-82) y pasarle esas props sería código muerto que además rompe la regla del test.
  - *Aceptación*: `rg 'stroke=\{?"?#' dashboard/components/MagnitudeTimeChart.tsx` devuelve
    solo las dos `ReferenceLine`. El archivo contiene `from '@/lib/chart-theme'`.
    `rg 'contentStyle|labelStyle|itemStyle' dashboard/components/MagnitudeTimeChart.tsx` → 0 matches.
  - *Spec*: Requirement "Cromo tematizado en `MagnitudeTimeChart`", escenarios 1, 2 y 4.

- [x] **1.2** Tematizar el markup del tooltip propio de `MagnitudeTimeChart.tsx` (L72-79):
  `border-gray-700 bg-gray-900 text-white` → `border-border bg-popover text-popover-foreground`;
  `text-gray-400` (L78) → `text-muted-foreground`. Los cuatro tokens existen en
  `tailwind.config` (verificado por el agente de spec).
  - *Aceptación*: el archivo no contiene ningún `text-gray-*` / `bg-gray-*` / `border-gray-*`
    **dentro de un `className`** sin pareja `dark:`. Regla exacta ya implementada en
    `chart-chrome.test.ts:104-121`; se satisface cuando el archivo entra al descubrimiento (tarea 2.1).
  - *Nota*: el `<h3>` usa `text-gray-900 dark:text-white` — **tiene** pareja `dark:`, la regla
    del test lo acepta y queda como está. No se toca: fuera de alcance de esta fase.
  - *Spec*: Decisión 3; escenario "El tooltip propio no queda gris sobre gris en un tema".

- [x] **1.3** Migrar el cromo de `dashboard/components/DepthDistributionChart.tsx`: importar
  las cinco constantes necesarias de `@/lib/chart-theme`; `stroke="#374151"` (L41) →
  `{CHART_GRID_STROKE}`; los dos `stroke="#9ca3af"` (L42-43) → `{CHART_AXIS_STROKE}`.
  Reemplazar el `contentStyle` inline (L45, `backgroundColor: '#1f2937'`, `border: 'none'`,
  `borderRadius: '8px'`) por `contentStyle={CHART_TOOLTIP_CONTENT_STYLE}`, el
  `labelStyle={{ color: '#fff' }}` (L46) por `labelStyle={CHART_TOOLTIP_LABEL_STYLE}`, y
  **agregar** `itemStyle={CHART_TOOLTIP_ITEM_STYLE}` (hoy ausente: sin él Recharts pinta cada
  fila con el color de su serie).
  El `border: 'none'` desaparece — el borde tematizado ya viene en `CHART_TOOLTIP_CONTENT_STYLE`;
  el `borderRadius: '8px'` tampoco se repite a mano, sale de la misma constante (`0.5rem`).
  **NO tocar** los cuatro `color` de los bins (L21-24): son la escala de profundidad.
  - *Aceptación*: `rg '#[0-9a-fA-F]{3,8}' dashboard/components/DepthDistributionChart.tsx`
    devuelve **solo** los cuatro hex de los bins (`#ef4444`, `#f59e0b`, `#3b82f6`, `#8b5cf6`).
    Las tres props del tooltip apuntan a las constantes, no a objetos inline.
  - *Spec*: Requirement "Cromo tematizado en `DepthDistributionChart`", escenarios 1, 2 y 3.

---

## Phase 2: Red de seguridad — `chart-chrome.test.ts` de whitelist a descubrimiento

Va **después** de la Fase 1 a propósito: si se convierte el test primero, queda rojo por los dos
paneles sin migrar y no se puede distinguir "rojo porque descubre bien" de "rojo por otra cosa".
La verificación de que el descubrimiento realmente atrapa está en la mutación 4.1/4.2, no en el orden.

- [x] **2.1** Reescribir el mecanismo de selección de `dashboard/components/analytics/chart-chrome.test.ts`:
  borrar el array `PANELES` (L25-31) y la función `fuente()` (L38-40), y reemplazarlos por el
  descubrimiento decidido arriba. Concretamente:
  - dos raíces: `const ANALYTICS_DIR = import.meta.dirname` y
    `const COMPONENTS_DIR = join(import.meta.dirname, '..')`;
  - `readdirSync(dir, { withFileTypes: true })` en cada una, quedarse con `isFile()`,
    `.endsWith('.tsx')` y `!.endsWith('.test.tsx')`;
  - leer cada candidato con `readFileSync(..., 'utf8')` y quedarse con los que matcheen
    `/from 'recharts'/`;
  - el resultado es una lista de **pares `[etiqueta, rutaAbsoluta]`** — la etiqueta lleva el
    directorio (p. ej. `analytics/BValueChart.tsx` vs `MagnitudeTimeChart.tsx`) para que el
    nombre del caso `it.each` sea inequívoco cuando dos directorios tengan homónimos;
  - `fuente()` pasa a recibir la ruta absoluta ya resuelta (deja de hacer `join(__dirname, ...)`).
  - *Aceptación*: los cinco `it.each(PANELES)` y el `for (const archivo of PANELES)` (L123)
    pasan a iterar el conjunto descubierto **sin ninguna lista literal de nombres de panel**
    en el archivo. `rg "RsamTrendChart|BValueChart" dashboard/components/analytics/chart-chrome.test.ts`
    → 0 matches (salvo dentro de comentarios explicativos).
  - *Aceptación*: la suite queda verde con `./node_modules/.bin/vitest run components/analytics/chart-chrome.test.ts`.
  - *Spec*: Requirement "`chart-chrome.test.ts` cubre por descubrimiento, no por whitelist",
    escenarios 1, 2 y 4.

- [x] **2.2** Agregar al mismo archivo el **test de piso**: un `it` que assertee que el conjunto
  descubierto tiene **al menos 7** archivos, con la constante `PISO_CONOCIDO = 7` y un comentario
  en español que explique por qué existe (un patrón roto que devuelve `[]` dejaría la suite en
  verde con cero paneles cubiertos — el modo de fallo exacto que esta fase viene a cerrar).
  El mensaje de fallo debe listar los archivos efectivamente descubiertos, para que el rojo diga
  qué falta y no solo un número.
  - *Aceptación*: el `it` existe y pasa con los 7 archivos actuales.
  - *Aceptación (mutación 4.4)*: restringir el descubrimiento a un solo directorio hace fallar
    **este** test, no solo los otros.
  - *Spec*: Decisión 5; escenario "Un descubrimiento vacío o incompleto no pasa".

- [x] **2.3** Actualizar el comentario de cabecera del archivo (L1-18): hoy dice "paneles de
  /analytics (Fase 5)" y describe una whitelist que ya no existe. Debe describir el criterio de
  descubrimiento real (dos directorios, `.tsx`, importa `recharts`, sin tests) y el piso.
  Comentario en español, identificadores en inglés — convención del repo.
  - *Aceptación*: leer el comentario y el código y que digan lo mismo. Es la misma clase de
    comment rot que el proposal denuncia en `StationUptimeChart.tsx:45`; no se reintroduce acá.

---

## Phase 3: Tests propios de los dos paneles heredados

Patrón obligatorio: `dashboard/components/analytics/DepthSectionChart.test.tsx` — mockear
`recharts` con `vi.mock` capturando props en arrays, y assertear **transformación de datos y
props que llegan al gráfico**, nunca el SVG.

**Prohibido explícitamente** (jsdom no hace layout ni resuelve `hsl(var(--token))` contra la
cascada): assertear dimensiones, recortes, visibilidad, o contraste efectivo. Cualquier assert
de esos sería verde falso.

- [x] **3.1** Crear `dashboard/components/MagnitudeTimeChart.test.tsx` cubriendo:
  1. **transformación**: N eventos → N puntos con `timestamp` (epoch ms de `hora_utc`), `mag`,
     `lugar` y `color` = `getMagnitudeColor(ev.mag)`;
  2. **cromo tematizado**: el `stroke` capturado de `CartesianGrid` es `CHART_GRID_STROKE` y el
     de `XAxis`/`YAxis` es `CHART_AXIS_STROKE` — comparando contra la **constante importada**,
     no contra el string literal (si mañana cambia el token, el test sigue siendo correcto);
  3. **dato preservado**: con dos eventos de magnitudes distintas (M2.0 y M6.5), cada `Cell.fill`
     es exactamente `getMagnitudeColor` de su magnitud; las dos `ReferenceLine` conservan
     `#ef4444` (y=5) y `#f59e0b` (y=4);
  4. **degenerado**: lista vacía renderiza sin lanzar, sin afirmar nada sobre dimensiones.
  - *Nota de implementación*: el componente usa `useTranslations`/`useFormatter` de `next-intl`;
    envolver con `IntlTestProvider` de `@/lib/test-intl`, igual que `DepthSectionChart.test.tsx`.
  - *Aceptación*: 4 casos verdes. Mutación 4.1 los pone en rojo.
  - *Spec*: Requirement "Test propio para cada uno de los dos paneles heredados", escenarios 1 y 2.

- [x] **3.2** Crear `dashboard/components/DepthDistributionChart.test.tsx` cubriendo:
  1. **binning**: eventos repartidos en los cuatro rangos (`<70`, `70-150`, `150-300`, `>300`)
     producen los `count` correctos, y el orden de los bins coincide con los cortes de
     `getDepthColor` (`dashboard/lib/utils.ts:64`);
  2. **cromo tematizado**: `stroke` de grilla y ejes contra las constantes importadas;
  3. **las tres props del tooltip**: las props capturadas de `Tooltip` incluyen `contentStyle`,
     `labelStyle` e `itemStyle`, y son **exactamente** las constantes del tema (identidad
     referencial, `toBe`, no `toEqual` con un objeto a mano — así una copia inline con los
     mismos valores no pasa);
  4. **dato preservado**: los cuatro `Cell.fill` conservan sus hex de bin;
  5. **degenerado — `prof_km` nulo**: un evento con `prof_km` nulo **no** incrementa el `count`
     de ninguno de los cuatro bins;
  6. **degenerado — lista vacía**: renderiza sin lanzar, los cuatro bins en `count: 0`.
  - *Trampa conocida a cubrir en el caso 5*: el componente filtra con `if (ev.prof_km)`, que es
    truthiness — un evento con `prof_km: 0` **también** se descarta hoy. El test debe **documentar
    el comportamiento actual tal cual es**, no arreglarlo: cambiar el binning es comportamiento
    de producto y esta fase declara "MODIFIED Requirements: Ninguno" (spec L289-294). Si el
    usuario quiere que `0 km` cuente, es otro change.
  - *Aceptación*: 6 casos verdes. Mutación 4.2 y 4.3 los ponen en rojo.
  - *Spec*: escenarios "Un evento sin profundidad no entra en ningún bin", "Los colores de
    profundidad no se tematizan", "Sin `itemStyle` las filas heredarían el color de la serie".

- [x] **3.3** Correr la suite completa del dashboard y confirmar que no hay regresión en los
  otros 5 paneles ni en el resto:
  `export PATH="$HOME/.nvm/versions/node/v22.16.0/bin:$PATH" && cd dashboard && ./node_modules/.bin/vitest run`
  - *Aceptación*: 0 fallos. Anotar el total de tests antes y después (debe subir en ~11:
    4 de 3.1 + 6 de 3.2 + 1 del piso de 2.2, más los casos extra que `it.each` genera al pasar
    de 5 a 7 archivos en `chart-chrome.test.ts`).

---

## Phase 4: Verificación por mutación (las cuatro obligatorias de la spec)

Estándar del repo, y acá es especialmente necesario: `chart-chrome.test.ts` **está verde hoy y
no protege nada de lo que dice proteger**. Un test que no se demostró capaz de fallar no es evidencia.

**Protocolo obligatorio para CADA mutación** (no negociable):

1. Aplicar la mutación. Si se usa `sd`: **`sd -s` con `\n` en el patrón no matchea y sale exit 0**,
   dejando el archivo intacto; y `sd` **sin** `-s` interpreta los paréntesis como regex. Preferir
   `Edit` sobre `sd` para estas mutaciones — son cambios de una línea.
2. **`git diff --stat` ANTES de correr los tests.** Si no muestra el archivo modificado, la
   mutación **no se aplicó**: el verde resultante es basura y no cuenta como evidencia.
3. Correr la suite (`./node_modules/.bin/vitest run`, con el PATH de nvm exportado).
4. Observar el **rojo** y anotar **qué test exacto falló** (nombre del `it`, no "falló la suite").
5. Revertir (`git checkout -- <archivo>`), volver a correr, confirmar verde.

- [x] **4.1** **Mutación 1** — hex de cromo en `MagnitudeTimeChart.tsx`: cambiar
  `stroke={CHART_GRID_STROKE}` por `stroke="#374151"` en el `CartesianGrid`.
  - *Aceptación*: falla **`MagnitudeTimeChart.test.tsx`** (el assert de cromo de 3.1.2) **Y**
    falla **`chart-chrome.test.ts`** (regla "no hardcodea hex" **y** regla "consume los tokens
    compartidos", esta última solo si el import queda sin usar — anotar cuál de las dos disparó).
    Los dos rojos son obligatorios: es lo que prueba que el descubrimiento alcanzó el archivo.
  - *Resultado (2026-09-09)*: los dos rojos, **pero** de `chart-chrome.test.ts` disparó **solo**
    "no hardcodea hex". La regla "consume los tokens compartidos" quedó verde porque el import
    sigue en uso (los dos ejes usan `CHART_AXIS_STROKE`, misma sentencia de import). Detalle en
    `mutation-log.md`.
  - *Spec*: Requirement "Verificación por mutación documentada", punto 1.

- [x] **4.2** **Mutación 2** — hex de cromo en `DepthDistributionChart.tsx`: cambiar
  `stroke={CHART_AXIS_STROKE}` del `XAxis` por `stroke="#9ca3af"`.
  - *Aceptación*: falla `DepthDistributionChart.test.tsx` **Y** `chart-chrome.test.ts`.
  - *Spec*: punto 2.

- [x] **4.3** **Mutación 3** — quitar `itemStyle={CHART_TOOLTIP_ITEM_STYLE}` de la `<Tooltip>` de
  `DepthDistributionChart.tsx`, dejando `contentStyle` y `labelStyle`.
  - *Aceptación*: falla el caso "usa las tres props si estila el tooltip por defecto" de
    `chart-chrome.test.ts` **Y** el caso 3 de `DepthDistributionChart.test.tsx`.
  - *Spec*: punto 3.

- [x] **4.4** **Mutación 4** — restringir el descubrimiento de `chart-chrome.test.ts` a un solo
  directorio: comentar la raíz `COMPONENTS_DIR` para que solo escanee `components/analytics/`
  (5 archivos, por debajo del piso de 7).
  - *Aceptación*: falla el test de piso de la tarea 2.2, **por no alcanzar los 7**, no por
    reportar cero fallos sobre cero archivos. El mensaje de error debe listar los 5 encontrados.
  - *Spec*: punto 4; escenario "Un descubrimiento vacío o incompleto no pasa".

- [x] **4.5** Dejar el resultado de las cuatro mutaciones **escrito** en el cuerpo del PR: una
  tabla `mutación → archivo tocado → `git diff --stat` no vacío (sí/no) → test(s) que fallaron →
  verde al revertir`. La spec lo exige explícitamente ("el resultado de las cuatro mutaciones
  MUST quedar escrito en el registro de la fase").
  - *Hecho (2026-09-09)*: la tabla vive en
    `openspec/changes/analytics-redesign/mutation-log.md`, misma convención que los demás
    changes del repo. Copiarla al cuerpo del PR cuando se abra.

---

## Phase 5: Cierre — invariantes, commit y QA visual del usuario

- [ ] **5.1** Verificar que el **backend quedó intacto**:
  `git diff --stat src/services/station_uptime.py src/services/tremor.py src/models/analytics.py`
  - *Aceptación*: salida **vacía**. Es un criterio de éxito literal del proposal (L281-282) y el
    riesgo #1 del change. Si hay una sola línea ahí, la fase no cierra.
  - *Aceptación*: `git diff --name-only` en total toca **exactamente** 5 archivos:
    `MagnitudeTimeChart.tsx`, `DepthDistributionChart.tsx`, `chart-chrome.test.ts`, y los dos
    `.test.tsx` nuevos. Nada de `messages/*.json` (Decisión 7: sin claves i18n en esta fase),
    nada de `analytics/page.tsx`, nada de layout.

- [ ] **5.2** Commit con conventional commits, mensaje en español, **sin ninguna atribución de IA**
  (ni `Co-Authored-By`, ni "Generated with Claude Code"). Sugerido:
  `fix(analytics): tematizar el cromo de los dos paneles heredados y cerrar el hueco de cobertura`
  con cuerpo que explique el descubrimiento por archivo y el piso de 7.
  - *Recordatorio*: **no buildear** después de los cambios (regla del usuario; y `next build`
    rompe el server de dev).

- [ ] **5.3** Redactar y entregar al usuario el **paquete de QA visual** — la fase NO se declara
  terminada apoyándose solo en los unit tests, porque jsdom no resuelve `hsl(var(--token))` ni
  hace layout. El reporte debe contener:
  - **URL exacta**: `/analytics` del entorno donde se probó (prod, por convención del proyecto:
    no se levanta el stack local). Dar la URL completa, no la ruta suelta.
  - **Qué paneles**: "Magnitud vs tiempo" (scatter) y "Distribución de profundidades" (barras),
    ambos en la pestaña donde hoy los renderiza `analytics/page.tsx:122` y `:126`.
  - **En los dos temas**: claro y oscuro (alternar con el toggle de tema del header).
  - **Los cuatro puntos a confirmar** (literal de la spec, Requirement de QA visual):
    1. la grilla se distingue del fondo sin dominarlo;
    2. los rótulos de los ejes se leen;
    3. el tooltip de profundidades (hover sobre una barra) muestra la **etiqueta** y las **filas**
       legibles sobre su fondo — es el defecto exacto que arregla `itemStyle`;
    4. los colores de magnitud (puntos) y de profundidad (barras) siguen siendo **los de siempre**:
       si alguno cambió, se rompió la escala semántica y hay que revertir.
  - **Un quinto punto propio del tooltip del scatter**: hover sobre un punto del gráfico de
    magnitud vs tiempo — el nombre del lugar (antes `text-gray-400`) tiene que leerse en **claro**,
    que es donde ese gris daba 2,54:1 y fallaba AA.
  - *Aceptación*: el reporte se entrega con URL y los cinco puntos. La fase queda **pendiente de
    confirmación del usuario**, no cerrada por decisión propia.

---

## Resumen

| Fase | Tareas | Foco |
|------|--------|------|
| 1 | 3 | Migración del cromo (producción) |
| 2 | 3 | `chart-chrome.test.ts`: whitelist → descubrimiento + piso |
| 3 | 3 | Tests propios de los dos paneles + suite completa |
| 4 | 5 | Verificación por mutación (4 obligatorias + registro) |
| 5 | 3 | Invariantes del backend, commit, QA visual del usuario |
| **Total** | **17** | |

### Orden y por qué

Producción antes que test de descubrimiento (Fase 1 → 2) para que el rojo, si aparece, tenga una
sola causa posible. Tests propios después del descubrimiento (3) para que ambas redes existan
antes de mutarlas. Mutación al final del código (4) porque es la ÚNICA evidencia de que los tests
sirven — en este archivo ya falló una vez. QA visual último (5) porque es lo único que puede ver
el contraste real, y lo hace el usuario.
