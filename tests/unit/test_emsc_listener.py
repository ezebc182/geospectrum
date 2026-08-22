"""
Tests del listener de EMSC (PR-W4, T4).

El grueso apunta a `parse_frame`, que es función pura: ahí vive todo lo que
puede salir mal con el formato de EMSC y se testea con dicts, sin red.

La regla que fijan estos tests: un frame raro se DESCARTA, nunca levanta. Un
listener que explota por un frame malo se desconecta y deja de recibir los
buenos — perder un frame es barato, perder la conexión no.
"""

import asyncio
import json

import pytest

from src.ingestors.emsc_listener import (
    EMSC_WEBSOCKET_URL,
    MAX_BACKOFF_SECONDS,
    EMSCListener,
    backoff_delay,
    parse_frame,
)


def frame(action: str = "create", **prop_overrides) -> str:
    """Frame de EMSC con la forma real del feed."""
    props = {
        "unid": "20260821_0000042",
        "time": "2026-08-21T12:00:00.0Z",
        "mag": 4.7,
        "magtype": "mb",
        "flynn_region": "ANTOFAGASTA, CHILE",
        "evtype": "ke",
        "auth": "EMSC",
    }
    props.update(prop_overrides)
    return json.dumps(
        {
            "action": action,
            "data": {
                "properties": props,
                # GeoJSON: [lon, lat, prof_km] en ESE orden.
                "geometry": {"type": "Point", "coordinates": [-68.2, -23.5, 110.0]},
            },
        }
    )


class TestParseFrameFelizmente:
    def test_un_frame_create_se_convierte_en_evento(self):
        evento = parse_frame(frame())

        assert evento is not None
        assert evento.id == "emsc_20260821_0000042"
        assert evento.fuentes == ["EMSC"]
        assert evento.mag == 4.7
        assert evento.mag_tipo == "mb"
        assert evento.lugar == "ANTOFAGASTA, CHILE"

    def test_las_coordenadas_se_leen_en_orden_geojson(self):
        """
        [lon, lat, prof] y NO [lat, lon]. Invertirlas pondría un sismo de
        Antofagasta en medio del Atlántico y nadie lo notaría hasta ver el mapa.
        """
        evento = parse_frame(frame())
        assert evento.lat == -23.5
        assert evento.lon == -68.2
        assert evento.prof_km == 110.0

    def test_un_frame_update_TAMBIEN_se_procesa(self):
        """
        Los `update` son las revisiones de magnitud que EMSC manda minutos
        después. El plan de 2026-04-29 los descartaba; ahora que hay dedupe +
        upsert, procesarlos actualiza la fila en vez de duplicarla.
        Descartarlos era perder la corrección de un M4.5 que resultó M5.2.
        """
        evento = parse_frame(frame(action="update", mag=5.2))
        assert evento is not None
        assert evento.mag == 5.2

    def test_la_hora_sin_Z_recibe_el_sufijo(self):
        evento = parse_frame(frame(time="2026-08-21T12:00:00"))
        assert evento.hora_utc.endswith("Z")

    def test_acepta_bytes_ademas_de_str(self):
        """websockets entrega bytes cuando el frame es binario."""
        assert parse_frame(frame().encode("utf-8")) is not None

    def test_sin_profundidad_el_evento_igual_entra(self):
        payload = json.loads(frame())
        payload["data"]["geometry"]["coordinates"] = [-68.2, -23.5]
        evento = parse_frame(json.dumps(payload))
        assert evento is not None
        assert evento.prof_km is None


class TestParseFrameDescartaSinExplotar:
    def test_json_invalido(self):
        assert parse_frame("{no es json") is None

    def test_frame_que_no_es_un_objeto(self):
        assert parse_frame('["una", "lista"]') is None

    def test_action_desconocida_se_ignora(self):
        """EMSC manda heartbeats y otros frames de control."""
        assert parse_frame(frame(action="heartbeat")) is None

    def test_sin_data(self):
        assert parse_frame(json.dumps({"action": "create"})) is None

    def test_sin_coordenadas(self):
        payload = json.loads(frame())
        payload["data"]["geometry"] = {}
        assert parse_frame(json.dumps(payload)) is None

    def test_con_coordenadas_nulas(self):
        payload = json.loads(frame())
        payload["data"]["geometry"]["coordinates"] = [None, None]
        assert parse_frame(json.dumps(payload)) is None

    def test_sin_hora(self):
        payload = json.loads(frame())
        del payload["data"]["properties"]["time"]
        assert parse_frame(json.dumps(payload)) is None

    def test_sin_magnitud(self):
        """
        Un evento sin magnitud no se puede pintar en el globo (radio y color
        salen de ahí) ni filtrar por min_magnitude.
        """
        payload = json.loads(frame())
        del payload["data"]["properties"]["mag"]
        assert parse_frame(json.dumps(payload)) is None

    def test_sin_identificador(self):
        payload = json.loads(frame())
        del payload["data"]["properties"]["unid"]
        assert parse_frame(json.dumps(payload)) is None

    def test_con_magnitud_no_numerica(self):
        assert parse_frame(frame(mag="cuatro coma siete")) is None


