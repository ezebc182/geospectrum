"""Test de integracion para RedisPubSubBus."""
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
