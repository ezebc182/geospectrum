"""
Tests para servicio de fusión de eventos.

============================================================================
VALIDACIÓN DE NO-CONMUTATIVIDAD DE merge_all_sources (Fase 0, change
"unify-dashboard-events-source") — RESULTADO DOCUMENTADO
============================================================================

Contexto: merge_all_sources reduce N listas de a pares vía
functools.reduce-like loop (merge_events(a,b), luego merge_events(result,c),
...). El matching dentro de merge_events es GREEDY "primer candidato que
cumple Δt<=120s y dist<=30km" (ver merge_events, líneas ~62-100), NO óptimo
global. Esto significa que el orden en que se pasan las listas de fuentes
puede alterar qué eventos se consideran duplicados entre sí.

Fixture usado (test_merge_all_sources_order_sensitivity /
test_merge_all_sources_order_impacts_alerts): 3 eventos, uno por fuente
(USGS, EMSC, INPRES), alineados sobre el mismo paralelo (-31.500) y
espaciados en longitud de forma que:
    - USGS  <-> EMSC:   ~24.97 km  (DENTRO del umbral de 30km)
    - EMSC  <-> INPRES: ~24.97 km  (DENTRO del umbral de 30km)
    - USGS  <-> INPRES: ~49.94 km  (FUERA del umbral de 30km)
EMSC actúa como "puente" geográfico entre USGS e INPRES, que entre sí NO
matchean directamente. Timestamps dentro de Δt<=120s entre pares vecinos.

Resultado observado (ejecutado y confirmado empíricamente, no solo
predicho):

| Orden de sources          | len(resultado) | ids resultantes            |
|----------------------------|-----------------|-----------------------------|
| (usgs, emsc, inpres)       | 2               | {usgs1, inpres1}            |
| (emsc, usgs, inpres)       | 2               | {emsc1, inpres1}            |
| (usgs, inpres, emsc)       | 2               | {usgs1, inpres1}            |
| (emsc, inpres, usgs)       | 2               | {emsc1, usgs1}              |
| (inpres, usgs, emsc)       | 2               | {inpres1, usgs1}            |
| (inpres, emsc, usgs)       | 1               | {inpres1}  <- LOS 3 FUSIONADOS |

CONFIRMADO NO-CONMUTATIVO: en 5 de los 6 órdenes el resultado tiene 2
eventos (EMSC se fusiona con USGS o con INPRES, pero el tercero queda
separado porque USGS-INPRES está fuera de umbral). En el orden
(inpres, emsc, usgs), la fusión ocurre en CADENA: INPRES+EMSC se fusionan
primero (matchean, ~24.97km) y el evento fusionado resultante queda
posicionado en la coordenada de EMSC (criterio de _fuse_two_events cuando
ninguno está revisado y "USGS" no está en a.fuentes: se usa la posición de
b). Esa posición SÍ está dentro de umbral de USGS (~24.97km), por lo que en
el segundo paso también matchea, colapsando los 3 reportes en 1 solo
evento. Además, cuál `id` sobrevive y qué `fuentes` quedan en el evento
final cambia según el orden (ver tabla).

Impacto en alertas (test_merge_all_sources_order_impacts_alerts): con
magnitudes usgs=4.9, emsc=5.2, inpres=4.8 y prof_km=50 (todas <70km), la
alerta `evento_significativo` (M>=5, prof<70km) DISPARA en los 3 órdenes
representativos probados ((usgs,emsc,inpres), (emsc,usgs,inpres),
(inpres,emsc,usgs)) porque el criterio de fusión de magnitud usa max(),
por lo que el mag=5.2 de EMSC siempre "gana" y queda en el evento
resultante sin importar con quién se fusionó. Lo que SÍ cambia con el
orden es el `id` que queda asociado a esa alerta en
`eventos_relacionados` (usgs1 / emsc1 / inpres1 respectivamente) y,
en el orden (inpres,emsc,usgs), kpis.total_eventos baja de 2 a 1 porque
los 3 reportes colapsan en una sola entidad.

VEREDICTO: ACEPTABLE (no bloqueante), bajo la mitigación ya prevista en
design.md — fijar el orden canónico `CANONICAL_SOURCES = ["usgs", "emsc",
"inpres"]` en report_service.py como decisión consciente y documentada,
consistente con el default que /events/search ya usa desde antes de este
change. No se detectó ningún caso donde una alerta pase de "no dispara" a
"dispara" (o viceversa) solo por el orden — lo que cambia es CUÁL id
sobrevive y CUÁNTOS eventos finales hay (1 vs 2), no SI se genera la
alerta operativa en sí para este fixture. Ver reporte completo del
sub-agente de Fase 0 para el detalle de riesgo residual (el conteo de
eventos SÍ puede variar, lo cual afecta _detect_swarms indirectamente en
otros fixtures — no probado exhaustivamente aquí, es un riesgo conocido y
aceptado, no eliminado).

CONFIRMACIÓN (Task 0.5): con base en 0.1-0.4, el orden canónico a fijar
en producción para los 3 endpoints migrados (`/report`, `/events`,
`/alerts`, vía `report_service.build_report`) es:

    CANONICAL_SOURCES = ["usgs", "emsc", "inpres"]

Esto es consistente con el default que `/events/search` ya usa hoy
(línea ~397 de `src/main.py`, `sources = ["usgs", "emsc", "inpres"]`
cuando no se pasa el query param), por lo que no introduce un
comportamiento nuevo no probado en producción — solo lo extiende a los
otros 3 endpoints.

============================================================================
RIESGO RESIDUAL: impacto del orden de merge_all_sources sobre
_detect_swarms — RESULTADO DOCUMENTADO (CONFIRMADO IMPACTA)
============================================================================

_detect_swarms (src/services/kpi_service.py, líneas ~155-184) marca
"enjambre" cuando >=3 eventos con mag>=3.0 quedan mutuamente dentro de
Δt<=15min y dist<=20km (comparación por pares, no solo con un ancla).

Búsqueda dirigida: para un TRÍO puro (3 reportes, 1 por lista/fuente)
mutuamente <=20km entre sí, se probó exhaustivamente (2000 triángulos
aleatorios x 6 órdenes c/u = 12000 corridas) que SIEMPRE colapsan a
exactamente 1 evento final sin importar el orden. Esto es una
consecuencia estructural, no solo empírica: swarm_radius(20km) <
merge_radius(30km) implica que cualquier trío mutuamente <=20km es
automáticamente un grafo completo de merge-eligibility (<=30km en los 3
pares), y el greedy chain-reduce de merge_all_sources siempre encuentra
un match en cada paso, colapsando el trío a 1 evento. Un trío puro de 3
fuentes NUNCA puede producir un enjambre (nunca llega a 3 supervivientes).

Con 4 reportes (búsqueda aleatoria dirigida, 30000 geometrías x 24
órdenes) SÍ se encontró un caso real (29/30000 geometrías) donde el
mismo conjunto de eventos, fusionado en dos órdenes distintos, produce
el MISMO número de eventos finales (3) pero solo en uno de los dos
órdenes esos 3 eventos quedan mutuamente <=20km (dispara enjambre) y en
el otro no (no dispara). La causa es la regla de posición de
_fuse_two_events: cuando dos reportes matchean, la posición final es
la de uno de los dos originales (nunca un promedio), y CUÁL de los dos
"gana" la posición depende de qué orden se comparan — eso desplaza al
evento fusionado dentro o fuera del radio de 20km del resto del grupo.

Fixture usado (test_merge_all_sources_order_affects_swarm_detection):
4 reportes de 4 fuentes distintas (a=USGS, b=EMSC, c=INPRES, d=USGS2),
mag=3.5 (>=3.0, elegibles para swarm), timestamps separados por 1s
(bien dentro de Δt<=15min):
    a: lat=-31.5750, lon=-68.6931
    b: lat=-31.4812, lon=-68.3051
    c: lat=-31.4540, lon=-68.6094
    d: lat=-31.3086, lon=-68.6175
Distancias reales: a-b=38.23km, a-c=15.62km, a-d=30.48km, b-c=29.02km,
b-d=35.32km, c-d=16.19km (ninguna es <=20km directamente salvo a-c y
c-d; el trío final a-b-d SOLO queda mutuamente <=20km si b termina
absorbiendo a c en su posición, ver abajo).

Órdenes comparados (de las 24 permutaciones válidas, ejecutadas y
confirmadas empíricamente):
  - ("usgs", "emsc", "inpres", "usgs2"): c se fusiona con a (a gana
    posición, criterio "USGS" in a.fuentes), resultado final
    {a(+c), b, d} en la posición ORIGINAL de a. dist(a,b)=38.23km,
    dist(a,d)=30.48km, dist(b,d)=35.32km -> ninguna <=20km ->
    _detect_swarms = [] (NO dispara).
  - ("emsc", "usgs", "usgs2", "inpres"): c se fusiona con b (b gana
    posición), resultado final {a, b(+c), d} en la posición ORIGINAL
    de b=(-31.4540,-68.6094) (la de c, ya que ninguno de los dos tiene
    "USGS" en fuentes al momento de fusionar y ninguno está revisado).
    dist(b,a)=15.62km, dist(b,d)=16.19km, dist(a,d)=30.48km ->
    2 de los 3 pares <=20km, pero _detect_swarms exige que CADA
    evento base tenga >=2 vecinos <=20km/<=15min para formar un grupo
    de >=3: b tiene vecinos a y d (ambos <=20km) -> grupo {a,b,d} de
    3 -> _detect_swarms = [['a','b','d']] (SÍ dispara).

En ambos órdenes el NÚMERO de eventos finales es el mismo (3), pero
las COORDENADAS del evento fusionado difieren (posición de "a" vs
posición de "c"), y esa diferencia de ~23km es suficiente para cruzar
el umbral de 20km del criterio de enjambre en un caso y no en el otro.

VEREDICTO PUNTUAL (_detect_swarms vs orden de merge): CONFIRMADO
IMPACTA. Se encontró un caso real, reproducible y ejecutado
empíricamente (no solo predicho) donde el orden de merge_all_sources
determina si la alerta `enjambre` dispara o no, para el MISMO conjunto
de reportes de entrada. El mecanismo es la regla de desempate de
posición en _fuse_two_events (labels de fuente / revisado deciden qué
coordenadas sobreviven a la fusión), no el conteo de eventos en sí.
Esto refuerza — y hace más concreta — la mitigación ya prevista
(orden canónico fijo `CANONICAL_SOURCES = ["usgs", "emsc", "inpres"]`
en report_service.py): sin un orden canónico fijo, la alerta de
enjambre sería no determinística ante el mismo input.
============================================================================
"""
import math

