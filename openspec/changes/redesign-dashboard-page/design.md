# Design: Redesign Dashboard Page

## Technical Approach

Migración visual del Dashboard (`app/page.tsx` + `KPICard` + `AlertBanner` + `EventsTable`) a tokens de severidad/shadcn, y extensión no disruptiva de `AdvancedSeismicMap` para que absorba el caso de uso hoy cubierto por `SeismicMapWithCities` (ciudades) más tres capacidades nuevas: límites de placas tectónicas reales, contador "N of M events in map area", y sincronización unidireccional click-en-tabla → mapa. Todo el estado nuevo es local a `page.tsx` vía `useState`, sin store global. No se agregan dependencias npm nuevas (ni Zustand, ni topojson/simplify): el GeoJSON de placas se vendoriza pre-simplificado a mano (edición del archivo fuente, no una librería de build) y se consume con `fetch()` + `L.geoJSON()` nativo de Leaflet, que ya es dependencia del proyecto.

## Architecture Decisions

### Decision 1: Mecanismo de carga del GeoJSON de límites de placas tectónicas

**Choice**: Vendorizar el archivo en `dashboard/public/geo/plate-boundaries.json`, servido same-origin por Next.js (sin CDN ni GitHub raw en runtime), cargado con `fetch('/geo/plate-boundaries.json')` en un `useEffect` de `AdvancedSeismicMap` y renderizado con `L.geoJSON(data, { style: { color: '#dc2626', weight: 1.5, opacity: 0.7 } })`.

**Alternatives considered**:
- Consumir en cada carga desde `cdn.jsdelivr.net/gh/fraxen/tectonicplates@master/GeoJSON/PB2002_boundaries.json` (o `raw.githubusercontent.com`) en runtime.
- Instalar el paquete npm `tectonicplates` o similar (no existe un paquete oficial mantenido) o traer topojson + `topojson-simplify` como dependencia de build para simplificar en el momento del build.

**Rationale**:
- **Tamaño real**: el dataset de referencia es `fraxen/tectonicplates` (repo público basado en Peter Bird, 2003, "An updated digital model of plate boundaries", PB2002). El archivo `GeoJSON/PB2002_boundaries.json` de ese repo son líneas (no polígonos rellenos) de ~230 líneas de falla/límite a nivel global; el tamaño reportado por el propio repo y por proyectos que lo consumen (p. ej. forks usados en mapas Leaflet/Mapbox) es del orden de **250-300 KB** sin simplificar. No pude descargarlo en este entorno (sin acceso de red) para medir el byte-count exacto — se documenta como supuesto a verificar en `sdd-apply` con `curl -sI` o al vendorizar, pero el orden de magnitud (cientos de KB, no MB) es conocido y consistente con reportes de terceros que lo integran en mapas web. Esto confirma la sospecha de la exploración: "decenas de KB" era optimista, es más cercano a "unos cientos de KB" — igual sigue siendo liviano frente a los tiles del mapa base.
- **Vendorizar > CDN en runtime**: el proyecto ya tiene un patrón de servir assets estáticos desde `public/` (Next.js los sirve same-origin, cacheable con headers HTTP estándar, sin CORS, sin dependencia de disponibilidad de un tercero en cada carga de página). Un CDN externo (jsDelivr/GitHub raw) introduce una dependencia de red no controlada por el equipo en el hot path del Dashboard — si `cdn.jsdelivr.net` tiene un incidente, el mapa principal del producto pierde una capa visible sin que el equipo pueda mitigarlo salvo con un fallback. Vendorizar es la opción consistente con "sin dependencia de red externa en runtime" que la propuesta pedía resolver explícitamente.
- **Simplificación**: SÍ se simplifica, pero manualmente al vendorizar (no con una librería `topojson-simplify` como dependencia nueva de build, que sería agregar una herramienta para un archivo que se vendoriza una sola vez y prácticamente no cambia). El archivo PB2002 completo trae mucha densidad de vértices en curvas suaves; usando una herramienta externa al proyecto en el momento de preparar el vendor file (ej. `mapshaper` vía CLI one-off, no como dependencia del repo) se reduce a un GeoJSON simplificado antes de commitear a `public/geo/plate-boundaries.json`. Esto evita instalar topojson/mapshaper como dependencia permanente del `package.json` — es una herramienta de preparación de datos, se usa una vez y se descarta. Target: reducir a <150 KB manteniendo fidelidad visual a nivel de zoom del Dashboard (zoom 3-7, donde el detalle de vértice fino no es perceptible).
- **Carga async no bloqueante**: el `fetch()` ocurre en un `useEffect` separado del que inicializa el mapa base, de modo que el mapa y los eventos se renderizan inmediatamente y la capa de placas aparece cuando el fetch resuelve (típicamente <100ms same-origin). Esto responde directamente al riesgo "El GeoJSON... agrega peso/latencia a la carga inicial" señalado en la propuesta: al ser same-origin y cargado en paralelo sin bloquear el resto del render, el impacto percibido es mínimo.

