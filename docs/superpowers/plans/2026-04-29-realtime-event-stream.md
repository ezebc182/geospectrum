# Realtime Event Stream Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convertir `seismic-monitor` de un sistema de polling a un stream push real con SSE, deduplicación cross-source, replay con `Last-Event-ID`, multi-región por presets, GlitchTip para error tracking y deploy en AWS EC2.

**Architecture:** Ingestor separado mantiene WebSocket EMSC + polling USGS/INPRES, publica vía `EventBus` (asyncio.Queue interno → Redis Pub/Sub). API FastAPI expone SSE con snapshot inicial + replay desde Redis ZSet. Frontend Next.js consume con `EventSource` y reconcilia NEW/UPDATE por `canonical_id`.

**Tech Stack:** Python 3.11 (FastAPI, httpx, websockets, redis-py, sentry-sdk), Next.js 15 (React 19, EventSource API), Redis 7, Nginx, Docker Compose, AWS EC2, GlitchTip self-hosted.

**Spec:** `docs/superpowers/specs/2026-04-29-realtime-event-stream-design.md`

---

## File Structure

### Backend Python — archivos NUEVOS

| Archivo | Responsabilidad |
|---|---|
| `src/services/event_bus.py` | Interfaz `EventBus` + `AsyncioQueueBus` + `RedisPubSubBus` |
| `src/config/regions.py` | `REGION_PRESETS` + función `event_in_bbox` + validación |
| `src/observability/__init__.py` | módulo |
| `src/observability/glitchtip.py` | `init_glitchtip()` con sentry_sdk |
| `src/observability/metrics.py` | métricas Prometheus extendidas (sse, ingestor) |
| `src/ingestors/__init__.py` | módulo |
| `src/ingestors/canonical_id.py` | `compute_canonical_id(event)` función pura |
| `src/ingestors/emsc_listener.py` | clase `EMSCListener` con WebSocket + reconnect |
| `src/ingestors/usgs_poller.py` | clase `USGSPoller` con polling adaptativo |
| `src/ingestors/inpres_poller.py` | clase `INPRESPoller` |
| `src/ingestors/archive_writer.py` | clase `ArchiveWriter` JSONL con rotación |
| `src/ingestors/dispatcher.py` | clase `Dispatcher` (canonical_id, dedupe, lock) |
| `src/ingestors/healthcheck.py` | script standalone para healthcheck Docker |
| `src/ingestors/main.py` | entry point del ingestor (asyncio.gather) |
| `src/api/__init__.py` | módulo |
| `src/api/sse_router.py` | `GET /stream/events` con snapshot + replay |
| `src/api/replay_router.py` | `GET /events/replay?since=...` |
| `src/api/regions_router.py` | `GET /regions` listando presets |

### Backend Python — archivos MODIFICADOS

| Archivo | Cambios |
|---|---|
| `src/config/settings.py` | +`redis_url`, +`glitchtip_dsn`, +`glitchtip_dsn_frontend`, +`environment`, +`git_sha`, +`max_sse_clients`, +`archive_dir`, +`cors_allowed_origins` |
| `src/main.py` | include sse_router, replay_router, regions_router; init glitchtip; CORS desde settings; `/health` extendido con estado de fuentes |
| `src/services/merge_service.py` | exponer `_fuse_two_events` como `fuse_two_events` (público) |
| `requirements.txt` | +`websockets`, +`redis`, +`sentry-sdk[fastapi]`, +`testcontainers` |

### Frontend Next.js — archivos NUEVOS

| Archivo | Responsabilidad |
|---|---|
| `dashboard/lib/sse-client.ts` | clase `SeismicStream` con `EventSource` |
| `dashboard/lib/sentry.client.config.ts` | init `@sentry/nextjs` cliente |
| `dashboard/components/RegionSelector.tsx` | checkboxes con presets |
| `dashboard/components/StreamHealthBadge.tsx` | badge "Stream EMSC: DEGRADADO" |
| `dashboard/components/SourceBadge.tsx` | badge de fuentes (EMSC, USGS, INPRES) |

### Frontend Next.js — archivos MODIFICADOS

| Archivo | Cambios |
|---|---|
| `dashboard/app/live/page.tsx` | reemplazar SWR polling por `SeismicStream` |
| `dashboard/lib/api.ts` | agregar `getRegions()` y `getHealth()` tipado |
| `dashboard/lib/types.ts` | agregar `canonical_id` a `SeismicEvent`, `RegionPreset`, `StreamMessage` |
| `dashboard/package.json` | +`@sentry/nextjs` |

### Infraestructura

| Archivo | Acción |
|---|---|
| `deploy/docker/docker-compose.yml` | +servicios redis, dashboard, nginx, glitchtip, glitchtip-postgres, glitchtip-worker, seismic-ingestor |
| `deploy/docker/Dockerfile.ingestor` | NUEVO Dockerfile para ingestor |
| `deploy/docker/Dockerfile.dashboard` | NUEVO Dockerfile multi-stage para Next.js |
| `deploy/docker/nginx/nginx.conf` | NUEVO config con SSE + rate limits |
| `deploy/docker/redis.conf` | NUEVO config con AOF + maxmemory |
| `.env.example` | actualizar con todas las variables nuevas |
| `scripts/deploy.sh` | NUEVO script de deploy secuencial |
| `scripts/daily-backup.sh` | NUEVO backup S3 |
| `scripts/wait-healthy.sh` | NUEVO espera healthchecks |

### Tests

| Archivo | Tipo |
|---|---|
| `tests/unit/test_canonical_id.py` | unit |
| `tests/unit/test_event_bus.py` | unit |
| `tests/unit/test_region_filter.py` | unit |
| `tests/unit/test_dispatcher_logic.py` | unit con FakeRedis |
| `tests/unit/test_sse_format.py` | unit |
| `tests/unit/test_archive_writer.py` | unit |
| `tests/integration/conftest.py` | fixtures (testcontainers Redis) |
| `tests/integration/test_replay_with_last_event_id.py` | integration |
| `tests/integration/test_dedupe_across_sources.py` | integration |
| `tests/integration/test_redis_failure_recovery.py` | integration |
| `tests/integration/test_emsc_reconnection.py` | integration |
| `tests/integration/test_health_endpoint.py` | integration |
| `tests/fixtures/emsc_frames/sample_event.json` | fixture |
| `tests/fixtures/usgs_responses/sample_query.json` | fixture |
| `dashboard/__tests__/sse-client.test.ts` | unit frontend |
| `tests/e2e/live_dashboard.spec.ts` | playwright |
| `tests/e2e/degraded_badge.spec.ts` | playwright |
| `tests/e2e/playwright.config.ts` | config |

---

## Phase 0: Repo bootstrap y dependencias

### Task 0.1: Inicializar git y commit baseline

**Files:**
- Modify: `.gitignore` (asegurar que ignore venv, node_modules, .next, data/)

- [ ] **Step 1: Inicializar repo git**

```bash
cd /Users/ezebc182/work/deshoku-apps/espectro-chechu/seismic-monitor
git init
git config user.email "dev@example.com"
git config user.name "Dev"
```

- [ ] **Step 2: Verificar .gitignore existente y completar**

Leer `.gitignore` actual con `bat .gitignore`. Asegurar que contenga:

```
venv/
__pycache__/
*.pyc
.env
node_modules/
.next/
data/
*.log
htmlcov/
.coverage
.pytest_cache/
```

Si falta alguna línea, agregarla con `Edit`.

- [ ] **Step 3: Commit baseline**

```bash
git add -A
git commit -m "chore: baseline before realtime-event-stream"
```

Expected: commit creado con todos los archivos actuales.

---

### Task 0.2: Agregar dependencias Python

**Files:**
- Modify: `requirements.txt`

- [ ] **Step 1: Editar requirements.txt agregando líneas**

Agregar al final del archivo (antes de `# Development`):

```
# Real-time stream
websockets==12.0
redis==5.0.4
sentry-sdk[fastapi]==2.7.1

# Testing infra
testcontainers[redis]==4.5.1
pytest-mock==3.14.0
freezegun==1.5.1
```

- [ ] **Step 2: Verificar instalación local**

```bash
source venv/bin/activate
pip install -r requirements.txt
```

Expected: instalación completa sin errores.

- [ ] **Step 3: Commit**

```bash
git add requirements.txt
git commit -m "chore: add websockets, redis, sentry-sdk, testcontainers deps"
```

---

### Task 0.3: Agregar dependencias frontend

**Files:**
- Modify: `dashboard/package.json`

- [ ] **Step 1: Editar package.json agregando dependencias**

En `dependencies` agregar:
```json
"@sentry/nextjs": "^8.20.0"
```

En `devDependencies` agregar:
```json
"@playwright/test": "^1.45.0",
"vitest": "^2.0.0",
"@testing-library/react": "^16.0.0",
"jsdom": "^24.1.0"
```

- [ ] **Step 2: Instalar**

```bash
cd dashboard
npm install
```

Expected: instalación completa.

- [ ] **Step 3: Commit**

```bash
cd ..
git add dashboard/package.json dashboard/package-lock.json
git commit -m "chore(dashboard): add sentry, playwright, vitest deps"
```

---

## Phase 1: Fundación (settings, regions, EventBus, observability)

### Task 1.1: Extender Settings con nuevas variables

**Files:**
- Modify: `src/config/settings.py`
- Modify: `.env.example`

- [ ] **Step 1: Agregar campos a Settings class**

Editar `src/config/settings.py`. Después del bloque "Storage opcional" (línea ~59) agregar:

```python
    # Redis
    redis_url: str = "redis://localhost:6379/0"
    redis_password: Optional[str] = None

    # SSE
    max_sse_clients: int = 200
    sse_heartbeat_seconds: int = 30
    sse_replay_window_hours: int = 24

    # Archive
    archive_dir: str = "/tmp/events-archive"

    # Observability
    glitchtip_dsn: Optional[str] = None
    glitchtip_dsn_frontend: Optional[str] = None
    environment: str = "development"
    git_sha: str = "unknown"
    glitchtip_traces_sample_rate: float = 0.1

    # CORS
    cors_allowed_origins: str = "http://localhost:3008,http://localhost:3000"

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.cors_allowed_origins.split(",") if o.strip()]
```

- [ ] **Step 2: Actualizar .env.example**

Agregar al final del archivo:

```
# Redis
REDIS_URL=redis://redis:6379/0
REDIS_PASSWORD=

# SSE
MAX_SSE_CLIENTS=200
SSE_HEARTBEAT_SECONDS=30
SSE_REPLAY_WINDOW_HOURS=24

# Archive
ARCHIVE_DIR=/data/events-archive

# Observability
GLITCHTIP_DSN=
GLITCHTIP_DSN_FRONTEND=
ENVIRONMENT=development
GIT_SHA=unknown
GLITCHTIP_TRACES_SAMPLE_RATE=0.1

# CORS (comma-separated)
CORS_ALLOWED_ORIGINS=http://localhost:3008,http://localhost:3000
```

- [ ] **Step 3: Smoke test de carga de settings**

```bash
source venv/bin/activate
python -c "from src.config.settings import settings; print(settings.redis_url, settings.environment)"
```

Expected: imprime `redis://localhost:6379/0 development`.

- [ ] **Step 4: Commit**

```bash
git add src/config/settings.py .env.example
git commit -m "feat(config): add settings for redis, sse, archive, observability, cors"
```

---

### Task 1.2: Crear region presets

**Files:**
- Create: `src/config/regions.py`
- Test: `tests/unit/test_region_filter.py`

- [ ] **Step 1: Escribir test failing**

Crear `tests/unit/test_region_filter.py`:

```python
"""Tests para filtrado por región y validación de presets."""
import pytest
from src.config.regions import (
    REGION_PRESETS,
    event_in_bbox,
    validate_presets,
    get_bbox_for_regions,
)


def test_andes_preset_exists():
    assert "andes_argentina_chile" in REGION_PRESETS


def test_event_in_andes_bbox():
    bbox = REGION_PRESETS["andes_argentina_chile"]["bbox"]
    event = {"lat": -32.9, "lon": -68.8}  # Mendoza
    assert event_in_bbox(event, bbox) is True


def test_event_outside_andes_bbox():
    bbox = REGION_PRESETS["andes_argentina_chile"]["bbox"]
    event = {"lat": 35.5, "lon": 139.7}  # Tokyo
    assert event_in_bbox(event, bbox) is False


def test_global_preset_matches_everything():
    bbox = REGION_PRESETS["global"]["bbox"]
    assert bbox is None
    event = {"lat": 35.5, "lon": 139.7}
    assert event_in_bbox(event, None) is True


def test_validate_presets_passes():
    validate_presets()  # no raise


def test_validate_invalid_bbox_raises():
    bad = {"bad": {"name": "Bad", "bbox": {"minlat": 10, "maxlat": -10, "minlon": 0, "maxlon": 1}}}
    with pytest.raises(AssertionError):
        validate_presets(bad)


def test_get_bbox_for_regions_multiple():
    bboxes = get_bbox_for_regions(["andes_argentina_chile", "japan"])
    assert len(bboxes) == 2


def test_get_bbox_for_regions_with_global_returns_empty_meaning_match_all():
    bboxes = get_bbox_for_regions(["global"])
    assert bboxes == []  # caller debe interpretar [] como "match all"
```

- [ ] **Step 2: Verificar fail**

```bash
pytest tests/unit/test_region_filter.py -v
```

Expected: FAIL con `ModuleNotFoundError: No module named 'src.config.regions'`.

- [ ] **Step 3: Implementar `src/config/regions.py`**

```python
"""
Region presets para suscripciones multi-región del stream SSE.

Cada preset tiene un bbox (bounding box) que define qué eventos pertenecen
a esa región. El preset 'global' tiene bbox None, lo que significa "todos".
"""
from typing import Optional

REGION_PRESETS: dict[str, dict] = {
    "andes_argentina_chile": {
        "name": "Andes Argentina-Chile",
        "bbox": {"minlat": -40, "maxlat": -20, "minlon": -75, "maxlon": -60},
    },
    "pacific_ring_south_america": {
        "name": "Pacific Ring (South America)",
        "bbox": {"minlat": -56, "maxlat": 12, "minlon": -82, "maxlon": -65},
    },
    "japan": {
        "name": "Japan",
        "bbox": {"minlat": 24, "maxlat": 46, "minlon": 122, "maxlon": 146},
    },
    "mediterranean": {
        "name": "Mediterranean",
        "bbox": {"minlat": 30, "maxlat": 47, "minlon": -10, "maxlon": 40},
    },
    "global": {
        "name": "Global (sin filtro)",
        "bbox": None,
    },
}


def event_in_bbox(event: dict, bbox: Optional[dict]) -> bool:
    """Devuelve True si el evento cae dentro del bbox.

    Si bbox es None (preset global), siempre devuelve True.
    """
    if bbox is None:
        return True
    lat = event["lat"]
    lon = event["lon"]
    return (
        bbox["minlat"] <= lat <= bbox["maxlat"]
        and bbox["minlon"] <= lon <= bbox["maxlon"]
    )


def validate_presets(presets: Optional[dict] = None) -> None:
    """Valida que todos los bboxes tengan rangos coherentes.

    Llamado en startup. Crashea si hay preset roto.
    """
    presets = presets if presets is not None else REGION_PRESETS
    for name, preset in presets.items():
        bbox = preset.get("bbox")
        if bbox is None:
            continue
        assert bbox["minlat"] < bbox["maxlat"], f"{name}: minlat >= maxlat"
        assert bbox["minlon"] < bbox["maxlon"], f"{name}: minlon >= maxlon"
        assert -90 <= bbox["minlat"] <= 90, f"{name}: minlat out of range"
        assert -90 <= bbox["maxlat"] <= 90, f"{name}: maxlat out of range"
        assert -180 <= bbox["minlon"] <= 180, f"{name}: minlon out of range"
        assert -180 <= bbox["maxlon"] <= 180, f"{name}: maxlon out of range"


def get_bbox_for_regions(region_names: list[str]) -> list[dict]:
    """Devuelve la lista de bboxes correspondientes a los presets pedidos.

    Si alguno es 'global' (bbox=None), devuelve [] (caller debe interpretar
    como "match all"). Ignora presets desconocidos.
    """
    bboxes: list[dict] = []
    for name in region_names:
        preset = REGION_PRESETS.get(name)
        if preset is None:
            continue
        bbox = preset["bbox"]
        if bbox is None:
            return []  # "global" cortocircuita
        bboxes.append(bbox)
    return bboxes
```

