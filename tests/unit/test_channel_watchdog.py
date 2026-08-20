"""
Tests del watchdog de canales del ingestor SeedLink.

El problema que motiva esto (memoria "plan-espectrogramas-tiempo-real-y-
streaming"): los streams se caen de a uno — JP.JYT y JP.JWT murieron a las
11:22 UTC del 20/8, C1.MT18 llevaba >12h muda — mientras la conexión TCP
sigue viva y el resto de los canales fluye. El ingestor no se entera y la
única cura era un redeploy. El watchdog detecta canales mudos y decide
cuándo forzar una reconexión (que re-suscribe todo y los recupera).

La lógica es pura (sin threads ni sockets): recibe timestamps y decide.
El cableado con el cliente SeedLink real se testea aparte.
"""

from datetime import datetime, timedelta, timezone

from src.services.channel_watchdog import ChannelWatchdog

T0 = datetime(2026, 8, 20, 12, 0, 0, tzinfo=timezone.utc)


def _wd(stale_after_s: int = 300, max_strikes: int = 3) -> ChannelWatchdog:
    wd = ChannelWatchdog(stale_after_s=stale_after_s, max_strikes=max_strikes)
    wd.note_connected(["JP.JYT.BHZ", "UW.LON.HHZ"], now=T0)
    return wd


def test_recien_conectado_ningun_canal_es_stale():
    wd = _wd()
    assert wd.stale_channels(now=T0 + timedelta(seconds=10)) == []
    assert not wd.should_reconnect(now=T0 + timedelta(seconds=10))


def test_canal_sin_datos_pasado_el_umbral_es_stale():
    wd = _wd(stale_after_s=300)
    # UW.LON manda datos al segundo, JP.JYT se queda muda desde la conexión.
    wd.note_data("UW.LON.HHZ", now=T0 + timedelta(seconds=299))

    ahora = T0 + timedelta(seconds=301)
    assert wd.stale_channels(now=ahora) == ["JP.JYT.BHZ"]
    assert wd.should_reconnect(now=ahora)


def test_canal_que_dejo_de_mandar_datos_se_vuelve_stale():
    wd = _wd(stale_after_s=300)
    wd.note_data("JP.JYT.BHZ", now=T0 + timedelta(seconds=60))
    wd.note_data("UW.LON.HHZ", now=T0 + timedelta(seconds=400))

    # 301 s después del último dato de JP.JYT
    ahora = T0 + timedelta(seconds=60 + 301)
    assert wd.stale_channels(now=ahora) == ["JP.JYT.BHZ"]


def test_reconectar_resetea_la_base_y_no_regatilla_enseguida():
    """Tras una reconexión todos arrancan de cero: el propio umbral de
    staleness actúa de cooldown — no hay reconexiones en cascada."""
    wd = _wd(stale_after_s=300)
    ahora = T0 + timedelta(seconds=301)
    assert wd.should_reconnect(now=ahora)

    wd.note_reconnect(now=ahora)

    assert wd.stale_channels(now=ahora + timedelta(seconds=299)) == []
    assert not wd.should_reconnect(now=ahora + timedelta(seconds=299))


def test_canal_que_sigue_mudo_tras_max_strikes_queda_en_cuarentena():
    """Perseguir a la estación muda del día (caso CI.BAR) es un juego
    perdido: tras max_strikes reconexiones sin revivir, deja de gatillar."""
    wd = _wd(stale_after_s=300, max_strikes=3)
    ahora = T0
    for _ in range(3):
        ahora += timedelta(seconds=301)
        # UW.LON siempre viva; JP.JYT muda en cada ciclo.
        wd.note_data("UW.LON.HHZ", now=ahora)
        assert wd.should_reconnect(now=ahora)
        wd.note_reconnect(now=ahora)

    # Cuarta ventana: JP.JYT sigue muda pero ya agotó sus strikes.
    ahora += timedelta(seconds=301)
    wd.note_data("UW.LON.HHZ", now=ahora)
    assert wd.stale_channels(now=ahora) == []
    assert not wd.should_reconnect(now=ahora)


def test_un_dato_saca_al_canal_de_cuarentena():
    wd = _wd(stale_after_s=300, max_strikes=1)
    ahora = T0 + timedelta(seconds=301)
    wd.note_data("UW.LON.HHZ", now=ahora)
    wd.note_reconnect(now=ahora)  # JP.JYT se lleva su único strike

    # En cuarentena: muda otra vez y no gatilla.
    ahora += timedelta(seconds=301)
    wd.note_data("UW.LON.HHZ", now=ahora)
    assert not wd.should_reconnect(now=ahora)

    # La estación revive un instante y vuelve a callarse: gatilla de nuevo.
    wd.note_data("JP.JYT.BHZ", now=ahora)
    ahora += timedelta(seconds=301)
    wd.note_data("UW.LON.HHZ", now=ahora)
    assert wd.stale_channels(now=ahora) == ["JP.JYT.BHZ"]
    assert wd.should_reconnect(now=ahora)