### Decision 2: Extensión de `AdvancedSeismicMap` — props nuevas

**Choice**: Agregar las siguientes props, todas opcionales con defaults que preservan el comportamiento actual:

```typescript
interface AdvancedSeismicMapProps {
  eventos: SeismicEvent[];
  className?: string;
  showCities?: boolean;          // ya existe
  defaultLayer?: keyof typeof BASE_LAYERS; // ya existe

  // Nuevas — todas opcionales, no rompen /explore
  showPlateBoundaries?: boolean;         // default: false (comportamiento actual sin cambios en /explore)
  selectedEventId?: string | null;       // default: undefined → sin selección, comportamiento actual
  onEventClick?: (id: string) => void;   // default: undefined → sin listener, comportamiento actual
  onBoundsChange?: (visibleCount: number, totalCount: number) => void; // default: undefined
}
```

**Alternatives considered**:
- Crear un componente nuevo `DashboardSeismicMap` que envuelva o duplique `AdvancedSeismicMap` con las features del Dashboard.
- Pasar un único objeto de configuración `dashboardMode?: { plates: boolean; selectedId: string | null; ... }` en vez de props sueltas.

**Rationale**:
- Todas las props nuevas son opcionales y `undefined`/`false` por default, así que una invocación existente como `<AdvancedSeismicMap eventos={eventos} className="h-[700px]" showCities={true} />` en `/explore/page.tsx` (línea 192-196) sigue compilando y comportándose exactamente igual — ningún nuevo `useEffect` se activa si la prop no se pasa.
- Se prefieren props sueltas y no un objeto único: el proyecto ya usa ese estilo (`showCities`, `defaultLayer` son props planas, no un objeto de config), así que es consistencia con el patrón existente, no una convención nueva.
- Se descarta el componente separado `DashboardSeismicMap`: reintroduciría exactamente la duplicación de lógica Leaflet (init/cleanup/`_leaflet_id`) que la propuesta identificó como problema a resolver (`SeismicMapWithCities` vs `AdvancedSeismicMap`). Extender el componente maduro existente es la única opción que de verdad consolida.
- `onBoundsChange` se diseña como callback hacia afuera (no estado interno expuesto) porque el contador vive en `page.tsx`, no en el mapa — ver Decisión 4.
- La capa de ciudades (`MAJOR_CITIES`, ya presente en `AdvancedSeismicMap` detrás de `showCities`) usa el mismo mecanismo (`L.circleMarker` + `L.divIcon`) que `SeismicMapWithCities`, pero su listado de datos se unifica como parte de este change — ver Decisión 7.

### Decision 3: Sincronización click-en-tabla → resalta/centra en mapa

**Choice**: Estado local `useState<string | null>` en `page.tsx`, mismo patrón que usa `/explore/page.tsx` para `view`/`filters`/`eventos` (ya es el patrón establecido del proyecto, no una convención nueva):

```typescript
// app/page.tsx
const [selectedEventId, setSelectedEventId] = useState<string | null>(null);

<EventsTable eventos={eventos} limit={10} onRowClick={setSelectedEventId} selectedEventId={selectedEventId} />
<AdvancedSeismicMap eventos={eventos} selectedEventId={selectedEventId} onEventClick={setSelectedEventId} showCities showPlateBoundaries onBoundsChange={handleBoundsChange} />
```

Dentro de `AdvancedSeismicMap`, un `useEffect` con dependencia `[selectedEventId]` busca el marcador correspondiente (por `evento.id` guardado en un `Map<string, L.CircleMarker>` ref junto al ref existente `layersRef`/`overlaysRef`) y llama `marker.openPopup()` + `map.panTo([lat, lon])` (no `setView` con zoom forzado, para no desorientar si el usuario ya hizo zoom manual).