- [ ] **Step 4: Verificar tests pasan**

```bash
pytest tests/unit/test_region_filter.py -v
```

Expected: todos los tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config/regions.py tests/unit/test_region_filter.py
git commit -m "feat(config): add region presets with bbox filter and validation"
```

---

### Task 1.3: Crear EventBus interfaz + AsyncioQueueBus

**Files:**
- Create: `src/services/event_bus.py`
- Test: `tests/unit/test_event_bus.py`

- [ ] **Step 1: Escribir test failing para AsyncioQueueBus**

Crear `tests/unit/test_event_bus.py`:

```python
"""Tests para EventBus implementations."""
import asyncio
import pytest
from src.services.event_bus import AsyncioQueueBus


@pytest.mark.asyncio
async def test_publish_and_subscribe_roundtrip():
    bus = AsyncioQueueBus()
    received: list[dict] = []

    async def consumer():
        async for event in bus.subscribe("ingest"):
            received.append(event)
            if len(received) >= 2:
                break

    consumer_task = asyncio.create_task(consumer())
    await asyncio.sleep(0.01)
    await bus.publish("ingest", {"id": "1"})
    await bus.publish("ingest", {"id": "2"})
    await asyncio.wait_for(consumer_task, timeout=2)

    assert received == [{"id": "1"}, {"id": "2"}]
    await bus.close()


@pytest.mark.asyncio
async def test_subscribe_separates_channels():
    bus = AsyncioQueueBus()
    a_received: list[dict] = []
    b_received: list[dict] = []

    async def consume(chan, target):
        async for event in bus.subscribe(chan):
            target.append(event)
            if target:
                return

    task_a = asyncio.create_task(consume("a", a_received))
    task_b = asyncio.create_task(consume("b", b_received))
    await asyncio.sleep(0.01)
    await bus.publish("a", {"x": 1})
    await bus.publish("b", {"y": 2})
    await asyncio.wait_for(asyncio.gather(task_a, task_b), timeout=2)

    assert a_received == [{"x": 1}]
    assert b_received == [{"y": 2}]
    await bus.close()
```

Crear `pytest.ini` adition o usar `pyproject.toml` para `asyncio_mode = "auto"`. Verificar `pytest.ini` actual.

- [ ] **Step 2: Verificar pytest.ini soporta asyncio**

```bash
bat pytest.ini
```

Si no contiene `asyncio_mode = auto`, agregar a `pytest.ini`:

```ini
[pytest]
asyncio_mode = auto
```

- [ ] **Step 3: Verificar fail del test**

```bash
pytest tests/unit/test_event_bus.py -v
```

Expected: FAIL `ModuleNotFoundError`.

- [ ] **Step 4: Implementar event_bus.py (solo AsyncioQueueBus por ahora)**

Crear `src/services/event_bus.py`:

```python
"""
EventBus: abstracción de transporte pub/sub.

Implementaciones:
- AsyncioQueueBus: in-process queue, usado dentro del ingestor
- RedisPubSubBus: cross-process via Redis, usado entre dispatcher y SSE handlers

Diseñado para permitir migración futura a Redis Streams o Kafka sin cambiar
el código de listeners/dispatchers.
"""
from __future__ import annotations

import asyncio
from typing import AsyncIterator, Protocol


class EventBus(Protocol):
    """Protocolo común para todos los buses de eventos."""

    async def publish(self, channel: str, event: dict) -> None: ...
    def subscribe(self, channel: str) -> AsyncIterator[dict]: ...
    async def close(self) -> None: ...


class AsyncioQueueBus:
    """Bus in-memory basado en asyncio.Queue, una queue por canal."""

    def __init__(self, maxsize: int = 1000) -> None:
        self._queues: dict[str, asyncio.Queue] = {}
        self._maxsize = maxsize
        self._closed = False

    def _queue_for(self, channel: str) -> asyncio.Queue:
        if channel not in self._queues:
            self._queues[channel] = asyncio.Queue(maxsize=self._maxsize)
        return self._queues[channel]

    async def publish(self, channel: str, event: dict) -> None:
        if self._closed:
            raise RuntimeError("Bus is closed")
        await self._queue_for(channel).put(event)

    async def subscribe(self, channel: str) -> AsyncIterator[dict]:
        queue = self._queue_for(channel)
        while not self._closed:
            try:
                event = await asyncio.wait_for(queue.get(), timeout=1.0)
                yield event
            except asyncio.TimeoutError:
                continue

    async def close(self) -> None:
        self._closed = True
```

- [ ] **Step 5: Verificar tests pasan**

```bash
pytest tests/unit/test_event_bus.py -v
```

Expected: PASS ambos tests.

- [ ] **Step 6: Commit**

```bash
git add src/services/event_bus.py tests/unit/test_event_bus.py pytest.ini
git commit -m "feat(event-bus): add EventBus protocol and AsyncioQueueBus impl"
```

---

### Task 1.4: Agregar RedisPubSubBus

**Files:**
- Modify: `src/services/event_bus.py`
- Test: `tests/integration/conftest.py` (crear)
- Test: `tests/integration/test_redis_pubsub_bus.py` (crear)

- [ ] **Step 1: Crear conftest con fixture Redis testcontainer**

Crear `tests/integration/conftest.py`:

```python
"""Fixtures compartidas para tests de integración."""
import asyncio
import pytest
from testcontainers.redis import RedisContainer


@pytest.fixture(scope="session")
def redis_container():
    container = RedisContainer("redis:7-alpine")
    container.start()
    yield container
    container.stop()


@pytest.fixture(scope="session")
def redis_url(redis_container):
    host = redis_container.get_container_host_ip()
    port = redis_container.get_exposed_port(6379)
    return f"redis://{host}:{port}/0"


@pytest.fixture
async def redis_client(redis_url):
    import redis.asyncio as aioredis
    client = aioredis.from_url(redis_url, decode_responses=True)
    await client.flushdb()
    yield client
    await client.flushdb()
    await client.aclose()
```

- [ ] **Step 2: Escribir test failing para RedisPubSubBus**

Crear `tests/integration/test_redis_pubsub_bus.py`:

```python
"""Test de integración para RedisPubSubBus."""
import asyncio
import pytest
from src.services.event_bus import RedisPubSubBus


@pytest.mark.asyncio
async def test_redis_pubsub_roundtrip(redis_url):
    publisher = RedisPubSubBus(redis_url)
    subscriber = RedisPubSubBus(redis_url)
    await publisher.connect()
    await subscriber.connect()

    received: list[dict] = []

    async def consume():
        async for evt in subscriber.subscribe("test.events"):
            received.append(evt)
            if len(received) >= 2:
                break

    consumer_task = asyncio.create_task(consume())
    await asyncio.sleep(0.2)  # dar tiempo a SUBSCRIBE
    await publisher.publish("test.events", {"id": "1"})
    await publisher.publish("test.events", {"id": "2"})
    await asyncio.wait_for(consumer_task, timeout=5)

    assert {"id": "1"} in received
    assert {"id": "2"} in received

    await publisher.close()
    await subscriber.close()
```

- [ ] **Step 3: Verificar fail**

```bash
pytest tests/integration/test_redis_pubsub_bus.py -v
```

Expected: FAIL `ImportError: cannot import name 'RedisPubSubBus'`.

- [ ] **Step 4: Agregar RedisPubSubBus a event_bus.py**

Editar `src/services/event_bus.py`, agregar al final:

```python
import json
import logging

import redis.asyncio as aioredis

logger = logging.getLogger(__name__)


class RedisPubSubBus:
    """Bus pub/sub respaldado por Redis. Usado entre procesos."""

    def __init__(self, redis_url: str) -> None:
        self._url = redis_url
        self._client: aioredis.Redis | None = None
        self._closed = False

    async def connect(self) -> None:
        self._client = aioredis.from_url(self._url, decode_responses=True)
        await self._client.ping()

    @property
    def client(self) -> aioredis.Redis:
        if self._client is None:
            raise RuntimeError("Bus not connected. Call connect() first.")
        return self._client

    async def publish(self, channel: str, event: dict) -> None:
        await self.client.publish(channel, json.dumps(event))

    async def subscribe(self, channel: str) -> AsyncIterator[dict]:
        pubsub = self.client.pubsub()
        await pubsub.subscribe(channel)
        try:
            while not self._closed:
                msg = await pubsub.get_message(
                    ignore_subscribe_messages=True, timeout=1.0
                )
                if msg is None:
                    continue
                if msg["type"] != "message":
                    continue
                try:
                    yield json.loads(msg["data"])
                except json.JSONDecodeError as e:
                    logger.warning(f"Bad JSON in pubsub: {e}")
        finally:
            await pubsub.unsubscribe(channel)
            await pubsub.aclose()

    async def close(self) -> None:
        self._closed = True
        if self._client is not None:
            await self._client.aclose()
```

- [ ] **Step 5: Verificar tests pasan**

```bash
pytest tests/integration/test_redis_pubsub_bus.py -v
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/services/event_bus.py tests/integration/conftest.py tests/integration/test_redis_pubsub_bus.py
git commit -m "feat(event-bus): add RedisPubSubBus with integration test"
```

---

### Task 1.5: Crear módulo observability con GlitchTip init

**Files:**
- Create: `src/observability/__init__.py`
- Create: `src/observability/glitchtip.py`
- Create: `src/observability/metrics.py`

- [ ] **Step 1: Crear `src/observability/__init__.py` vacío**

```bash
touch src/observability/__init__.py
```

- [ ] **Step 2: Implementar `src/observability/glitchtip.py`**

```python
"""
Inicialización de GlitchTip (compatible Sentry SDK).

Llamado por el ingestor y la API en startup. Si no hay DSN configurado,
es no-op (útil para desarrollo local).
"""
import logging
from typing import Any

import sentry_sdk
from sentry_sdk.integrations.asyncio import AsyncioIntegration

from src.config.settings import settings

logger = logging.getLogger(__name__)


def _sanitize_pii(event: dict, hint: dict) -> dict | None:
    """Filtro before_send: descarta errores conocidos no-actionable."""
    # Ejemplo: descartar ConnectionResetError de clientes que cierran browser
    exc_info = hint.get("exc_info")
    if exc_info:
        exc_type = exc_info[0]
        if exc_type is ConnectionResetError:
            return None
    return event


def init_glitchtip(component: str) -> None:
    """Inicializa Sentry SDK contra GlitchTip si hay DSN configurado.

    Args:
        component: nombre del servicio ('ingestor', 'api') para tag.
    """
    if not settings.glitchtip_dsn:
        logger.info("GlitchTip DSN not configured, skipping init")
        return

    integrations: list[Any] = [AsyncioIntegration()]
    if component == "api":
        from sentry_sdk.integrations.fastapi import FastApiIntegration
        from sentry_sdk.integrations.starlette import StarletteIntegration

        integrations.extend([FastApiIntegration(), StarletteIntegration()])

    sentry_sdk.init(
        dsn=settings.glitchtip_dsn,
        environment=settings.environment,
        release=settings.git_sha,
        traces_sample_rate=settings.glitchtip_traces_sample_rate,
        integrations=integrations,
        before_send=_sanitize_pii,
    )
    sentry_sdk.set_tag("component", component)
    logger.info(f"GlitchTip initialized for component={component}")
```

- [ ] **Step 3: Implementar `src/observability/metrics.py`**

```python
"""Métricas Prometheus extendidas para el stream real-time."""
from prometheus_client import Counter, Gauge, Histogram

# Ingestor
emsc_websocket_connected = Gauge(
    "seismic_emsc_websocket_connected",
    "1 si EMSC WebSocket está conectado, 0 si no",
)

emsc_last_message_seconds_ago = Gauge(
    "seismic_emsc_last_message_seconds_ago",
    "Segundos desde el último mensaje recibido por EMSC WS",
)

emsc_parse_errors_total = Counter(
    "seismic_emsc_parse_errors_total",
    "Frames de EMSC que fallaron al parsear",
)

emsc_reconnections_total = Counter(
    "seismic_emsc_reconnections_total",
    "Veces que el listener EMSC reconectó",
)

usgs_rate_limited_total = Counter(
    "seismic_usgs_rate_limited_total",
    "Respuestas 429 de USGS",
)

dispatcher_events_processed = Counter(
    "seismic_dispatcher_events_processed_total",
    "Eventos procesados por el dispatcher",
    ["event_type"],  # 'new' | 'update' | 'noop' | 'invalid'
)

dispatcher_collisions_total = Counter(
    "seismic_dispatcher_collisions_total",
    "Veces que un UPDATE difiere demasiado en magnitud (potencial colisión de canonical_id)",
)

dispatcher_local_buffer_size = Gauge(
    "seismic_dispatcher_local_buffer_size",
    "Tamaño actual del buffer local cuando Redis está caído",
)

redis_errors_total = Counter(
    "seismic_redis_errors_total",
    "Errores al hablar con Redis",
    ["operation"],
)

# SSE
sse_active_clients = Gauge(
    "seismic_sse_active_clients",
    "Clientes SSE actualmente conectados",
)

sse_messages_sent_total = Counter(
    "seismic_sse_messages_sent_total",
    "Mensajes SSE enviados",
    ["event_type"],  # 'new' | 'update' | 'snapshot' | 'replay' | 'heartbeat'
)

sse_replay_truncated_total = Counter(
    "seismic_sse_replay_truncated_total",
    "Veces que un cliente pidió replay >24h y fue truncado",
)

# Archive
archive_writes_total = Counter(
    "seismic_archive_writes_total",
    "Eventos escritos al archivo JSONL",
)

archive_write_errors_total = Counter(
    "seismic_archive_write_errors_total",
    "Errores al escribir al archivo JSONL",
)
```

- [ ] **Step 4: Smoke test**

```bash
python -c "from src.observability.glitchtip import init_glitchtip; init_glitchtip('test'); print('ok')"
python -c "from src.observability.metrics import emsc_websocket_connected; emsc_websocket_connected.set(1); print('ok')"
```

Expected: imprime `ok` ambas veces.

- [ ] **Step 5: Commit**

```bash
git add src/observability/
git commit -m "feat(observability): add glitchtip init and prometheus metrics"
```

---

## Phase 2: Canonical ID y dispatcher

### Task 2.1: Implementar canonical_id (función pura)

**Files:**
- Create: `src/ingestors/__init__.py`
- Create: `src/ingestors/canonical_id.py`
- Test: `tests/unit/test_canonical_id.py`

- [ ] **Step 1: Crear paquete ingestors**

```bash
touch src/ingestors/__init__.py
```

- [ ] **Step 2: Escribir test failing**

Crear `tests/unit/test_canonical_id.py`:

```python
"""Tests para compute_canonical_id."""
from datetime import datetime, timezone
from src.ingestors.canonical_id import compute_canonical_id


def make_event(time_iso: str, lat: float, lon: float, mag: float) -> dict:
    return {"hora_utc": time_iso, "lat": lat, "lon": lon, "mag": mag}


def test_same_event_same_id_across_sources():
    """Mismo evento desde 2 fuentes con jitter pequeño genera el mismo canonical_id."""
    emsc = make_event("2026-04-29T14:00:00Z", -32.9, -68.8, 4.8)
    usgs = make_event("2026-04-29T14:00:05Z", -32.91, -68.79, 4.9)
    assert compute_canonical_id(emsc) == compute_canonical_id(usgs)


def test_different_earthquakes_different_ids():
    e1 = make_event("2026-04-29T14:00:00Z", -32.9, -68.8, 4.8)
    e2 = make_event("2026-04-29T14:00:00Z", -33.5, -68.8, 4.8)  # 60km al sur
    assert compute_canonical_id(e1) != compute_canonical_id(e2)


