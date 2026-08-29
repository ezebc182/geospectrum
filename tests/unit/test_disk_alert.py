"""Alerta de disco de TimescaleDB: dispara ntfy solo al cruzar el umbral.

El contrato crítico, post caída del 2026-08-28: un ciclo que falla (base o
ntfy caídos) NO puede matar el loop para siempre — el próximo chequeo debe
reintentar solo, igual que fdsn_warmup.
"""

import asyncio
from unittest.mock import AsyncMock, patch

import pytest

from src.services.disk_alert import check_disk_usage, run_disk_alert_loop

pytestmark = pytest.mark.asyncio

_GB = 1024**3


class _FakePool:
    def __init__(self, size_bytes):
        self.size_bytes = size_bytes

    def acquire(self):
        return self

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def fetchval(self, query):
        return self.size_bytes


async def test_no_notifica_por_debajo_del_umbral():
    pool = _FakePool(size_bytes=int(5 * _GB))  # 50% de 10 GB
    with patch("src.services.disk_alert._notify_ntfy", new=AsyncMock()) as notify:
        await check_disk_usage(
            pool, volume_capacity_bytes=10 * _GB, threshold_ratio=0.8, ntfy_topic_url="https://ntfy.sh/x"
        )
    notify.assert_not_called()


async def test_notifica_al_cruzar_el_umbral():
    pool = _FakePool(size_bytes=int(8.5 * _GB))  # 85% de 10 GB
    with patch("src.services.disk_alert._notify_ntfy", new=AsyncMock()) as notify:
        await check_disk_usage(
            pool, volume_capacity_bytes=10 * _GB, threshold_ratio=0.8, ntfy_topic_url="https://ntfy.sh/x"
        )
    notify.assert_awaited_once()
    args, _ = notify.call_args
    assert args[0] == "https://ntfy.sh/x"
    assert args[1] == pytest.approx(0.85, rel=1e-2)


async def test_un_ciclo_fallido_no_mata_el_loop():
    """La lección del ingestor: un except sin try dejaba el hilo muerto para
    siempre. Acá, dos ciclos — el primero explota, el segundo debe correr."""
    stop_event = asyncio.Event()
    calls = []

    async def _fake_check(*args, **kwargs):
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("base caída un instante")
        stop_event.set()

    with patch("src.services.disk_alert.check_disk_usage", new=_fake_check):
        await run_disk_alert_loop(
            pool=None,
            volume_capacity_bytes=10 * _GB,
            threshold_ratio=0.8,
            ntfy_topic_url="https://ntfy.sh/x",
            interval_seconds=0,
            stop_event=stop_event,
        )

    assert len(calls) == 2
