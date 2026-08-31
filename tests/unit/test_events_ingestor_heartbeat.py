"""
Tests del heartbeat de `events_ingestor.py` (watchdog-servicios-railway, Fase 4).

El test que importa de verdad acá es
`test_heartbeat_con_excepcion_en_redis_no_tumba_el_gather`: protege contra
repetir el incidente ya vivido en este proyecto ("el ingestor salía con exit
0" — un hilo daemon sin try/except que moría en silencio). El heartbeat es
una corrutina más dentro del mismo `asyncio.gather()` que EMSC/USGS: si
propagara una excepción que no sea `asyncio.CancelledError`, `gather()` sin
`return_exceptions=True` cancelaría las otras dos y tumbaría la ingesta real
por un simple fallo de Redis — exactamente lo que este change prohíbe.

Se testea `_heartbeat_loop` en aislamiento (sin depender de EMSC/USGS reales)
y también corriendo dentro de un `gather()` real con corrutinas mock que
"viven" indefinidamente, para probar la interacción real de asyncio y no solo
la lógica interna del método.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from unittest.mock import AsyncMock

import pytest

from src.services.events_ingestor import EventsIngestor


class StubRedis:
    """Cliente Redis mínimo: solo lo que _heartbeat_loop necesita de él."""

    def __init__(self, fail_times: int = 0) -> None:
        self.calls: list[tuple[str, str, int]] = []
        self._fail_times = fail_times
        self._call_count = 0

    async def set(self, key: str, value: str, ex: int) -> None:
        self._call_count += 1
        if self._call_count <= self._fail_times:
            raise ConnectionError("Redis caído (simulado)")
        self.calls.append((key, value, ex))


class ForeverRunning:
    """Corrutina que nunca vuelve por su cuenta — simula EMSC/USGS vivos."""

    def __init__(self) -> None:
        self.cancelled = False

    async def run(self) -> None:
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            self.cancelled = True
            raise


def build_ingestor(redis_client) -> EventsIngestor:
    bus = AsyncMock()
    store = AsyncMock()
    return EventsIngestor(bus, store, redis_client=redis_client)


@pytest.mark.asyncio
class TestHeartbeatLoopEscritura:
    async def test_heartbeat_loop_escribe_key_con_ttl(self):
        redis_client = StubRedis()
        ingestor = build_ingestor(redis_client)

        task = asyncio.create_task(
            ingestor._heartbeat_loop(interval_s=0.01, ttl_s=42)
        )
        await asyncio.sleep(0.05)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

        assert len(redis_client.calls) >= 1
        key, value, ex = redis_client.calls[0]
        assert key == "events_ingestor:heartbeat"
        assert ex == 42
        # El valor debe ser un ISO8601 UTC parseable.
        parsed = datetime.fromisoformat(value)
        assert parsed.tzinfo is not None

    async def test_heartbeat_independiente_de_eventos_procesados(self):
        """
        Cubre el escenario de spec "Heartbeat expirado sin sismos nuevos en
        el período": el heartbeat se escribe SIN que handle_event se haya
        llamado ni una sola vez — la independencia de si hubo sismos.
        """
        redis_client = StubRedis()
        ingestor = build_ingestor(redis_client)

        task = asyncio.create_task(
            ingestor._heartbeat_loop(interval_s=0.01, ttl_s=42)
        )
        await asyncio.sleep(0.05)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

        assert len(redis_client.calls) >= 1
        # handle_event nunca se invocó ni se mockeó como llamado: no hay
        # ningún evento en juego en este test, y aun así el heartbeat escribió.
        assert ingestor.persisted_count == 0
        assert ingestor.published_count == 0


@pytest.mark.asyncio
class TestHeartbeatNoTumbaElGather:
    async def test_heartbeat_con_excepcion_en_redis_no_tumba_el_gather(self):
        """
        EL TEST MÁS IMPORTANTE DE TODO EL CHANGE.

        Un stub de Redis cuyo set() falla la primera vez y funciona la
        segunda, corriendo asyncio.gather(emsc.run(), usgs.run(),
        heartbeat_loop()) con emsc/usgs mockeados para vivir indefinidamente.
        Se verifica que NINGUNA corrutina se cancela por el fallo del
        heartbeat: el gather() sigue vivo tras el error, y en la segunda
        vuelta el set() se reintenta y tiene éxito.
        """
        redis_client = StubRedis(fail_times=1)
        ingestor = build_ingestor(redis_client)

        fake_emsc = ForeverRunning()
        fake_usgs = ForeverRunning()
        ingestor.emsc.run = fake_emsc.run
        ingestor.usgs.run = fake_usgs.run

        gather_task = asyncio.ensure_future(
            asyncio.gather(
                ingestor.emsc.run(),
                ingestor.usgs.run(),
                ingestor._heartbeat_loop(interval_s=0.01, ttl_s=42),
            )
        )

        # Darle tiempo a que el heartbeat falle una vez y se reintente con
        # éxito, sin que eso tumbe el gather.
        await asyncio.sleep(0.1)

        assert not gather_task.done(), (
            "El gather() terminó solo: el fallo del heartbeat se propagó y "
            "canceló a EMSC/USGS — exactamente el riesgo que este test existe "
            "para bloquear."
        )
        assert not fake_emsc.cancelled
        assert not fake_usgs.cancelled

        # El reintento posterior al fallo tuvo que tener éxito.
        assert len(redis_client.calls) >= 1

        gather_task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await gather_task

    async def test_heartbeat_solo_repropaga_cancelled_error(self):
        """
        Comportamiento distinto de cualquier otra excepción: CancelledError
        SÍ debe re-propagarse — el shutdown del proceso depende de esto.
        """
        redis_client = StubRedis()
        ingestor = build_ingestor(redis_client)

        task = asyncio.create_task(
            ingestor._heartbeat_loop(interval_s=0.01, ttl_s=42)
        )
        await asyncio.sleep(0.03)
        task.cancel()

        with pytest.raises(asyncio.CancelledError):
            await task
        assert task.cancelled()


@pytest.mark.asyncio
class TestHeartbeatSinClienteRedis:
    async def test_sin_redis_client_el_heartbeat_se_salta_con_log(self, caplog):
        """
        Decisión de diseño: redis_client=None es un camino válido (no
        obligatorio). Si no hay cliente, el heartbeat no debe intentar
        escribir nada ni reventar — se loguea y listo. Cubre el constructor
        con default None documentado en el docstring.
        """
        ingestor = build_ingestor(redis_client=None)

        with caplog.at_level("WARNING"):
            task = asyncio.create_task(
                ingestor._heartbeat_loop(interval_s=0.01, ttl_s=42)
            )
            await asyncio.sleep(0.03)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task

        assert any(
            "heartbeat" in record.message.lower() for record in caplog.records
        )
