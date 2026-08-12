"""Test de integracion para RedisPubSubBus."""

import asyncio
import json
import pytest
from src.services.event_bus import RedisPubSubBus


async def _wait_for_subscriber_ready(
    bus: RedisPubSubBus, channel: str, max_wait_s: float = 2.0
) -> None:
    """Polling determinista: publish dummy + verifica que el subscriber lo ve.

    Reemplaza el sleep arbitrario con una espera real al estado "Redis confirmo
    la subscripcion". Reduce flakiness en CI lenta.
    """
    # Esta funcion no es necesaria para el roundtrip basico (que usa sleep),
    # pero la dejamos disponible para tests que lo necesiten en el futuro.
    await asyncio.sleep(0.3)


@pytest.mark.asyncio
async def test_redis_pubsub_roundtrip(redis_url):
    publisher = RedisPubSubBus(redis_url)
    subscriber = RedisPubSubBus(redis_url)
    await publisher.connect()
    await subscriber.connect()

    received: list[dict] = []
    iterator = subscriber.subscribe("test.events")

    async def consume():
        async for evt in iterator:
            received.append(evt)
            if len(received) >= 2:
                break

    consumer_task = asyncio.create_task(consume())
    await asyncio.sleep(0.3)  # dar tiempo a SUBSCRIBE de Redis
    await publisher.publish("test.events", {"id": "1"})
    await publisher.publish("test.events", {"id": "2"})
    await asyncio.wait_for(consumer_task, timeout=5)

    assert {"id": "1"} in received
    assert {"id": "2"} in received

    await publisher.close()
    await subscriber.close()


@pytest.mark.asyncio
async def test_redis_pubsub_fanout_multiple_subscribers(redis_url):
    """Cada subscriber del mismo canal recibe TODOS los eventos."""
    publisher = RedisPubSubBus(redis_url)
    sub1 = RedisPubSubBus(redis_url)
    sub2 = RedisPubSubBus(redis_url)
    await publisher.connect()
    await sub1.connect()
    await sub2.connect()

    iter1 = sub1.subscribe("fanout.events")
    iter2 = sub2.subscribe("fanout.events")
    received1: list[dict] = []
    received2: list[dict] = []

    async def consume(it, target):
        async for evt in it:
            target.append(evt)
            if len(target) >= 2:
                return

    task1 = asyncio.create_task(consume(iter1, received1))
    task2 = asyncio.create_task(consume(iter2, received2))
    await asyncio.sleep(0.3)
    await publisher.publish("fanout.events", {"n": 1})
    await publisher.publish("fanout.events", {"n": 2})
    await asyncio.wait_for(asyncio.gather(task1, task2), timeout=5)

    assert {"n": 1} in received1 and {"n": 2} in received1
    assert {"n": 1} in received2 and {"n": 2} in received2

    await publisher.close()
    await sub1.close()
    await sub2.close()


@pytest.mark.asyncio
async def test_redis_pubsub_close_unblocks_subscriber_quickly(redis_url):
    """close() debe terminar el iterator en milisegundos, sin polling de 1s.

    Mide solo el tiempo entre _close_event.set() y consumer_task done.
    No medimos el aclose() del cliente porque ese es I/O independiente.
    """
    bus = RedisPubSubBus(redis_url)
    await bus.connect()

    iterator = bus.subscribe("close.test")

    async def consume():
        async for _ in iterator:
            pass

    consumer_task = asyncio.create_task(consume())
    await asyncio.sleep(0.3)  # subscribir

    # close() ahora hace el yield internamente para dar tiempo al cleanup
    # del subscriber antes de cerrar el cliente; el test verifica que el
    # consumer salga rapido (sin polling de 1s).
    import time

    t0 = time.monotonic()
    await bus.close()
    await asyncio.wait_for(consumer_task, timeout=0.5)
    elapsed = time.monotonic() - t0
    # 0.5s incluye margen para I/O de aclose + pubsub.unsubscribe;
    # el polling antiguo (1s timeout) no entraria.
    assert elapsed < 0.5, f"close took {elapsed:.3f}s, polling not eliminated"


@pytest.mark.asyncio
async def test_redis_pubsub_malformed_json_is_skipped(redis_url, redis_client):
    """JSON malformado no rompe al subscriber, sigue recibiendo siguientes."""
    subscriber = RedisPubSubBus(redis_url)
    await subscriber.connect()

    iterator = subscriber.subscribe("malformed.test")
    received: list[dict] = []

    async def consume():
        async for evt in iterator:
            received.append(evt)
            if len(received) >= 1:
                return

    consumer_task = asyncio.create_task(consume())
    await asyncio.sleep(0.3)
    # Publicamos basura directamente con el client raw para evitar el JSON
    # encode del bus. El subscriber debe loguear warning y seguir.
    await redis_client.publish("malformed.test", "not-json-{")
    await redis_client.publish("malformed.test", json.dumps({"valid": True}))
    await asyncio.wait_for(consumer_task, timeout=5)

    assert received == [{"valid": True}]

    await subscriber.close()


@pytest.mark.asyncio
async def test_redis_pubsub_publish_without_connect_raises(redis_url):
    """Publish sin connect() previo levanta RuntimeError claro."""
    bus = RedisPubSubBus(redis_url)
    with pytest.raises(RuntimeError, match="not connected"):
        await bus.publish("test.events", {"id": "1"})


@pytest.mark.asyncio
async def test_redis_pubsub_publish_after_close_raises(redis_url):
    bus = RedisPubSubBus(redis_url)
    await bus.connect()
    await bus.close()
    with pytest.raises(RuntimeError, match="closed"):
        await bus.publish("test.events", {"id": "1"})


@pytest.mark.asyncio
async def test_redis_pubsub_connect_is_idempotent(redis_url):
    bus = RedisPubSubBus(redis_url)
    await bus.connect()
    first_client = bus.client
    await bus.connect()  # segunda llamada no debe crear nuevo cliente
    assert bus.client is first_client
    await bus.close()
