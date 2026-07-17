# Design: Unificación de fuente de datos sísmicos entre Dashboard y Explorador

## Technical Approach

Extraer la secuencia `_fetch_parallel → merge_all_sources → compute_kpis_and_alerts → region_monitorizada` a una función interna única (`build_report`, en `src/services/report_service.py`) que reciba `sources` y filtros opcionales y devuelva `MonitorReport`. `GET /report` pasa a llamar a esa función con `sources=["usgs","emsc","inpres"]` y sin filtros. `GET /events` y `GET /alerts` migran al mismo flujo, proyectando el `MonitorReport` resultante a `eventos`/`alertas` respectivamente. `GET /events/search` **se mantiene tal cual está hoy** — mismo `response_model=list[SeismicEvent]`, mismos query params, mismo uso directo de `merge_all_sources` — porque ya usa 3 fuentes; el problema nunca estuvo ahí. No se crea ningún endpoint nuevo. Ver "Decisión: Contrato REST" abajo para la justificación completa.

Este approach respeta el scope de la propuesta: `merge_events`, `merge_all_sources` y `compute_kpis_and_alerts` no cambian su firma ni su algoritmo — solo cambia QUIÉN los llama y con qué fuentes.

## Architecture Decisions

### Decision: Contrato REST — mantener `/events/search` intacto, NO crear endpoint nuevo

**Choice**: `/events/search` conserva su `response_model=list[SeismicEvent]` sin ningún cambio de firma, comportamiento ni código. El Dashboard (`app/page.tsx`) y Monitoreo en Vivo (`app/live/page.tsx`) siguen consumiendo `/report`, que pasa a fusionar USGS+EMSC+INPRES. No se introduce `/report/search` ni ningún otro endpoint nuevo.

**Alternativas consideradas**:
1. Crear `/report/search`: un endpoint nuevo que devuelva `MonitorReport` completo (con `kpis`/`alertas`) pero aceptando los filtros de `/events/search`.
2. Deprecar `/events/search` y que el Explorador consuma `/report` filtrando en el cliente.
3. Cambiar el `response_model` de `/events/search` a `MonitorReport`.

**Rationale**:
- **Auditoría del código real muestra que `/events/search` NUNCA tuvo el bug.** Ya usa `merge_all_sources(usgs_events, emsc_events, inpres_events)` (línea 406 de `main.py`) y ya por defecto usa `sources = ["usgs", "emsc", "inpres"]` cuando no se pasa el query param `sources` (línea 397). El desalineamiento que motiva esta propuesta es exclusivamente que `/report`/`/events`/`/alerts` usaban `merge_events` de 2 fuentes. Tocar `/events/search` sería resolver un problema que no existe ahí, violando el principio de cambio mínimo.
- **Auditoría de consumidores frontend confirma que ningún componente necesita `MonitorReport` con filtros.** `app/page.tsx` y `app/live/page.tsx` desestructuran `{ kpis, alertas, eventos, timestamp_utc_generacion, region_monitorizada, data_source_errors }` de la respuesta de `/report` — no llaman a `searchEvents` ni pasan filtros. `app/explore/page.tsx` llama exclusivamente a `seismicAPI.searchEvents(...)` (`lib/api.ts` línea 86, pega a `/events/search`) y solo usa el array de eventos — nunca lee `kpis` ni `alertas`. No hay ningún punto del frontend que necesite "KPIs + filtros" a la vez. Crear `/report/search` sería construir una superficie de API sin consumidor real (YAGNI).
- **Costo de la Alternativa 1 (`/report/search`) sin beneficio medible**: agregar un endpoint nuevo implica más superficie de OpenAPI para mantener, un segundo lugar donde puede desalinearse el comportamiento de filtros, y trabajo de implementación (adaptar `build_report` para aceptar los ~11 filtros de `/events/search` que hoy NO están en su firma: `min_mag`, `max_mag`, `min_depth`, `max_depth`, `min_lat/max_lat`, `min_lon/max_lon`, `felt_only`, `reviewed_only`). Ninguna historia de usuario lo pide.
- **Costo de la Alternativa 2 (deprecar `/events/search`)**: forzaría a mover el filtrado (11 parámetros) al cliente, lo que rompe el patrón actual de filtrado server-side, aumenta el payload transferido (habría que traer TODOS los eventos de la ventana para filtrar en JS) y rompe el OpenAPI schema que ya consume el Explorador — exactamente lo que la propuesta pide evitar explícitamente ("no romper el OpenAPI schema ni el Explorador").
- **Costo de la Alternativa 3 (cambiar `response_model` de `/events/search`)**: rompe el contrato actual que el Explorador ya consume como `SeismicEvent[]` (`eventos.map(...)`, `eventos.length`, exportToCSV que itera el array directo). Sería un breaking change sin ninguna necesidad funcional detrás.
- **Consecuencia arquitectónica**: `/events/search` NO se migra a usar `report_service.build_report` — sigue llamando a `_fetch_parallel` + `merge_all_sources` + el pipeline de filtros directamente, como hoy. Esto es intencional: `build_report` está diseñado para el caso "reporte completo sin filtros de negocio", mientras `/events/search` resuelve "búsqueda filtrada sin KPIs". Forzarlos a compartir función agregaría parámetros opcionales a `build_report` que solo un caller usaría, degradando su cohesión. Si en el futuro se necesitara compartir lógica, extraer el sub-paso `_fetch_parallel` + `merge_all_sources` (que YA está compartido, ver más abajo) es suficiente — no hace falta compartir el ensamblado de KPIs/alertas.

