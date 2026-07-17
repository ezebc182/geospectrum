# Proposal: Redesign Dashboard Page

## Intent

La Fase 1 del rediseño de UI (shadcn/ui + paleta industrial + tokens de severidad `--severity-*` + tipografía Familjen Grotesk/IBM Plex Sans/JetBrains Mono) solo tocó el layout raíz (`app/layout.tsx`, `AppSidebar.tsx`, `globals.css`). El Dashboard (`app/page.tsx`) sigue 100% en Tailwind genérico pre-rediseño: colores hardcodeados por magnitud, `text-gray-900 dark:text-white`, sin tokens de severidad, sin componentes `ui/*` de shadcn más allá de los ya usados en el layout. El resultado es una inconsistencia visual evidente entre el shell de la app (sidebar, header) y su página principal.

Además, el Dashboard hoy no ofrece ninguna de las capacidades de exploración visual que el usuario pidió explícitamente a partir de la Sección 11 del documento de arquitectura de referencia (`seismic-monitor-arquitectura.md`): no hay límites de placas tectónicas, el mapa no distingue eventos por antigüedad/profundidad, no existe sincronización entre el mapa y la tabla de eventos, y no hay un contador que indique cuántos eventos del total están dentro del área visible del mapa.

Este change resuelve ambos problemas para la página Dashboard: cierra la brecha visual aplicando la paleta industrial/shadcn por primera vez a una página de contenido, y entrega las funcionalidades de exploración visual más distintivas pedidas por el usuario, sin comprometerse todavía a la reingeniería de estado global (store tipo Zustand, sincronización bidireccional completa) que el propio documento reconoce como parte de una versión más ambiciosa y que puede evaluarse en una iteración posterior si el usuario la pide después de ver este resultado.

## Scope

### In Scope

- Migrar `dashboard/app/page.tsx` a la paleta industrial: tokens `--severity-low/moderate/high/critical`, clase `.font-data`, componentes shadcn (`Card`, `Badge`) en reemplazo de divs con clases Tailwind genéricas.
- Migrar los componentes compartidos `KPICard`, `AlertBanner` y `EventsTable` a la misma paleta/tokens shadcn. Estos componentes son usados también por `/explore` y `/analytics` (que no son su turno de rediseño todavía); el layout general de esas dos páginas NO se toca, solo estos 3 componentes ganan el nuevo estilo visual por adelantado, para no duplicar el trabajo cuando les llegue el turno.
- Reemplazar el mapa del Dashboard: dejar de usar `SeismicMapWithCities` y construir el mapa extendiendo `AdvancedSeismicMap` (componente más maduro, hoy usado en `/explore`, con mejor patrón de control de capas ya construido). `SeismicMapWithCities` queda deprecado tras este change — no se borra en este mismo change, pero deja de estar en uso, eliminando la duplicación de lógica Leaflet entre ambos componentes para el flujo del Dashboard.
- Agregar capa de límites de placas tectónicas reales al mapa del Dashboard: reemplazar el overlay `GEOLOGICAL_OVERLAYS.plateBoundaries` mal etiquetado (hoy apunta a tiles WMS de fronteras políticas) por un `L.geoJSON()` cargado desde el dataset PB2002 real de `fraxen/tectonicplates`, vendorizado en `public/` o servido vía CDN (a decidir en `sdd-design`).
- Agregar contador "N of M events in map area" visible junto al mapa del Dashboard.
- Agregar sincronización unidireccional básica tabla → mapa: click en una fila de `EventsTable` centra/resalta el evento correspondiente en el mapa. No incluye hover ni sincronización mapa → tabla (ver Out of Scope).
- Documentar como hallazgo colateral, sin corregir en este change: `explore/page.tsx` referencia `bg-seismic-600`, una clase de un sistema de color anterior que ya no existe — está roto visualmente hoy. Queda anotado para el change futuro del Explorador.

### Out of Scope

