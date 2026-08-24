"""Ventana absoluta vs relativa en el fetch FDSN del servicio de espectrogramas.

El candado que impedía mirar un evento pasado NO estaba en el endpoint sino acá:
`_get_waveform_sync` hacía `end_time = UTCDateTime()` — "ahora" — y derivaba el
inicio restando `duration_hours`. Cualquier ventana pedida terminaba anclada al
presente.

Estos tests asertan sobre los ARGUMENTOS con los que se llamó a `get_waveforms`,
no sobre el valor devuelto. Un test que sólo verifique "devuelve un Stream"
pasaría igual con la ventana anclada a ahora, que es exactamente el bug.
"""

from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

from obspy import UTCDateTime

from src.services.spectrogram_service import SpectrogramService


def _service_con_cliente_mockeado() -> tuple[SpectrogramService, MagicMock]:
    """Servicio con un único cliente FDSN falso que devuelve un stream no vacío.

    El stream tiene que ser "no vacío" para que el loop de failover corte en el
    primer servidor: `_get_waveform_sync` sigue probando servidores mientras
    `len(stream) == 0`.
    """
    service = SpectrogramService.__new__(SpectrogramService)
    client = MagicMock()
    client.get_waveforms.return_value = [MagicMock()]  # len() == 1
    service.clients = {"IRIS": client}
    return service, client


def test_ventana_absoluta_se_pide_tal_cual():
    # Una ventana de 2019: si el código anclara a "ahora", estos límites no
    # podrían aparecer en la llamada de ninguna forma.
    service, client = _service_con_cliente_mockeado()
    start = datetime(2019, 4, 18, 20, 0, 0, tzinfo=timezone.utc)
    end = datetime(2019, 4, 18, 20, 10, 0, tzinfo=timezone.utc)

    service._get_waveform_sync(
        network="WY",
        station="NIHS",
        location="--",
        channel="HNZ",
        starttime=start,
        endtime=end,
    )

    kwargs = client.get_waveforms.call_args.kwargs
    assert kwargs["starttime"] == UTCDateTime(start)
    assert kwargs["endtime"] == UTCDateTime(end)


def test_ventana_absoluta_ignora_duration_hours():
    # `duration_hours` es del modo relativo. Si la ventana absoluta lo mirara,
    # la duración pedida sería 24 h en vez de los 10 minutos señalados.
    service, client = _service_con_cliente_mockeado()
    start = datetime(2019, 4, 18, 20, 0, 0, tzinfo=timezone.utc)
    end = datetime(2019, 4, 18, 20, 10, 0, tzinfo=timezone.utc)

    service._get_waveform_sync(
        network="WY",
        station="NIHS",
        duration_hours=24,
        starttime=start,
        endtime=end,
    )

    kwargs = client.get_waveforms.call_args.kwargs
    assert kwargs["endtime"] - kwargs["starttime"] == 600.0


def test_sin_ventana_la_ventana_sigue_anclada_a_ahora():
    # Retro-compatibilidad: el comportamiento histórico no cambia. Se compara
    # contra un "ahora" tomado en el test con holgura de 60 s para no depender
    # del reloj exacto entre ambas líneas.
    service, client = _service_con_cliente_mockeado()
    antes = UTCDateTime()

    service._get_waveform_sync(network="AK", station="FIRE", duration_hours=3)

    kwargs = client.get_waveforms.call_args.kwargs
    assert abs(kwargs["endtime"] - antes) < 60
    assert abs((kwargs["endtime"] - kwargs["starttime"]) - 3 * 3600) < 1


def test_ventana_incompleta_cae_al_modo_relativo():
    # Sólo uno de los dos límites no alcanza para definir una ventana. El
    # endpoint valida esto con un 422, pero el servicio no puede confiar en su
    # único llamador: acá el fallback seguro es el comportamiento histórico.
    service, client = _service_con_cliente_mockeado()
    antes = UTCDateTime()

    service._get_waveform_sync(
        network="AK",
        station="FIRE",
        duration_hours=1,
        starttime=datetime(2019, 4, 18, 20, 0, 0, tzinfo=timezone.utc),
        endtime=None,
    )

    kwargs = client.get_waveforms.call_args.kwargs
    assert kwargs["starttime"] != UTCDateTime(2019, 4, 18, 20, 0, 0)
    assert abs(kwargs["endtime"] - antes) < 60


def test_ventana_absoluta_naive_se_interpreta_como_utc():
    # `utcnow()` naive ya desplazó horas en este repo (rotulaba 5:10 "UTC"
    # siendo las 02:10). Un datetime sin tzinfo acá debe leerse como UTC, nunca
    # como hora local del servidor.
    service, client = _service_con_cliente_mockeado()
    naive_start = datetime(2019, 4, 18, 20, 0, 0)
    naive_end = datetime(2019, 4, 18, 20, 10, 0)

    service._get_waveform_sync(
        network="WY",
        station="NIHS",
        starttime=naive_start,
        endtime=naive_end,
    )

    kwargs = client.get_waveforms.call_args.kwargs
    assert kwargs["starttime"] == UTCDateTime(2019, 4, 18, 20, 0, 0)


def test_ventana_absoluta_con_offset_equivale_a_su_utc():
    # 11:00-03:00 y 14:00Z son el MISMO instante: el servicio debe pedir lo
    # mismo en ambos casos (importa para que la cache key no se duplique).
    service, client = _service_con_cliente_mockeado()
    con_offset = datetime(2026, 8, 23, 11, 0, 0, tzinfo=timezone(timedelta(hours=-3)))

    service._get_waveform_sync(
        network="AK",
        station="FIRE",
        starttime=con_offset,
        endtime=con_offset + timedelta(minutes=10),
    )

    kwargs = client.get_waveforms.call_args.kwargs
    assert kwargs["starttime"] == UTCDateTime(2026, 8, 23, 14, 0, 0)