### Decision: Diseño del servicio interno único `report_service.py`

**Choice**:

```python
# src/services/report_service.py
async def build_report(
    sources: list[str],
    window_minutes: Optional[int] = None,
) -> MonitorReport:
    """
    Orquesta fetch + merge + KPIs/alertas para las fuentes dadas.
    Usado por /report, /events y /alerts (proyectando el resultado).
    NO usado por /events/search (que tiene su propio pipeline con filtros).
    """
```

- Recibe `sources: list[str]` (sin default — cada caller es explícito) y `window_minutes: Optional[int]` (si `None`, usa `settings.window_minutes`, igual al patrón ya existente en `/events/search`).
- Internamente llama a `_fetch_parallel(time_window, sources)` (se mueve de `main.py` a `report_service.py` tal cual, sin cambios de firma — es un detalle de implementación del servicio, no de la ruta HTTP).
- Aplica `merge_all_sources(usgs_events, emsc_events, inpres_events)` — reemplaza el `merge_events(usgs_events, inpres_events)` de 2 fuentes que hoy usan `/report`/`/events`/`/alerts`. Nota importante: `merge_all_sources` con listas vacías se comporta igual que `merge_events` de a pares (confirmado leyendo `merge_service.py` líneas 25-31: filtra listas vacías y reduce de a pares), por lo que si algún caller pasa `sources=["usgs","inpres"]` el comportamiento es idéntico al actual — no hay regresión para callers que no pidan EMSC.
- Llama a `compute_kpis_and_alerts(merged_events, effective_window)` sin cambios.
- Arma `region_monitorizada=settings.bbox` igual que hoy en `/report` (línea 322 de `main.py`).
- Devuelve `MonitorReport` completo con `data_source_errors=errors`.
- Las métricas Prometheus (`events_fetched`, `data_source_errors`, `alerts_generated`, `request_duration`) se quedan en `main.py`, no en el servicio — mismo patrón que hoy separa I/O de FastAPI (métricas, logging de endpoint, `request_duration.labels(...).time()`) de la lógica de negocio pura en `services/`. `report_service.py` no importa `prometheus_client`.

**Integración en `main.py`**:

