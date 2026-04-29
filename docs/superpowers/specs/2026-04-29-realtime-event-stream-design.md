# Realtime Event Stream — Design Spec

**Fecha**: 2026-04-29
**Status**: Approved (pending user review)
**Cambio**: `realtime-event-stream`
**Autor**: Diseño colaborativo

---

## 1. Contexto y motivación

El sistema actual (`seismic-monitor`) integra USGS, EMSC e INPRES mediante polling HTTP, expuesto a través de endpoints REST consumidos por un dashboard Next.js que hace `refresh` cada 30-60 segundos. Esto NO es tiempo real: hay una latencia inherente de hasta 60 segundos entre que un evento ocurre y el operador lo ve, y cada cliente conectado dispara fetches duplicados a las APIs externas.

Este cambio convierte el sistema en un **stream push real**: los eventos llegan al backend por WebSocket (EMSC) y polling (USGS/INPRES), se deduplican y enriquecen, y se distribuyen a los clientes browser por **Server-Sent Events (SSE)** con replay garantizado. El objetivo es bajar la latencia evento→operador a P95 <5s y eliminar la pérdida de eventos durante reconexiones de cliente.

---

## 2. Decisiones arquitectónicas (resumen)

| Decisión | Elegido | Justificación |
|---|---|---|
| Broker interno | Redis Pub/Sub + Sorted Set | Mismo Redis sirve para distribución, replay y estado. Una pieza de infra. |
| Estrategia de updates | "Primero gana, después actualiza" | El operador ve EMSC al instante y la confirmación cruzada de USGS llegando después. |
| Identidad de evento | Hash determinístico `sha1(time_round + lat_round + lon_round + mag_bucket)` | Sin estado compartido, dos ingestors paralelos generan el mismo ID. |
| Reconexión cliente | SSE `Last-Event-ID` + snapshot inicial | Estándar del protocolo SSE. Replay automático del browser. |
| Resiliencia EMSC | Reconexión exponencial + heartbeat + degraded mode visible | El operador NUNCA opera con falsa confianza. |
| Filtrado por región | Multi-región con presets nombrados | Operador elige checkboxes, backend valida. Extensible. |
| Topología | Procesos separados (ingestor, API) | Restart de API sin perder conexión EMSC. Permite escalar API horizontalmente. |
| Error tracking | GlitchTip self-hosted desde el día 1 | Captura stack traces y agrupación. Complemento de Prometheus. |
| Deploy target | AWS EC2 t3.medium en us-east-1 | Costo-eficiente para empezar. Migración a sa-east-1 viable si los usuarios son LATAM. |

---

## 3. Arquitectura de alto nivel

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         AWS EC2 (Docker Compose)                        │
│                                                                         │
│  ┌──────────────────┐    ┌──────────────┐    ┌────────────────────┐  │
│  │  EMSC WebSocket  │    │  USGS API    │    │  INPRES Adapter    │  │
│  │  (push, global)  │    │  (poll, 30s) │    │  (poll, 5min)      │  │
│  └────────┬─────────┘    └──────┬───────┘    └─────────┬──────────┘  │
│           │ wss://              │ HTTPS               │ HTTP           │
│           ▼                     ▼                     ▼                │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │              seismic-ingestor (proceso separado)               │  │
│  │  EMSCListener → USGSPoller → INPRESPoller                      │  │
│  │              ↓                                                  │  │
│  │   AsyncioQueueBus (interno) → Dispatcher (canonical_id, dedupe)│  │
│  └────────────────────────────────────────────────────────────────┘  │
│                               │ publish                                │
│                               ▼                                        │
│                    ┌──────────────────────┐                           │
│                    │       Redis          │                           │
│                    │  Pub/Sub: live       │                           │
│                    │  ZSet: replay 24h    │                           │
│                    │  Keys: state TTL 1h  │                           │
│                    └──────────┬───────────┘                           │
│                               │ subscribe                              │
│                               ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │  seismic-api (FastAPI)                                          │ │
│  │  GET /stream/events?regions=...  → SSE                          │ │
│  │  GET /events, /report, /alerts   → REST existente (compat)      │ │
│  │  GET /events/replay?since=...    → archivo JSONL >24h           │ │
│  │  GET /health                     → estado del stream            │ │
│  └────────────────────────────┬────────────────────────────────────┘ │
│                               │ SSE                                    │
│                               ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │           Next.js dashboard (browser EventSource)               │ │
│  │  - Subscribe a presets seleccionados                            │ │
│  │  - Reconcilia NEW/UPDATE por canonical_id                       │ │
│  │  - Last-Event-ID handling automático                            │ │
│  └─────────────────────────────────────────────────────────────────┘ │
│                                                                       │
│  + Sidecars: nginx (TLS, routing, rate limit)                        │
│            + glitchtip + glitchtip-postgres (error tracking)         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Servicios en docker-compose

