# Proposal: Rediseño de /analytics — de "panel que muestra números" a "panel que te dice qué mirar"

## Intent

El usuario definió `/analytics` como **EL DIFERENCIAL del producto**. Hoy la página
(`dashboard/app/(app)/analytics/page.tsx`) tiene 7 paneles que muestran números correctos
y estadísticamente honestos, pero que **no ayudan a interpretarlos**. El backend ya calcula
metadatos de confiabilidad que el frontend descarta en silencio, el ranking de uptime lista
todas las estaciones sin decir cuáles importan, y dos paneles heredados quedaron fuera de la
tematización de Fase 5.

Tres premisas del pedido original se verificaron contra el código antes de escribir esto, y
**dos resultaron falsas** — se documentan acá para que no se re-implementen cosas que ya existen:

1. **"Falta paginación en la tabla" — FALSO.** `EventsTable` ya se usa con `filterable paginated`
   (`page.tsx:138`), `pageSize` 50, recorte en `EventsTable.tsx:195-196`, y el filtrado se aplica
   ANTES del recorte (`EventsTable.tsx:149-154`). Lo que realmente falta es **ordenamiento por
   columna**: no hay estado de sort ni handler en la cabecera.
2. **"El gráfico de uptime pinta `null` como cero" — FALSO.** El `null` viaja limpio de punta a
   punta: `dashboard/lib/uptime-series.ts:70` lo pasa tal cual, `ratioToPercent`
   (`StationUptimeChart.tsx:49-51`) devuelve `null` explícito, y Recharts no dibuja la barra.
   **El defecto real es de codificación visual, no de datos**: una barra ausente y una barra de
   altura cero producen el MISMO píxel vacío. El propio código ya lo admite en el comentario de
   `StationUptimeChart.tsx:240-241`. ⇒ **El backend de uptime NO se toca.**
3. **"Falta ayuda para interpretar" — VERDADERO, y es lo que más pesa.** Es el corazón de este change.

El diagnóstico de fondo, que ordena todo el resto: **paginar reparte el problema en páginas, no lo
resuelve**. Nadie recorre N estaciones ni 200 eventos de a 20 por página. Lo que hace falta es
filtrado, agrupación, umbrales y jerarquía visual que digan **CUÁLES están mal y POR QUÉ**. La
paginación es el piso, no el techo. Aplica sobre todo al ranking de uptime: el rediseño debe
responder *"qué estaciones tengo que mirar HOY"*, no listar todas.

## Scope

### In Scope

**A. Interpretación (el diferencial — prioridad 1)**

- **Advertencias de confiabilidad**: cada panel ADVIERTE cuando su resultado no es confiable,
  usando metadatos que el backend **ya calcula y el frontend hoy descarta**:
  - `mc_at_catalog_floor` (bool) — **el más valioso de todos**: avisa que Mc coincide con el piso
    de ingesta del catálogo y no con la sensibilidad real de la red. Un b-value con esto en `true`
    NO es confiable, y hoy el usuario **no se entera**.
  - `sigma_b` — incertidumbre de Shi & Bolt (1982). Es σ, **no** un intervalo de confianza: la UI
    debe presentar `b ± 1.96σ` y decir explícitamente que es un intervalo derivado, no calculado
    por el backend.
  - `mag_type_counts` — Gutenberg-Richter asume UNA escala de magnitud; el catálogo fusionado
    mezcla varias. Si hay mezcla, se advierte.
  - `n_total` vs `n_above_mc`, `min_events`, y los `bins` de la FMD (con `count` y `cumulative`).
  - Tremor: `baseline_rsam` / `threshold_rsam` — con la limitación documentada en
    `src/services/tremor.py:26-28` hecha visible: un episodio que ocupe más de media ventana sube
    la mediana y **no se detecta**. El backend expone estos valores precisamente para poder mostrarlo.
  - Tremor por episodio: `tremor_fraction`, `parameters`, `onset_ratio`, `fi_sign`, `band`.
- **Prosa interpretativa corta** por panel: qué significa el número, en una o dos frases, en el
  idioma del usuario (i18n).
- **Glosario contextual por término** (b-value, Mc, RSAM, FI, y los que surjan en spec), accesible
  desde cada panel donde el término aparece — no una página aparte que nadie visita.
