"""Watchdog externo de servicios en Railway.

El dolor que resuelve: Railway ya reinicia solo los procesos que crashean de
verdad (`seedlink_ingestor.py` / `events_ingestor.py` terminan con un
`raise RuntimeError(...)` explícito si su loop principal vuelve sin deber
hacerlo — lección de "el ingestor salía con exit 0"). Pero ningún proceso
puede avisar de su propia caída si sigue VIVO pero dejó de producir algo
útil: un "falso vivo". Ejemplos reales que este módulo cubre: un
`seedlink_ingestor` colgado sin levantar la excepción, un `events_ingestor`
sin heartbeat que nadie notaría hasta el próximo sismo, un API que responde
pero con el pool de conexiones roto, o el dashboard de Vercel caído sin que
nada del lado del backend se entere.

Qué NO cubre: la caída total de un proceso (exit code != 0) — de eso ya se
encarga Railway solo, reiniciando el contenedor. Este módulo tampoco hace
ninguna forma de auto-remediación: solo detecta y notifica por ntfy.

Corre como proceso standalone (mismo patrón que `seedlink_ingestor.py` /
`events_ingestor.py`): un loop `asyncio` con `stop_event` esperado (no un
`sleep` pelado, mismo criterio que `disk_alert.py`). Cada uno de los 4
chequeos va envuelto en su propio `try/except` — un chequeo que revienta
no debe tumbar a los otros tres ni al ciclo siguiente.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import signal
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Optional

import asyncpg
import httpx
import redis.asyncio as aioredis

from src.config.settings import settings
from src.services.seedlink_ingestor import DEFAULT_CHANNELS

logger = logging.getLogger(__name__)

COMPONENTS = ("api", "ui", "seedlink", "events")

# Key que escribe events_ingestor.py en cada vuelta de su loop, independiente
# de si hubo sismos nuevos (ver design.md, Decision "Heartbeat de
# events_ingestor..."). El watchdog solo la lee.
EVENTS_HEARTBEAT_KEY = "events_ingestor:heartbeat"

# Prefijo de las keys de estado propio del watchdog (una por componente).
STATE_KEY_PREFIX = "watchdog:state:"


@dataclass(frozen=True)
class CheckResult:
    """Resultado binario de un chequeo, con detalle legible para ntfy."""

    up: bool
    detail: str  # para el body de ntfy: "HTTP 503", "sin datos de 3/3 canales", etc.


async def check_api(client: httpx.AsyncClient, url: str, timeout: float) -> CheckResult:
    """GET a `url`. No-200 o timeout/error de conexión cuenta como caído.

    Nunca propaga una excepción: un fallo de red del API no debe tumbar el
    resto del ciclo del watchdog (ver spec, "Aislamiento de fallos entre
    chequeos").
    """
    try:
        response = await client.get(url, timeout=timeout)
    except httpx.TimeoutException:
        return CheckResult(up=False, detail="timeout")
    except httpx.ConnectError:
        return CheckResult(up=False, detail="error de conexión")
    except Exception as exc:  # cualquier otro fallo de httpx no debe propagar
        logger.warning("watchdog.check_api: fallo inesperado consultando %s", url, exc_info=True)
        return CheckResult(up=False, detail=f"error inesperado: {exc}")

    if response.status_code != 200:
        return CheckResult(up=False, detail=f"HTTP {response.status_code}")
    return CheckResult(up=True, detail="HTTP 200")


async def check_ui(client: httpx.AsyncClient, url: str, timeout: float) -> CheckResult:
    """GET a la URL pública de la UI (Vercel), sin autenticación.

    Mismo patrón que check_api pero deliberadamente independiente: no
    comparte cliente httpx con estado ni resultado con check_api — la UI
    puede estar caída sin que el backend lo esté, y viceversa.
    """
    try:
        response = await client.get(url, timeout=timeout)
    except httpx.TimeoutException:
        return CheckResult(up=False, detail="timeout")
    except httpx.ConnectError:
        return CheckResult(up=False, detail="error de conexión")
    except Exception as exc:
        logger.warning("watchdog.check_ui: fallo inesperado consultando %s", url, exc_info=True)
        return CheckResult(up=False, detail=f"error inesperado: {exc}")

    if response.status_code != 200:
        return CheckResult(up=False, detail=f"HTTP {response.status_code}")
    return CheckResult(up=True, detail="HTTP 200")


async def check_seedlink(
    pool: "asyncpg.Pool | object", stale_after_s: int, expected_channels: list[str]
) -> CheckResult:
    """Determina si seedlink_ingestor está caído por canales mudos.

    "Caído" ÚNICAMENTE cuando TODOS los canales del catálogo activo esperado
    están mudos por encima de `stale_after_s`. Un subconjunto mudo, mientras
    quede al menos un canal activo, es comportamiento normal (SeedLink cae
    de a ratos por canal) y NO debe marcar `down`.

    Catálogo vacío (`expected_channels=[]`) es "no hay nada que chequear",
    NO "todo mudo" — se devuelve `up` sin tocar la base, para no confundir
    una situación operativa normal (sin estaciones suscriptas ahora) con una
    caída total (ver spec, "Catálogo de canales activos vacío no se confunde
    con caída total").
    """
    if not expected_channels:
        return CheckResult(up=True, detail="sin canales en el catálogo activo")

    # Redondeo hacia arriba: truncar 600s a 9 minutos sería MÁS estricto que
    # el umbral configurado (perdería hasta 59s de margen). math.ceil
    # garantiza que fetch_active_channels() nunca sea más exigente que
    # stale_after_s.
    minutes = math.ceil(stale_after_s / 60)
    active_channels = set(await pool.fetch_active_channels(minutes=minutes))
    expected = set(expected_channels)
    muted = expected - active_channels

    if not (expected & active_channels):
        # Intersección vacía: NINGÚN canal esperado está activo -> todos mudos.
        return CheckResult(
            up=False,
            detail=f"sin datos de {len(muted)}/{len(expected)} canales",
        )

    if muted:
        return CheckResult(
            up=True,
            detail=f"{len(muted)}/{len(expected)} canales mudos, resto activo",
        )

    return CheckResult(up=True, detail=f"{len(expected)}/{len(expected)} canales activos")


async def check_events(redis_client, ttl_grace_s: int = 0) -> CheckResult:
    """Determina si events_ingestor está caído por heartbeat en Redis.

    `events_ingestor:heartbeat` la escribe events_ingestor.py en cada vuelta
    de su loop (ver _heartbeat_loop en events_ingestor.py), con TTL nativo
    de Redis. La responsabilidad PRINCIPAL de "vencido" recae en ese TTL: si
    la key ya expiró, `get()` devuelve None y acá se marca down directo.

    `ttl_grace_s` es un chequeo de "vejez" DEFENSIVO y opcional (default 0 =
    desactivado, confía 100% en el TTL nativo de Redis): si se pasa un valor
    > 0, se interpreta como el umbral máximo de antigüedad tolerada para el
    heartbeat leído — cubre el caso patológico de una key presente pero con
    un timestamp viejo (ej. reloj desincronizado entre procesos, o un TTL
    mal configurado que dejó vivir una key más de la cuenta). Con
    `ttl_grace_s=0` cualquier heartbeat presente se considera `up` sin
    chequear su edad.
    """
    try:
        raw = await redis_client.get(EVENTS_HEARTBEAT_KEY)
    except Exception:
        logger.warning("watchdog.check_events: fallo leyendo Redis", exc_info=True)
        return CheckResult(up=False, detail="no se pudo leer el heartbeat (Redis no disponible)")

    if raw is None:
        return CheckResult(up=False, detail="heartbeat ausente (expiró o nunca se escribió)")

    try:
        heartbeat_ts = datetime.fromisoformat(raw)
    except ValueError:
        return CheckResult(up=False, detail=f"heartbeat con formato inválido: {raw!r}")

    age_s = (datetime.now(timezone.utc) - heartbeat_ts).total_seconds()
    if ttl_grace_s > 0 and age_s > ttl_grace_s:
        return CheckResult(up=False, detail=f"heartbeat vencido hace {age_s:.0f}s")

    return CheckResult(up=True, detail=f"heartbeat hace {age_s:.0f}s")


class WatchdogStateStore:
    """Estado persistido en Redis del último resultado conocido por componente.

    Mismo patrón `SET`/`GET` con JSON de `MetricsStore`
    (`src/services/metrics_store.py:22-41`), con una diferencia deliberada:
    acá NO hay TTL. `MetricsStore` cachea un valor que debe caducar si nadie
    lo renueva; `watchdog:state:{componente}` es el registro de un incidente
    que debe sobrevivir mientras dure la caída, aunque sean días — expirarlo
    por accidente perdería la deduplicación de notificaciones y el cálculo de
    duración de la caída al notificar la recuperación (ver design.md,
    Decision "Esquema de Redis").

    `None` en el valor de retorno de `get_state` significa "Redis no
    responde", NO "el componente nunca se chequeó" (ver design.md, Decision
    "Redis caído → notificar igual, degradando SIN estado"): CUALQUIER
    excepción de Redis se atrapa acá y se degrada a `None`/no-op, nunca
    propaga — el loop principal del watchdog interpreta esa degradación como
    "no hay evidencia de estado previo", nunca como un fallo que deba
    abortar el ciclo.
    """

    def __init__(self, redis_client) -> None:
        self._client = redis_client

    async def get_state(self, component: str) -> Optional[dict]:
        try:
            raw = await self._client.get(f"{STATE_KEY_PREFIX}{component}")
        except Exception:
            logger.warning(
                "watchdog.WatchdogStateStore.get_state: fallo leyendo Redis para %s",
                component,
                exc_info=True,
            )
            return None
        return json.loads(raw) if raw else None

    async def set_state(self, component: str, status: str, since: str) -> None:
        try:
            await self._client.set(
                f"{STATE_KEY_PREFIX}{component}",
                json.dumps({"status": status, "since": since}),
            )
        except Exception:
            logger.warning(
                "watchdog.WatchdogStateStore.set_state: fallo escribiendo Redis para %s",
                component,
                exc_info=True,
            )


# Tabla de tags/prioridad de ntfy por componente (ver design.md, Decision
# "Mensaje de ntfy"): título accionable + tag distintivo por componente, el
# operador sabe QUÉ se cayó con solo leer la notificación push.
_NTFY_COMPONENT_INFO = {
    "api": {"tag": "rotating_light", "label": "API"},
    "ui": {"tag": "globe_with_meridians", "label": "Dashboard (UI)"},
    "seedlink": {"tag": "satellite", "label": "SeedLink (ingesta en vivo)"},
    "events": {"tag": "earth_americas", "label": "Ingesta de eventos sísmicos"},
}


def _format_duration(delta_seconds: float) -> str:
    """Formatea una duración en segundos como '<Xm Ys>' para el body de ntfy."""
    total_seconds = int(delta_seconds)
    minutes, seconds = divmod(total_seconds, 60)
    return f"{minutes}m {seconds}s"


async def _notify_ntfy(
    component: str, event: str, ntfy_topic_url: str, extra: Optional[dict] = None
) -> None:
    """Envía una notificación por ntfy para una transición up<->down.

    `event` es `"down"` o `"up"` (recuperación). `extra` es un dict opcional
    con detalle adicional (`detail` del CheckResult, `since`/`duration_s` de
    la caída si se pudo calcular).
    """
    extra = extra or {}
    info = _NTFY_COMPONENT_INFO.get(component, {"tag": "warning", "label": component})
    label = info["label"]
    tag = info["tag"]
    detail = extra.get("detail", "")

    if event == "down":
        title = f"GeoSpectrum watchdog: {label} CAÍDO"
        priority = "urgent"
        tags = f"warning,{tag}"
        body = f"{label} no responde. Detalle: {detail}" if detail else f"{label} no responde."
    else:
        title = f"GeoSpectrum watchdog: {label} recuperado"
        priority = "default"
        tags = f"white_check_mark,{tag}"
        duration_s = extra.get("duration_s")
        if duration_s is not None:
            body = f"{label} volvió a responder. Estuvo caído {_format_duration(duration_s)}."
        else:
            body = (
                f"{label} volvió a responder (duración desconocida — Redis no "
                "disponible durante la caída)."
            )

    async with httpx.AsyncClient(timeout=10.0) as client:
        await client.post(
            ntfy_topic_url,
            content=body.encode("utf-8"),
            headers={"Title": title, "Priority": priority, "Tags": tags},
        )


async def evaluate_and_notify(
    component: str,
    result: CheckResult,
    store: "WatchdogStateStore",
    ntfy_topic_url: str,
) -> None:
    """Compara el resultado actual contra el estado persistido y notifica
    SOLO en las transiciones up->down / down->up (ver spec, "Deduplicación
    de notificaciones de caída" y "Notificación de recuperación con duración
    de la caída").

    `store.get_state(component)` devuelve `None` en DOS situaciones
    indistinguibles entre sí (ver design.md, Decision "Redis caído →
    notificar igual, degradando SIN estado"): Redis está caído/degradado, o
    es la primera vez que se chequea este componente (nunca se persistió
    estado). En ambos casos el comportamiento es el mismo por diseño: se
    notifica `down` SIEMPRE que `result.up` sea `False` (no hay forma de
    saber si ya se había notificado, se acepta el spam si es Redis caído), y
    NUNCA se notifica `up` (no hay "since" del cual calcular duración ni
    evidencia de que antes estuviera caído — sería una "recuperación
    fantasma"). Si el resultado actual es `up`, se intenta persistir un
    estado inicial (best-effort vía `set_state`, que ya degrada sola a
    no-op si Redis está caído) para que la próxima comparación tenga un
    "previous" real, sin que esto dispare ninguna notificación.
    """
    previous = await store.get_state(component)
    current_status = "up" if result.up else "down"

    if previous is None:
        if current_status == "down":
            await _notify_ntfy(component, "down", ntfy_topic_url, extra={"detail": result.detail})
        else:
            await store.set_state(component, status="up", since=datetime.now(timezone.utc).isoformat())
        return

    previous_status = previous.get("status")
    if previous_status == current_status:
        return  # sin cambio de estado: no notifica (up->up ni down->down)

    now_iso = datetime.now(timezone.utc).isoformat()

    if current_status == "down":
        # Transición up->down: nuevo incidente, "since" nuevo.
        await store.set_state(component, status="down", since=now_iso)
        await _notify_ntfy(component, "down", ntfy_topic_url, extra={"detail": result.detail})
    else:
        # Transición down->up: preserva el "since" original para calcular
        # la duración de la caída.
        since = previous.get("since")
        duration_s: Optional[float] = None
        if since:
            try:
                since_dt = datetime.fromisoformat(since)
                duration_s = (datetime.now(timezone.utc) - since_dt).total_seconds()
            except ValueError:
                duration_s = None
        await store.set_state(component, status="up", since=since)
        await _notify_ntfy(
            component,
            "up",
            ntfy_topic_url,
            extra={"detail": result.detail, "duration_s": duration_s},
        )


async def run_watchdog_loop(
    client: httpx.AsyncClient,
    pool: "asyncpg.Pool | object",
    redis_client: Any,
    store: "WatchdogStateStore",
    settings_snapshot: dict,
    stop_event: asyncio.Event,
) -> None:
    """Ciclo principal: corre los 4 chequeos + evaluate_and_notify cada
    `settings_snapshot["interval_seconds"]`, hasta que `stop_event` se setea.

    Calca el patrón `while not stop_event.is_set(): ... await
    asyncio.wait_for(stop_event.wait(), timeout=interval_seconds)` de
    `disk_alert.py:75-94` — NO un `sleep` pelado, para no demorar el
    shutdown cuando Railway manda SIGTERM.

    Cada chequeo (y su `evaluate_and_notify` correspondiente) va envuelto en
    su propio `try/except Exception` INDIVIDUAL dentro del ciclo (mismo
    criterio que `disk_alert.py:85-90`): si `check_seedlink` revienta con
    una excepción no anticipada, los otros 3 chequeos del mismo ciclo deben
    ejecutarse igual — ver spec, "Aislamiento de fallos entre chequeos". Un
    chequeo que falla así NO llega a `evaluate_and_notify` en ese ciclo (no
    hay `CheckResult` que evaluar), pero el ciclo entero no aborta ni el
    proceso deja de despertar en el próximo ciclo programado.
    """
    interval_seconds = settings_snapshot["interval_seconds"]
    ntfy_topic_url = settings_snapshot["ntfy_topic_url"]

    while not stop_event.is_set():
        try:
            api_result = await check_api(
                client, settings_snapshot["api_url"], settings_snapshot["api_timeout_s"]
            )
            await evaluate_and_notify("api", api_result, store, ntfy_topic_url)
        except Exception:
            logger.warning("watchdog: chequeo de api falló, se reintenta en el próximo ciclo", exc_info=True)

        try:
            ui_url = settings_snapshot.get("ui_url")
            if ui_url is None:
                logger.info("watchdog: WATCHDOG_UI_URL no configurada, se salta el chequeo de ui")
            else:
                ui_result = await check_ui(client, ui_url, settings_snapshot["ui_timeout_s"])
                await evaluate_and_notify("ui", ui_result, store, ntfy_topic_url)
        except Exception:
            logger.warning("watchdog: chequeo de ui falló, se reintenta en el próximo ciclo", exc_info=True)

        try:
            seedlink_result = await check_seedlink(
                pool,
                settings_snapshot["seedlink_stale_after_seconds"],
                settings_snapshot["expected_channels"],
            )
            await evaluate_and_notify("seedlink", seedlink_result, store, ntfy_topic_url)
        except Exception:
            logger.warning(
                "watchdog: chequeo de seedlink falló, se reintenta en el próximo ciclo", exc_info=True
            )

        try:
            events_result = await check_events(redis_client)
            await evaluate_and_notify("events", events_result, store, ntfy_topic_url)
        except Exception:
            logger.warning(
                "watchdog: chequeo de events falló, se reintenta en el próximo ciclo", exc_info=True
            )

        try:
            await asyncio.wait_for(stop_event.wait(), timeout=interval_seconds)
        except asyncio.TimeoutError:
            pass


async def _main() -> None:
    """Arranque real del proceso standalone (invocado por `asyncio.run` desde
    el bloque `if __name__ == "__main__":` de más abajo).

    Se define a NIVEL DE MÓDULO (no anidada dentro del `if __name__`,
    a diferencia de `events_ingestor.py`/`seedlink_ingestor.py`) a propósito:
    así queda importable y testeable directamente
    (`test_main_no_arranca_el_loop_si_watchdog_enabled_es_false`), sin
    depender de ejecutar el módulo como script ni de `runpy` para verificar
    el camino opt-in — mismo comportamiento, un nivel de indentación menos.

    Servicio opt-in: si `WATCHDOG_ENABLED` no está seteado a `true`, el
    proceso loguea un mensaje informativo y vuelve SIN levantar ninguna
    excepción y SIN intentar conectar a Postgres/Redis/httpx — apagarlo vía
    env var es un rollback limpio (ver proposal.md, "Rollback Plan"), no un
    error, y no debe generar tráfico saliente innecesario.
    """
    if not settings.watchdog_enabled:
        logger.info(
            "watchdog: WATCHDOG_ENABLED=false — el proceso no arranca el loop "
            "(no-op limpio, ver proposal.md 'Rollback Plan')"
        )
        return

    if settings.timescaledb_dsn is None:
        raise RuntimeError(
            "watchdog: falta la config de Postgres "
            "(TIMESCALEDB_HOST/USER/PASSWORD) — sin base no puede chequear seedlink"
        )
    if not settings.watchdog_ntfy_topic_url:
        raise RuntimeError(
            "watchdog: falta WATCHDOG_NTFY_TOPIC_URL — sin topic no hay dónde notificar"
        )

    stop_event = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        # Mismo patrón que seedlink_ingestor.py/events_ingestor.py: cerrar
        # limpio en Railway (SIGTERM) sin esperar a que el proceso lo mate a
        # la fuerza.
        loop.add_signal_handler(sig, stop_event.set)

    client = httpx.AsyncClient()
    # Pool de SOLO LECTURA: mismo DSN que TimescaleColumnWriter, sin permisos
    # de escritura adicionales — el watchdog únicamente hace SELECT vía
    # fetch_active_channels.
    pool = await asyncpg.create_pool(settings.timescaledb_dsn)
    redis_client = aioredis.from_url(settings.redis_url, decode_responses=True)
    await redis_client.ping()

    store = WatchdogStateStore(redis_client)

    # Catálogo de canales activos esperados: reutiliza DEFAULT_CHANNELS tal
    # cual (sin duplicar la lista), mismo formato "NET.STA.CHAN" que escribe
    # seedlink_ingestor.py:387 en spectrogram_columns.
    expected_channels = [f"{net}.{sta}.{cha}" for net, sta, cha in DEFAULT_CHANNELS]

    settings_snapshot = {
        "interval_seconds": settings.watchdog_interval_seconds,
        "api_url": settings.watchdog_api_url,
        "ui_url": settings.watchdog_ui_url,
        "api_timeout_s": settings.watchdog_api_timeout_s,
        "ui_timeout_s": settings.watchdog_ui_timeout_s,
        "seedlink_stale_after_seconds": settings.watchdog_seedlink_stale_after_seconds,
        "expected_channels": expected_channels,
        "ntfy_topic_url": settings.watchdog_ntfy_topic_url,
    }

    logger.info(
        "watchdog: arrancando — ciclo cada %ds, %d canales esperados",
        settings_snapshot["interval_seconds"],
        len(expected_channels),
    )

    try:
        await run_watchdog_loop(
            client=client,
            pool=pool,
            redis_client=redis_client,
            store=store,
            settings_snapshot=settings_snapshot,
            stop_event=stop_event,
        )
    finally:
        logger.info("watchdog: cerrando")
        await client.aclose()
        await pool.close()
        await redis_client.aclose()


if __name__ == "__main__":
    """
    Proceso independiente. Uso:
        python -m src.services.watchdog

    Mismo patrón de arranque/cierre que `seedlink_ingestor.py` /
    `events_ingestor.py`: logging.basicConfig, manejo de SIGTERM/SIGINT
    seteando un stop_event (ver `_main()` arriba), asyncio.run(_main()).
    """
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    asyncio.run(_main())
