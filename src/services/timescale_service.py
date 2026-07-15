"""
Persistencia de columnas de espectrograma en TimescaleDB.

Usado por seedlink_ingestor.py para no perder el historial cuando Redis
Pub/Sub no tiene subscribers (fire-and-forget) y por main.py para servir
GET /spectrograms/{channel}/history al reconectar un cliente.

Escribe en lotes (no INSERT por columna) para no saturar de writes: a
COLUMN_INTERVAL_SECONDS=4 por canal, son ~15 columnas/min/canal.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime
from typing import Any, Optional

import asyncpg

logger = logging.getLogger(__name__)

# Cuántas columnas acumular antes de flush, o cada cuántos segundos, lo que
# ocurra primero. Con 3 canales por defecto, BATCH_SIZE=10 flushea cada ~13s.
BATCH_SIZE = 10
FLUSH_INTERVAL_SECONDS = 15


class TimescaleColumnWriter:
    """Acumula columnas en memoria y las escribe a TimescaleDB en lotes."""

    def __init__(self, dsn: str) -> None:
        self._dsn = dsn
        self._pool: Optional[asyncpg.Pool] = None
        self._buffer: list[dict[str, Any]] = []
        self._lock = asyncio.Lock()
        self._flush_task: Optional[asyncio.Task] = None

    async def connect(self) -> None:
        if self._pool is not None:
            return  # idempotente
        self._pool = await asyncpg.create_pool(self._dsn, min_size=1, max_size=5)
        self._flush_task = asyncio.create_task(self._periodic_flush())

    async def add_column(self, column: dict[str, Any]) -> None:
        """No bloqueante para el hot path del ingestor: solo encola."""
        async with self._lock:
            self._buffer.append(column)
            should_flush = len(self._buffer) >= BATCH_SIZE
        if should_flush:
            await self.flush()

    async def _periodic_flush(self) -> None:
        while True:
            await asyncio.sleep(FLUSH_INTERVAL_SECONDS)
            await self.flush()

    async def flush(self) -> None:
        async with self._lock:
            if not self._buffer:
                return
            batch, self._buffer = self._buffer, []

        rows = [
            (
                col["channel"],
                datetime.fromisoformat(col["endtime"].replace("Z", "+00:00")),
                col["freqs"],
                col["power_db"],
            )
            for col in batch
        ]
        try:
            async with self._pool.acquire() as conn:
                await conn.executemany(
                    """
                    INSERT INTO spectrogram_columns (channel, endtime, freqs, power_db)
                    VALUES ($1, $2, $3, $4)
                    ON CONFLICT (channel, endtime) DO NOTHING
                    """,
                    rows,
                )
        except Exception:
            logger.warning(
                "timescale_service: fallo escribiendo lote de %d columnas", len(rows), exc_info=True
            )

    async def fetch_history(self, channel: str, minutes: int) -> list[dict[str, Any]]:
        async with self._pool.acquire() as conn:
            records = await conn.fetch(
                """
                SELECT endtime, freqs, power_db
                FROM spectrogram_columns
                WHERE channel = $1 AND endtime >= now() - ($2 || ' minutes')::interval
                ORDER BY endtime ASC
                """,
                channel,
                str(minutes),
            )
        return [
            {
                "channel": channel,
                "endtime": r["endtime"].isoformat(),
                "freqs": list(r["freqs"]),
                "power_db": list(r["power_db"]),
            }
            for r in records
        ]

    async def close(self) -> None:
        if self._flush_task is not None:
            self._flush_task.cancel()
        await self.flush()
        if self._pool is not None:
            await self._pool.close()
