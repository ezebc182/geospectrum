# Tasks — Fase 2: fundaciones de interpretación

Change: `analytics-redesign`, **Fase 2 solamente** (`proposal.md:159`).
Spec fuente: `openspec/changes/analytics-redesign/specs/dashboard-ui/spec-fase-2-fundaciones-interpretacion.md`
(10 requirements).
Design fuente: `openspec/changes/analytics-redesign/design-fase-2-fundaciones-interpretacion.md`
(11 decisiones, 12 archivos, 10 pasos de construcción, 15 mutaciones).

Base: `main` en `41e7f5b` (Fase 1 mergeada, squash). Baseline de la suite: **1362 tests**.

Alcance en una frase: **se construyen la lib pura de reglas, sus tipos, el glosario
i18n y dos componentes de presentación, y NADA se cablea a ningún panel.**

> **Esta fase NO cambia un solo píxel de `/analytics`.** La página renderiza byte
> por byte lo mismo antes y después. El QA del usuario **no es una pantalla**: es
> **revisión de contenido** de las 5 definiciones del glosario en ES y EN (tarea 8.3).
> Si alguien busca un cambio visual, se le está pidiendo mal.

---

## Conflictos spec/design (resolver ANTES de escribir código)

La spec y el design **no coinciden** en cinco puntos. Ninguno es cosmético: tres
cambian el conjunto de reglas a implementar y dos cambian firmas. **No se elige en
silencio** — acá está cada uno con su resolución recomendada. Si el usuario no
objeta, se implementa la columna "Resolución"; cada tarea de abajo ya la asume y
la cita por número (C1…C5).

### C1 — El nombre del nivel medio de severidad: `warning` vs `caution`

| Fuente | Dice |
|---|---|
| Spec, Requirement "Tipos de la capa de advertencias" | `'critical' \| 'warning' \| 'info'` (y toda la tabla de reglas usa `warning`) |
| Design, Decisión 3 y el bloque de `Interfaces` | `'critical' \| 'caution' \| 'info'` |

**Resolución recomendada: `'critical' | 'warning' | 'info'` (la spec manda).**
Razones: (a) la spec es el contrato y el design es su implementación, no al revés;
(b) `warning` es el término que ya usa el token del repo — `--warning` /
`--warning-foreground` en `app/globals.css`, que es justo el token que el design
manda usar para ese nivel (Decisión 7); tener el token `warning` y el literal
`caution` obliga a una traducción mental en cada lectura; (c) el design mismo
escribe `border-warning/40 bg-warning/10 text-warning` en la fila que llama
`caution`. **El design se corrige acá, no la spec.**

### C2 — Cuántas reglas hay y cómo se llaman los ids

| Fuente | b-value | tremor | uptime |
|---|---|---|---|
| Spec | **6**: `mc-at-catalog-floor`, `mixed-magnitude-scales`, `unknown-magnitude-type`, `small-sample-above-mc`, `most-events-below-mc`, `derived-sigma-interval` | **4**: `median-baseline-masking`, `no-baseline`, `emergent-onset`, `undefined-band` | 1 regla de partición (no una advertencia) |
| Design | **4**: `b-value.mc-at-catalog-floor`, `b-value.mixed-magnitude-types`, `b-value.small-sample`, `b-value.derived-interval` | **3**: `tremor.no-baseline`, `tremor.baseline-masked`, `tremor.no-episodes` | **2 advertencias**: `uptime.channels-below-threshold`, `uptime.channels-unobserved` |

El design **pierde cuatro reglas que la spec declara obligatorias**
(`unknown-magnitude-type`, `most-events-below-mc`, `emergent-onset`,
`undefined-band`) e **inventa una que la spec no tiene** (`tremor.no-episodes`).

**Resolución recomendada: el catálogo de la spec es el piso obligatorio, con los
ids en el formato namespaceado del design.** Es decir: **10 reglas**, no 7 ni 11.

| Id final | Origen | Severidad final |
|---|---|---|
| `b-value.mc-at-catalog-floor` | ambos | `critical` |
| `b-value.mixed-magnitude-scales` | spec (nombre de la spec: "scales", no "types") | `warning` |
| `b-value.unknown-magnitude-type` | **solo spec** | `info` |
| `b-value.small-sample-above-mc` | spec (design la acorta a `small-sample`) | `warning` |
| `b-value.most-events-below-mc` | **solo spec** | `info` |
| `b-value.derived-sigma-interval` | spec (design la acorta a `derived-interval`) | `info` |
| `tremor.median-baseline-masking` | spec (design la llama `baseline-masked`) | `warning` |
| `tremor.no-baseline` | ambos | **`info`** (ver C3) |
| `tremor.emergent-onset` | **solo spec** | `info` |
| `tremor.undefined-band` | **solo spec** | `info` |

Se toman **los nombres de la spec** porque describen la condición
(`mixed-magnitude-scales` dice "escalas", que es el supuesto de Gutenberg-Richter
que se viola; `types` es el nombre del campo del backend, no del problema). Se
toma **el namespace del design** (`panel.regla`) porque cierra la Decisión 2: el id
es a la vez la clave i18n y no hace falta tabla de mapeo.

`tremor.no-episodes` del design **se descarta**: no está en la spec, que dice
"ninguna otra entra en esta fase", y "no hay episodios" no es una limitación de
lectura — es el resultado. Si el usuario la quiere, es un pedido nuevo.

### C3 — Severidad de `no-baseline`: `info` (spec) vs `caution` (design)

**Resolución recomendada: `info`, como dice la spec.** `baseline_rsam === null`
significa "no hubo muestras no nulas en la ventana", y la consecuencia visible ya
es que no se dibuja la línea de umbral. Es contexto que explica una ausencia, no un
supuesto debilitado. Además refuerza la Decisión 3 del propio design (`critical`
escaso, y `warning` reservado a "supuesto debilitado o muestra chica").

### C4 — Uptime: ¿partición en 3 grupos (spec) o dos advertencias con conteo (design)?

La spec pide una regla que **parta `overall` en tres grupos** (`a revisar`, `sano`,
`nunca observados`), con el grupo "a revisar" **ordenado de peor a mejor con
desempate por nombre ascendente** — y tiene cinco escenarios que assertean esa
forma (`el grupo a revisar es exactamente ["M","A","Z"]`). El design expone
`uptimeWarnings(overall): AnalyticsWarning[]` con dos advertencias que solo llevan
`count`. **Con la firma del design, cuatro de los cinco escenarios de la spec no se
pueden escribir.**

**Resolución recomendada: implementar LAS DOS, con la partición como fuente.**

```ts
export function partitionUptimeChannels(overall: Record<string, number | null>): {
  needsAttention: string[];   // ratio < 0.9, peor→mejor, desempate por nombre asc
  healthy: string[];
  unobserved: string[];
};
export function uptimeWarnings(overall: Record<string, number | null>): AnalyticsWarning[];
```

