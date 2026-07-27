# TECT-1: Límites de placas estilizados tipo USGS

**Fecha:** 2026-07-27
**Estado:** Aprobado, listo para implementar

## Intent

El mapa ya renderiza los límites de placas tectónicas (dataset PB2002 de Peter Bird, vendorizado en
`dashboard/public/geo/plate-boundaries.json`), pero como líneas rojas planas y uniformes: un solo
`L.geoJSON()` con `{ color: '#dc2626', weight: 1.5, opacity: 0.7 }` en
`AdvancedSeismicMap.tsx:320-322`.

El dataset trae un campo `Type` que hoy se ignora. 65 de sus 241 features están marcados como
`"subduction"`. El mapa del USGS ("Latest Earthquakes") usa justamente esa distinción para dibujar
dientes de sierra sobre las zonas de subducción — el rasgo visual que hace legible de un vistazo
dónde una placa se hunde bajo otra.

Este change usa el `Type` que ya está en los datos para estilizar por tipo de contacto, y expone un
toggle real de mostrar/ocultar placas, que hoy no existe.

## Scope

### In Scope

- Nuevo módulo puro `dashboard/lib/plate-boundaries.ts`: tipos del GeoJSON, clasificación por `Type`,
  parseo de polaridad de subducción, y función de estilo. Sin importar Leaflet.
- Estilizado diferenciado: subducción con símbolos de triángulo orientados; otros límites con trazo simple.
- Toggle de usuario para mostrar/ocultar placas, en el panel de capas ya existente del componente.
- Tests vitest del módulo puro, incluido un test de contrato contra el JSON real.

### Out of Scope

- Gestión de áreas de interés (AOI-1) — ver "Decisiones heredadas" al final.
- Vista 3D con `globe.gl` — consumirá este módulo cuando exista.
- Cambiar el basemap por defecto de ninguna página. "Escala de Grises" ya existe en
  `BASE_LAYERS` (`map-layers.ts:38`) y queda a elección del usuario.
- Fallas geológicas (`usFaults`) — siguen siendo un overlay de tiles independiente.
- Actualizar o reemplazar el dataset PB2002.

## Hallazgos que fundamentan el diseño

Verificados contra el archivo real, no asumidos:

| Hecho | Valor |
|---|---|
| Features totales | 241, todos `LineString` |
| Tamaño | 70K |
| Vértices | 1.366 totales (min 2, max 47, promedio 6) |
| `Type: "subduction"` | 65 features |
| `Type: ""` (vacío) | 176 features |
| Claves de `properties` | `LAYER`, `Name`, `PlateA`, `PlateB`, `Source`, `Type` |

**Polaridad de subducción.** El campo `Name` codifica de qué lado se hunde la placa mediante el
separador entre los códigos de placa:

```
SUBDUCCIÓN      slash (A/B) = 44    backslash (A\B) = 21    total 65
NO-SUBDUCCIÓN   slash = 0           backslash = 0           total 176
```

La correlación es del 100%: todo feature de subducción tiene separador, ninguno de los otros lo
tiene. Esa es la convención PB2002 para la polaridad, y es la que determina hacia qué lado apuntan
los dientes de sierra. Sin ella habría que inventar o calcular la dirección.

El volumen (1.366 vértices) es chico: se procesa en cliente sin problema de performance.

## Arquitectura

```
dashboard/lib/plate-boundaries.ts          NUEVO — módulo puro, cero Leaflet
  ├─ PlateBoundaryProperties, PlateBoundaryFeature   tipos del GeoJSON
  ├─ classify(feature)      → 'subduction' | 'other'
  ├─ parsePolarity(name)    → 'forward' | 'reverse' | null
  └─ styleFor(kind)         → { color, weight, opacity, dashArray? }

dashboard/components/AdvancedSeismicMap.tsx   MODIFICADO
  ├─ effect 307-339   consume el módulo; aplica decorador de símbolos
  └─ panel de capas   nueva sección "Capas Tectónicas" con checkbox

dashboard/lib/plate-boundaries.test.ts     NUEVO — vitest, sin Leaflet
```

