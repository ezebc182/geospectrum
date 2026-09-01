"""station_catalog expone TODAS las candidatas (75), no solo la ganadora
por ciudad que devuelve resolve_live_catalog (27)."""

import pytest

from src.services.spectrogram_service import (
    LIVE_CANDIDATES_BY_CITY,
    LIVE_CANDIDATES_GEOFON_BY_CITY,
    station_catalog,
)

SAMPLE = {
    "santiago": ["C1.MT05..BHZ", "C1.MT14..BHZ"],
    "lima": ["II.NNA.00.BHZ"],
}


def test_devuelve_una_entrada_por_candidata():
    result = station_catalog(SAMPLE, active_channels=set())

    assert [e["channel"] for e in result] == [
        "C1.MT05..BHZ",
        "C1.MT14..BHZ",
        "II.NNA.00.BHZ",
    ]


def test_marca_primaria_solo_la_primera_de_cada_ciudad():
    result = station_catalog(SAMPLE, active_channels=set())
    by_channel = {e["channel"]: e for e in result}

    assert by_channel["C1.MT05..BHZ"]["is_primary"] is True
    assert by_channel["C1.MT14..BHZ"]["is_primary"] is False
    assert by_channel["II.NNA.00.BHZ"]["is_primary"] is True


def test_is_live_refleja_las_columnas_frescas():
    result = station_catalog(SAMPLE, active_channels={"C1.MT14..BHZ"})
    by_channel = {e["channel"]: e for e in result}

    assert by_channel["C1.MT14..BHZ"]["is_live"] is True
    assert by_channel["C1.MT05..BHZ"]["is_live"] is False


def test_sin_datos_de_frescura_nada_se_marca_vivo():
    # active_channels=None = "no se pudo consultar la base" (misma semántica
    # que resolve_live_catalog): se ofrece todo, sin mentir sobre frescura.
    result = station_catalog(SAMPLE, active_channels=None)

    assert len(result) == 3
    assert all(e["is_live"] is False for e in result)


def test_desglosa_red_y_estacion_del_scnl():
    result = station_catalog({"lima": ["II.NNA.00.BHZ"]}, active_channels=set())

    assert result[0]["network"] == "II"
    assert result[0]["station"] == "NNA"
    assert result[0]["city_id"] == "lima"


@pytest.mark.parametrize(
    "catalogo",
    [LIVE_CANDIDATES_BY_CITY, LIVE_CANDIDATES_GEOFON_BY_CITY],
    ids=["rtserve", "geofon"],
)
def test_live_candidates_geofon_by_city_tiene_la_misma_forma_que_rtserve(catalogo):
    # Los dos catálogos alimentan las MISMAS funciones (channels_from_catalog,
    # resolve_live_catalog, station_catalog), que hacen seed_id.split(".") y
    # esperan 4 componentes. Una entrada mal formada en el de GEOFON revienta
    # el ingestor nuevo en el arranque, no en un test.
    assert catalogo, "el catálogo no puede estar vacío"
    for city_id, candidates in catalogo.items():
        assert isinstance(candidates, list) and candidates, (
            f"{city_id}: las candidatas deben ser una lista no vacía"
        )
        for seed_id in candidates:
            assert isinstance(seed_id, str), f"{city_id}: {seed_id!r} no es un string"
            partes = seed_id.split(".")
            assert len(partes) == 4, (
                f"{city_id}: {seed_id!r} no tiene forma net.sta.loc.cha"
            )
            net, sta, _loc, cha = partes
            # loc puede ser vacío ("MN.TRI..HHZ"); el resto no.
            assert net and sta and cha, f"{city_id}: {seed_id!r} tiene campos vacíos"


def test_ningun_candidato_geofon_usa_canal_de_1hz():
    # LHZ/LLZ están VIVOS en GE.KBU y WM.AVE, pero son banda larga a 1 Hz: el
    # espectrograma grafica hasta Nyquist, así que el eje de frecuencia moriría
    # en 0,5 Hz. "Vivo" no es lo mismo que "útil" — este test es la regla que
    # separa las dos cosas, para que un respaldo de 1 Hz no entre al catálogo
    # creyendo que suma redundancia.
    for city_id, candidates in LIVE_CANDIDATES_GEOFON_BY_CITY.items():
        for seed_id in candidates:
            banda = seed_id.split(".")[3][0]
            assert banda != "L", (
                f"{city_id}: {seed_id!r} es un canal de banda larga (1 Hz), "
                "inservible para el espectrograma"
            )


def test_el_catalogo_real_expone_mas_canales_que_ciudades():
    result = station_catalog(LIVE_CANDIDATES_BY_CITY, active_channels=set())

    assert len(result) > len(LIVE_CANDIDATES_BY_CITY)  # 75 vs 27
    # La clave única es (ciudad, canal), no el canal solo: NZ.KHZ.10.HHZ es
    # respaldo de wellington Y primaria de christchurch — la misma estación
    # cubre las dos ciudades y cada entrada lleva su propio is_primary.
    assert len({(e["city_id"], e["channel"]) for e in result}) == len(result)
