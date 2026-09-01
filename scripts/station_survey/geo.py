"""Cruza el catalogo SeedLink vivo con el metadata geografico FDSN.

Permite responder "hay una estacion VIVA dentro de este bounding box?" en vez
de adivinar que red FDSN cubre que pais -- el metodo que ya destrabo UAE.
"""
import catalog
from datetime import datetime, timezone

def load_geo(path="stations.txt"):
    """-> {(net, sta): (lat, lon, sitename)}"""
    geo = {}
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            if line.startswith("#"):
                continue
            p = line.rstrip("\n").split("|")
            if len(p) < 6:
                continue
            try:
                geo[(p[0], p[1])] = (float(p[2]), float(p[3]), p[5])
            except ValueError:
                continue
    return geo

class Index:
    def __init__(self):
        self.rt = catalog.load("rtserve.xml")
        self.ge = catalog.load("geofon.xml")
        self.geo = load_geo()
        self.now = datetime.now(timezone.utc)

    def rows(self):
        """-> lista de (net, sta, server, cha, age_min, lat, lon, site)"""
        out = []
        for server, cat in (("rtserve", self.rt), ("geofon", self.ge)):
            for (net, sta), chans in cat.items():
                b = catalog.best(chans)
                if not b:
                    continue
                cha, dt = b
                age = (self.now - dt).total_seconds() / 60
                lat, lon, site = self.geo.get((net, sta), (None, None, ""))
                out.append((net, sta, server, cha, age, lat, lon, site))
        return out

    def in_box(self, lat0, lat1, lon0, lon1, max_age=30):
        """Estaciones VIVAS dentro del bounding box, mas frescas primero."""
        hits = []
        for net, sta, server, cha, age, lat, lon, site in self.rows():
            if lat is None or age > max_age:
                continue
            if lat0 <= lat <= lat1 and lon0 <= lon <= lon1:
                hits.append((net, sta, server, cha, age, lat, lon, site))
        return sorted(hits, key=lambda r: r[4])

if __name__ == "__main__":
    ix = Index()
    r = ix.rows()
    con_geo = sum(1 for x in r if x[5] is not None)
    vivas = sum(1 for x in r if x[4] <= 30)
    print(f"{len(r)} estaciones en catalogo SeedLink")
    print(f"{con_geo} con lat/lon del metadata FDSN")
    print(f"{vivas} vivas (<=30 min)")
    print("\nUAE (control, debe dar II.UOSS):")
    for h in ix.in_box(22.0, 26.5, 51.0, 56.5)[:5]:
        print(f"  {h[0]}.{h[1]:6s} {h[2]:8s} {h[3]} {h[4]:6.1f}min ({h[5]:.2f},{h[6]:.2f}) {h[7][:40]}")