| Servicio | Estado | Notas |
|---|---|---|
| `seismic-ingestor` | NUEVO | 24/7, mantiene WebSocket EMSC + polling |
| `seismic-api` | EXISTENTE (modificado) | FastAPI con endpoint SSE agregado |
| `redis` | NUEVO | Broker, replay, state |
| `inpres-adapter` | EXISTENTE | Sin cambios |
| `dashboard` | NUEVO en compose | Next.js productizado |
| `nginx` | NUEVO | TLS, reverse proxy, rate limit |
| `glitchtip` | NUEVO | Error tracking |
| `glitchtip-postgres` | NUEVO | DB de GlitchTip |
| `glitchtip-worker` | NUEVO | Celery worker de GlitchTip |

---

## 4. Componentes y responsabilidades

### 4.1 — `EventBus` (interfaz abstracta)

**Archivo**: `src/services/event_bus.py`

**Responsabilidad**: abstraer el transporte entre productores y consumidores. Es la pieza clave para migrar Enfoque 1 (monolítico) → Enfoque 3 (microservicios) sin reescribir.

```python
class EventBus(Protocol):
    async def publish(self, channel: str, event: dict) -> None: ...
    async def subscribe(self, channel: str) -> AsyncIterator[dict]: ...
    async def close(self) -> None: ...
```

**Implementaciones**:
- `AsyncioQueueBus` — interno del ingestor, in-process
- `RedisPubSubBus` — entre dispatcher e instancias de la API

**Lo que NO hace**: persistir, deduplicar, enriquecer. Solo transporte.

### 4.2 — Listeners (uno por fuente)

**Archivos**: `src/ingestors/emsc_listener.py`, `usgs_poller.py`, `inpres_poller.py`

**Responsabilidad común**: cada uno consume su fuente, normaliza al modelo `SeismicEvent`, publica al `EventBus` interno.

**Particularidades**:
- **EMSCListener**: WebSocket persistente con reconexión exponencial (1s→60s, max 60s), heartbeat de 5min. Si está caído >2min, dispara flag que `USGSPoller` lee para acelerar polling.
- **USGSPoller**: HTTP GET cada 30s. Cuando EMSC degraded, intervalo baja a 15s. Refactor a clase `class USGSPoller` con método `run()`.
- **INPRESPoller**: HTTP GET cada 5min al `inpres-adapter` existente. Sin cambios al adapter.

**Lo que NO hacen**: deduplicar, calcular canonical_id, decidir NEW vs UPDATE.

### 4.3 — `Dispatcher`

**Archivo**: `src/ingestors/dispatcher.py`

**Responsabilidad**: consumir del EventBus interno, calcular `canonical_id`, decidir NEW vs UPDATE, mantener estado en Redis, publicar al canal Redis.

**Algoritmo**:
```python
async for raw_event in internal_bus.subscribe("ingest"):
    canonical_id = sha1(
        f"{round(epoch_seconds, -1)}_{round(lat, 1)}_{round(lon, 1)}_{int(mag)}"
    ).hexdigest()[:16]

    # Lock distribuido por canonical_id (protección race conditions)
    lock_key = f"lock:{canonical_id}"
    acquired = await redis.set(lock_key, "1", nx=True, ex=2)
    if not acquired:
        await asyncio.sleep(0.1)
        continue  # otro proceso lo está procesando

    try:
        state_key = f"events:state:{canonical_id}"
        existing = await redis.get(state_key)

        if existing is None:
            merged = SeismicEvent(canonical_id=canonical_id, ...raw_event)
            event_type = "new"
        else:
            parsed_existing = SeismicEvent.parse(existing)
            merged = merge_service._fuse_two_events(parsed_existing, raw_event)
            if merged == parsed_existing:
                continue  # no cambió nada relevante, no publicar
            event_type = "update"

        payload = {"type": event_type, "event": merged.model_dump()}
        # state como key individual (no hash) para soportar TTL por entrada
        state_key = f"events:state:{canonical_id}"
        await redis.set(state_key, merged.json(), ex=3600)
        await redis.zadd("events:replay", {json.dumps(payload): epoch_ms_now})
        await redis.zremrangebyscore("events:replay", 0, epoch_ms_now - 86400_000)
        await redis.publish("seismic.events", json.dumps(payload))

        # Persistencia paralela a JSONL (para replay >24h)
        await archive_writer.append(payload)
    finally:
        await redis.delete(lock_key)
```

**Reusa**: `merge_service._fuse_two_events()` existente.

### 4.4 — `SSE handler` (lado API)

**Archivo**: `src/api/sse_router.py`

**Responsabilidad**: exponer `GET /stream/events?regions=preset1,preset2`, manejar conexiones EventSource con snapshot inicial, replay con Last-Event-ID, stream live.

