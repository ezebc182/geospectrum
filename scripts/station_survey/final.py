# -*- coding: utf-8 -*-
"""Evaluacion final: cada entrada del cuaderno contra dato vivo real.

Dos filtros encadenados para evitar falsos positivos:
  1. bounding box geografico (lat/lon del metadata FDSN de AMBOS servidores)
  2. filtro por pais sobre el SiteName, cuando el box roza paises vecinos
     (Venezuela/Colombia, Somalia/Yibuti, Guatemala/El Salvador...)
"""
import catalog, json, re
from datetime import datetime, timezone

def load_geo(path):
    g = {}
    for line in open(path, encoding="utf-8", errors="replace"):
        if line.startswith("#"):
            continue
        p = line.rstrip("\n").split("|")
        if len(p) < 6:
            continue
        try:
            g[(p[0], p[1])] = (float(p[2]), float(p[3]), p[5])
        except ValueError:
            pass
    return g

GEO = load_geo("geofon_sta.txt")
GEO.update(load_geo("stations.txt"))
NOW = datetime.now(timezone.utc)

ROWS = []
for server, path in (("rtserve", "rtserve.xml"), ("geofon", "geofon.xml")):
    for (net, sta), chans in catalog.load(path).items():
        b = catalog.best(chans)
        if not b:
            continue
        cha, dt = b
        lat, lon, site = GEO.get((net, sta), (None, None, ""))
        ROWS.append(dict(net=net, sta=sta, server=server, cha=cha,
                         age=(NOW - dt).total_seconds() / 60,
                         lat=lat, lon=lon, site=site))

def buscar(box, incluir=None, excluir=None, max_age=30):
    la0, la1, lo0, lo1 = box
    out = []
    for r in ROWS:
        if r["lat"] is None or r["age"] > max_age:
            continue
        if not (la0 <= r["lat"] <= la1 and lo0 <= r["lon"] <= lo1):
            continue
        s = r["site"].lower()
        if excluir and any(x in s for x in excluir):
            continue
        if incluir and not any(x in s for x in incluir):
            continue
        out.append(r)
    return sorted(out, key=lambda r: r["age"])