`uptimeWarnings` se implementa **encima** de `partitionUptimeChannels`
(`count: needsAttention.length` y `count: unobserved.length`), no en paralelo. Así
los cinco escenarios de la spec son testeables, la Fase 4 recibe la lista ordenada
que va a renderizar (que es lo que realmente necesita), y el contrato del design
—que la Fase 3/4 consume vía `AnalyticsWarning[]`— se cumple igual. Cero
duplicación de la lógica del umbral.

### C5 — `mc-at-catalog-floor`: ¿la condición incluye `mc !== null`?

Spec: `mc_at_catalog_floor === true`, punto. Design (tabla de reglas literales):
`mc_at_catalog_floor === true` **y** `mc !== null`.

**Resolución recomendada: seguir el design (`&& mc !== null`), pero SOLO porque el
mensaje interpola `{mc}`.** El design declara `params: { mc: number }`; con
`mc: null` la clave i18n renderizaría "Mc coincide…" con un hueco. La spec no lo
contempla porque no habla de `params`. **Se documenta en el JSDoc de la regla** y
se le escribe un test explícito (`mc_at_catalog_floor: true` con `mc: null` ⇒ no
emite), para que la divergencia quede registrada y no parezca un olvido.

**Nada más diverge.** Los umbrales coinciden en los dos documentos:
`NORMAL_95_FACTOR = 1.96`, `UPTIME_ATTENTION_THRESHOLD = 0.9`,
`SMALL_SAMPLE_FACTOR = 1.5`, `TREMOR_BASELINE_MASK_FRACTION = 0.5`. El `0.3` de
`emergent-onset` solo aparece en la spec (el design perdió la regla): se nombra
`EMERGENT_ONSET_RATIO = 0.3`.

> **`SMALL_SAMPLE_FACTOR = 1.5` no tiene respaldo del usuario** — el design lo dice
> en sus Open Questions. Es el único umbral de la fase elegido por el equipo. No
> bloquea, pero se re-confirma en el QA de la Fase 3 con datos reales.

---

## Preflight (una vez, en CADA shell de esta fase)

Node del shell es v12:

```
export PATH="$HOME/.nvm/versions/node/v22.16.0/bin:$PATH"
```

Correr siempre `./node_modules/.bin/vitest` desde `dashboard/`. **NUNCA `npx`**
(baja un vitest ajeno de internet). **NUNCA `next build`** (comparte `.next` con el
server de dev y lo rompe; además el usuario prohíbe buildear).

Convención del repo: **identificadores en inglés, comentarios y prosa en español.**

### El estándar de verificación de esta fase

**Verde no es evidencia. Rojo por mutación sí.** Es especialmente cierto acá
porque —como dice el design— la fase termina con la suite en verde sobre código
que **nadie consume todavía**: sin mutación no hay forma de distinguir una lib
correcta de una lib que nunca se ejecutó.

Por eso cada tarea de código lleva el ciclo completo:

1. **RED** — escribir el test que falla (la función no existe o devuelve otra cosa).
2. **GREEN** — escribir el código mínimo que lo pone verde.
3. **MUTAR** — aplicar la mutación nombrada en la columna correspondiente, con
   `Edit` (nunca `sd`: `sd -s` con `\n` en el patrón no matchea y sale exit 0
   dejando el archivo intacto), verificar **`git diff --stat` NO vacío ANTES** de
   correr, correr, anotar el `it` exacto y el mensaje del rojo.
4. **REVERTIR** — `git checkout -- <archivo>`, re-correr, confirmar verde y
   `git status --porcelain` limpio.

Una mutación que no cambió el archivo no prueba nada y su verde es basura.

### Lo que jsdom NO puede verificar (y por eso ninguna tarea lo promete)

**jsdom no hace layout.** Todo mide 0×0, `overflow` no recorta, `hsl(var(--token))`
no se resuelve contra la cascada. Consecuencias, literales:

- **No se testea contraste.** Se testea que el elemento **declare** la clase
  (`toHaveClass('text-destructive')`). Que dé 4.5:1 no lo dice ningún unit test.
- **No se testea que el popover no quede recortado.** El `Portal` y el `z-[1100]`
  son inverificables por unit test: el contenido puede estar en el DOM y estar
  igual invisible en pantalla. Se testea que el componente **declare** el Portal.
- **No se testea posición ni foco visible.**

Ningún criterio de aceptación de abajo dice "se ve bien". Los que lo dirían están
en la Fase 3, donde los componentes viven en su contexto real.

### Interacción con Radix: `fireEvent.click` es verde falso

Lección ya pagada en este repo con Radix Tabs: `fireEvent.click` sobre un trigger
de Radix **no dispara el cambio de estado**. Para abrir el Popover va `userEvent`
(que emite `pointerdown` → `mousedown` → `click`) o
`fireEvent.pointerDown` + `fireEvent.mouseDown`. **Un test que use
`fireEvent.click` pelado y pase tiene que sospecharse**: o el popover ya estaba
abierto, o el assert no mira nada.

---

# BLOQUE A — lib + tipos + contenido i18n (sin React)

Pasos 1-6 del orden de construcción del design. **Este bloque es un PR completo y
mergeable solo**: no toca ni un `.tsx` de app y la suite queda verde. Es el corte
natural que el design sugiere (entre el paso 6 y el 7).

## Grupo 1: Tipos, constantes y `derivedBInterval`

- [ ] **1.1 (RED)** Crear `dashboard/lib/analytics-warnings.test.ts` con los casos de
  `derivedBInterval` y de las constantes, **antes** de que exista el módulo:
  1. `NORMAL_95_FACTOR` es `1.96`, `UPTIME_ATTENTION_THRESHOLD` es `0.9`,
     `SMALL_SAMPLE_FACTOR` es `1.5`, `TREMOR_BASELINE_MASK_FRACTION` es `0.5`,
     `EMERGENT_ONSET_RATIO` es `0.3`.
  2. `derivedBInterval(1.0, 0.1)` → `{ low: 0.804, high: 1.196 }` con
     `toBeCloseTo` (punto flotante: `1 - 1.96*0.1` no da `0.804` exacto).
  3. `derivedBInterval(0.9, 0)` → `{ low: 0.9, high: 0.9 }` — el intervalo colapsa
     pero la función no falla (spec, escenario "Con `sigma_b` en cero…").
  4. El cálculo usa la constante: `derivedBInterval(b, s)` coincide con
     `b ± NORMAL_95_FACTOR * s` computado en el test **desde la constante importada**,
     no contra `1.96` escrito a mano.
  - *Aceptación*: el archivo falla por módulo inexistente. Ese es el rojo correcto.
  - *Spec*: Requirement "Catálogo de reglas de advertencia de b-value" (párrafo del
    factor `1.96`).