import pytest
from src.models.event import SeismicEvent
from src.services.merge_service import merge_events, merge_all_sources
from src.services.kpi_service import compute_kpis_and_alerts, _detect_swarms
from src.utils.geo import parse_datetime_utc


def test_merge_no_overlap():
    """Test fusión sin eventos solapados."""
    usgs = [
        SeismicEvent(
            id="usgs1",
            fuentes=["USGS"],
            hora_utc="2025-10-28T22:00:00Z",
            lat=-31.5,
            lon=-68.5,
            prof_km=100.0,
            mag=4.0,
            mag_tipo="Mw",
            lugar="Event 1",
            sentido=False,
            revisado=True,
        ),
    ]

    inpres = [
        SeismicEvent(
            id="inpres1",
            fuentes=["INPRES"],
            hora_utc="2025-10-28T23:00:00Z",  # 1 hora después
            lat=-32.5,
            lon=-69.5,
            prof_km=80.0,
            mag=3.5,
            mag_tipo="ML",
            lugar="Event 2",
            sentido=True,
            revisado=True,
        ),
    ]

    merged = merge_events(usgs, inpres)

    assert len(merged) == 2  # No overlap → ambos eventos


def test_merge_with_overlap():
    """Test fusión con eventos solapados (mismo evento reportado por ambas fuentes)."""
    usgs = [
        SeismicEvent(
            id="usgs1",
            fuentes=["USGS"],
            hora_utc="2025-10-28T22:00:00Z",
            lat=-31.5,
            lon=-68.5,
            prof_km=100.0,
            mag=4.0,
            mag_tipo="Mw",
            lugar="Same event",
            sentido=False,
            revisado=True,
        ),
    ]

    inpres = [
        SeismicEvent(
            id="inpres1",
            fuentes=["INPRES"],
            hora_utc="2025-10-28T22:00:30Z",  # 30 seg después
            lat=-31.51,  # Muy cerca
            lon=-68.51,
            prof_km=105.0,
            mag=4.1,  # Mag ligeramente diferente
            mag_tipo="ML",
            lugar="Same event (INPRES)",
            sentido=True,
            revisado=True,
        ),
    ]

    merged = merge_events(usgs, inpres)

    assert len(merged) == 1  # Fusionados
    assert "USGS" in merged[0].fuentes
    assert "INPRES" in merged[0].fuentes
    assert merged[0].mag == 4.1  # Mayor magnitud (conservador)
    assert merged[0].sentido is True  # OR lógico