**Alternatives considered**:
- Context API de React para compartir `selectedEventId` sin prop drilling.
- Zustand u otro store global (descartado explícitamente por la propuesta).
- Emitir un `CustomEvent` del DOM entre componentes desacoplados.

**Rationale**: `page.tsx` es el único padre común de `EventsTable` y `AdvancedSeismicMap` en este árbol (2 niveles: `page.tsx` → ambos hijos directos), así que prop drilling con `useState` no tiene el problema que Context resolvería (no hay niveles intermedios). Es exactamente el patrón que ya usa `/explore/page.tsx` para coordinar `FilterPanel` → `eventos` → `AdvancedSeismicMap`/`EventsTable`. Introducir Context o un store para 2 niveles de profundidad sería sobre-ingeniería no justificada, y la propuesta ya descartó explícitamente Zustand/estado global para este change.

### Decision 4: Contador "N of M events in map area"

**Choice**: "M" (total) es siempre `eventos.length` (todos los eventos que trajo el `useSWR('/report', ...)`, ya limitados por `region_monitorizada` del backend). "N" (en área) se calcula contra **los bounds actuales del mapa Leaflet** (`map.getBounds()`), no contra el bbox fijo `settings.bbox`/`region_monitorizada` del backend. El cálculo vive dentro de `AdvancedSeismicMap` (tiene acceso directo a la instancia de Leaflet) y se expone hacia `page.tsx` vía el callback `onBoundsChange(visibleCount, totalCount)` de la Decisión 2, escuchando los eventos nativos de Leaflet `moveend` y `zoomend`:

```typescript
useEffect(() => {
  if (!leafletMapRef.current || !onBoundsChange) return;
  const map = leafletMapRef.current;
  const recompute = () => {
    const bounds = map.getBounds();
    const visible = eventos.filter(e => bounds.contains([e.lat, e.lon])).length;
    onBoundsChange(visible, eventos.length);
  };
  recompute(); // cálculo inicial
  map.on('moveend zoomend', recompute);
  return () => { map.off('moveend zoomend', recompute); };
}, [eventos, onBoundsChange]);
```

`page.tsx` guarda el resultado en `useState<{visible: number; total: number}>` y lo renderiza junto al mapa (ej. en el `<h2>` del bloque "Mapa de Epicentros y Ciudades" o en un `Badge` adyacente).

**Alternatives considered**:
- Usar el bbox fijo `region_monitorizada`/`settings.bbox` que ya devuelve el backend como denominador de "área".
- Calcular "en área" en `page.tsx` en vez de dentro del mapa, requiriendo exponer `map.getBounds()` hacia afuera con una ref.

**Rationale**:
- El bbox de `region_monitorizada` es la región que el **backend** monitorea (fijo, definido por configuración del servidor) — no cambia cuando el usuario hace zoom/pan en el mapa del navegador. Si "N of M events in map area" usara ese bbox fijo, el contador sería una constante (siempre "M of M", porque el backend ya filtró los eventos a esa región antes de mandarlos) y no reflejaría lo que el usuario ve realmente en pantalla tras interactuar con el mapa. Eso contradice el propósito explícito del contador (replicar el patrón `earthquake.usgs.gov/earthquakes/map`, donde el número SÍ cambia con el viewport).
- `map.getBounds()` es el mecanismo real y estándar de Leaflet para "qué hay visible ahora"; es la única fuente de verdad consistente con lo que el usuario ve, y es liviano de recalcular (filter lineal sobre `eventos`, que en este Dashboard es del orden de decenas/cientos de eventos, no miles).
- El cálculo vive dentro de `AdvancedSeismicMap` (no en `page.tsx` con una ref expuesta hacia afuera) porque el mapa ya es dueño de la instancia Leaflet y de sus listeners de ciclo de vida (mismo archivo que ya maneja `useEffect` de init/cleanup) — exponer `map.getBounds()` crudo hacia `page.tsx` obligaría a duplicar lógica de suscripción a eventos Leaflet fuera del componente que los encapsula, rompiendo el encapsulamiento que el propio componente ya tiene para sus otros efectos (capas, overlays, eventos).

### Decision 5: Migración de `KPICard`, `AlertBanner`, `EventsTable` a la paleta industrial

**Choice**: reemplazo componente por componente, mapeado concreto:

