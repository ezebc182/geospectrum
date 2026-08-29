"""Canales SeedLink efímeros: el contrato entre api e ingestor vía Redis.

El contrato crítico: request_channel escribe con la key/formato EXACTOS que
list_requested_channels espera leer del otro lado (procesos distintos, no
comparten nada más que Redis) — un desacople entre ambos deja al canal
pedido invisible para el ingestor, sin error.
"""

from unittest.mock import AsyncMock, MagicMock

import pytest

from src.services.ephemeral_channels import (
    DEFAULT_TTL_SECONDS,
    list_requested_channels,
    request_channel,
    request_channel_async,
)

def test_request_channel_escribe_con_ttl():
    client = MagicMock()
    request_channel(client, "IU.MAJO.00.BHZ", ttl_seconds=120)
    client.set.assert_called_once_with("ephemeral_channel:IU.MAJO.00.BHZ", "1", ex=120)


def test_request_channel_usa_el_ttl_default_sin_especificar():
    client = MagicMock()
    request_channel(client, "IU.MAJO.00.BHZ")
    client.set.assert_called_once_with(
        "ephemeral_channel:IU.MAJO.00.BHZ", "1", ex=DEFAULT_TTL_SECONDS
    )


def test_list_requested_channels_descarta_el_location_code():
    client = MagicMock()
    client.scan_iter.return_value = iter(["ephemeral_channel:IU.MAJO.00.BHZ"])
    assert list_requested_channels(client) == [("IU", "MAJO", "BHZ")]


def test_list_requested_channels_ignora_un_scnl_malformado():
    client = MagicMock()
    client.scan_iter.return_value = iter(["ephemeral_channel:IU.MAJO"])
    assert list_requested_channels(client) == []


def test_list_requested_channels_decodifica_bytes():
    """El cliente redis SÍNCRONO sin decode_responses devuelve bytes."""
    client = MagicMock()
    client.scan_iter.return_value = iter([b"ephemeral_channel:IU.MAJO.00.BHZ"])
    assert list_requested_channels(client) == [("IU", "MAJO", "BHZ")]


@pytest.mark.asyncio
async def test_request_channel_async_mismo_formato_de_key():
    client = MagicMock()
    client.set = AsyncMock()
    await request_channel_async(client, "IU.MAJO.00.BHZ", ttl_seconds=90)
    client.set.assert_awaited_once_with("ephemeral_channel:IU.MAJO.00.BHZ", "1", ex=90)