def _make_event(event_id: str, source: str, lat: float, lon: float, hora: str, mag: float = 3.0) -> SeismicEvent:
    return SeismicEvent(
        id=event_id,
        fuentes=[source],
        hora_utc=hora,
        lat=lat,
        lon=lon,
        prof_km=10.0,
        mag=mag,
        mag_tipo="ML",
        lugar=f"Lugar {event_id}",
        sentido=False,
        revisado=False,
    )


def test_merge_all_sources_empty():
    assert merge_all_sources() == []
    assert merge_all_sources([], [], []) == []


def test_merge_all_sources_single_list():
    events = [_make_event("e1", "USGS", -31.5, -68.5, "2025-10-28T22:00:00Z")]
    result = merge_all_sources(events)
    assert result == events


def test_merge_all_sources_no_overlap():
    """Tres fuentes, sin duplicados: resultado tiene los tres eventos."""
    usgs = [_make_event("u1", "USGS", -31.5, -68.5, "2025-10-28T22:00:00Z")]
    emsc = [_make_event("e1", "EMSC", -35.0, -70.0, "2025-10-28T21:00:00Z")]
    inpres = [_make_event("i1", "INPRES", -28.0, -65.0, "2025-10-28T20:00:00Z")]

    result = merge_all_sources(usgs, emsc, inpres)
    assert len(result) == 3


