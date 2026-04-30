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