- [ ] **1.2 (GREEN)** Crear `dashboard/lib/analytics-warnings.ts` con **solo** los
  tipos, las constantes y `derivedBInterval`. Sin las funciones de reglas todavía.
  - `import type { BValueResponse, TremorResponse } from './analytics';` —
    **solo tipos**, nunca el transporte (el módulo trae `fetch`/`ApiStatusError`;
    arrastrarlo mataría la pureza). Molde: `lib/uptime-series.ts:16`.
  - `export type WarningSeverity = 'critical' | 'warning' | 'info';` (**C1**).
  - `interface WarningBase<Id extends string, P extends object>` con
    `readonly id: Id`, `readonly severity: WarningSeverity`, `readonly params: P`.
  - Los 10 miembros de la unión discriminada por `id` (**C2**), con `params`
    tipado **por miembro** — no `Record<string, unknown>`. Las reglas sin
    interpolación llevan `Record<string, never>`.
  - `export type AnalyticsWarning = …` (unión) y
    `export type AnalyticsWarningId = AnalyticsWarning['id'];`
  - Las 5 constantes, **cada una con docstring en español que diga el supuesto**.
    La de `NORMAL_95_FACTOR` MUST decir que `sigma_b` es σ de Shi & Bolt (1982) y
    **no** un intervalo de confianza del backend.
  - `derivedBInterval(b: number, sigmaB: number): { low: number; high: number }`
    — devuelve **números**, nunca string formateado: el locale es del componente.
  - **PROHIBIDO** el identificador `confidenceInterval` en cualquier forma: el
    nombre del código se filtra a la prosa (design, Decisión 10).
  - *Aceptación*: 1.1 en verde. `rg -i 'confidence' dashboard/lib/analytics-warnings.ts`
    → 0 matches. `rg "from 'react'|next-intl" dashboard/lib/analytics-warnings.ts`
    → 0 matches (la lib es pura).
  - *Spec*: Requirement "Tipos de la capa de advertencias".

- [ ] **1.3 (MUTACIÓN 2.4)** `NORMAL_95_FACTOR = 1.96` → `2`.
  - *Aceptación*: falla el caso 2 de 1.1 (`derivedBInterval(1.0, 0.1)` deja de dar
    `{0.804, 1.196}`). **El caso 4 NO debe fallar** — compara contra la constante,
    así que muta con ella; eso está bien y hay que anotarlo: es el caso que prueba
    que el código usa la constante, no el que prueba su valor.
  - *Protocolo*: `git diff --stat` no vacío antes de correr. Revertir y confirmar verde.

## Grupo 2: Las reglas de b-value

- [ ] **2.1 (RED)** Extender `analytics-warnings.test.ts` con los escenarios de
  b-value de la spec, uno por `it`, sobre `bValueWarnings(response)`:
  1. Respuesta sana (`status:'ok'`, `mc_at_catalog_floor:false`, una sola escala,
     `n_above_mc` holgado, `n_above_mc/n_total >= 0.5`) → **array vacío salvo**
     `b-value.derived-sigma-interval`, que con `status:'ok'` dispara **siempre**.
     *Anotar el matiz*: el escenario 1 de la spec dice "array vacío", pero esa misma
     spec declara `derived-sigma-interval` con condición "`status === 'ok'` (siempre
     que haya estimación)". El caso "array literalmente vacío" solo existe con
     `status !== 'ok'` y sin otros disparadores. El test cubre **los dos**.
  2. `mc_at_catalog_floor: true` (con `mc` numérico) → aparece
     `b-value.mc-at-catalog-floor` con severidad `critical`. Con `false` desaparece
     **y ninguna otra la reemplaza** (assertear el largo, no solo la ausencia).
  3. **(C5)** `mc_at_catalog_floor: true` con `mc: null` → **no** emite. Comentario
     en el test explicando que es divergencia deliberada spec/design.
  4. `mag_type_counts: { ml:120, mw:30 }` → `mixed-magnitude-scales` `warning`, y
     los `params` permiten nombrar las dos escalas y sus conteos.
  5. `{ ml: 150 }` → no aparece `mixed-magnitude-scales`.
  6. `{ ml:100, unknown:8 }` → aparecen **ambas**, y `mixed-magnitude-scales`
     **precede** a `unknown-magnitude-type` (severidad).
  7. `{ ml:100, unknown:0 }` → **no** `unknown-magnitude-type`; **sí**
     `mixed-magnitude-scales` (dos claves declaradas).
  8. `{}` → ninguna regla de escalas, y no lanza.
  9. `status:'ok'`, `min_events:50`, `n_above_mc:60` → `small-sample-above-mc` `warning`.
  10. `n_above_mc:75` → no aparece; `n_above_mc:74` → **sí** (corte `< min*1.5`).
      Los dos en el mismo `it`: es el borde exacto.
  11. `min_events:0`, `n_above_mc:3` → no dispara, y **ningún `params` contiene
      `NaN` ni `Infinity`** (assertearlo explícitamente sobre todos los valores).
  12. `n_total:400`, `n_above_mc:120` → `most-events-below-mc` `info`.
  13. `n_total:0`, `n_above_mc:0` → no aparece `most-events-below-mc`, sin `NaN`, no lanza.
  14. `status:'ok'`, `b:1.0`, `sigma_b:0.1` → `derived-sigma-interval` con
      `params.low`/`params.high` en `0.804`/`1.196` (`toBeCloseTo`).
  15. `status:'insufficient'` → **no** aparecen `derived-sigma-interval` ni
      `small-sample-above-mc`; **sí** pueden aparecer `mc-at-catalog-floor` y las
      de escalas.
  16. **Orden determinista**: una respuesta que dispara un `critical` y dos `info`
      evaluada **dos veces** devuelve la misma secuencia, con el `critical` primero.
  17. **`critical` es escaso**: recorriendo el catálogo completo de reglas, la
      **única** que puede emitir `critical` es `mc-at-catalog-floor`. Es el test que
      hace verificable el riesgo "si todo advierte, nada advierte".
  18. **La lib no traduce**: ninguna advertencia contiene una frase en español ni
      en inglés — los `params` son `string | number` y los strings admitidos son
      nombres de escala/canal, nunca prosa. Asserteable como "ningún valor contiene
      un espacio seguido de una letra acentuada" es frágil: **mejor** assertear que
      cada advertencia tiene exactamente las claves `id`/`severity`/`params` y que
      el objeto no tiene ninguna propiedad `message`/`text`/`label`.
  - *Aceptación*: todos rojos (la función no existe).
  - *Spec*: Requirements "Lib pura de reglas de confiabilidad" y "Catálogo de reglas
    de advertencia de b-value" (los 12 escenarios).

