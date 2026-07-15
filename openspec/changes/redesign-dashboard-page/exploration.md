## Exploration: redesign-dashboard-page

### Current State

**Hallazgo crítico #1 — la Fase 1 de UI (shadcn/ui + sidebar + paleta industrial) NO llegó a ninguna página de contenido.** Solo tocó el layout raíz:

- `dashboard/app/layout.tsx` — usa `SidebarProvider`/`SidebarInset`/`AppSidebar`, fuentes Familjen Grotesk / IBM Plex Sans / JetBrains Mono cargadas vía `next/font/google` con CSS vars (`--font-heading`, `--font-sans`, `--font-mono`), header con `.font-data`.
- `dashboard/app/globals.css` — define correctamente los tokens shadcn (`--background`, `--primary` hue 172, etc.) y los 4 tokens de severidad `--severity-low/moderate/high/critical` separados de `--destructive`, en `:root` y `.dark`. Clase utilitaria `.font-data` (tabular-nums, mono) ya lista para usar.

Pero **`app/page.tsx` (Dashboard), `app/explore/page.tsx`, `app/analytics/page.tsx`, y los componentes que consumen (`KPICard`, `AlertBanner`, `EventsTable`, `SeismicMapWithCities`, `AdvancedSeismicMap`) siguen 100% en Tailwind genérico pre-rediseño**: `text-gray-900 dark:text-white`, `border-red-200 dark:border-red-800`, `bg-blue-50`, colores hardcodeados por magnitud vía `getMagnitudeColor()` (no tokens CSS), y ningún uso de `.font-data`, `--severity-*`, ni componentes `ui/*` de shadcn (excepto los ya usados en sidebar/layout: `card`, `sheet`, `tooltip`, `badge`, `sidebar`, `separator`, `button`, `input`, `skeleton`).

De hecho `explore/page.tsx` referencia `bg-seismic-600` (clase Tailwind de un sistema de colores anterior que ya no existe en `tailwind.config`/`globals.css` actual) — probablemente renderiza sin color de fondo hoy, es una regresión visual silenciosa del rediseño de Fase 1 que nadie notó porque no se tocó esa página.

**`app/page.tsx` (Dashboard actual, 125 líneas):**
- `'use client'`, fetch vía `useSWR('/report', reportFetcher, { refreshInterval: 60000, revalidateOnFocus: true })`.
- Ya NO tiene el bug de "0 eventos" (resuelto en `unify-dashboard-events-source`, backend fusiona USGS+EMSC+INPRES).
- Estructura: header con título + timestamp relativo, banner de `data_source_errors` (warnings amarillos), `<AlertBanner alertas={alertas} />`, grid de 4 `<KPICard>` (Total Eventos, Magnitud Máxima, Profundidad Media M≥4, Eventos Sentidos), luego grid 2 columnas: `<SeismicMapWithCities>` (izq, `h-[500px]` fijo) + `<EventsTable limit={10}>` (der).
- **No usa `min-h-screen`** en el div raíz (`<div className="space-y-8">`) — ya cumple esa regla.
- No tiene: contador "N of M events in map area", sincronización mapa↔lista, checkbox "solo visibles en mapa", toggle de color por antigüedad/profundidad, límites de placas tectónicas, selector Sort/Format.

**`SeismicMapWithCities.tsx`** (usado hoy en Dashboard):
- Leaflet vía `import('leaflet')` dinámico client-side. 3 tile layers (terrain/streets/satellite) con `L.control.layers()`.
- Dibuja rectángulo rojo punteado del bbox `region_monitorizada`.
- Ciudades: array hardcodeado `MAJOR_CITIES` (27 ciudades AR/CL/PE/BO/PY/UY) como `L.circleMarker` + `L.divIcon` label, tamaño por población.
- Eventos: `L.circleMarker` con `radius = mag*4` clamped [4,30], color por `getMagnitudeColor(mag)` (función en `lib/utils.ts`, NO token CSS), popup con magnitud/lugar/hora/profundidad/coords/fuentes.
- **Sin capa de límites de placas tectónicas.** Sin toggle antigüedad/profundidad — el color solo depende de magnitud, no hay noción de "reciente vs viejo".
- Sin sincronización con ninguna lista externa (no emite eventos de click/hover hacia afuera, no escucha selección).