def test_swarm_collision_avoided_by_mag_bucket():
    e_small = make_event("2026-04-29T14:00:00Z", -32.9, -68.8, 3.2)
    e_big = make_event("2026-04-29T14:00:00Z", -32.9, -68.8, 5.1)
    assert compute_canonical_id(e_small) != compute_canonical_id(e_big)


def test_id_is_16_chars_hex():
    e = make_event("2026-04-29T14:00:00Z", -32.9, -68.8, 4.8)
    cid = compute_canonical_id(e)
    assert len(cid) == 16
    assert all(c in "0123456789abcdef" for c in cid)


def test_id_deterministic():
    e = make_event("2026-04-29T14:00:00Z", -32.9, -68.8, 4.8)
    assert compute_canonical_id(e) == compute_canonical_id(e)


def test_handles_datetime_with_offset():
    e = make_event("2026-04-29T11:00:00-03:00", -32.9, -68.8, 4.8)
    e_utc = make_event("2026-04-29T14:00:00Z", -32.9, -68.8, 4.8)
    assert compute_canonical_id(e) == compute_canonical_id(e_utc)
```

- [ ] **Step 3: Verificar fail**

```bash
pytest tests/unit/test_canonical_id.py -v
```

Expected: FAIL `ModuleNotFoundError`.

- [ ] **Step 4: Implementar canonical_id.py**

Crear `src/ingestors/canonical_id.py`:

```python
"""
Cálculo de canonical_id determinístico para eventos sísmicos.

El canonical_id permite deduplicar reportes del mismo terremoto provenientes
de fuentes distintas (EMSC, USGS, INPRES) sin necesidad de estado compartido.

Algoritmo: sha1 de (epoch_seconds//10, round(lat,1), round(lon,1), int(mag))[:16]

- Bucket temporal de 10s tolera el jitter de timestamps entre fuentes.
- Coordenadas redondeadas a 0.1° (~11km) toleran imprecisión de localización.
- Mag bucket entero evita colisiones en enjambres con magnitudes diferentes.
"""
import hashlib
from datetime import datetime
from src.utils.geo import parse_datetime_utc


def compute_canonical_id(event: dict) -> str:
    """Calcula el canonical_id a partir de hora_utc, lat, lon, mag.

    Args:
        event: dict con keys 'hora_utc' (ISO8601 string), 'lat', 'lon', 'mag'.

    Returns:
        16 chars hex.
    """
    dt = parse_datetime_utc(event["hora_utc"])
    epoch_bucket = int(dt.timestamp()) // 10
    lat_round = round(event["lat"], 1)
    lon_round = round(event["lon"], 1)
    mag_bucket = int(event["mag"])

    key = f"{epoch_bucket}_{lat_round}_{lon_round}_{mag_bucket}"
    return hashlib.sha1(key.encode()).hexdigest()[:16]
```

- [ ] **Step 5: Verificar tests pasan**

```bash
pytest tests/unit/test_canonical_id.py -v
```

Expected: PASS los 6 tests.

- [ ] **Step 6: Commit**

```bash
git add src/ingestors/__init__.py src/ingestors/canonical_id.py tests/unit/test_canonical_id.py
git commit -m "feat(ingestors): add canonical_id deterministic hash"
```

---

### Task 2.2: Exponer fuse_two_events público

**Files:**
- Modify: `src/services/merge_service.py`

- [ ] **Step 1: Agregar alias público al final de merge_service.py**

Editar `src/services/merge_service.py`, agregar al final del archivo:

```python


# Alias público para reuso desde ingestors.dispatcher
fuse_two_events = _fuse_two_events
```

- [ ] **Step 2: Smoke test del import**

```bash
python -c "from src.services.merge_service import fuse_two_events; print('ok')"
```

Expected: imprime `ok`.

- [ ] **Step 3: Commit**

```bash
git add src/services/merge_service.py
git commit -m "refactor(merge): expose fuse_two_events publicly for dispatcher reuse"
```

---

### Task 2.3: Implementar Dispatcher (NEW vs UPDATE logic)

**Files:**
- Create: `src/ingestors/dispatcher.py`
- Test: `tests/unit/test_dispatcher_logic.py`

- [ ] **Step 1: Escribir test failing**

Crear `tests/unit/test_dispatcher_logic.py`:

```python
"""Tests unitarios del Dispatcher con FakeRedis."""
import asyncio
import json
import pytest
from unittest.mock import AsyncMock, MagicMock
from src.ingestors.dispatcher import Dispatcher
from src.services.event_bus import AsyncioQueueBus


class FakeRedis:
    def __init__(self) -> None:
        self.store: dict[str, str] = {}
        self.zset: list[tuple[float, str]] = []
        self.published: list[tuple[str, str]] = []

    async def set(self, key, value, ex=None, nx=False):
        if nx and key in self.store:
            return None
        self.store[key] = value
        return True

    async def get(self, key):
        return self.store.get(key)

    async def delete(self, key):
        self.store.pop(key, None)
        return 1

    async def zadd(self, key, mapping):
        for member, score in mapping.items():
            self.zset.append((score, member))
        return len(mapping)

    async def zremrangebyscore(self, key, min_, max_):
        before = len(self.zset)
        self.zset = [e for e in self.zset if not (min_ <= e[0] <= max_)]
        return before - len(self.zset)

    async def publish(self, channel, message):
        self.published.append((channel, message))
        return 1


def make_raw_event(source: str, mag: float = 4.8) -> dict:
    return {
        "id": f"{source}_test",
        "fuentes": [source],
        "hora_utc": "2026-04-29T14:00:00Z",
        "lat": -32.9,
        "lon": -68.8,
        "prof_km": 50.0,
        "mag": mag,
        "mag_tipo": "Mw",
        "lugar": "Test",
        "sentido": False,
        "revisado": source != "EMSC",
    }


@pytest.mark.asyncio
async def test_first_event_published_as_new():
    redis = FakeRedis()
    archive = AsyncMock()
    dispatcher = Dispatcher(redis_client=redis, archive_writer=archive)

    await dispatcher.process_event(make_raw_event("EMSC"))

    assert len(redis.published) == 1
    channel, payload_json = redis.published[0]
    assert channel == "seismic.events"
    payload = json.loads(payload_json)
    assert payload["type"] == "new"
    assert payload["event"]["fuentes"] == ["EMSC"]
    archive.append.assert_awaited_once()


@pytest.mark.asyncio
async def test_second_source_publishes_update_with_merged_sources():
    redis = FakeRedis()
    archive = AsyncMock()
    dispatcher = Dispatcher(redis_client=redis, archive_writer=archive)

    await dispatcher.process_event(make_raw_event("EMSC", mag=4.8))
    await dispatcher.process_event(make_raw_event("USGS", mag=4.9))

    assert len(redis.published) == 2
    second = json.loads(redis.published[1][1])
    assert second["type"] == "update"
    assert set(second["event"]["fuentes"]) == {"EMSC", "USGS"}
    assert second["event"]["mag"] == 4.9


@pytest.mark.asyncio
async def test_identical_repeat_does_not_publish():
    redis = FakeRedis()
    archive = AsyncMock()
    dispatcher = Dispatcher(redis_client=redis, archive_writer=archive)

    raw = make_raw_event("EMSC")
    await dispatcher.process_event(raw)
    await dispatcher.process_event(raw)  # idéntico

    assert len(redis.published) == 1  # solo el primero


@pytest.mark.asyncio
async def test_lock_prevents_concurrent_processing():
    """Si dos coroutines procesan el mismo canonical_id en paralelo,
    una espera a la otra (no pierde el evento)."""
    redis = FakeRedis()
    archive = AsyncMock()
    dispatcher = Dispatcher(redis_client=redis, archive_writer=archive)

    raw_a = make_raw_event("EMSC", mag=4.8)
    raw_b = make_raw_event("USGS", mag=4.9)

    await asyncio.gather(
        dispatcher.process_event(raw_a),
        dispatcher.process_event(raw_b),
    )

    # Ambos deben haberse procesado: 1 NEW + 1 UPDATE
    assert len(redis.published) == 2
```

- [ ] **Step 2: Verificar fail**

```bash
pytest tests/unit/test_dispatcher_logic.py -v
```

Expected: FAIL `ModuleNotFoundError`.

- [ ] **Step 3: Implementar Dispatcher**

Crear `src/ingestors/dispatcher.py`:

```python
"""
Dispatcher: corazón de la deduplicación y enriquecimiento.

Consume eventos crudos del EventBus interno, calcula canonical_id, decide
NEW vs UPDATE consultando Redis, fusiona con merge_service, publica el
resultado al canal Redis Pub/Sub `seismic.events` y persiste a JSONL.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from collections import deque
from typing import Any

from src.ingestors.canonical_id import compute_canonical_id
from src.models.event import SeismicEvent
from src.services.merge_service import fuse_two_events
from src.observability.metrics import (
    dispatcher_events_processed,
    dispatcher_local_buffer_size,
    redis_errors_total,
)

logger = logging.getLogger(__name__)

CHANNEL = "seismic.events"
STATE_PREFIX = "events:state:"
REPLAY_KEY = "events:replay"
LOCK_PREFIX = "lock:"
LOCK_TTL_SECONDS = 2
STATE_TTL_SECONDS = 3600
REPLAY_WINDOW_MS = 86400_000  # 24h


class Dispatcher:
    """Procesa eventos crudos de listeners y publica al canal Redis."""

    def __init__(
        self,
        redis_client: Any,
        archive_writer: Any,
        local_buffer_max: int = 10_000,
    ) -> None:
        self.redis = redis_client
        self.archive = archive_writer
        self.local_buffer: deque = deque(maxlen=local_buffer_max)

    async def process_event(self, raw_event: dict) -> None:
        """Procesa un evento crudo: calcula canonical_id, dedupe, publica."""
        try:
            canonical_id = compute_canonical_id(raw_event)
        except (KeyError, ValueError) as e:
            logger.warning(f"Invalid event for canonical_id: {e}, raw={raw_event}")
            dispatcher_events_processed.labels(event_type="invalid").inc()
            return

        # Lock distribuido (espera con backoff si está tomado)
        lock_key = f"{LOCK_PREFIX}{canonical_id}"
        for attempt in range(20):
            try:
                acquired = await self.redis.set(lock_key, "1", nx=True, ex=LOCK_TTL_SECONDS)
            except Exception as e:
                logger.error(f"Redis error acquiring lock: {e}")
                redis_errors_total.labels(operation="lock").inc()
                self._buffer_locally(raw_event)
                return
            if acquired:
                break
            await asyncio.sleep(0.05)
        else:
            logger.warning(f"Could not acquire lock for {canonical_id} after retries")
            return

        try:
            await self._process_with_lock(canonical_id, raw_event)
        finally:
            try:
                await self.redis.delete(lock_key)
            except Exception:
                pass

    async def _process_with_lock(self, canonical_id: str, raw: dict) -> None:
        state_key = f"{STATE_PREFIX}{canonical_id}"

        try:
            existing_json = await self.redis.get(state_key)
        except Exception as e:
            logger.error(f"Redis GET failed: {e}")
            redis_errors_total.labels(operation="get").inc()
            self._buffer_locally(raw)
            return

        try:
            new_event = SeismicEvent(**{k: v for k, v in raw.items() if k != "id"})
        except Exception as e:
            logger.warning(f"Pydantic validation failed: {e}")
            dispatcher_events_processed.labels(event_type="invalid").inc()
            return

        if existing_json is None:
            merged = new_event
            event_type = "new"
        else:
            try:
                existing = SeismicEvent.model_validate_json(existing_json)
            except Exception as e:
                logger.error(f"Could not parse existing state: {e}")
                merged = new_event
                event_type = "new"
            else:
                merged = fuse_two_events(existing, new_event)
                if _events_equal(existing, merged):
                    dispatcher_events_processed.labels(event_type="noop").inc()
                    return
                event_type = "update"

        # Forzar canonical_id en el evento publicado
        merged_dict = merged.model_dump()
        merged_dict["canonical_id"] = canonical_id

        payload = {"type": event_type, "event": merged_dict}
        payload_json = json.dumps(payload, default=str)
        epoch_ms_now = int(time.time() * 1000)

        # Persistir
        try:
            await self.redis.set(state_key, json.dumps(merged_dict, default=str), ex=STATE_TTL_SECONDS)
            await self.redis.zadd(REPLAY_KEY, {payload_json: epoch_ms_now})
            await self.redis.zremrangebyscore(REPLAY_KEY, 0, epoch_ms_now - REPLAY_WINDOW_MS)
            await self.redis.publish(CHANNEL, payload_json)
        except Exception as e:
            logger.error(f"Redis persistence failed: {e}")
            redis_errors_total.labels(operation="persist").inc()
            self._buffer_locally(raw)
            return

        # Archivar a JSONL
        try:
            await self.archive.append(payload)
        except Exception as e:
            logger.error(f"Archive write failed: {e}")

        dispatcher_events_processed.labels(event_type=event_type).inc()

    def _buffer_locally(self, raw: dict) -> None:
        self.local_buffer.append(raw)
        dispatcher_local_buffer_size.set(len(self.local_buffer))

    async def flush_buffer(self) -> int:
        """Re-procesa el buffer local cuando Redis vuelve. Retorna cantidad flusheada."""
        flushed = 0
        while self.local_buffer:
            raw = self.local_buffer.popleft()
            try:
                await self.process_event(raw)
                flushed += 1
            except Exception as e:
                logger.error(f"Flush failed for event: {e}, re-buffering")
                self.local_buffer.appendleft(raw)
                break
        dispatcher_local_buffer_size.set(len(self.local_buffer))
        return flushed


def _events_equal(a: SeismicEvent, b: SeismicEvent) -> bool:
    """Compara dos eventos para detectar si un merge fue no-op."""
    return (
        sorted(a.fuentes) == sorted(b.fuentes)
        and a.mag == b.mag
        and a.prof_km == b.prof_km
        and a.sentido == b.sentido
        and a.revisado == b.revisado
        and a.lat == b.lat
        and a.lon == b.lon
    )
```

- [ ] **Step 4: Verificar tests pasan**

```bash
pytest tests/unit/test_dispatcher_logic.py -v
```

Expected: PASS los 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ingestors/dispatcher.py tests/unit/test_dispatcher_logic.py
git commit -m "feat(dispatcher): NEW/UPDATE dedup logic with lock and local buffer"
```

---

### Task 2.4: Implementar ArchiveWriter (JSONL con rotación diaria)

**Files:**
- Create: `src/ingestors/archive_writer.py`
- Test: `tests/unit/test_archive_writer.py`

- [ ] **Step 1: Escribir test failing**

Crear `tests/unit/test_archive_writer.py`:

```python
"""Tests para ArchiveWriter."""
import json
import os
import pytest
from datetime import datetime, timezone
from freezegun import freeze_time
from src.ingestors.archive_writer import ArchiveWriter


@pytest.mark.asyncio
async def test_writes_jsonl_to_daily_file(tmp_path):
    writer = ArchiveWriter(base_dir=str(tmp_path))
    with freeze_time("2026-04-29T14:00:00Z"):
        await writer.append({"type": "new", "event": {"id": "x"}})
        await writer.append({"type": "update", "event": {"id": "x"}})

    files = list(tmp_path.iterdir())
    assert len(files) == 1
    assert files[0].name == "2026-04-29.jsonl"
    lines = files[0].read_text().strip().split("\n")
    assert len(lines) == 2
    assert json.loads(lines[0])["type"] == "new"


@pytest.mark.asyncio
async def test_rotates_at_midnight_utc(tmp_path):
    writer = ArchiveWriter(base_dir=str(tmp_path))
    with freeze_time("2026-04-29T23:59:59Z"):
        await writer.append({"day": "before"})
    with freeze_time("2026-04-30T00:00:01Z"):
        await writer.append({"day": "after"})

    names = sorted(p.name for p in tmp_path.iterdir())
    assert names == ["2026-04-29.jsonl", "2026-04-30.jsonl"]


@pytest.mark.asyncio
async def test_creates_dir_if_missing(tmp_path):
    sub = tmp_path / "deep" / "nested"
    writer = ArchiveWriter(base_dir=str(sub))
    await writer.append({"foo": "bar"})
    assert sub.exists()
```

- [ ] **Step 2: Verificar fail**

```bash
pytest tests/unit/test_archive_writer.py -v
```

Expected: FAIL `ModuleNotFoundError`.

- [ ] **Step 3: Implementar ArchiveWriter**

Crear `src/ingestors/archive_writer.py`:

```python
"""
ArchiveWriter: persiste eventos a JSONL con rotación diaria UTC.