- **Leyenda para la tira de cuadraditos de uptime** (`StationUptimeChart.tsx:242-271`): hoy el
  punteado = sin observación (L256), la opacidad ∝ ratio (L261) y el anillo ámbar = `in_progress`
  (L258) **no están explicados en ningún lado** — solo hay `title` (L252) y `sr-only` (L263-267),
  y no existen claves de leyenda en `dashboard/messages/en.json:723-736`.

**B. Codificación visual honesta y jerarquía (prioridad 2)**

- **Distinguir "sin dato" de "cero"** en el gráfico de uptime, por codificación visual explícita
  (no por cambio de datos): el caso `null` debe verse distinto del `0.0`, no idéntico.
- **El color del ranking debe codificar el ratio**: hoy `StationUptimeChart.tsx:163` usa
  `fill={RATIO_COLOR}` con `RATIO_COLOR = '#059669'` fijo (L46), sin `<Cell>` por fila. Peor: el
  comentario de L45 dice *"sequential de un tono: emerald, claro → oscuro con el ratio"* y **el
  código nunca modula por ratio** — es comment rot que hay que corregir junto con el código.
- **Recortar y priorizar el ranking**: `StationUptimeChart.tsx:167-197` hace `ranked.map()` sin
  `.slice()`, con `height = Math.max(160, rankingRows.length * 22)` (L143) metido en un
  `max-h-56 overflow-y-auto` (L167). Crece sin tope y se resuelve con scroll, no con recorte. El
  rediseño debe responder "qué mirar HOY": umbral, agrupación y recorte con "ver todas" explícito.
- **Jerarquía visual en la tabla de eventos**: destacar los eventos que importan (magnitud alta,
  recientes) para que deje de ser una grilla plana.

**C. Tabla de eventos (prioridad 3)**

- **Ordenamiento por columna** en `EventsTable` (lo único que realmente falta de la tabla), con el
  sort aplicado ANTES del recorte de página, igual que el filtrado hoy (`EventsTable.tsx:149-154`).

**D. Deuda de tematización de los dos paneles heredados**

- Migrar `dashboard/components/MagnitudeTimeChart.tsx` (hex fijos en L50 `#374151`, L59/L66
  `#9ca3af`, L83-85) y `dashboard/components/DepthDistributionChart.tsx` (L41-45, tooltip
  `#1f2937` fijo) a `dashboard/lib/chart-theme.ts`.
- Darles test propio: son los **únicos dos paneles de analytics sin test**.
- **Causa raíz del hueco de cobertura, ya identificada**: `chart-chrome.test.ts` no los atrapa por
  dos razones acumuladas — (a) itera una whitelist hardcodeada `PANELES` (L25-31) que solo lista
  los 5 paneles de Fase 5, y (b) resuelve las rutas con `join(__dirname, archivo)` (L40), y
  `__dirname` es `components/analytics/`, mientras los dos paneles viejos viven en
  `components/`. El fix debe cerrar el mecanismo (descubrimiento de archivos, no whitelist), no
  solo agregar dos strings a un array.

### Out of Scope

- **Cambios al backend de uptime.** `src/services/station_uptime.py:138-144` (`_ratio()`) ya
  distingue correctamente los tres casos: nadie miró → `null`; canal mudo en hora observada →
  `0.0`; canal sin filas → `null`. La invariante está declarada en `src/models/analytics.py:11-15`
  y blindada por tests (`test_station_uptime.py:53,66,79,108`;
  `test_analytics_api.py:531,546,571,591`), y el SQL (`station_uptime.py:232-236`) deliberadamente
  NO filtra por canal para no convertir `0.0` en `null`. **Tocar esto es una regresión, no una mejora.**
- **Inventar métricas que el backend no calcula.** Explícitamente fuera: intervalo de confianza
  formal, bondad de ajuste (R², KS, test de Utsu), error de Mc, SNR. Si un panel las necesita, es
  un change de backend aparte con su propia justificación sismológica.
- **Afirmaciones de dominio que el backend no hace.** La docstring de `src/services/tremor.py:30-32`
  marca el límite honesto: *"Lo que esto NO afirma: 'tremor volcánico'. La interpretación es del
  sismólogo."* La capa de interpretación de este change **explica métricas**, no **diagnostica
  fenómenos**. Ese límite no se cruza.
