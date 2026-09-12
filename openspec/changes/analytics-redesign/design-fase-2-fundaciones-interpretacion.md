# Design — Fase 2: fundaciones de interpretación

Change: `analytics-redesign`, **Fase 2 solamente** (`proposal.md:159`).
Depende de la Fase 1 solo de forma opcional (ya mergeada en `main`, squash `41e7f5b`).

Alcance de esta fase, en una frase: **se construye la maquinaria de interpretación
—lib pura de reglas, tipos, claves i18n del glosario, componente de término y
componente de advertencia— y NO se cablea a ningún panel.** Todo es nuevo y
aditivo. Ningún archivo existente cambia de comportamiento.

El criterio de "terminado" de esta fase es incómodo a propósito: **la suite pasa a
verde con código que nadie consume todavía**. Por eso la verificación por mutación
no es un adorno acá — es lo ÚNICO que distingue una lib correcta de una lib que
nunca se ejecutó.

---

## Decisiones ya cerradas que este design ENCODEA (no reabre)

Vienen del pedido y de la spec; se listan para que ninguna tarea las re-discuta.

| # | Decisión | Consecuencia en este design |
|---|----------|-----------------------------|
| D1 | **Glosario v1 = exactamente 5 términos**: `b-value`, `Mc`, `RSAM`, `FI`, `uptime ratio`. | `sigma_b`, `onset_ratio`, `fi_sign` y `tremor_fraction` **NO** son entradas de glosario: se explican DENTRO del texto de su advertencia. El tipo `GlossaryTermId` es una unión cerrada de 5 literales — agregar un sexto término no compila sin tocar el tipo, que es exactamente la fricción que se busca. |
| D2 | **Umbral de uptime fijo: `ratio < 0.9`**, peores primero, recorte a 10 + "ver todas". 107 canales (medido, no 118). | La Fase 2 aloja **solo la regla**, no el render. La constante y el predicado viven en la lib; el recorte y el "ver todas" son de la Fase 4. |
| D3 | **`b ± 1.96σ` se calcula en la UI** a partir de `sigma_b`, rotulado como intervalo derivado bajo supuesto de normalidad. | La lib expone el cálculo como función pura con el factor `1.96` como constante nombrada. **No** se llama `confidenceInterval` en ningún identificador. |
| D4 | **Backend intocado.** | `src/models/analytics.py`, `src/services/tremor.py` y `src/services/station_uptime.py` con `git diff` vacío al cerrar la fase. Los tipos de entrada de la lib son los de `dashboard/lib/analytics.ts`, importados — no redeclarados. |
| D5 | **La prosa explica la métrica, nunca diagnostica el fenómeno.** | Límite fijado por `src/services/tremor.py:30-32`. Se vuelve verificable: ver Decisión 8. |

---

## Lo que el código dice hoy (verificado 2026-09-11)

| Afirmación | Estado en el código |
|---|---|
| Los metadatos que la lib va a consumir YA están tipados en el frontend | Cierto. `dashboard/lib/analytics.ts`: `mc_at_catalog_floor: boolean` (L61), `mag_type_counts: Record<string, number>` (L64), `n_total`/`n_above_mc`/`min_events` (L55-58), `sigma_b: number` **solo en `BValueOk`** (L76), `baseline_rsam`/`threshold_rsam: number \| null` (L174-176), `tremor_fraction`/`parameters`/`onset_ratio`/`fi_sign`/`band` (L148-178), `overall: Record<string, number \| null>` (L128). **No hay que agregar ni un campo.** |
| `BValueResponse` es unión discriminada por `status` | Cierto (`analytics.ts:85`). `b`, `a` y `sigma_b` existen **solo** en `BValueOk` (L72-77). Una regla que lea `sigma_b` sin narrow por `status` **no compila** — la lib se apoya en eso en vez de defenderse con `?.`. |
| `radix-ui` unificado, v`^1.6.2` | Cierto (`package.json:34`). Hoy solo se importan 2 primitivas: `DropdownMenu` (`components/ui/dropdown-menu.tsx:4`) y `Tabs` (`components/ui/tabs.tsx:4`). |
| **`Popover`, `HoverCard` y `Tooltip` los exporta las TRES el paquete unificado** | Cierto, medido en `node_modules/radix-ui/dist/index.d.ts`: L25-26 `HoverCard`, L37-38 `Popover`, L67-68 `Tooltip`. Ninguna de las tres necesita dependencia nueva. |
| **Ya existe `components/ui/tooltip.tsx` envolviendo `Tooltip` de radix** | Cierto. Es un wrapper shadcn completo (`Provider`/`Root`/`Trigger`/`Content` + `Arrow`), con `z-[1100]` para ganarle al Leaflet (L45) y `bg-foreground`/`text-background` tematizado (L46). **No aparece en el `rg "from 'radix-ui'"` de los componentes de app porque nadie lo consume todavía** — existe y no se usa. |
| No existe `components/ui/popover.tsx` | Cierto: `eza components/ui/` da 15 archivos y popover no está. Habría que crearlo. |
| next-intl v4 con augmentation de tipos desde ES | Cierto. `global.d.ts:9-13` declara `AppConfig.Messages = typeof es`. **Una clave i18n inexistente pasada a `t()` no compila.** |
| `t.rich` se usa en la app | Cierto, 8 call-sites (`EventFiltersBar.tsx:163,171,289`, `InvitationsPanel.tsx:574`, `UsersPanel.tsx:342,550`, `DangerZoneSection.tsx:91`, `invite/[token]/page.tsx:373`). Es una herramienta disponible, no una novedad. |
| Paridad ES/EN verificada por test | Cierto: `messages/parity.test.ts` aplana ambos árboles y exige igualdad en las dos direcciones + ningún valor vacío (L39-58). **Toda clave nueva entra en los DOS archivos o la suite se pone roja sola.** |
| Ya existen claves de analytics donde colgar lo nuevo | Cierto: `messages/en.json` tiene `analytics.uptime` (L723-736), `analytics.bValue` (L737-755) con `mcAtFloor` **ya escrito** (L743), `analytics.tremor` (L756-787). |
| `--warning` y `--destructive` existen en los DOS temas | Cierto: `app/globals.css` L27-28/L35-36 (`:root`) y L74-75/L80-81 (`.dark`), con sus `-foreground`. No hay que inventar tokens. |
| El patrón de lib pura está establecido | Cierto: ~30 pares `lib/X.ts` + `lib/X.test.ts`. El molde más cercano es `lib/uptime-series.ts`: sin React, importa **tipos** de `./analytics`, docstring que declara la invariante que protege (L5-13), funciones chicas y totales. |
| Vitest corre jsdom sin plugins de Vite | Cierto (`vitest.config.ts`): `environment: 'jsdom'`, `globals: true`, alias `@`, `esbuild.jsx: 'automatic'`, **sin `plugins`**. Consecuencia heredada de la Fase 1: `import.meta.glob` es `undefined` en runtime. |
| Hay helper de intl para tests | Cierto: `lib/test-intl.tsx` exporta `IntlTestProvider`, que importa `formats` y `APP_TIME_ZONE` de `i18n/request.ts` **reales** (L18) y carga `messages/es.json` (L19). Un test NO debe montar `NextIntlClientProvider` a mano. |