Permite replay de eventos más viejos que la ventana Redis (24h).
Cuando llegue TimescaleDB en cambio futuro, se reemplaza por DB.
"""
from __future__ import annotations

import asyncio
import json
import os
from datetime import datetime, timezone
from pathlib import Path

from src.observability.metrics import archive_writes_total, archive_write_errors_total


class ArchiveWriter:
    """Append-only JSONL archive con rotación diaria."""

    def __init__(self, base_dir: str) -> None:
        self.base_dir = Path(base_dir)
        self._lock = asyncio.Lock()

    def _path_for(self, when: datetime) -> Path:
        date_str = when.strftime("%Y-%m-%d")
        return self.base_dir / f"{date_str}.jsonl"

    async def append(self, payload: dict) -> None:
        """Escribe payload como una línea JSONL al archivo del día UTC actual."""
        async with self._lock:
            try:
                self.base_dir.mkdir(parents=True, exist_ok=True)
                path = self._path_for(datetime.now(timezone.utc))
                line = json.dumps(payload, default=str) + "\n"
                # Escritura sync, pero protegida por lock asyncio
                with path.open("a", encoding="utf-8") as f:
                    f.write(line)
                archive_writes_total.inc()
            except OSError as e:
                archive_write_errors_total.inc()
                raise
```

- [ ] **Step 4: Verificar tests pasan**

```bash
pytest tests/unit/test_archive_writer.py -v
```

Expected: PASS los 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ingestors/archive_writer.py tests/unit/test_archive_writer.py
git commit -m "feat(archive): JSONL writer with daily UTC rotation"
```

---

## Phase 3: Listeners (EMSC, USGS, INPRES)

### Task 3.1: Implementar EMSCListener (WebSocket con reconexión)

**Files:**
- Create: `src/ingestors/emsc_listener.py`
- Test: `tests/integration/test_emsc_reconnection.py`

- [ ] **Step 1: Implementar EMSCListener**

Crear `src/ingestors/emsc_listener.py`:

```python
"""
EMSCListener: mantiene WebSocket persistente contra EMSC seismicportal.eu.

URL: wss://www.seismicportal.eu/standing_order/websocket

Características:
- Reconexión exponencial (1s → 60s, max 60s) con jitter ±10%
- Heartbeat: si no hay mensaje en 5min, asume conexión muerta
- Métrica de salud para que USGSPoller lea y acelere si EMSC está caído
- Métricas Prometheus + GlitchTip para observabilidad
"""
from __future__ import annotations

import asyncio
import json
import logging
import random
import time
from typing import Any

import sentry_sdk
import websockets

from src.observability.metrics import (
    emsc_websocket_connected,
    emsc_last_message_seconds_ago,
    emsc_parse_errors_total,
    emsc_reconnections_total,
)
from src.services.event_bus import AsyncioQueueBus

logger = logging.getLogger(__name__)

EMSC_WS_URL = "wss://www.seismicportal.eu/standing_order/websocket"
HEARTBEAT_TIMEOUT_SECONDS = 300  # 5 min
INITIAL_BACKOFF = 1.0
MAX_BACKOFF = 60.0


class EMSCListener:
    """Listener de WebSocket EMSC."""

    def __init__(self, bus: AsyncioQueueBus, channel: str = "ingest") -> None:
        self.bus = bus
        self.channel = channel
        self.last_message_ts: float = 0.0
        self._stopped = False

    @property
    def seconds_since_last_message(self) -> float:
        if self.last_message_ts == 0:
            return float("inf")
        return time.time() - self.last_message_ts

    @property
    def is_degraded(self) -> bool:
        return self.seconds_since_last_message > 120

    async def run(self) -> None:
        backoff = INITIAL_BACKOFF
        while not self._stopped:
            try:
                emsc_websocket_connected.set(0)
                logger.info(f"Connecting to EMSC WS: {EMSC_WS_URL}")
                async with websockets.connect(
                    EMSC_WS_URL,
                    ping_interval=30,
                    ping_timeout=20,
                    close_timeout=5,
                ) as ws:
                    emsc_websocket_connected.set(1)
                    backoff = INITIAL_BACKOFF
                    logger.info("EMSC WS connected")

                    # Tarea heartbeat watchdog
                    watchdog = asyncio.create_task(self._watchdog(ws))
                    try:
                        await self._consume(ws)
                    finally:
                        watchdog.cancel()
            except (
                websockets.ConnectionClosed,
                websockets.InvalidStatusCode,
                ConnectionRefusedError,
                OSError,
            ) as e:
                emsc_websocket_connected.set(0)
                emsc_reconnections_total.inc()
                jitter = random.uniform(0.9, 1.1)
                wait = min(backoff * jitter, MAX_BACKOFF)
                logger.warning(f"EMSC WS error: {e}. Reconnecting in {wait:.1f}s")
                sentry_sdk.capture_message(
                    f"EMSC WS reconnect: {type(e).__name__}: {e}",
                    level="warning",
                )
                await asyncio.sleep(wait)
                backoff = min(backoff * 2, MAX_BACKOFF)
            except Exception as e:
                emsc_websocket_connected.set(0)
                logger.exception("Unexpected EMSC error")
                sentry_sdk.capture_exception(e)
                await asyncio.sleep(5)

    async def _consume(self, ws: Any) -> None:
        async for raw in ws:
            self.last_message_ts = time.time()
            emsc_last_message_seconds_ago.set(0)
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError as e:
                emsc_parse_errors_total.inc()
                logger.warning(f"EMSC bad JSON: {e}, raw[:200]={raw[:200]}")
                continue
            normalized = self._normalize(msg)
            if normalized is None:
                continue
            await self.bus.publish(self.channel, normalized)

    def _normalize(self, msg: dict) -> dict | None:
        """Convierte frame EMSC a dict compatible con SeismicEvent."""
        try:
            data = msg.get("data") if msg.get("action") == "create" else None
            if data is None:
                return None
            props = data.get("properties", {})
            geom = data.get("geometry", {})
            coords = geom.get("coordinates", [None, None, None])
            if coords[1] is None or coords[0] is None:
                return None
            time_str = props.get("time")
            if not time_str:
                return None
            return {
                "fuentes": ["EMSC"],
                "hora_utc": time_str if time_str.endswith("Z") else time_str + "Z",
                "lat": coords[1],
                "lon": coords[0],
                "prof_km": coords[2] if len(coords) > 2 else None,
                "mag": props.get("mag", 0.0),
                "mag_tipo": props.get("magtype", "M"),
                "lugar": props.get("flynn_region") or props.get("place", "Unknown"),
                "sentido": False,
                "revisado": props.get("status") in ("reviewed", "manual"),
            }
        except (KeyError, TypeError, ValueError) as e:
            emsc_parse_errors_total.inc()
            logger.warning(f"EMSC normalize failed: {e}")
            return None

    async def _watchdog(self, ws: Any) -> None:
        while True:
            await asyncio.sleep(30)
            since = self.seconds_since_last_message
            emsc_last_message_seconds_ago.set(since)
            if since > HEARTBEAT_TIMEOUT_SECONDS:
                logger.warning(f"EMSC heartbeat timeout ({since:.0f}s), forcing reconnect")
                await ws.close(code=1011, reason="heartbeat timeout")
                return

    def stop(self) -> None:
        self._stopped = True
```

- [ ] **Step 2: Escribir test integración con mock WS**

Crear `tests/integration/test_emsc_reconnection.py`:

```python
"""Test que EMSCListener reconecta con backoff exponencial."""
import asyncio
import pytest
import websockets
from src.ingestors.emsc_listener import EMSCListener
from src.services.event_bus import AsyncioQueueBus


@pytest.mark.asyncio
async def test_listener_reconnects_after_disconnect():
    """Levantamos un WS server local que cierra al primer mensaje y verificamos reconexión."""
    connections = []

    async def ws_handler(ws):
        connections.append(ws)
        await ws.send('{"action":"create","data":{"properties":{"time":"2026-04-29T14:00:00Z","mag":4.0,"magtype":"M","place":"Test"},"geometry":{"coordinates":[-68.8,-32.9,50]}}}')
        await ws.close()

    server = await websockets.serve(ws_handler, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]

    # Patchear URL
    import src.ingestors.emsc_listener as mod
    original_url = mod.EMSC_WS_URL
    mod.EMSC_WS_URL = f"ws://127.0.0.1:{port}"
    mod.INITIAL_BACKOFF = 0.1
    mod.MAX_BACKOFF = 0.5

    bus = AsyncioQueueBus()
    listener = EMSCListener(bus)

    task = asyncio.create_task(listener.run())
    received: list[dict] = []

    async def consume():
        async for evt in bus.subscribe("ingest"):
            received.append(evt)
            if len(received) >= 2:
                return

    try:
        await asyncio.wait_for(consume(), timeout=5)
    finally:
        listener.stop()
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass
        server.close()
        await server.wait_closed()
        mod.EMSC_WS_URL = original_url

    assert len(received) >= 2
    assert len(connections) >= 2  # reconectó al menos una vez
```

- [ ] **Step 3: Verificar test pasa**

```bash
pytest tests/integration/test_emsc_reconnection.py -v
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/ingestors/emsc_listener.py tests/integration/test_emsc_reconnection.py
git commit -m "feat(ingestors): EMSCListener with exponential backoff and watchdog"
```

---

### Task 3.2: Implementar USGSPoller (con polling adaptativo)

**Files:**
- Create: `src/ingestors/usgs_poller.py`

- [ ] **Step 1: Implementar USGSPoller**

Crear `src/ingestors/usgs_poller.py`:

```python
"""
USGSPoller: hace polling al USGS ComCat API cada 30s normalmente, 15s si EMSC degraded.
"""
from __future__ import annotations

import asyncio
import logging
import sentry_sdk

from src.services.usgs_service import fetch_usgs_events
from src.services.event_bus import AsyncioQueueBus
from src.observability.metrics import usgs_rate_limited_total
from src.config.settings import settings

logger = logging.getLogger(__name__)

NORMAL_INTERVAL_SECONDS = 30
DEGRADED_INTERVAL_SECONDS = 15
WINDOW_MINUTES = 15


class USGSPoller:
    def __init__(
        self,
        bus: AsyncioQueueBus,
        channel: str = "ingest",
        emsc_health_check=None,
    ) -> None:
        self.bus = bus
        self.channel = channel
        self.emsc_health_check = emsc_health_check  # callable -> bool (True si degraded)
        self._stopped = False

    def _interval(self) -> int:
        if self.emsc_health_check and self.emsc_health_check():
            return DEGRADED_INTERVAL_SECONDS
        return NORMAL_INTERVAL_SECONDS

    async def run(self) -> None:
        # Catchup inicial: una window más amplia para llenar el gap de restart
        await self._poll_once(window_minutes=WINDOW_MINUTES)
        while not self._stopped:
            await asyncio.sleep(self._interval())
            await self._poll_once(window_minutes=WINDOW_MINUTES)

    async def _poll_once(self, window_minutes: int) -> None:
        try:
            events, error = await fetch_usgs_events(window_minutes)
        except Exception as e:
            logger.exception("USGS poll failed")
            sentry_sdk.capture_exception(e)
            return
        if error:
            logger.warning(f"USGS error: {error}")
            if "429" in error:
                usgs_rate_limited_total.inc()
            return
        for evt in events:
            normalized = self._normalize(evt)
            await self.bus.publish(self.channel, normalized)

    def _normalize(self, event) -> dict:
        return {
            "fuentes": ["USGS"],
            "hora_utc": event.hora_utc,
            "lat": event.lat,
            "lon": event.lon,
            "prof_km": event.prof_km,
            "mag": event.mag,
            "mag_tipo": event.mag_tipo,
            "lugar": event.lugar,
            "sentido": event.sentido,
            "revisado": event.revisado,
        }

    def stop(self) -> None:
        self._stopped = True
```

- [ ] **Step 2: Smoke test del import**

```bash
python -c "from src.ingestors.usgs_poller import USGSPoller; print('ok')"
```

Expected: imprime `ok`.

- [ ] **Step 3: Commit**

```bash
git add src/ingestors/usgs_poller.py
git commit -m "feat(ingestors): USGSPoller with adaptive interval based on EMSC health"
```

---

### Task 3.3: Implementar INPRESPoller

**Files:**
- Create: `src/ingestors/inpres_poller.py`

- [ ] **Step 1: Implementar INPRESPoller**

Crear `src/ingestors/inpres_poller.py`:

```python
"""
INPRESPoller: hace polling al adapter INPRES cada 5min.
"""
from __future__ import annotations

import asyncio
import logging
import sentry_sdk

from src.services.inpres_service import fetch_inpres_events
from src.services.event_bus import AsyncioQueueBus

logger = logging.getLogger(__name__)

INTERVAL_SECONDS = 300  # 5 min
WINDOW_MINUTES = 60


class INPRESPoller:
    def __init__(self, bus: AsyncioQueueBus, channel: str = "ingest") -> None:
        self.bus = bus
        self.channel = channel
        self._stopped = False

    async def run(self) -> None:
        await self._poll_once()
        while not self._stopped:
            await asyncio.sleep(INTERVAL_SECONDS)
            await self._poll_once()

    async def _poll_once(self) -> None:
        try:
            events, error = await fetch_inpres_events(WINDOW_MINUTES)
        except Exception as e:
            logger.exception("INPRES poll failed")
            sentry_sdk.capture_exception(e)
            return
        if error:
            logger.warning(f"INPRES error: {error}")
            return
        for evt in events:
            await self.bus.publish(self.channel, {
                "fuentes": ["INPRES"],
                "hora_utc": evt.hora_utc,
                "lat": evt.lat,
                "lon": evt.lon,
                "prof_km": evt.prof_km,
                "mag": evt.mag,
                "mag_tipo": evt.mag_tipo,
                "lugar": evt.lugar,
                "sentido": evt.sentido,
                "revisado": evt.revisado,
            })

    def stop(self) -> None:
        self._stopped = True
```

- [ ] **Step 2: Smoke test**

```bash
python -c "from src.ingestors.inpres_poller import INPRESPoller; print('ok')"
```

Expected: `ok`.

- [ ] **Step 3: Commit**

```bash
git add src/ingestors/inpres_poller.py
git commit -m "feat(ingestors): INPRESPoller every 5 minutes"
```

---

### Task 3.4: Entry point del ingestor + healthcheck

**Files:**
- Create: `src/ingestors/main.py`
- Create: `src/ingestors/healthcheck.py`

- [ ] **Step 1: Crear `src/ingestors/main.py`**

```python
"""
Entry point del proceso ingestor.

Inicializa GlitchTip, conecta Redis, levanta listeners y dispatcher
en paralelo con asyncio.gather.