**Por qué esta frontera.** `plate-boundaries.ts` no importa Leaflet, así que se testea sin jsdom ni
instancia de mapa. Es el patrón ya establecido en `dashboard/lib/map-bounds.ts`, que define una
interfaz estructural mínima (`BoundsLike`) exactamente para poder testear lógica geométrica sin
Leaflet. Cuando llegue `globe.gl`, reusa `classify()`, `parsePolarity()` y `styleFor()` sin cambios
y solo escribe su propio render de símbolos.

## Decisión 1: símbolos con `leaflet-polylinedecorator`

Los dientes de sierra requieren colocar símbolos repetidos a lo largo de una polilínea, rotados
según el ángulo del segmento, y recalculados en cada zoom.

**Elegido:** el plugin `leaflet-polylinedecorator`, que resuelve exactamente ese problema
(espaciado, rotación por segmento, re-render en zoom).

**Descartado — SVG calculado a mano:** implica implementar interpolación a lo largo de la línea,
ángulo perpendicular por segmento, y recreación de cientos de triángulos en cada `zoomend` sobre
1.366 vértices. Es reimplementar el plugin, más lento y más frágil.

**Descartado — solo estilizar el trazo (color/grosor/dash, sin símbolos):** son ~10 líneas y cero
dependencias, pero no produce los dientes de sierra, que son el 80% del valor visual del referente
USGS.

**Costo aceptado:** una dependencia de ~15KB, más un `.d.ts` mínimo propio porque el plugin no
publica tipos TypeScript.

Este criterio es consistente con la decisión de usar Shapely en el backend en lugar de ray-casting
propio: no reimplementar geometría computacional que ya está resuelta y testeada.

## Decisión 2: estilizado por tipo de contacto

| Tipo | N | Trazo | Símbolo |
|---|---|---|---|
| Subducción | 65 | rojo, `weight: 2` | triángulos cada ~40px, rotados por polaridad |
| Otros límites | 176 | rojo, `weight: 1.2`, `opacity: 0.65` | ninguno |

Se conserva el rojo actual (`#dc2626`) como color base: es el del referente USGS y el que ya usa el
mapa. La diferenciación es por grosor, opacidad y presencia de símbolos.

## Decisión 3: el toggle pasa de prop fija a estado interno

**Problema actual.** `showPlateBoundaries` es una prop del componente padre:

| Página | Valor |
|---|---|
| `app/(app)/page.tsx:147` | `showPlateBoundaries` (hardcodeado en `true`) |
| `app/(app)/explore/page.tsx:192-196` | prop ausente → `false` |

El usuario no puede togglear nada: las placas están prendidas fijas en el Dashboard y apagadas fijas
en el Explorador.

Además, las placas no aparecen en el panel de capas: "Capa Base" lista `BASE_LAYERS` y "Overlays
Geológicos" lista `GEOLOGICAL_OVERLAYS`, y las placas están deliberadamente fuera de ese registro
porque son vectoriales, no tiles (documentado en `map-layers.ts:52-57`).

**Solución.** La prop pasa a ser el valor *inicial* de un estado interno:

```ts
const [showPlates, setShowPlates] = useState(showPlateBoundaries);
```

Y se agrega una sección "Capas Tectónicas" al panel existente, con el mismo markup de checkbox que
ya usan los overlays geológicos.

**Consecuencia:** ninguna de las dos páginas necesita cambios. El Dashboard sigue arrancando con
placas visibles, `/explore` sigue arrancando sin ellas, y en ambas el usuario ahora puede togglear.
Retrocompatible por construcción.

## Manejo de errores

Se preserva el comportamiento actual (`AdvancedSeismicMap.tsx:326-329`): si el `fetch` del GeoJSON
falla, se registra en `console.error` y el resto del mapa sigue funcionando. Lo exige el Requirement
2 del spec de dashboard-ui.

Se extiende el mismo criterio al plugin: si el decorador de símbolos falla al inicializarse, las
líneas base se dibujan igual. La degradación es a "placas sin dientes de sierra", nunca a "mapa
roto".

El flag `cancelled` y la limpieza en el return del effect se mantienen tal como están.

## Testing

`dashboard/lib/plate-boundaries.test.ts` — vitest, sin Leaflet, siguiendo el estilo de
`map-bounds.test.ts` (describe/it en español, factory local de fixtures):

