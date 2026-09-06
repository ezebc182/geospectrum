# Proposal: Paneles profesionales de análisis en /analytics

## Intent

La página `/analytics` (`dashboard/app/(app)/analytics/page.tsx`) usa hoy solo 2 de los ~5 datasets que el backend ya calcula: `MagnitudeTimeChart` y `DepthDistributionChart` sobre `eventos` del endpoint `/report`. RSAM (`src/services/swarm_rsam.py`) y el espectro 1D (`src/services/signal_spectrum.py`) ya existen pero solo se ven en vistas de canal individual, nunca agregados en Analytics. No hay vista histórica/reportable de uptime de estaciones (el watchdog solo guarda el estado actual — ver Riesgos), no existe cálculo de b-value (Gutenberg-Richter), y no hay caracterización de tremor volcánico sobre la serie RSAM. El objetivo es convertir Analytics en un panel profesional real, y sentar la base de datos/paneles que la iniciativa siguiente (`analytics-report-export`) va a exportar a PDF y mandar por email.

## Scope

### In Scope
- RSAM: gráfico de tendencia (Recharts) agregado por canal/estación en Analytics, reutilizando `swarm_rsam.py` como base de cálculo.
- Uptime histórico de estaciones: nueva agregación backend + vista en Analytics (bar/timeline).
- b-value / Gutenberg-Richter: nuevo cálculo backend con guarda explícita de mínimo de eventos — si el catálogo es chico, la UI debe mostrar "datos insuficientes" en vez de un número engañoso.
- Caracterización de tremor volcánico: capa de clasificación nueva sobre la serie RSAM existente (no reemplaza RSAM, se apoya en ella).
- Mapa de hipocentros: vista NUEVA y específica de Analytics, con Leaflet (ya instalado), sin reutilizar el componente de `/live` (`AdvancedSeismicMap.tsx` / `SeismicMapWithCities.tsx`) ni su comportamiento "todo en vivo" — acotado al contexto de Analytics (p. ej. ventana de tiempo seleccionada).
- Todos los paneles nuevos de series/estadística (RSAM trend, b-value plot, uptime) usan Recharts, seteados con el mismo patrón de estilos oscuro/i18n de `MagnitudeTimeChart.tsx` / `DepthDistributionChart.tsx`.

### Out of Scope
- Exportación a PDF / generación de reportes — pertenece a `analytics-report-export`.
- Envío de reporte semanal automático por email — pertenece a `analytics-report-export`. Ya está decidido (misma conversación) que será generado en un schedule (no on-demand) y enviado con el `EmailService` existente (`src/services/email_service.py`, Resend, ya en producción para invitaciones) — no un proveedor nuevo.
- El mecanismo de scheduler/cron (Railway no tiene cron nativo; la alternativa es un job de Railway o un loop asyncio in-process) es una decisión de infraestructura de `analytics-report-export`, NO de este change. Se deja como pregunta abierta para esa fase de diseño posterior, no se resuelve acá.

## Approach