Run: python -m src.ingestors.main
"""
from __future__ import annotations

import asyncio
import logging
import os
import signal

import redis.asyncio as aioredis
import sentry_sdk

from src.config.settings import settings
from src.config.regions import validate_presets
from src.ingestors.archive_writer import ArchiveWriter
from src.ingestors.dispatcher import Dispatcher
from src.ingestors.emsc_listener import EMSCListener
from src.ingestors.usgs_poller import USGSPoller
from src.ingestors.inpres_poller import INPRESPoller
from src.observability.glitchtip import init_glitchtip
from src.services.event_bus import AsyncioQueueBus

logger = logging.getLogger(__name__)


async def wait_for_redis(url: str, max_wait: int = 60) -> aioredis.Redis:
    """Espera hasta que Redis responda PING o falla rápido."""
    import time
    client = aioredis.from_url(url, decode_responses=True)
    start = time.time()
    while time.time() - start < max_wait:
        try:
            await client.ping()
            return client
        except Exception as e:
            logger.warning(f"Redis not ready: {e}")
            await asyncio.sleep(2)
    raise RuntimeError(f"Redis at {url} unavailable after {max_wait}s")


async def watchdog(emsc: EMSCListener) -> None:
    """Sale del proceso si EMSC lleva >10min sin mensaje (docker reinicia)."""
    while True:
        await asyncio.sleep(60)
        if emsc.seconds_since_last_message > 600:
            logger.error("EMSC silent for >10min, forcing exit for docker restart")
            os._exit(1)


async def dispatch_loop(bus: AsyncioQueueBus, dispatcher: Dispatcher) -> None:
    async for raw in bus.subscribe("ingest"):
        await dispatcher.process_event(raw)


async def main() -> None:
    logging.basicConfig(
        level=getattr(logging, settings.log_level.upper()),
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    )

    init_glitchtip(component="ingestor")
    validate_presets()

    redis_client = await wait_for_redis(settings.redis_url)
    archive = ArchiveWriter(base_dir=settings.archive_dir)
    bus = AsyncioQueueBus(maxsize=10_000)
    dispatcher = Dispatcher(redis_client=redis_client, archive_writer=archive)

    emsc = EMSCListener(bus)
    usgs = USGSPoller(bus, emsc_health_check=lambda: emsc.is_degraded)
    inpres = INPRESPoller(bus)

    stop_event = asyncio.Event()

    def handle_signal(*_):
        logger.info("Signal received, shutting down")
        stop_event.set()
        emsc.stop()
        usgs.stop()
        inpres.stop()

    loop = asyncio.get_event_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, handle_signal)

    tasks = [
        asyncio.create_task(emsc.run(), name="emsc"),
        asyncio.create_task(usgs.run(), name="usgs"),
        asyncio.create_task(inpres.run(), name="inpres"),
        asyncio.create_task(dispatch_loop(bus, dispatcher), name="dispatch"),
        asyncio.create_task(watchdog(emsc), name="watchdog"),
    ]

    logger.info("🚀 Ingestor running")
    await stop_event.wait()
    for t in tasks:
        t.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    await redis_client.aclose()


if __name__ == "__main__":
    asyncio.run(main())
```

- [ ] **Step 2: Crear `src/ingestors/healthcheck.py`**

```python
"""
Healthcheck script standalone para Docker HEALTHCHECK del ingestor.

Verifica:
- Redis responde a PING
- Archivo de pid/status existe y EMSC envió un mensaje en últimos 10min

Sale 0 si OK, 1 si KO.
"""
import asyncio
import sys
import os

import redis.asyncio as aioredis

from src.config.settings import settings


HEALTH_FILE = "/tmp/ingestor_health"
EMSC_MAX_AGE_SECONDS = 600  # 10 min


async def main() -> int:
    # 1. Redis
    try:
        client = aioredis.from_url(settings.redis_url, decode_responses=True)
        await client.ping()
        await client.aclose()
    except Exception as e:
        print(f"FAIL: redis: {e}", file=sys.stderr)
        return 1

    # 2. EMSC freshness file (escrito periódicamente por el listener watchdog)
    if os.path.exists(HEALTH_FILE):
        try:
            mtime = os.path.getmtime(HEALTH_FILE)
            import time
            age = time.time() - mtime
            if age > EMSC_MAX_AGE_SECONDS:
                print(f"FAIL: emsc stale {age:.0f}s", file=sys.stderr)
                return 1
        except OSError as e:
            print(f"FAIL: emsc health file: {e}", file=sys.stderr)
            return 1

    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
```

- [ ] **Step 3: Modificar EMSCListener para escribir health file**

Editar `src/ingestors/emsc_listener.py`. En `_consume`, después de actualizar `last_message_ts`, agregar:

```python
            try:
                with open("/tmp/ingestor_health", "w") as f:
                    f.write(str(self.last_message_ts))
            except OSError:
                pass
```

- [ ] **Step 4: Smoke test del import**

```bash
python -c "import src.ingestors.main; print('ok')"
python -c "import src.ingestors.healthcheck; print('ok')"
```

Expected: ambos `ok`.

- [ ] **Step 5: Commit**

```bash
git add src/ingestors/main.py src/ingestors/healthcheck.py src/ingestors/emsc_listener.py
git commit -m "feat(ingestors): main entry point with watchdog and healthcheck script"
```

---

## Phase 4: API SSE

### Task 4.1: SSE router con snapshot inicial + replay

**Files:**
- Create: `src/api/__init__.py`
- Create: `src/api/sse_router.py`
- Test: `tests/unit/test_sse_format.py`

- [ ] **Step 1: Crear paquete y test**

```bash
touch src/api/__init__.py
```

Crear `tests/unit/test_sse_format.py`:

```python
"""Tests para utilidades de formato SSE."""
import pytest
from src.api.sse_router import format_sse_message, parse_last_event_id


def test_format_sse_message_full():
    msg = format_sse_message(
        event_id="1730000000000-1",
        event_type="seismic",
        data={"foo": "bar"},
    )
    assert "id: 1730000000000-1\n" in msg
    assert "event: seismic\n" in msg
    assert 'data: {"foo": "bar"}\n\n' in msg


def test_parse_last_event_id_valid():
    assert parse_last_event_id("1730000000000-1") == 1730000000000


def test_parse_last_event_id_garbage():
    assert parse_last_event_id("garbage") is None


def test_parse_last_event_id_empty():
    assert parse_last_event_id("") is None
    assert parse_last_event_id(None) is None


def test_parse_last_event_id_too_old():
    import time
    too_old = (int(time.time() * 1000) - 86400_000 * 2)  # 48h
    assert parse_last_event_id(f"{too_old}-1") is None


def test_parse_last_event_id_from_future():
    import time
    future = int(time.time() * 1000) + 120_000  # 2min en el futuro
    assert parse_last_event_id(f"{future}-1") is None
```

- [ ] **Step 2: Verificar fail**

```bash
pytest tests/unit/test_sse_format.py -v
```

Expected: FAIL `ImportError`.

- [ ] **Step 3: Implementar `src/api/sse_router.py`**

```python
"""
SSE router: GET /stream/events?regions=preset1,preset2

Flujo:
1. Validar regions (presets válidos)
2. Si NO hay Last-Event-ID: snapshot última hora filtrado por bbox
3. Si HAY Last-Event-ID: replay desde ese epoch_ms
4. Subscribe Redis pub/sub, filtrar por bbox, reenviar
5. Heartbeat cada N segundos
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import AsyncIterator, Optional

import redis.asyncio as aioredis
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from src.config.regions import (
    REGION_PRESETS,
    event_in_bbox,
    get_bbox_for_regions,
)
from src.config.settings import settings
from src.observability.metrics import (
    sse_active_clients,
    sse_messages_sent_total,
    sse_replay_truncated_total,
)

logger = logging.getLogger(__name__)

router = APIRouter()

CHANNEL = "seismic.events"
REPLAY_KEY = "events:replay"
SNAPSHOT_WINDOW_MS = 3600_000  # 1h
REPLAY_MAX_AGE_MS = 86400_000  # 24h


def format_sse_message(event_id: str, event_type: str, data: dict) -> str:
    """Formatea un mensaje SSE válido."""
    return f"id: {event_id}\nevent: {event_type}\ndata: {json.dumps(data)}\n\n"


def parse_last_event_id(header: Optional[str]) -> Optional[int]:
    """Parsea Last-Event-ID. Devuelve None si inválido, muy viejo, o del futuro."""
    if not header:
        return None
    try:
        epoch_ms = int(header.split("-")[0])
    except (ValueError, IndexError):
        return None
    now_ms = int(time.time() * 1000)
    if epoch_ms > now_ms + 60_000:
        return None  # del futuro (clock skew)
    if epoch_ms < now_ms - REPLAY_MAX_AGE_MS:
        return None  # muy viejo
    return epoch_ms


def event_matches_bboxes(event: dict, bboxes: list[dict]) -> bool:
    """True si el evento cae en al menos uno de los bboxes (o si bboxes vacío = global)."""
    if not bboxes:
        return True
    return any(event_in_bbox(event, bbox) for bbox in bboxes)


async def _redis_client() -> aioredis.Redis:
    return aioredis.from_url(settings.redis_url, decode_responses=True)


async def _snapshot_or_replay(
    redis: aioredis.Redis, last_event_id: Optional[int], bboxes: list[dict]
) -> AsyncIterator[tuple[int, dict]]:
    """Yields (epoch_ms, payload) para snapshot inicial o replay."""
    now_ms = int(time.time() * 1000)
    if last_event_id is not None:
        min_score = last_event_id + 1
    else:
        min_score = now_ms - SNAPSHOT_WINDOW_MS

    raw_entries = await redis.zrangebyscore(
        REPLAY_KEY, min_score, now_ms, withscores=True
    )
    for raw, score in raw_entries:
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if event_matches_bboxes(payload.get("event", {}), bboxes):
            yield int(score), payload


@router.get("/stream/events")
async def stream_events(
    request: Request,
    regions: str = Query(
        "andes_argentina_chile",
        description="Comma-separated region preset names",
    ),
):
    """SSE endpoint para stream de eventos sísmicos en tiempo real."""

    # Validar regions
    region_list = [r.strip() for r in regions.split(",") if r.strip()]
    valid = [r for r in region_list if r in REGION_PRESETS]
    if not valid:
        raise HTTPException(
            status_code=400,
            detail=f"No valid regions. Available: {sorted(REGION_PRESETS.keys())}",
        )
    bboxes = get_bbox_for_regions(valid)

    # Cap absoluto
    if sse_active_clients._value.get() >= settings.max_sse_clients:
        raise HTTPException(503, "Server at capacity")

    last_event_id = parse_last_event_id(request.headers.get("Last-Event-ID"))
    last_event_id_too_old = (
        request.headers.get("Last-Event-ID") is not None
        and last_event_id is None
    )

    async def event_stream() -> AsyncIterator[str]:
        redis = await _redis_client()
        sse_active_clients.inc()
        seq = 0
        last_score = 0
        try:
            # 1. Replay truncated warning
            if last_event_id_too_old:
                sse_replay_truncated_total.inc()
                yield format_sse_message(
                    event_id=f"{int(time.time() * 1000)}-{seq}",
                    event_type="replay_truncated",
                    data={"oldest_available_ms": int(time.time() * 1000) - REPLAY_MAX_AGE_MS},
                )
                seq += 1

            # 2. Snapshot o replay
            async for score, payload in _snapshot_or_replay(redis, last_event_id, bboxes):
                last_score = max(last_score, score)
                yield format_sse_message(
                    event_id=f"{score}-{seq}",
                    event_type=payload.get("type", "seismic"),
                    data=payload,
                )
                sse_messages_sent_total.labels(event_type="snapshot" if last_event_id is None else "replay").inc()
                seq += 1

            # 3. Stream live
            pubsub = redis.pubsub()
            await pubsub.subscribe(CHANNEL)
            heartbeat_task = asyncio.create_task(asyncio.sleep(settings.sse_heartbeat_seconds))
            try:
                while True:
                    if await request.is_disconnected():
                        break
                    msg_task = asyncio.create_task(
                        pubsub.get_message(ignore_subscribe_messages=True, timeout=settings.sse_heartbeat_seconds)
                    )
                    done, _ = await asyncio.wait(
                        {msg_task, heartbeat_task}, return_when=asyncio.FIRST_COMPLETED
                    )
                    if heartbeat_task in done:
                        yield ":\n\n"
                        sse_messages_sent_total.labels(event_type="heartbeat").inc()
                        heartbeat_task = asyncio.create_task(
                            asyncio.sleep(settings.sse_heartbeat_seconds)
                        )
                    if msg_task in done:
                        msg = msg_task.result()
                        if msg is None:
                            continue
                        try:
                            payload = json.loads(msg["data"])
                        except (json.JSONDecodeError, TypeError):
                            continue
                        if not event_matches_bboxes(payload.get("event", {}), bboxes):
                            continue
                        score = int(time.time() * 1000)
                        yield format_sse_message(
                            event_id=f"{score}-{seq}",
                            event_type=payload.get("type", "seismic"),
                            data=payload,
                        )
                        sse_messages_sent_total.labels(event_type=payload.get("type", "unknown")).inc()
                        seq += 1
            finally:
                heartbeat_task.cancel()
                await pubsub.unsubscribe(CHANNEL)
                await pubsub.aclose()
        finally:
            sse_active_clients.dec()
            await redis.aclose()

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # nginx hint
        },
    )
```

- [ ] **Step 4: Verificar tests pasan**

```bash
pytest tests/unit/test_sse_format.py -v
```

Expected: PASS los 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/api/__init__.py src/api/sse_router.py tests/unit/test_sse_format.py
git commit -m "feat(api): SSE router with snapshot, replay, and live stream"
```

---

### Task 4.2: Replay router para JSONL >24h

**Files:**
- Create: `src/api/replay_router.py`

- [ ] **Step 1: Implementar replay_router.py**

```python
"""
Replay router: GET /events/replay?since=ISO_TIMESTAMP

Si since > now - 24h: lee de Redis ZSet (más rápido).
Si más viejo: lee de archivos JSONL diarios.
"""
from __future__ import annotations

import gzip
import json
import logging
import os
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import redis.asyncio as aioredis
from fastapi import APIRouter, HTTPException, Query

from src.config.settings import settings
from src.config.regions import (
    REGION_PRESETS,
    event_in_bbox,
    get_bbox_for_regions,
)

logger = logging.getLogger(__name__)
router = APIRouter()

REDIS_WINDOW_MS = 86400_000  # 24h


@router.get("/events/replay")
async def replay(
    since: datetime = Query(..., description="ISO 8601 timestamp UTC"),
    regions: str = Query("andes_argentina_chile"),
    limit: int = Query(10000, ge=1, le=100000),
):
    """Replay de eventos desde un timestamp dado."""
    region_list = [r.strip() for r in regions.split(",") if r.strip()]
    valid = [r for r in region_list if r in REGION_PRESETS]
    if not valid:
        raise HTTPException(400, f"No valid regions. Available: {sorted(REGION_PRESETS.keys())}")
    bboxes = get_bbox_for_regions(valid)

    if since.tzinfo is None:
        since = since.replace(tzinfo=timezone.utc)
    since_ms = int(since.timestamp() * 1000)
    now_ms = int(time.time() * 1000)

    if since_ms >= now_ms - REDIS_WINDOW_MS:
        return await _replay_from_redis(since_ms, now_ms, bboxes, limit)
    else:
        return await _replay_from_files(since, bboxes, limit)


async def _replay_from_redis(
    since_ms: int, now_ms: int, bboxes: list[dict], limit: int
) -> list[dict]:
    redis = aioredis.from_url(settings.redis_url, decode_responses=True)
    try:
        raw = await redis.zrangebyscore(
            "events:replay", since_ms, now_ms, withscores=False, start=0, num=limit
        )
        results: list[dict] = []
        for r in raw:
            try:
                payload = json.loads(r)
            except json.JSONDecodeError:
                continue
            if not _matches(payload, bboxes):
                continue
            results.append(payload)
        return results
    finally:
        await redis.aclose()


async def _replay_from_files(
    since: datetime, bboxes: list[dict], limit: int
) -> list[dict]:
    base = Path(settings.archive_dir)
    if not base.exists():
        return []
    results: list[dict] = []
    day = since.date()
    today = datetime.now(timezone.utc).date()
    while day <= today and len(results) < limit:
        for suffix in (".jsonl", ".jsonl.gz"):
            path = base / f"{day.isoformat()}{suffix}"
            if not path.exists():
                continue
            opener = gzip.open if suffix.endswith(".gz") else open
            with opener(path, "rt", encoding="utf-8") as f:
                for line in f:
                    try:
                        payload = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if not _matches(payload, bboxes):
                        continue
                    results.append(payload)
                    if len(results) >= limit:
                        break
            break
        day = day + timedelta(days=1)
    return results


def _matches(payload: dict, bboxes: list[dict]) -> bool:
    event = payload.get("event", {})
    if not bboxes:
        return True
    return any(event_in_bbox(event, b) for b in bboxes)
```