def test_merge_all_sources_dedup_across_sources():
    """Evento reportado por USGS e INPRES dentro de ventana → fusionado."""
    usgs = [_make_event("u1", "USGS", -31.5, -68.5, "2025-10-28T22:00:00Z", mag=4.0)]
    inpres = [_make_event("i1", "INPRES", -31.51, -68.51, "2025-10-28T22:00:30Z", mag=4.2)]

    result = merge_all_sources(usgs, [], inpres)
    assert len(result) == 1
    assert result[0].mag == 4.2
    assert "USGS" in result[0].fuentes
    assert "INPRES" in result[0].fuentes


# ============================================================================
# Fase 0 — Validación de no-conmutatividad de merge_all_sources
# (gate bloqueante del change "unify-dashboard-events-source")
# Ver bloque de documentación al inicio de este archivo para el resumen
# completo del resultado y el veredicto.
# ============================================================================

# Coordenadas base y separación en longitud calculadas con haversine real
# (no aproximación): a lat=-31.500, 1 grado de longitud ≈ 94.98 km.
# LON_PER_KM se deriva de 1 / (111.32 * cos(radians(31.5))).
_LAT0 = -31.500
_LON0 = -68.500
_LON_PER_KM = 1 / (111.32 * math.cos(math.radians(_LAT0)))


