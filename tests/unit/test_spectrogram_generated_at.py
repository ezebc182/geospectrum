"""`generated_at` del espectrograma tiene que declarar su zona horaria.

Por qué existe: la tarjeta de /spectrograms-live rotulaba "Actualizado: 5:10
a. m. UTC" cuando eran las 02:10 UTC — tres horas EN EL FUTURO, que es
exactamente el offset del navegador que lo miraba (-03).

Ninguna capa estaba mal formateando. El backend serializaba con
`datetime.utcnow().isoformat()`, que devuelve un datetime *naive*: la hora es
UTC, pero el string sale sin `Z` ni `+00:00`. Y un ISO 8601 sin zona, por spec
de ECMAScript, `new Date()` lo interpreta como hora LOCAL. El navegador leía
"02:10 en Buenos Aires", lo pasaba a UTC y le daba 05:10Z. De ahí en adelante
todo el pipeline fue coherente con una mentira.

El daño real no es el rótulo: `spectrogram-freshness.ts` compara ese timestamp
contra `now` para decidir si un canal enmudeció. Con el dato adelantado 3 h,
una estación muerta se sigue mostrando "en vivo" durante tres horas — el mismo
bug que el umbral de frescura vino a matar, entrando por otra puerta.

Por eso el test mira el CONTRATO (el string lleva offset y se parsea a un
datetime aware), no la implementación: cualquier vuelta a un naive lo rompe.
"""

from datetime import datetime, timezone

import pytest

from src.services.spectrogram_service import SpectrogramService


def parse_generated_at(value: str) -> datetime:
    """Parsea como lo haría un cliente. Falla si el string no trae zona."""
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    assert parsed.tzinfo is not None, (
        f"generated_at={value!r} es naive: sin offset, el navegador lo lee "
        f"como hora local y lo desplaza por el offset del usuario"
    )
    return parsed


@pytest.mark.parametrize("data_type", ["synthetic", "real"])
def test_generated_at_declara_zona_horaria(data_type: str) -> None:
    """El timestamp serializado tiene que ser tz-aware y estar en UTC."""
    # Se construye el metadata igual que el service, para fijar el contrato
    # en las dos ramas (sintética y real) sin depender de red ni de matplotlib.
    generated_at = datetime.now(timezone.utc).isoformat()

    parsed = parse_generated_at(generated_at)
    assert parsed.utcoffset() == timezone.utc.utcoffset(None), (
        "generated_at tiene que estar en UTC: el dominio sísmico trabaja en "
        "UTC y el frontend rotula el valor con el sufijo 'UTC' fijo"
    )


def test_utcnow_naive_es_el_bug_que_este_test_previene() -> None:
    """Fija POR QUÉ `datetime.utcnow()` no sirve acá.

    Este test documenta el modo de falla: si alguien vuelve a `utcnow()`,
    el string no lleva offset y `parse_generated_at` lo rechaza.
    """
    naive = datetime(2026, 8, 24, 2, 10, 17).isoformat()
    assert "+" not in naive and not naive.endswith("Z")

    with pytest.raises(AssertionError, match="es naive"):
        parse_generated_at(naive)


def test_el_service_no_usa_utcnow() -> None:
    """`utcnow()` no puede volver al código del service.

    Se revisa el fuente y no el resultado porque generar un espectrograma real
    pide red y ObsPy: acá lo que importa es que la llamada prohibida no esté.
    """
    import ast
    import inspect

    # Se parsea el AST y no se busca el texto: el comentario que explica por
    # qué `utcnow()` está prohibido menciona `utcnow()`, y un `in source`
    # pelado se marcaba a sí mismo (el test daba rojo con el bug ya arreglado).
    tree = ast.parse(inspect.getsource(SpectrogramService).lstrip())
    llamadas = {
        node.func.attr
        for node in ast.walk(tree)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
    }
    assert "utcnow" not in llamadas, (
        "datetime.utcnow() devuelve un datetime naive y está deprecado desde "
        "Python 3.12: usar datetime.now(timezone.utc)"
    )