**`AdvancedSeismicMap.tsx`** (usado hoy en `/explore`, NO en Dashboard):
- Mismo patrón de Leaflet dinámico, pero más maduro: `BASE_LAYERS` (5 capas: terrain/street/satellite/greyscale/ocean) y `GEOLOGICAL_OVERLAYS` desde `lib/map-layers.ts`, con panel de control de capas propio (botón flotante `Layers` + panel expandible con radios de capa base y checkboxes de overlays).
- **`GEOLOGICAL_OVERLAYS.plateBoundaries` YA EXISTE como entrada de configuración** pero apunta a `services.arcgisonline.com/.../World_Boundaries_and_Places/MapServer` (un tile layer WMS genérico de fronteras políticas/referencias, **NO es el GeoJSON PB2002 de placas tectónicas que pide la Sección 11** del doc de arquitectura — es un placeholder mal etiquetado, no la fuente real `fraxen/tectonicplates`).
- Popup incluye emoji de fuente (🇪🇺/🇦🇷/🇺🇸) además de magnitud/lugar/hora/profundidad/coords/fuentes.
- Tampoco tiene sincronización lista↔mapa ni contador "N of M". Se usa junto a `EventsTable` en `/explore` pero como dos vistas alternantes (`view === 'map' | 'list'`), no simultáneas ni sincronizadas.

### Affected Areas

- `seismic-monitor/dashboard/app/page.tsx` — objetivo principal del rediseño; migrar a tokens de severidad, `.font-data`, componentes shadcn (`Card`, `Badge`), y decidir alcance de features de Sección 11.
- `seismic-monitor/dashboard/components/KPICard.tsx` — reescribir con `card.tsx` de shadcn + tokens en vez de `colorClasses`/`iconColorClasses` hardcodeados en Tailwind gris/azul/etc.
- `seismic-monitor/dashboard/components/AlertBanner.tsx` — migrar `severityStyles` (red/yellow/blue Tailwind) a `--severity-low/moderate/high/critical`.
- `seismic-monitor/dashboard/components/EventsTable.tsx` — usado también en `/explore` y `/analytics`; cualquier cambio de skin afecta esas 2 páginas también (riesgo de acoplamiento, ver Risks).
- `seismic-monitor/dashboard/components/SeismicMapWithCities.tsx` — candidato a extender con capa de placas tectónicas y toggle antigüedad/profundidad, o a reemplazar por una variante de `AdvancedSeismicMap`.
- `seismic-monitor/dashboard/components/AdvancedSeismicMap.tsx` — referencia de patrón (control de capas ya construido); su overlay `plateBoundaries` está mal apuntado y sería necesario corregirlo si se reusa.
- `seismic-monitor/dashboard/lib/map-layers.ts` — `GEOLOGICAL_OVERLAYS.plateBoundaries.url` requiere reemplazo por un GeoJSON real de `fraxen/tectonicplates` (no es un simple tile WMS, es vector GeoJSON — cambia el mecanismo de carga, no solo la URL).
- `seismic-monitor/dashboard/lib/utils.ts` — `getMagnitudeColor()` devuelve strings de color fijos; si se introduce el switch antigüedad/profundidad de Sección 11.A, necesita una función de color adicional (por edad) y otra por profundidad, ambas idealmente derivadas de los tokens de severidad para mantener coherencia con el resto del sistema.
- `seismic-monitor/dashboard/components/ui/*` — inventario disponible: `card`, `badge`, `tooltip`, `sheet`, `sidebar`, `separator`, `button`, `input`, `skeleton`. Aplicables directo: `Card` (KPIs, paneles), `Badge` (magnitud, fuentes, estado revisado/sentido), `Tooltip` (detalles de evento sin depender de popups de Leaflet), `Skeleton` (loading state en vez del spinner genérico actual).
- **Faltan en el inventario shadcn** para cubrir 11.B completo: no hay `Table`, `Select` (para Sort/Format), `Checkbox` (para "solo visibles en mapa"), `ScrollArea`. Si se quiere ese nivel de fidelidad, hay que instalar esos componentes shadcn adicionales — no están hoy en `components/ui/`.