- **RSAM trend**: nuevo endpoint backend que agrega muestras de `RsamAccumulator`/`rsam_series` (`src/services/swarm_rsam.py:36-80`) en una ventana temporal seleccionable, expuesto a un componente Recharts nuevo en `dashboard/components/analytics/`.
- **Uptime histórico**: el watchdog (`src/services/watchdog.py`) hoy solo persiste el ESTADO ACTUAL vía `WatchdogStateStore.get_state`/`set_state` (líneas 220-256, backed por Redis) — no hay serie histórica. Se necesita una agregación backend nueva (probablemente logging de transiciones a Postgres/Timescale, no solo el último estado en Redis) para tener algo reportable.
- **b-value**: nuevo módulo de agregación backend sobre `SeismicEvent.mag` (`src/models/event.py:9-22`), con un guard de N mínimo de eventos antes de calcular — catálogos regionales chicos dan resultados estadísticamente sin sentido. Método exacto (máxima verosimilitud vs. mínimos cuadrados) queda como pregunta abierta de spec/design.
- **Tremor volcánico**: capa de clasificación nueva que consume la serie ya calculada por `rsam_series`/`RsamAccumulator`, sin duplicar el cálculo de amplitud.
- **Mapa de hipocentros**: componente Leaflet nuevo y propio de Analytics (no el de `/live`), alimentado por `lat`/`lon`/`prof_km` que `SeismicEvent` ya expone (`src/models/event.py:15-17`) — sin cambio de schema para los datos, solo visualización nueva.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/services/swarm_rsam.py` | Modified/Extended | Base de cálculo RSAM reutilizada para agregación temporal (no cambia su contrato actual de accumulator por tick) |
| `src/services/watchdog.py` | Modified | `WatchdogStateStore` (hoy solo último estado) necesita extenderse o complementarse con persistencia de historial de transiciones |
| `src/services/` | New | Módulo nuevo de b-value / Gutenberg-Richter con guard de N mínimo |
| `src/services/` | New | Módulo nuevo de clasificación de tremor volcánico sobre RSAM |
| `src/api/` (o router equivalente) | New | Endpoints nuevos: RSAM trend agregado, uptime histórico, b-value, tremor, eventos para el mapa de hipocentros |
| `dashboard/app/(app)/analytics/page.tsx` | Modified | Página extendida con los paneles nuevos |
| `dashboard/components/analytics/` (o similar, nuevo directorio) | New | Componentes Recharts (RSAM trend, uptime, b-value plot) siguiendo el patrón de `MagnitudeTimeChart.tsx` / `DepthDistributionChart.tsx` |
| `dashboard/components/` | New | Componente de mapa de hipocentros con Leaflet, independiente de `AdvancedSeismicMap.tsx` / `SeismicMapWithCities.tsx` |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Validez estadística del b-value con catálogos regionales chicos | High | Guard de N mínimo de eventos explícito; mostrar "datos insuficientes" en vez de un número |
| Costo de query de la agregación de uptime (nueva, no existe hoy) | Medium | Definir ventana de agregación acotada en la fase de design; medir antes de exponerla sin límite |
| Performance del mapa de hipocentros con muchos eventos | Medium | Estrategia de clustering a definir en design (pregunta abierta) |
| Scope creep — este es el change más grande de la serie reciente (4 features + 1 vista nueva en un solo change) | High | Mantener el corte estricto: nada de PDF/email acá; si en `sdd-tasks` se ve inabarcable, evaluar partir en sub-fases dentro del mismo change, no ampliar el scope |

## Rollback Plan

Los endpoints nuevos son aditivos (no tocan `/report` ni contratos existentes) y los componentes nuevos son opt-in dentro de `/analytics`. Si un panel falla en producción: revertir el commit/PR que lo agrega (git revert), o feature-flag por componente si `sdd-tasks` decide entregarlos incrementalmente. El cambio a `watchdog.py` para historial de uptime es el único con estado persistente nuevo — su rollback requiere solo dejar de escribir el historial (el estado actual en Redis no se toca).

## Dependencies

- Este change es PRERREQUISITO de `analytics-report-export`: los paneles construidos acá son la fuente de verdad que esa iniciativa va a renderizar a PDF y mandar por email semanal (schedule, `EmailService`/Resend). `analytics-report-export` NO arranca hasta que este change esté completo.

## Open Questions

- b-value: ¿máxima verosimilitud (Aki/Utsu) o mínimos cuadrados sobre el histograma? Definir en `sdd-spec`/`sdd-design`.
- Uptime histórico: ¿qué ventana de agregación (diaria/semanal) y dónde persiste (Postgres/Timescale existente vs. algo nuevo)? El watchdog actual no tiene ninguna tabla de historial — hay que diseñarla.
- Mapa de hipocentros: estrategia de clustering para zonas densas de eventos (¿marker clustering de Leaflet, o agregación server-side?).
- (Explícitamente diferida a `analytics-report-export`, no a resolver acá): mecanismo de scheduler para el reporte semanal — Railway cron job vs. loop asyncio in-process.

## Success Criteria

- [ ] `/analytics` muestra RSAM trend, uptime histórico, b-value (con guard de datos insuficientes visible cuando aplica), tremor volcánico y mapa de hipocentros, todos con datos reales (no mocks).
- [ ] El mapa de hipocentros es un componente propio de Analytics, verificablemente distinto de `AdvancedSeismicMap.tsx`/`SeismicMapWithCities.tsx` (no import compartido de comportamiento "live").
- [ ] El b-value nunca muestra un número cuando el N de eventos está bajo el mínimo definido; muestra el estado "insuficiente" en su lugar.
- [ ] Ningún endpoint nuevo rompe `/report` ni los paneles existentes (`MagnitudeTimeChart`, `DepthDistributionChart`, `EventsTable`).
- [ ] `sdd-tasks` para `analytics-report-export` puede arrancar citando los paneles/endpoints de este change como fuente de datos, sin necesitar rediseñarlos.
