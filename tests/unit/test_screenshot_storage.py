"""Tests unitarios de ScreenshotStorageService (feedback-screenshot-attachment,
tarea 2.2). Sin base ni red: `boto3.client(...)` valida forma de credenciales
al construirse, no las verifica contra R2 real — así que estos tests corren
sin ningún socket abierto (molde: unit puro, no integration).

Contrato (design.md Decision 2): las 4 variables presentes ⇒ `enabled=True`;
falta CUALQUIERA de las 4 ⇒ `enabled=False`, construcción SIN excepción
(degrada, no rompe — mismo criterio que EmailService).
"""

import itertools

import pytest

from src.services.screenshot_storage import ScreenshotStorageService

_ALL_VARS = {
    "endpoint_url": "https://fake.r2.cloudflarestorage.com",
    "bucket": "feedback-screenshots-test",
    "access_key_id": "fake-access-key-id",
    "secret_access_key": "fake-secret-access-key",
}


def test_las_cuatro_variables_presentes_habilitan_el_servicio_sin_abrir_socket():
    service = ScreenshotStorageService(**_ALL_VARS)
    assert service.enabled is True


@pytest.mark.parametrize("missing", list(_ALL_VARS))
def test_falta_una_variable_deshabilita_sin_excepcion(missing):
    kwargs = dict(_ALL_VARS)
    kwargs[missing] = None
    service = ScreenshotStorageService(**kwargs)  # no debe lanzar
    assert service.enabled is False


def test_las_cuatro_combinaciones_de_una_sola_variable_ausente_deshabilitan():
    """Parametrizado explícito de las 4 combinaciones (tasks.md 2.2): cada
    variable, sola, ausente ⇒ enabled False. Redundante con el test de arriba
    a propósito — deja la matriz completa explícita en un solo lugar."""
    for missing in itertools.combinations(_ALL_VARS, 1):
        kwargs = dict(_ALL_VARS)
        kwargs[missing[0]] = None
        service = ScreenshotStorageService(**kwargs)
        assert service.enabled is False, f"faltando {missing[0]} debería deshabilitar"


def test_las_cuatro_variables_ausentes_deshabilita_sin_excepcion():
    service = ScreenshotStorageService(
        endpoint_url=None, bucket=None, access_key_id=None, secret_access_key=None
    )
    assert service.enabled is False


def test_create_upload_url_con_enabled_false_asume_precondicion_del_caller():
    """El design NO especifica si el service debe lanzar cuando `enabled` es
    False: la responsabilidad de chequear `enabled` antes de llamar es 100%
    del router (ver docstring de create_upload_url/create_download_url en el
    propio servicio). Este test documenta esa asunción: cualquier excepción
    que salga (AttributeError sobre client=None, la más probable) es
    aceptable, PORQUE el router SIEMPRE guardia con `if not storage.enabled`
    antes de llamar — el caso "enabled=False y aun así se llama" no es un
    contrato soportado, es un misuse del caller."""
    service = ScreenshotStorageService(
        endpoint_url=None, bucket=None, access_key_id=None, secret_access_key=None
    )
    assert service.enabled is False
    with pytest.raises(Exception):
        service.create_upload_url()
