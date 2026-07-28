#!/usr/bin/env python3
"""
Genera dashboard/public/geo/plate-boundaries.json a partir del dataset PB2002_steps
de Peter Bird, clasificando cada tramo por tipo de contacto (STEPCLASS).

    python3 scripts/build_plate_boundaries.py

Por qué steps y no boundaries
-----------------------------
PB2002_boundaries.json (241 features) solo distingue `Type == "subduction"` del
resto: no permite separar dorsales divergentes de fallas transformantes, que el
USGS dibuja distinto (punteada vs. sólida). PB2002_steps.json trae STEPCLASS con
los 7 tipos de contacto reales, a costa de 5824 features y 269k vértices.

Servir ese dataset crudo sería una regresión de performance: 9,9 MB y 43x los
vértices actuales, para detalle sub-kilométrico invisible en un mapa mundial. De
ahí este preprocesamiento offline, cuyo output se commitea.

Pipeline
--------
1. Fusionar tramos contiguos que compartan STEPCLASS y polaridad (5824 -> ~1650).
   Esto NO reduce el costo de render por sí solo (los vértices bajan 1,5%: solo
   se elimina el duplicado de cada juntura), pero es requisito de (2): simplificar
   tramo por tramo conservaría los extremos de los 5824 originales.
2. Simplificar con Douglas-Peucker (269k -> ~5,7k vértices). Acá está la ganancia:
   el 53% de los segmentos del dataset mide menos de 1,1 km.
3. Redondear a 3 decimales (~110 m) y conservar solo las properties que usa el
   dashboard.

El resultado queda más liviano que el dataset que reemplaza (~39 KB gzip contra
54 KB) y con los 7 tipos de contacto en vez de 2.
"""

from __future__ import annotations

import json
import math
import urllib.request
from collections import Counter
from pathlib import Path

SOURCE_URL = "https://raw.githubusercontent.com/fraxen/tectonicplates/master/GeoJSON/PB2002_steps.json"

REPO_ROOT = Path(__file__).resolve().parent.parent
OUTPUT_PATH = REPO_ROOT / "dashboard" / "public" / "geo" / "plate-boundaries.json"
CACHE_PATH = REPO_ROOT / ".cache" / "PB2002_steps.json"

# Tolerancia de Douglas-Peucker en grados. 0,01° ~ 1,1 km en el ecuador: por debajo
# del pixel a cualquier zoom al que el dashboard dibuja la capa mundial. Bajarlo a
# 0,005° duplica los vértices y sigue siendo un orden de magnitud menos que el crudo.
SIMPLIFY_TOLERANCE_DEG = 0.01

# Precisión del output. 3 decimales ~ 110 m, coherente con la tolerancia de arriba.
COORD_PRECISION = 3

# Distancia bajo la cual dos extremos se consideran el mismo punto al fusionar.
# El dataset trae junturas exactas (97,6% de los pares consecutivos), así que esto
# solo absorbe ruido de punto flotante.
JOIN_EPSILON_DEG = 1e-9


def load_source() -> dict:
    """Descarga el dataset PB2002_steps, cacheando el crudo para no repetir 10 MB."""
    if CACHE_PATH.exists():
        print(f"usando cache {CACHE_PATH.relative_to(REPO_ROOT)}")
        return json.loads(CACHE_PATH.read_text())

    print(f"descargando {SOURCE_URL}")
    with urllib.request.urlopen(SOURCE_URL) as response:
        raw = response.read().decode("utf-8")

    CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    CACHE_PATH.write_text(raw)
    return json.loads(raw)


def polarity_separator(plate_bound: str) -> str:
    """
    Separador de polaridad de PB2002: `\\` y `/` codifican de qué lado se hunde la
    placa, y el dashboard lo lee para orientar los dientes de sierra.

    Se conserva tal cual en el output: fusionar dos tramos con distinto separador
    invertiría la orientación de uno de los dos.
    """
    if "\\" in plate_bound:
        return "\\"
    if "/" in plate_bound:
        return "/"
    return "-"


def same_point(a: list[float], b: list[float]) -> bool:
    return abs(a[0] - b[0]) < JOIN_EPSILON_DEG and abs(a[1] - b[1]) < JOIN_EPSILON_DEG