def _order_sensitivity_fixture():
    """
    Fixture triple ambiguo: USGS<->EMSC ~24.97km, EMSC<->INPRES ~24.97km,
    USGS<->INPRES ~49.94km (fuera de umbral). EMSC actúa de "puente".
    Timestamps dentro de Δt<=120s entre pares vecinos.
    """
    usgs = _make_event(
        "usgs1", "USGS", _LAT0, _LON0, "2025-10-28T22:00:00Z", mag=4.0
    )
    emsc = _make_event(
        "emsc1", "EMSC", _LAT0, _LON0 + 25 * _LON_PER_KM, "2025-10-28T22:00:30Z", mag=4.3
    )
    inpres = _make_event(
        "inpres1", "INPRES", _LAT0, _LON0 + 50 * _LON_PER_KM, "2025-10-28T22:01:00Z", mag=4.1
    )
    return usgs, emsc, inpres


def test_merge_all_sources_order_sensitivity():
    """
    Task 0.1/0.2: ejecuta merge_all_sources sobre el fixture ambiguo en al
    menos 3 órdenes distintos y no triviales, y documenta len(resultado) y
    el set de ids por orden.

    Resultado esperado (confirmado empíricamente, ver docstring del módulo):
    - (usgs, emsc, inpres)  -> 2 eventos, ids {usgs1, inpres1}
    - (emsc, usgs, inpres)  -> 2 eventos, ids {emsc1, inpres1}
    - (inpres, emsc, usgs)  -> 1 evento,  ids {inpres1}  (fusión en cadena)
    """
    usgs_ev, emsc_ev, inpres_ev = _order_sensitivity_fixture()

    orders = {
        ("usgs", "emsc", "inpres"): ([usgs_ev], [emsc_ev], [inpres_ev]),
        ("emsc", "usgs", "inpres"): ([emsc_ev], [usgs_ev], [inpres_ev]),
        ("inpres", "emsc", "usgs"): ([inpres_ev], [emsc_ev], [usgs_ev]),
    }

    observed = {}
    for order_name, lists in orders.items():
        result = merge_all_sources(*lists)
        observed[order_name] = {
            "len": len(result),
            "ids": sorted(e.id for e in result),
            "mags": sorted(e.mag for e in result),
        }

    # (usgs, emsc, inpres): USGS matchea EMSC (25km), evento fusionado queda
    # en posición USGS -> dist a INPRES = ~49.94km, fuera de umbral -> 2 eventos
    assert observed[("usgs", "emsc", "inpres")]["len"] == 2
    assert observed[("usgs", "emsc", "inpres")]["ids"] == ["inpres1", "usgs1"]

    # (emsc, usgs, inpres): EMSC matchea USGS, resultado fusionado toma la
    # posición de USGS (criterio _fuse_two_events: "USGS" no está en a.fuentes
    # cuando a=emsc, b=usgs -> usa posición de b=usgs) -> 2 eventos
    assert observed[("emsc", "usgs", "inpres")]["len"] == 2
    assert observed[("emsc", "usgs", "inpres")]["ids"] == ["emsc1", "inpres1"]

    # (inpres, emsc, usgs): INPRES matchea EMSC primero (24.97km), el
    # fusionado queda en posición EMSC -> esa posición SÍ está dentro de
    # umbral de USGS (24.97km) -> matchea también -> los 3 colapsan en 1
    assert observed[("inpres", "emsc", "usgs")]["len"] == 1
    assert observed[("inpres", "emsc", "usgs")]["ids"] == ["inpres1"]

    # Evidencia central de no-conmutatividad: el conteo de eventos fusionados
    # NO es el mismo en todos los órdenes probados.
    lens = {v["len"] for v in observed.values()}
    assert lens == {1, 2}, (
        "Se esperaba observar al menos dos valores distintos de "
        f"len(resultado) entre órdenes; se obtuvo: {observed}"
    )


