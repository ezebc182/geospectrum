"""Catalogo SeedLink parseado de forma robusta ante paquetes SLINFO.

Estrategia: NO depender de que los tags esten intactos. Los paquetes binarios
parten el XML en cualquier punto, asi que se ancla en el par de atributos
name=/network= (que identifica una estacion) y en cada seedname=/end_time=
(que identifica un canal), sin exigir '<station' ni '<stream' bien formados.
"""
import re
from datetime import datetime, timezone

# El paquete SLINFO puede caer ENTRE name= y network= (visto en II.UOSS), asi
# que no se puede exigir que sean consecutivos: se permite basura en el medio
# mientras no aparezca otro name=, que ya seria la estacion siguiente.
STATION = re.compile(rb'name="([A-Z0-9_\-]{1,8})"(?:(?!name=")[\s\S]){0,200}?'
                     rb'network="([A-Z0-9_\-]{1,8})"')
STREAM  = re.compile(rb'seedname="([A-Z0-9]{3})"[^<>]{0,200}?end_time="'
                     rb'(\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}:\d{2})')
VERT    = re.compile(r'^[BHESLM][HNLPG]Z$')

def _printable(raw: bytes) -> bytes:
    return bytes(b for b in raw if 32 <= b < 127 or b in (9, 10, 13))

def parse_time(s: str):
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y/%m/%d %H:%M:%S"):
        try:
            return datetime.strptime(s[:19], fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    return None

def load(path):
    """-> {(net, sta): {cha: end_time_utc}}  solo canales verticales."""
    raw = _printable(open(path, "rb").read().replace(b"SLINFO ", b""))
    marks = [(m.start(), m.group(2).decode(), m.group(1).decode())
             for m in STATION.finditer(raw)]
    out = {}
    for idx, (pos, net, sta) in enumerate(marks):
        end = marks[idx + 1][0] if idx + 1 < len(marks) else len(raw)
        chans = out.setdefault((net, sta), {})
        for sm in STREAM.finditer(raw, pos, end):
            cha = sm.group(1).decode()
            if not VERT.match(cha):
                continue
            dt = parse_time(sm.group(2).decode())
            # una estacion puede repetir el mismo canal: quedarse con el maximo
            if dt and (cha not in chans or dt > chans[cha]):
                chans[cha] = dt
    return out

def best(chans):
    """Canal vertical mas fresco -> (cha, datetime) o None."""
    if not chans:
        return None
    cha = max(chans, key=lambda c: chans[c])
    return cha, chans[cha]

if __name__ == "__main__":
    now = datetime.now(timezone.utc)
    for name, path in [("rtserve", "rtserve.xml"), ("geofon", "geofon.xml")]:
        cat = load(path)
        vivas = sum(1 for v in cat.values()
                    if v and (now - best(v)[1]).total_seconds() < 1800)
        print(f"{name}: {len(cat)} estaciones, {vivas} vivas (<30 min)")
    rt, ge = load("rtserve.xml"), load("geofon.xml")
    print("\n--- sanity check (contra lo verificado a mano) ---")
    for net, sta, src, esperado in [
        ("II","UOSS",rt,"viva"), ("GE","KBU",ge,"viva"),
        ("WM","AVE",ge,"viva"), ("MN","TRI",ge,"viva"),
        ("WM","TIO",ge,"muerta 3.3d"),
    ]:
        v = src.get((net, sta))
        if not v:
            print(f"  {net}.{sta:5s} NO ENCONTRADA  (esperado: {esperado})")
            continue
        cha, dt = best(v)
        age = (now - dt).total_seconds() / 60
        print(f"  {net}.{sta:5s} {cha} atraso={age:8.1f} min  (esperado: {esperado})")
