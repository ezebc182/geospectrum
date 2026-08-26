"""Tests de las fórmulas sismológicas de picking (S-P → distancia, coda → magnitud).

Todos los valores esperados están calculados a mano a partir de las constantes
de `dashboard/lib/seismic-constants.json` (vp=6.0, vp/vs=1.73, Mc=1.86·log10(t)-0.85).
Ninguno verifica "devuelve un número": este repo ya produjo tres tests verdes
que no podían fallar y acá el número equivocado termina en un CSV de mediciones.

Los MISMOS valores esperados viven en `dashboard/lib/signal-picks.test.ts`:
si las dos implementaciones divergen, los dos tests no pueden estar verdes a la vez.
"""

import pytest

from src.services.signal_picks import (
    CODA_A,
    CODA_B,
    P_VELOCITY_KM_S,
    S_VELOCITY_KM_S,
    VP_VS_RATIO,
    coda_magnitude,
    sp_distance_km,
)


class TestConstantsFromSharedJson:
    """Las constantes salen del JSON compartido, no de literales propios."""

    def test_module_exposes_expected_constants(self) -> None:
        # Si el JSON cambia, estos asertos cambian con él: fijan que la carga
        # leyó las claves correctas, no que los valores sean eternos.
        assert P_VELOCITY_KM_S == 6.0
        assert VP_VS_RATIO == 1.73
        assert CODA_A == 1.86
        assert CODA_B == -0.85

    def test_s_velocity_is_derived_not_declared(self) -> None:
        # vs se deriva de vp y el ratio; declararla aparte crearía una quinta
        # constante que podría divergir de las cuatro del JSON.
        assert S_VELOCITY_KM_S == pytest.approx(P_VELOCITY_KM_S / VP_VS_RATIO)


class TestSpDistanceKm:
    """d = (tS - tP) · (vp·vs)/(vp - vs), con vp=6.0 y vp/vs=1.73."""

    def test_sp_10_seconds_gives_82_1918_km(self) -> None:
        assert sp_distance_km(10.0) == pytest.approx(82.1918, abs=0.001)

    def test_sp_5_seconds_gives_41_0959_km(self) -> None:
        assert sp_distance_km(5.0) == pytest.approx(41.0959, abs=0.001)

    def test_sp_1_second_gives_8_2192_km(self) -> None:
        assert sp_distance_km(1.0) == pytest.approx(8.2192, abs=0.001)

    def test_sp_zero_gives_none(self) -> None:
        assert sp_distance_km(0.0) is None

    def test_sp_negative_gives_none(self) -> None:
        # Sin la guarda daría -24.657: un número perfectamente serializable
        # que la UI dibujaría como medición. None obliga a tratarlo.
        assert sp_distance_km(-3.0) is None

    def test_sp_nan_gives_none(self) -> None:
        assert sp_distance_km(float("nan")) is None

    def test_sp_infinity_gives_none(self) -> None:
        assert sp_distance_km(float("inf")) is None


class TestCodaMagnitude:
    """Mc = 1.86 · log10(t) - 0.85."""

    def test_coda_100_seconds_gives_2_87(self) -> None:
        assert coda_magnitude(100.0) == pytest.approx(2.87, abs=1e-6)

    def test_coda_10_seconds_gives_1_01(self) -> None:
        assert coda_magnitude(10.0) == pytest.approx(1.01, abs=1e-6)

    def test_coda_1_second_gives_minus_0_85(self) -> None:
        # Negativo y CORRECTO: no se recorta a cero.
        assert coda_magnitude(1.0) == pytest.approx(-0.85, abs=1e-6)

    def test_coda_60_seconds_gives_2_4574(self) -> None:
        # Los otros tres casos usan potencias exactas de 10, donde log10 da
        # enteros: este es el que detecta un log natural o un atajo por
        # conteo de dígitos.
        assert coda_magnitude(60.0) == pytest.approx(2.4574, abs=1e-4)

    def test_coda_zero_gives_none(self) -> None:
        # Sin la guarda, t=0 propaga -Infinity hasta la UI y el CSV.
        assert coda_magnitude(0.0) is None

    def test_coda_negative_gives_none(self) -> None:
        # Sin la guarda, t<0 propaga NaN.
        assert coda_magnitude(-5.0) is None

    def test_coda_nan_gives_none(self) -> None:
        assert coda_magnitude(float("nan")) is None

    def test_coda_infinity_gives_none(self) -> None:
        assert coda_magnitude(float("inf")) is None