def test_merge_all_sources_order_impacts_alerts():
    """
    Task 0.3: corre compute_kpis_and_alerts sobre el resultado de cada orden
    del fixture ambiguo (con magnitudes que cruzan el umbral de
    evento_significativo, M>=5, prof<70km) y compara kpis.total_eventos,
    kpis.magnitud_max y la lista de alertas (tipo + eventos_relacionados)
    entre órdenes.
    """
    usgs_ev = _make_event("usgs1", "USGS", _LAT0, _LON0, "2025-10-28T22:00:00Z", mag=4.9)
    usgs_ev.prof_km = 50.0
    emsc_ev = _make_event(
        "emsc1", "EMSC", _LAT0, _LON0 + 25 * _LON_PER_KM, "2025-10-28T22:00:30Z", mag=5.2
    )
    emsc_ev.prof_km = 50.0
    inpres_ev = _make_event(
        "inpres1", "INPRES", _LAT0, _LON0 + 50 * _LON_PER_KM, "2025-10-28T22:01:00Z", mag=4.8
    )
    inpres_ev.prof_km = 50.0

    orders = {
        ("usgs", "emsc", "inpres"): ([usgs_ev], [emsc_ev], [inpres_ev]),
        ("emsc", "usgs", "inpres"): ([emsc_ev], [usgs_ev], [inpres_ev]),
        ("inpres", "emsc", "usgs"): ([inpres_ev], [emsc_ev], [usgs_ev]),
    }

    observed = {}
    for order_name, lists in orders.items():
        result = merge_all_sources(*lists)
        kpis, alertas = compute_kpis_and_alerts(result, window_minutes=60)
        observed[order_name] = {
            "total_eventos": kpis.total_eventos,
            "magnitud_max": kpis.magnitud_max,
            "alertas": sorted(
                (a.tipo, tuple(sorted(a.eventos_relacionados))) for a in alertas
            ),
        }

    # magnitud_max es siempre 5.2 (max() gana en _fuse_two_events sin
    # importar el orden) -> el KPI de magnitud es estable ante el orden.
    assert all(v["magnitud_max"] == 5.2 for v in observed.values())

    # La alerta evento_significativo SIEMPRE dispara en los 3 órdenes para
    # este fixture (ningún caso "no dispara" -> "dispara" observado aquí).
    for order_name, data in observed.items():
        assert data["alertas"][0][0] == "evento_significativo", (
            f"Orden {order_name} no generó evento_significativo: {data}"
        )

    # Pero el id asociado a la alerta SÍ cambia según el orden (auditable:
    # el operador vería un id de evento distinto sobreviviendo la fusión).
    ids_en_alerta = {data["alertas"][0][1] for data in observed.values()}
    assert ids_en_alerta == {("usgs1",), ("emsc1",), ("inpres1",)}

    # Y total_eventos SÍ cambia: 2 en la mayoría de los órdenes, 1 en el
    # orden que colapsa los 3 reportes en una sola cadena de fusión.
    totals = {v["total_eventos"] for v in observed.values()}
    assert totals == {1, 2}


# ============================================================================
# Riesgo residual — impacto del orden de merge sobre _detect_swarms
# Ver bloque de documentación al inicio de este archivo para el detalle
# completo del mecanismo y el veredicto (CONFIRMADO IMPACTA).
# ============================================================================