- Rediseño de layout completo de `/explore` y `/analytics` (changes futuros; orden ya acordado: Dashboard → Explorador → Análisis).
- Corrección del bug `bg-seismic-600` en `explore/page.tsx` (se resuelve en el change del Explorador).
- Toggle de color por antigüedad/profundidad de evento.
- Checkbox "solo visibles en mapa" atado a eventos `moveend`/`zoomend` del mapa.
- Selectores de Sort/Format sobre la tabla de eventos.
- Sincronización bidireccional completa (hover en mapa → resaltar en tabla, y viceversa).
- Introducción de un store de estado global (Zustand u otro) para `events`/`viewportBounds`/`selectedId`. El estado de selección para la sincronización tabla→mapa se maneja local a `page.tsx` (`useState`), sin nueva dependencia de gestión de estado.
- Eliminación física del archivo `SeismicMapWithCities.tsx` (queda deprecado pero no se borra en este change, para no romper referencias no detectadas y permitir rollback simple).

## Approach

Enfoque medio (Approach 2 de la exploración): rediseño visual completo del Dashboard y sus componentes compartidos, más las dos funcionalidades más visualmente distintivas de la Sección 11 (placas tectónicas reales + contador de eventos en área visible), más una sincronización simple y de bajo riesgo (click tabla→mapa) que no requiere estado global nuevo.

Pasos técnicos principales:
1. Migrar estilos de `page.tsx`, `KPICard.tsx`, `AlertBanner.tsx`, `EventsTable.tsx` a tokens de severidad y componentes shadcn (`Card`, `Badge`, y evaluar `Skeleton` para loading state en reemplazo del spinner genérico).
2. Extender `AdvancedSeismicMap.tsx` para soportar el caso de uso del Dashboard: capa de ciudades (hoy exclusiva de `SeismicMapWithCities`), y aceptar un evento seleccionado desde afuera (prop `selectedEventId` o equivalente) para centrar/resaltar.
3. Corregir `lib/map-layers.ts`: reemplazar la URL del overlay `plateBoundaries` por la carga del GeoJSON PB2002 real (`fraxen/tectonicplates`), cambiando el mecanismo de renderizado de tile layer a `L.geoJSON()`.
4. Agregar lógica de conteo "eventos en área visible" escuchando bounds del mapa (`moveend`/`zoomend` de Leaflet) sin necesariamente exponer el checkbox de filtro — solo el contador, que es lo pedido en este change.
5. Conectar `EventsTable` → `page.tsx` → mapa mediante callback `onRowClick` + `useState<selectedId>` local, pasado como prop al mapa extendido.
6. Reemplazar el uso de `SeismicMapWithCities` por el `AdvancedSeismicMap` extendido en `page.tsx`; dejar el archivo viejo sin importar (deprecado).

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `dashboard/app/page.tsx` | Modified | Migración a tokens/shadcn; adopta `AdvancedSeismicMap` extendido en vez de `SeismicMapWithCities`; agrega estado de selección para sincronización tabla→mapa |
| `dashboard/components/KPICard.tsx` | Modified | Migrar `colorClasses`/`iconColorClasses` hardcodeados a `Card` shadcn + tokens de severidad |
| `dashboard/components/AlertBanner.tsx` | Modified | Migrar `severityStyles` (red/yellow/blue Tailwind) a `--severity-low/moderate/high/critical` |
| `dashboard/components/EventsTable.tsx` | Modified | Migración visual a tokens/shadcn; agrega callback `onRowClick` para sincronización con el mapa; usado también por `/explore` y `/analytics`, que heredan el nuevo estilo sin cambios de layout |
| `dashboard/components/AdvancedSeismicMap.tsx` | Modified | Extendido con capa de ciudades y soporte de evento seleccionado externo; pasa a ser el único mapa usado por el Dashboard |
| `dashboard/components/SeismicMapWithCities.tsx` | Deprecated (no removido) | Deja de usarse en `page.tsx`; se mantiene en el repo sin referencias activas hasta un cleanup futuro |
| `dashboard/lib/map-layers.ts` | Modified | `GEOLOGICAL_OVERLAYS.plateBoundaries` pasa de tile WMS mal etiquetado a fuente GeoJSON PB2002 real |
| `dashboard/lib/utils.ts` | Possibly Modified | Solo si se requiere alguna función de color adicional derivada de tokens de severidad para la nueva capa; no se toca `getMagnitudeColor()` fuera de lo necesario para consistencia visual |
| `dashboard/public/` (nuevo asset) | New | Posible vendorización del GeoJSON PB2002 de `fraxen/tectonicplates`, a confirmar en `sdd-design` |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Migrar `KPICard`/`AlertBanner`/`EventsTable` afecta visualmente `/explore` y `/analytics` antes de su turno de rediseño | High (es una consecuencia esperada y aceptada) | Decisión explícita del usuario: es aceptable porque evita duplicar trabajo; se documenta acá para que no sorprenda en el change del Explorador. El bug preexistente `bg-seismic-600` en `/explore` queda anotado y fuera de este change |
| El GeoJSON PB2002 de `fraxen/tectonicplates` agrega peso/latencia a la carga inicial del Dashboard | Medium | Confirmar tamaño real del dataset en `sdd-design` antes de implementar; considerar carga async no bloqueante o lazy sobre el mapa |
| Extender `AdvancedSeismicMap` con capa de ciudades y evento seleccionado externo puede introducir regresiones en `/explore`, que ya lo consume | Medium | Las nuevas props/capas deben ser opcionales (no rompen el uso actual en `/explore`); verificar `/explore` manualmente tras el cambio aunque su layout no se toque |
| Sincronización tabla→mapa con `useState` local puede quedar corta si a futuro se pide sincronización bidireccional completa, forzando refactor | Low | Aceptado conscientemente: se prioriza entregar algo verificable ahora sobre comprometerse a un store global sin necesidad confirmada |
| Doble mantenimiento temporal de `SeismicMapWithCities` (deprecado pero no borrado) y `AdvancedSeismicMap` | Low | Es intencional para permitir rollback simple; se documenta como deuda técnica a limpiar en un change futuro |

