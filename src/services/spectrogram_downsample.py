"""
Reduce columnas de espectrograma al ancho real del canvas.

POR QUÉ EXISTE: las tarjetas de /spectrograms-live pedían un PNG generado con
matplotlib en el servidor — 24 h descargadas de FDSN, renderizadas y
codificadas en base64 (que además infla un 33%). Con 30 ubicaciones en
pantalla eso daba ~3,6 MB y decenas de segundos de espera.

El dato ya está en TimescaleDB gracias al ingestor, pero servirlo crudo es
PEOR: 24 h de un canal son ~21.600 columnas y `/history` ya devuelve 1,3 MB
con apenas 655. El canvas mide ~400 px y dibuja UNA columna por píxel, así
que todo lo que exceda ese ancho se descarta al pintar — mandarlo es tirar
ancho de banda.

EL CRITERIO ES EL PICO, NO EL PROMEDIO. Un sismo *es* el pico: promediar
—sobre una escala que además es logarítmica— aplanaría justo el evento que
el operador está buscando. Es el mismo razonamiento que la decimación
min/max de station_waveform.py, que ya está documentado en este proyecto.
"""

from __future__ import annotations

from typing import Any


def downsample_columns(columns: list[dict[str, Any]], width: int) -> list[dict[str, Any]]:
    """Colapsa `columns` a lo sumo `width` columnas, quedándose con los picos.

    :param columns: columnas tal como salen de TimescaleDB (endtime/freqs/power_db)
    :param width:   ancho del canvas en píxeles (1 columna = 1 píxel)
    """
    if width <= 0:
        return []
    # Sin dato de sobra no hay nada que reducir: agregar acá sólo inventaría
    # columnas que nadie midió.
    if len(columns) <= width:
        return columns

    # Bloques del mismo tamaño; el último absorbe el resto de la división
    # para no dejar columnas afuera.
    tamano = len(columns) / width
    reducidas: list[dict[str, Any]] = []

    for i in range(width):
        desde = int(i * tamano)
        hasta = len(columns) if i == width - 1 else int((i + 1) * tamano)
        bloque = columns[desde:hasta] or [columns[desde]]
        reducidas.append(_colapsar(bloque))

    return reducidas


def _colapsar(bloque: list[dict[str, Any]]) -> dict[str, Any]:
    """Una columna con el pico de cada bin de frecuencia del bloque.

    Se colapsa bin por bin y no eligiendo "la columna más fuerte": el pico
    puede estar en frecuencias distintas en columnas distintas, y quedarse
    con una sola perdería el resto del contenido espectral.
    """
    ultima = bloque[-1]
    # El eje de frecuencia puede cambiar DENTRO de un mismo canal (está
    # documentado en el proyecto), así que el largo se toma del más corto:
    # indexar de más reventaría la vista entera por un cambio de muestreo.
    n_bins = min(len(c["power_db"]) for c in bloque)

    # `round(_, 1)` no pierde información real: el ingestor ya guarda los dB
    # redondeados a 1 decimal (seedlink_ingestor.py), y serializar el float32
    # crudo escribía "108.80000305175781" — 18 dígitos de ruido de coma
    # flotante por cada uno de los 65 bins, en cada columna.
    picos = [round(max(c["power_db"][b] for c in bloque), 1) for b in range(n_bins)]

    return {
        # El endtime del final del bloque: el eje de tiempo del canvas se lee
        # de estos timestamps y así la columna queda alineada con el instante
        # que representa.
        "endtime": ultima["endtime"],
        "freqs": ultima["freqs"][:n_bins],
        "power_db": picos,
    }


def extract_shared_freqs(columns: list[dict[str, Any]]) -> list[float] | None:
    """El eje de frecuencia, si TODAS las columnas comparten el mismo.

    Devolverlo una sola vez por canal en vez de repetirlo en cada columna:
    son 65 floats idénticos que, multiplicados por 400 columnas, pesaban
    ~400 KB de una misma lista copiada.

    Ante columnas con ejes distintos (pasa: el muestreo puede cambiar dentro
    de un canal) devuelve None y cada columna conserva el suyo — antes que
    dibujar todo con la escala equivocada.
    """
    if not columns:
        return None

    primero = columns[0].get("freqs")
    if primero is None:
        return None
    if any(c.get("freqs") != primero for c in columns):
        return None
    return [round(f, 2) for f in primero]