- **Reabrir decisiones de diseño heredadas de `analytics-professional-panels`**: la estructura de
  3 tabs (Sismicidad / Señal / Red) con selectores fijos arriba y `keepMounted` se mantiene (la
  razón está cerrada: RSAM/tremor/uptime cargan en `useEffect` y desmontar re-dispararía peticiones
  FDSN). `BValueChart` e `HypocenterMap` siguen siendo presentacionales con el `useSWR` en la página.
- **Rediseño del layout general de la página** (grillas, paleta, tipografía). Este change cambia
  QUÉ se comunica y CÓMO se codifica el dato, no el chrome de la página.
- **Asistente conversacional** (`asistente-sismico-conversacional`) — es otra iniciativa. La
  interpretación de este change es estática y determinista, no generada por LLM.
- **El favicon del sitio** — pedido encolado aparte, no entra acá.

## Approach

Todo el trabajo es de **frontend**. El backend no se toca: la tesis del change es que
**los datos para interpretar YA EXISTEN y el frontend los está tirando a la basura**.

- **Advertencias**: una capa de reglas puras (lib testeable, sin React) que toma la respuesta del
  endpoint y devuelve una lista tipada de advertencias con severidad. `mc_at_catalog_floor === true`
  ⇒ advertencia fuerte sobre el b-value; `mag_type_counts` con más de una escala ⇒ advertencia de
  supuesto violado; `n_above_mc` cerca de `min_events` ⇒ advertencia de muestra chica. Lógica pura
  = testeable por mutación, que es el estándar de verificación del repo.
- **`b ± 1.96σ`** se calcula **en la UI** a partir de `sigma_b`, y se rotula como intervalo derivado
  bajo supuesto de normalidad — no se presenta como si el backend hubiera calculado un IC.
- **Glosario**: diccionario de términos en los archivos de i18n (`dashboard/messages/`), consumido
  por un componente de término reutilizable. Un término = una entrada, invocable desde cualquier panel.
- **Codificación visual del uptime**: `<Cell>` por fila con la escala secuencial que el comentario
  de `StationUptimeChart.tsx:45` ya prometía, más un patrón/hatch o marca explícita para el caso
  `null` que lo separe visualmente del `0.0`. El dato no cambia; cambia el mapeo dato → píxel.
- **Ranking**: umbral + agrupación + recorte con escape a "ver todas", en vez de `ranked.map()`
  sin tope dentro de un contenedor con scroll.
- **Sort de la tabla**: estado de orden en `EventsTable`, aplicado en la misma tubería que el
  filtro y **antes** del `slice` de paginación, para no ordenar solo la página visible.
- **Tematización de los dos paneles viejos**: reemplazar hex por las constantes de
  `dashboard/lib/chart-theme.ts` (`CHART_GRID_STROKE`, `CHART_AXIS_STROKE`, y las tres props de
  tooltip). Los colores que **codifican dato** siguen fuera de `chart-theme.ts` a propósito — eso
  es escala semántica, no cromo.
- **Cierre del hueco de test**: convertir la whitelist `PANELES` de `chart-chrome.test.ts` en
  descubrimiento de archivos sobre los directorios donde viven paneles de analytics, de modo que
  un panel nuevo (o uno viejo migrado) quede cubierto sin que nadie se acuerde de agregarlo a un array.
- **Radix**: el repo usa el paquete unificado `radix-ui`, NO los `@radix-ui/react-*` sueltos.
  Cualquier primitiva nueva (popover/tooltip del glosario) sale de ahí.

### Fases propuestas

Ordenadas por dependencia. Cada fase se puede mergear sola.

| Fase | Contenido | Depende de | ¿Mergeable sola? |
|------|-----------|-----------|------------------|
| **1. Deuda de tematización** | Migrar `MagnitudeTimeChart` y `DepthDistributionChart` a `chart-theme.ts`, darles test, y convertir `chart-chrome.test.ts` de whitelist a descubrimiento | — | Sí. Autocontenida, sin dependencias, cierra deuda conocida. Es el mejor primer PR: chico, verificable y deja la red de seguridad puesta para todo lo que sigue. |
| **2. Fundaciones de interpretación** | Lib pura de reglas de advertencia + tipos + claves i18n del glosario + componente de término y de advertencia (sin cablear a ningún panel todavía) | 1 (opcional) | Sí. Todo nuevo y aditivo; con tests unitarios propios aunque nada lo consuma aún. |
| **3. Interpretación cableada a los paneles** | Consumir los metadatos descartados en b-value (empezando por `mc_at_catalog_floor`) y tremor; prosa por panel; glosario invocado desde cada término | 2 | Sí, y **se puede subdividir por panel** si el PR queda grande: b-value primero (es donde `mc_at_catalog_floor` tiene más valor), tremor después. |
| **4. Uptime: codificación visual y priorización** | `<Cell>` por ratio (y arreglar el comment rot de L45), distinción visual `null` vs `0.0`, leyenda de la tira de cuadraditos, umbral + agrupación + recorte del ranking | 2 (para el componente de leyenda/advertencia) | Sí. Toca un solo componente + su test. |
| **5. Tabla de eventos** | Ordenamiento por columna (sort antes del recorte de página) + jerarquía visual de filas | — | Sí. Independiente de todo lo anterior; podría ir en paralelo a 2-4. |