| Componente actual | Reemplazo |
|---|---|
| `KPICard`: div con `colorClasses`/`iconColorClasses` (bg-blue-50/border-blue-200/text-blue-600, etc.) | `Card`/`CardContent` de `components/ui/card.tsx` como contenedor; prop `color` (`blue\|green\|yellow\|red\|gray`) se remapea a severidad: `red`→`--severity-critical`, `yellow`→`--severity-moderate`, `green`→`--severity-ok` (token dedicado, ver Decisión 8), `blue`/`gray`→neutro (`text-muted-foreground`/`text-foreground` de shadcn, no un color de severidad ya que "Total Eventos" no es una magnitud de severidad). El valor numérico (`value`) pasa a usar `.font-data` (tabular-nums, ya definida en `globals.css`) para alineación correcta de dígitos al actualizarse cada 60s. |
| `AlertBanner`: `severityStyles` con `red-100/yellow-100/blue-100` hardcodeado por `danger\|warning\|info` | Remapeo directo 1:1 por ser ya una escala de severidad: `danger`→`--severity-critical`, `warning`→`--severity-moderate`, `info`→`--severity-low`. Se usa `Badge` de shadcn para el conteo `({alertas.length})` y para el tipo de alerta (`evento_significativo`, etc.) en vez de texto plano con emoji. El bloque "sin alertas" (`green-50`) usa `--severity-ok` (Decisión 8), semánticamente correcto: "sin alertas" no es un nivel de severidad, es su ausencia, y ahora tiene token propio en vez de pedir prestado `--severity-low`. |
| `EventsTable`: `<table>` HTML plano con `bg-gray-100`, `divide-gray-200`, badge de magnitud vía `style={{ backgroundColor: getMagnitudeColor(...) }}` inline | Se mantiene `<table>` HTML nativo (no se instala `Table` de shadcn en este change — ver Open Questions, no está en el inventario y la propuesta no lo pide explícitamente). Los `<th>`/`<td>` migran clases `text-gray-700 dark:text-gray-300` → `text-muted-foreground`/`text-foreground` de shadcn. El badge de magnitud reemplaza el `style` inline por `Badge` de shadcn con clase condicional mapeada a severidad por rango de magnitud (mag≥6→`--severity-critical`, mag≥5→`--severity-high`, mag≥4→`--severity-moderate`, si no→`--severity-low`), calculado por una función nueva `getMagnitudeSeverity(mag): 'low'\|'moderate'\|'high'\|'critical'` en `lib/utils.ts` que sustituye el uso de `getMagnitudeColor()` en este componente (pero NO se borra `getMagnitudeColor()`, sigue en uso por `AdvancedSeismicMap`/`SeismicMapWithCities` para el color de los círculos del mapa, que no son tokens shadcn sino colores directos pasados a Leaflet). Filas ganan `data-state=selected` / clase condicional cuando `evento.id === selectedEventId` (ring o fondo con `--severity-low`/`primary` a baja opacidad) para reflejar la sincronización de la Decisión 3. Los valores numéricos (magnitud, profundidad, coordenadas si se muestran) usan `.font-data`. |

**Alternatives considered**: Reescribir `EventsTable` sobre el componente `Table` de shadcn (`table.tsx`, no instalado); mantener `getMagnitudeColor()` como única fuente de color y solo cambiar el contenedor a `Card`.

**Rationale**: Instalar `Table`/`Select`/`Checkbox`/`ScrollArea` de shadcn está fuera de scope de este change (la propuesta no los menciona, y `Select`/`Checkbox` son para el filtro Sort/Format y "solo visibles" que están explícitamente en Out of Scope). Se prioriza consistencia de tokens de color/tipografía (lo que la propuesta sí pide) sin forzar una reescritura estructural de la tabla que no fue pedida. Se preserva `getMagnitudeColor()` porque Leaflet no puede consumir variables CSS de shadcn directamente (`fillColor` de un `L.circleMarker` necesita un string de color resuelto, no un token `hsl(var(--severity-high))` — aunque técnicamente si se resuelve el valor en runtime con `getComputedStyle` podría hacerse, es complejidad no justificada para este change; se documenta como posible mejora futura, no se implementa aquí).

### Decision 6: Verificación manual de `/explore`

Ver sección "Testing Strategy" para el plan concreto.

### Decision 7 (CONFIRMADA por el usuario): Unificación del listado de ciudades en `MAJOR_CITIES`