**Flujo**:
1. Validar `regions` (presets válidos), responder 400 si todas inválidas.
2. Si NO hay `Last-Event-ID`: snapshot de eventos de la última hora filtrados por bbox.
3. Si HAY `Last-Event-ID`: replay desde ese ID hacia adelante.
4. Suscribirse a Redis pub/sub `seismic.events`, filtrar por bbox del cliente, reenviar con `event_id` incremental.
5. Heartbeat cada 30s (`":\n\n"`) para mantener conexión.
6. Cleanup en `finally`: decrementar contador de clientes, cerrar suscripción Redis.

**Formato SSE**:
```
id: 1730000000123-1
event: seismic
data: {"type":"new","event":{...}}

```

### 4.5 — `Region presets`

**Archivo**: `src/config/regions.py`

**Responsabilidad**: definir presets nombrados con bboxes. Compartido entre ingestor (filtra eventos globales de EMSC) y API (filtra por suscripción de cliente).

```python
REGION_PRESETS = {
    "andes_argentina_chile": {
        "name": "Andes Argentina-Chile",
        "bbox": {"minlat": -40, "maxlat": -20, "minlon": -75, "maxlon": -60}
    },
    "pacific_ring": {...},
    "japan": {...},
    "global": {"bbox": None}  # caso especial: sin filtro
}
```

**Validación en startup**: verifica que `minlat < maxlat`, coords en rango válido. Fail fast si hay preset roto.

### 4.6 — `Dashboard SSE client`

**Archivos**: `dashboard/lib/sse-client.ts` (NUEVO) + modificación de `dashboard/app/live/page.tsx`

**Responsabilidad**: encapsular `EventSource` del browser, mantener `Map<canonical_id, SeismicEvent>` local, emitir cambios a componentes React.

```typescript
class SeismicStream {
  private eventSource: EventSource;
  private events: Map<string, SeismicEvent>;
  private listeners: Set<(events: SeismicEvent[]) => void>;

  connect(regions: string[]) { ... }
  onUpdate(callback): () => void { ... }
  disconnect() { ... }
}
```

**Live page**:
- Checkboxes con presets disponibles (fetch de `/regions` endpoint).
- `useEffect` que crea/destruye `SeismicStream` según selección.
- `{type:"new"}` → agregar al state con animación de entrada.
- `{type:"update"}` → actualizar entrada existente con highlight visual breve (1s glow).
- Fallback a polling cada 15s si SSE falla 3 reconexiones consecutivas (con badge "Modo polling").

### 4.7 — Estructura de archivos resultante

```
src/
├── services/
│   ├── event_bus.py              # NUEVO: interfaz + 2 implementaciones
│   ├── usgs_service.py           # existente, sin cambios
│   ├── emsc_service.py           # existente, sin cambios
│   ├── inpres_service.py         # existente, sin cambios
│   ├── merge_service.py          # existente, _fuse_two_events reutilizado
│   ├── kpi_service.py            # existente, sin cambios
│   └── spectrogram_service.py    # existente, sin cambios (cambio futuro)
├── ingestors/                     # NUEVO directorio
│   ├── __init__.py
│   ├── emsc_listener.py
│   ├── usgs_poller.py
│   ├── inpres_poller.py
│   ├── dispatcher.py
│   ├── archive_writer.py         # JSONL persistence
│   └── main.py                   # entry point del ingestor
├── api/                           # NUEVO directorio
│   ├── __init__.py
│   ├── sse_router.py
│   └── replay_router.py          # GET /events/replay para >24h
├── config/
│   ├── settings.py               # existente, +redis_url, +glitchtip_dsn, +environment
│   └── regions.py                # NUEVO
├── observability/                 # NUEVO directorio
│   ├── __init__.py
│   ├── glitchtip.py              # init sentry_sdk
│   └── metrics.py                # métricas Prometheus extendidas
└── main.py                       # incluye sse_router + replay_router

dashboard/
├── lib/
│   └── sse-client.ts             # NUEVO
└── app/
    └── live/page.tsx             # MODIFICADO

tests/
├── unit/
│   ├── test_canonical_id.py
│   ├── test_dispatcher_logic.py
│   ├── test_region_filter.py
│   ├── test_sse_format.py
│   ├── test_event_bus.py
│   └── test_health_logic.py
├── integration/
│   ├── conftest.py
│   ├── test_replay_with_last_event_id.py
│   ├── test_dedupe_across_sources.py
│   ├── test_redis_failure_recovery.py
│   ├── test_emsc_reconnection.py
│   └── test_health_endpoint.py
├── e2e/
│   ├── test_live_dashboard.spec.ts
│   └── test_degraded_badge.spec.ts
└── fixtures/
    ├── emsc_frames/
    ├── usgs_responses/
    └── inpres_responses/
```

---

## 5. Flujo de datos detallado

### 5.1 — Escenario: evento nuevo (EMSC primero, USGS confirma)

