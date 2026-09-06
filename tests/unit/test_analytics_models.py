"""Modelos Pydantic de `/analytics` (analytics-professional-panels, 3.1).

Molde `test_feedback_models.py`: modelo pelado, sin base ni app. Lo que se
fija acá es la parte OBSERVABLE del contrato del design ("Interfaces /
Contracts"):

- `BValueOk` exige `b`, `a`, `sigma_b` y `status == "ok"`.
- `BValueNotEstimable` NO declara `b` ([R8]: en "insuficiente" el campo no
  existe, ni siquiera como `null`) y rechaza `status == "ok"` ([R9]: el
  tercer estado es `degenerate`, nunca `ok`).
- `BValueResponse` discrimina por `status`.
- `null` ≠ `0` en uptime y tremor ([R12], [R4]): `ratio`, `overall[ch]`,
  `baseline_rsam` y `threshold_rsam` admiten `None`.
- `TremorEpisode` exige `samples`, `mean_ratio`, `band` y `fi_sign` con los
  `Literal` del design.
"""

from datetime import datetime, timezone

import pytest
from pydantic import TypeAdapter, ValidationError

from src.models.analytics import (
    BValueNotEstimable,
    BValueOk,
    BValueResponse,
    HypocentersResponse,
    MagnitudeBin,
    StationUptimeResponse,
    TremorEpisode,
    TremorParameters,
    TremorResponse,
    UptimeBucket,
)
from src.models.event import SeismicEvent

T0 = datetime(2026, 9, 1, tzinfo=timezone.utc)
T1 = datetime(2026, 9, 2, tzinfo=timezone.utc)


def _bvalue_base(**overrides) -> dict:
    """Campos comunes a `BValueOk` y `BValueNotEstimable` (`_BValueBase`)."""
    data = {
        "method": "aki-utsu-mle",
        "n_total": 483,
        "n_above_mc": 483,
        "min_events": 50,
        "mc": 2.0,
        "mc_at_catalog_floor": True,
        "bins": [{"m": 2.0, "count": 100, "cumulative": 483}],
        "mag_type_counts": {"Mw": 400, "unknown": 83},
        "window_start": T0,
        "window_end": T1,
        "area_slug": "andes",
    }
    data.update(overrides)
    return data


def _episode(**overrides) -> dict:
    data = {
        "start": T0,
        "end": T1,
        "samples": 4,
        "duration_s": 2400,
        "mean_ratio": 3.0,
        "peak_rsam": 120.0,
        "peak_ratio": 4.0,
        "onset_ratio": 0.5,
        "mean_dominant_hz": 1.5,
        "mean_fi": -0.3,
        "band": "low",
        "fi_sign": "lp_like",
    }
    data.update(overrides)
    return data


# ---------------------------------------------------------------------------
# b-value: unión discriminada por `status`
# ---------------------------------------------------------------------------


class TestBValueOk:
    def test_acepta_el_contrato_completo(self):
        ok = BValueOk.model_validate(_bvalue_base(status="ok", b=0.9963, a=6.0, sigma_b=0.01))
        assert ok.status == "ok"
        assert ok.b == 0.9963
        assert ok.method == "aki-utsu-mle"
        assert isinstance(ok.bins[0], MagnitudeBin)

    @pytest.mark.parametrize("missing", ["b", "a", "sigma_b"])
    def test_exige_b_a_y_sigma_b(self, missing):
        data = _bvalue_base(status="ok", b=1.0, a=6.0, sigma_b=0.01)
        del data[missing]
        with pytest.raises(ValidationError):
            BValueOk.model_validate(data)

    @pytest.mark.parametrize("status", ["insufficient", "degenerate", "OK"])
    def test_rechaza_status_distinto_de_ok(self, status):
        with pytest.raises(ValidationError):
            BValueOk.model_validate(_bvalue_base(status=status, b=1.0, a=6.0, sigma_b=0.01))

    def test_rechaza_method_desconocido(self):
        with pytest.raises(ValidationError):
            BValueOk.model_validate(
                _bvalue_base(status="ok", b=1.0, a=6.0, sigma_b=0.01, method="least-squares")
            )


