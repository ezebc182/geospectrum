# Proposal: Unificación de fuente de datos sísmicos entre Dashboard y Explorador

## Intent

El backend tiene dos rutas de fusión de datos sísmicos paralelas y desalineadas: `/report` (y por herencia `/events`, `/alerts`) fusiona solo USGS+INPRES, mientras que `/events/search` fusiona USGS+EMSC+INPRES. Como consecuencia, el Dashboard y "Monitoreo en Vivo" (que consumen `/report`) muestran una foto incompleta de la actividad sísmica —le falta EMSC— respecto del Explorador (que consume `/events/search`). Esto no es una decisión de producto: es deuda técnica confirmada por el usuario. El negocio necesita UNA sola fuente de verdad de fusión de eventos en el backend, para que ningún endpoint mienta sobre qué está pasando sísmicamente.

## Scope

### In Scope
- Extraer la lógica de fusión (`_fetch_parallel` + `merge_all_sources` + `compute_kpis_and_alerts` + armado de `region_monitorizada`) a una función/servicio interno único y reutilizable (candidato: `seismic-monitor/src/services/report_service.py`).
- Migrar `GET /report` para usar esa función con las 3 fuentes (USGS+EMSC+INPRES), dejando de ser una ruta de fusión distinta a `/events/search`.
- Migrar `GET /events` y `GET /alerts` a la misma función interna con las 3 fuentes.
- Resolver la decisión de contrato REST entre `/report` (que devuelve `MonitorReport` completo) y `/events/search` (que devuelve `list[SeismicEvent]`) — ver "Open Design Question" abajo. Esto queda para `/sdd-design`, no se resuelve en esta propuesta.
- Ajuste mínimo de frontend: alinear el default de `sources` en `explore/page.tsx` (actualmente `['usgs', 'emsc']`) con el nuevo comportamiento consistente del backend (`usgs+emsc+inpres`).
- Validación explícita de no-conmutatividad de `merge_all_sources` antes de mergear a producción — con datos reales o fixtures representativos.
- Migración deliberada (no accidental) de los tests existentes en `tests/integration/test_api.py` que fijan comportamiento de "2 fuentes only" en `/report`.

### Out of Scope
- Rediseño visual/UX del Dashboard (layout, mapa con límites de placas tectónicas, etc.) — change posterior y separado.
- Cualquier cambio al algoritmo de matching de `merge_events` (criterio Δt≤120s, distancia≤30km, greedy) — se reusa tal cual.
- Cambios a `_detect_swarms` o a la lógica de umbral de alertas más allá del impacto indirecto de tener EMSC en el pool.
- Nuevas fuentes de datos sísmicos.

## Approach

Consolidar en una función interna única que reciba `sources: list[str]`, filtros opcionales y `window_minutes`, y devuelva `MonitorReport` completo: `_fetch_parallel(sources)` → `merge_all_sources(...)` → `compute_kpis_and_alerts(...)` → `region_monitorizada` desde `settings.bbox`. `/report` pasa a ser un wrapper fino sobre esa función con `sources=["usgs","emsc","inpres"]` y sin filtros adicionales. `/events` y `/alerts` migran al mismo flujo. La decisión de si `/events/search` se mantiene con su contrato actual o si se crea un endpoint nuevo que devuelva `MonitorReport` completo, se resuelve en `/sdd-design`.

## Affected Areas

| Area | Impact | Description |
|------|--------|--------------|
| `seismic-monitor/src/services/report_service.py` (nuevo, propuesto) | New | Función/servicio único de fusión de 3 fuentes + KPIs/alertas + region_monitorizada |
| `seismic-monitor/src/main.py` (líneas 283-332, `/report`) | Modified | Pasa a wrapper fino sobre el nuevo servicio, agrega EMSC |
| `seismic-monitor/src/main.py` (`/events`, línea 335) | Modified | Migra de `merge_events` (2 fuentes) al nuevo servicio (3 fuentes) |
| `seismic-monitor/src/main.py` (`/alerts`, línea 355) | Modified | Migra de `merge_events` (2 fuentes) al nuevo servicio (3 fuentes) |
| `seismic-monitor/src/main.py` (líneas 377-436, `/events/search`) | Decision pending | Contrato REST a definir en diseño: reuso vs. endpoint nuevo |
| `seismic-monitor/src/services/merge_service.py` | Reused, no changes | `merge_events` y `merge_all_sources` se reusan tal cual |
| `seismic-monitor/src/services/kpi_service.py` | Reused, no changes | `compute_kpis_and_alerts` se reusa tal cual |
| `seismic-monitor/dashboard/app/explore/page.tsx` | Modified | Alinear default de `sources` inicial con `usgs+emsc+inpres` |
| `seismic-monitor/dashboard/app/page.tsx`, `seismic-monitor/dashboard/app/live/page.tsx` | Verified, likely no changes | Consumen `/report` — deberían recibir EMSC automáticamente sin cambio de contrato |
| `tests/integration/test_api.py` (líneas 48-66, 94-108, 111-138) | Modified | Migración deliberada de expectativas de shape/fuentes |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| No-conmutatividad de `merge_all_sources`: al agregar EMSC a `/report`/`/events`/`/alerts`, el resultado de fusión puede variar según el orden de fusión, ya que el algoritmo reduce pares greedy "primer match". Puede cambiar qué eventos se consideran duplicados, impactando `_detect_swarms` y alertas `evento_significativo`/`actividad_sentida`. | Alta — riesgo estructural del algoritmo existente | Validación explícita con datos reales o fixtures representativos ANTES de mergear a main. Riesgo CRÍTICO, no detalle menor. |
| Ningún test actual fija el comportamiento de "2 fuentes only" como intencional | Media | Auditar todos los consumidores de `/report`, `/events`, `/alerts` antes de cambiar el contrato de datos |
| Cambio de contrato REST indeciso entre `/report` y `/events/search` puede filtrarse a medio implementar | Media | Bloquear el inicio de `sdd-tasks` hasta que `sdd-design` resuelva explícitamente esta pregunta |
| Consolidar 3 endpoints puede introducir regresión de performance si fetch a 3 fuentes es más lento | Baja | Medir latencia antes/después en `/sdd-verify`; `_fetch_parallel` ya soporta N fuentes en paralelo |