def _swarm_order_fixture():
    """
    4 reportes de 4 fuentes distintas, mag=3.5 (elegibles para enjambre,
    umbral M>=3), timestamps espaciados 1s (bien dentro de Δt<=15min).
    Ninguna distancia par-a-par original es <=20km salvo a-c (15.62km) y
    c-d (16.19km); el trío final {a,b,d} solo queda mutuamente <=20km si
    "c" termina fusionado en la posición de "b" (ver docstring del módulo).
    """
    a = _make_event("a", "USGS", -31.5750, -68.6931, "2025-10-28T22:00:00Z", mag=3.5)
    b = _make_event("b", "EMSC", -31.4812, -68.3051, "2025-10-28T22:00:01Z", mag=3.5)
    c = _make_event("c", "INPRES", -31.4540, -68.6094, "2025-10-28T22:00:02Z", mag=3.5)
    d = _make_event("d", "USGS2", -31.3086, -68.6175, "2025-10-28T22:00:03Z", mag=3.5)
    return a, b, c, d


def test_merge_all_sources_order_affects_swarm_detection():
    """
    Riesgo residual (Fase 0): ejecuta merge_all_sources sobre el fixture de
    4 reportes en dos órdenes distintas, corre _detect_swarms sobre cada
    resultado fusionado y compara si la alerta de enjambre dispara.

    Resultado esperado (confirmado empíricamente, ver docstring del
    módulo): ambos órdenes producen 3 eventos finales con el mismo set de
    ids {a, b, d}, pero SOLO en el segundo orden esos 3 eventos quedan
    mutuamente <=20km (b absorbe la posición de c) y el enjambre dispara.
    """
    a1, b1, c1, d1 = _swarm_order_fixture()
    order_no_swarm = merge_all_sources([a1], [b1], [c1], [d1])  # (usgs, emsc, inpres, usgs2)

    a2, b2, c2, d2 = _swarm_order_fixture()
    order_swarm = merge_all_sources([b2], [a2], [d2], [c2])  # (emsc, usgs, usgs2, inpres)

    def swarms_for(result):
        cluster_points = [
            {
                "t": parse_datetime_utc(e.hora_utc),
                "lat": e.lat,
                "lon": e.lon,
                "mag": e.mag,
                "id": e.id,
            }
            for e in result
        ]
        return _detect_swarms(cluster_points)

    swarms_a = swarms_for(order_no_swarm)
    swarms_b = swarms_for(order_swarm)

    # Ambos órdenes colapsan al mismo NÚMERO y SET de eventos finales: el
    # riesgo no está en el conteo, sino en las coordenadas post-fusión.
    assert len(order_no_swarm) == 3
    assert sorted(e.id for e in order_no_swarm) == ["a", "b", "d"]
    assert len(order_swarm) == 3
    assert sorted(e.id for e in order_swarm) == ["a", "b", "d"]

    # Evidencia central: mismo input, mismo conteo/ids finales, pero el
    # orden de fusión determina si la alerta de enjambre dispara o no.
    assert swarms_a == [], (
        f"Se esperaba que el orden (usgs,emsc,inpres,usgs2) NO detectara "
        f"enjambre; se obtuvo: {swarms_a}"
    )
    assert swarms_b == [["a", "b", "d"]], (
        f"Se esperaba que el orden (emsc,usgs,usgs2,inpres) SÍ detectara "
        f"enjambre {{a,b,d}}; se obtuvo: {swarms_b}"
    )

    # Alerta operativa completa: compute_kpis_and_alerts debe reflejar la
    # misma discrepancia (alerta tipo="enjambre" presente/ausente según
    # el orden), no solo _detect_swarms en aislamiento.
    _, alertas_a = compute_kpis_and_alerts(order_no_swarm, window_minutes=60)
    _, alertas_b = compute_kpis_and_alerts(order_swarm, window_minutes=60)

    tipos_a = {al.tipo for al in alertas_a}
    tipos_b = {al.tipo for al in alertas_b}

    assert "enjambre" not in tipos_a, f"No se esperaba alerta 'enjambre' en orden A: {alertas_a}"
    assert "enjambre" in tipos_b, f"Se esperaba alerta 'enjambre' en orden B: {alertas_b}"
