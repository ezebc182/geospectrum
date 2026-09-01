"""Baja INFO STREAMS crudo de los dos servidores y lo guarda a disco."""
import socket, sys

def dump(host, out, port=18000, timeout=90):
    s = socket.create_connection((host, port), timeout=timeout)
    s.settimeout(timeout)
    s.sendall(b"HELLO\r\n"); s.recv(4096)
    s.sendall(b"INFO STREAMS\r\n")
    buf = b""
    try:
        while True:
            c = s.recv(262144)
            if not c: break
            buf += c
            if b"</seedlink>" in buf: break
    except socket.timeout:
        pass
    s.close()
    with open(out, "wb") as f:
        f.write(buf)
    print(f"{host}: {len(buf)} bytes -> {out}")

dump("rtserve.earthscope.org", "rtserve.xml")
dump("geofon.gfz-potsdam.de", "geofon.xml")