**T=0s**: EMSC empuja por WebSocket sismo M4.8 en Mendoza.
- `EMSCListener` parsea frame → publica al `AsyncioQueueBus` interno.
- `Dispatcher` calcula `canonical_id = sha1("1761660000_-32.9_-68.8_4")[:16]`.
- Redis `get("events:state:<canonical_id>")` → `None`.
- Publicación `{type: "new", event: {...fuentes:["EMSC"], mag:4.8...}}` a Redis.
- `events:replay` ZAdd con score = epoch_ms.
- `events:state:<canonical_id>` SET con TTL 1h.
- Archivo JSONL append: `data/events-archive/2026-04-29.jsonl`.

**T=0s + delay SSE**: SSE handler reenvía a clientes cuyo bbox match.
- Cliente A (suscripto a `andes_argentina_chile`): recibe.
- Cliente B (suscripto a `japan`): no recibe.
- Frontend agrega marker al mapa con animación de entrada.

**T=45s**: USGSPoller corre, USGS reporta el mismo sismo.
- `Dispatcher` calcula MISMO `canonical_id`.
- `get("events:state:<canonical_id>")` devuelve el evento previo.
- `merge_service._fuse_two_events` produce evento con `fuentes=["EMSC","USGS"]`, `mag=max(4.8, 4.9)=4.9`, `revisado=True`.
- Diff con previo: cambió `fuentes` y `mag` y `revisado` → publicar `{type: "update", event: {...}}`.
- Frontend busca por `canonical_id` en `Map` → actualiza entrada con highlight visual (glow azul 1s) y badge "EMSC + USGS ✓".

### 5.2 — Escenario: cliente reconecta tras 30s sin internet

**T=0s**: Cliente conectado, último evento recibido `id: 1761660045500-1`.

**T=10s**: corte de internet.

**T=40s**: vuelve internet. Browser EventSource auto-reconecta con `Last-Event-ID: 1761660045500-1`.

- SSE handler parsea `Last-Event-ID` → score `1761660045500`.
- `redis.zrangebyscore("events:replay", 1761660045500, now_ms)`.
- Filtra por bbox del cliente.
- Reenvía cada evento perdido como SSE message con id incremental.
- Continúa stream live normal.

**Resultado**: cliente NO percibe la desconexión salvo por la reconexión instantánea de eventos perdidos.

### 5.3 — Escenario: EMSC WebSocket cae 5 min

**T=0s**: EMSC streaming OK.

**T=120s**: EMSC WS cierra conexión inesperadamente.
- `EMSCListener` captura `websockets.ConnectionClosed`.
- `emsc_health_metric.set(0)`, GlitchTip `capture_message(level="warning")`.
- Reconnect loop con backoff: 1, 2, 4, 8, 16, 32, 60, 60... (max 60s).

**T=120s a T=300s** (mientras está caído):
- `USGSPoller` detecta `(now - emsc_last_message_ts) > 120` → baja intervalo a 15s.
- API `/health` devuelve `status: "degraded"`.
- Dashboard muestra badge rojo "Stream EMSC: DEGRADADO (Xm Ys)".

**T=300s**: EMSC reacepta conexión.
- Listener reconecta exitosamente.
- `emsc_health_metric.set(1)`, backoff resetea a 1.
- USGSPoller vuelve a intervalo 30s.
- Badge desaparece automáticamente.

---

## 6. Manejo de errores

### 6.1 — Política general

| Tipo | Política |
|---|---|
| Error transitorio externo (API down, timeout) | Log + reintento + métrica, no propagar |
| Error en evento individual (parse fail, validación) | Descartar evento, métrica, GlitchTip si recurrente, seguir |
| Error en infra interna (Redis, archivo) | Buffer local + reintentar + degraded mode visible |
| Error de configuración | Fail fast en startup con mensaje claro |
| Error de cliente (input inválido) | 400/503 con mensaje útil, no leak interno |
| Cancelación / disconnect | Cleanup en `finally` SIEMPRE |

### 6.2 — Casos críticos cubiertos

**EMSC frame inválido**: descartar frame, no la conexión. Métrica + log con primeros 200 chars.

**EMSC handshake falla en startup**: ingestor arranca igual. USGS+INPRES siguen. Reconnect background.

**EMSC reconnection storm**: backoff exponencial cap 60s, jitter ±10%.

**USGS 429 rate limit**: respetar `Retry-After` header. Métrica `usgs_rate_limited_total`.

**USGS timeout / 5xx**: log + continuar al siguiente ciclo. Sin reintentos en el mismo tick.

**Redis no responde**:
- Dispatcher buffera localmente (`deque(maxlen=10000)`).
- Métrica `redis_errors_total` + `dispatcher_local_buffer_size`.
- API `/stream/events` responde 503 con `Retry-After: 5` durante el outage.
- Cuando Redis vuelve, `flush_buffer()` ordenado.

**Race condition por canonical_id**: Lock distribuido `SET NX EX 2` en Redis.