## Open Design Question

*(Para `/sdd-design`, NO resuelta aquí)*

¿`/events/search` se mantiene con su `response_model=list[SeismicEvent]` actual intacto y el Dashboard/Monitoreo en Vivo simplemente consumen el `/report` ya corregido con 3 fuentes? ¿O se introduce un endpoint nuevo (ej. `/report/search`) que devuelva `MonitorReport` completo con filtros adicionales?

## Rollback Plan

Cambio aditivo a nivel de servicio interno; no elimina `merge_events`/`merge_all_sources`/`compute_kpis_and_alerts`. Rollback: revertir el commit/PR de `report_service.py` y cambios en `main.py` de `/report`, `/events`, `/alerts`; revertir cambio de default de `sources` en `explore/page.tsx`. Sin migraciones de datos ni cambios de esquema de BD.

## Dependencies

Ninguna dependencia externa nueva. Depende de que `/sdd-design` resuelva la pregunta de contrato REST abierta antes de `/sdd-tasks`.

## Success Criteria

- [x] `/report`, `/events` y `/alerts` fusionan datos de USGS+EMSC+INPRES — Confirmado en código: los 3 handlers en `src/main.py` llaman a `build_report(sources=CANONICAL_SOURCES)` con `CANONICAL_SOURCES = ["usgs", "emsc", "inpres"]` (`src/services/report_service.py`). Confirmado en tests: `test_report_includes_emsc_only_event`, `test_events_endpoint`, `test_alerts_endpoint` (con evento EMSC-only mockeado) — todos PASSED.
- [x] Existe una única función/servicio de fusión reusado por los 3 endpoints — `report_service.build_report` es la única función invocada por `/report`, `/events` y `/alerts` para fusión+KPIs+alertas (grep confirma un único símbolo, un único módulo). `/events/search` mantiene su propio pipeline por decisión de diseño explícita (no un olvido) — ver `design.md`, "Decisión: Contrato REST".
- [x] Dashboard, Monitoreo en Vivo y Explorador muestran el mismo conjunto de eventos ante la misma ventana temporal y mismas fuentes — Validado a nivel de test automatizado: `test_report_events_alerts_parity` confirma paridad de `id`s entre `/report`/`/events`/`/alerts`. `app/page.tsx` y `app/live/page.tsx` no fueron modificados y consumen `/report` (ahora con 3 fuentes) sin cambio de contrato. `explore/page.tsx` y `FilterPanel.tsx` alinearon su default de `sources` a `['usgs','emsc','inpres']`. **Pendiente de verificación con infraestructura viva** (servidor real + browser): no se levantó Docker/TimescaleDB en esta sesión, ver `tasks.md` Fase 7.1-7.2 para el detalle de qué falta confirmar manualmente.
- [x] Se documentó y validó explícitamente el comportamiento de no-conmutatividad de `merge_all_sources` con al menos un caso real o fixture representativo — Completado en Fase 0 (lotes anteriores): `test_merge_all_sources_order_sensitivity` y `test_merge_all_sources_order_impacts_alerts` en `tests/unit/test_merge_service.py`, con fixture sintético de solapamiento triple ambiguo. Resultado documentado y orden canónico `["usgs","emsc","inpres"]` fijado en `CANONICAL_SOURCES`.
- [x] La pregunta de contrato REST `/report` vs `/events/search` quedó resuelta y documentada en el `design.md` de la fase siguiente — Resuelta en `design.md`, sección "Decision: Contrato REST — mantener `/events/search` intacto, NO crear endpoint nuevo", con rationale completo y alternativas descartadas.
- [x] Los tests de `tests/integration/test_api.py` fueron migrados deliberadamente y siguen pasando en verde — Confirmado en este lote: `./venv/bin/python -m pytest -v` — 66 passed, 1 failed (preexistente, `test_ms_to_iso`, no relacionado), 7 errors (preexistentes, Docker no disponible para `test_redis_pubsub_bus.py`, no relacionados). Todos los tests de `test_api.py`, incluyendo los migrados y los nuevos de paridad, PASSED.