```python
@app.get("/report", response_model=MonitorReport, tags=["monitoring"])
async def report() -> MonitorReport:
    with request_duration.labels(endpoint="/report").time():
        logger.info("Generating seismic report")
        report_obj = await build_report(sources=["usgs", "emsc", "inpres"])

        events_fetched.labels(source="USGS").inc(...)  # desde report_obj o refactor de conteo
        ...
        for alerta in report_obj.alertas:
            alerts_generated.labels(tipo=alerta.tipo).inc()
        requests_total.labels(endpoint="/report", status="200").inc()
        return report_obj

@app.get("/events", response_model=list[SeismicEvent], tags=["monitoring"])
async def get_events() -> list[SeismicEvent]:
    with request_duration.labels(endpoint="/events").time():
        report_obj = await build_report(sources=["usgs", "emsc", "inpres"])
        requests_total.labels(endpoint="/events", status="200").inc()
        return report_obj.eventos

@app.get("/alerts", response_model=list[Alert], tags=["monitoring"])
async def get_alerts() -> list[Alert]:
    with request_duration.labels(endpoint="/alerts").time():
        report_obj = await build_report(sources=["usgs", "emsc", "inpres"])
        requests_total.labels(endpoint="/alerts", status="200").inc()
        return report_obj.alertas
```

Nota de implementación para `sdd-tasks`: los contadores `events_fetched.labels(source=...)` por fuente individual (hoy solo cuentan USGS/INPRES en `/report`) necesitan decidir si `build_report` devuelve también el desglose por fuente (ej. agregar un campo interno no-Pydantic o devolver una tupla `(MonitorReport, dict[str,int])`) o si simplemente se cuenta `len(report_obj.eventos)` fusionado. Esto es un detalle de métricas, no bloquea el diseño funcional, pero debe resolverse explícitamente en tasks para no perder observabilidad de EMSC.

**Alternativas consideradas**:
- Mantener `_fetch_parallel` en `main.py` e importarlo desde `report_service.py`: rechazado — mezcla responsabilidades de HTTP layer con lógica de negocio reusable; además `_fetch_parallel` no depende de nada de FastAPI (no usa `Request`/`Response`), por lo que moverlo es coherente con la carpeta `services/`.
- Servicio como clase (`ReportService`) en vez de función: rechazado — no hay estado a mantener entre llamadas (el caché ya vive en `src/services/cache.py` como módulo separado), y el resto de `services/` en este proyecto (`merge_service.py`, `kpi_service.py`) usa funciones puras, no clases. Seguir el patrón existente.

**Rationale**: Cohesión con el patrón ya establecido en `src/services/` (funciones puras, sin estado, sin dependencias de FastAPI) y separación clara HTTP-layer (métricas, request context) vs. lógica de dominio (fetch+merge+KPIs).

### Decision: `sources` explícito, sin default en `build_report`

**Choice**: `build_report(sources: list[str], ...)` sin valor por defecto — cada caller en `main.py` pasa `["usgs", "emsc", "inpres"]` explícitamente.

**Alternativas consideradas**: Default `sources=["usgs","emsc","inpres"]` en la firma de `build_report`.

**Rationale**: Un default silencioso en el servicio reintroduce el mismo tipo de bug que originó esta propuesta — un caller nuevo que se agregue en el futuro y omita el parámetro "por las dudas" terminaría con 3 fuentes sin decidirlo conscientemente, o peor, alguien lo cambia pensando que solo afecta un endpoint cuando afecta a los tres. Forzar explicitud en cada call-site de `main.py` es más verboso pero hace que el comportamiento de cada endpoint sea auditable con un `grep build_report` sin tener que rastrear defaults.

