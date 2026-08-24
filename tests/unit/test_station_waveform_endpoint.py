"""El endpoint `/stations/{channel}/waveform` de punta a punta, sin red.

Los tests de `test_station_waveform.py` cubren la lógica pura. Estos cubren lo
que la lógica pura NO puede ver: que la ruta esté registrada, que el SCNL se
parsee, que los códigos de estado sean los correctos y que la respuesta
sobreviva la serialización de FastAPI.

Lección del proyecto: 736 tests verdes y el proceso moría al arrancar. Que las
funciones anden no prueba que el endpoint responda.
"""

from datetime import datetime, timezone

import numpy as np
import pytest
from fastapi.testclient import TestClient
from obspy import Stream, Trace
from unittest.mock import AsyncMock, patch

from src.main import app


@pytest.fixture
def client():
    return TestClient(app)


def _stream(fs=20.0, seconds=3600.0, offset=500.0, amp=100.0):
    """Stream sintético con offset DC, para verificar que el demean lo saca."""
    t = np.arange(int(fs * seconds)) / fs
    data = offset + amp * np.sin(2 * np.pi * 5.0 * t)
    return Stream(
        [
            Trace(
                data=data,
                header={
                    "network": "IU",
                    "station": "MAJO",
                    "channel": "BHZ",
                    "sampling_rate": fs,
                },
            )
        ]
    )


def test_scnl_mal_formado_da_422(client):
    # Falta el location code: "IU.MAJO.BHZ" son 3 partes, no 4.
    resp = client.get("/stations/IU.MAJO.BHZ/waveform")
    assert resp.status_code == 422
    assert "NET.STA.LOC.CHA" in resp.json()["detail"]


def test_devuelve_waveform_decimado_y_demeaneado(client):
    with patch("src.main.get_spectrogram_service") as gs:
        gs.return_value.get_waveform_data = AsyncMock(return_value=_stream())
        resp = client.get("/stations/IU.MAJO..BHZ/waveform?minutes=60&points=500")

    assert resp.status_code == 200
    body = resp.json()
    assert body["channel"] == "IU.MAJO..BHZ"
    assert body["sampling_rate"] == 20.0
    assert len(body["mins"]) == len(body["maxs"]) == 500
    # El offset DC de 500 no llega al cliente: la señal sale centrada en 0.
    assert abs(np.mean(body["mins"]) + np.mean(body["maxs"])) < 5.0


def test_sin_datos_fdsn_da_404(client):
    with patch("src.main.get_spectrogram_service") as gs:
        gs.return_value.get_waveform_data = AsyncMock(return_value=None)
        resp = client.get("/stations/XX.NADA..BHZ/waveform")

    assert resp.status_code == 404
    assert "XX.NADA..BHZ" in resp.json()["detail"]


@pytest.mark.parametrize(
    "minutes,horas_esperadas",
    [
        (60, 1),  # exacto: una hora es una hora
        (90, 2),  # 90 // 60 daba 1 y se perdía media hora en silencio
        (61, 2),  # un minuto de más ya obliga a pedir la hora siguiente
        (1440, 24),  # el día entero del helicorder no cambia
        (1, 1),  # nunca menos de una hora: FDSN se pide por horas
    ],
)
def test_no_recorta_la_ventana_pedida(client, minutes, horas_esperadas):
    """`minutes // 60` (división ENTERA) achicaba el pedido sin avisar.

    Cualquier ventana no múltiplo de 60 se truncaba hacia abajo: pedir 90 min
    devolvía 60 y el cliente no tenía forma de notarlo. Se redondea hacia
    ARRIBA porque pedir de más y recortar es correcto — pedir de menos y
    devolver la ventana equivocada, no.
    """
    with patch("src.main.get_spectrogram_service") as gs:
        gs.return_value.get_waveform_data = AsyncMock(return_value=_stream())
        resp = client.get(f"/stations/IU.MAJO..BHZ/waveform?minutes={minutes}&points=100")

    assert resp.status_code == 200
    assert gs.return_value.get_waveform_data.await_args.kwargs["duration_hours"] == (
        horas_esperadas
    )


def test_usa_el_trace_mas_largo_cuando_hay_gaps(client):
    """Un stream partido por gaps trae varios traces: se dibuja el más largo,
    no el primero (que puede ser un fragmento de segundos)."""
    corto = _stream(seconds=10.0)[0]
    largo = _stream(seconds=3600.0)[0]
    with patch("src.main.get_spectrogram_service") as gs:
        gs.return_value.get_waveform_data = AsyncMock(return_value=Stream([corto, largo]))
        resp = client.get("/stations/IU.MAJO..BHZ/waveform?points=400")

    assert resp.status_code == 200
    # Con el trace corto (10 s a 20 Hz = 200 muestras) no se llegaría a 400 pares.
    assert len(resp.json()["mins"]) == 400


