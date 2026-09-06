"""Tests del estimador de b-value de Gutenberg-Richter (Aki-Utsu MLE).

Todos los valores esperados están calculados a mano (Python, 2026-09-05) a
partir de catálogos sintéticos `round(10^(a − b·M))` por bin. Ninguno afirma
"es un número": el catálogo b=1.0 espera 0.9963 y el b=1.5 espera 1.4853, así
que un estimador que devuelva siempre la misma constante no puede pasar los
dos. La tolerancia `[0.90, 1.10]` del primero está calibrada para dejar AFUERA
el 1.1254 que da la MLE SIN la corrección de binning de Utsu (mutación M2).

Los umbrales (`MIN_EVENTS`, `BIN_WIDTH`, `MC_CORRECTION`) se comparan contra
`dashboard/lib/seismic-constants.json` leído en el propio test, no contra
literales: si el módulo dejara de leer el JSON, esto se pone rojo.
"""

import json
import math
from pathlib import Path

import pytest

from src.models.event import SeismicEvent
from src.services.gutenberg_richter import (
    BIN_WIDTH,
    MC_CORRECTION,
    METHOD,
    MIN_EVENTS,
    estimate_mc_maxc,
    fit_b_value,
    mag_type_counts,
    magnitude_bins,
)

_CONSTANTS_PATH = (
    Path(__file__).resolve().parents[2] / "dashboard" / "lib" / "seismic-constants.json"
)


def synthetic_catalog(
    a: float, b: float, lo: float = 2.0, hi: float = 6.0
) -> tuple[list[float], list[tuple[float, int]]]:
    """Catálogo sintético: para cada bin M en [lo, hi] con paso BIN_WIDTH,
    `round(10^(a − b·M))` eventos con magnitud exactamente M. Devuelve
    (magnitudes, [(M, conteo)]) — los bins con conteo 0 se omiten."""
    n_bins = int(round((hi - lo) / BIN_WIDTH)) + 1
    mags: list[float] = []
    counts: list[tuple[float, int]] = []
    for i in range(n_bins):
        m = round(lo + i * BIN_WIDTH, 1)
        count = int(round(10 ** (a - b * m)))
        if count == 0:
            continue
        counts.append((m, count))
        mags.extend([m] * count)
    return mags, counts


class TestConstantsFromSharedJson:
    def test_las_constantes_salen_del_json_compartido(self) -> None:
        constants = json.loads(_CONSTANTS_PATH.read_text(encoding="utf-8"))
        assert MIN_EVENTS == constants["bValueMinEvents"]
        assert BIN_WIDTH == constants["magnitudeBinWidth"]
        assert MC_CORRECTION == constants["mcCorrection"]

    def test_la_guarda_de_n_es_al_menos_50(self) -> None:
        # Aki: σ_b ≈ b/√N; con N=50 ya es ±0.14. Una guarda menor no es una guarda.
        assert MIN_EVENTS >= 50


class TestFitBValueOk:
    def test_catalogo_b_1_0_recupera_b_cerca_de_1(self) -> None:
        mags, counts = synthetic_catalog(6.0, 1.0)
        assert [c for _, c in counts[:5]] == [10000, 7943, 6310, 5012, 3981]
        assert [c for _, c in counts[-5:]] == [3, 2, 2, 1, 1]
        assert len(mags) == 48617

        result = fit_b_value(mags, mc=2.0)

        assert result.status == "ok"
        assert result.method == METHOD == "aki-utsu-mle"
        assert result.n_above_mc == 48617
        assert result.n_total == 48617
        # A mano: mean = 2.3859; b = 0.4343 / (2.3859 − 1.95) = 0.9963.
        # SIN Utsu daría 0.4343 / 0.3859 = 1.1254: queda afuera de este rango.
        assert 0.90 <= result.b <= 1.10
        assert result.b == pytest.approx(0.9963, abs=0.0005)
        assert result.sigma_b == pytest.approx(0.00447, abs=0.0001)
        assert result.a == pytest.approx(math.log10(48617) + result.b * 2.0)
        assert result.min_events == MIN_EVENTS

    def test_catalogo_b_1_5_recupera_b_cerca_de_1_5(self) -> None:
        mags, counts = synthetic_catalog(8.0, 1.5)
        assert [c for _, c in counts[:5]] == [100000, 70795, 50119, 35481, 25119]
        assert len(mags) == 342402

        result = fit_b_value(mags, mc=2.0)

        assert result.status == "ok"
        # A mano: mean = 2.2424; b = 0.4343 / (2.2424 − 1.95) = 1.4853.
        assert 1.40 <= result.b <= 1.60
        assert result.b == pytest.approx(1.4853, abs=0.0005)

    def test_es_determinista(self) -> None:
        mags, _ = synthetic_catalog(6.0, 1.0)
        first = fit_b_value(mags, mc=2.0)
        second = fit_b_value(list(mags), mc=2.0)
        assert first == second
        # El orden de la lista no cambia el resultado (más allá del redondeo de la suma).
        reordered = fit_b_value(list(reversed(mags)), mc=2.0)
        assert reordered.status == "ok"
        assert reordered.b == pytest.approx(first.b, abs=1e-12)
        assert reordered.bins == first.bins