**Last-Event-ID malformado/del futuro/muy viejo**: Tratar como conexión nueva. Si >24h, enviar evento `replay_truncated` para transparencia.

**Cliente con regions todas inválidas**: 400 con mensaje listando presets disponibles.

**Cliente con regions parcialmente inválidas**: procesar las válidas, advertir en primer SSE message.

**Cliente abre N conexiones SSE**: rate limit Nginx (5/min/IP) + cap absoluto MAX_SSE_CLIENTS.

**Redis URL mal configurada**: `wait_for_redis(60)` en startup. Si timeout, `RuntimeError` y crash. NO arrancar en silencio sin Redis.

**Preset de región mal definido**: validación en startup con `assert`. Crash con mensaje claro.

### 6.3 — Integración GlitchTip

```python
# src/observability/glitchtip.py
import sentry_sdk
from sentry_sdk.integrations.asyncio import AsyncioIntegration
from sentry_sdk.integrations.fastapi import FastApiIntegration

def init_glitchtip():
    if not settings.glitchtip_dsn:
        return
    sentry_sdk.init(
        dsn=settings.glitchtip_dsn,
        environment=settings.environment,
        release=settings.git_sha,
        traces_sample_rate=0.1,
        integrations=[AsyncioIntegration(), FastApiIntegration()],
        before_send=sanitize_pii,
    )
```

**Captura manual con contexto extra**:
```python
with sentry_sdk.push_scope() as scope:
    scope.set_tag("source", raw.get("fuente"))
    scope.set_context("event", {"raw": raw, "canonical_id": canonical_id})
    try:
        ...
    except RedisError as e:
        sentry_sdk.capture_exception(e)
```

**Frontend**: `@sentry/nextjs` capturando errores del browser con DSN público diferente.

**Filtro de ruido** (`before_send`): descarta frames EMSC malformados conocidos (no actionable), ConnectionResetError de clientes que cierran browser bruscamente.

---

## 7. Mitigaciones de limitaciones

### 7.1 — Si el ingestor se cae

1. **Watchdog asyncio**: tarea cada 60s verifica `now - last_emsc_message_ts < 600`. Si supera umbral, `os._exit(1)` → docker restart.
2. **Healthcheck preciso**: `python -m src.ingestors.healthcheck` chequea proceso vivo + Redis accesible + último mensaje EMSC <10min.
3. **Catchup post-restart**: en startup, fetch USGS últimos 15min para rellenar gap. Eventos previos se procesan como UPDATE (no-op) o NEW si genuinamente nuevos.

**Resultado**: gap detectado en <60s, restart automático, eventos de USGS recuperados. Pérdida real ≈ 0 salvo eventos solo-EMSC durante el gap.

### 7.2 — Si Redis se cae

1. **Persistencia AOF + RDB**:
   ```yaml
   command: >
     redis-server
     --appendonly yes
     --appendfsync everysec
     --save 60 1
     --maxmemory 512mb
     --maxmemory-policy allkeys-lru
   ```
2. **Buffer local en dispatcher**: `deque(maxlen=10000)` cuando Redis no responde. Flush ordenado al recovery.
3. **API en degraded**: 503 con `Retry-After`. Browser EventSource reconecta automáticamente.
4. **Healthcheck Redis aggressive**: `redis-cli ping` cada 5s.

**Resultado**: outage <5s → buffer cubre. Outage >5s → API degraded visible, ingestor acumula, recovery automático con persistencia AOF (pérdida máxima 1s).

### 7.3 — Replay limitado a 1h

1. **Ventana Redis 24h** (no 1h):
   ```python
   await redis.zremrangebyscore("events:replay", 0, now_ms - 86400_000)
   ```
2. **Persistencia paralela JSONL**: dispatcher escribe a `data/events-archive/YYYY-MM-DD.jsonl` con rotación diaria + compresión `.gz` después de 24h.
3. **Endpoint replay**:
   ```python
   GET /events/replay?since=2026-04-28T00:00:00Z
   ```
   Si `since > now-24h`: lee de Redis. Si más viejo: lee del JSONL.
4. **Honestidad con cliente**: si `Last-Event-ID > 24h`, enviar primero `event: replay_truncated\ndata: {oldest_available: ...}`.

**Resultado**: replay efectivo de 24h en Redis + cualquier histórico en archivo. Cuando llegue TimescaleDB en cambio futuro, se reemplaza JSONL por DB sin tocar el contrato del endpoint.

---

## 8. Estrategia de testing

### 8.1 — Unitarios (~40 tests, ejecución <2s)

Lógica pura, sin I/O. Coverage objetivo ≥85% en código nuevo.