class TestBackoff:
    def test_arranca_en_alrededor_de_un_segundo(self):
        assert 0.5 <= backoff_delay(0) <= 1.5

    def test_crece_exponencialmente(self):
        """Sin jitter serían 1, 2, 4, 8. Con ±20 % los rangos no se pisan."""
        assert backoff_delay(1) < backoff_delay(3) < backoff_delay(5)

    def test_tiene_tope(self):
        """
        Sin tope, tras 20 intentos la espera sería de días y el worker no se
        recuperaría nunca de una caída larga de EMSC.
        """
        for intento in range(10, 30):
            assert backoff_delay(intento) <= MAX_BACKOFF_SECONDS * 1.2

    def test_el_jitter_dispersa_los_reintentos(self):
        """
        Sin jitter, todos los clientes del mundo reconectarían al mismo
        segundo cuando EMSC vuelva (thundering herd).
        """
        esperas = {backoff_delay(5) for _ in range(20)}
        assert len(esperas) > 1


class TestListener:
    def test_la_url_por_defecto_es_la_de_seismicportal(self):
        assert EMSC_WEBSOCKET_URL == "wss://www.seismicportal.eu/standing_order/websocket"

    def test_arranca_desconectado_y_sin_fallo(self):
        listener = EMSCListener(on_event=_noop)
        assert listener.connected is False
        assert listener.failure is None
        assert listener.seconds_since_last_message is None

    def test_sin_mensajes_todavia_no_se_declara_mudo(self):
        """
        Un listener recién arrancado no tiene última-vez-que-llegó-algo. Sin
        este guard se declararía mudo al instante y reconectaría en loop.
        """
        listener = EMSCListener(on_event=_noop)
        assert listener.is_silent() is False

    @pytest.mark.asyncio
    async def test_un_callback_que_falla_no_corta_el_consumo(self):
        """
        EL comportamiento crítico: si procesar un evento explota, el siguiente
        sismo tiene que llegar igual. Sin esto, un bug en el store nos deja
        sordos hasta el próximo redeploy.
        """
        recibidos = []

        async def on_event(evento):
            recibidos.append(evento.id)
            if len(recibidos) == 1:
                raise RuntimeError("fallo simulado del store")

        listener = EMSCListener(on_event=on_event)
        listener._running = True
        await listener._consume(_FakeSocket([frame(unid="a"), frame(unid="b")]))

        assert recibidos == ["emsc_a", "emsc_b"]

    @pytest.mark.asyncio
    async def test_los_frames_basura_no_llegan_al_callback(self):
        recibidos = []

        async def on_event(evento):
            recibidos.append(evento.id)

        listener = EMSCListener(on_event=on_event)
        listener._running = True
        await listener._consume(
            _FakeSocket(["{roto", frame(action="heartbeat"), frame(unid="ok")])
        )

        assert recibidos == ["emsc_ok"]

    @pytest.mark.asyncio
    async def test_un_frame_recibido_actualiza_el_reloj_de_silencio(self):
        listener = EMSCListener(on_event=_noop)
        listener._running = True
        await listener._consume(_FakeSocket([frame()]))

        assert listener.seconds_since_last_message is not None
        assert listener.is_silent() is False


async def _noop(_evento):
    return None


class _FakeSocket:
    """Socket mínimo: itera una lista de frames y se acaba."""

    def __init__(self, frames):
        self._frames = frames

    def __aiter__(self):
        async def gen():
            for f in self._frames:
                yield f
                await asyncio.sleep(0)

        return gen()