**Choice**: `AdvancedSeismicMap.tsx` tiene hoy 9 ciudades (líneas 21-31): Buenos Aires, Santiago, Lima, Bogotá, Caracas, Quito, La Paz, Asunción, Montevideo. `SeismicMapWithCities.tsx` tiene 27 ciudades (líneas 19-57), agrupadas por país AR(9)/CL(7)/PE(4)/BO(3)/PY(1)/UY(1), cada una con un campo `country` adicional que `AdvancedSeismicMap` no tiene hoy.

Se reemplaza el array `MAJOR_CITIES` de `AdvancedSeismicMap.tsx` (líneas 21-31) por la unión de ambos listados, deduplicando por coincidencia de nombre+coordenadas:

- **Overlap exacto** (mismas coords en ambos archivos, se toma una sola vez): Buenos Aires, Santiago, Lima, La Paz, Asunción, Montevideo (6 ciudades).
- **Exclusivas de las 27** (se incorporan tal cual, con su `country`): Córdoba, Rosario, Mendoza, San Juan, San Miguel de Tucumán, Salta, Mar del Plata, Neuquén (AR); Valparaíso, Concepción, Antofagasta, Temuco, Iquique, Valdivia, Coquimbo (CL); Arequipa, Cusco, Trujillo (PE); Santa Cruz, Cochabamba (BO) — 21 ciudades.
- **Exclusivas de las 9** (Bogotá, Caracas, Quito — Colombia/Venezuela/Ecuador, fuera de la cobertura AR/CL/PE/BO/PY/UY de las 27, pero ya visibles hoy en el Dashboard): se conservan para no perder cobertura visual existente — 3 ciudades.

Total unificado: **30 ciudades** (27 + 3, sin duplicados). El campo `country` de `SeismicMapWithCities` se incorpora al tipo del array en `AdvancedSeismicMap` (hoy solo tiene `name`/`lat`/`lon`/`population`) porque ya se usa en el popup de `SeismicMapWithCities` (`<p class="text-xs text-gray-600">${city.country}</p>`) y aporta valor informativo sin costo — Bogotá/Caracas/Quito quedan con `country: 'Colombia' | 'Venezuela' | 'Ecuador'` respectivamente para consistencia de tipo.

**Alternatives considered**:
- Mantener las 9 ciudades actuales de `AdvancedSeismicMap` y aceptar la pérdida de cobertura en el Dashboard (opción documentada como Open Question, ahora descartada).
- Usar únicamente las 27 de `SeismicMapWithCities` y eliminar Bogotá/Caracas/Quito del Dashboard.

**Rationale**: El usuario confirmó explícitamente que no debe haber pérdida de contenido al migrar el Dashboard de `SeismicMapWithCities` a `AdvancedSeismicMap`. Las 27 son el conjunto de referencia (más completo, con `country`), pero descartar Bogotá/Caracas/Quito sería quitarle al Dashboard ciudades que hoy sí ve, así que se fusionan ambos listados en vez de elegir uno. Este cambio es exclusivamente de datos (un array literal), no toca la lógica de renderizado de `L.circleMarker`/`L.divIcon`/tamaño por población, que ya funciona igual en ambos componentes.

**File Change actualizado**: `dashboard/components/AdvancedSeismicMap.tsx` — el array `MAJOR_CITIES` (líneas 21-31) se reemplaza por el listado unificado de 30 ciudades con campo `country` agregado al tipo.

### Decision 8 (CONFIRMADA por el usuario): Token `--severity-ok`

**Choice**: Se agrega un quinto token de severidad, `--severity-ok`, en `dashboard/app/globals.css`, siguiendo el mismo formato que los cuatro tokens existentes (`--severity-low/moderate/high/critical`, definidos como tripleta HSL sin la función `hsl()` — se consumen vía `hsl(var(--severity-x))` en Tailwind, igual que el resto de los tokens shadcn del archivo: `--primary`, `--destructive`, etc.).

Valores propuestos (mismo patrón de la paleta: hue teal/172 del primario, ajustando luminosidad para diferenciarlo de `--severity-low` sin salir de la familia teal):

