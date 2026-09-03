"""Modelos Pydantic del feedback de beta (change feedback-beta-testers, 2.1).

Molde `test_locale_models.py`: `pytest.raises(ValidationError)` sobre el
modelo pelado, sin base ni app. Los límites (2000 / 300 / 2000 / 400) son
los MISMOS que los CHECK de la migración 019: acá se prueba que la API
adelanta el rechazo a un 422 legible, no que lo reemplaza.

Punto 6 de la reconciliación specs ↔ design: `user_agent` es OBLIGATORIO
(ausente ⇒ error) pero admite `""`.
"""

import pytest
from pydantic import ValidationError

from src.models.feedback import (
    FeedbackAdminCommentUpdate,
    FeedbackReportCreate,
    FeedbackReportItem,
    FeedbackStatusUpdate,
)

VALID_STATUSES = ("new", "in_analysis", "in_progress", "done", "discarded")


def _payload(**overrides) -> dict:
    data = {
        "type": "bug",
        "body": "El helicorder no carga",
        "route": "/spectrograms",
        "url": "https://app.example.com/spectrograms",
        "user_agent": "pytest",
    }
    data.update(overrides)
    return data


# ---------------------------------------------------------------------------
# FeedbackReportCreate
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("kind", ["bug", "suggestion"])
def test_create_acepta_los_dos_tipos(kind):
    report = FeedbackReportCreate.model_validate(_payload(type=kind))
    assert report.type == kind


def test_create_rechaza_type_ausente():
    data = _payload()
    del data["type"]
    with pytest.raises(ValidationError):
        FeedbackReportCreate.model_validate(data)


def test_create_rechaza_type_fuera_del_enum():
    with pytest.raises(ValidationError):
        FeedbackReportCreate.model_validate(_payload(type="question"))


@pytest.mark.parametrize(
    "body",
    [
        pytest.param("", id="vacio"),
        pytest.param("   \n\t  ", id="solo-espacios"),
        pytest.param("x" * 2001, id="2001"),
    ],
)
def test_create_rechaza_body_invalido(body):
    with pytest.raises(ValidationError):
        FeedbackReportCreate.model_validate(_payload(body=body))


def test_create_acepta_body_de_2000_exactos_sin_alterarlo():
    body = "b" * 2000
    report = FeedbackReportCreate.model_validate(_payload(body=body))
    assert report.body == body


def test_create_no_recorta_el_body_con_espacios_exteriores():
    """El validator rechaza el vacío pero NO altera lo que se persiste."""
    report = FeedbackReportCreate.model_validate(_payload(body="  hola  "))
    assert report.body == "  hola  "


@pytest.mark.parametrize(
    "field,value",
    [
        pytest.param("route", "r" * 301, id="route-301"),
        pytest.param("url", "u" * 2001, id="url-2001"),
        pytest.param("user_agent", "a" * 401, id="user-agent-401"),
    ],
)
def test_create_rechaza_contexto_sobredimensionado(field, value):
    with pytest.raises(ValidationError):
        FeedbackReportCreate.model_validate(_payload(**{field: value}))


def test_create_acepta_contexto_en_el_limite_exacto():
    report = FeedbackReportCreate.model_validate(
        _payload(route="r" * 300, url="u" * 2000, user_agent="a" * 400)
    )
    assert len(report.route) == 300
    assert len(report.url) == 2000
    assert len(report.user_agent) == 400


def test_create_acepta_user_agent_vacio():
    report = FeedbackReportCreate.model_validate(_payload(user_agent=""))
    assert report.user_agent == ""


@pytest.mark.parametrize("field", ["route", "url", "user_agent"])
def test_create_rechaza_contexto_ausente(field):
    """Punto 6 de la reconciliación: los tres campos son obligatorios."""
    data = _payload()
    del data[field]
    with pytest.raises(ValidationError):
        FeedbackReportCreate.model_validate(data)


def test_create_no_expone_user_id_created_at_ni_status():
    report = FeedbackReportCreate.model_validate(
        _payload(
            user_id="11111111-1111-1111-1111-111111111111",
            created_at="2020-01-01T00:00:00Z",
            status="done",
        )
    )
    for attr in ("user_id", "created_at", "status"):
        assert not hasattr(report, attr), attr
        assert attr not in report.model_dump()


# ---------------------------------------------------------------------------
# FeedbackStatusUpdate
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("status", VALID_STATUSES)
def test_status_update_acepta_los_cinco_valores(status):
    assert FeedbackStatusUpdate.model_validate({"status": status}).status == status


@pytest.mark.parametrize("invalid", ["resolved", "Hecho"])
def test_status_update_rechaza_valores_fuera_del_enum(invalid):
    with pytest.raises(ValidationError):
        FeedbackStatusUpdate.model_validate({"status": invalid})


def test_status_update_rechaza_status_ausente():
    with pytest.raises(ValidationError):
        FeedbackStatusUpdate.model_validate({})


# ---------------------------------------------------------------------------
# FeedbackAdminCommentUpdate
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "value",
    [
        pytest.param(None, id="null"),
        pytest.param("", id="vacio"),
        pytest.param("   ", id="solo-espacios"),
    ],
)
def test_comment_update_normaliza_vacio_a_none(value):
    assert FeedbackAdminCommentUpdate.model_validate({"comment": value}).comment is None


def test_comment_update_recorta_espacios_exteriores():
    assert FeedbackAdminCommentUpdate.model_validate({"comment": " x "}).comment == "x"


def test_comment_update_rechaza_2001():
    with pytest.raises(ValidationError):
        FeedbackAdminCommentUpdate.model_validate({"comment": "c" * 2001})


def test_comment_update_acepta_2000_exactos():
    text = "c" * 2000
    assert FeedbackAdminCommentUpdate.model_validate({"comment": text}).comment == text


# ---------------------------------------------------------------------------
# FeedbackReportItem
# ---------------------------------------------------------------------------


def test_item_acepta_timestamps_nulos_de_movimiento_y_comentario():
    """Reconciliación 3: `status_changed_at` nace null hasta el primer
    movimiento; `admin_comment_updated_at` va en par con `admin_comment`."""
    item = FeedbackReportItem.model_validate(
        {
            "id": "3f9a2b1c-1111-2222-3333-444455556680",
            "type": "bug",
            "body": "x",
            "route": "/",
            "url": "https://a.b/",
            "user_agent": "",
            "author_email": "a@example.com",
            "created_at": "2026-09-03T00:00:00Z",
            "status": "new",
            "status_changed_at": None,
            "admin_comment": None,
            "admin_comment_updated_at": None,
        }
    )
    assert item.status_changed_at is None
    assert item.admin_comment_updated_at is None
