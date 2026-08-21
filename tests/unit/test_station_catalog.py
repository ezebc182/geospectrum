"""station_catalog expone TODAS las candidatas (75), no solo la ganadora
por ciudad que devuelve resolve_live_catalog (27)."""

from src.services.spectrogram_service import (
    LIVE_CANDIDATES_BY_CITY,
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


def test_el_catalogo_real_expone_mas_canales_que_ciudades():
    result = station_catalog(LIVE_CANDIDATES_BY_CITY, active_channels=set())

    assert len(result) > len(LIVE_CANDIDATES_BY_CITY)  # 75 vs 27
    # La clave única es (ciudad, canal), no el canal solo: NZ.KHZ.10.HHZ es
    # respaldo de wellington Y primaria de christchurch — la misma estación
    # cubre las dos ciudades y cada entrada lleva su propio is_primary.
    assert len({(e["city_id"], e["channel"]) for e in result}) == len(result)