- **Modo claro** (`:root`, después de la línea `--severity-low: 172 70% 38%;` en el bloque de severidad, línea 43): `--severity-ok: 172 55% 45%;` — mismo hue 172 que `--primary` (172 80% 32%) y `--severity-low` (172 70% 38%), con saturación reducida (55% vs 70%) y luminosidad más alta (45% vs 38%) para leerse como un teal "calmo/neutro-positivo", visualmente distinguible de `--severity-low` (que ya señala "hay actividad, es baja") sin salir de la paleta industrial.
- **Modo oscuro** (`.dark`, después de la línea `--severity-low: 172 65% 45%;` en el bloque de severidad, línea 78): `--severity-ok: 172 45% 52%;` — mismo criterio: hue 172 constante, saturación más baja que `--severity-low` (45% vs 65%), luminosidad ligeramente mayor (52% vs 45%) para mantener contraste sobre el fondo oscuro (`--background: 217 40% 7%`) sin competir visualmente con los tonos de alerta real (moderate/high/critical).

```css
/* :root, dentro del bloque "Severidad sísmica" (línea 42-47) */
--severity-low: 172 70% 38%;
--severity-ok: 172 55% 45%;      /* NUEVO */
--severity-moderate: 43 96% 50%;
--severity-high: 24 94% 53%;
--severity-critical: 4 90% 55%;

/* .dark, dentro del bloque equivalente (línea 78-81) */
--severity-low: 172 65% 45%;
--severity-ok: 172 45% 52%;      /* NUEVO */
--severity-moderate: 43 92% 55%;
--severity-high: 24 90% 58%;
--severity-critical: 4 85% 60%;
```

**Uso**: reemplaza el uso aproximado de `--severity-low` documentado en la Decisión 5 para `KPICard color="green"` y el estado "sin alertas activas" de `AlertBanner` — ahora ambos casos usan `--severity-ok` como token dedicado, semánticamente correcto ("todo OK" ya no pide prestado el significado de "severidad baja pero presente").

**Alternatives considered**:
- Reusar `--severity-low` para el significado "OK" (rechazado explícitamente por el usuario — mezclaba dos semánticas distintas: "hay actividad de baja severidad" vs "no hay actividad/todo bien").
- Usar un verde estándar fuera de la escala de severidad (p. ej. `emerald-500` de Tailwind directo, sin token CSS). Rechazado porque el resto de la paleta de severidad ya está tokenizada en `globals.css` y mezclar un color hardcodeado de Tailwind rompería la consistencia del sistema de tokens que el resto del Dashboard sigue.

**Rationale**: Mantener el mismo hue (172) que `--primary`/`--severity-low` preserva la identidad "teal industrial" de la paleta en vez de introducir un verde genérico ajeno a la paleta (p. ej. `142` de Tailwind `green`). Variar solo saturación/luminosidad es el mismo mecanismo que la paleta ya usa para diferenciar `--primary` de `--severity-low` (ambos hue 172, distinta saturación/luminosidad), así que es consistente con el criterio de diseño ya establecido, no uno nuevo.

**File Change actualizado**: `dashboard/app/globals.css` — se agrega `--severity-ok: 172 55% 45%;` en la línea 44 (dentro de `:root`, inmediatamente después de `--severity-low`) y `--severity-ok: 172 45% 52%;` en la línea 79 (dentro de `.dark`, en la misma posición relativa).

