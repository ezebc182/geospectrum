"""Regla de elegibilidad del cache eterno: `covers_window`.

Un resultado de ventana absoluta solo puede persistirse SIN vencimiento si el
trace devuelto cubre la ventana pedida. Congelar un parcial para siempre
serviría datos incompletos aun cuando FDSN ya tenga la ventana entera.

La tolerancia existe porque FDSN alinea los bordes al sample: un trace que
arranca 2 s después de `start` sigue siendo la ventana pedida a efectos
prácticos, no un parcial.
"""

from datetime import datetime, timedelta, timezone

from src.services.fdsn_result_cache import covers_window

START = datetime(2019, 4, 18, 20, 0, 0, tzinfo=timezone.utc)
END = datetime(2019, 4, 18, 20, 10, 0, tzinfo=timezone.utc)


def _sec(s: float) -> timedelta:
    return timedelta(seconds=s)


def test_cobertura_exacta_es_elegible():
    assert covers_window(START, END, START, END) is True


def test_trace_mas_ancho_que_la_ventana_es_elegible():
    # FDSN suele devolver de más (se pide por horas y se recorta después).
    assert covers_window(START - _sec(30), END + _sec(30), START, END) is True


def test_trace_que_termina_antes_fuera_de_tolerancia_no_es_elegible():
    assert covers_window(START, END - _sec(6), START, END) is False


def test_trace_que_termina_antes_dentro_de_tolerancia_es_elegible():
    assert covers_window(START, END - _sec(4), START, END) is True


def test_trace_que_arranca_tarde_fuera_de_tolerancia_no_es_elegible():
    assert covers_window(START + _sec(6), END, START, END) is False


def test_trace_que_arranca_tarde_dentro_de_tolerancia_es_elegible():
    assert covers_window(START + _sec(4), END, START, END) is True


def test_el_borde_exacto_de_la_tolerancia_es_elegible():
    """Fija el operador en `<=`: exactamente 5 s de falta sigue siendo la
    ventana pedida. Si alguien lo cambia a `<`, ESTE test se pone en rojo."""
    assert covers_window(START, END - _sec(5), START, END) is True
    assert covers_window(START + _sec(5), END, START, END) is True


def test_tolerancia_configurable():
    # Con tolerancia 0, cualquier falta descalifica.
    assert covers_window(START, END - _sec(1), START, END, tolerance_seconds=0) is False
    assert covers_window(START, END, START, END, tolerance_seconds=0) is True


def test_corto_en_ambas_puntas_no_es_elegible():
    """Las dos faltas no se compensan: 4 s tarde y 4 s corto siguen dentro de
    la tolerancia POR PUNTA, pero 6 s en cualquiera de las dos descalifica."""
    assert covers_window(START + _sec(4), END - _sec(4), START, END) is True
    assert covers_window(START + _sec(6), END - _sec(4), START, END) is False
    assert covers_window(START + _sec(4), END - _sec(6), START, END) is False
