#!/usr/bin/env python3
"""
Genera deploy/sql/seeds/areas_of_interest.json: el catálogo curado de presets del
sistema (Decisión heredada #4 de AOI-1).

    python3 scripts/build_areas_of_interest.py

Lo carga en la base scripts/seed_areas_of_interest.py. Este script NO toca
Postgres: sólo produce el JSON, que se versiona y se revisa en el diff.

Por qué polígonos curados y no un dataset descargado
----------------------------------------------------
scripts/build_plate_boundaries.py descarga PB2002 y lo transforma: la fuente es
externa y autoritativa. Acá no hay equivalente, y no por falta de búsqueda:

  - Las fronteras políticas (Natural Earth) NO sirven. La frontera de Chile no
    cubre su zona de subducción, que está mar adentro y es donde ocurren los
    grandes eventos interplaca. Monitorear "Chile" es monitorear la fosa
    Perú-Chile, no el territorio.
  - Los cinturones (Anillo de Fuego, Alpino-Himalayo) no son entidades
    cartográficas: son conceptos geológicos difusos sin dataset canónico.

Un área de monitoreo es una decisión editorial, no un objeto que se descarga.
De ahí que las coordenadas vivan acá como constantes documentadas: cada una
lleva el criterio que la justifica, y "reproducible" significa que correr el
script produce siempre el mismo output — no que lo baje de algún lado.

El otro motivo es de costo. El consumidor es Shapely corriendo punto-en-polígono
por cada evento (src/services/geo_filter.py). Un país de Natural Earth trae
cientos de vértices; estas áreas tienen entre 5 y 20. Filtran igual de bien y no
cargan el path caliente.

Antimeridiano (Decisión heredada #5)
------------------------------------
RFC 7946 §3.1.9 prohíbe longitudes fuera de -180..180: un área que cruza el
antimeridiano va como MultiPolygon partido en dos. Acá se declara con
longitudes continuas (ej. 120 → 290) y `split_antimeridian()` hace el corte.
Escribirlo ya partido a mano sería ilegible y propenso a error.

Consecuencia conocida y aceptada: el bbox de esas áreas queda -180..180 en
longitud, o sea inútil como pre-filtro. Está documentado en el docstring de
geo_filter.py — el bbox es un PRE-filtro y Shapely hace el trabajo real.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

REPO_ROOT = Path(__file__).resolve().parent.parent
OUTPUT_PATH = REPO_ROOT / "deploy" / "sql" / "seeds" / "areas_of_interest.json"

# Slug del preset por defecto. DEBE coincidir con DEFAULT_AREA_SLUG en
# src/services/area_service.py: es el área que ve un usuario sin selección
# explícita (users.active_area_id IS NULL).
#
# Es "global" y no una región concreta a propósito. El sistema no tiene ninguna
# señal de dónde está el usuario —no hay geolocalización ni país en `users`—,
# así que cualquier default regional le impondría una región ajena a la mayoría:
# un usuario de California no tiene por qué ver los Andes. Global es la única
# opción neutral, y es coherente con la Decisión #1 (ingesta global, filtro al
# leer). Defaultear por geolocalización es un feature propio, fuera de AOI-1.
DEFAULT_SLUG = "global"


def rectangle(
    minlon: float, minlat: float, maxlon: float, maxlat: float
) -> list[list[float]]:
    """Anillo exterior rectangular, en sentido antihorario.

    RFC 7946 §3.1.6 pide anillos exteriores antihorarios. Shapely no lo exige
    para `covers()`, pero un GeoJSON que sale de acá puede terminar en otros
    consumidores (PostGIS si algún día se migra, o el frontend) que sí lo miran.

    Las posiciones son [lon, lat] — RFC 7946 §3.1.1, invertido respecto de cómo
    se nombran las coordenadas en el resto del proyecto.
    """
    return [
        [minlon, minlat],
        [maxlon, minlat],
        [maxlon, maxlat],
        [minlon, maxlat],
        [minlon, minlat],  # RFC 7946: el anillo cierra repitiendo el primero
    ]


# Catálogo curado. Cada área declara uno o más anillos ("rings"): las áreas
# simples tienen uno solo, y los cinturones se declaran como la UNIÓN de sus
# segmentos de arco.
#
# Por qué los cinturones son varios rectángulos y no un anillo cóncavo
# --------------------------------------------------------------------
# La primera versión modelaba el Anillo de Fuego como una herradura de 12
# vértices alrededor del Pacífico. Falló: verificado contra sismos históricos,
# no matcheaba Valdivia, Maule, Sumatra ni Christchurch, y sí matcheaba Loma
# Prieta (que es transformante y no pertenece al cinturón).
#
# El motivo es geométrico. split_antimeridian() recorta por banda de longitud,
# y eso sólo preserva la forma de polígonos convexos y monótonos en longitud.
# Una herradura cóncava no cumple ninguna de las dos cosas: el recorte la
# deformaba. Y aun sin el corte, un anillo cóncavo dibujado a ojo alrededor de
# medio planeta es imposible de auditar en un diff.
#
# Modelar el cinturón como lo que es —una CADENA de zonas de subducción— da
# rectángulos que sí son convexos y monótonos, cada uno auditable por separado,
# y hace el corte del antimeridiano trivial (sólo lo cruza el tramo aleutiano).
#
# Los polígonos siguen la geometría sismotectónica, no las fronteras políticas:
# se extienden mar adentro sobre la fosa donde el evento interplaca ocurre, y
# tierra adentro hasta donde llega la sismicidad de la placa que subduce.
REGIONS: list[dict] = [
    {
        "slug": "global",
        "name": "Global — todo el planeta",
        # El default. Cubre el planeta entero: sin señal de ubicación del
        # usuario, no imponerle ninguna región es lo correcto.
        "rings": [rectangle(-180.0, -90.0, 180.0, 90.0)],
    },
    {
        "slug": "anillo_de_fuego",
        "name": "Cinturón — Anillo de Fuego",
        # ~90% de los sismos del planeta. Unión de los arcos de subducción que
        # bordean el Pacífico, de Sudamérica a Indonesia por el norte.
        # Deliberadamente NO incluye la falla de San Andrés: es transformante,
        # no un margen convergente, y no forma parte del cinturón.
        "rings": [
            # Margen sudamericano: fosa Perú-Chile completa.
            rectangle(-82.0, -56.0, -66.0, -3.0),
            # Centroamérica y México: fosa Mesoamericana.
            rectangle(-107.0, 6.5, -77.0, 22.0),
            # Cascadia y Alaska (al norte de San Andrés).
            rectangle(-160.0, 40.0, -122.0, 62.0),
            # Aleutianas: el único tramo que cruza el antimeridiano.
            rectangle(165.0, 47.0, 200.0, 60.0),
            # Kuriles, Kamchatka y Japón.
            rectangle(128.0, 30.0, 165.0, 56.0),
            # Ryukyu, Taiwán, Filipinas y Marianas.
            rectangle(117.0, 4.5, 147.0, 30.0),
            # Indonesia, Sonda y Melanesia.
            rectangle(94.0, -11.5, 156.0, 6.5),
            # Tonga-Kermadec y Nueva Zelanda.
            rectangle(163.0, -48.0, 180.0, -14.0),
        ],
    },
    {
        "slug": "cinturon_alpino_himalayo",
        "name": "Cinturón — Alpino-Himalayo",
        # El segundo cinturón sísmico (~17% de los eventos). Colisión
        # Eurasia–África/Arabia/India, del Mediterráneo al sudeste asiático.
        # No cruza el antimeridiano.
        "rings": [rectangle(-10.0, 25.0, 105.0, 47.0)],
    },
    {
        "slug": "indonesia",
        "name": "Indonesia y fosa de la Sonda",
        # Subducción de la placa Australiana bajo la Sonda. Se extiende al
        # sudoeste sobre la fosa: el evento de 2004 (Mw 9.1) fue ahí, mar adentro.
        "rings": [rectangle(94.0, -11.5, 141.0, 6.5)],
    },
    {
        "slug": "japon",
        "name": "Japón y fosa de Japón",
        # Triple unión Pacífico/Filipinas/Okhotsk. El límite este llega a 148°
        # para cubrir la fosa donde ocurrió Tohoku 2011, ~130 km mar adentro.
        "rings": [rectangle(128.0, 30.0, 148.0, 46.0)],
    },
    {
        "slug": "filipinas",
        "name": "Filipinas",
        # Doble subducción: fosa de Manila al oeste y de Filipinas al este.
        # Por eso el área abarca ambos flancos del archipiélago.
        "rings": [rectangle(117.0, 4.5, 127.0, 21.0)],
    },
    {
        "slug": "chile",
        "name": "Chile y fosa Perú-Chile",
        # Subducción de Nazca bajo Sudamérica. Se extiende ~4° mar adentro
        # (hasta -76.5): Valdivia 1960 (Mw 9.5, el mayor registrado) fue
        # interplaca, no continental.
        "rings": [rectangle(-76.5, -56.0, -66.0, -17.5)],
    },
    {
        "slug": "peru",
        "name": "Perú y fosa Perú-Chile (norte)",
        # Continuación norte del mismo margen. Incluye el segmento de
        # subducción plana (flat-slab), sísmicamente distinto del chileno.
        "rings": [rectangle(-82.0, -18.5, -68.0, -3.0)],
    },
    {
        "slug": "mexico",
        "name": "México y fosa Mesoamericana",
        # Subducción de Cocos y Rivera bajo Norteamérica. Cubre la fosa frente
        # a Guerrero/Oaxaca y el eje volcánico transversal.
        "rings": [rectangle(-107.0, 13.5, -92.0, 22.0)],
    },
    {
        "slug": "centroamerica",
        "name": "Centroamérica",
        # Del istmo de Tehuantepec a Panamá: fosa Mesoamericana y el arco
        # volcánico de Guatemala–Nicaragua–Costa Rica.
        "rings": [rectangle(-93.0, 6.5, -77.0, 18.5)],
    },
    {
        "slug": "kamchatka_aleutianas",
        "name": "Kamchatka, Kuriles y Aleutianas",
        # Arco continuo desde Kamchatka hasta Alaska. Cruza el antimeridiano
        # por las Aleutianas centrales, de ahí las longitudes > 180.
        "rings": [rectangle(150.0, 47.0, 205.0, 60.0)],
    },
    {
        "slug": "himalaya",
        "name": "Himalaya y meseta tibetana",
        # Colisión India–Eurasia. Sismicidad continental de falla inversa, sin
        # subducción oceánica: la más letal del cinturón Alpino-Himalayo.
        "rings": [rectangle(72.0, 26.0, 96.0, 37.0)],
    },
    {
        "slug": "papua_nueva_guinea",
        "name": "Papúa Nueva Guinea y Melanesia",
        # Una de las zonas de mayor densidad sísmica del planeta: colisión
        # múltiple entre las placas Australiana, Pacífica y microplacas.
        "rings": [rectangle(139.0, -11.5, 156.0, -1.0)],
    },
    {
        "slug": "san_andres",
        "name": "Falla de San Andrés (California)",
        # Falla transformante, no subducción: los eventos son someros y de
        # desgarre. Por eso NO forma parte de anillo_de_fuego, cuyo tramo
        # norteamericano arranca recién en Cascadia (40°N).
        "rings": [rectangle(-126.0, 31.5, -114.0, 42.0)],
    },
    {
        "slug": "cascadia",
        "name": "Zona de subducción de Cascadia",
        # Juan de Fuca subduciendo bajo Norteamérica, del norte de California
        # (40°N, donde la triple unión de Mendocino la separa de San Andrés) a
        # la isla de Vancouver. El límite oeste (-132) cubre la fosa mar
        # adentro, que es donde ocurriría el evento interplaca: el último fue
        # en 1700 (Mw ~9.0) y no hay registro instrumental de uno igual, así
        # que el encuadre sigue la estructura y no la sismicidad observada.
        #
        # Deliberadamente NO incluye Alaska, aunque el tramo homónimo de
        # anillo_de_fuego los agrupe en un solo rectángulo: son márgenes
        # distintos y un área llamada "Cascadia" no debería traer eventos de
        # las Aleutianas.
        "rings": [rectangle(-132.0, 40.0, -119.0, 51.5)],
    },
    {
        "slug": "anatolia",
        "name": "Anatolia (falla Norte de Anatolia)",
        # Transformante que acomoda la extrusión de la placa Anatolia hacia el
        # oeste. Kahramanmaraş 2023 (Mw 7.8) fue en la falla oriental, incluida.
        # El límite oeste (26°E) solapa con mediterraneo_oriental sobre el
        # Egeo: es correcto, ahí las dos zonas son la misma sismicidad.
        "rings": [rectangle(26.0, 36.0, 45.0, 42.5)],
    },
    {
        "slug": "nueva_zelanda",
        "name": "Nueva Zelanda",
        # Fosa de Hikurangi al noreste y falla Alpina al suroeste. El límite
        # este llega a 180 exacto sin cruzarlo.
        "rings": [rectangle(163.0, -48.0, 180.0, -33.0)],
    },
    {
        "slug": "mediterraneo_oriental",
        "name": "Mediterráneo oriental y arco helénico",
        # Subducción de África bajo el Egeo. Sismicidad histórica densa: es la
        # zona con el registro documentado más largo del mundo.
        "rings": [rectangle(19.0, 32.0, 37.0, 42.0)],
    },
]


def split_antimeridian(ring: list[list[float]]) -> list[list[list[list[float]]]]:
    """Parte un anillo con longitudes continuas en polígonos RFC 7946 válidos.

    Un anillo declarado con longitudes > 180 (ej. Kamchatka: 150 → 205) es
    ilegal según RFC 7946 §3.1.1, que acota la longitud a -180..180. La
    representación correcta es un MultiPolygon con una parte a cada lado del
    antimeridiano (§3.1.9).

    Se corta en la banda -180..180 y en la 180..540 (que al restarle 360 cae en
    -180..180). Devuelve una lista de polígonos, cada uno como lista de anillos.

    No maneja el caso general de un anillo de forma arbitraria cruzando el
    corte: para eso haría falta clipping de polígonos (Sutherland-Hodgman o
    Shapely). Acá alcanza con acotar la longitud de cada vértice a la banda,
    porque las áreas del catálogo son convexas y monótonas en longitud — si
    alguna dejara de serlo, validate() lo detecta al comparar el área partida
    contra la original.
    """
    lons = [pos[0] for pos in ring]
    if max(lons) <= 180.0:
        return [[ring]]

    parts: list[list[list[list[float]]]] = []
    for offset, lo, hi in ((0.0, -180.0, 180.0), (-360.0, 180.0, 540.0)):
        clipped = [
            [min(max(lon, lo), hi) + offset, lat] for lon, lat in ring
        ]
        # Si tras acotar el anillo colapsó a una línea (todas las longitudes
        # iguales), esa banda no contiene nada del área: se descarta.
        if len({lon for lon, _ in clipped}) < 2:
            continue
        parts.append([clipped])

    return parts


def build_geometry(rings: list[list[list[float]]]) -> dict:
    """Construye el GeoJSON de un área a partir de sus anillos.

    Un área es la UNIÓN de sus anillos (ver el comentario de REGIONS), y cada
    uno puede además partirse en dos si cruza el antimeridiano. Sale Polygon
    sólo cuando queda exactamente una parte; MultiPolygon en cualquier otro
    caso.

    Los anillos pueden solaparse entre sí —los tramos del Anillo de Fuego lo
    hacen deliberadamente, para no dejar huecos en las junturas—. Es válido:
    Shapely resuelve `covers()` sobre un MultiPolygon con partes solapadas sin
    problema, y el resultado es la unión, que es justo lo que se quiere.
    """
    parts: list[list[list[list[float]]]] = []
    for ring in rings:
        parts.extend(split_antimeridian(ring))

    if len(parts) == 1:
        return {"type": "Polygon", "coordinates": parts[0]}
    return {"type": "MultiPolygon", "coordinates": parts}


def bbox_of(geometry: dict) -> dict:
    """Bbox de la geometría.

    Reimplementa src/services/geo_filter.py:bbox_of() en vez de importarlo, a
    propósito: este script no debe depender de que `src/` sea importable ni de
    que las dependencias de la app estén instaladas. Como contrapartida,
    validate() compara ambos resultados cuando geo_filter SÍ está disponible,
    para que las dos implementaciones no se desincronicen en silencio.
    """
    depth_is_multi = geometry["type"] == "MultiPolygon"
    polygons = geometry["coordinates"] if depth_is_multi else [geometry["coordinates"]]

    lons: list[float] = []
    lats: list[float] = []
    for polygon in polygons:
        for ring in polygon:
            for lon, lat in ring:
                lons.append(lon)
                lats.append(lat)

    return {
        "minlat": min(lats),
        "maxlat": max(lats),
        "minlon": min(lons),
        "maxlon": max(lons),
    }


def validate(area: dict) -> None:
    """Chequea los invariantes que la base y el filtro dan por sentados.

    Fallar acá es infinitamente más barato que descubrirlo con un CHECK
    violado a mitad del seed, o peor: con un área que no matchea nada en
    producción porque quedó con [lat, lon] invertido.
    """
    slug, geometry, bbox = area["slug"], area["geometry"], area["bbox"]

    # Los 3 CHECK de la migración 006, replicados: bbox ordenado y en rango.
    if not (bbox["minlat"] < bbox["maxlat"] and bbox["minlon"] < bbox["maxlon"]):
        raise ValueError(f"{slug}: bbox degenerado o invertido: {bbox}")
    if not (-90 <= bbox["minlat"] and bbox["maxlat"] <= 90):
        raise ValueError(f"{slug}: latitud fuera de rango: {bbox}")
    if not (-180 <= bbox["minlon"] and bbox["maxlon"] <= 180):
        raise ValueError(f"{slug}: longitud fuera de rango: {bbox}")

    # RFC 7946 §3.1.6: todo anillo lineal cierra en su primer punto.
    polygons = (
        geometry["coordinates"]
        if geometry["type"] == "MultiPolygon"
        else [geometry["coordinates"]]
    )
    for polygon in polygons:
        for ring in polygon:
            if len(ring) < 4:
                raise ValueError(f"{slug}: anillo con {len(ring)} posiciones (mínimo 4)")
            if ring[0] != ring[-1]:
                raise ValueError(f"{slug}: anillo no cerrado ({ring[0]} != {ring[-1]})")

    # Contraste contra la implementación real del filtro, si está disponible.
    # Es el chequeo que evita que este script y geo_filter.py diverjan.
    try:
        from src.services.geo_filter import bbox_of as filter_bbox_of
    except ImportError:
        return

    reference = filter_bbox_of(geometry)
    for key in ("minlat", "maxlat", "minlon", "maxlon"):
        if abs(reference[key] - bbox[key]) > 1e-9:
            raise ValueError(
                f"{slug}: bbox no coincide con geo_filter.bbox_of() en {key!r}: "
                f"{bbox[key]} vs {reference[key]}"
            )


def build() -> dict:
    slugs = [region["slug"] for region in REGIONS]
    if len(slugs) != len(set(slugs)):
        duplicates = {s for s in slugs if slugs.count(s) > 1}
        raise ValueError(f"slugs duplicados: {sorted(duplicates)}")
    if DEFAULT_SLUG not in slugs:
        raise ValueError(f"falta el preset por defecto {DEFAULT_SLUG!r} en el catálogo")

    areas = []
    for region in REGIONS:
        geometry = build_geometry(region["rings"])
        area = {
            "slug": region["slug"],
            "name": region["name"],
            "geometry": geometry,
            "bbox": bbox_of(geometry),
        }
        validate(area)
        areas.append(area)

        kind = "MultiPolygon" if geometry["type"] == "MultiPolygon" else "Polygon"
        vertices = sum(
            len(ring)
            for polygon in (
                geometry["coordinates"]
                if kind == "MultiPolygon"
                else [geometry["coordinates"]]
            )
            for ring in polygon
        )
        marker = "  (default)" if region["slug"] == DEFAULT_SLUG else ""
        print(f"  {region['slug']:28} {kind:13} {vertices:3} vértices{marker}")

    return {"default_slug": DEFAULT_SLUG, "areas": areas}


def main() -> None:
    print(f"generando catálogo de {len(REGIONS)} áreas de interés\n")
    catalog = build()

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n")

    size_kb = OUTPUT_PATH.stat().st_size / 1024
    print(f"\nescrito {OUTPUT_PATH.relative_to(REPO_ROOT)} ({size_kb:.1f} KB)")
    print("cargalo con: venv/bin/python scripts/seed_areas_of_interest.py")


if __name__ == "__main__":
    main()