class TestBValueNotEstimable:
    def test_no_declara_el_campo_b(self):
        """[R8]: `"b" not in body` se afirma end-to-end en 3.5; acá, en el tipo."""
        assert "b" not in BValueNotEstimable.model_fields
        assert "a" not in BValueNotEstimable.model_fields
        assert "sigma_b" not in BValueNotEstimable.model_fields

    @pytest.mark.parametrize("status", ["insufficient", "degenerate"])
    def test_acepta_los_dos_estados_no_estimables(self, status):
        result = BValueNotEstimable.model_validate(_bvalue_base(status=status, n_above_mc=45))
        assert result.status == status
        assert result.n_above_mc == 45

    def test_rechaza_status_ok(self):
        with pytest.raises(ValidationError):
            BValueNotEstimable.model_validate(_bvalue_base(status="ok"))

    def test_mc_admite_none_con_catalogo_vacio(self):
        result = BValueNotEstimable.model_validate(
            _bvalue_base(status="insufficient", n_total=0, n_above_mc=0, mc=None, bins=[])
        )
        assert result.mc is None
        assert result.bins == []

    def test_al_serializar_el_dict_no_contiene_b(self):
        body = BValueNotEstimable.model_validate(
            _bvalue_base(status="insufficient", n_above_mc=45)
        ).model_dump(mode="json")
        assert "b" not in body
        assert body["status"] == "insufficient"
        assert body["min_events"] == 50


class TestBValueResponseDiscriminada:
    adapter = TypeAdapter(BValueResponse)

    def test_status_ok_resuelve_a_bvalue_ok(self):
        parsed = self.adapter.validate_python(_bvalue_base(status="ok", b=1.0, a=6.0, sigma_b=0.01))
        assert isinstance(parsed, BValueOk)

    @pytest.mark.parametrize("status", ["insufficient", "degenerate"])
    def test_status_no_estimable_resuelve_a_not_estimable(self, status):
        parsed = self.adapter.validate_python(_bvalue_base(status=status))
        assert isinstance(parsed, BValueNotEstimable)

    def test_status_ok_sin_b_es_error_no_degradacion(self):
        """Con el discriminador, `status=ok` sin `b` NO cae en silencio al otro
        miembro de la unión: es un 422/ValidationError."""
        with pytest.raises(ValidationError):
            self.adapter.validate_python(_bvalue_base(status="ok"))

    def test_status_desconocido_es_error(self):
        with pytest.raises(ValidationError):
            self.adapter.validate_python(_bvalue_base(status="maybe"))

    def test_serializar_not_estimable_via_la_union_no_agrega_b(self):
        instance = BValueNotEstimable.model_validate(_bvalue_base(status="degenerate"))
        body = self.adapter.dump_python(instance, mode="json")
        assert "b" not in body
        assert body["status"] == "degenerate"
        assert body["window_start"] == "2026-09-01T00:00:00Z"


# ---------------------------------------------------------------------------
# hipocentros
# ---------------------------------------------------------------------------


class TestHypocentersResponse:
    def test_prof_km_nula_viaja_como_null(self):
        event = SeismicEvent(
            id="inpres_1",
            hora_utc="2026-09-01T00:00:00Z",
            lat=-31.8,
            lon=-68.3,
            prof_km=None,
            mag=4.2,
        )
        body = HypocentersResponse(
            eventos=[event],
            total=1,
            truncated=False,
            window_start=T0,
            window_end=T1,
            area_slug=None,
        ).model_dump(mode="json")
        assert body["eventos"][0]["prof_km"] is None
        assert body["truncated"] is False
        assert body["area_slug"] is None

    def test_exige_total_y_truncated(self):
        with pytest.raises(ValidationError):
            HypocentersResponse.model_validate(
                {"eventos": [], "window_start": T0, "window_end": T1, "area_slug": None}
            )


# ---------------------------------------------------------------------------
# uptime: null ≠ 0 [R12]
# ---------------------------------------------------------------------------