## Data Flow

    GET /report ──┐
    GET /events ──┼──→ build_report(sources=[usgs,emsc,inpres]) ──→ _fetch_parallel ──→ merge_all_sources ──→ compute_kpis_and_alerts ──→ MonitorReport
    GET /alerts ──┘                                                                                                                            │
                                                                                                          ┌─────────────┬───────────────────────┤
                                                                                                     .eventos       .alertas              (completo)
                                                                                                          │              │                       │
                                                                                                     GET /events   GET /alerts            GET /report
                                                                                                     (proyección)  (proyección)            (passthrough)

    GET /events/search (SIN CAMBIOS) ──→ _fetch_parallel ──→ merge_all_sources ──→ filtros in-memory (min_mag, max_mag, min_depth, ..., felt_only, reviewed_only) ──→ list[SeismicEvent]

    Frontend:
    app/page.tsx ────────→ reportFetcher() ─────→ GET /report ─────→ { kpis, alertas, eventos, region_monitorizada, data_source_errors }
    app/live/page.tsx ───→ reportFetcher() ─────→ GET /report ─────→ { alertas, eventos, region_monitorizada }  (mismo fetcher, ya recibe EMSC sin cambios de código)
    app/explore/page.tsx → seismicAPI.searchEvents() → GET /events/search ─→ SeismicEvent[] (sin cambios de contrato; solo cambia el DEFAULT de `sources` en el estado inicial del cliente)

## File Changes

| File | Action | Description |
|------|--------|--------------|
| `seismic-monitor/src/services/report_service.py` | Create | Función `build_report(sources, window_minutes=None) -> MonitorReport`. Mueve `_fetch_parallel` desde `main.py` (sin cambios de firma) y orquesta `merge_all_sources` + `compute_kpis_and_alerts` + `settings.bbox`. |
| `seismic-monitor/src/main.py` (líneas 223-280, `_fetch_parallel`) | Delete (moved) | Se elimina de `main.py`; su lógica pasa intacta a `report_service.py`. |
| `seismic-monitor/src/main.py` (líneas 283-332, `/report`) | Modify | Wrapper fino sobre `build_report(sources=["usgs","emsc","inpres"])`. Conserva métricas/logging propios del endpoint. |
| `seismic-monitor/src/main.py` (líneas 335-352, `/events`) | Modify | Usa `build_report(...)` y devuelve `.eventos`. Deja de llamar `merge_events` directo. |
| `seismic-monitor/src/main.py` (líneas 355-374, `/alerts`) | Modify | Usa `build_report(...)` y devuelve `.alertas`. Deja de llamar `merge_events`/`compute_kpis_and_alerts` directo. |
| `seismic-monitor/src/main.py` (líneas 377-436, `/events/search`) | No change | Se mantiene exactamente como está (decisión de diseño arriba). |
| `seismic-monitor/src/services/merge_service.py` | No change | `merge_events`/`merge_all_sources` se reusan tal cual, sin tocar el algoritmo. |
| `seismic-monitor/src/services/kpi_service.py` | No change | `compute_kpis_and_alerts` se reusa tal cual. |
| `seismic-monitor/dashboard/app/explore/page.tsx` (línea 13) | Modify | Default de `sources` en `useState<SeismicFilters>` pasa de `['usgs', 'emsc']` a `['usgs', 'emsc', 'inpres']`. |
| `seismic-monitor/dashboard/app/page.tsx`, `seismic-monitor/dashboard/lib/api.ts` | No change | `reportFetcher`/`getReport()` no cambian de firma; reciben más eventos (EMSC) sin tocar código. |
| `seismic-monitor/dashboard/app/live/page.tsx` | No change | Idem — mismo `reportFetcher`. |
| `seismic-monitor/tests/integration/test_api.py` (líneas 48-66, 94-108 no aplica — pertenecen a `/events/search` que no cambia; realmente 69-84, ver Testing Strategy) | Modify | Migrar expectativas de `/events`, `/alerts`, `/report` a 3 fuentes. Ver Migration/Rollout. |
| `seismic-monitor/tests/unit/test_report_service.py` | Create | Tests unitarios nuevos para `build_report` (fetch mockeado + merge de 3 fuentes + KPIs). |
| `seismic-monitor/tests/unit/test_merge_service.py` | Modify | Agregar tests de no-conmutatividad respecto al ORDEN de `sources` (ver Testing Strategy → validación crítica). |