class TestFitBValueNotEstimable:
    def test_recorte_por_debajo_del_minimo_es_insuficiente_sin_b(self) -> None:
        mags, counts = synthetic_catalog(6.0, 1.0)
        # M_cut se construye DESDE la constante importada: el menor bin cuyo
        # conteo acumulado queda por debajo de MIN_EVENTS (con 50 es 5.0 ⇒ 45).
        m_cut = next(
            m for m, _ in counts if sum(c for mm, c in counts if mm >= m - 1e-9) < MIN_EVENTS
        )
        subset = [m for m in mags if m >= m_cut - 1e-9]
        assert len(subset) < MIN_EVENTS

        result = fit_b_value(subset, mc=m_cut)

        assert result.status == "insufficient"
        assert not hasattr(result, "b")
        assert not hasattr(result, "a")
        assert not hasattr(result, "sigma_b")
        assert result.n_above_mc == len(subset)
        assert result.min_events == MIN_EVENTS

    def test_n_se_cuenta_despues_de_filtrar_por_mc(self) -> None:
        above = [3.0 + 0.1 * (i % 5) for i in range(MIN_EVENTS - 1)]
        below = [1.0 + 0.1 * (i % 19) for i in range(1000 - len(above))]
        mags = below + above
        assert len(mags) == 1000

        result = fit_b_value(mags, mc=3.0)

        assert result.status == "insufficient"
        assert result.n_above_mc == MIN_EVENTS - 1
        assert result.n_total == 1000
        assert not hasattr(result, "b")

    def test_catalogo_vacio_es_insuficiente_sin_excepcion(self) -> None:
        auto = fit_b_value([], mc=None)
        assert auto.status == "insufficient"
        assert auto.n_total == 0
        assert auto.n_above_mc == 0
        assert auto.mc is None
        assert auto.bins == []
        assert not hasattr(auto, "b")

        explicit = fit_b_value([], mc=2.0)
        assert explicit.status == "insufficient"
        assert explicit.n_total == 0
        assert explicit.mc == 2.0

    def test_todas_las_magnitudes_iguales_es_degenerado(self) -> None:
        mags = [3.0] * (MIN_EVENTS + 10)

        result = fit_b_value(mags, mc=3.0)

        # La MLE daría log10(e) / (ΔM/2) = 8.69, serializable y absurdo.
        assert result.status == "degenerate"
        assert result.n_above_mc == MIN_EVENTS + 10
        assert not hasattr(result, "b")


class TestMcAutomatico:
    def test_mc_cae_en_el_pico_del_histograma_y_avisa_el_piso(self) -> None:
        mags, _ = synthetic_catalog(6.0, 1.0)

        result = fit_b_value(mags, mc=None)

        assert result.mc == pytest.approx(2.0 + MC_CORRECTION)
        assert result.mc_at_catalog_floor is True
        assert result.status == "ok"
        assert 0.90 <= result.b <= 1.10
        # A mano sobre M ≥ 2.2: N = 30674, mean = 2.5858, b = 0.9966.
        assert result.n_above_mc == 30674
        assert result.b == pytest.approx(0.9966, abs=0.0005)

    def test_estimate_mc_maxc_sin_bins_devuelve_none(self) -> None:
        assert estimate_mc_maxc([]) == (None, False)

    def test_pico_por_encima_del_piso_no_avisa(self) -> None:
        # Pico en 3.0 con un bin más bajo (2.0) poco poblado: Mc = 3.2, sin aviso.
        bins = magnitude_bins([2.0] * 3 + [3.0] * 10 + [3.1] * 4)
        mc, at_floor = estimate_mc_maxc(bins)
        assert mc == pytest.approx(3.0 + MC_CORRECTION)
        assert at_floor is False


class TestMagnitudeBins:
    def test_conteo_por_bin_y_acumulado(self) -> None:
        mags, counts = synthetic_catalog(6.0, 1.0, lo=2.0, hi=2.4)
        # [10000, 7943, 6310, 5012, 3981]
        bins = magnitude_bins(mags)

        assert [(b.m, b.count) for b in bins] == counts
        total = sum(c for _, c in counts)
        expected_cumulative = []
        seen = 0
        for _, c in counts:
            expected_cumulative.append(total - seen)
            seen += c
        assert [b.cumulative for b in bins] == expected_cumulative

    def test_bins_contiguos_con_huecos_en_cero(self) -> None:
        # 2.0 y 2.3 con nada en el medio: el histograma NO saltea 2.1 y 2.2.
        bins = magnitude_bins([2.0, 2.0, 2.3])
        assert [(b.m, b.count, b.cumulative) for b in bins] == [
            (2.0, 2, 3),
            (2.1, 0, 1),
            (2.2, 0, 1),
            (2.3, 1, 1),
        ]

    def test_una_magnitud_intermedia_cae_en_el_bin_de_su_piso(self) -> None:
        # 2.34 pertenece al bin [2.3, 2.4); el piso se calcula sin errores de
        # coma flotante (2.3 / 0.1 = 22.999… no puede caer en 2.2).
        bins = magnitude_bins([2.34, 2.3])
        assert [(b.m, b.count) for b in bins] == [(2.3, 2)]


class TestMagTypeCounts:
    def test_cuenta_por_tipo_y_none_como_unknown(self) -> None:
        def ev(mag_tipo: str | None) -> SeismicEvent:
            return SeismicEvent(
                id=f"x{mag_tipo}",
                hora_utc="2026-09-05T00:00:00Z",
                lat=0.0,
                lon=0.0,
                mag=3.0,
                mag_tipo=mag_tipo,
            )

        counts = mag_type_counts([ev("Mw"), ev("ML"), ev("ML"), ev(None), ev(None), ev(None)])
        assert counts == {"Mw": 1, "ML": 2, "unknown": 3}