# clave, etiqueta, box, incluir, excluir
Z = [
 ("Argentina","Salta",(-26.5,-22.0,-67.0,-62.0),None,None),
 ("Argentina","San Juan",(-32.5,-29.5,-70.5,-67.0),None,None),
 ("Argentina","Mendoza",(-37.5,-32.0,-70.5,-66.5),None,None),
 ("Argentina","Ushuaia / Tierra del Fuego",(-56.0,-53.0,-69.5,-64.0),None,None),
 ("Chile","Zona N (Antofagasta)",(-26.5,-20.0,-71.5,-67.0),None,None),
 ("Chile","Zona M (Valparaiso/Santiago)",(-35.0,-32.0,-72.5,-69.5),None,None),
 ("Chile","Zona S (Bio Bio/Los Lagos)",(-44.0,-36.0,-75.0,-71.0),None,None),
 ("Peru","Lima",(-13.5,-10.5,-78.0,-75.5),None,None),
 ("Peru","otras",(-18.5,-3.0,-82.0,-68.0),["peru","perú"],None),
 ("Ecuador","(cualquiera)",(-5.0,1.5,-81.5,-75.0),None,None),
 ("Colombia","(cualquiera)",(-4.5,12.5,-79.0,-67.0),["colombia"],None),
 ("Venezuela","(cualquiera)",(0.5,12.5,-73.5,-59.5),["venezuela"],None),
 ("Puerto Rico","Zona N",(18.2,18.6,-67.3,-65.5),None,None),
 ("Puerto Rico","Zona S",(17.8,18.2,-67.3,-65.5),None,None),
 ("Nicaragua","(cualquiera)",(10.7,15.1,-87.7,-83.1),["nicaragua"],None),
 ("Costa Rica","(cualquiera)",(8.0,11.3,-86.0,-82.5),None,None),
 ("Guatemala","(cualquiera)",(13.7,17.9,-92.3,-88.2),["guatemala"],None),
 ("Mexico","Zona N (Golfo California)",(23.0,32.5,-115.0,-107.0),["mexico","méxico"],None),
 ("Mexico","Mexico DF",(18.5,20.5,-100.0,-98.0),None,None),
 ("Mexico","Oaxaca",(15.5,18.5,-98.5,-94.0),None,None),
 ("Mexico","Chiapas",(14.3,17.5,-94.5,-90.3),None,None),
 ("USA CA","Capetown (Cape Mendocino)",(40.0,40.9,-124.6,-123.6),None,None),
 ("USA CA","Mount Shasta",(41.0,41.8,-122.6,-121.8),None,None),
 ("USA CA","Long Valley",(37.4,38.0,-119.2,-118.5),None,None),
 ("USA CA","Salton",(32.9,33.7,-116.4,-115.4),None,None),
 ("USA","Oregon",(41.9,46.3,-124.6,-116.4),["or, usa","oregon"],None),
 ("USA WA","Mount Rainier",(46.6,47.1,-122.1,-121.4),None,None),
 ("USA WA","Volcan St. Helens",(46.0,46.4,-122.4,-122.0),None,None),
 ("USA","Volcan 3 Sisters",(43.9,44.4,-122.0,-121.5),None,None),
 ("USA","Texas",(25.8,36.6,-106.7,-93.5),["tx, usa","texas"],None),
 ("USA","Yellowstone",(44.1,45.1,-111.2,-109.8),None,None),
 ("USA AK","Anchorage",(60.8,61.5,-150.5,-149.0),None,None),
 ("USA AK","Volcan Redoubt",(60.3,60.7,-153.0,-152.4),None,None),
 ("USA AK","Volcan Shishaldin",(54.5,55.0,-164.3,-163.6),None,None),
 ("USA AK","Volcan Okmok",(53.2,53.7,-168.4,-167.6),None,None),
 ("USA AK","Volcan Gareloi",(51.6,52.1,-178.9,-178.5),None,None),
 ("USA HI","Mauna Loa",(19.2,19.7,-155.8,-155.3),None,None),
 ("USA HI","Kilauea",(19.2,19.5,-155.4,-155.0),None,None),
 ("Canada","Mount Bella (BC)",(51.5,52.9,-128.5,-125.5),None,None),
 ("Islas","Santa Elena",(-16.3,-15.7,-6.0,-5.4),None,None),
 ("Islas","Azores",(36.8,39.8,-31.5,-24.7),None,None),
 ("Islas","Canarias",(27.5,29.5,-18.3,-13.3),None,None),
 ("Portugal","Lisboa",(37.5,40.0,-10.0,-7.5),["portugal"],None),
 ("Espana","(cualquiera)",(36.0,43.9,-9.4,3.4),["spain","espa"],None),
 ("Espana","Granada",(36.8,37.5,-4.0,-2.9),None,None),
 ("Francia","(cualquiera)",(42.3,51.1,-5.2,8.3),["france","francia"],None),
 ("Italia","continental",(40.5,46.6,6.6,14.0),["ital"],None),
 ("Italia","Vesubio/Napoles",(40.6,41.1,14.0,14.6),None,None),
 ("Italia","Etna/Sicilia",(36.6,38.3,12.4,15.7),None,None),
 ("Grecia","continental",(37.0,41.7,20.1,26.0),["greece","grecia"],None),
 ("Grecia","Dodecaneso",(35.5,37.5,26.0,28.3),None,None),
 ("Islandia","(cualquiera)",(63.2,66.6,-24.6,-13.4),None,None),
 ("Turquia","Estambul",(40.0,42.0,27.0,31.0),None,None),
 ("Turquia","Gaziantep",(36.5,37.8,36.4,38.0),None,None),
 ("UAE","II.UOSS (Sharjah)",(22.0,26.5,51.0,56.5),None,None),
 ("Afganistan","Kabul",(29.3,38.5,60.5,74.9),["afghan"],None),
 ("Pakistan","(cualquiera)",(23.6,37.1,60.9,77.1),["pakistan"],None),
 ("Nepal","Everest",(27.6,28.3,86.5,87.3),None,None),
 ("India","(1 sola)",(6.5,35.5,68.0,89.0),["india"],None),
 ("China","(no oficial)",(18.0,53.6,73.5,135.1),["china"],None),
 ("Japon","Zona N",(37.0,45.6,139.0,146.0),None,None),
 ("Japon","Tokio",(34.5,36.8,138.5,141.0),None,None),
 ("Japon","Zona S",(24.0,34.5,126.0,136.0),None,None),
 ("Rusia","Kamchatka",(48.0,64.0,150.0,172.0),["russia","rusia"],None),
 ("Filipinas","(cualquiera)",(4.5,21.2,116.9,126.6),["philipp"],None),
 ("Indonesia","Sumatra",(-6.1,5.9,95.0,106.0),["indonesia","sumatra"],None),
 ("Indonesia","Java",(-8.8,-5.8,105.0,114.6),None,None),
 ("Indonesia","otras",(-11.0,6.0,114.6,141.0),["indonesia"],None),
 ("Nueva Zelanda","(cualquiera)",(-47.5,-34.0,166.0,178.6),None,None),
 ("Samoa","(cualquiera)",(-14.6,-13.2,-172.9,-171.0),None,None),
 ("Australia","Norte",(-26.0,-10.0,113.0,154.0),None,None),
 ("Australia","Sur",(-44.0,-26.0,113.0,154.0),None,None),
 ("Marruecos","WM.AVE (Averroes)",(27.6,36.0,-13.3,-1.0),["morocco","marru"],None),
 ("Sudan","(sin servidor conocido)",(8.7,22.2,21.8,38.6),["sudan"],None),
 ("Somalia","(sin servidor conocido)",(-1.7,12.0,40.9,51.4),["somal"],None),
 ("Madagascar","(cualquiera)",(-25.7,-11.9,43.2,50.5),["madagascar"],None),
]

res = []
for pais, zona, box, inc, exc in Z:
    hits = buscar(box, inc, exc)
    res.append(dict(pais=pais, zona=zona, n=len(hits),
                    top=[dict(seed=f"{h['net']}.{h['sta']}", server=h["server"],
                              cha=h["cha"], age=round(h["age"],1),
                              site=h["site"][:50]) for h in hits[:3]]))

json.dump(res, open("final.json","w"), indent=1, ensure_ascii=False)
print(f"{'PAIS':15s} {'ZONA':30s} {'N':>3s}  CANDIDATA")
print("-"*112)
for r in res:
    if r["n"] == 0:
        print(f"{r['pais']:15s} {r['zona']:30s} {0:3d}  --- SIN ESTACION VIVA ---")
    else:
        t = r["top"][0]
        print(f"{r['pais']:15s} {r['zona']:30s} {r['n']:3d}  {t['seed']:11s} {t['server']:8s} {t['cha']} {t['age']:5.1f}m {t['site'][:38]}")
