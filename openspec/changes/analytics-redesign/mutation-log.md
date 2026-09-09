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