Fase 1 y Fase 5 no dependen de nada y pueden arrancar en paralelo. Fase 3 y 4 son las que entregan
el diferencial y ambas cuelgan de la Fase 2.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `dashboard/components/MagnitudeTimeChart.tsx` | Modified | Reemplazar hex fijos (L50, L59, L66, L83-85) por constantes de `chart-theme.ts` |
| `dashboard/components/DepthDistributionChart.tsx` | Modified | Ídem (L41-45) + tooltip `#1f2937` fijo a las tres props tematizadas |
| `dashboard/components/MagnitudeTimeChart.test.tsx` | New | Panel hoy sin test propio |
| `dashboard/components/DepthDistributionChart.test.tsx` | New | Panel hoy sin test propio |
| `dashboard/components/analytics/chart-chrome.test.ts` | Modified | Whitelist `PANELES` (L25-31) + `join(__dirname, ...)` (L40) ⇒ descubrimiento de archivos que alcance también `dashboard/components/` |
| `dashboard/lib/` | New | Lib pura de reglas de advertencia/confiabilidad (sin React, testeable por mutación) |
| `dashboard/components/analytics/` | New | Componente de advertencia + componente de término de glosario |
| `dashboard/components/analytics/BValueChart.tsx` | Modified | Consumir `mc_at_catalog_floor`, `sigma_b` (⇒ `b ± 1.96σ` en UI), `mag_type_counts`, `n_total`/`n_above_mc`/`min_events` |
| `dashboard/components/analytics/TremorPanel.tsx` | Modified | Exponer `baseline_rsam`/`threshold_rsam` con la limitación de `tremor.py:26-28`, `tremor_fraction`, `parameters`, `onset_ratio`, `fi_sign`, `band` |
| `dashboard/components/analytics/StationUptimeChart.tsx` | Modified | `<Cell>` por ratio (L163, `RATIO_COLOR` L46), corregir comment rot de L45, distinción visual `null` vs `0.0`, leyenda de la tira (L242-271), recorte/umbral del ranking (L143, L167-197) |
| `dashboard/components/EventsTable.tsx` | Modified | Ordenamiento por columna, aplicado antes del recorte de página (junto al filtrado de L149-154) |
| `dashboard/messages/*.json` | Modified | Claves nuevas: leyenda de uptime (hoy ausentes en `en.json:723-736`), glosario, prosa interpretativa, advertencias |
| `dashboard/app/(app)/analytics/page.tsx` | Modified (mínimo) | Solo si hace falta pasar props nuevas; la estructura de tabs y el `keepMounted` NO se tocan |
| `src/services/station_uptime.py` | **Untouched** | Explícitamente fuera de alcance — la invariante de tres casos es correcta y está blindada por tests |
| `src/services/tremor.py` | **Untouched** | Se consume lo que ya expone; su límite de dominio se respeta |
| `src/models/analytics.py` | **Untouched** | Los metadatos ya existen; el problema es que el frontend no los muestra |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Que alguien "arregle" el backend de uptime creyendo que el `null` es un bug | **High** | La invariante está documentada en `src/models/analytics.py:11-15` y blindada por 8 tests. La spec debe repetir explícitamente que `_ratio()` es correcto y está fuera de alcance. Es el riesgo #1 de este change. |
| Cruzar el límite de dominio: que la prosa interpretativa termine diagnosticando ("esto es tremor volcánico") en vez de explicar | **High** | El límite lo fija `tremor.py:30-32`. Toda la prosa se revisa contra esa regla; la spec debe pedir redacción que explique la métrica, nunca que afirme el fenómeno. |
| Presentar `b ± 1.96σ` como si fuera un intervalo de confianza calculado por el backend | Med | `sigma_b` es σ (Shi & Bolt 1982), no un IC. El copy debe rotularlo como intervalo derivado bajo supuesto de normalidad, calculado en la UI. |
| Inventar métricas que el backend no calcula (R², KS, Utsu, error de Mc, SNR) | Med | Listadas explícitamente en Out of Scope. Cualquier propuesta de agregarlas es un change de backend nuevo. |
| Ruido de advertencias: si todo advierte, nada advierte | Med | Severidad graduada y umbrales definidos en la spec. `mc_at_catalog_floor` es la advertencia fuerte; el resto informa. Verificar con el usuario en QA visual. |
| El corte del ranking de uptime esconde una estación caída | Med | El recorte debe ser por criterio (peores primero / bajo umbral), nunca por orden arbitrario, y con "ver todas" siempre accesible. |
| **La cifra de estaciones NO está verificada** — se mencionó "118 canales" pero el único match en el repo es un conteo de archivos de test | Med | El defecto del ranking sin tope es real **estructuralmente** (`ranked.map()` sin `slice`, L167-197). La cifra hay que **medirla en producción** antes de fijar el umbral de recorte. Ver Open Questions. |
| Regresión de accesibilidad al agregar popovers/tooltips de glosario | Med | Usar `radix-ui` (paquete unificado) y respetar la lección ya aprendida: `forceMount` rompe a11y; los triggers de tab responden a `mouseDown`, no a `fireEvent.click`. |
| Scope creep: 5 fases, 3 ejes de trabajo, en el panel más grande del producto | **High** | Fases mergeables por separado, ordenadas por dependencia. Si `sdd-tasks` ve una fase inabarcable, se subdivide (la Fase 3 ya trae el corte previsto por panel), no se amplía. |
| Convertir `chart-chrome.test.ts` a descubrimiento arrastre archivos que no son paneles y rompa el test | Low | Acotar el descubrimiento por criterio explícito (p. ej. archivos que importen Recharts) y verificar el set descubierto contra la lista actual antes de borrar la whitelist. |