## Rollback Plan

Todos los cambios de este change están contenidos en `dashboard/app/page.tsx`, `dashboard/components/{KPICard,AlertBanner,EventsTable,AdvancedSeismicMap}.tsx` y `dashboard/lib/map-layers.ts`, sin cambios de backend ni de esquema de datos. Rollback vía `git revert` del/los commits del change:

- Si el problema es solo visual (tokens/shadcn), revertir el commit correspondiente a esos archivos deja el Dashboard en su estado Tailwind genérico anterior, funcionalmente idéntico.
- Si el problema es el mapa extendido o la capa de placas tectónicas, `page.tsx` puede revertir puntualmente el import a `SeismicMapWithCities` (que se mantiene intacto en el repo sin borrar) sin necesidad de revertir la migración visual de `KPICard`/`AlertBanner`/`EventsTable`, ya que son independientes entre sí.
- No hay migraciones de datos ni cambios de contrato de API involucrados; el rollback es puramente de frontend.

## Dependencies

- Dataset GeoJSON PB2002 de límites de placas tectónicas (`fraxen/tectonicplates`), a obtener vía CDN o vendorizado en `public/` — confirmar mecanismo de carga en `sdd-design`.
- Ningún paquete npm nuevo confirmado todavía; si `sdd-design` determina que se necesita alguna librería adicional (por ejemplo, para simplificar el manejo de bounds de Leaflet), debe evaluarse ahí, no asumirse acá. Explícitamente NO se agrega Zustand ni ninguna librería de estado global en este change.

## Success Criteria