- [ ] **2.2 (GREEN)** Implementar `bValueWarnings(response: BValueResponse)` en
  `analytics-warnings.ts`, más el helper de orden.
  - Las 6 reglas del catálogo final (**C2**), **en el orden de declaración** de la
    tabla de C2; el `sort` es **estable por severidad** (`critical` → `warning` →
    `info`) y **no reordena** dentro del nivel. Nunca `Object.keys` como fuente de
    orden (design, Decisión 9; spec, Decisión 7).
  - `small-sample-above-mc` y `derived-sigma-interval` viven **dentro del narrow
    `status === 'ok'`**: `sigma_b` solo existe en `BValueOk` (`analytics.ts:76`).
    No se defiende con `?.` — se apoya en que **no compila** de otra forma.
  - `min_events * SMALL_SAMPLE_FACTOR` con `min_events: 0` da `0` y
    `n_above_mc < 0` es falso ⇒ no dispara solo. **No hace falta un `if` extra**,
    pero sí el test 11 que lo fija.
  - `most-events-below-mc` guarda `n_total > 0` **antes** de dividir.
  - *Aceptación*: los 18 casos de 2.1 en verde. `derivedBInterval` reusada, no
    reimplementada inline.

- [ ] **2.3 (MUTACIÓN 2.1)** `mc_at_catalog_floor === true` → `=== false`.
  - *Aceptación*: falla el caso 2 de 2.1. Anotar `it` y mensaje.

- [ ] **2.4 (MUTACIÓN 2.2)** en esa misma regla, `severity: 'critical'` → `'warning'`.
  - *Aceptación*: **dos rojos obligatorios** — el assert de severidad del caso 2
    **y** el caso 17 ("solo una regla emite `critical`"). Si solo cae uno, el caso
    17 no protege lo que dice.

- [ ] **2.5 (MUTACIÓN nueva, exigida por la spec)** `Object.keys(...).length > 1`
  → `> 0` en `mixed-magnitude-scales`.
  - *Aceptación*: falla el caso 5 (una sola escala no advierte). Es el punto 2 de
    las ocho mutaciones mínimas de la spec, que el design **no** listó.

- [ ] **2.6 (MUTACIÓN 2.6)** quitar el `sort` por severidad.
  - *Aceptación*: falla el caso 16. Si queda verde, el orden lo estaba dando el
    orden de los `if` por casualidad y el contrato no está protegido.

## Grupo 3: Las reglas de tremor

- [ ] **3.1 (RED)** Extender el test con los escenarios de tremor sobre
  `tremorWarnings(response)`:
  1. `tremor_fraction: 0.62` → `median-baseline-masking` `warning`; con `0.5`
     exacto **no** aparece (corte estrictamente `>`). Los dos en el mismo `it`.
  2. `baseline_rsam: null`, `threshold_rsam: null` → `no-baseline` con severidad
     **`info`** (**C3**).
  3. `baseline_rsam: 0`, `threshold_rsam: 0` → **NO** aparece `no-baseline`.
     Comentario en el test: es la invariante `null ≠ 0` que `analytics.ts` y
     `src/models/analytics.py:11-15` declaran; convertir `null` en `0` acá
     reintroduciría del lado del frontend el bug que el backend evita a propósito.
  4. `episodes: []` → no aparecen `emergent-onset` ni `undefined-band`, y no lanza.
  5. Dos episodios con `onset_ratio` `0.8` y `0.12` → `emergent-onset` **una sola
     vez**, no una por episodio (assertear el conteo de ocurrencias del id).
  6. Un episodio con `band: 'undefined'` entre varios → `undefined-band` una vez.
  7. Ninguna banda `'undefined'` → no aparece.
  - *Spec*: Requirement "Catálogo de reglas de advertencia de tremor" (5 escenarios).

- [ ] **3.2 (GREEN)** Implementar `tremorWarnings(response: TremorResponse)` con las
  4 reglas de C2. `no-baseline` compara `=== null` **explícito**, nunca
  `!baseline_rsam`. Las dos reglas por episodio usan `.some(...)` — una advertencia
  por regla, no por episodio.
  - *Aceptación*: los 7 casos verdes.

- [ ] **3.3 (MUTACIÓN 2.7)** `tremor_fraction > 0.5` → `> 0.9`.
  - *Aceptación*: falla el caso 1 (`0.62` deja de emitir).

- [ ] **3.4 (MUTACIÓN nueva, exigida por la spec)** `>` → `>=` en
  `median-baseline-masking`.
  - *Aceptación*: falla la mitad "`0.5` exacto no aparece" del caso 1. Es el punto 6
    de las ocho mínimas de la spec.

- [ ] **3.5 (MUTACIÓN 2.5 / punto 5 de la spec)** `baseline_rsam === null` →
  `!baseline_rsam`.
  - *Aceptación*: falla el caso 3 (la línea base en cero empieza a emitir
    `no-baseline`). Es la mutación que prueba que `null ≠ 0` está protegido.

## Grupo 4: Uptime — partición y advertencias

- [ ] **4.1 (RED)** Extender el test con los escenarios de uptime sobre
  `partitionUptimeChannels(overall)` y `uptimeWarnings(overall)` (**C4**):
  1. `{ A:0.89, B:0.9, C:0.91 }` → `needsAttention` contiene `A`; `B` y `C` en
     `healthy` (corte **estrictamente** `< 0.9`).
  2. `{ A:null, B:0.0 }` → `B` en `needsAttention`; `A` en `unobserved`,
     **separado** de los otros dos grupos. Assertear que `A` **no** está en
     `needsAttention` ni en `healthy`.
  3. `{ Z:0.5, A:0.5, M:0.2 }` → `needsAttention` es **exactamente** `['M','A','Z']`
     (peor→mejor, desempate por nombre ascendente).
  4. Todos `>= 0.9` → `needsAttention` es `[]`, **y eso no es un error**: una lista
     vacía es el resultado correcto.
  5. `{}` → los tres grupos son `[]`.
  6. `uptimeWarnings` emite `channels-below-threshold` con
     `count === needsAttention.length` y `channels-unobserved` con
     `count === unobserved.length`, y **no emite** la advertencia cuyo grupo esté vacío.
  7. Un `null` **nunca** suma a `channels-below-threshold`: con `{A:null}` el conteo
     de `below-threshold` es 0 y no existe esa advertencia.
  - *Spec*: Requirement "Regla de umbral de uptime «qué mirar hoy»" (5 escenarios).

- [ ] **4.2 (GREEN)** Implementar `partitionUptimeChannels` y, **encima de ella**,
  `uptimeWarnings` (**C4** — cero duplicación del umbral).
  - Comentario en español sobre `unobserved` explicando por qué es un grupo aparte,
    citando `src/services/station_uptime.py` y `lib/uptime-series.ts:5-13`.
  - Orden: `sort` por ratio ascendente con desempate `localeCompare` (o comparación
    de strings) por nombre — determinista, no dependiente de `Object.keys`.
  - *Aceptación*: los 7 casos verdes.

- [ ] **4.3 (MUTACIÓN 2.3 / punto 4 de la spec)** `UPTIME_ATTENTION_THRESHOLD = 0.9`
  → `0.95`.
  - *Aceptación*: falla el caso 1 (`B:0.9` y `C:0.91` pasan a `needsAttention`).
    El mensaje de error debe decir el valor esperado, no solo "expected true".