**Casos clave**:
- `test_canonical_id`: mismo evento desde 2 fuentes → mismo ID. Sismos genuinamente distintos → IDs distintos. Mag bucket evita colisión en enjambres.
- `test_dispatcher_logic`: primer evento publica `new`. Segunda fuente publica `update` con fuentes mergueadas. Repetición idéntica NO publica.
- `test_region_filter`: bbox match correctamente. Preset `global` matchea todo.
- `test_sse_format`: formato SSE incluye `id`, `event`, `data`. Parse de `Last-Event-ID` rechaza inputs inválidos.
- `test_event_bus`: `AsyncioQueueBus` y `RedisPubSubBus` cumplen el protocolo.

### 8.2 — Integración (~15 tests, ejecución ~30s)

Redis real en docker container con `testcontainers-python`. Mocks de fuentes externas.

**Casos críticos**:
- `test_replay_with_last_event_id`: cliente desconectado recibe los eventos que se perdió.
- `test_dedupe_across_sources`: EMSC primero, USGS después → cliente recibe `new` + `update` con mismo `canonical_id`.
- `test_redis_failure_recovery`: dispatcher buffera durante outage, flushea al recovery.
- `test_emsc_reconnection`: backoff exponencial 1, 2, 4, ... 60s.
- `test_health_endpoint`: refleja correctamente el estado de cada fuente.

### 8.3 — E2E (~3 tests, ejecución ~1min)

Playwright contra docker-compose levantado.

- Dashboard recibe evento por SSE y aparece en el mapa.
- Badge degraded aparece cuando se simula EMSC down.
- Reconexión automática mantiene state.

### 8.4 — Lo que NO testeamos

Decisión consciente:

- Integración real contra EMSC/USGS/INPRES (mock con fixtures grabadas).
- Tests de carga / stress (alcance futuro si crece tráfico).
- Tests del scraper INPRES (estable, costo/beneficio negativo).
- Tests de seguridad automatizados (alcance del cambio `auth-and-rbac`).

### 8.5 — CI

```yaml
test:
  - pytest tests/unit/                # cada push
  - pytest tests/integration/         # cada PR
  - playwright test                   # PRs a main
  - mypy src/
  - ruff check src/
```

Política: no se mergea con tests rojos. Tests E2E flaky → `@pytest.mark.flaky(reruns=2)`.

### 8.6 — Estrategia TDD

- **Lógica pura** (canonical_id, dispatcher, filtros): TDD estricto. Test antes que código.
- **Integración con Redis/WebSocket**: tests en paralelo al código.
- **Wiring/glue**: post-hoc, para regresión.

---

## 9. Plan de despliegue

### 9.1 — Topología EC2

- **Instancia**: `t3.medium` (2 vCPU, 4 GB RAM). Mínimo razonable.
- **Disco**: gp3 SSD 30 GB.
- **Networking**: 1 Elastic IP, Security Group abierto en 22/80/443.
- **Region**: `us-east-1` inicialmente (más barato). Migrar a `sa-east-1` viable si los usuarios finales son LATAM (latencia 30-40ms vs 120-150ms).

### 9.2 — Layout en disco

```
/opt/seismic-monitor/
├── docker-compose.yml
├── .env (chmod 600)
├── nginx/
│   ├── nginx.conf
│   └── certs/                  # Let's Encrypt
├── data/
│   ├── redis/
│   ├── glitchtip-pg/
│   ├── events-archive/
│   └── prometheus/
└── logs/
```

### 9.3 — Nginx config crítica para SSE

```nginx
location /api/stream/ {
    proxy_pass http://seismic-api:8000;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;           # CRÍTICO
    proxy_cache off;
    proxy_read_timeout 24h;
    proxy_send_timeout 24h;
    chunked_transfer_encoding on;
    limit_req zone=sse_zone burst=10 nodelay;
}

limit_req_zone $binary_remote_addr zone=sse_zone:10m rate=5r/m;
limit_req_zone $binary_remote_addr zone=api_zone:10m rate=60r/m;
```

### 9.4 — Secrets

`.env` con `chmod 600`, generados con `openssl rand`. Backup cifrado con `age` o `gpg` en S3 privado.

### 9.5 — Proceso de deploy

Script `scripts/deploy.sh` con restart secuencial (no big-bang) para evitar downtime simultáneo. Browser SSE reconecta con `Last-Event-ID`, cero pérdida de eventos durante deploys.

### 9.6 — Backup diario

Cron a las 03:00:
- Postgres GlitchTip: `pg_dump | gzip | aws s3 cp`
- Redis: `BGSAVE` + sync RDB a S3
- Events archive: `aws s3 sync`

RPO 24h, RTO ~1h.

### 9.7 — Observabilidad

- **CloudWatch**: alarmas CPU/memoria/disco/status check.
- **UptimeRobot**: HTTP check `/health` cada 1min.
- **GlitchTip**: errores con stack trace y agrupación.
- **Logs**: `docker compose logs` + `journald` driver. Loki+Grafana es alcance futuro.

### 9.8 — Hardening

SSH key-only desde IP fija, fail2ban, unattended-upgrades, UFW solo 22/80/443, TLS 1.2+ con HSTS post-validación, Nginx security headers.