# =============================================================================
# Ventana absoluta (start/end) — Fase 1 de `analiticas-profesionales-senal`
# =============================================================================


@pytest.fixture(autouse=True)
def _cache_limpio():
    """El TTL por defecto es 900 s, así que el cache está ACTIVO en los tests.

    Sin esto, un test que pide la misma URL que otro se sirve del cache, el mock
    no se llama, y el aserto sobre `await_args` mira la llamada del test
    anterior. Es un falso verde particularmente difícil de ver.
    """
    from src.services import cache as _cache

    _cache.clear()
    yield
    _cache.clear()


VENTANA = "start=2019-04-18T20:00:00Z&end=2019-04-18T20:10:00Z"


def test_ventana_absoluta_llega_al_servicio(client):
    with patch("src.main.get_spectrogram_service") as gs:
        gs.return_value.get_waveform_data = AsyncMock(return_value=_stream())
        resp = client.get(f"/stations/IU.MAJO..BHZ/waveform?{VENTANA}&points=100")

    assert resp.status_code == 200
    kwargs = gs.return_value.get_waveform_data.await_args.kwargs
    assert kwargs["starttime"] == datetime(2019, 4, 18, 20, 0, tzinfo=timezone.utc)
    assert kwargs["endtime"] == datetime(2019, 4, 18, 20, 10, tzinfo=timezone.utc)


def test_start_sin_end_da_422(client):
    with patch("src.main.get_spectrogram_service") as gs:
        gs.return_value.get_waveform_data = AsyncMock(return_value=_stream())
        resp = client.get("/stations/IU.MAJO..BHZ/waveform?start=2019-04-18T20:00:00Z")

    assert resp.status_code == 422
    assert "juntos" in resp.json()["detail"]
    gs.return_value.get_waveform_data.assert_not_awaited()


def test_end_sin_start_da_422(client):
    with patch("src.main.get_spectrogram_service") as gs:
        gs.return_value.get_waveform_data = AsyncMock(return_value=_stream())
        resp = client.get("/stations/IU.MAJO..BHZ/waveform?end=2019-04-18T20:00:00Z")

    assert resp.status_code == 422
    gs.return_value.get_waveform_data.assert_not_awaited()


def test_ventana_con_minutes_explicito_da_422(client):
    with patch("src.main.get_spectrogram_service") as gs:
        gs.return_value.get_waveform_data = AsyncMock(return_value=_stream())
        resp = client.get(f"/stations/IU.MAJO..BHZ/waveform?{VENTANA}&minutes=60")

    assert resp.status_code == 422
    assert "mutuamente excluyentes" in resp.json()["detail"]
    gs.return_value.get_waveform_data.assert_not_awaited()


def test_end_anterior_a_start_da_422(client):
    with patch("src.main.get_spectrogram_service") as gs:
        gs.return_value.get_waveform_data = AsyncMock(return_value=_stream())
        resp = client.get(
            "/stations/IU.MAJO..BHZ/waveform"
            "?start=2019-04-18T20:10:00Z&end=2019-04-18T20:00:00Z"
        )

    assert resp.status_code == 422
    assert "posterior" in resp.json()["detail"]
    gs.return_value.get_waveform_data.assert_not_awaited()


def test_end_igual_a_start_da_422(client):
    """Escenario SEPARADO del anterior a propósito: fija el borde en `>` y no
    `>=`. Con `end < start` solo, cambiar el operador a `<` dejaría este caso
    pasando con una ventana de duración cero."""
    with patch("src.main.get_spectrogram_service") as gs:
        gs.return_value.get_waveform_data = AsyncMock(return_value=_stream())
        resp = client.get(
            "/stations/IU.MAJO..BHZ/waveform"
            "?start=2019-04-18T20:00:00Z&end=2019-04-18T20:00:00Z"
        )

    assert resp.status_code == 422
    gs.return_value.get_waveform_data.assert_not_awaited()


def test_ventana_de_mas_de_24h_da_422(client):
    with patch("src.main.get_spectrogram_service") as gs:
        gs.return_value.get_waveform_data = AsyncMock(return_value=_stream())
        resp = client.get(
            "/stations/IU.MAJO..BHZ/waveform"
            "?start=2019-04-18T20:00:00Z&end=2019-04-19T20:00:01Z"
        )

    assert resp.status_code == 422
    assert "24 horas" in resp.json()["detail"]
    gs.return_value.get_waveform_data.assert_not_awaited()


def test_ventana_de_exactamente_24h_no_da_422(client):
    """El par del test anterior: fija el borde en `>` y no `>=`. Sin este, un
    `>=` dejaría pasar el test de arriba y rechazaría una ventana legítima."""
    with patch("src.main.get_spectrogram_service") as gs:
        gs.return_value.get_waveform_data = AsyncMock(return_value=_stream())
        resp = client.get(
            "/stations/IU.MAJO..BHZ/waveform"
            "?start=2019-04-18T20:00:00Z&end=2019-04-19T20:00:00Z&points=100"
        )

    assert resp.status_code == 200