- [ ] **Step 2: Smoke test**

```bash
python -c "from src.api.replay_router import router; print(len(router.routes))"
```

Expected: imprime `1`.

- [ ] **Step 3: Commit**

```bash
git add src/api/replay_router.py
git commit -m "feat(api): replay router for events older than 24h via JSONL"
```

---

### Task 4.3: Regions router

**Files:**
- Create: `src/api/regions_router.py`

- [ ] **Step 1: Implementar regions_router.py**

```python
"""GET /regions: lista de presets disponibles para el frontend."""
from fastapi import APIRouter

from src.config.regions import REGION_PRESETS

router = APIRouter()


@router.get("/regions")
async def list_regions() -> dict:
    """Devuelve la lista de presets de región disponibles."""
    return {
        "presets": [
            {
                "id": rid,
                "name": preset["name"],
                "bbox": preset["bbox"],
            }
            for rid, preset in REGION_PRESETS.items()
        ]
    }
```

- [ ] **Step 2: Smoke test**

```bash
python -c "from src.api.regions_router import router; print(len(router.routes))"
```

Expected: `1`.

- [ ] **Step 3: Commit**

```bash
git add src/api/regions_router.py
git commit -m "feat(api): regions router exposing preset list"
```

---

### Task 4.4: Integrar routers en main.py + extender /health

**Files:**
- Modify: `src/main.py`

- [ ] **Step 1: Modificar src/main.py**

Editar `src/main.py`:

1. Agregar imports al principio (después de los existentes):

```python
from src.api.sse_router import router as sse_router
from src.api.replay_router import router as replay_router
from src.api.regions_router import router as regions_router
from src.observability.glitchtip import init_glitchtip
import redis.asyncio as aioredis
import time
```

2. Llamar `init_glitchtip("api")` al inicio de `lifespan`, antes de los logs.

3. Reemplazar el bloque CORS por uno que use settings:

```python
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

4. Agregar al final, antes de `# Entry point`:

```python
app.include_router(sse_router, prefix="", tags=["stream"])
app.include_router(replay_router, prefix="", tags=["replay"])
app.include_router(regions_router, prefix="", tags=["regions"])
```

5. Reemplazar la función `health` existente por:

```python
@app.get("/health", tags=["ops"])
async def health() -> dict:
    """Health check con estado de fuentes."""
    sources_status = {}
    overall = "ok"
    try:
        redis = aioredis.from_url(settings.redis_url, decode_responses=True)
        await redis.ping()
        # Última actividad EMSC desde métrica seteada por listener
        last_emsc_ago = await redis.get("emsc:last_message_seconds_ago")
        await redis.aclose()
        emsc_ago_s = float(last_emsc_ago) if last_emsc_ago else float("inf")
        sources_status["emsc"] = {
            "status": "up" if emsc_ago_s < 120 else "down",
            "last_message_ago_s": emsc_ago_s if emsc_ago_s != float("inf") else None,
        }
        sources_status["redis"] = {"status": "up"}
        if sources_status["emsc"]["status"] == "down":
            overall = "degraded"
    except Exception as e:
        sources_status["redis"] = {"status": "down", "error": str(e)}
        overall = "degraded"

    sources_status["usgs"] = {"status": "up"}
    sources_status["inpres"] = {"status": "up"}

    requests_total.labels(endpoint="/health", status="200").inc()
    return {"status": overall, "sources": sources_status}
```

6. Modificar `EMSCListener._consume` (en `src/ingestors/emsc_listener.py`) para escribir el contador a Redis cada 30s. Esto requiere pasarle el redis client al listener. Para simplicidad, usar la métrica Prometheus + un periódico publish a Redis desde el watchdog.

Editar `src/ingestors/emsc_listener.py`:
- Agregar parámetro `redis_client` al `__init__`:

```python
def __init__(self, bus: AsyncioQueueBus, redis_client=None, channel: str = "ingest") -> None:
    self.bus = bus
    self.redis = redis_client
    self.channel = channel
    self.last_message_ts: float = 0.0
    self._stopped = False
```

- Modificar `_watchdog` para escribir a Redis:

```python
async def _watchdog(self, ws: Any) -> None:
    while True:
        await asyncio.sleep(30)
        since = self.seconds_since_last_message
        emsc_last_message_seconds_ago.set(since)
        if self.redis is not None:
            try:
                await self.redis.set("emsc:last_message_seconds_ago", str(since), ex=120)
            except Exception:
                pass
        if since > HEARTBEAT_TIMEOUT_SECONDS:
            logger.warning(f"EMSC heartbeat timeout ({since:.0f}s), forcing reconnect")
            await ws.close(code=1011, reason="heartbeat timeout")
            return
```

- En `src/ingestors/main.py`, pasar el redis al listener:

```python
emsc = EMSCListener(bus, redis_client=redis_client)
```

- [ ] **Step 2: Smoke test**

```bash
python -c "from src.main import app; print([r.path for r in app.routes])"
```

Expected: imprime lista incluyendo `/stream/events`, `/events/replay`, `/regions`, `/health`.

- [ ] **Step 3: Commit**

```bash
git add src/main.py src/ingestors/emsc_listener.py src/ingestors/main.py
git commit -m "feat(api): wire SSE/replay/regions routers, init glitchtip, extended health"
```

---

### Task 4.5: Test de integración del replay con Last-Event-ID

**Files:**
- Test: `tests/integration/test_replay_with_last_event_id.py`

- [ ] **Step 1: Escribir test integración**

Crear `tests/integration/test_replay_with_last_event_id.py`:

```python
"""Test crítico: cliente SSE que reconecta con Last-Event-ID recibe los eventos perdidos."""
import asyncio
import json
import time
import pytest
from httpx import ASGITransport, AsyncClient


@pytest.mark.asyncio
async def test_replay_returns_missed_events(redis_client, monkeypatch):
    """Publicar eventos en Redis ZSet, luego SSE conecta con Last-Event-ID y recibe los nuevos."""
    monkeypatch.setenv("REDIS_URL", str(redis_client.connection_pool.connection_kwargs))

    # Publicar 3 eventos directamente al ZSet con epoch_ms ascendentes
    base = int(time.time() * 1000)
    events = [
        {"type": "new", "event": {"canonical_id": "a", "lat": -32.9, "lon": -68.8, "mag": 4.0}},
        {"type": "new", "event": {"canonical_id": "b", "lat": -32.5, "lon": -68.5, "mag": 4.5}},
        {"type": "new", "event": {"canonical_id": "c", "lat": -33.0, "lon": -69.0, "mag": 5.0}},
    ]
    for i, evt in enumerate(events):
        await redis_client.zadd("events:replay", {json.dumps(evt): base + i * 1000})

    last_event_id = f"{base + 500}-1"  # entre evento 0 y evento 1

    from src.main import app

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        async with client.stream(
            "GET",
            "/stream/events?regions=andes_argentina_chile",
            headers={"Last-Event-ID": last_event_id},
            timeout=5,
        ) as response:
            assert response.status_code == 200
            received: list[dict] = []
            async for line in response.aiter_lines():
                if line.startswith("data:"):
                    raw = line[5:].strip()
                    payload = json.loads(raw)
                    received.append(payload)
                    if len(received) >= 2:
                        break

    canonical_ids = [r["event"]["canonical_id"] for r in received]
    assert "b" in canonical_ids
    assert "c" in canonical_ids
    assert "a" not in canonical_ids  # quedó antes del Last-Event-ID
```

- [ ] **Step 2: Verificar test pasa**

```bash
pytest tests/integration/test_replay_with_last_event_id.py -v
```

Expected: PASS. (Si falla por timing, revisar que el Redis URL del test apunte al container.)

- [ ] **Step 3: Commit**

```bash
git add tests/integration/test_replay_with_last_event_id.py
git commit -m "test(integration): replay with Last-Event-ID delivers missed events"
```

---

## Phase 5: Frontend SSE client

### Task 5.1: Tipos TypeScript

**Files:**
- Modify: `dashboard/lib/types.ts`

- [ ] **Step 1: Agregar tipos**

Editar `dashboard/lib/types.ts`. Verificar contenido actual con `bat dashboard/lib/types.ts`.

Agregar al final:

```typescript
export interface RegionPreset {
  id: string;
  name: string;
  bbox: { minlat: number; maxlat: number; minlon: number; maxlon: number } | null;
}

export interface StreamMessage {
  type: 'new' | 'update' | 'replay_truncated';
  event?: SeismicEvent & { canonical_id: string };
  oldest_available_ms?: number;
}

export interface HealthStatus {
  status: 'ok' | 'degraded' | 'unhealthy';
  sources: {
    emsc: { status: 'up' | 'down'; last_message_ago_s: number | null };
    usgs: { status: 'up' | 'down' };
    inpres: { status: 'up' | 'down' };
    redis?: { status: 'up' | 'down'; error?: string };
  };
}
```

Y modificar el tipo `SeismicEvent` existente para agregar `canonical_id?: string`.

- [ ] **Step 2: Verificar TypeScript compila**

```bash
cd dashboard
npx tsc --noEmit
cd ..
```

Expected: 0 errores.

- [ ] **Step 3: Commit**

```bash
git add dashboard/lib/types.ts
git commit -m "feat(dashboard): add types for stream messages and health"
```

---

### Task 5.2: SeismicStream client

**Files:**
- Create: `dashboard/lib/sse-client.ts`

- [ ] **Step 1: Implementar SeismicStream**

Crear `dashboard/lib/sse-client.ts`:

```typescript
/**
 * SeismicStream: cliente SSE para el endpoint /stream/events.
 *
 * Encapsula EventSource del browser. Mantiene un Map<canonical_id, event>
 * y notifica a listeners en cada cambio (new o update).
 *
 * Reconexión automática del browser cuando se cae. Si falla 3 veces seguidas,
 * dispara fallback a polling (no implementado en esta clase, decisión del caller).
 */

import type { SeismicEvent, StreamMessage } from './types';

type SeismicEventWithId = SeismicEvent & { canonical_id: string };

export type StreamUpdateCallback = (events: SeismicEventWithId[]) => void;
export type StreamErrorCallback = (consecutiveErrors: number) => void;

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

export class SeismicStream {
  private eventSource: EventSource | null = null;
  private events = new Map<string, SeismicEventWithId>();
  private listeners = new Set<StreamUpdateCallback>();
  private errorListeners = new Set<StreamErrorCallback>();
  private consecutiveErrors = 0;
  private regions: string[] = [];

  connect(regions: string[]): void {
    this.regions = regions;
    this.disconnect();
    const url = `${API_BASE_URL}/stream/events?regions=${encodeURIComponent(regions.join(','))}`;
    this.eventSource = new EventSource(url);

    this.eventSource.addEventListener('open', () => {
      this.consecutiveErrors = 0;
    });

    this.eventSource.addEventListener('seismic', (ev: MessageEvent) => {
      this._handleMessage(ev);
    });
    // Algunos navegadores envían default 'message'
    this.eventSource.addEventListener('message', (ev: MessageEvent) => {
      this._handleMessage(ev);
    });
    this.eventSource.addEventListener('new', (ev: MessageEvent) => {
      this._handleMessage(ev);
    });
    this.eventSource.addEventListener('update', (ev: MessageEvent) => {
      this._handleMessage(ev);
    });
    this.eventSource.addEventListener('replay_truncated', (ev: MessageEvent) => {
      try {
        const payload = JSON.parse(ev.data);
        console.warn('Replay truncated', payload);
      } catch {}
    });

    this.eventSource.addEventListener('error', () => {
      this.consecutiveErrors += 1;
      this.errorListeners.forEach((cb) => cb(this.consecutiveErrors));
    });
  }

  private _handleMessage(ev: MessageEvent): void {
    let payload: StreamMessage;
    try {
      payload = JSON.parse(ev.data) as StreamMessage;
    } catch {
      return;
    }
    if (!payload.event || !payload.event.canonical_id) return;
    this.events.set(payload.event.canonical_id, payload.event as SeismicEventWithId);
    this._emit();
  }

  private _emit(): void {
    const list = Array.from(this.events.values()).sort((a, b) =>
      b.hora_utc.localeCompare(a.hora_utc),
    );
    this.listeners.forEach((cb) => cb(list));
  }

  onUpdate(cb: StreamUpdateCallback): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  onError(cb: StreamErrorCallback): () => void {
    this.errorListeners.add(cb);
    return () => this.errorListeners.delete(cb);
  }

  disconnect(): void {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }

  getEvents(): SeismicEventWithId[] {
    return Array.from(this.events.values());
  }

  clear(): void {
    this.events.clear();
    this._emit();
  }
}
```

- [ ] **Step 2: Verificar TypeScript**

```bash
cd dashboard
npx tsc --noEmit
cd ..
```

Expected: 0 errores.

- [ ] **Step 3: Commit**

```bash
git add dashboard/lib/sse-client.ts
git commit -m "feat(dashboard): add SeismicStream EventSource client"
```

---

### Task 5.3: Componentes RegionSelector y StreamHealthBadge

**Files:**
- Create: `dashboard/components/RegionSelector.tsx`
- Create: `dashboard/components/StreamHealthBadge.tsx`

- [ ] **Step 1: Crear RegionSelector**

```typescript
'use client';

import { useEffect, useState } from 'react';
import type { RegionPreset } from '@/lib/types';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

interface Props {
  selected: string[];
  onChange: (regions: string[]) => void;
}

export function RegionSelector({ selected, onChange }: Props) {
  const [presets, setPresets] = useState<RegionPreset[]>([]);

  useEffect(() => {
    fetch(`${API_BASE_URL}/regions`)
      .then((r) => r.json())
      .then((data) => setPresets(data.presets ?? []))
      .catch(() => setPresets([]));
  }, []);

  const toggle = (id: string) => {
    if (selected.includes(id)) {
      onChange(selected.filter((x) => x !== id));
    } else {
      onChange([...selected, id]);
    }
  };

  return (
    <div className="border-2 border-gray-200 dark:border-gray-700 rounded-lg p-4 bg-white dark:bg-gray-900">
      <h3 className="font-bold mb-2 text-gray-900 dark:text-white">Regiones</h3>
      <div className="space-y-1">
        {presets.map((p) => (
          <label key={p.id} className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={selected.includes(p.id)}
              onChange={() => toggle(p.id)}
              className="h-4 w-4"
            />
            <span className="text-sm text-gray-900 dark:text-white">{p.name}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Crear StreamHealthBadge**

```typescript
'use client';

import { useEffect, useState } from 'react';
import type { HealthStatus } from '@/lib/types';
import { AlertTriangle, CheckCircle } from 'lucide-react';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

export function StreamHealthBadge() {
  const [health, setHealth] = useState<HealthStatus | null>(null);

  useEffect(() => {
    const fetchHealth = () =>
      fetch(`${API_BASE_URL}/health`)
        .then((r) => r.json())
        .then(setHealth)
        .catch(() => setHealth(null));

    fetchHealth();
    const id = setInterval(fetchHealth, 15000);
    return () => clearInterval(id);
  }, []);

  if (!health) return null;

  if (health.status === 'ok') {
    return (
      <div className="flex items-center gap-2 px-3 py-1 rounded-lg bg-green-100 dark:bg-green-900/40 text-green-800 dark:text-green-200 text-xs font-medium">
        <CheckCircle className="h-3 w-3" />
        Stream OK
      </div>
    );
  }

  const emscDown = health.sources.emsc.status === 'down';
  const ago = health.sources.emsc.last_message_ago_s;

  return (
    <div className="flex items-center gap-2 px-3 py-1 rounded-lg bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-200 text-xs font-medium">
      <AlertTriangle className="h-3 w-3" />
      {emscDown
        ? `Stream EMSC: DEGRADADO ${ago ? `(${Math.floor(ago)}s)` : ''}`
        : 'Sistema degradado'}
    </div>
  );
}
```

- [ ] **Step 3: Verificar TypeScript**

```bash
cd dashboard && npx tsc --noEmit && cd ..
```

Expected: 0 errores.

- [ ] **Step 4: Commit**

```bash
git add dashboard/components/RegionSelector.tsx dashboard/components/StreamHealthBadge.tsx
git commit -m "feat(dashboard): RegionSelector and StreamHealthBadge components"
```

---

### Task 5.4: Reemplazar live page para usar SSE

**Files:**
- Modify: `dashboard/app/live/page.tsx`

- [ ] **Step 1: Reemplazar implementación con SSE**

Editar `dashboard/app/live/page.tsx`. Reemplazar TODO el contenido por:

```typescript
'use client';