def merge_contiguous(features: list[dict]) -> list[dict]:
    """
    Une tramos consecutivos que compartan STEPCLASS, PLATEBOUND y extremo.

    El dataset viene ordenado por SEQNUM siguiendo cada límite, así que alcanza con
    una pasada secuencial: no hace falta indexar extremos ni resolver bifurcaciones.
    """
    merged: list[dict] = []

    for feature in features:
        props = feature["properties"]
        coords = feature["geometry"]["coordinates"]
        key = (props["STEPCLASS"], props["PLATEBOUND"])

        if merged:
            last = merged[-1]
            if last["key"] == key and same_point(last["coordinates"][-1], coords[0]):
                # Se saltea el primer vértice: es el mismo que el último del anterior.
                last["coordinates"].extend(coords[1:])
                continue

        merged.append({"key": key, "coordinates": list(coords)})

    return merged


def perpendicular_distance(point, start, end) -> float:
    """Distancia de `point` al segmento `start`-`end`, en grados (plano, no geodésica)."""
    (px, py), (sx, sy), (ex, ey) = point, start, end

    dx, dy = ex - sx, ey - sy
    if dx == 0 and dy == 0:
        return math.hypot(px - sx, py - sy)

    # Proyección escalar del punto sobre el segmento, recortada a [0, 1].
    t = max(0.0, min(1.0, ((px - sx) * dx + (py - sy) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (sx + t * dx), py - (sy + t * dy))


def simplify(coords: list[list[float]], tolerance: float) -> list[list[float]]:
    """
    Douglas-Peucker iterativo (sin recursión: algunas trazas fusionadas superan los
    10k vértices y la recursiva puede reventar el stack).
    """
    if len(coords) <= 2:
        return list(coords)

    keep = [False] * len(coords)
    keep[0] = keep[-1] = True
    stack = [(0, len(coords) - 1)]

    while stack:
        first, last = stack.pop()
        if last <= first + 1:
            continue

        max_distance, farthest = 0.0, first
        for i in range(first + 1, last):
            distance = perpendicular_distance(coords[i], coords[first], coords[last])
            if distance > max_distance:
                max_distance, farthest = distance, i

        if max_distance > tolerance:
            keep[farthest] = True
            stack.append((first, farthest))
            stack.append((farthest, last))

    return [coord for coord, kept in zip(coords, keep) if kept]


def round_coords(coords: list[list[float]]) -> list[list[float]]:
    """
    Redondea y colapsa vértices que quedan repetidos tras el redondeo, cuidando de
    no dejar una línea de menos de 2 puntos.
    """
    rounded = [[round(lon, COORD_PRECISION), round(lat, COORD_PRECISION)] for lon, lat in coords]

    deduped = [rounded[0]]
    for coord in rounded[1:]:
        if coord != deduped[-1]:
            deduped.append(coord)

    return deduped if len(deduped) >= 2 else rounded[:2]


def build() -> dict:
    source = load_source()
    source_features = source["features"]
    source_vertices = sum(len(f["geometry"]["coordinates"]) for f in source_features)
    print(f"origen: {len(source_features)} features, {source_vertices} vértices")

    merged = merge_contiguous(source_features)
    print(f"fusionado: {len(merged)} features")

    features = []
    for item in merged:
        step_class, plate_bound = item["key"]
        coords = round_coords(simplify(item["coordinates"], SIMPLIFY_TOLERANCE_DEG))

        features.append(
            {
                "type": "Feature",
                "properties": {
                    "STEPCLASS": step_class,
                    "PLATEBOUND": plate_bound,
                },
                "geometry": {"type": "LineString", "coordinates": coords},
            }
        )

    output_vertices = sum(len(f["geometry"]["coordinates"]) for f in features)
    print(f"simplificado: {output_vertices} vértices ({output_vertices / source_vertices:.1%} del origen)")

    by_class = Counter(f["properties"]["STEPCLASS"] for f in features)
    for step_class, count in sorted(by_class.items(), key=lambda kv: -kv[1]):
        print(f"  {step_class}: {count}")

    return {
        "type": "FeatureCollection",
        "features": features,
    }


def main() -> None:
    collection = build()
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(collection, separators=(",", ":")))

    size_kb = OUTPUT_PATH.stat().st_size / 1024
    print(f"\nescrito {OUTPUT_PATH.relative_to(REPO_ROOT)} ({size_kb:.1f} KB)")


if __name__ == "__main__":
    main()