- `parsePolarity('EU/AF')` → `'forward'`; `parsePolarity('EU\\AF')` → `'reverse'`
- `classify()` distingue `Type: "subduction"` de `Type: ""`
- `styleFor()` devuelve `weight`/`opacity` distintos por tipo
- **Test de contrato sobre el JSON real:** los 241 features clasifican sin excepción, y los 65 de
  subducción tienen polaridad parseable. Si una actualización del dataset rompe la convención del
  separador, este test falla.

No se agregan tests de componente para el mapa: no existe ninguno hoy, y el precedente establecido
del proyecto es extraer la lógica a un módulo puro y testear ahí (`map-bounds.ts:1-12`).

## Verificación

- [ ] `npx tsc --noEmit` sin errores en `dashboard/`
- [ ] `npm run test` — tests nuevos pasan, los 3 archivos de test existentes sin regresión
- [ ] `npm run build` pasa
- [ ] Verificación visual en `/` y `/explore`: los triángulos aparecen sobre zonas de subducción
      conocidas (costa de Chile, arco de Japón, Aleutianas), el checkbox muestra y oculta la capa, y
      el estado inicial de cada página no cambió

## Rollback

El cambio son dos archivos nuevos (`lib/plate-boundaries.ts`, su test), un archivo modificado
(`AdvancedSeismicMap.tsx`), un `.d.ts`, y una dependencia en `package.json`. Sin backend, sin
esquema de datos, sin contrato de API. `git revert` del commit deja el mapa con las líneas planas
actuales.

---

## Decisiones heredadas: AOI-1 (áreas de interés)

Antes de pivotear a TECT-1 se brainstormeó el feature de áreas de interés. Estas decisiones quedan
registradas como insumo de su propio ciclo, para no rediscutirlas:

1. **Sin PostGIS.** Verificado contra la base corriendo (`docker exec timescaledb psql`):
   `pg_extension` devuelve solo `plpgsql` y `timescaledb v2.28.2`, y `postgis` **no aparece en
   `pg_available_extensions`** — o sea `CREATE EXTENSION postgis` fallaría; la imagen
   `timescale/timescaledb:latest-pg15` no trae los binarios. La imagen
   `timescale/timescaledb-postgis` está deprecada upstream. Geometría como GeoJSON en columna JSONB,
   con columnas `bbox_*` indexadas para el pre-filtro grueso. Migrable a PostGIS más adelante vía
   `ST_GeomFromGeoJSON()`.
2. **Shapely** para punto-en-polígono en Python (maneja multipolígonos y agujeros).
3. **Presets del sistema + áreas propias:** `is_system` boolean, `owner_id` nullable.
4. **Catálogo curado de ~16 regiones sísmicas relevantes** (Indonesia, México, Filipinas, Japón,
   Chile, Centroamérica, Kamchatka/Aleutianas, Perú, Himalaya, Papúa Nueva Guinea, más los
   cinturones Anillo de Fuego y Alpino-Himalayo, más San Andrés, Anatolia, Nueva Zelanda,
   Mediterráneo oriental).
5. **Cinturones como MultiPolygon partido en el antimeridiano** (RFC 7946). El Anillo de Fuego cruza
   ±180°; un bbox `-180..180` sería "todo el planeta" e inútil como filtro.
6. **Presets:** GeoJSON vendorizado en `dashboard/public/geo/` (patrón de `plate-boundaries.json`) +
   seed en migración SQL con `is_system=true`.
7. **Fallas geológicas fuera de alcance** — siguen siendo overlay de tiles USGS.
8. **Abstracción render-agnóstica mínima:** módulo puro de geometría, sin inventar una interfaz
   `AoiRenderer` contra un único consumidor.
9. **Dibujo a mano diferido a AOI-1b.** AOI-1 entrega catálogo + activar/desactivar + render +
   persistencia.

Punto de partida existente: `src/config/regions.py` ya modela presets curados por nombre con bbox
(`Bbox` TypedDict, convención `bbox=None ≡ global ≡ match-all`) para suscripciones del stream SSE, y
`src/api/deps.py:8-9` reserva explícitamente `require_min_role` para "endpoints futuros (regiones,
dashboards personalizados)".

El alcance completo se descompone en tres ciclos independientes: **AOI-1** (fundación: modelo,
CRUD, presets, render), **AOI-2** (filtro de eventos por área + estadísticas agregadas), **AOI-3**
(alertas en tiempo real — toca el pipeline de ingesta y requiere decidir canal de notificación,
deduplicación y umbrales por área).