def test_fecha_invalida_da_422(client):
    with patch("src.main.get_spectrogram_service") as gs:
        gs.return_value.get_waveform_data = AsyncMock(return_value=_stream())
        resp = client.get("/stations/IU.MAJO..BHZ/waveform?start=ayer&end=hoy")

    assert resp.status_code == 422
    gs.return_value.get_waveform_data.assert_not_awaited()


def test_offset_y_utc_son_la_misma_ventana(client):
    """11:00-03:00 y 14:00Z son el MISMO instante: deben producir la misma key
    de cache. Si no se normalizara a UTC antes de formatear, la segunda llamada
    volvería a pegarle a FDSN por la misma ventana."""
    with patch("src.main.get_spectrogram_service") as gs:
        gs.return_value.get_waveform_data = AsyncMock(return_value=_stream())
        primera = client.get(
            "/stations/IU.MAJO..BHZ/waveform"
            "?start=2026-08-23T14:00:00Z&end=2026-08-23T14:10:00Z&points=100"
        )
        segunda = client.get(
            "/stations/IU.MAJO..BHZ/waveform"
            "?start=2026-08-23T11:00:00-03:00&end=2026-08-23T11:10:00-03:00&points=100"
        )

    assert primera.status_code == segunda.status_code == 200
    assert gs.return_value.get_waveform_data.await_count == 1


def test_dos_ventanas_distintas_no_colisionan_en_cache(client):
    """La mutación #9 (sacar `window_part` de la key) debe poner ESTE test en
    rojo: sin la ventana en la key, la segunda llamada se serviría del cache de
    la primera y `await_count` quedaría en 1."""
    with patch("src.main.get_spectrogram_service") as gs:
        gs.return_value.get_waveform_data = AsyncMock(return_value=_stream())
        client.get(
            "/stations/IU.MAJO..BHZ/waveform"
            "?start=2019-04-18T20:00:00Z&end=2019-04-18T20:10:00Z&points=100"
        )
        client.get(
            "/stations/IU.MAJO..BHZ/waveform"
            "?start=2020-01-01T00:00:00Z&end=2020-01-01T00:10:00Z&points=100"
        )

    assert gs.return_value.get_waveform_data.await_count == 2


def test_ventana_relativa_y_absoluta_no_colisionan(client):
    with patch("src.main.get_spectrogram_service") as gs:
        gs.return_value.get_waveform_data = AsyncMock(return_value=_stream())
        client.get("/stations/IU.MAJO..BHZ/waveform?minutes=60&points=100")
        client.get(f"/stations/IU.MAJO..BHZ/waveform?{VENTANA}&points=100")

    assert gs.return_value.get_waveform_data.await_count == 2


def test_la_misma_ventana_se_sirve_del_cache(client):
    with patch("src.main.get_spectrogram_service") as gs:
        gs.return_value.get_waveform_data = AsyncMock(return_value=_stream())
        client.get(f"/stations/IU.MAJO..BHZ/waveform?{VENTANA}&points=100")
        client.get(f"/stations/IU.MAJO..BHZ/waveform?{VENTANA}&points=100")

    assert gs.return_value.get_waveform_data.await_count == 1


def test_sin_datos_fdsn_no_se_cachea_el_vacio(client):
    """Un vacío puede venir de un timeout transitorio: cachearlo dejaría la
    ventana muerta por todo el TTL (900 s). El 404 se lanza ANTES del
    `cache.set`, así que el segundo intento debe volver a pedirle a FDSN."""
    with patch("src.main.get_spectrogram_service") as gs:
        gs.return_value.get_waveform_data = AsyncMock(return_value=None)
        primera = client.get(f"/stations/IU.MAJO..BHZ/waveform?{VENTANA}")
        segunda = client.get(f"/stations/IU.MAJO..BHZ/waveform?{VENTANA}")

    assert primera.status_code == segunda.status_code == 404
    assert gs.return_value.get_waveform_data.await_count == 2


def test_retrocompatibilidad_sin_minutes_sigue_dando_24h(client):
    """El llamado REAL de `HelicorderCanvas.tsx:96-99` no manda `minutes`.

    Esta es la tarea que impide que el cambio de `minutes` a `None` rompa al
    único cliente en producción."""
    with patch("src.main.get_spectrogram_service") as gs:
        gs.return_value.get_waveform_data = AsyncMock(return_value=_stream())
        resp = client.get("/stations/AK.FIRE..BHZ/waveform?points=38400&filter=none")

    assert resp.status_code == 200
    kwargs = gs.return_value.get_waveform_data.await_args.kwargs
    assert kwargs["duration_hours"] == 24
    assert kwargs["starttime"] is None
    assert kwargs["endtime"] is None
