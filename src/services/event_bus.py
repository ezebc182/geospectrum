"""
EventBus: abstraccion de transporte pub/sub.

Implementaciones:
- AsyncioQueueBus: in-process queue, usado dentro del ingestor
- RedisPubSubBus: cross-process via Redis (se agrega en Task 1.4)

Disenado para permitir migracion futura a Redis Streams o Kafka sin
cambiar el codigo de listeners/dispatchers.
"""
from __future__ import annotations

import asyncio
from typing import AsyncIterator, Protocol


class EventBus(Protocol):
    """Protocolo comun para todos los buses de eventos."""

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
