# -*- coding: utf-8 -*-
"""Busca estacion de RESPALDO para las zonas que cuelgan de una sola.

Amplia el radio progresivamente y reporta la segunda mejor candidata viva,
con la distancia real a la zona pedida. Una zona con respaldo a 80 km sigue
sirviendo si la titular se cae; una a 1500 km no es respaldo, es otra cosa.
"""
import final as F
from math import radians, sin, cos, asin, sqrt

def km(lat1, lon1, lat2, lon2):
    dlat, dlon = radians(lat2-lat1), radians(lon2-lon1)
    a = sin(dlat/2)**2 + cos(radians(lat1))*cos(radians(lat2))*sin(dlon/2)**2
    return 6371 * 2 * asin(sqrt(a))

# zona -> (lat, lon) del punto de interes real + titular actual
FRAGILES = [
 ("Argentina - Salta",      -24.79, -65.41, "GE.SALTA"),
 ("Argentina - San Juan",   -31.54, -68.54, "WA.ZON"),
 ("Peru - Lima",            -12.05, -77.04, "II.NNA"),
 ("Venezuela",                8.88, -70.63, "IU.SDV"),
 ("Mexico - DF",             19.43, -99.13, "G.UNM"),
 ("Mexico - Oaxaca",         17.07, -96.72, "MX.TLIG"),
 ("Mexico - Chiapas",        16.75, -93.12, "MX.CCIG"),
 ("California - Mt Shasta",  41.41,-122.19, "PB.B039"),
 ("California - Long Valley",37.70,-118.87, "CI.MLAC"),
 ("Isla Santa Elena",       -15.96,  -5.72, "II.SHEL"),
 ("Islas Canarias",          28.29, -16.62, "IU.MACI"),
 ("Portugal - Lisboa",       38.72,  -9.14, "PM.PESTR"),
 ("Islandia",                64.14, -21.94, "II.BORG"),
 ("Turquia - Estambul",      41.01,  28.98, "2Q.BUAD"),
 ("UAE",                     25.35,  55.42, "II.UOSS"),
 ("Afganistan - Kabul",      34.53,  69.17, "GE.KBU"),
 ("Pakistan",                33.65,  73.25, "II.NIL"),
 ("India",                   20.00,  78.00, "IN.MNC"),
 ("Japon - Tokio",           35.68, 139.69, "JP.JYT"),
 ("Rusia - Kamchatka",       53.02, 158.65, "IU.MA2"),
 ("Filipinas",               14.60, 120.98, "IU.DAV"),
 ("Samoa",                  -13.76,-172.10, "IU.AFI"),
 ("Marruecos",               33.30,  -7.41, "WM.AVE"),
 ("Peru - otras",           -12.05, -77.04, "II.NNA"),
]

print(f"{'ZONA':26s} {'TITULAR':11s} {'RESPALDO':11s} {'dist':>7s}  {'srv':8s} SITIO")
print("-"*104)
sin_respaldo = []
for label, lat, lon, titular in FRAGILES:
    cands = []
    for r in F.ROWS:
        if r["lat"] is None or r["age"] > 30:
            continue
        seed = f"{r['net']}.{r['sta']}"
        if seed == titular:
            continue
        d = km(lat, lon, r["lat"], r["lon"])
        if d <= 600:
            cands.append((d, seed, r))
    cands.sort(key=lambda c: c[0])
    if not cands:
        print(f"{label:26s} {titular:11s} {'-- NINGUNA en 600 km --':32s}")
        sin_respaldo.append(label)
    else:
        d, seed, r = cands[0]
        print(f"{label:26s} {titular:11s} {seed:11s} {d:6.0f}km  {r['server']:8s} {r['site'][:42]}")

print(f"\n=== {len(sin_respaldo)} zonas SIN respaldo en 600 km ===")
for z in sin_respaldo:
    print("   -", z)
