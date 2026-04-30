"""
EventBus: abstraccion de transporte pub/sub con semantica fan-out.

Implementaciones:
- AsyncioQueueBus: in-process, usado dentro del ingestor
- RedisPubSubBus: cross-process via Redis (se agrega en Task 1.4)

Ambas implementaciones cumplen semantica fan-out: cada subscriber del mismo
canal recibe TODOS los eventos publicados (igual que Redis Pub/Sub). Esto es
clave para que el codigo del ingestor y del SSE handler funcione identico
con cualquiera de las dos implementaciones cuando migremos a multi-proceso.

Disenado para permitir migracion futura a Redis Streams o Kafka sin cambiar
el codigo de listeners/dispatchers.
"""
from __future__ import annotations

import asyncio
from typing import Any, AsyncIterator, Protocol


# Sentinel publicado a las queues de subscribers cuando el bus se cierra,
# para desbloquear el `queue.get()` y permitir cleanup inmediato.
_CLOSE_SENTINEL: object = object()


class EventBus(Protocol):
    """Protocolo comun para todos los buses de eventos.

    Convencion: subscribe es sync y devuelve un AsyncIterator. Esto se alinea
    con como funciona Redis Pub/Sub (el listen() es sync, devuelve iterator
    async). Implementaciones que internamente usan async generator deben
    envolverlas en un metodo sync que las retorna.
    """

    async def publish(self, channel: str, event: dict[str, Any]) -> None: ...
    def subscribe(self, channel: str) -> AsyncIterator[dict[str, Any]]: ...
    async def close(self) -> None: ...


class AsyncioQueueBus:
    """Bus in-memory con fan-out: cada subscriber tiene su propia queue.

    Decisiones de diseno:
    - Una queue POR SUBSCRIBER (no por canal compartida) para que multiples
      subscribers reciban cada evento. Esto matchea la semantica de Redis
      Pub/Sub que el RedisPubSubBus expondra.
    - Bounded queues (maxsize) para aplicar backpressure cuando un subscriber
      se atrasa: publish() awaita en put() en vez de explotar memoria.
    - Cleanup de subscribers via _CLOSE_SENTINEL: close() empuja el sentinel
      a cada queue, los subscribers lo detectan y salen inmediatamente sin
      polling.

    Single-loop only. NO es thread-safe. No compartir entre threads o loops.
    """

    def __init__(self, maxsize: int = 1000) -> None:
        """maxsize: bound por subscriber. publish awaita si la queue esta llena."""
        self._subscribers: dict[str, list[asyncio.Queue[Any]]] = {}
        self._maxsize = maxsize
        self._closed = False

    async def publish(self, channel: str, event: dict[str, Any]) -> None:
        if self._closed:
            raise RuntimeError("Bus is closed")
        # Fan-out: copiar a cada subscriber del canal.
        for queue in list(self._subscribers.get(channel, [])):
            await queue.put(event)

    def subscribe(self, channel: str) -> AsyncIterator[dict[str, Any]]:
        """Sync: registra el subscriber y devuelve un AsyncIterator.

        Esto matchea la signature del Protocol (sync que devuelve AsyncIterator)
        en lugar de ser una async-generator-function (que devuelve coroutine).
        """
        queue: asyncio.Queue[Any] = asyncio.Queue(maxsize=self._maxsize)
        self._subscribers.setdefault(channel, []).append(queue)
        return self._consume(channel, queue)

    async def _consume(
        self, channel: str, queue: asyncio.Queue[Any]
    ) -> AsyncIterator[dict[str, Any]]:
        try:
            while True:
                event = await queue.get()
                if event is _CLOSE_SENTINEL:
                    return
                yield event
        finally:
            # Liberar el slot del subscriber al salir del iterator.
            subs = self._subscribers.get(channel)
            if subs and queue in subs:
                subs.remove(queue)

    async def close(self) -> None:
        """Cierra el bus desbloqueando subscribers activos via sentinel."""
        if self._closed:
            return  # idempotente
        self._closed = True
        for subs in self._subscribers.values():
            for queue in subs:
                # put_nowait porque el sentinel puede ir aunque queue este llena;
                # si esta llena igual, fallback a put async.
                try:
                    queue.put_nowait(_CLOSE_SENTINEL)
                except asyncio.QueueFull:
                    await queue.put(_CLOSE_SENTINEL)


# ===========================================================================
# RedisPubSubBus - cross-process via Redis Pub/Sub
# ===========================================================================

import json
import logging

import redis.asyncio as aioredis

logger = logging.getLogger(__name__)


class RedisPubSubBus:
    """Bus pub/sub respaldado por Redis. Usado entre procesos.

    Semantica: igual que AsyncioQueueBus, fan-out nativo (cada subscriber
    recibe todos los eventos publicados al canal).

    Es responsabilidad del caller llamar `connect()` antes de publish/subscribe.
    """

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

    async def publish(self, channel: str, event: dict[str, Any]) -> None:
        if self._closed:
            raise RuntimeError("Bus is closed")
        await self.client.publish(channel, json.dumps(event))

    def subscribe(self, channel: str) -> AsyncIterator[dict[str, Any]]:
        """Sync: devuelve AsyncIterator. Matchea signature del Protocol."""
        return self._consume(channel)

    async def _consume(self, channel: str) -> AsyncIterator[dict[str, Any]]:
        pubsub = self.client.pubsub()
        await pubsub.subscribe(channel)
        try:
            while not self._closed:
                msg = await pubsub.get_message(
                    ignore_subscribe_messages=True, timeout=1.0
                )
                if msg is None:
                    continue
                if msg.get("type") != "message":
                    continue
                try:
                    yield json.loads(msg["data"])
                except json.JSONDecodeError as e:
                    logger.warning(f"Bad JSON in pubsub: {e}")
        finally:
            await pubsub.unsubscribe(channel)
            await pubsub.aclose()

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._client is not None:
            await self._client.aclose()