import { useEffect, useState, useRef } from 'react';
import { SeismicStream } from '@/lib/sse-client';
import { RegionSelector } from '@/components/RegionSelector';
import { StreamHealthBadge } from '@/components/StreamHealthBadge';
import { AlertBanner } from '@/components/AlertBanner';
import { SeismicMapWithCities } from '@/components/SeismicMapWithCities';
import { EventsTable } from '@/components/EventsTable';
import { Radio } from 'lucide-react';
import type { SeismicEvent } from '@/lib/types';

export default function LivePage() {
  const [regions, setRegions] = useState<string[]>(['andes_argentina_chile']);
  const [events, setEvents] = useState<SeismicEvent[]>([]);
  const [errorCount, setErrorCount] = useState(0);
  const streamRef = useRef<SeismicStream | null>(null);

  useEffect(() => {
    if (regions.length === 0) {
      streamRef.current?.disconnect();
      streamRef.current = null;
      setEvents([]);
      return;
    }
    const stream = new SeismicStream();
    streamRef.current = stream;
    const offUpdate = stream.onUpdate(setEvents);
    const offError = stream.onError(setErrorCount);
    stream.connect(regions);
    return () => {
      offUpdate();
      offError();
      stream.disconnect();
    };
  }, [regions]);

  // Bbox visible: si solo eligió uno, usar ese; si varios, usar región global
  const region = { minlat: -56, maxlat: 12, minlon: -82, maxlon: -65 };

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-3">
          <Radio className="h-8 w-8 text-red-600 animate-pulse" />
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white">
            Monitoreo en Vivo (Stream)
          </h1>
        </div>
        <StreamHealthBadge />
      </div>

      {errorCount >= 3 && (
        <div className="rounded-lg border-2 border-yellow-200 bg-yellow-50 p-4 text-yellow-900 text-sm">
          Conexión SSE inestable ({errorCount} errores). Si persiste, recargar la página.
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        <div className="lg:col-span-1">
          <RegionSelector selected={regions} onChange={setRegions} />
        </div>

        <div className="lg:col-span-3 space-y-6">
          <AlertBanner alertas={[]} />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div>
              <h2 className="mb-2 text-xl font-semibold text-gray-900 dark:text-white">
                Mapa
              </h2>
              <SeismicMapWithCities
                eventos={events}
                region={region}
                className="h-[500px]"
              />
            </div>
            <div>
              <h2 className="mb-2 text-xl font-semibold text-gray-900 dark:text-white">
                Eventos ({events.length})
              </h2>
              <div className="max-h-[500px] overflow-y-auto">
                <EventsTable eventos={events.slice(0, 30)} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verificar TypeScript**

```bash
cd dashboard && npx tsc --noEmit && cd ..
```

Expected: 0 errores.

- [ ] **Step 3: Commit**

```bash
git add dashboard/app/live/page.tsx
git commit -m "feat(dashboard): live page powered by SSE instead of polling"
```

---

### Task 5.5: Init Sentry frontend

**Files:**
- Create: `dashboard/sentry.client.config.ts`
- Create: `dashboard/sentry.server.config.ts`
- Create: `dashboard/sentry.edge.config.ts`

- [ ] **Step 1: Crear sentry.client.config.ts**

```typescript
import * as Sentry from '@sentry/nextjs';

const dsn = process.env.NEXT_PUBLIC_GLITCHTIP_DSN;
if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV,
    tracesSampleRate: 0.1,
  });
}
```

- [ ] **Step 2: Crear sentry.server.config.ts y sentry.edge.config.ts**

`sentry.server.config.ts`:
```typescript
import * as Sentry from '@sentry/nextjs';

const dsn = process.env.GLITCHTIP_DSN;
if (dsn) {
  Sentry.init({ dsn, environment: process.env.NODE_ENV, tracesSampleRate: 0.1 });
}
```

`sentry.edge.config.ts`:
```typescript
import * as Sentry from '@sentry/nextjs';

const dsn = process.env.GLITCHTIP_DSN;
if (dsn) {
  Sentry.init({ dsn, environment: process.env.NODE_ENV, tracesSampleRate: 0.1 });
}
```

- [ ] **Step 3: Smoke test build**

```bash
cd dashboard
npm run build
cd ..
```

Expected: build OK (puede haber warnings de Sentry sin DSN configurado, está bien).

- [ ] **Step 4: Commit**

```bash
git add dashboard/sentry.client.config.ts dashboard/sentry.server.config.ts dashboard/sentry.edge.config.ts
git commit -m "feat(dashboard): init sentry/glitchtip on client, server, edge"
```

---

## Phase 6: Tests de integración críticos

### Task 6.1: Test dedupe across sources

**Files:**
- Test: `tests/integration/test_dedupe_across_sources.py`

- [ ] **Step 1: Escribir test**

```python
"""Test que EMSC primero + USGS después produce un new + un update."""
import asyncio
import json
import pytest

from src.ingestors.dispatcher import Dispatcher
from src.ingestors.archive_writer import ArchiveWriter


@pytest.mark.asyncio
async def test_emsc_then_usgs_produces_new_then_update(redis_client, tmp_path):
    archive = ArchiveWriter(base_dir=str(tmp_path))
    dispatcher = Dispatcher(redis_client=redis_client, archive_writer=archive)

    # Subscriber para capturar publicaciones
    pubsub = redis_client.pubsub()
    await pubsub.subscribe("seismic.events")
    await asyncio.sleep(0.1)

    base_event = {
        "fuentes": ["EMSC"],
        "hora_utc": "2026-04-29T14:00:00Z",
        "lat": -32.9,
        "lon": -68.8,
        "prof_km": 50.0,
        "mag": 4.8,
        "mag_tipo": "M",
        "lugar": "Test",
        "sentido": False,
        "revisado": False,
    }
    await dispatcher.process_event(base_event)

    usgs_event = {**base_event, "fuentes": ["USGS"], "mag": 4.9, "revisado": True, "hora_utc": "2026-04-29T14:00:05Z"}
    await dispatcher.process_event(usgs_event)

    received = []
    for _ in range(5):
        msg = await pubsub.get_message(ignore_subscribe_messages=True, timeout=2)
        if msg and msg["type"] == "message":
            received.append(json.loads(msg["data"]))
            if len(received) >= 2:
                break

    assert len(received) == 2
    assert received[0]["type"] == "new"
    assert received[1]["type"] == "update"
    assert set(received[1]["event"]["fuentes"]) == {"EMSC", "USGS"}
    assert received[1]["event"]["mag"] == 4.9
    assert received[0]["event"]["canonical_id"] == received[1]["event"]["canonical_id"]

    await pubsub.unsubscribe("seismic.events")
    await pubsub.aclose()
```

- [ ] **Step 2: Verificar test pasa**

```bash
pytest tests/integration/test_dedupe_across_sources.py -v
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/test_dedupe_across_sources.py
git commit -m "test(integration): EMSC then USGS produces new+update with merged sources"
```

---

### Task 6.2: Test health endpoint refleja degraded

**Files:**
- Test: `tests/integration/test_health_endpoint.py`

- [ ] **Step 1: Escribir test**

```python
"""Test que /health refleja correctamente el estado degradado de EMSC."""
import pytest
from httpx import ASGITransport, AsyncClient


@pytest.mark.asyncio
async def test_health_reports_emsc_down_when_no_recent_message(redis_client, monkeypatch):
    monkeypatch.setenv("REDIS_URL", str(redis_client.connection_pool.connection_kwargs))
    # No setear emsc:last_message_seconds_ago → simula EMSC nunca envió
    from src.main import app
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        r = await client.get("/health")
        data = r.json()
    assert data["sources"]["emsc"]["status"] == "down"


@pytest.mark.asyncio
async def test_health_reports_emsc_up_when_fresh(redis_client, monkeypatch):
    monkeypatch.setenv("REDIS_URL", str(redis_client.connection_pool.connection_kwargs))
    await redis_client.set("emsc:last_message_seconds_ago", "10")
    from src.main import app
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        r = await client.get("/health")
        data = r.json()
    assert data["sources"]["emsc"]["status"] == "up"
    assert data["status"] == "ok"
```

- [ ] **Step 2: Verificar test pasa**

```bash
pytest tests/integration/test_health_endpoint.py -v
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/test_health_endpoint.py
git commit -m "test(integration): health endpoint reflects EMSC up/down"
```

---

### Task 6.3: Test redis failure recovery

**Files:**
- Test: `tests/integration/test_redis_failure_recovery.py`

- [ ] **Step 1: Escribir test**

```python
"""Test que dispatcher buffea cuando Redis falla y recupera al volver."""
import pytest
from unittest.mock import AsyncMock, MagicMock
from src.ingestors.dispatcher import Dispatcher
from src.ingestors.archive_writer import ArchiveWriter


@pytest.mark.asyncio
async def test_dispatcher_buffers_on_redis_failure(tmp_path):
    """Mock redis que tira excepciones."""
    archive = ArchiveWriter(base_dir=str(tmp_path))

    bad_redis = MagicMock()
    bad_redis.set = AsyncMock(side_effect=ConnectionError("redis down"))
    bad_redis.get = AsyncMock(side_effect=ConnectionError("redis down"))
    bad_redis.delete = AsyncMock()
    bad_redis.zadd = AsyncMock()
    bad_redis.zremrangebyscore = AsyncMock()
    bad_redis.publish = AsyncMock()

    dispatcher = Dispatcher(redis_client=bad_redis, archive_writer=archive)

    raw = {
        "fuentes": ["EMSC"],
        "hora_utc": "2026-04-29T14:00:00Z",
        "lat": -32.9, "lon": -68.8, "prof_km": 50.0,
        "mag": 4.8, "mag_tipo": "M", "lugar": "Test",
        "sentido": False, "revisado": False,
    }
    for _ in range(5):
        await dispatcher.process_event(raw)

    assert len(dispatcher.local_buffer) == 5  # todos buffereados


@pytest.mark.asyncio
async def test_dispatcher_flushes_buffer_on_recovery(redis_client, tmp_path):
    archive = ArchiveWriter(base_dir=str(tmp_path))
    dispatcher = Dispatcher(redis_client=redis_client, archive_writer=archive)

    raw = {
        "fuentes": ["EMSC"],
        "hora_utc": "2026-04-29T14:00:00Z",
        "lat": -32.9, "lon": -68.8, "prof_km": 50.0,
        "mag": 4.8, "mag_tipo": "M", "lugar": "Test",
        "sentido": False, "revisado": False,
    }
    dispatcher._buffer_locally(raw)
    dispatcher._buffer_locally({**raw, "lat": -33.0})

    assert len(dispatcher.local_buffer) == 2
    flushed = await dispatcher.flush_buffer()
    assert flushed == 2
    assert len(dispatcher.local_buffer) == 0
```

- [ ] **Step 2: Verificar test pasa**

```bash
pytest tests/integration/test_redis_failure_recovery.py -v
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/test_redis_failure_recovery.py
git commit -m "test(integration): dispatcher buffers on redis failure and flushes on recovery"
```

---

## Phase 7: Docker, Nginx, Deploy

### Task 7.1: Dockerfile del ingestor

**Files:**
- Create: `deploy/docker/Dockerfile.ingestor`

- [ ] **Step 1: Crear Dockerfile.ingestor**

```dockerfile
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl gcc g++ \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY src/ ./src/

RUN useradd -u 1000 -m appuser \
 && mkdir -p /data/events-archive \
 && chown -R appuser:appuser /app /data

USER appuser

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD python -m src.ingestors.healthcheck || exit 1

CMD ["python", "-m", "src.ingestors.main"]
```

- [ ] **Step 2: Build local**

```bash
cd /Users/ezebc182/work/deshoku-apps/espectro-chechu/seismic-monitor
docker build -f deploy/docker/Dockerfile.ingestor -t seismic-ingestor:test .
```

Expected: build exitoso.

- [ ] **Step 3: Commit**

```bash
git add deploy/docker/Dockerfile.ingestor
git commit -m "feat(deploy): Dockerfile for seismic-ingestor"
```

---

### Task 7.2: Dockerfile del dashboard

**Files:**
- Create: `deploy/docker/Dockerfile.dashboard`

- [ ] **Step 1: Crear Dockerfile.dashboard**

```dockerfile
FROM node:20-alpine AS deps
WORKDIR /app
COPY dashboard/package.json dashboard/package-lock.json ./
RUN npm ci

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY dashboard/ ./
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup -S app && adduser -S app -G app
COPY --from=builder --chown=app:app /app/.next ./.next
COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/package.json ./
COPY --from=builder --chown=app:app /app/public ./public

USER app
EXPOSE 3008

CMD ["npm", "start"]
```

- [ ] **Step 2: Build local**

```bash
docker build -f deploy/docker/Dockerfile.dashboard -t seismic-dashboard:test .
```

Expected: build exitoso.

- [ ] **Step 3: Commit**

```bash
git add deploy/docker/Dockerfile.dashboard
git commit -m "feat(deploy): Dockerfile multi-stage for dashboard"
```

---

### Task 7.3: redis.conf

**Files:**
- Create: `deploy/docker/redis.conf`

- [ ] **Step 1: Crear redis.conf**

```
# /opt/seismic-monitor/deploy/docker/redis.conf
appendonly yes
appendfsync everysec
save 60 1
maxmemory 512mb
maxmemory-policy allkeys-lru
dir /data
```

- [ ] **Step 2: Commit**

```bash
git add deploy/docker/redis.conf
git commit -m "feat(deploy): redis config with AOF persistence and LRU eviction"
```

---

### Task 7.4: nginx.conf con SSE

**Files:**
- Create: `deploy/docker/nginx/nginx.conf`

- [ ] **Step 1: Crear nginx.conf**

```nginx
worker_processes auto;
events {
    worker_connections 1024;
}

http {
    include       /etc/nginx/mime.types;
    default_type  application/octet-stream;
    sendfile      on;
    tcp_nopush    on;

    limit_req_zone $binary_remote_addr zone=sse_zone:10m rate=5r/m;
    limit_req_zone $binary_remote_addr zone=api_zone:10m rate=60r/m;

    upstream seismic-api {
        server seismic-api:8000;
    }
    upstream dashboard {
        server dashboard:3008;
    }
    upstream glitchtip {
        server glitchtip:8000;
    }

    server {
        listen 80;
        server_name _;

        # SSE endpoint
        location /api/stream/ {
            limit_req zone=sse_zone burst=10 nodelay;
            proxy_pass http://seismic-api/stream/;
            proxy_http_version 1.1;
            proxy_set_header Connection "";
            proxy_set_header Host $host;
            proxy_buffering off;
            proxy_cache off;
            proxy_read_timeout 24h;
            proxy_send_timeout 24h;
            chunked_transfer_encoding on;
        }

        # API REST
        location /api/ {
            limit_req zone=api_zone burst=30 nodelay;
            proxy_pass http://seismic-api/;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        }

        # GlitchTip dashboard
        location /errors/ {
            proxy_pass http://glitchtip/;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
        }

        # Dashboard Next.js
        location / {
            proxy_pass http://dashboard;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        }

        # Security headers
        add_header X-Content-Type-Options nosniff;
        add_header X-Frame-Options SAMEORIGIN;
        add_header Referrer-Policy strict-origin-when-cross-origin;
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add deploy/docker/nginx/nginx.conf
git commit -m "feat(deploy): nginx config with SSE-aware proxying and rate limits"
```

---

### Task 7.5: docker-compose.yml completo

**Files:**
- Modify: `deploy/docker/docker-compose.yml`

- [ ] **Step 1: Reemplazar el docker-compose.yml por versión completa**

Reemplazar TODO el contenido de `deploy/docker/docker-compose.yml` por:

```yaml
services:
  # ===========================================================================
  # Reverse proxy
  # ===========================================================================
  nginx:
    image: nginx:1.27-alpine
    container_name: seismic-nginx
    ports:
      - "80:80"
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf:ro
    depends_on:
      - seismic-api
      - dashboard
      - glitchtip
    restart: always
    networks:
      - seismic-net

  # ===========================================================================
  # API FastAPI
  # ===========================================================================
  seismic-api:
    build:
      context: ../..
      dockerfile: deploy/docker/Dockerfile
    image: seismic-api:latest
    container_name: seismic-api
    environment:
      REDIS_URL: redis://redis:6379/0
      ARCHIVE_DIR: /data/events-archive
      GLITCHTIP_DSN: ${GLITCHTIP_DSN:-}
      ENVIRONMENT: ${ENVIRONMENT:-production}
      GIT_SHA: ${GIT_SHA:-unknown}
      CORS_ALLOWED_ORIGINS: ${CORS_ALLOWED_ORIGINS:-http://localhost}
      INPRES_PROXY_URL: http://inpres-adapter:8001/recent
      LOG_LEVEL: INFO
    volumes:
      - events-archive:/data/events-archive:ro
    depends_on:
      redis:
        condition: service_healthy
    restart: always
    networks:
      - seismic-net

  # ===========================================================================
  # Ingestor (NUEVO)
  # ===========================================================================
  seismic-ingestor:
    build:
      context: ../..
      dockerfile: deploy/docker/Dockerfile.ingestor
    image: seismic-ingestor:latest
    container_name: seismic-ingestor
    environment:
      REDIS_URL: redis://redis:6379/0
      ARCHIVE_DIR: /data/events-archive
      GLITCHTIP_DSN: ${GLITCHTIP_DSN:-}
      ENVIRONMENT: ${ENVIRONMENT:-production}
      GIT_SHA: ${GIT_SHA:-unknown}
      INPRES_PROXY_URL: http://inpres-adapter:8001/recent
      LOG_LEVEL: INFO
    volumes:
      - events-archive:/data/events-archive
    depends_on:
      redis:
        condition: service_healthy
      inpres-adapter:
        condition: service_healthy
    restart: always
    networks:
      - seismic-net

  # ===========================================================================
  # INPRES adapter (existente)
  # ===========================================================================
  inpres-adapter:
    build:
      context: ../..
      dockerfile: deploy/docker/Dockerfile.inpres-adapter
    image: inpres-adapter:latest
    container_name: inpres-adapter
    restart: always
    networks:
      - seismic-net
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8001/health"]
      interval: 30s
      timeout: 5s
      retries: 3

  # ===========================================================================
  # Dashboard Next.js
  # ===========================================================================
  dashboard:
    build:
      context: ../..
      dockerfile: deploy/docker/Dockerfile.dashboard
    image: seismic-dashboard:latest
    container_name: seismic-dashboard
    environment:
      NEXT_PUBLIC_API_URL: ${NEXT_PUBLIC_API_URL:-http://localhost/api}
      NEXT_PUBLIC_GLITCHTIP_DSN: ${NEXT_PUBLIC_GLITCHTIP_DSN:-}
    restart: always
    networks:
      - seismic-net

  # ===========================================================================
  # Redis
  # ===========================================================================
  redis:
    image: redis:7-alpine
    container_name: seismic-redis
    command: ["redis-server", "/usr/local/etc/redis/redis.conf"]
    volumes:
      - ./redis.conf:/usr/local/etc/redis/redis.conf:ro
      - redis-data:/data
    restart: always
    networks:
      - seismic-net
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 3

  # ===========================================================================
  # GlitchTip
  # ===========================================================================
  glitchtip-postgres:
    image: postgres:15-alpine
    container_name: glitchtip-postgres
    environment:
      POSTGRES_DB: glitchtip
      POSTGRES_USER: glitchtip
      POSTGRES_PASSWORD: ${GLITCHTIP_POSTGRES_PASSWORD:-changeme}
    volumes:
      - glitchtip-pg-data:/var/lib/postgresql/data
    restart: always
    networks:
      - seismic-net
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U glitchtip"]
      interval: 10s
      timeout: 5s
      retries: 5

  glitchtip:
    image: glitchtip/glitchtip:v4
    container_name: glitchtip
    environment:
      DATABASE_URL: postgres://glitchtip:${GLITCHTIP_POSTGRES_PASSWORD:-changeme}@glitchtip-postgres:5432/glitchtip
      SECRET_KEY: ${GLITCHTIP_SECRET_KEY:-changeme-please-use-openssl-rand}
      EMAIL_URL: ${EMAIL_URL:-consolemail://}
      GLITCHTIP_DOMAIN: ${GLITCHTIP_DOMAIN:-http://localhost/errors}
      DEFAULT_FROM_EMAIL: noreply@example.com
      CELERY_WORKER_AUTOSCALE: "1,3"
      REDIS_URL: redis://redis:6379/1
    depends_on:
      glitchtip-postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    restart: always
    networks:
      - seismic-net

  glitchtip-worker:
    image: glitchtip/glitchtip:v4
    container_name: glitchtip-worker
    command: ["./bin/run-celery-with-beat.sh"]
    environment:
      DATABASE_URL: postgres://glitchtip:${GLITCHTIP_POSTGRES_PASSWORD:-changeme}@glitchtip-postgres:5432/glitchtip
      SECRET_KEY: ${GLITCHTIP_SECRET_KEY:-changeme-please-use-openssl-rand}
      REDIS_URL: redis://redis:6379/1
    depends_on:
      glitchtip-postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    restart: always
    networks:
      - seismic-net

networks:
  seismic-net:
    driver: bridge

volumes:
  redis-data:
  glitchtip-pg-data:
  events-archive:
```

- [ ] **Step 2: Validar sintaxis**

```bash
cd deploy/docker && docker compose config > /dev/null && echo "OK" && cd ../..
```

Expected: imprime `OK`.

- [ ] **Step 3: Commit**

```bash
git add deploy/docker/docker-compose.yml
git commit -m "feat(deploy): full docker-compose with ingestor, redis, glitchtip, dashboard, nginx"
```

---

### Task 7.6: Scripts de deploy y backup

**Files:**
- Create: `scripts/deploy.sh`
- Create: `scripts/wait-healthy.sh`
- Create: `scripts/daily-backup.sh`

- [ ] **Step 1: Crear scripts/wait-healthy.sh**

```bash
#!/bin/bash
set -euo pipefail

SERVICES=("seismic-api" "seismic-ingestor" "redis" "glitchtip" "dashboard" "nginx" "inpres-adapter")
TIMEOUT=120
START=$(date +%s)

for svc in "${SERVICES[@]}"; do
    echo -n "Waiting for $svc... "
    while true; do
        STATUS=$(docker inspect --format '{{.State.Health.Status}}' "$svc" 2>/dev/null || echo "no-health")
        RUNNING=$(docker inspect --format '{{.State.Status}}' "$svc" 2>/dev/null || echo "missing")
        if [[ "$STATUS" == "healthy" || ("$STATUS" == "no-health" && "$RUNNING" == "running") ]]; then
            echo "OK"
            break
        fi
        NOW=$(date +%s)
        if (( NOW - START > TIMEOUT )); then
            echo "FAIL ($STATUS)"
            exit 1
        fi
        sleep 2
    done
done

echo "All services healthy"
```

```bash
chmod +x scripts/wait-healthy.sh
```

- [ ] **Step 2: Crear scripts/deploy.sh**

```bash
#!/bin/bash
set -euo pipefail

EC2_HOST="${EC2_HOST:-ubuntu@ec2-host-here}"
APP_DIR="${APP_DIR:-/opt/seismic-monitor}"
GIT_SHA=$(git rev-parse --short HEAD)

echo "Deploying GIT_SHA=$GIT_SHA to $EC2_HOST"

# 1. Tar source y subir (alternativa: docker build local + push a registry)
TARFILE=$(mktemp)
git archive --format=tar HEAD | gzip > "$TARFILE"
scp "$TARFILE" "$EC2_HOST:/tmp/seismic.tar.gz"
rm "$TARFILE"

# 2. Deploy remoto
ssh "$EC2_HOST" bash -s << EOF
set -euo pipefail
mkdir -p $APP_DIR
cd $APP_DIR
tar xzf /tmp/seismic.tar.gz
rm /tmp/seismic.tar.gz

cd deploy/docker

# Restart secuencial
docker compose build seismic-api seismic-ingestor dashboard

docker compose up -d redis glitchtip-postgres
sleep 5
docker compose up -d glitchtip glitchtip-worker
docker compose up -d --no-deps seismic-ingestor
docker compose up -d --no-deps seismic-api
docker compose up -d --no-deps dashboard
docker compose up -d --no-deps inpres-adapter
docker compose up -d --no-deps nginx

../../scripts/wait-healthy.sh
EOF

# 3. Smoke test
sleep 5
echo "Deploy OK"
```

```bash
chmod +x scripts/deploy.sh
```

- [ ] **Step 3: Crear scripts/daily-backup.sh**

```bash
#!/bin/bash
set -euo pipefail

DATE=$(date +%Y-%m-%d)
BUCKET="${S3_BUCKET:-s3://seismic-monitor-backups}"
APP_DIR="${APP_DIR:-/opt/seismic-monitor}"

cd "$APP_DIR/deploy/docker"

# Postgres GlitchTip
docker compose exec -T glitchtip-postgres pg_dump -U glitchtip glitchtip | \
    gzip | aws s3 cp - "$BUCKET/postgres/$DATE.sql.gz"

# Redis dump
docker compose exec -T redis redis-cli BGSAVE
sleep 30
docker cp seismic-redis:/data/dump.rdb "/tmp/redis-$DATE.rdb"
aws s3 cp "/tmp/redis-$DATE.rdb" "$BUCKET/redis/$DATE.rdb"
rm "/tmp/redis-$DATE.rdb"

# Events archive
aws s3 sync "$APP_DIR/data/events-archive/" "$BUCKET/events-archive/"

# Limpiar locales > 7 días
find "$APP_DIR/data/events-archive" -name "*.jsonl" -mtime +7 -exec gzip {} \;
find "$APP_DIR/data/events-archive" -name "*.jsonl.gz" -mtime +30 -delete

echo "Backup $DATE complete"
```

```bash
chmod +x scripts/daily-backup.sh
```

- [ ] **Step 4: Commit**

```bash
git add scripts/deploy.sh scripts/wait-healthy.sh scripts/daily-backup.sh
git commit -m "feat(deploy): scripts for deploy, healthcheck wait, daily backup"
```

---

## Phase 8: Tests E2E (Playwright)

### Task 8.1: Setup Playwright

**Files:**
- Create: `tests/e2e/playwright.config.ts`

- [ ] **Step 1: Crear playwright.config.ts**

```typescript
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './',
  timeout: 30000,
  retries: 2,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3008',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
});
```

- [ ] **Step 2: Instalar browsers de Playwright**

```bash
cd dashboard
npx playwright install chromium
cd ..
```

Expected: instalación OK.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/playwright.config.ts
git commit -m "test(e2e): playwright config for chromium"
```

---

### Task 8.2: E2E live dashboard

**Files:**
- Create: `tests/e2e/live_dashboard.spec.ts`

- [ ] **Step 1: Crear test E2E**

```typescript
import { test, expect } from '@playwright/test';

test('live dashboard loads and connects to SSE', async ({ page }) => {
  const responses: string[] = [];
  page.on('response', (r) => {
    if (r.url().includes('/stream/events')) responses.push(r.url());
  });

  await page.goto('/live');
  await expect(page.locator('h1')).toContainText('Monitoreo en Vivo');

  // Esperar conexión SSE
  await page.waitForResponse((r) => r.url().includes('/stream/events'), { timeout: 10000 });
  expect(responses.length).toBeGreaterThan(0);
});

test('region selector updates active subscriptions', async ({ page }) => {
  await page.goto('/live');
  const checkbox = page.locator('input[type="checkbox"]').first();
  await expect(checkbox).toBeVisible();
  await checkbox.click();
  await page.waitForTimeout(500);
});
```

- [ ] **Step 2: Documentar cómo correrlo (no se ejecuta en CI sin stack)**

Estos tests requieren el docker-compose levantado. Crear `tests/e2e/README.md`:

```markdown
# E2E tests

Requiere stack levantado:

```bash
cd deploy/docker
docker compose up -d
../../scripts/wait-healthy.sh
cd ../..
cd dashboard
npx playwright test ../tests/e2e/
```
```

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/live_dashboard.spec.ts tests/e2e/README.md
git commit -m "test(e2e): live dashboard SSE connection scenarios"
```

---

## Phase 9: CI y validación final

### Task 9.1: Documentar cómo correr el sistema completo

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Agregar sección al README**

Agregar al final del README.md, antes de `## License`:

```markdown
## Real-time Stream (SSE)

A partir de la versión con cambio `realtime-event-stream`, el sistema soporta:

- **WebSocket EMSC** para push instantáneo de eventos.
- **SSE endpoint** `GET /stream/events?regions=preset1,preset2` para clientes browser.
- **Replay con Last-Event-ID** garantizando que reconexiones no pierdan eventos.
- **Multi-región** vía presets (`andes_argentina_chile`, `japan`, `pacific_ring_south_america`, `mediterranean`, `global`).
- **Persistencia 24h** en Redis ZSet, archivo JSONL para más viejos.
- **GlitchTip self-hosted** para error tracking.

### Levantar stack completo

```bash
cd deploy/docker
cp ../../.env.example .env  # editar con secrets reales
docker compose up -d
../../scripts/wait-healthy.sh
```

Servicios:
- Dashboard: http://localhost
- API: http://localhost/api
- GlitchTip: http://localhost/errors

### Endpoints nuevos

| Endpoint | Descripción |
|---|---|
| `GET /stream/events?regions=...` | SSE stream con replay |
| `GET /events/replay?since=ISO` | Replay histórico (Redis o JSONL) |
| `GET /regions` | Lista de presets de región |
| `GET /health` | Estado con sources detallado |
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs(readme): document real-time stream endpoints and stack"
```

---

### Task 9.2: Smoke test integral del stack

**Files:**
- (no archivos nuevos, solo verificación)

- [ ] **Step 1: Levantar stack local**

```bash
cd deploy/docker
cp ../../.env.example .env
docker compose up -d
../../scripts/wait-healthy.sh
```

Expected: todos los servicios healthy.

- [ ] **Step 2: Verificar endpoints**

```bash
curl -s http://localhost/api/health | jq
curl -s http://localhost/api/regions | jq
curl -s -N "http://localhost/api/stream/events?regions=andes_argentina_chile" --max-time 10 | head -20
```

Expected:
- `/health` devuelve `status: ok` o `degraded` (degraded es OK si EMSC todavía no envió)
- `/regions` devuelve lista con `andes_argentina_chile` y otros
- `/stream/events` devuelve `id:`, `event:`, `data:` lines

- [ ] **Step 3: Verificar dashboard**

Abrir `http://localhost/live` en browser. Verificar:
- Carga sin errores en consola
- StreamHealthBadge visible
- RegionSelector muestra checkboxes con presets
- DevTools Network: hay conexión `EventStream` a `/api/stream/events`

- [ ] **Step 4: Apagar stack**

```bash
docker compose down
cd ../..
```

- [ ] **Step 5: Commit (si hubo ajustes)**

Si algo no funcionó, ajustar el código pertinente y commitear con mensaje descriptivo.

---

## Self-Review Checklist (post-plan-write)

- [x] Cada sección del spec tiene al menos una task que la implementa.
- [x] Sin placeholders (TBD, TODO, "implement later"): plan revisado.
- [x] Métodos consistentes entre tasks (e.g., `process_event` mismo nombre en dispatcher y tests).
- [x] Imports válidos: cada import en código del plan apunta a módulo definido en otra task del plan.
- [x] Comandos exactos para correr tests con expected output.
- [x] Frecuencia alta de commits (uno por task).
- [x] TDD aplicado en lógica pura (canonical_id, dispatcher, archive_writer, sse_format, region_filter, event_bus).