---

## Technical Approach

Tres capas, con una frontera dura entre la primera y las otras dos:

```
  Respuesta del backend (tipos de lib/analytics.ts, sin tocar)
        │
        ▼
  ┌─────────────────────────────────────────────────────┐
  │  CAPA 1 — lib/analytics-warnings.ts   (PURA, 0 React)│
  │  reglas → AnalyticsWarning[]                         │
  │  · sin JSX, sin i18n, sin DOM, sin fetch             │
  │  · devuelve id + severidad + params (NÚMEROS)        │
  │  · NUNCA devuelve texto renderizado                  │
  └─────────────────────────────────────────────────────┘
        │  AnalyticsWarning[]  (dato, no prosa)
        ▼
  ┌─────────────────────────────────────────────────────┐
  │  CAPA 2 — components/analytics/AnalyticsWarning.tsx  │
  │  id → clave i18n; params → interpolación; severidad  │
  │  → icono + token de color + role ARIA                │
  └─────────────────────────────────────────────────────┘
        │
        ▼
  ┌─────────────────────────────────────────────────────┐
  │  CAPA 3 — components/analytics/GlossaryTerm.tsx      │
  │  5 términos, radix Popover, teclado + touch + SR     │
  └─────────────────────────────────────────────────────┘

  Fase 3 y 4 enchufan los paneles ACÁ ARRIBA. En Fase 2 nada llama a nada.
```

**La frontera que importa**: la Capa 1 no conoce el idioma del usuario. Devuelve
`{ id: 'b-value.mc-at-catalog-floor', severity: 'critical', params: { mc: 2.5 } }`,
no `"Mc coincide con el piso del catálogo"`. Eso es lo que la hace testeable por
mutación sin montar React ni un provider de intl, y lo que impide que la prosa
—que es contenido revisable— se esconda adentro de un `if`.

---

## Architecture Decisions

### Decisión 1 — Dónde vive la lib y cómo se llama

**Elegido**: un archivo nuevo `dashboard/lib/analytics-warnings.ts` + su
`dashboard/lib/analytics-warnings.test.ts`, al lado de sus hermanos
(`uptime-series.ts`, `b-value-plot.ts`, `hypocenter-markers.ts`,
`depth-section.ts`).

**Alternativas consideradas**:
- Un directorio `dashboard/lib/analytics/` con varios archivos por panel.
- Meter las reglas dentro de `lib/analytics.ts` (que ya tiene los tipos).

**Rationale**: `dashboard/lib/` es **plano** — no hay ni un subdirectorio en los
~60 archivos que lista `eza lib/`. Abrir un directorio para 3 funciones sería
inventar una convención para esta fase sola. Y meterlo en `lib/analytics.ts`
mezclaría **transporte** (`fetch`, `ApiStatusError`, `credentials: 'include'`) con
**reglas puras**: hoy `analytics.ts` no se puede importar sin arrastrar el cliente
HTTP, y una lib de reglas que arrastra `fetch` deja de ser trivialmente testeable.
La separación ya está establecida: `uptime-series.ts` importa **solo tipos** de
`./analytics` (`import type { StationUptimeResponse }`, L16) y no su transporte. La
lib nueva hace exactamente lo mismo.

### Decisión 2 — Forma del tipo `AnalyticsWarning`: unión discriminada por `id`

**Elegido**: unión discriminada por `id`, con `params` tipado por miembro.

```ts
export type WarningSeverity = 'critical' | 'caution' | 'info';

interface WarningBase<Id extends string, P> {
  id: Id;
  severity: WarningSeverity;
  params: P;
}
```

**Alternativas consideradas**:
- `{ id: string; severity: WarningSeverity; params: Record<string, unknown> }` —
  una sola forma laxa.
- Una clase con subclases por regla.
- Devolver el texto ya resuelto desde la lib.