- [ ] **4.4 (MUTACIÓN 2.5-bis / punto 5 de la spec, variante uptime)** en
  `partitionUptimeChannels`, tratar `ratio === null` como `0`.
  - *Aceptación*: **dos rojos** — el caso 2 (`A` deja de estar en `unobserved`) y el
    caso 7 (`A` empieza a contar en `below-threshold`). Es la invariante `null ≠ 0`
    del lado del uptime.

## Grupo 5: El catálogo de términos del glosario (TS)

- [ ] **5.1 (RED)** Crear `dashboard/lib/glossary.test.ts`:
  1. `GLOSSARY_TERM_IDS` tiene **exactamente 5** entradas y coincide con las claves
     de `GLOSSARY_MESSAGE_KEYS`.
  2. Para cada id, `GLOSSARY_MESSAGE_KEYS[id]` existe y es no vacío.
  3. **Ningún id** del glosario es `sigma_b`, `onset_ratio`, `fi_sign` ni
     `tremor_fraction` (decisión 1 de la spec, hecha test).
  - *Spec*: Requirement "Glosario v1 de exactamente cinco términos".

- [ ] **5.2 (GREEN)** Crear `dashboard/lib/glossary.ts` con
  `GlossaryTermId` (unión cerrada de `'b-value' | 'mc' | 'rsam' | 'fi' | 'uptime-ratio'`),
  `GLOSSARY_TERM_IDS` (`readonly`, `as const`) y
  `GLOSSARY_MESSAGE_KEYS: Record<GlossaryTermId, string>` mapeando kebab→camelCase.
  Docstring en español explicando por qué la tabla es explícita y no un
  `camelCase()` genérico (design, Decisión 6).
  - *Aceptación*: 5.1 en verde. Sin prosa de definiciones en este archivo: el
    contenido vive en i18n (Decisión 5).

- [ ] **5.3 (MUTACIÓN 2.15)** borrar `'fi'` del `Record` (dejando la unión intacta).
  - *Aceptación*: **dos rojos, y uno de ellos NO es vitest.**
    (a) `./node_modules/.bin/tsc --noEmit` falla: el `Record` tipado por la unión no
    compila si falta una entrada — es la única mutación de la fase que se verifica
    con el compilador, y es el chequeo de que la unión cerrada de la Decisión 6
    realmente aprieta. (b) el caso 1 de 5.1 (conteo/coincidencia).
  - *Nota*: correr `tsc --noEmit`, **no** `next build`.

## Grupo 6: Contenido i18n (glosario + mensajes de advertencia)

- [ ] **6.1** Agregar a `dashboard/messages/es.json` **y** `dashboard/messages/en.json`,
  **en el mismo commit** (si no, `parity.test.ts` se pone roja sola):
  - `analytics.glossary`: `trigger` (aria-label, interpola `{term}`), `close`, y los
    **5 términos** en camelCase (`bValue`, `mc`, `rsam`, `fi`, `uptimeRatio`), cada
    uno con `term` + `definition` y `note` **opcional**. Contenido según la tabla del
    Requirement "Glosario v1" de la spec.
  - `analytics.warnings`: **10 claves**, una por id de C2, con el mismo path que el
    id (`analytics.warnings.b-value.mc-at-catalog-floor`, etc.) y los placeholders
    que cada `params` declara.
  - **Reglas duras del contenido**:
    - `note` es opcional **en el contenido, no en la forma**: si un término no la
      necesita, la clave **no existe en ninguno de los dos idiomas**. Un `note: ""`
      hace fallar la regla de "ningún valor vacío" de `parity.test.ts` — bien: string
      vacío es basura, no ausencia.
    - Redacción en modo **"esto significa X"**, nunca **"está pasando X"**.
    - La clave de `derived-sigma-interval` MUST rotular el intervalo como
      **derivado bajo supuesto de normalidad** y MUST NOT decir "intervalo de
      confianza" / "confidence interval".
    - Las claves de `emergent-onset` y `median-baseline-masking` explican
      `onset_ratio` y `tremor_fraction` **dentro de su propio texto**: no tienen
      entrada de glosario a propósito (decisión 1).
    - **Solo agrega**: ninguna clave existente de `analytics.*` se renombra, se
      mueve ni se borra.
  - *Aceptación*: `./node_modules/.bin/vitest run messages/parity.test.ts` verde.
    `git diff` de los dos JSON muestra **solo líneas agregadas** (`+`), cero `-`
    fuera de las comas de cierre de bloque.
  - *Spec*: Requirements "Glosario v1…" y "Toda clave nueva explica la métrica…".

- [ ] **6.2 (RED→GREEN)** Crear
  `dashboard/components/analytics/interpretation-copy.test.ts` — el test de **límite
  de dominio** sobre las claves i18n. Va **acá y no al final**: si la prosa cruza la
  línea, mejor enterarse antes de construir componentes sobre ella.
  - Importa `messages/es.json` y `messages/en.json` **directos** (no vía provider),
    aplana los subárboles `analytics.glossary` y `analytics.warnings`, y recorre
    **todos** los strings de **los dos locales**.
  - Lista de términos prohibidos, **case-insensitive**, como mínimo (spec):
    `tremor volcánico`, `volcanic tremor`, `erupción`, `eruption`, `enjambre`,
    `swarm`, `precursor`, `inminente`, `imminent`, `predice`, `predicts`.
    Sumar del design: `volcán`, `volcánico`, `volcanic`, `premonitor`.
  - Caso aparte para el par **`intervalo de confianza` / `confidence interval`**,
    con su propio `it` y su propio mensaje: es un riesgo distinto (confundir σ con
    un IC) y merece un rojo que lo diga.
  - El mensaje de fallo MUST nombrar **la clave** y **el término** encontrados, no
    solo "falló": un rojo que no dice qué clave no sirve para arreglar nada.
  - **Cobertura del test, asserteable**: un `it` que verifique que el recorrido
    tocó **al menos N strings** (N = el conteo real al escribirlo). Sin ese piso,
    un typo en el path del subárbol dejaría el test verde iterando sobre cero —
    exactamente el modo de fallo que la Fase 1 encontró en `chart-chrome.test.ts`.
  - *Aceptación*: verde con el contenido de 6.1.
  - *Spec*: Requirement "Toda clave nueva explica la métrica y no diagnostica el
    fenómeno" (4 escenarios).

- [ ] **6.3 (MUTACIÓN 2.13 / punto 7 de la spec)** meter
  `"…esto indica tremor volcánico…"` dentro de una `definition` de `es.json`.
  - *Aceptación*: falla `interpretation-copy.test.ts` **nombrando la clave y el
    término**. Verificar que el mensaje efectivamente los nombra; si dice solo
    "expected false to be true", el test está mal escrito y hay que arreglarlo.

- [ ] **6.4 (MUTACIÓN nueva — variante EN del punto 7)** meter `imminent` en una
  clave **solo de `en.json`**.
  - *Aceptación*: falla igual. Es el escenario "El test cubre los dos idiomas" de
    la spec, que ni el design ni la lista de 15 mutaciones cubría: la 2.13 solo
    muta español.

