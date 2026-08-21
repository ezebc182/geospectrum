"""Muro default "Global": agrupamiento por región y reparto en columnas."""

from src.services.spectrogram_service import LIVE_CANDIDATES_BY_CITY
from src.services.wall_service import (
    CITY_REGIONS,
    build_global_wall,
    pack_groups_into_columns,
)


def test_toda_ciudad_viva_tiene_region():
    # Si se agrega una ciudad al catálogo sin mapear su región, este test
    # canta — el fallback "OTROS" es para datos dinámicos, no para el catálogo.
    for city_id in LIVE_CANDIDATES_BY_CITY:
        assert city_id in CITY_REGIONS, f"{city_id} sin región asignada"


def test_muro_global_incluye_cada_ciudad_una_sola_vez():
    wall = build_global_wall()
    channels = [
        ch["channel"]
        for col in wall["layout"]["columns"]
        for grp in col["groups"]
        for ch in grp["channels"]
    ]
    # Una tira por ciudad: el canal primario (primero de la lista de candidatos)
    assert len(channels) == len(LIVE_CANDIDATES_BY_CITY)
    assert len(set(channels)) == len(channels)
    primaries = {cands[0] for cands in LIVE_CANDIDATES_BY_CITY.values()}
    assert set(channels) == primaries


def test_muro_global_agrupa_por_region_y_etiqueta_con_ciudad():
    wall = build_global_wall()
    titles = {g["title"] for col in wall["layout"]["columns"] for g in col["groups"]}
    assert "SUDAMÉRICA" in titles
    labels = [
        ch["label"]
        for col in wall["layout"]["columns"]
        for g in col["groups"]
        for ch in g["channels"]
    ]
    assert any("Tokyo" in lab or "Tokio" in lab for lab in labels)


def test_reparto_en_columnas_balancea_por_cantidad_de_tiras():
    groups = [
        {"title": "A", "channels": [{}] * 10},
        {"title": "B", "channels": [{}] * 6},
        {"title": "C", "channels": [{}] * 5},
        {"title": "D", "channels": [{}] * 1},
    ]
    cols = pack_groups_into_columns(groups, 2)
    sizes = [sum(len(g["channels"]) for g in col) for col in cols]
    # Greedy por columna más liviana: 10+1 y 6+5 → 11 y 11
    assert sizes == [11, 11]
    # Un grupo nunca se parte entre columnas
    all_titles = [g["title"] for col in cols for g in col]
    assert sorted(all_titles) == ["A", "B", "C", "D"]