### 9.9 — Costo estimado mensual

us-east-1 t3.medium on-demand: ~$35/mes total (EC2+EBS+bandwidth+S3+Route53). Con Reserved Instance 1 año: ~$25/mes.

---

## 10. Riesgos y mitigaciones

| Riesgo | Probabilidad | Impacto | Mitigación |
|---|---|---|---|
| EMSC cambia formato WS | Baja | Alto | Tests con fixtures, métrica `parse_errors`, fallback a USGS-only si umbral excedido |
| Redis OOM | Media (largo plazo) | Catastrófico | `maxmemory 512mb` + LRU eviction, métrica `redis_memory` con alerta 80% |
| Canonical_id collision en enjambres | Baja-media | Medio | Mag bucket, métrica de colisiones, posibilidad de bucket más fino (lat round 0.05) |
| USGS rate limit | Media | Bajo | Respetar `Retry-After`, jitter, User-Agent identificable |
| SSE bloqueado por proxies corporativos | Alta en empresas | Alto | Fallback a polling 15s con badge "Modo polling" visible |
| Disco llenado por JSONL | Media (largo plazo) | Medio | Rotación + compresión + sync S3 + alerta CloudWatch |
| Operador no entiende "degraded" | Alta sin training | Medio | Tooltip + actualización del runbook |
| Falsa confianza por baja densidad de eventos | Media | Alto | Heartbeat visible "Última conexión EMSC: hace Xs" |
| GlitchTip ruido excesivo | Alta sin curado | Medio | `before_send` filtros, sample rate 10% traces, housekeeping semanal |

### 10.1 — Métricas de éxito (post-deploy)

1. Latencia evento EMSC → cliente browser: P50 <2s, P95 <5s.
2. Disponibilidad SSE: ≥99.5% mensual.
3. Eventos perdidos durante deploys: 0 (validable con replay).
4. Tiempo detección de stream degradado: <2 min.
5. Reducción tiempo "evento ocurre → operador lo ve": de ~30-60s a <5s.
6. Cobertura de fuentes: 100% de eventos M≥3 reportados por al menos UNA fuente.
7. Coverage tests código nuevo: ≥75%.
8. Errores GlitchTip P1: <5/semana después del primer mes.

### 10.2 — Lo que duele aunque hagamos todo bien

- **Cold start post-deploy**: gap ~30-60s durante catchup. Inevitable sin hot-swap.
- **Datos contradictorios entre fuentes**: lat/lon difieren ~10km, mag ±0.5. `_fuse_two_events` elige criterios pero no hay verdad absoluta.
- **Piso de "tiempo real"**: EMSC publica minutos después del sismo (las redes sísmicas necesitan tiempo para asociar fases P/S). Lo que hacemos es publicar lo más rápido posible lo que las redes ya detectaron.

---

## 11. Lo que NO incluye este cambio (alcance explícito)

| Problema | Estado post-cambio | Próximo cambio |
|---|---|---|
| Tiempo real | ✅ Resuelto | — |
| Espectrogramas reales | ❌ Synthetics todavía | `real-spectrograms` |
| Persistencia histórica con queries | ⚠️ Parcial (JSONL, sin queries SQL) | `historical-persistence` |
| Auth y RBAC | ❌ Sin cambios | `auth-and-rbac` |
| Detección anomalías ML | ❌ Sin cambios | `anomaly-detection` |
| Notificaciones push (Slack, SMS) | ❌ Sin cambios | `multi-channel-alerts` |
| ShakeMap / intensidades | ❌ Sin cambios | `shakemap-integration` |
| Helicorder visual | ❌ No existe | `helicorder-view` (nuevo, ver sección 12) |
| Mobile app | ❌ Sin cambios | Fuera de scope |

**Próximo cambio recomendado**: `historical-persistence` (TimescaleDB).

### 11.1 — Decisiones diferidas conscientemente (YAGNI)

- WebSocket en lugar de SSE.
- Multi-EC2 / HA (1 EC2 OK para empezar).
- Kafka / Redis Streams (abstracción `EventBus` permite migrar sin reescribir).
- Sharding del replay buffer.
- PWA con offline mode.
- Auth en SSE endpoint (rate limit por IP temporalmente).

---

## 12. Sistemas relacionados y por qué no los usamos directamente

### 12.1 — Swarm (USGS)

**Qué es**: aplicación Java de escritorio del USGS Volcano Hazards Program para visualización de waveforms y helicorders en tiempo real.

**Estado actual**: repositorio `usgs/swarm` **archivado en GitHub** (último push marzo 2021, última versión 3.5.0 de 2018). No mantenido activamente.

**Por qué NO lo usamos como reemplazo**:

| Capacidad | Swarm | Este sistema |
|---|---|---|
| Visualización waveforms | ✅ Excelente | ⚠️ Synthetics hoy, FDSN real en `real-spectrograms` |
| Helicorders 24h | ✅ Feature estrella | ❌ Pendiente: `helicorder-view` |
| Multi-usuario web | ❌ App de escritorio individual | ✅ Dashboard web |
| Alertas automáticas | ❌ No tiene | ✅ Enjambres, M≥5, sentidos |
| Integración custom | ❌ App cerrada | ✅ Código propio |
| Histórico con queries arbitrarias | ❌ Sin DB | ⚠️ TimescaleDB en `historical-persistence` |
| Mantenido | ❌ Archivado 2021 | ✅ Activo |
| Deploy en servidor | ❌ Es desktop app | ✅ Docker en EC2 |
| Notificaciones a Slack/SMS | ❌ Imposible | ⚠️ Roadmap `multi-channel-alerts` |

**Conclusión**: Swarm es un **visor sismológico individual** para sismólogos que abren la app en su laptop. Lo que diseñamos es un **centro de monitoreo operacional con web UI multi-usuario y alertas**. Categorías de software distintas, no compiten.

**Lo que SÍ aprovechamos del concepto**: el patrón de **helicorder** (24h de waveform de UNA estación en una pantalla) es la herramienta visual estándar de sismólogos para detectar enjambres. Anotado como cambio futuro `helicorder-view`.

### 12.2 — IRIS (FDSN data center)

**Qué es**: red global que provee waveforms sísmicos vía protocolo FDSN.

**Cómo lo usamos**: ya está en `spectrogram_service.py` como FDSN priority 1. Será fuente de waveforms reales en cambio futuro `real-spectrograms`.

**Por qué no es alternativa al sistema actual**: IRIS es una **fuente de datos**, no un sistema de monitoreo. Es como comparar "una API de clima" con "un dashboard meteorológico".

### 12.3 — Sistemas similares no considerados

- **SeisComP** (gempa GmbH / GFZ): plataforma de adquisición y procesamiento sismológico industrial. Open source pero pesado, requiere expertise sismológica seria. Reemplazaría todo el stack. Fuera de scope para MVP.
- **EarthWorm** (USGS): similar a SeisComP, más viejo, mismo argumento.
- **ObsPy** (Python toolkit): librería, no sistema. Ya la usamos en `spectrogram_service.py`.

---

## 13. Migración futura de Enfoque 1 → Enfoque 3 (microservicios)

El diseño deliberadamente facilita migrar de monolítico a microservicios cuando el tráfico lo justifique:

**Lo que ya está preparado**:
- `EventBus` como interfaz abstracta → swap `AsyncioQueueBus` → `RedisStreamsBus` o `KafkaBus`.
- Listeners como clases con método `run()` standalone → cada uno puede ser su propio container.
- Lock distribuido en dispatcher por `canonical_id` → soporta múltiples consumers.

**Lo que SÍ habrá que reescribir** (~10% del código, no el 100%):
- Dedupe distribuida con `SET NX` o leader election si hay múltiples dispatchers.
- Partitioning de eventos por `canonical_id` si se va a Kafka multi-partition.
- Coordinación de health/degraded entre listeners que ya no comparten proceso.

---

## 14. Glosario

- **canonical_id**: identificador único de evento sísmico, calculado determinísticamente a partir de tiempo+ubicación+magnitud. Permite deduplicar reportes de la misma fuente o diferentes fuentes.
- **EventBus**: interfaz abstracta de transporte pub/sub. Implementaciones: `AsyncioQueueBus` (in-memory), `RedisPubSubBus` (cross-process).
- **degraded mode**: estado del sistema donde una o más fuentes están caídas pero el resto sigue funcionando. Visible al operador.
- **Helicorder**: visualización tipo "rollo de papel" mostrando 24h de waveform de una estación en una pantalla.
- **Last-Event-ID**: header HTTP estándar de SSE que el browser envía automáticamente en reconexiones. Permite replay de eventos perdidos.
- **MiniSEED**: formato binario estándar para waveforms sísmicos. Usado por FDSN.
- **SSE (Server-Sent Events)**: protocolo HTTP de streaming unidireccional servidor→cliente. Soporte nativo en browsers vía `EventSource`.
- **swarm (enjambre)**: secuencia de sismos pequeños concentrados espacial y temporalmente. Criterio del sistema: ≥3 eventos M≥3 en ≤15min y ≤20km.

---

## 15. Aprobaciones

- [x] Decisiones de diseño confirmadas con usuario (broker, updates, IDs, replay, resiliencia, regiones, topología, error tracking, region AWS).
- [x] Mitigaciones de limitaciones aprobadas.
- [x] Estrategia de testing aprobada.
- [x] Plan de despliegue aprobado.
- [x] Análisis de Swarm como alternativa: documentado como sistema relacionado distinto.
- [ ] Spec review por usuario (pendiente).
- [ ] Plan de implementación generado por `writing-plans` skill (pendiente).