### Approaches

1. **Rediseño de skin únicamente (alcance acotado)** — migrar `page.tsx` + `KPICard` + `AlertBanner` + `EventsTable` (en su uso desde Dashboard) + `SeismicMapWithCities` a tokens de severidad/tipografía/shadcn, SIN tocar funcionalidad: mismo layout de 2 columnas (mapa + tabla top-10), sin placas tectónicas, sin sincronización mapa↔lista, sin toggle antigüedad/profundidad.
   - Pros: bajo riesgo, cierra la brecha visual evidente (Dashboard hoy visualmente inconsistente con sidebar/layout), no toca lógica de datos, unblockea 2/3 páginas restantes rápido.
   - Cons: no cumple la Sección 11 pedida explícitamente por el usuario en sesión previa; el usuario puede rechazarlo por "no es lo que pedí".
   - Effort: Low.

2. **Rediseño de skin + features clave de Sección 11 (alcance medio)** — approach 1 + agregar capa de límites de placas tectónicas (GeoJSON `fraxen/tectonicplates` real, reemplazando el overlay mal apuntado) + contador "N of M events in map area" + sincronización básica click-en-fila-centra-mapa (unidireccional, tabla→mapa). Deja afuera: toggle antigüedad/profundidad, checkbox "solo visibles en mapa", selectores Sort/Format, hover bidireccional.
   - Pros: entrega el elemento más visualmente distintivo pedido (placas tectónicas) y un signo de sincronización real, alineado con el pedido explícito de sesión previa, sin la complejidad de un store global de viewport.
   - Cons: requiere instalar/cargar GeoJSON de `fraxen/tectonicplates` (~decenas de KB, pero es un layer nuevo con manejo de carga async y estilos de línea roja); introduce necesidad de estado compartido mapa↔tabla (aunque sea local a `page.tsx` con `useState<selectedId>`, no todavía Zustand).
   - Effort: Medium.

3. **Rediseño completo fiel a Sección 11 (alcance alto)** — approach 2 + toggle color por antigüedad/profundidad + checkbox "solo visibles en mapa" atado a `moveend`/`zoomend` + selectores Sort/Format + sincronización bidireccional completa (hover también, no solo click) + store Zustand para `events`/`viewportBounds`/`selectedId` como sugiere el doc.
   - Pros: fidelidad total a la visión de Sección 11 y a `earthquake.usgs.gov/earthquakes/map`.
   - Cons: alcance grande para "1 de 3 páginas, con revisión intermedia" — probablemente sea el approach correcto pero repartido en más de un change, o con tasks.md muy largo; introduce Zustand como dependencia nueva (hoy no está en el proyecto — no until verified, ver Risks) solo para esta página cuando `useState` local podría alcanzar a esta escala; mezcla decisión de estado global con rediseño visual (dos preocupaciones distintas).
   - Effort: High.

### Recommendation

Approach 2 (rediseño de skin + placas tectónicas + contador + sincronización unidireccional básica). Es el punto donde el "Dashboard profesional según la documentación" dejar de ser una frase vaga y se vuelve verificable (el usuario va a VER las placas tectónicas rojas y el contador, que es lo que mostró en su captura de referencia), sin comprometerse a la reingeniería de estado global (Zustand, hover bidireccional, checkbox de viewport) que el propio doc reconoce como parte de una "vista USGS-like" completa y que puede quedar para una iteración posterior explícita si el usuario la pide después de ver el resultado de esta. Mantiene el principio ya acordado de "una página por vez con revisión intermedia": mejor entregar un Dashboard notoriamente mejorado y verificable ahora que atarse a un scope que arriesga no cerrar en una sesión.