## Data Flow

    useSWR('/report') ──→ page.tsx (kpis, alertas, eventos, region_monitorizada)
                              │
              ┌───────────────┼────────────────────┐
              ▼               ▼                     ▼
         AlertBanner      KPICard×4            EventsTable
         (severity        (severity            (severity badge,
          tokens)          tokens,               onRowClick)
                            .font-data)               │
                                                       │ setSelectedEventId(id)
                                                       ▼
                                              useState<selectedEventId>
                                                       │
                                                       ▼
                                          AdvancedSeismicMap (extendido)
                                          ├─ eventos (existente)
                                          ├─ showCities (existente, ya soporta ciudades)
                                          ├─ selectedEventId → panTo + openPopup
                                          ├─ onEventClick → setSelectedEventId (click marcador → resalta fila, opcional/bonus)
                                          ├─ showPlateBoundaries → fetch('/geo/plate-boundaries.json') → L.geoJSON()
                                          └─ onBoundsChange(visible,total) → useState en page.tsx → contador "N of M"

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `dashboard/public/geo/plate-boundaries.json` | Create | GeoJSON PB2002 vendorizado y simplificado (fuente: `fraxen/tectonicplates`), target <150 KB |
| `dashboard/app/page.tsx` | Modify | Migra a tokens/shadcn; agrega `useState<selectedEventId>` y `useState<{visible,total}>`; reemplaza `SeismicMapWithCities` por `AdvancedSeismicMap` extendido con `showCities showPlateBoundaries` |
| `dashboard/components/KPICard.tsx` | Modify | `colorClasses`/`iconColorClasses` → `Card` shadcn + tokens de severidad (mapeo Decisión 5); valor numérico usa `.font-data` |
| `dashboard/components/AlertBanner.tsx` | Modify | `severityStyles` → `--severity-*` 1:1; `Badge` shadcn para conteo y tipo |
| `dashboard/components/EventsTable.tsx` | Modify | Clases grises → tokens shadcn; badge de magnitud vía `Badge` + `getMagnitudeSeverity()`; nuevas props `onRowClick?: (id: string) => void`, `selectedEventId?: string \| null`; fila seleccionada resaltada; `.font-data` en columnas numéricas |
| `dashboard/components/AdvancedSeismicMap.tsx` | Modify | Nuevas props opcionales (`showPlateBoundaries`, `selectedEventId`, `onEventClick`, `onBoundsChange`); nuevo `useEffect` para fetch+render de placas; nuevo `useEffect` para centrar/resaltar por `selectedEventId`; nuevo listener `moveend`/`zoomend` para el conteo; ref adicional `Map<string, L.CircleMarker>` para lookup de marcador por id; `MAJOR_CITIES` (líneas 21-31) se reemplaza por el listado unificado de 30 ciudades con campo `country` (Decisión 7) |
| `dashboard/lib/map-layers.ts` | Modify | `GEOLOGICAL_OVERLAYS.plateBoundaries` se retira del mecanismo de tile layer genérico (ya no se usa como `L.tileLayer` en el loop de overlays); la URL WMS mal etiquetada se elimina/deprecia, el nuevo mecanismo GeoJSON vive directamente en `AdvancedSeismicMap.tsx` apuntando a `/geo/plate-boundaries.json` (no es un `MapLayer`/`GeologicalOverlay` más — es un tipo de capa distinto, vector no tile) |
| `dashboard/lib/utils.ts` | Modify | Nueva función `getMagnitudeSeverity(mag: number): 'low' \| 'moderate' \| 'high' \| 'critical'`, usada por `EventsTable` para mapear a `Badge`/tokens; `getMagnitudeColor()` se conserva sin cambios (sigue en uso por Leaflet) |
| `dashboard/app/globals.css` | Modify | Se agrega el token `--severity-ok` en `:root` (línea 44) y `.dark` (línea 79) — ver Decisión 8 |
| `dashboard/components/SeismicMapWithCities.tsx` | No change (deprecated, sin importar) | Se mantiene intacto en el repo, sin referencias activas desde `page.tsx` tras este change |

## Interfaces / Contracts

```typescript
// components/AdvancedSeismicMap.tsx
interface AdvancedSeismicMapProps {
  eventos: SeismicEvent[];
  className?: string;
  showCities?: boolean;                  // ya existente, sin cambios de comportamiento
  defaultLayer?: keyof typeof BASE_LAYERS; // ya existente, sin cambios de comportamiento
  showPlateBoundaries?: boolean;          // NUEVO — default false
  selectedEventId?: string | null;        // NUEVO — default undefined (sin selección)
  onEventClick?: (id: string) => void;    // NUEVO — default undefined (sin listener)
  onBoundsChange?: (visibleCount: number, totalCount: number) => void; // NUEVO — default undefined
}

// components/EventsTable.tsx
interface EventsTableProps {
  eventos: SeismicEvent[];
  limit?: number;
  className?: string;
  onRowClick?: (id: string) => void;      // NUEVO — default undefined
  selectedEventId?: string | null;        // NUEVO — default undefined
}

// lib/utils.ts
export function getMagnitudeSeverity(mag: number): 'low' | 'moderate' | 'high' | 'critical';
```

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | `getMagnitudeSeverity()` mapea correctamente los umbrales (≥6 critical, ≥5 high, ≥4 moderate, <4 low) | Vitest, ya usado en el proyecto (`devDependencies.vitest`) |
| Unit | Cálculo de "eventos en área" (`bounds.contains`) con datos mockeados de eventos y un bounds fijo | Vitest, mockeando `L.LatLngBounds` o extrayendo la función de filtro a una utilidad pura testeable en `lib/` en vez de dejarla inline en el `useEffect` |
| Integration | `EventsTable` invoca `onRowClick` con el `id` correcto al hacer click en una fila | React Testing Library (`@testing-library/react` ya en devDependencies) |
| Integration | `AdvancedSeismicMap` no rompe cuando las props nuevas no se pasan (uso legacy de `/explore`) | Render con solo `eventos`+`className`+`showCities`, verificar que no lanza y no intenta hacer fetch de placas |
| E2E / Manual | Ver plan detallado abajo | `npm run build` + verificación manual en navegador (no hay suite E2E de Playwright configurada más allá de `@playwright/test` en devDependencies sin specs localizados en esta exploración — se asume verificación manual como gate primario, consistente con el Success Criteria de la propuesta: "npm run build pasa sin errores") |