## Rollback Plan

Todo el change es frontend y aditivo sobre componentes existentes. No hay migraciones, no hay
endpoints nuevos, no hay cambios de contrato: el backend queda **byte por byte igual**, así que
ningún rollback puede dejar datos inconsistentes.

Por fase:

1. **Fase 1** (tematización): `git revert` del PR devuelve los hex fijos. Riesgo cero de datos;
   lo único que vuelve es el defecto de contraste conocido.
2. **Fase 2** (fundaciones): código nuevo que nadie consume todavía. Revertir es borrar archivos nuevos.
3. **Fase 3** (interpretación cableada): revertir por panel. Cada panel vuelve a su render actual,
   que sigue siendo correcto — solo deja de mostrar las advertencias.
4. **Fase 4** (uptime): revertir devuelve `RATIO_COLOR` fijo y el ranking sin tope. El dato
   subyacente nunca cambió, así que no hay estado que reparar.
5. **Fase 5** (tabla): revertir el sort deja la tabla con filtrado + paginación como hoy.

Si una fase se detecta rota **en producción**, se revierte su PR y se redeploya; ninguna fase es
prerequisito operativo de otra ya mergeada (2 es prerequisito de código para 3 y 4, pero si 3 y 4
no están mergeadas, revertir 2 es seguro).

## Dependencies

- **Ninguna de backend.** Este change consume metadatos que `src/models/analytics.py`,
  `src/services/tremor.py` y `src/services/station_uptime.py` ya exponen.
- Hereda las decisiones de diseño de `analytics-professional-panels` (tabs, `keepMounted`,
  presentacional vs. dueño del SWR) — que **no se reabren**.
- `dashboard/lib/chart-theme.ts` debe existir tal cual está (Fase 5 de `analytics-professional-panels`,
  ya en main).
- QA visual: por convención del proyecto, **lo hace el usuario**. Cada fase tiene que entregar URL
  exacta y qué mirar.

## Open Questions

1. **¿Cuántas estaciones/canales tiene realmente el ranking de uptime en producción?** La cifra
   "118" no está verificada (el único match en el repo es un conteo de archivos de test). Hay que
   medirla antes de fijar el umbral y el tope de recorte. No bloquea el diseño del mecanismo, sí la
   calibración del número.