class TestUptimeModels:
    def test_ratio_admite_none_y_cero_como_valores_distintos(self):
        nadie_miro = UptimeBucket(
            bucket_start=T0,
            columns_count=0,
            observed_hours=0,
            expected=0,
            ratio=None,
            in_progress=False,
        )
        mudo = UptimeBucket(
            bucket_start=T0,
            columns_count=0,
            observed_hours=1,
            expected=900,
            ratio=0.0,
            in_progress=False,
        )
        assert nadie_miro.ratio is None
        assert mudo.ratio == 0.0
        assert nadie_miro.model_dump(mode="json")["ratio"] is None

    def test_ratio_es_obligatorio_aunque_admita_none(self):
        with pytest.raises(ValidationError):
            UptimeBucket.model_validate(
                {
                    "bucket_start": T0,
                    "columns_count": 0,
                    "observed_hours": 0,
                    "expected": 0,
                    "in_progress": False,
                }
            )

    def test_overall_admite_none_por_canal(self):
        response = StationUptimeResponse(
            bucket="day",
            window_start=T0,
            window_end=T1,
            expected_columns_per_hour=900,
            stations={"GE.KBU..BHZ": [], "XX.NOPE..BHZ": []},
            overall={"GE.KBU..BHZ": 1.0, "XX.NOPE..BHZ": None},
        )
        body = response.model_dump(mode="json")
        assert body["overall"]["XX.NOPE..BHZ"] is None
        assert body["overall"]["GE.KBU..BHZ"] == 1.0

    def test_bucket_solo_hour_o_day(self):
        with pytest.raises(ValidationError):
            StationUptimeResponse(
                bucket="week",
                window_start=T0,
                window_end=T1,
                expected_columns_per_hour=900,
                stations={},
                overall={},
            )


# ---------------------------------------------------------------------------
# tremor [R4]
# ---------------------------------------------------------------------------


class TestTremorModels:
    def test_episode_acepta_el_contrato_completo(self):
        episode = TremorEpisode.model_validate(_episode())
        assert episode.samples == 4
        assert episode.mean_ratio == 3.0
        assert episode.band == "low"
        assert episode.fi_sign == "lp_like"

    @pytest.mark.parametrize("missing", ["samples", "mean_ratio", "band", "fi_sign"])
    def test_episode_exige_los_campos_de_la_spec(self, missing):
        data = _episode()
        del data[missing]
        with pytest.raises(ValidationError):
            TremorEpisode.model_validate(data)

    @pytest.mark.parametrize("band", ["low", "mid", "high", "undefined"])
    def test_episode_acepta_las_cuatro_bandas(self, band):
        assert TremorEpisode.model_validate(_episode(band=band)).band == band

    @pytest.mark.parametrize(
        ("field", "value"),
        [("band", "ultra"), ("fi_sign", "positive"), ("fi_sign", "lp")],
    )
    def test_episode_rechaza_literales_fuera_del_design(self, field, value):
        with pytest.raises(ValidationError):
            TremorEpisode.model_validate(_episode(**{field: value}))

    def test_episode_admite_none_en_los_promedios_espectrales(self):
        episode = TremorEpisode.model_validate(
            _episode(mean_dominant_hz=None, mean_fi=None, band="undefined", fi_sign="undefined")
        )
        assert episode.mean_dominant_hz is None
        assert episode.mean_fi is None

    def test_response_sin_datos_lleva_baseline_y_threshold_none(self):
        response = TremorResponse(
            channel="GE.KBU..BHZ",
            sampling_rate=20.0,
            period_seconds=600,
            baseline_rsam=None,
            threshold_rsam=None,
            tremor_fraction=0.0,
            parameters=TremorParameters(baseline_factor=2.0, min_duration_periods=3),
            samples=[],
            episodes=[],
        )
        body = response.model_dump(mode="json")
        assert body["baseline_rsam"] is None
        assert body["threshold_rsam"] is None
        assert body["tremor_fraction"] == 0.0
        assert body["parameters"] == {"baseline_factor": 2.0, "min_duration_periods": 3}

    def test_response_exige_parameters_y_tremor_fraction(self):
        with pytest.raises(ValidationError):
            TremorResponse.model_validate(
                {
                    "channel": "GE.KBU..BHZ",
                    "sampling_rate": 20.0,
                    "period_seconds": 600,
                    "baseline_rsam": 40.0,
                    "threshold_rsam": 80.0,
                    "samples": [],
                    "episodes": [],
                }
            )