- [ ] **6.5 (MUTACIÓN 2.14 / punto 8 de la spec)** renombrar una clave nueva en
  `en.json` sin tocar `es.json`.
  - *Aceptación*: falla `messages/parity.test.ts` (que **no se modifica** en esta
    fase: se cumple, no se toca) indicando la clave ausente.

- [ ] **6.6 (MUTACIÓN nueva — punto 8 de la spec, primera mitad)** agregar una
  **sexta** entrada al glosario, en los dos idiomas.
  - *Aceptación*: falla el caso 1 de `glossary.test.ts`… **solo si ese test cuenta
    contra el JSON**. Con `GLOSSARY_TERM_IDS` puro TS no lo hace.
    **Por eso 5.1 necesita un caso extra**: un `it` que compare el set de claves de
    `analytics.glossary` en `es.json` (excluyendo `trigger`/`close`) contra
    `GLOSSARY_MESSAGE_KEYS`, en **las dos direcciones**. Agregar esta tarea implica
    volver a 5.1 y sumarle ese caso — hacerlo **antes** de correr esta mutación.
  - *Aceptación (segunda mitad)*: agregar la sexta entrada **en un solo idioma** hace
    fallar **además** `parity.test.ts`.

- [ ] **6.7** Correr la suite completa y confirmar el estado del BLOQUE A.
  `export PATH="$HOME/.nvm/versions/node/v22.16.0/bin:$PATH" && cd dashboard && ./node_modules/.bin/vitest run`
  - *Aceptación*: 0 fallos, total **estrictamente mayor** que 1362.
  - *Aceptación*: `git diff --name-only` del bloque toca **exactamente 7 archivos**:
    `lib/analytics-warnings.ts`, `lib/analytics-warnings.test.ts`, `lib/glossary.ts`,
    `lib/glossary.test.ts`, `components/analytics/interpretation-copy.test.ts`,
    `messages/es.json`, `messages/en.json`. **Ningún `.tsx` de app, nada de `src/`.**
  - *Aceptación*: `./node_modules/.bin/tsc --noEmit` sin errores.
  - **Corte de PR sugerido acá** (design: "el corte natural es entre 6 y 7"). El
    BLOQUE A mergea solo: agrega código que nadie consume y contenido i18n que nadie
    lee todavía. Cero riesgo de regresión visual, porque no hay render.

---

# BLOQUE B — componentes de presentación

Pasos 7-9 del orden de construcción. Segundo PR. Sigue sin cablearse a ningún panel.

## Grupo 7: El wrapper de Popover

- [ ] **7.1** Crear `dashboard/components/ui/popover.tsx`, wrapper de `Popover` del
  paquete unificado **`radix-ui`** (`import { Popover as PopoverPrimitive } from "radix-ui"`),
  calcado del molde de `dashboard/components/ui/tooltip.tsx` — **del archivo
  existente, no de la doc de shadcn**. Dos detalles se copian a propósito:
  1. **`Portal`**: sin él, un popover dentro de un contenedor con `overflow-y-auto`
     (el `max-h-56` del ranking de uptime, `StationUptimeChart.tsx:167`) sale
     **recortado**. Ese bug ya mordió en este repo (commit `42fa3bb`).
  2. **`z-[1100]`**: el comentario de `tooltip.tsx:45` documenta que es un fix
     sistémico para ganarle a los `z-[1000]` de Leaflet. El `z-50` del molde de
     shadcn reproduciría el bug exacto en el tab con mapa.
  - Clases tematizadas por token (`bg-popover text-popover-foreground border-border`),
    **cero hex**.
  - **Sin `forceMount`** en ninguna parte.
  - *Aceptación*: `rg '@radix-ui/react-' dashboard/components/ui/popover.tsx` → 0
    matches (es el paquete unificado). `rg '#[0-9a-fA-F]{3,8}' …/popover.tsx` → 0.
    `rg 'z-\[1100\]|Portal' …/popover.tsx` → ambos presentes.
  - *Nota honesta*: que el Portal y el z-index **funcionen** es inverificable en
    jsdom. Acá solo se verifica que estén **declarados**. Lo demás va al QA de la
    Fase 3, con instrucción explícita de abrir un término dentro del ranking de
    uptime y sobre el tab con mapa.

## Grupo 8: `AnalyticsWarning`

- [ ] **8.1 (RED)** Crear
  `dashboard/components/analytics/AnalyticsWarning.test.tsx` con
  `@testing-library/react` + **`IntlTestProvider` de `@/lib/test-intl`** (nunca
  `NextIntlClientProvider` a mano: pasar `timeZone` en un test es el falso verde que
  ese helper vino a matar):
  1. Una advertencia de **cada** severidad: cada una expone su severidad de forma
     accesible al lector de pantalla (texto de severidad alcanzable, no solo color)
     **y** renderiza un icono con `aria-hidden`. Assertear las **dos** cosas: es el
     escenario "no depende únicamente del color".
  2. `role`: `critical` → `role="alert"`; `warning` e `info` → `role="status"`.
  3. **Lista vacía** → el componente **no renderiza ningún contenedor ni separador**
     en el DOM. Assertear `container.firstChild === null` (o `toBeEmptyDOMElement`),
     no "no hay texto".
  4. El texto sale de i18n: una advertencia con `params` renderiza la clave resuelta
     **con esos valores interpolados**, y el literal **no** está escrito en el `.tsx`.
     Verificar lo segundo con una lectura del fuente (`readFileSync` + `not.toMatch`),
     igual que hace `chart-chrome.test.ts`: un assert de DOM solo no distingue "salió
     de i18n" de "está hardcodeado y coincide".
  5. **Cero hex** en el fuente del componente. Este test es **necesario** porque
     `chart-chrome.test.ts` **NO** cubre este archivo: su criterio de descubrimiento
     es "importa `recharts`", y este componente no lo importa a propósito.
  6. Las clases de color son **tokens declarados** (`toHaveClass('text-destructive')`),
     no valores computados. jsdom no resuelve `hsl(var(--token))`: lo que se verifica
     es la **declaración**, y el contraste real lo ve el usuario.
  - *Spec*: Requirement "Componente de advertencia reutilizable" (3 escenarios).