Nota de precisión sobre la propuesta: la propuesta cita "líneas 48-66, 94-108, 111-138" de `test_api.py` como afectadas, pero al leer el archivo real esas líneas corresponden a `test_report_endpoint_structure` (48-66), `test_search_events_source_filter` (94-108) y `test_search_events_uses_merge_all_sources` (111-138) — las dos últimas son de `/events/search`, que este diseño decide NO tocar. Los tests que sí requieren migración deliberada por el cambio de fuentes son `test_report_endpoint_structure` (48-66), `test_events_endpoint` (69-76) y `test_alerts_endpoint` (78-84). Se corrige el alcance en la sección de Testing Strategy.

## Interfaces / Contracts

```python
# src/services/report_service.py

async def build_report(
    sources: list[str],
    window_minutes: Optional[int] = None,
) -> MonitorReport:
    """
    Orquesta la fusión de eventos sísmicos de las fuentes dadas y calcula
    KPIs/alertas sobre el resultado.

    Args:
        sources: Fuentes a consultar, ej. ["usgs", "emsc", "inpres"].
            Sin default deliberadamente — ver Architecture Decisions.
        window_minutes: Ventana temporal en minutos. Si None, usa
            settings.window_minutes (mismo default que /events/search).

    Returns:
        MonitorReport con kpis, alertas, eventos, region_monitorizada
        (desde settings.bbox) y data_source_errors.
    """


async def _fetch_parallel(
    time_window: int,
    sources: list[str],
) -> tuple[list[SeismicEvent], list[SeismicEvent], list[SeismicEvent], list[str]]:
    """Movida sin cambios desde main.py."""
```

No hay cambios en `MonitorReport`, `SeismicEvent`, `KPIs` ni `Alert` (`src/models/event.py`) — ningún campo nuevo, ningún endpoint nuevo, ningún cambio de `response_model` en ninguna ruta existente.

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | `build_report` con 3 fuentes mockeadas (`fetch_usgs_events`, `fetch_emsc_events`, `fetch_inpres_events`) | `tests/unit/test_report_service.py` nuevo. Verificar que devuelve `MonitorReport` con `eventos` fusionados de las 3 fuentes, `kpis` consistentes con `compute_kpis_and_alerts`, y `region_monitorizada == settings.bbox`. |
| Unit | **CRÍTICO — no-conmutatividad de `merge_all_sources` según orden de `sources`** | Ver bloque dedicado abajo. |
| Integration | `/report`, `/events`, `/alerts` devuelven eventos con `fuentes` incluyendo `"EMSC"` cuando EMSC reporta algo en la ventana | Mockear las 3 fuentes en `test_api.py` con un evento EMSC único (sin match con USGS/INPRES) y verificar que aparece en la respuesta de los 3 endpoints. |
| Integration | `/events/search` sigue devolviendo exactamente el mismo shape (`list[SeismicEvent]`) y comportamiento (tests existentes `test_search_events_*` en verde sin modificar) | No requiere tests nuevos — es la prueba de que "no tocar el endpoint" se cumplió. |
| E2E (manual/Playwright si aplica) | Dashboard y Monitoreo en Vivo muestran eventos EMSC (antes ausentes) tras el fix | Verificar visualmente en `sdd-verify` con datos reales o fixture con evento EMSC-only. |

### Plan concreto de validación de no-conmutatividad de `merge_all_sources`

**Por qué es crítico**: `merge_all_sources` reduce de a pares con `functools.reduce`-like loop (`merge_service.py` líneas 25-31): `result = merge_events(source_lists[0], source_lists[1])`, luego `result = merge_events(result, source_lists[2])`, etc. El algoritmo de matching dentro de `merge_events` es greedy "primer match que cumple Δt≤120s y dist≤30km" (líneas 62-91), NO óptimo global. Esto significa que el resultado de fusionar 3 fuentes puede variar según en qué ORDEN se pasan las listas — un evento que matchea con dos candidatos distintos en dos órdenes distintos puede terminar fusionado con uno u otro, cambiando cuántos eventos finales hay, lo cual afecta directamente `_detect_swarms` (cuenta eventos en cluster) y las alertas `evento_significativo`/`actividad_sentida` (dependen del conteo y de qué IDs sobreviven la fusión).

