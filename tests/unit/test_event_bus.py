"""Tests para EventBus implementations."""
import asyncio
import pytest
from src.services.event_bus import AsyncioQueueBus


async def _ready_subscribe(bus: AsyncioQueueBus, channel: str):
    """Devuelve (iterator, ready_event). El ready se setea cuando el
    subscriber esta efectivamente registrado en el bus, eliminando el
    sleep flaky tipico para esperar al subscriber.

    Como subscribe() es sync (registra inmediatamente y devuelve iterator),
    solo wrappeamos el iterator y senalamos ready apenas hayamos llamado.
    """
    iterator = bus.subscribe(channel)
    ready = asyncio.Event()
    ready.set()
    return iterator, ready


@pytest.mark.asyncio
async def test_publish_and_subscribe_roundtrip():
    bus = AsyncioQueueBus()
    iterator = bus.subscribe("ingest")  # registra antes de publish
    received: list[dict] = []

    async def consumer():
        async for event in iterator:
            received.append(event)
            if len(received) >= 2:
                break

    consumer_task = asyncio.create_task(consumer())
    await bus.publish("ingest", {"id": "1"})
    await bus.publish("ingest", {"id": "2"})
    await asyncio.wait_for(consumer_task, timeout=2)

    assert received == [{"id": "1"}, {"id": "2"}]
    await bus.close()


@pytest.mark.asyncio
async def test_subscribe_separates_channels():
    bus = AsyncioQueueBus()
    iter_a = bus.subscribe("a")
    iter_b = bus.subscribe("b")
    a_received: list[dict] = []
    b_received: list[dict] = []

    async def consume(it, target):
        async for event in it:
            target.append(event)
            return

    task_a = asyncio.create_task(consume(iter_a, a_received))
    task_b = asyncio.create_task(consume(iter_b, b_received))
    await bus.publish("a", {"x": 1})
    await bus.publish("b", {"y": 2})
    await asyncio.wait_for(asyncio.gather(task_a, task_b), timeout=2)

    assert a_received == [{"x": 1}]
    assert b_received == [{"y": 2}]
    await bus.close()


@pytest.mark.asyncio
async def test_fan_out_multiple_subscribers_same_channel():
    """Cada subscriber recibe TODOS los eventos (semantica Redis Pub/Sub)."""
    bus = AsyncioQueueBus()
    iter1 = bus.subscribe("ingest")
    iter2 = bus.subscribe("ingest")
    received1: list[dict] = []
    received2: list[dict] = []

    async def consume(it, target):
        async for event in it:
            target.append(event)
            if len(target) >= 2:
                return

    task1 = asyncio.create_task(consume(iter1, received1))
    task2 = asyncio.create_task(consume(iter2, received2))
    await bus.publish("ingest", {"id": "1"})
    await bus.publish("ingest", {"id": "2"})
    await asyncio.wait_for(asyncio.gather(task1, task2), timeout=2)

    assert received1 == [{"id": "1"}, {"id": "2"}]
    assert received2 == [{"id": "1"}, {"id": "2"}]
    await bus.close()


@pytest.mark.asyncio
async def test_publish_after_close_raises():
    bus = AsyncioQueueBus()
    await bus.close()
    with pytest.raises(RuntimeError, match="closed"):
        await bus.publish("ingest", {"id": "1"})


@pytest.mark.asyncio
async def test_subscribe_terminates_on_close_quickly():
    """Close debe desbloquear subscribers activos via sentinel.

    Sin sentinel, este test queda colgado o usa el polling de 1s.
    Con sentinel, termina en milisegundos.
    """
    bus = AsyncioQueueBus()
    iterator = bus.subscribe("ingest")
    received: list[dict] = []

    async def consumer():
        async for event in iterator:
            received.append(event)

    consumer_task = asyncio.create_task(consumer())
    await asyncio.sleep(0.01)  # ceder al consumer para entrar al loop
    await bus.close()
    # Deberia salir muy rapido (sin polling). Damos margen amplio igual.
    await asyncio.wait_for(consumer_task, timeout=0.5)


@pytest.mark.asyncio
async def test_close_is_idempotent():
    bus = AsyncioQueueBus()
    await bus.close()
    await bus.close()  # no debe romper


@pytest.mark.asyncio
async def test_subscriber_cleanup_on_iterator_aclose():
    """Cerrar el iterator (aclose) libera la queue del bus.

    Convencion: el caller es responsable de aclose() cuando termina, igual
    que el patron AsyncIterator estandar de Python. close() del bus tambien
    libera todo via sentinel.
    """
    bus = AsyncioQueueBus()
    iterator = bus.subscribe("ingest")

    received: list[dict] = []

    async def consumer():
        async for event in iterator:
            received.append(event)
            break  # rompe el loop pero NO cierra el generator todavia

    task = asyncio.create_task(consumer())
    await bus.publish("ingest", {"id": "1"})
    await asyncio.wait_for(task, timeout=1)

    # En este punto el generator quedo referenciado; lo cerramos
    # explicitamente para disparar el finally de cleanup.
    await iterator.aclose()

    assert bus._subscribers.get("ingest") in (None, [])
    await bus.close()