Antes de proponer, hay 2 decisiones que **sdd-propose debe plantear explícitamente al usuario**, no asumir:
1. ¿Reemplazar `SeismicMapWithCities` por una versión extendida de `AdvancedSeismicMap` (reusando su patrón de control de capas ya construido), o extender `SeismicMapWithCities` in-place? Recomendación técnica: extender `AdvancedSeismicMap` con soporte de eventos+ciudades (ya tiene el patrón de layers/overlays correcto) y que el Dashboard lo adopte, dejando `SeismicMapWithCities` como deprecated — evita mantener dos implementaciones de Leaflet divergentes. Pero es una decisión de propietario de código que debe confirmarse.
2. ¿El cambio a `KPICard`/`AlertBanner`/`EventsTable` (compartidos con `/explore` y `/analytics`) se hace ahora aunque esas páginas no se rediseñen todavía? Si se migran los tokens ahora, `/explore` y `/analytics` heredan visualmente el cambio de inmediato (posiblemente para mejor, ya que hoy tienen `bg-seismic-600` roto) pero eso podría interpretarse como "tocar" esas páginas antes de su turno. Alternativa: crear variantes/props opcionales para no romper el resto, o aceptar que estos 3 componentes son transversales y su alineación teams ya beneficia a las 3 páginas.

### Risks

- **`bg-seismic-600` en `explore/page.tsx` ya está roto hoy** (clase de un sistema de colores Tailwind previo que no existe en la config actual) — no es un riesgo introducido por este change, es preexistente, pero si se toca `EventsTable`/`KPICard` compartidos, vale la pena señalarlo al usuario como hallazgo colateral (no arreglarlo silenciosamente sin avisar, ya que Explorador es el próximo change y quizás prefiera arreglarlo ahí).
- **`GEOLOGICAL_OVERLAYS.plateBoundaries` es un overlay tile WMS mal etiquetado**, no el GeoJSON PB2002 real. Agregar placas tectónicas correctas requiere `L.geoJSON()` con fetch del archivo GeoJSON de `fraxen/tectonicplates` (vía CDN tipo jsDelivr/unpkg apuntando al repo, o vendorizado en `public/`), no reusar la entrada existente tal cual — es trabajo nuevo, no un simple "activar el overlay que ya está".
- **No hay Zustand ni store global instalado en el proyecto** (no verificado con búsqueda de `package.json`, asumir que no existe salvo que sdd-design confirme lo contrario) — si en algún momento se decide ir a sincronización bidireccional completa (Approach 3), es una dependencia nueva a evaluar, no asumir que ya está disponible.
- **`EventsTable`, `KPICard`, `AlertBanner` son compartidos entre 3 páginas** (`/`, `/explore`, `/analytics`) — cualquier cambio de skin en este change tiene blast radius sobre páginas que técnicamente "no son su turno todavía" según el orden acordado Dashboard→Explorador→Análisis. Hay que decidir explícitamente si eso es aceptable (mejora incidental) o si se necesitan variantes por página.
- **`SeismicMapWithCities` vs `AdvancedSeismicMap`: duplicación de lógica Leaflet** — ya existen dos implementaciones independientes con manejo de ciclo de vida de mapa casi idéntico (init, cleanup, `_leaflet_id`). Si este change extiende una sin consolidar con la otra, la duplicación crece. Vale la pena que `sdd-design` decida si consolidar es parte de este change o deuda técnica documentada para después.
- **Tamaño/performance del GeoJSON de placas tectónicas**: el dataset PB2002 completo (boundaries) es liviano (decenas de KB) pero conviene confirmarlo en `sdd-design` antes de asumir que no afecta el tiempo de carga inicial del Dashboard.

### Ready for Proposal

Sí. Hay evidencia concreta y accionable para `/sdd-propose`. Las 2 decisiones marcadas arriba (mapa base a extender, y si tocar componentes compartidos ahora) deberían plantearse al usuario como preguntas explícitas dentro de la propuesta o antes de escribirla, no resolverse unilateralmente — son decisiones de producto/arquitectura, no de implementación.