- [ ] **8.2 (GREEN)** Crear `dashboard/components/analytics/AnalyticsWarning.tsx`.
  - `switch (warning.id)` para narrowar `params` al shape exacto de esa regla — es
    el mecanismo que ata el contrato lib↔clave i18n en compile-time (Decisión 2).
  - Severidad → token + icono + `role`, según la tabla de la Decisión 7 del design,
    **con `caution` renombrado a `warning`** (**C1**):
    | Severidad | Clases | Icono `lucide-react` | `role` |
    |---|---|---|---|
    | `critical` | `border-destructive/40 bg-destructive/10 text-destructive` | `TriangleAlert` | `alert` |
    | `warning` | `border-warning/40 bg-warning/10 text-warning` | `AlertCircle` | `status` |
    | `info` | `border-border bg-muted text-muted-foreground` | `Info` | `status` |
  - Comentario en español explicando por qué **solo** `critical` lleva `role="alert"`:
    `alert` es una live region assertive que interrumpe al lector de pantalla; cuatro
    `info` en `alert` convierten la página en un atropello sonoro.
  - El icono lleva `aria-hidden`: su significado ya está en el texto.
  - **No recibe `className` ni `variant`**: la severidad determina la apariencia y un
    override externo permitiría pintar un `critical` de gris. El espaciado lo pone el
    contenedor (que es Fase 3).
  - **No importa `recharts`** — a propósito.
  - *Aceptación*: los 6 casos de 8.1 verdes.
  - *Aceptación*: `./node_modules/.bin/vitest run components/analytics/chart-chrome.test.ts`
    sigue descubriendo **exactamente 7** archivos y pasa **sin modificaciones**.

- [ ] **8.3 (MUTACIÓN 2.8)** `role` de `critical`: `'alert'` → `'status'`.
  - *Aceptación*: falla el caso 2 de 8.1.

- [ ] **8.4 (MUTACIÓN 2.9)** quitar el icono (dejar solo texto y color).
  - *Aceptación*: falla el caso 1 ("no depende solo del color"): no encuentra el
    icono con `aria-hidden`.

- [ ] **8.5 (MUTACIÓN 2.10)** `text-destructive` → `text-[#ef4444]`.
  - *Aceptación*: falla el caso 5 (prohibición de hex) **y/o** el 6 (token
    declarado). Anotar cuál(es). Es la mutación que prueba que el hueco de
    `chart-chrome.test.ts` está tapado **por el test propio del componente**.

## Grupo 9: `GlossaryTerm`

- [ ] **9.1 (RED)** Crear `dashboard/components/analytics/GlossaryTerm.test.tsx`,
  con `IntlTestProvider` y **`userEvent`, nunca `fireEvent.click` pelado**:
  1. Renderizado para `'b-value'`: el trigger es un `role="button"` real, con
     nombre accesible que sale de `analytics.glossary.trigger`.
  2. **Apertura por teclado**: el trigger recibe foco y se activa con Enter/Space →
     la definición queda disponible. **Al cerrar con Esc, el foco vuelve al trigger.**
  3. **Contenido cerrado no expuesto**: con el popover cerrado, la definición **no
     está en el DOM** (`queryByText(...)` → `null`). Es el assert que mata
     `forceMount`.
  4. **El mismo término desde dos lugares**: dos instancias con `id="mc"` abiertas
     muestran **exactamente el mismo texto**, resuelto de la misma clave. Una entrada
     de i18n, N invocaciones.
  5. **Cero hex** en el fuente y **cero `forceMount`** (lectura del fuente).
  - *Spec*: Requirement "Componente de término de glosario reutilizable" (4 escenarios).

- [ ] **9.2 (GREEN)** Crear `dashboard/components/analytics/GlossaryTerm.tsx`.
  - Firma: `{ id: GlossaryTermId; label?: string }`. `id` tipado con la unión cerrada
    de `lib/glossary.ts`: pedir `'sigma_b'` **no compila** (escenario de la spec), no
    falla en runtime.
  - Resuelve la clave vía `GLOSSARY_MESSAGE_KEYS[id]` y `useTranslations`. Renderiza
    `term`, `definition` y —**solo si existe**— `note`.
  - Trigger `<button>` real dentro del `Popover.Trigger` (`asChild`): Enter/Space
    abre, Esc cierra, el foco entra al contenido y vuelve al trigger. Es todo
    comportamiento de Radix; el componente no lo reimplementa.
  - **Sin `forceMount`**, en ninguna forma. Lección registrada en este repo.
  - Sin `t.rich`: las definiciones son párrafos planos (Decisión 5).
  - *Aceptación*: los 5 casos de 9.1 verdes.

- [ ] **9.3 (MUTACIÓN 2.11)** `<button>` → `<span onClick>`.
  - *Aceptación*: falla el caso 1 (`role="button"`) y/o el 2 (apertura con Enter).
    Anotar cuál(es): si **solo** cae el 1, el caso 2 no está probando el teclado y
    hay que reescribirlo.

- [ ] **9.4 (MUTACIÓN 2.12)** agregar `forceMount` al `Content`.
  - *Aceptación*: falla el caso 3 (contenido presente en el DOM con el popover
    cerrado). Si queda verde, el caso 3 está mirando visibilidad en vez de presencia
    — y jsdom no mide visibilidad: sería verde falso.

---

# BLOQUE C — cierre

- [ ] **10.1** **Suite completa en verde.**
  `export PATH="$HOME/.nvm/versions/node/v22.16.0/bin:$PATH" && cd dashboard && ./node_modules/.bin/vitest run`
  - *Aceptación*: 0 fallos, 0 saltados. Total **estrictamente mayor que 1362**
    (baseline de Fase 1, `mutation-log.md`). Anotar el número exacto.
  - *Aceptación*: `./node_modules/.bin/tsc --noEmit` sin errores.
  - *Aceptación*: `chart-chrome.test.ts` sigue descubriendo **exactamente 7**
    archivos y pasa **sin haber sido modificado**. Los componentes nuevos no importan
    `recharts`, así que no entran al conjunto ni mueven el piso. Si alguien lo
    "arregla" creyendo que los perdió, salió del alcance.

- [ ] **10.2** **Invariantes de "la fase no altera nada".**
  - `git diff --stat src/` → **vacío**. Es el riesgo #1 del change: la invariante de
    tres casos de `_ratio()` en `station_uptime.py` es correcta y está blindada por 8
    tests. Una sola línea ahí y la fase no cierra.
  - `git diff --stat` de los 8 paneles existentes (`BValueChart.tsx`,
    `TremorPanel.tsx`, `StationUptimeChart.tsx`, `RsamTrendChart.tsx`,
    `DepthSectionChart.tsx`, `MagnitudeTimeChart.tsx`, `DepthDistributionChart.tsx`,
    `EventsTable.tsx`) + `app/(app)/analytics/page.tsx` + `lib/analytics.ts` +
    `lib/uptime-series.ts` + `lib/chart-theme.ts` + `chart-chrome.test.ts` +
    `messages/parity.test.ts` → **vacío**.
  - *Aceptación*: `git diff --name-only` contra la base de la rama lista
    **exactamente 12 archivos**: los 10 nuevos del design + los 2 `messages/*.json`.
    Ni uno más.
  - *Spec*: Requirement "La fase no altera la página ni el backend".

