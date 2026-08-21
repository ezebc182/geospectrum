"""Validación server-side del layout de muro (spec §2: 8 columnas, 120 canales, SCNL)."""

import pytest

from src.services.wall_service import (
    MAX_WALL_CHANNELS,
    MAX_WALL_COLUMNS,
    InvalidWallLayoutError,
    validate_wall_layout,
)


def _layout(columns=None, show_metrics=False):
    if columns is None:
        columns = [
            {"groups": [{"title": "ASIA", "channels": [{"channel": "IU.MAJO.00.BHZ", "label": "Tokyo"}]}]}
        ]
    return {"columns": columns, "showMetrics": show_metrics}


def test_layout_valido_pasa():
    validate_wall_layout(_layout())  # no levanta


def test_loc_vacio_es_valido():
    # JP.JYT..BHZ existe en LIVE_CANDIDATES_BY_CITY: LOC vacío es legal en SCNL
    validate_wall_layout(
        _layout([{"groups": [{"title": "ASIA", "channels": [{"channel": "JP.JYT..BHZ", "label": "Tokyo"}]}]}])
    )


def test_muro_vacio_es_valido():
    # Un muro a medio armar se puede guardar (columna con grupo sin canales)
    validate_wall_layout(_layout([{"groups": [{"title": "NUEVO", "channels": []}]}]))
    validate_wall_layout(_layout([{"groups": []}]))


@pytest.mark.parametrize(
    "bad",
    ["", "IU.MAJO.00", "iu.majo.00.bhz", "IU.MAJO.00.BHZZ", "IU MAJO 00 BHZ", "TOOLONG.MAJO.00.BHZ", "IU.MAJO.00.BHZ.EXTRA"],
)
def test_canal_no_scnl_rechazado(bad):
    with pytest.raises(InvalidWallLayoutError):
        validate_wall_layout(_layout([{"groups": [{"title": "X", "channels": [{"channel": bad, "label": "x"}]}]}]))


def test_canal_como_string_pelado_rechazado():
    # Decisión de contrato: channels son objetos {channel, label}, no strings
    with pytest.raises(InvalidWallLayoutError):
        validate_wall_layout(_layout([{"groups": [{"title": "X", "channels": ["IU.MAJO.00.BHZ"]}]}]))


def test_mas_de_ocho_columnas_rechazado():
    cols = [{"groups": []} for _ in range(MAX_WALL_COLUMNS + 1)]
    with pytest.raises(InvalidWallLayoutError):
        validate_wall_layout(_layout(cols))


def test_mas_de_120_canales_rechazado():
    chans = [{"channel": f"IU.S{i:03d}.00.BHZ", "label": f"s{i}"} for i in range(MAX_WALL_CHANNELS + 1)]
    with pytest.raises(InvalidWallLayoutError):
        validate_wall_layout(_layout([{"groups": [{"title": "X", "channels": chans}]}]))


def test_estructura_rota_rechazada():
    with pytest.raises(InvalidWallLayoutError):
        validate_wall_layout({"showMetrics": False})  # sin columns
    with pytest.raises(InvalidWallLayoutError):
        validate_wall_layout({"columns": [], "showMetrics": False})  # columns vacía
    with pytest.raises(InvalidWallLayoutError):
        validate_wall_layout(_layout(show_metrics="yes"))  # showMetrics no bool
    with pytest.raises(InvalidWallLayoutError):
        validate_wall_layout(_layout([{"sin_groups": True}]))
    with pytest.raises(InvalidWallLayoutError):
        validate_wall_layout("no soy un dict")


def test_titulo_de_grupo_y_label_obligatorios_y_acotados():
    with pytest.raises(InvalidWallLayoutError):
        validate_wall_layout(_layout([{"groups": [{"title": "  ", "channels": []}]}]))
    with pytest.raises(InvalidWallLayoutError):
        validate_wall_layout(
            _layout([{"groups": [{"title": "X", "channels": [{"channel": "IU.MAJO.00.BHZ", "label": ""}]}]}])
        )
    with pytest.raises(InvalidWallLayoutError):
        validate_wall_layout(
            _layout([{"groups": [{"title": "X", "channels": [{"channel": "IU.MAJO.00.BHZ", "label": "x" * 41}]}]}])
        )