2. **¿Cuál es el umbral de ratio que define "estación que tengo que mirar HOY"?** ¿Un valor fijo
   (p. ej. < 0.9), un percentil sobre el conjunto, o "las N peores"? Decidir en `sdd-spec`
   preferentemente con el usuario, porque es criterio de dominio, no técnico.
3. **¿Cuántos términos entran en el glosario v1?** El pedido nombra b-value, Mc, RSAM y FI. ¿Se
   suman `sigma_b`, `onset_ratio`, `fi_sign`, `tremor_fraction`, "uptime ratio"? Definir el corte
   en spec para no convertir el glosario en un proyecto aparte.
4. **¿Qué primitiva de `radix-ui` usa el glosario — Popover, HoverCard o Tooltip?** Impacta a11y y
   touch (un HoverCard no se abre con el dedo). Decidir en `sdd-design`.
5. **Distinción visual `null` vs `0.0` en uptime: ¿patrón/hatch, color distinto, o marca sobre el eje?**
   Tiene que funcionar en claro y oscuro y no depender solo del color (daltonismo). Decidir en `sdd-design`.
6. **¿La jerarquía visual de la tabla se define por umbral de magnitud, por recencia, o por ambos?**
   Y si es por ambos, ¿cuál gana cuando compiten? Definir en spec.

## Success Criteria

- [ ] Un b-value con `mc_at_catalog_floor === true` muestra una advertencia visible que explica que
      Mc es el piso de ingesta del catálogo y no la sensibilidad real de la red — verificable
      cambiando ese solo campo en la respuesta y viendo aparecer/desaparecer la advertencia.
- [ ] `sigma_b` se presenta como `b ± 1.96σ` rotulado como intervalo derivado en la UI, y en ningún
      lugar del copy se lo llama intervalo de confianza calculado por el backend.
- [ ] Cuando `mag_type_counts` contiene más de una escala de magnitud, el panel advierte que el
      supuesto de Gutenberg-Richter (una sola escala) está violado.
- [ ] El panel de tremor muestra `baseline_rsam`/`threshold_rsam` junto con la limitación de
      `src/services/tremor.py:26-28` (un episodio largo sube la mediana y no se detecta), en texto
      que el usuario puede leer sin abrir el código.
- [ ] Ningún texto de la capa interpretativa afirma un fenómeno de dominio ("es tremor volcánico");
      todos explican la métrica. Verificable leyendo las claves i18n nuevas.
- [ ] En el gráfico de uptime, una hora **sin observación** (`null`) se distingue visualmente de una
      hora **observada con ratio 0.0** — verificable con dos series de prueba que hoy producen píxeles idénticos.
- [ ] Las barras del ranking modulan su color con el ratio (`<Cell>` por fila), y el comentario de
      `StationUptimeChart.tsx:45` describe lo que el código hace de verdad.
- [ ] La tira de cuadraditos tiene leyenda visible que explica punteado (sin observación), opacidad
      (∝ ratio) y anillo ámbar (`in_progress`), con claves reales en `dashboard/messages/`.
- [ ] El ranking de uptime responde "qué mirar hoy": recorta por criterio (peores / bajo umbral),
      no crece sin tope, y ofrece "ver todas" — verificable con un conjunto grande de estaciones.
- [ ] `EventsTable` ordena por columna, y el orden se aplica **antes** del recorte de página
      (verificable: ordenar con más de una página no debe reordenar solo la página visible).
- [ ] `MagnitudeTimeChart` y `DepthDistributionChart` no contienen ningún hex de cromo y consumen
      `@/lib/chart-theme`, y **`chart-chrome.test.ts` los cubre por descubrimiento** — verificable
      metiendo un hex a mano en cualquiera de los dos y viendo fallar el test.
- [ ] `src/services/station_uptime.py`, `src/services/tremor.py` y `src/models/analytics.py` no
      tienen ni una línea modificada al final del change (`git diff` vacío en esos archivos).
- [ ] Ningún panel muestra una métrica que el backend no calcula (sin R², sin KS, sin Utsu, sin
      error de Mc, sin SNR).
- [ ] La estructura de 3 tabs con `keepMounted` sigue intacta y los paneles no re-disparan
      peticiones FDSN al cambiar de tab.