- [ ] **10.3** **Registrar las mutaciones en
  `openspec/changes/analytics-redesign/mutation-log.md`**, en la misma tabla y con la
  misma convención que las 4 de la Fase 1.
  - Una sección `## Fase 2` con: baseline (total de tests antes), el protocolo
    aplicado, y la tabla
    `# | archivo | mutación | git diff --stat no vacío (sí/no) | test(s) rojo(s) con el `it` EXACTO y el mensaje | revertido (git status limpio)`.
  - Son **19 mutaciones**: las 15 del design más las 4 que la spec exige y el design
    no listó (2.5 `mixed-magnitude-scales` `>1`→`>0`; 3.4 `>`→`>=` en
    `median-baseline-masking`; 6.4 término prohibido solo en EN; 6.6 sexta entrada de
    glosario). Numeradas acá como 1.3, 2.3-2.6, 3.3-3.5, 4.3-4.4, 5.3, 6.3-6.6,
    8.3-8.5, 9.3-9.4.
  - **Anotar los desvíos**, como se hizo con la 4.1 de la Fase 1: si una mutación
    tira menos rojos de los predichos, la explicación va escrita. Un desvío
    documentado es información; uno silenciado es un hueco de cobertura disfrazado.
  - *Aceptación*: **ninguna mutación quedó en verde.** Si alguna quedó, el test que
    debía atraparla no protege lo que dice y hay que arreglarlo **antes** de cerrar.
  - *Spec*: Requirement "Verificación por mutación de toda regla del catálogo".

- [ ] **10.4** **Commits**, conventional commits, mensaje en español, **sin ninguna
  atribución de IA** (ni `Co-Authored-By`, ni "Generated with Claude Code", ni nada
  equivalente, en el título, el cuerpo o el PR). Sugeridos, uno por bloque:
  - BLOQUE A:
    `feat(analytics): lib pura de reglas de confiabilidad y glosario i18n de cinco terminos`
    Cuerpo: las 10 reglas con sus umbrales nombrados, la invariante `null ≠ 0` en
    uptime, el test de límite de dominio, y **las cinco resoluciones de conflicto
    spec/design (C1-C5)** — que quede en el historial por qué el catálogo tiene 10
    reglas y no 7.
  - BLOQUE B:
    `feat(analytics): componentes de advertencia y de termino de glosario`
    Cuerpo: el wrapper de Popover con `Portal` + `z-[1100]` y por qué, la regla de
    `role="alert"` solo para `critical`, y el no-`forceMount`.
  - **No buildear** después de los cambios (regla del usuario; `next build` además
    rompe el server de dev).

- [ ] **10.5** **PR contra `main`.** Dos PRs (uno por bloque) o uno solo si el
  revisor lo prefiere; el corte natural es entre A y B.
  - El cuerpo MUST contener: la tabla de mutaciones de 10.3, la lista de archivos
    tocados de 10.2, y **en el primer párrafo, en negrita: "esta fase no produce
    ningún cambio visible en `/analytics`"** — para que nadie abra la página
    buscando un antes/después que no existe.
  - MUST listar **las piezas disponibles para la Fase 3**: `bValueWarnings`,
    `tremorWarnings`, `uptimeWarnings`, `partitionUptimeChannels`,
    `derivedBInterval`, `UPTIME_ATTENTION_THRESHOLD`, `<AnalyticsWarning>`,
    `<GlossaryTerm>`, y los 5 ids del glosario. Es el entregable real de la fase.
  - Sin atribución de IA en el cuerpo ni en los comentarios.

- [ ] **10.6** **Entregar al usuario el paquete de revisión — que NO es un QA visual.**
  La spec lo dice explícitamente: "esta fase no produce cambio visual y por lo tanto
  MUST NOT pedirle al usuario un QA visual de producto". Lo que se entrega es:
  1. **Las 5 definiciones del glosario, en ES y EN, en texto plano en el mensaje**
     (`b-value`, `Mc`, `RSAM`, `FI`, `uptime ratio`), para **revisión de contenido**.
     El texto es dominio sismológico: los tests garantizan que exista, que esté en
     los dos idiomas y que no cruce el límite de diagnóstico. **Que sea correcto lo
     dice el sismólogo, y ningún test lo reemplaza.**
  2. **Los 10 mensajes de advertencia**, mismo formato, misma pregunta.
  3. **Dos preguntas abiertas**, explícitas:
     - `SMALL_SAMPLE_FACTOR = 1.5` es elección del equipo, sin respaldo del usuario
       (a diferencia del `0.9` de uptime, que sí está cerrado). Se re-confirma en el
       QA de la Fase 3, cuando se vea cuántas veces dispara con datos reales.
     - Las **cinco resoluciones C1-C5** de conflicto spec/design — sobre todo **C2**
       (el catálogo queda en 10 reglas, no en las 7 del design) y **C4** (uptime
       entrega partición **y** advertencias).
  4. **NO se recomienda montar un harness descartable** para ver los componentes.
     La Fase 3 los entrega en su contexto real, que es donde el juicio visual sirve;
     un harness mostraría un componente flotando en el vacío y no probaría nada sobre
     cómo se ve dentro de un panel.
  - *Aceptación*: la fase queda **pendiente de confirmación de contenido del
    usuario**, no cerrada por decisión propia.

---

## Resumen

| Bloque | Grupo | Tareas | Foco |
|---|---|---|---|
| **A** (lib + i18n, sin React) | 1 | 3 | Tipos, constantes, `derivedBInterval` (+1 mutación) |
| | 2 | 6 | Reglas de b-value (+4 mutaciones) |
| | 3 | 5 | Reglas de tremor (+3 mutaciones) |
| | 4 | 4 | Uptime: partición + advertencias (+2 mutaciones) |
| | 5 | 3 | Catálogo TS del glosario (+1 mutación, la única con `tsc`) |
| | 6 | 7 | Contenido i18n + límite de dominio (+4 mutaciones) |
| **B** (componentes) | 7 | 1 | Wrapper de Popover |
| | 8 | 5 | `AnalyticsWarning` (+3 mutaciones) |
| | 9 | 4 | `GlossaryTerm` (+2 mutaciones) |
| **C** (cierre) | 10 | 6 | Suite, invariantes, registro, commits, PR, revisión de contenido |
| **Total** | | **44** | de las cuales **19 son mutaciones** |

### Orden y por qué

**Lib antes que todo lo que la usa**, y **contenido i18n antes que los componentes
que lo leen**: la augmentation de `global.d.ts:9-13` hace que una clave i18n
inexistente pasada a `t()` **no compile**, así que un componente escrito antes que su
clave no arranca.

El test de límite de dominio (6.2) va **antes** de los componentes, no al final: si
la prosa cruza la línea, mejor enterarse antes de construir encima.

Las mutaciones van **pegadas a su código**, no todas juntas al final. Acá importa más
que de costumbre: la fase termina con la suite verde sobre código **que nadie
consume**. Sin mutación, ese verde no distingue una lib correcta de una lib que nunca
se ejecutó — y este repo ya pagó esa lección: `chart-chrome.test.ts` estuvo verde una
fase entera protegiendo cero.

El corte de PR entre A y B es del design: A es "lib + contenido" (nada de React), B es
"componentes". Las dos mitades mergean solas.