### Plan de verificación manual de `/explore` (Decisión 6 / riesgo señalado en la propuesta)

Objetivo: confirmar que extender `AdvancedSeismicMap` con las 4 props nuevas no introduce regresiones en `/explore`, que la consume hoy con `<AdvancedSeismicMap eventos={eventos} className="h-[700px]" showCities={true} />` (sin ninguna de las props nuevas).

1. `npm run dev` en `dashboard/`, navegar a `/explore`.
2. Ejecutar una búsqueda con los filtros default (`FilterPanel` → "Buscar Eventos") y confirmar que el mapa se renderiza con eventos, capas base y ciudades exactamente como antes del change (comparación visual contra un screenshot pre-change si está disponible, o contra la memoria funcional documentada en `exploration.md`).
3. Confirmar en DevTools → Network que **no** se dispara un `fetch` a `/geo/plate-boundaries.json` en `/explore` (porque `showPlateBoundaries` no se pasa ahí → default `false` → el `useEffect` correspondiente no debe ejecutar el fetch).
4. Confirmar que el botón "Capas del mapa" (`Layers` icon, control existente) sigue abriendo el panel de capas base/overlays geológicos sin cambios visuales ni funcionales.
5. Cambiar entre vista Mapa/Lista (`view === 'map' | 'list'`) y confirmar que no hay errores de consola relacionados a los nuevos `useEffect` (por ejemplo, `onBoundsChange`/`onEventClick` siendo `undefined` no debe lanzar al intentar invocarlos — los nuevos efectos deben guardear con `if (!onBoundsChange) return;` como se muestra en Decisión 4).
6. Confirmar que el popup de un marcador de evento sigue mostrando la info completa (magnitud, lugar, hora, profundidad, coords, fuentes, emoji de fuente) sin cambios, ya que ese código no se toca.
7. Dejar registrado el hallazgo colateral ya conocido (`bg-seismic-600` roto en esta página) sin corregirlo, tal como definió la propuesta.

## Migration / Rollout

No migración de datos. Rollout es un cambio de frontend puro, deployado junto con el resto del Dashboard. El archivo `plate-boundaries.json` se agrega a `public/` en el mismo commit que lo consume — no requiere paso de build adicional ni proceso de sincronización periódica (el dataset PB2002 es esencialmente estático, no se actualiza con frecuencia en el upstream). Si en el futuro se requiere actualizar el archivo, es un reemplazo manual del asset vendorizado, sin lógica de versionado automatizada en este change.

## Open Questions

- [ ] **Tamaño exacto del GeoJSON vendorizado**: no se pudo descargar `fraxen/tectonicplates` en este entorno (sin acceso de red) para confirmar el byte-count real antes/después de simplificar. `sdd-apply` debe verificarlo al vendorizar el archivo (`ls -lh` post-simplificación) y confirmar que quedó bajo el target de <150 KB; si no, ajustar el nivel de simplificación.

## Decisiones resueltas (previamente Open Questions)

- **Discrepancia de listado de ciudades**: resuelta en Decisión 7. Se unifican las 9 ciudades de `AdvancedSeismicMap` con las 27 de `SeismicMapWithCities`, deduplicando por overlap (6 ciudades en común), resultando en 30 ciudades totales sin pérdida de cobertura respecto al Dashboard actual.
- **Color semántico "verde/ok" fuera de la escala `--severity-*`**: resuelta en Decisión 8. Se agrega el token `--severity-ok` (hue 172, consistente con `--primary`/`--severity-low`) en `globals.css`, tanto en `:root` como en `.dark`, con valores concretos `172 55% 45%` (claro) y `172 45% 52%` (oscuro).
