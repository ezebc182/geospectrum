"""WatchdogStateStore contra Redis real (testcontainers) — misma política del
proyecto que test_metrics_store.py: los mocks son ciegos a la semántica real
de Redis (TTL, persistencia). Acá interesa además confirmar la AUSENCIA de
TTL en `watchdog:state:{componente}` (a diferencia de MetricsStore), y que
una caída sostenida de varios ciclos preserva el `since` original sin volver
a escribirlo — ver spec, "Caída simulada prolongada verificable en Redis"."""

from src.services.watchdog import STATE_KEY_PREFIX, CheckResult, WatchdogStateStore, evaluate_and_notify


async def test_set_state_y_get_state_roundtrip_contra_redis_real(redis_url):
    store = WatchdogStateStore(_connected_client(redis_url))
    await store.set_state("api", status="down", since="2026-08-30T14:05:00+00:00")
    result = await store.get_state("api")
    assert result == {"status": "down", "since": "2026-08-30T14:05:00+00:00"}


async def test_watchdog_state_no_tiene_ttl(redis_url, redis_client):
    store = WatchdogStateStore(redis_client)
    await store.set_state("api", status="down", since="2026-08-30T14:05:00+00:00")
    # Sin TTL: -1 es el valor que devuelve Redis para "existe pero sin
    # expiración" (a diferencia de MetricsStore, que sí fija un TTL).
    ttl = await redis_client.ttl(f"{STATE_KEY_PREFIX}api")
    assert ttl == -1


async def test_caida_sostenida_de_3_ciclos_preserva_el_since_original(redis_url, redis_client):
    """Cubre el escenario de spec "Caída simulada prolongada verificable en
    Redis": 3 ciclos consecutivos de down deben persistir UN solo `since`
    (el de la primera transición), y notificar UNA sola vez."""
    store = WatchdogStateStore(redis_client)
    notified: list[str] = []

    async def _fake_notify(component, event, ntfy_topic_url, extra=None):
        notified.append(event)

    import src.services.watchdog as watchdog_module

    original = watchdog_module._notify_ntfy
    watchdog_module._notify_ntfy = _fake_notify
    try:
        down_result = CheckResult(up=False, detail="HTTP 500")
        for _ in range(3):
            await evaluate_and_notify("api", down_result, store, "https://ntfy.sh/test")

        state = await store.get_state("api")
        assert state["status"] == "down"
        assert notified == ["down"]  # una sola notificación en los 3 ciclos

        since_after_3_cycles = state["since"]

        # Un cuarto ciclo también down: el "since" sigue sin cambiar.
        await evaluate_and_notify("api", down_result, store, "https://ntfy.sh/test")
        state_after_4th = await store.get_state("api")
        assert state_after_4th["since"] == since_after_3_cycles
        assert notified == ["down"]
    finally:
        watchdog_module._notify_ntfy = original


def _connected_client(redis_url):
    import redis.asyncio as aioredis

    return aioredis.from_url(redis_url, decode_responses=True)