**Qué datos/fixtures usar**:
1. Fixture sintético controlado en `tests/unit/test_merge_service.py`: 3 eventos, uno por fuente (USGS, EMSC, INPRES), diseñados para que EMSC esté geográfica y temporalmente "entre" USGS e INPRES (ej. USGS a 25km de EMSC, EMSC a 25km de INPRES, pero USGS a 45km de INPRES — de modo que el resultado de "quién matchea con quién primero" cambie según el orden de reducción). Este es el fixture mínimo que demuestra el fenómeno de forma determinística y rápida (sin red).
2. Caso con magnitudes distintas por fuente en el punto de ambigüedad (ej. USGS mag=4.0, EMSC mag=4.3, INPRES mag=4.1) para verificar si la magnitud final reportada cambia según el orden — esto es lo que un operador vería directamente en el Dashboard.
3. Datos reales: capturar una ventana de 60-90 minutos real de las 3 fuentes en un momento con actividad sísmica confirmada en la región (ej. usando los endpoints actuales de staging o los adapters directamente contra las APIs reales, guardado como fixture JSON versionado en `tests/fixtures/merge_order_sample.json`). Esto valida con datos no sintéticos que el fenómeno (o su ausencia) se observa en la práctica.

**Qué comparar exactamente**:
- Ejecutar `merge_all_sources(usgs, emsc, inpres)`, `merge_all_sources(emsc, usgs, inpres)`, `merge_all_sources(inpres, emsc, usgs)` (las 6 permutaciones si el volumen de fixture lo permite, mínimo 3 no triviales) sobre el MISMO input.
- Comparar: (a) `len(resultado)` — ¿cambia la cantidad de eventos fusionados?; (b) el `set` de `id`s presentes en cada resultado; (c) para los eventos con mismo `id`, si `mag`, `fuentes`, `lat/lon` difieren entre permutaciones.
- Correr `compute_kpis_and_alerts` sobre cada resultado permutado y comparar `kpis.total_eventos`, `kpis.magnitud_max`, y la lista de `alertas` generadas (tipo y `eventos_relacionados`).

**Qué resultado es aceptable vs. bloqueante**:
- **Aceptable**: los fixtures diseñados a propósito para forzar ambigüedad SÍ muestran diferencias entre órdenes (es evidencia esperada del algoritmo greedy, no una sorpresa) — en ese caso, la resolución para este change es fijar el orden de invocación como `sources=["usgs", "emsc", "inpres"]` de forma consistente y documentada en todos los call-sites (`build_report`, y de hecho `/events/search` ya construye la tupla en ese mismo orden fijo `usgs_events, emsc_events, inpres_events` en su default), de modo que el comportamiento sea determinístico y reproducible aunque no sea "óptimo". Esto NO bloquea el merge a main — es el comportamiento ya vigente hoy en `/events/search` desde antes de esta propuesta, y aceptarlo es coherente con no tocar el algoritmo (fuera de scope explícito).
- **Bloqueante**: si se detecta que el mismo par de eventos duplicados NO se fusiona en ningún orden razonable (falso negativo de dedup) cuando debería, o si el KPI `magnitud_max`/alertas de `evento_significativo` cambia de "no dispara" a "dispara" (o viceversa) solo por el orden interno de `sources` en `build_report` — eso indicaría que el mismo evento real generaría o no una alerta operativa dependiendo de un detalle de implementación arbitrario, lo cual sí es inaceptable para un sistema de monitoreo. Si esto ocurre, la mitigación es: (a) fijar el orden canónico en la constante compartida (ver abajo) y (b) documentar explícitamente en el docstring de `build_report` y `merge_all_sources` que el orden de `sources` es significativo y debe mantenerse fijo entre releases.
- **Acción de diseño derivada**: para eliminar el riesgo de "alguien cambia el orden sin saber que importa", se introduce una constante módulo-level en `report_service.py`: `CANONICAL_SOURCES = ["usgs", "emsc", "inpres"]`, usada por los 3 endpoints migrados. `/events/search` NO se toca (mantiene su propio default en la firma del endpoint, que además ya coincide en el mismo orden). Esto no es una nueva función compartida — es una constante de datos que documenta la decisión, evitando duplicar el literal `["usgs", "emsc", "inpres"]` tres veces en `main.py`.

