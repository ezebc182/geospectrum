"""Tests para utilidades geoespaciales."""
import pytest
from src.utils.geo import haversine_km, energy_weight, ms_to_iso


def test_haversine_distance():
    """Test distancia haversine básica."""
    # Buenos Aires a San Juan (aprox 1000 km)
    lat1, lon1 = -34.603722, -58.381592  # Buenos Aires
    lat2, lon2 = -31.537778, -68.536389  # San Juan

    dist = haversine_km(lat1, lon1, lat2, lon2)

    assert 900 < dist < 1100  # Margen razonable


def test_haversine_same_point():
    """Test distancia entre mismo punto."""
    dist = haversine_km(-31.5, -68.5, -31.5, -68.5)
    assert dist == 0.0


def test_energy_weight():
    """Test cálculo de energía sísmica."""
    # M4 vs M5: diferencia ~32x
    e4 = energy_weight(4.0)
    e5 = energy_weight(5.0)

    ratio = e5 / e4
    assert 30 < ratio < 34  # ~10^1.5 ≈ 31.6


def test_energy_weight_zero():
    """Test energía en magnitud 0."""
    e0 = energy_weight(0.0)
    assert e0 == 1.0  # 10^0 = 1


def test_ms_to_iso():
    """Test conversión timestamp UNIX ms a ISO."""
    # 2025-10-28 22:26:39 UTC
    ms = 1730155599000
    iso = ms_to_iso(ms)

    assert "2025-10-28" in iso
    assert "22:26:39" in iso