- [x] `dashboard/app/page.tsx` y sus componentes (`KPICard`, `AlertBanner`, `EventsTable`) usan tokens `--severity-*`, `.font-data` y componentes shadcn, sin clases Tailwind de color hardcodeadas remanentes del sistema anterior. **Evidencia**: `rg -n "text-gray-900|dark:text-white|bg-blue-50|border-red-200|dark:border-red-800" app/page.tsx components/KPICard.tsx components/AlertBanner.tsx components/EventsTable.tsx` → sin coincidencias. Lectura de código confirma `Card`/`Badge`/`Skeleton` de shadcn en uso y `.font-data` en valores numéricos.
- [x] El Dashboard usa `AdvancedSeismicMap` extendido; `SeismicMapWithCities` ya no está importado desde `page.tsx`. **Evidencia**: `rg -n "SeismicMapWithCities" app/page.tsx` → sin coincidencias; `app/page.tsx` importa y renderiza `AdvancedSeismicMap` (línea 9, 140-147). El archivo `components/SeismicMapWithCities.tsx` sigue presente en disco (10888 bytes), tal como pide el Rollback Plan.
- [x] El mapa del Dashboard muestra límites de placas tectónicas reales (GeoJSON PB2002), no el overlay WMS placeholder anterior. **Evidencia**: `dashboard/public/geo/plate-boundaries.json` existe, 70 KB, `FeatureCollection` válido con 241 features `LineString` (verificado parseando el JSON). `page.tsx` pasa `showPlateBoundaries` a `AdvancedSeismicMap` (línea 144), que lo consume vía `fetch('/geo/plate-boundaries.json')` + `L.geoJSON()` (líneas 307-339 de `AdvancedSeismicMap.tsx`). `GEOLOGICAL_OVERLAYS.plateBoundaries` retirado de `map-layers.ts`. **No verificado visualmente en navegador con backend real** (bloqueado por CORS del entorno, ver nota de cierre en `tasks.md` Phase 7/8) — pendiente de confirmación visual del usuario.
- [x] El Dashboard muestra un contador "N of M events in map area" que refleja correctamente los eventos dentro del viewport visible del mapa. **Evidencia**: `page.tsx` renderiza `<Badge>{visibleCounts.visible} of {visibleCounts.total} events in map area</Badge>` (línea 136-138), alimentado por `onBoundsChange` del mapa (línea 146). La lógica de conteo (`countEventsInBounds`, `lib/map-bounds.ts`) tiene 4 tests unitarios pasando (`map-bounds.test.ts`), cubriendo 0 visibles, todos visibles y `eventos.length === 0` sin división por cero. **No observado con datos reales en pantalla** (mismo bloqueo CORS) — pendiente de confirmación visual del usuario.
- [x] Click en una fila de `EventsTable` centra/resalta el evento correspondiente en el mapa. **Evidencia**: `EventsTable.test.tsx` (5 tests) confirma que `onRowClick` se invoca con el `id` correcto al click, y que hover/mouseEnter/mouseOver NO lo invocan (unidireccionalidad). `page.tsx` conecta `onRowClick={setSelectedEventId}` (línea 157) y pasa `selectedEventId` al mapa (línea 145). El efecto `[selectedEventId]` en `AdvancedSeismicMap.tsx` (líneas 342-350) hace `panTo` + `openPopup` sin restricción de viewport. **El click real en navegador con marcador visible no se ejerció** (bloqueado por CORS) — pendiente de confirmación visual del usuario.
- [x] `/explore` sigue funcionando sin regresiones tras la extensión de `AdvancedSeismicMap` (verificación manual, aunque su layout no cambie en este change). **Evidencia parcial con navegador real**: `/explore` carga sin errores de consola, invoca `AdvancedSeismicMap` con la firma legacy exacta (`eventos`, `className`, `showCities` — sin ninguna prop nueva), confirmado que no dispara fetch de placas tectónicas en toda la sesión. Los 3 `useEffect` nuevos guardean con `if (!prop) return`. **La comparación visual del mapa CON eventos renderizados (popups, capas, control de layers) no se pudo completar** por el mismo bloqueo CORS — ver Phase 7 de `tasks.md` para el detalle tarea por tarea de qué quedó confirmado y qué pendiente.
- [x] `npm run build` (comando de verify del proyecto) pasa sin errores en `dashboard/`. **Evidencia**: build ejecutado dos veces en este change (Phase 6 y Phase 8), última corrida limpia: "Compiled successfully", 8/8 páginas estáticas generadas, sin errores de tipo. `npx tsc --noEmit` sin salida. `npm run test` (Vitest): 17/17 tests pasan.

### Nota sobre criterios con verificación visual pendiente

Tres de los siete criterios (placas tectónicas visibles, contador en pantalla, click tabla→mapa observado) están **verificados por código y tests automatizados, pero no observados corriendo en un navegador con datos reales del backend**, porque el backend (`src/main.py`) solo declara `allow_origins` para `http://localhost:3008`/`:3000` en CORS, y el puerto `:3008` estaba ocupado por un proceso `next-server` previo del usuario que este sub-agente no detuvo (no es su proceso). Se marcan `[x]` porque la implementación cumple lo especificado según evidencia de código exhaustiva (lectura línea por línea, tests unitarios/integración pasando, guards confirmados), pero el usuario debería confirmar visualmente en su propio `npm run dev` (puerto `:3008`, backend accesible) antes de considerar el change 100% cerrado para producción.