**Rationale**: con `params: Record<string, unknown>` el componente tendría que
castear en cada rama y un typo en un parámetro (`{ nAboveMc }` donde la clave i18n
espera `{n}`) llegaría a producción como `"N above Mc: {n}"` literal en pantalla.
Con la unión discriminada, el `switch (warning.id)` narrowa `params` al shape
exacto de ESA regla y el compilador ata el contrato entre la lib y la clave i18n.
Es el mismo mecanismo que ya blinda `BValueResponse` (`analytics.ts:85`), que la
docstring del archivo defiende explícitamente ("un componente que lea `b` sin
narrow por `status` no compila", L11-12). **Una clase sería peor**: la lib se
serializa conceptualmente a datos planos y las clases no aportan comportamiento
acá. **Devolver texto resuelto** rompería la pureza (habría que inyectar `t`) y
volvería la lib intesteable sin provider.

Los `id` se escriben como **string literales con namespace por panel**
(`'b-value.mc-at-catalog-floor'`), no como enum: el string es a la vez la clave de
i18n (bajo `analytics.warnings.`), lo que elimina una tabla de mapeo id→clave que
podría desincronizarse en silencio.

### Decisión 3 — Escala de severidad: tres niveles, y `critical` es escaso a propósito

**Elegido**: `'critical' | 'caution' | 'info'`.

| Severidad | Significado operativo | Quién la usa en v1 |
|---|---|---|
| `critical` | **El número mostrado no es confiable.** Leerlo como si lo fuera es un error. | Solo `mc_at_catalog_floor === true`. |
| `caution` | El número es computable pero un supuesto está debilitado o la muestra es chica. | Mezcla de escalas de magnitud; `n_above_mc` cerca de `min_events`; baseline de tremor con fracción alta; canal de uptime bajo umbral. |
| `info` | Contexto que ayuda a leer, sin poner en duda el número. | Intervalo derivado `b ± 1.96σ`; tremor sin episodios. |

**Alternativas consideradas**: dos niveles (error/aviso); cuatro o cinco alineados
con `--severity-*` (que tiene 6: `low`, `ok`, `light`, `moderate`, `high`,
`critical`).

**Rationale**: el riesgo declarado en el proposal es *"si todo advierte, nada
advierte"* (`proposal.md:196`). Tres niveles con **un solo emisor de `critical`**
hace ese riesgo verificable, no aspiracional: un test puede afirmar que la única
regla que produce `critical` es `mc_at_catalog_floor`. Con dos niveles, `sigma_b`
(que es contexto útil) competiría visualmente con `mc_at_catalog_floor` (que
invalida el b-value). **Alinear con `--severity-*` sería un error de dominio**: esa
escala codifica **magnitud sísmica** (`getMagnitudeColor`), y reusarla para
confiabilidad haría que un aviso de muestra chica se pinte del mismo naranja que un
M6. Son dos escalas distintas y deben seguir siéndolo — es la misma regla
"cromo vs dato" que la Fase 1 defendió.

### Decisión 4 — La primitiva del glosario: **`Popover`** (Open Question 4, cerrada)

**Elegido**: `Popover` de `radix-ui`, envuelto en un `components/ui/popover.tsx`
nuevo siguiendo el molde exacto de `components/ui/tooltip.tsx`.

**Alternativas consideradas**: `Tooltip` (ya envuelto en `components/ui/tooltip.tsx`);
`HoverCard`.

**Rationale**, contra los cuatro requisitos del pedido:

| Requisito | `Tooltip` | `HoverCard` | `Popover` |
|---|---|---|---|
| **Touch** — se abre con el dedo | ✗ Radix Tooltip es hover/focus; en touch depende de un long-press inconsistente entre navegadores | ✗ Explícitamente hover-only, "not intended for touch" en su propia doc | ✅ Es click/tap: la interacción primaria funciona igual con dedo, mouse y teclado |
| **Teclado** | Parcial: abre con focus, pero es un tooltip — no captura foco ni puede contener contenido navegable | ✗ No focusable | ✅ `Trigger` es un `button` real: Enter/Space abre, Esc cierra, el foco entra al contenido y vuelve al trigger al cerrar |
| **Lector de pantalla** | El contenido va como nombre accesible del trigger: sirve para una etiqueta corta, no para un párrafo con definición | Sin semántica de diálogo | ✅ `role="dialog"` + `aria-expanded`/`aria-controls` en el trigger, gestionado por Radix |
| **Contenido** | Una frase. Un párrafo dentro de un tooltip es mal uso de la primitiva | Ídem | ✅ Pensado para contenido rico: definición + unidad + nota de límite |

El desempate es **touch**. Una definición de "b-value" que no se puede abrir con el
dedo en un tablet es una feature que no existe para la mitad de los usos de un
panel de monitoreo. `HoverCard` queda descartado por el propio pedido ("un HoverCard
no se abre con el dedo"). `Tooltip` queda descartado por semántica: lo que se muestra
es un párrafo, no una etiqueta.

**Costo asumido y por qué se paga**: hay que crear `components/ui/popover.tsx`
(`Tooltip` ya está envuelto). Es ~40 líneas calcadas del molde de al lado, con dos
detalles que se copian **del archivo existente, no de la doc de shadcn**:

1. **`z-[1100]`** — el comentario de `tooltip.tsx:45` documenta que es un fix
   sistémico de QA para ganarle a los `z-[1000]` de Leaflet. Un popover de glosario
   dentro del tab "Red" (que tiene mapa) reproduciría el bug exacto si se usa el
   `z-50` que trae el molde de shadcn.
2. **`Portal`** — `tooltip.tsx:40` porteliza. Sin eso, un popover dentro de un
   contenedor con `overflow-y-auto` (como el `max-h-56` del ranking de uptime,
   `StationUptimeChart.tsx:167`) sale **recortado**. Este bug ya mordió en este
   repo — es la misma clase de defecto que el commit `42fa3bb` ("el panel de
   espectrogramas quedaba recortado en el HUD embebido").

**Lo que NO se hace, explícitamente**: `forceMount`. La lección está registrada
(`radix-tabs-forcemount-rompe-accesibilidad`): deja el contenido inactivo visible
al lector de pantalla. Un popover cerrado debe estar **fuera del árbol de
accesibilidad**, y el comportamiento por defecto de Radix ya lo garantiza. No hay
ninguna razón de esta fase para montar contenido cerrado.

### Decisión 5 — El glosario vive en `messages/*.json`, no en un módulo TS

**Elegido**: un nodo `analytics.glossary.<termId>` con `{ term, definition, note? }`
en `messages/es.json` y `messages/en.json`. El **catálogo de ids** (la unión de 5
literales) vive en TS; el **contenido** vive en i18n.

**Alternativas consideradas**: un `lib/glossary.ts` con las definiciones en español
e inglés; un JSON aparte tipo `seismic-constants.json`.

**Rationale**: el contenido del glosario es **texto traducible**, y este repo ya
tiene una red de seguridad completa para eso y solo para eso — `parity.test.ts`
(que ya exigiría ES/EN simétricos y sin vacíos, L39-58) y la augmentation de
`global.d.ts:9-13` (que hace fallar en compile-time una clave inexistente). Un
`lib/glossary.ts` se quedaría afuera de las dos: nadie garantizaría que la entrada
inglesa exista, y el typo en un id se descubriría en runtime. Gratis, además, el
glosario queda alcanzable desde cualquier componente con `useTranslations`.

El paralelo con `seismic-constants.json` **no aplica**: ese archivo existe porque
Python y TypeScript necesitan leer **los mismos números** (`tremor.py:54-57` lo
carga desde el backend). El glosario es prosa, es solo de frontend, y es
traducible. Nada que compartir con Python.

**Estructura elegida — plana, con `note` opcional**:

```jsonc
"analytics": {
  "glossary": {
    "trigger": "Qué es {term}",          // aria-label del botón
    "close": "Cerrar",
    "bValue": {
      "term": "b-value",
      "definition": "Pendiente de la relación Gutenberg-Richter…",
      "note": "Se estima por máxima verosimilitud (Aki-Utsu) sobre…"
    },
    "mc": { "term": "Mc", "definition": "…", "note": "…" },
    "rsam": { "term": "RSAM", "definition": "…" },
    "fi": { "term": "FI", "definition": "…", "note": "…" },
    "uptimeRatio": { "term": "Uptime ratio", "definition": "…", "note": "…" }
  }
}
```

`note` es **opcional en el contenido pero obligatorio en la forma**: si un término
no la necesita, la clave no existe en ninguno de los dos idiomas (`parity.test.ts`
lo exige simétrico) y el componente no renderiza el bloque. Un `note: ""` haría
fallar la regla de "ningún valor vacío" (L50-58) — bien: string vacío es basura,
no ausencia.

**Sin `t.rich` en el glosario v1.** Está disponible (8 call-sites en la app) pero
las definiciones son párrafos planos; meter markup dentro de la clave obligaría a
cada consumidor a pasar los mismos renderers y convertiría el diccionario en
código. Si una definición necesita énfasis, se parte en `definition` + `note`, que
es lo que la estructura ya prevé.

### Decisión 6 — El identificador del término en TS: unión cerrada de 5, con mapeo explícito a la clave

**Elegido**:

```ts
export type GlossaryTermId = 'b-value' | 'mc' | 'rsam' | 'fi' | 'uptime-ratio';
```

y un `Record<GlossaryTermId, string>` que mapea al segmento de la clave i18n
(`'b-value' → 'bValue'`, `'uptime-ratio' → 'uptimeRatio'`).

**Alternativas consideradas**: usar el mismo string en ambos lados (`'bValue'` como
id público), o derivar la clave con un `camelCase()` genérico.

**Rationale**: los ids públicos van en kebab-case porque es como se escriben los
`id` de advertencia (`'b-value.mc-at-catalog-floor'`) y porque el término se llama
"b-value" con guion en la literatura. Las claves de `messages/*.json` van en
camelCase porque **todo el archivo está en camelCase** (`noObservations`,
`mcAtFloor`, `inProgress`…) y next-intl lo navega por puntos. Un `camelCase()`
genérico sería una función viva que puede desviarse; el `Record` tipado por la
unión **no compila** si falta una entrada o sobra una. Cinco líneas de tabla contra
una función con casos borde: la tabla gana.

### Decisión 7 — Severidad → píxel: token + icono + texto, nunca color solo

**Elegido**:

| Severidad | Token de fondo/texto | Icono `lucide-react` | `role` ARIA |
|---|---|---|---|
| `critical` | `border-destructive/40 bg-destructive/10 text-destructive` | `TriangleAlert` | `alert` |
| `caution` | `border-warning/40 bg-warning/10 text-warning` | `AlertCircle` | `status` |
| `info` | `border-border bg-muted text-muted-foreground` | `Info` | `status` |

**Alternativas consideradas**: solo color de borde; `role="alert"` para las tres;
sin icono; hex fijos por severidad.

**Rationale**:

- **Tokens, no hex.** `--destructive` y `--warning` existen en `:root` (L27-28,
  L35-36) **y** en `.dark` (L74-75, L80-81) con sus `-foreground`. Usar clases
  Tailwind sobre esos tokens hace que el tema lo resuelva la cascada, sin
  `useTheme` — el mismo principio que `chart-theme.ts:8-13`. Como el componente es
  JSX y no pasa nada a Recharts, se usan **clases** (`text-destructive`) y no
  `hsl(var(--destructive))`: esto lo mantiene **fuera del alcance de
  `chart-chrome.test.ts`**, que descubre archivos filtrando por `from 'recharts'`
  (criterio de la Fase 1) — `AnalyticsWarning.tsx` no importa Recharts, así que no
  entra al conjunto descubierto. **Un hex acá tampoco sería atrapado por ese test**,
  razón de más para que su propio test lo prohíba (ver Testing).
- **Icono + texto, no color solo.** WCAG 1.4.1: el color no puede ser el único
  portador de información. Un daltónico debe distinguir `critical` de `caution` por
  la **forma** del icono (triángulo vs círculo). El icono lleva `aria-hidden`: su
  significado ya está en el texto de la advertencia, y un lector de pantalla que
  anuncie "triángulo" no aporta nada.
- **`role="alert"` solo para `critical`.** `alert` es una live region **assertive**:
  interrumpe al lector de pantalla. Un panel con cuatro `info` en `role="alert"`
  convierte la página en un atropello sonoro. `status` es polite y se anuncia cuando
  el usuario llega. La regla operativa: `alert` solo cuando el número en pantalla no
  es confiable — que es exactamente la definición de `critical` de la Decisión 3.

### Decisión 8 — El límite de dominio se vuelve TEST, no buena intención

**Elegido**: un test que escanea las claves i18n nuevas
(`analytics.warnings.*` y `analytics.glossary.*`) en **ambos idiomas** y falla si
alguna contiene un término de diagnóstico de fenómeno.

**Alternativas consideradas**: dejarlo como criterio de code review; una nota en la
spec.

**Rationale**: el proposal marca este riesgo como **High** (`proposal.md:193`) y el
límite está escrito en el backend (`tremor.py:30-32`: *"Lo que esto NO afirma:
'tremor volcánico'… la interpretación es del sismólogo"*). Un criterio que solo vive
en la cabeza del revisor se pierde en el primer PR apurado. La lista negra mínima
—`volcán`/`volcánico`/`volcanic`, `erupción`/`eruption`, `inminente`/`imminent`,
`predice`/`predicts`, `premonitor`/`precursor`— es corta y honesta sobre lo que
puede: no detecta toda mala redacción, pero **hace imposible el error concreto que
el proposal nombra**. El resto lo cubre el QA del usuario.

Este test es barato y es la única forma de que la Decisión D5 sea verificable.

### Decisión 9 — Las reglas se agrupan por endpoint, no una función gigante

**Elegido**: tres funciones exportadas, una por respuesta del backend, más las
utilidades de derivación:

```ts
bValueWarnings(response: BValueResponse): AnalyticsWarning[]
tremorWarnings(response: TremorResponse): AnalyticsWarning[]
uptimeWarnings(overall: Record<string, number | null>): AnalyticsWarning[]
```

**Alternativas consideradas**: una sola `analyticsWarnings(all)` que reciba todo;
una función por regla exportada individualmente.

**Rationale**: cada panel de la Fase 3/4 tiene **su propia** respuesta y su propio
ciclo de carga (`useSWR` en la página para b-value, `useEffect` para tremor/uptime
— decisión heredada que no se reabre, `proposal.md:113-114`). Una función que
reciba todo obligaría a esperar los tres endpoints para mostrar una advertencia del
primero. Una función por regla multiplicaría los call-sites sin ganar nada: el
consumidor quiere "todas las advertencias de este panel", no elegir reglas.

El **orden del array es parte del contrato**: `critical` primero, después `caution`,
después `info`, y dentro de cada nivel el orden de declaración de las reglas. El
consumidor renderiza `map()` sin ordenar. Un orden implícito que dependa del orden
de los `if` es una trampa: se fija con un `sort` estable por severidad y se testea.

### Decisión 10 — `b ± 1.96σ`: función pura con el factor nombrado, y el nombre NO dice "confianza"

**Elegido**:

```ts
/** 1,96σ ≈ 95 % BAJO SUPUESTO DE NORMALIDAD. `sigma_b` es σ de
 *  Shi & Bolt (1982), NO un intervalo de confianza calculado por el backend. */
export const NORMAL_95_FACTOR = 1.96;

export function derivedBInterval(b: number, sigmaB: number): { low: number; high: number };
```

**Alternativas consideradas**: `confidenceInterval()`; calcularlo inline en el
componente; devolver el string ya formateado.

**Rationale**: el riesgo está nombrado en el proposal (`proposal.md:194`) y el
vector de contagio es **el nombre del identificador**. Si la función se llama
`confidenceInterval`, el próximo que la lea escribe "intervalo de confianza" en el
copy sin pensarlo — el nombre del código se filtra a la prosa. Se llama
`derivedBInterval` y la constante `NORMAL_95_FACTOR` dice el supuesto en el nombre.
El `1.96` pelado inline sería un número mágico que nadie puede auditar.

Devuelve **números**, no string: el formateo es del componente (que tiene el
locale). Y la clave i18n que lo muestra lleva el rótulo del supuesto — está bajo el
alcance del test de la Decisión 8 ampliado: ninguna clave nueva puede decir
"intervalo de confianza" / "confidence interval".

### Decisión 11 — El umbral de uptime vive en la lib, el recorte no

**Elegido**: la lib exporta la constante y el predicado; **no** exporta el recorte
ni el "ver todas".

```ts
/** Decisión cerrada con el usuario: por debajo de este ratio la estación
 *  entra en "qué mirar HOY". Fijo, NO percentil. */
export const UPTIME_ATTENTION_THRESHOLD = 0.9;
```

**Alternativas consideradas**: dejar todo el umbral para la Fase 4; poner también el
`slice(0, 10)` acá.

**Rationale**: el umbral es **criterio de dominio** y es la clase de número que hay
que poder testear por mutación aislado — cambiarlo a `0.95` debe poner un test en
rojo con un mensaje que diga el valor esperado. El recorte a 10, en cambio, es
**decisión de presentación**: depende del alto disponible y del "ver todas", que es
interacción. Meterlo en la lib pura ataría la lib a un detalle de layout que jsdom
ni siquiera puede verificar (no hace layout). La frontera es: **la lib decide qué
es "para mirar hoy", el componente decide cuántos caben en pantalla.**

`null` (nadie miró) **no** cruza el umbral: no es "estación mala", es "sin dato".
Se emite como una advertencia distinta (`uptime.channels-unobserved`) — es
exactamente la invariante que `station_uptime.py:138-144` protege en el backend y
que `uptime-series.ts:5-13` ya declara en el frontend. Convertir `null` en "< 0.9"
sería reponer el bug que dos capas vienen defendiendo.

---

## Data Flow

Fase 2 en aislamiento — nadie llama a nada todavía:

```
  [ Fase 2: lo que se construye ]

  BValueResponse ──► bValueWarnings() ──► AnalyticsWarning[]
  TremorResponse ──► tremorWarnings() ──► AnalyticsWarning[]
  overall{}      ──► uptimeWarnings() ──► AnalyticsWarning[]
                          (lib pura, sin React)

  AnalyticsWarning ──► <AnalyticsWarning> ──► icono + t(`analytics.warnings.${id}`, params)
                                           └► role: critical ? 'alert' : 'status'

  GlossaryTermId   ──► <GlossaryTerm>     ──► Popover: trigger (button) + content (dialog)
                                           └► t(`analytics.glossary.${key}.definition`)
```

Cómo lo consumirá la Fase 3 (**fuera de esta fase**, se dibuja solo para mostrar que
la frontera cierra):

```
  page.tsx (useSWR)          BValueChart.tsx
       │                           │
       └── BValueResponse ────────►├─► bValueWarnings(res).map(w =>
                                   │     <AnalyticsWarning key={w.id} warning={w} />)
                                   │
                                   └─► "Mc <GlossaryTerm id="mc" />: 2.5"
```

Secuencia del glosario (teclado y touch resuelven igual — ese es el punto de la
Decisión 4):

```
  Usuario            GlossaryTerm          Popover(radix)        Lector de pantalla
    │                     │                      │                      │
    │ tap / Enter ───────►│                      │                      │
    │                     │ onOpenChange(true)──►│                      │
    │                     │                      │ portal + role=dialog─►│ "diálogo, b-value"
    │                     │                      │ foco → contenido      │
    │ Esc ───────────────────────────────────────►│                      │
    │                     │                      │ desmonta contenido ──►│ (fuera del árbol)
    │◄───────────────── foco de vuelta al trigger │                      │
```

---

## File Changes

Todos **nuevos** salvo los dos `messages/*.json`. Ningún componente ni lib existente
se modifica: es la propiedad que hace esta fase revertible borrando archivos
(`proposal.md:213`).

| Archivo | Acción | Descripción |
|---|---|---|
| `dashboard/lib/analytics-warnings.ts` | **New** | Lib pura. Tipos `WarningSeverity`/`AnalyticsWarning`, las tres funciones por endpoint, `derivedBInterval` + `NORMAL_95_FACTOR`, `UPTIME_ATTENTION_THRESHOLD`. Cero imports de React/next-intl. |
| `dashboard/lib/analytics-warnings.test.ts` | **New** | Test de la lib. Sin jsdom-dependencias: datos in/datos out. |
| `dashboard/lib/glossary.ts` | **New** | `GlossaryTermId` (unión de 5) + `GLOSSARY_MESSAGE_KEYS: Record<GlossaryTermId, string>`. Sin contenido de prosa. |
| `dashboard/lib/glossary.test.ts` | **New** | El mapeo cubre los 5 ids y cada clave existe en ES **y** EN. |
| `dashboard/components/ui/popover.tsx` | **New** | Wrapper de `Popover` de `radix-ui`, calcado de `components/ui/tooltip.tsx`: `Portal`, `z-[1100]`, clases tematizadas. |
| `dashboard/components/analytics/AnalyticsWarning.tsx` | **New** | Severidad → icono + token + `role`; id + params → texto i18n. |
| `dashboard/components/analytics/AnalyticsWarning.test.tsx` | **New** | DOM/ARIA/clases declaradas. |
| `dashboard/components/analytics/GlossaryTerm.tsx` | **New** | Trigger accesible + Popover con definición. |
| `dashboard/components/analytics/GlossaryTerm.test.tsx` | **New** | Apertura por teclado, cierre por Esc, contenido ausente del DOM al cerrar. |
| `dashboard/components/analytics/interpretation-copy.test.ts` | **New** | Límite de dominio (Decisión 8) sobre las claves nuevas en los dos idiomas. |
| `dashboard/messages/es.json` | **Modify** | `analytics.glossary.*` (5 términos + `trigger`/`close`) y `analytics.warnings.*`. **Solo agrega**; ninguna clave existente se renombra ni se borra. |
| `dashboard/messages/en.json` | **Modify** | Idem, en paralelo. `parity.test.ts` falla sola si divergen. |

**Lo que NO se toca, y hay que poder demostrarlo con `git diff` vacío**:
`BValueChart.tsx`, `TremorPanel.tsx`, `StationUptimeChart.tsx`, `EventsTable.tsx`,
`app/(app)/analytics/page.tsx`, `lib/analytics.ts`, `lib/uptime-series.ts`,
`lib/chart-theme.ts`, `chart-chrome.test.ts`, y **todo `src/`**.

---

## Interfaces / Contracts

### `dashboard/lib/analytics-warnings.ts`

```ts
import type { BValueResponse, TremorResponse } from './analytics';

/** Tres niveles (design, Decisión 3). `critical` = el número mostrado NO es
 *  confiable; `caution` = supuesto debilitado o muestra chica; `info` =
 *  contexto. Una sola regla emite `critical`, a propósito. */
export type WarningSeverity = 'critical' | 'caution' | 'info';

/** El `id` es a la vez discriminante de la unión Y sufijo de la clave i18n
 *  bajo `analytics.warnings.` — sin tabla de mapeo que pueda desincronizarse. */
interface WarningBase<Id extends string, P extends object> {
  readonly id: Id;
  readonly severity: WarningSeverity;
  /** Números crudos; el formateo (locale) es del componente. */
  readonly params: P;
}

// --- b-value ---
export type McAtCatalogFloorWarning =
  WarningBase<'b-value.mc-at-catalog-floor', { mc: number }>;
export type MixedMagnitudeTypesWarning =
  WarningBase<'b-value.mixed-magnitude-types', { types: string; count: number }>;
export type SmallSampleWarning =
  WarningBase<'b-value.small-sample', { n: number; min: number }>;
export type DerivedIntervalWarning =
  WarningBase<'b-value.derived-interval', { low: number; high: number; sigma: number }>;

// --- tremor ---
export type TremorBaselineMaskedWarning =
  WarningBase<'tremor.baseline-masked', { fraction: number }>;
export type TremorNoBaselineWarning =
  WarningBase<'tremor.no-baseline', Record<string, never>>;
export type TremorNoEpisodesWarning =
  WarningBase<'tremor.no-episodes', Record<string, never>>;

// --- uptime ---
export type UptimeBelowThresholdWarning =
  WarningBase<'uptime.channels-below-threshold', { count: number; threshold: number }>;
export type UptimeUnobservedWarning =
  WarningBase<'uptime.channels-unobserved', { count: number }>;

export type AnalyticsWarning =
  | McAtCatalogFloorWarning | MixedMagnitudeTypesWarning | SmallSampleWarning
  | DerivedIntervalWarning | TremorBaselineMaskedWarning | TremorNoBaselineWarning
  | TremorNoEpisodesWarning | UptimeBelowThresholdWarning | UptimeUnobservedWarning;

export type AnalyticsWarningId = AnalyticsWarning['id'];

// --- constantes con el supuesto en el nombre (Decisión 10 y 11) ---
export const NORMAL_95_FACTOR = 1.96;
export const UPTIME_ATTENTION_THRESHOLD = 0.9;
/** `n_above_mc` a menos de este múltiplo de `min_events` ⇒ muestra chica. */
export const SMALL_SAMPLE_FACTOR = 1.5;
/** Fracción de ventana en episodio por encima de la cual la MEDIANA queda
 *  contaminada (`src/services/tremor.py:26-28`). */
export const TREMOR_BASELINE_MASK_FRACTION = 0.5;

/** `b ± 1.96σ` BAJO SUPUESTO DE NORMALIDAD. NO es un IC del backend. */
export function derivedBInterval(b: number, sigmaB: number): { low: number; high: number };

/** Orden garantizado: critical → caution → info; estable dentro del nivel. */
export function bValueWarnings(response: BValueResponse): AnalyticsWarning[];
export function tremorWarnings(response: TremorResponse): AnalyticsWarning[];
export function uptimeWarnings(overall: Record<string, number | null>): AnalyticsWarning[];
```

**Reglas, literales** (cada una es un test):

| id | Dispara cuando | Severidad |
|---|---|---|
| `b-value.mc-at-catalog-floor` | `mc_at_catalog_floor === true` **y** `mc !== null` | `critical` |
| `b-value.mixed-magnitude-types` | `Object.keys(mag_type_counts).length > 1` | `caution` |
| `b-value.small-sample` | `status === 'ok'` **y** `n_above_mc < min_events * SMALL_SAMPLE_FACTOR` | `caution` |
| `b-value.derived-interval` | `status === 'ok'` (único acceso legal a `sigma_b`) | `info` |
| `tremor.no-baseline` | `baseline_rsam === null` | `caution` |
| `tremor.baseline-masked` | `baseline_rsam !== null` **y** `tremor_fraction > 0.5` | `caution` |
| `tremor.no-episodes` | `episodes.length === 0` **y** `baseline_rsam !== null` | `info` |
| `uptime.channels-below-threshold` | ≥1 canal con `ratio !== null && ratio < 0.9` | `caution` |
| `uptime.channels-unobserved` | ≥1 canal con `ratio === null` | `caution` |

Dos detalles de borde que la tabla esconde y los tests fijan:

- `b-value.small-sample` y `b-value.derived-interval` **solo** en `status === 'ok'`.
  Con `insufficient`/`degenerate` el campo `sigma_b` no existe en el tipo; el narrow
  por `status` no es defensa, es la única forma de que compile.
- `uptime.channels-unobserved` cuenta `null`, **nunca** los suma a
  `channels-below-threshold`. Son dos hechos distintos y viajan en dos advertencias
  distintas (Decisión 11).

### `dashboard/lib/glossary.ts`

```ts
export type GlossaryTermId = 'b-value' | 'mc' | 'rsam' | 'fi' | 'uptime-ratio';

/** Los 5 de v1 (decisión cerrada). `sigma_b`, `onset_ratio`, `fi_sign` y
 *  `tremor_fraction` NO son entradas: se explican dentro de su advertencia. */
export const GLOSSARY_TERM_IDS: readonly GlossaryTermId[] =
  ['b-value', 'mc', 'rsam', 'fi', 'uptime-ratio'] as const;

/** id público (kebab, como en la literatura) → segmento de clave i18n
 *  (camelCase, como TODO messages/*.json). Tabla explícita, no camelCase():
 *  `Record` tipado por la unión no compila si falta o sobra una entrada. */
export const GLOSSARY_MESSAGE_KEYS: Record<GlossaryTermId, string> = {
  'b-value': 'bValue', mc: 'mc', rsam: 'rsam', fi: 'fi', 'uptime-ratio': 'uptimeRatio',
};
```

### Componentes

```tsx
// AnalyticsWarning.tsx — presentacional puro, sin estado, sin efectos
export function AnalyticsWarning({ warning }: { warning: AnalyticsWarningModel }): JSX.Element;

// GlossaryTerm.tsx — el trigger es un <button> real (Decisión 4)
export function GlossaryTerm({
  id,
  /** Texto del trigger; por defecto `glossary.<key>.term`. */
  label,
}: { id: GlossaryTermId; label?: string }): JSX.Element;
```

`AnalyticsWarning` no recibe `className` ni `variant`: la severidad ya determina la
apariencia y un override externo permitiría pintar un `critical` de gris. Si la
Fase 3 necesita espaciado, lo pone el contenedor.

---

## Testing Strategy

Runner: `./node_modules/.bin/vitest run` con el PATH de nvm exportado
(`export PATH="$HOME/.nvm/versions/node/v22.16.0/bin:$PATH"`). **Nunca `npx`** (baja
un vitest ajeno de internet) y **nunca `next build`** (comparte `.next` con el server
de dev y lo rompe).

| Capa | Qué se testea | Cómo |
|---|---|---|
| Lib pura (`analytics-warnings`, `glossary`) | Reglas, umbrales, orden del array, bordes de `null`, narrow por `status` | Datos in / datos out. Sin jsdom, sin provider, sin mocks. Es el molde de `uptime-series.test.ts`. |
| Componentes (`AnalyticsWarning`, `GlossaryTerm`) | DOM, ARIA, clases **declaradas**, interacción de teclado | `@testing-library/react` + `IntlTestProvider` de `lib/test-intl.tsx` (**nunca** `NextIntlClientProvider` a mano: pasar `timeZone` en un test es el falso verde que ese helper vino a matar). |
| Contenido i18n (`interpretation-copy`, `glossary`) | Existencia de claves en ES **y** EN, límite de dominio, prohibición de "intervalo de confianza" | Importar los dos JSON y assertear sobre los strings. |
| Paridad ES/EN | Ya cubierta | `messages/parity.test.ts` existente — **no se toca**, se cumple. |

### Lo que jsdom NO puede hacer, y por qué importa acá

**jsdom no hace layout.** Todo mide 0×0, `overflow` no recorta y `hsl(var(--token))`
no se resuelve contra la cascada. Consecuencias directas para esta fase:

- **No se testea contraste** de `--destructive`/`--warning`. Se testea que el
  elemento **declare** la clase (`toHaveClass('text-destructive')`). Que esa clase dé
  4.5:1 lo verifica el usuario en QA visual.
- **No se testea que el popover no quede recortado.** El `Portal` y el `z-[1100]` de
  la Decisión 4 son **inverificables por unit test** — un test puede probar que el
  contenido está en el DOM y estar igual invisible en pantalla. Lo que sí se testea
  es que el componente **declare** el Portal. El recorte real va al QA visual, con
  instrucción explícita de abrir un término dentro del ranking de uptime (contenedor
  con `overflow-y-auto`) y sobre el tab con mapa.
- **No se testea la posición** del popover ni el foco visible.

### Interacción: `mouseDown`, no `fireEvent.click`

Lección ya pagada en este repo con Radix Tabs: `fireEvent.click` en un trigger de
Radix **no dispara el cambio de estado** y deja un verde falso. Para abrir el
Popover se usa `userEvent` (que emite la secuencia completa `pointerdown` →
`mousedown` → `click`) o `fireEvent.pointerDown` + `fireEvent.mouseDown`. Un test
que use `fireEvent.click` pelado y pase **tiene que sospecharse**: probablemente el
popover ya estaba abierto o el assert no mira nada.

### Mutaciones obligatorias — cada una debe producir rojo

Protocolo del repo: mutar con `Edit` (no con `sd`: `sd -s` con `\n` en el patrón no
matchea y sale exit 0 dejando el archivo intacto), verificar `git diff --stat` **no
vacío ANTES** de correr los tests, correr, anotar el `it` exacto y el mensaje,
revertir con `git checkout --` y confirmar `git status --porcelain` vacío. Si hay
dos corridas en el mismo segundo sobre el mismo archivo, `rm -rf __pycache__` no
aplica acá pero sí conviene no encadenar mutación+revert+mutación sin correr entre
medio.

| # | Archivo | Mutación | Test que DEBE ponerse rojo |
|---|---|---|---|
| 2.1 | `analytics-warnings.ts` | `mc_at_catalog_floor === true` → `=== false` | la regla no emite `b-value.mc-at-catalog-floor` con el flag prendido |
| 2.2 | `analytics-warnings.ts` | `severity: 'critical'` → `'caution'` en esa misma regla | severidad de `mc-at-catalog-floor`; **y** el test de "solo una regla emite critical" |
| 2.3 | `analytics-warnings.ts` | `UPTIME_ATTENTION_THRESHOLD = 0.9` → `0.95` | un canal a `0.92` pasa a contar como bajo umbral |
| 2.4 | `analytics-warnings.ts` | `NORMAL_95_FACTOR = 1.96` → `2` | `derivedBInterval(1.0, 0.1)` deja de dar `{0.804, 1.196}` |
| 2.5 | `analytics-warnings.ts` | en `uptimeWarnings`, tratar `ratio === null` como `0` | `null` deja de emitir `channels-unobserved` **y** empieza a contar en `below-threshold` — la invariante `null ≠ 0` |
| 2.6 | `analytics-warnings.ts` | quitar el `sort` por severidad | el array deja de venir `critical` → `caution` → `info` |
| 2.7 | `analytics-warnings.ts` | `tremor_fraction > 0.5` → `> 0.9` | una respuesta con `0.6` deja de emitir `baseline-masked` |
| 2.8 | `AnalyticsWarning.tsx` | `role` de `critical`: `'alert'` → `'status'` | el assert de `role="alert"` |
| 2.9 | `AnalyticsWarning.tsx` | quitar el icono (dejar solo texto y color) | el test de "no depende solo del color": no encuentra el icono con `aria-hidden` |
| 2.10 | `AnalyticsWarning.tsx` | `text-destructive` → `text-[#ef4444]` | el test que prohíbe hex en este componente (**`chart-chrome.test.ts` NO lo cubre**: no importa Recharts) |
| 2.11 | `GlossaryTerm.tsx` | `<button>` → `<span onClick>` | el test que busca el trigger por `role="button"` / apertura con Enter |
| 2.12 | `GlossaryTerm.tsx` | agregar `forceMount` al `Content` | el test que exige que el contenido **no esté en el DOM** con el popover cerrado |
| 2.13 | `messages/es.json` | meter `"…indica tremor volcánico…"` en una definición | el test de límite de dominio (Decisión 8) |
| 2.14 | `messages/en.json` | renombrar una clave nueva sin tocar ES | `parity.test.ts` (que ya existe) |
| 2.15 | `glossary.ts` | borrar `'fi'` del `Record` | no compila (`tsc --noEmit`) **y** el test de cobertura de los 5 ids |

La 2.15 es la única que se verifica con `./node_modules/.bin/tsc --noEmit` además de
con vitest: es el chequeo de que la unión cerrada de la Decisión 6 realmente aprieta.

### Trampas del harness ya conocidas — no re-descubrir

- Node del shell es v12: exportar el PATH de nvm v22.16.0 **antes** de todo.
- `npx` baja un vitest de internet: usar `./node_modules/.bin/vitest`.
- Mock de router inestable cuelga tests: si algún componente lo necesitara, misma
  referencia SIEMPRE. (Ninguno de los dos de esta fase usa router — si aparece uno,
  es señal de que el alcance se corrió.)

---

## Migration / Rollout

**No migration required.** Cero backend, cero base de datos, cero endpoints, cero
contratos. Ningún componente existente cambia, así que la página `/analytics` en
producción renderiza **byte por byte lo mismo** antes y después de mergear esta fase.

Rollback: borrar los archivos nuevos y revertir los dos JSON de mensajes. Como nada
los consume, no queda ningún call-site huérfano (`proposal.md:213`).

**QA visual** (lo hace el usuario, convención del proyecto): esta fase **no cambia
nada visible en `/analytics`**, y hay que decirlo así de claro para que el usuario no
busque un cambio que no existe. Lo único que se puede pedir es mirar un harness
temporal o esperar a la Fase 3. La recomendación es **no** montar un harness
descartable: la Fase 3 entrega los componentes en su contexto real, que es donde el
juicio visual sirve. Lo que sí se entrega al cerrar: la lista de los 5 términos con
su definición en ES y EN, **para revisión de contenido** — que es donde el usuario
es la autoridad y ningún test puede reemplazarlo.

---

## Orden de construcción (file-by-file)

Cada paso deja la suite en verde. El orden no es cosmético: pone la lib pura antes
que todo lo que la usa, y el contenido i18n antes que los componentes que lo leen
(si no, el componente no compila — la augmentation de `global.d.ts` rechaza claves
inexistentes).

1. **`lib/analytics-warnings.ts`** — tipos + constantes + `derivedBInterval`. Sin
   las tres funciones de reglas todavía.
2. **`lib/analytics-warnings.test.ts`** — `derivedBInterval` y las constantes.
   Mutaciones 2.4.
3. **`lib/analytics-warnings.ts`** — `bValueWarnings`, `tremorWarnings`,
   `uptimeWarnings` + el `sort` por severidad, y el test crece con ellas.
   Mutaciones 2.1, 2.2, 2.3, 2.5, 2.6, 2.7.
4. **`lib/glossary.ts` + `lib/glossary.test.ts`** — la unión y el `Record`.
   Mutación 2.15.
5. **`messages/es.json` y `messages/en.json`** — glosario (5 términos + `trigger` +
   `close`) y `analytics.warnings.*` (9 claves). **Los dos archivos en el mismo
   commit**, o `parity.test.ts` se pone roja. Mutación 2.14.
6. **`components/analytics/interpretation-copy.test.ts`** — límite de dominio.
   Mutación 2.13. Va acá y no al final: si la prosa cruza la línea, mejor enterarse
   antes de construir componentes sobre ella.
7. **`components/ui/popover.tsx`** — wrapper calcado de `ui/tooltip.tsx`, con
   `Portal` y `z-[1100]`.
8. **`components/analytics/AnalyticsWarning.tsx` + su test**. Mutaciones 2.8, 2.9,
   2.10.
9. **`components/analytics/GlossaryTerm.tsx` + su test**. Mutaciones 2.11, 2.12.
10. **`./node_modules/.bin/tsc --noEmit`** y suite completa. Registrar las 15
    mutaciones en `openspec/changes/analytics-redesign/mutation-log.md`, en la misma
    tabla que las 4 de la Fase 1.

Si el PR queda grande, el corte natural es **entre 6 y 7**: pasos 1-6 son "lib +
contenido" (nada de React), 7-9 son "componentes". Las dos mitades mergean solas.

---

## Open Questions

Ninguna bloqueante. Las que el proposal dejaba abiertas para esta fase quedan
cerradas acá:

- **OQ4 (primitiva de radix)** — cerrada: **`Popover`** (Decisión 4), con el costo
  de crear `components/ui/popover.tsx`.
- **OQ3 (cuántos términos)** — cerrada antes de este design: 5.

Pendientes que NO bloquean:

- [ ] **Revisión de contenido de las 5 definiciones por el usuario.** El texto es
      dominio sismológico; los tests solo garantizan que exista, que esté en los dos
      idiomas y que no cruce el límite de diagnóstico. Que sea **correcto** lo dice
      el sismólogo.
- [ ] **`SMALL_SAMPLE_FACTOR = 1.5` es una elección de este design, no del usuario.**
      Es el único umbral de la fase sin respaldo explícito (el de uptime sí lo tiene:
      0.9 cerrado). Conviene confirmarlo en el QA de la Fase 3, cuando se vea cuántas
      veces dispara con datos reales. Cambiarlo es editar una constante y un test.
- [ ] **¿Un evento de 0 km entra en el histograma de profundidad?** — pregunta
      heredada, **de la Fase 1/5**, no de ésta. Se anota para que no se pierda.