Esta validación debe ejecutarse y su resultado documentarse (aceptable/bloqueante, con los números concretos observados) ANTES de que `sdd-apply` se dé por completo — es un gate explícito pedido por la propuesta, no un nice-to-have.

## Migration / Rollout

No requiere migración de datos ni cambios de esquema de BD (coincide con el Rollback Plan de la propuesta).

**Migración deliberada de tests existentes** (`tests/integration/test_api.py`):
- `test_report_endpoint_structure` (líneas 48-66): no depende de cuántas fuentes se usen (solo verifica shape), pero debe actualizarse para mockear las 3 fuentes explícitamente (hoy no mockea nada, pega a red real/vacía) y agregar una aserción de que `data_source_errors` puede incluir errores de EMSC. Riesgo bajo de romper.
- `test_events_endpoint` (líneas 69-76) y `test_alerts_endpoint` (líneas 78-84): igual — no fijan explícitamente "2 fuentes" hoy (no hay mocks ni aserciones sobre `fuentes`), por lo que técnicameynte NO se rompen con el cambio, pero deben extenderse con un caso mockeado que agregue un evento EMSC-only y verifique que aparece en la respuesta — de lo contrario, esta migración quedaría sin cobertura de regresión real (que es precisamente el problema que originó esta propuesta: nadie testeaba que EMSC faltaba).
- `test_cache_serves_second_request` (líneas 141-164): mockea `fetch_usgs_events`/`fetch_inpres_events` pero NO `fetch_emsc_events` — al agregar EMSC a `/events`, este test fallará porque intentará una llamada de red real a EMSC. Debe agregarse `patch("src.main.fetch_emsc_events", ...)` (ajustar el path del patch a `src.services.report_service.fetch_emsc_events` si el import se mueve junto con `_fetch_parallel`).
- `test_search_events_source_filter` y `test_search_events_uses_merge_all_sources` (líneas 94-108, 111-138): **NO requieren cambios** — pertenecen a `/events/search`, que este diseño no toca. Se mantienen como regresión de que el contrato no se rompió.

**Orden de rollout sugerido para `sdd-tasks`**:
1. Crear `report_service.py` con `build_report` + tests unitarios (incluye la validación de no-conmutatividad).
2. Migrar `/report` primero (mayor visibilidad, permite validar en Dashboard real).
3. Migrar `/events` y `/alerts`.
4. Actualizar tests de integración afectados.
5. Ajustar default de `sources` en `explore/page.tsx`.
6. Medir latencia antes/después (riesgo de performance ya identificado en la propuesta) — comparar `request_duration_seconds{endpoint="/report"}` pre/post en un ambiente de staging.

## Open Questions

Ninguna abierta a nivel de diseño. La pregunta de contrato REST planteada por la propuesta queda resuelta: **se mantiene `/events/search` intacto, sin endpoint nuevo**. El único punto que queda explícitamente delegado a `sdd-tasks` (no es una pregunta de diseño, es un detalle de implementación) es cómo se recalculan los contadores Prometheus `events_fetched` por fuente individual dentro de `build_report` sin duplicar lógica de conteo en cada endpoint — ver nota en "Architecture Decisions → Diseño del servicio interno único".
