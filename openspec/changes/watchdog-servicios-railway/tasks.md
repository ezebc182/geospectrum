# Tasks: Watchdog externo de servicios en Railway

> **Orden estricto de fases**: 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7.
> Las Fases 2 y 3 dependen de la 1 (settings). La Fase 4 (heartbeat de
> `events_ingestor.py`) es independiente de 2/3 y puede intercalarse, pero se
> deja después porque toca un proceso YA en producción — conviene tener los 4
> chequeos y el store de estado ya probados antes de arriesgar ese archivo.
> La Fase 5 (loop + `__main__`) necesita 1, 2 y 3 completas. La Fase 6
> (Dockerfile) puede hacerse en paralelo a 5. La Fase 7 cierra el change.
>
> **Convenciones no negociables de este change:**
> - Identificadores en INGLÉS, comentarios y docstrings en ESPAÑOL.
> - Backend: `./venv/bin/python -m pytest` (el venv está en `venv/`, NO en `.venv/`).
> - **Nunca correr `next build`** (no aplica a este change — es puro backend
>   Python, pero queda dicho para no romper el server de dev de otra sesión
>   concurrente).
> - TDD real: el test se escribe ANTES o junto con el código, nunca después.
>   Cada test marcado "crítico" abajo se verifica por mutación (romper el
>   código a propósito, confirmar rojo, revertir) ANTES de darlo por bueno —
>   registrar cada mutación en `mutation-log.md` de este change.
> - Cualquier tarea que toque `events_ingestor.py` lleva un test explícito de
>   que el heartbeat roto NO tumba el `gather()` ni dispara el
>   `raise RuntimeError` de cierre (memoria del proyecto: "el ingestor salía
>   con exit 0").
> - Cada chequeo/loop va envuelto en su propio `try/except` — un fallo aislado
>   no debe tumbar el ciclo completo ni el proceso.

---

## Phase 0: Preparación transversal

- [x] 0.1 Correr `./venv/bin/python -m pytest tests/ -q` en la raíz del
      proyecto ANTES de tocar cualquier archivo y registrar el conteo exacto
      de tests y cobertura en la sección "Baseline registrada" de
      `openspec/changes/watchdog-servicios-railway/mutation-log.md` (ya creado
      con la tabla vacía). Sin la baseline registrada no se puede afirmar
      después que "la suite quedó verde".
      **Resultado**: `9 failed, 658 passed, 2 skipped, 8 warnings, 330 errors`.
      Los 330 `errors` son por Docker caído en el entorno de ejecución
      (testcontainer, no regresión de código) — causa raíz verificada con
      traceback y documentada en `mutation-log.md`.
- [x] 0.2 Confirmar que `openspec/changes/watchdog-servicios-railway/mutation-log.md`
      existe con las columnas `#`, `archivo`, `mutación`, `salida del rg`,
      `test que se puso rojo`, `revertido (sí/no)` — ya creado en este change,
      solo verificar que no se haya perdido en el checkout de la rama de trabajo.
      Verificado: las 6 columnas están presentes en la tabla "Registro".

---

## Phase 1: Fundamentos — settings y documentación de entorno

**Estado desplegable al cerrar la fase**: la app sigue arrancando igual que
antes (todas las settings nuevas tienen default seguro), sin ningún chequeo ni
loop nuevo todavía.

- [ ] 1.1 En `src/config/settings.py`, agregar el bloque `watchdog_*` inmediatamente
      después del bloque `disk_alert_*` (línea ~103, antes de `# Rate limiting`),
      con el mismo estilo de comentario narrativo que ese bloque:
      ```python
      watchdog_enabled: bool = False
      watchdog_ntfy_topic_url: Optional[str] = None
      watchdog_interval_seconds: int = 300
      watchdog_api_url: str = "https://api.geospectrum.org/health"
      watchdog_ui_url: Optional[str] = None
      watchdog_api_timeout_s: float = 10.0
      watchdog_ui_timeout_s: float = 10.0
      watchdog_seedlink_stale_after_seconds: int = 600
      watchdog_events_heartbeat_ttl_seconds: int = 180
      ```
      El comentario debe explicar (en español, citando el proposal): qué caso
      cubre el watchdog que Railway no puede ver (falso vivo), por qué
      `watchdog_seedlink_stale_after_seconds` es 600 y no 300 ni 900 (ver
      design.md, Decision "Umbral de seedlink_ingestor caído"), y que
      `watchdog_ui_url` es `Optional[str] = None` a propósito — sin
      configurarlo, ese chequeo específico se salta con un `logger.info`, no
      bloquea a los otros tres.
      *Criterio de aceptación*: `rg -n "watchdog_" src/config/settings.py`
      muestra las 9 claves nuevas; `./venv/bin/python -c "from src.config.settings import settings; print(settings.watchdog_enabled)"`
      imprime `False` sin levantar excepción.
      **[x] Hecho.** Bloque agregado en `src/config/settings.py` (después de
      `disk_alert_*`, antes de `# Rate limiting`), con comentario narrativo.
      Verificado: `rg -n "watchdog_"` muestra las 9 claves, el import imprime
      `False`.
- [x] 1.2 En `src/services/events_ingestor.py`, agregar la settings
      `watchdog_events_heartbeat_interval_seconds: int = 60` al bloque
      `watchdog_*` de `src/config/settings.py` (se documenta acá porque la
      ESCRIBE `events_ingestor.py`, no `watchdog.py`, pero la declaración vive
      en el mismo `settings.py` — no crear un `Settings` paralelo). Agregar el
      comentario que explica que el intervalo (60s) coincide con el poll de
      USGS y que el TTL (`watchdog_events_heartbeat_ttl_seconds`, ya agregado
      en 1.1) es 3x ese intervalo, mismo margen que ya usa `fdsn_warmup` entre
      ciclo y TTL.
      *Criterio de aceptación*: `rg -n "watchdog_events_heartbeat_interval_seconds" src/config/settings.py`
      muestra la clave nueva.
      **[x] Hecho.** Verificado con `rg`, la clave está en el mismo bloque de 1.1.
- [x] 1.3 **Completada — verificación manual del usuario (no automatizada).** Actualizar `.env.example` agregando, en una sección nueva
      `# Watchdog de servicios (Railway)` calcada del estilo de la sección
      `# Alerta de disco de TimescaleDB` existente: `WATCHDOG_ENABLED`,
      `WATCHDOG_NTFY_TOPIC_URL`, `WATCHDOG_INTERVAL_SECONDS`,
      `WATCHDOG_API_URL`, `WATCHDOG_UI_URL`,
      `WATCHDOG_SEEDLINK_STALE_AFTER_SECONDS`,
      `WATCHDOG_EVENTS_HEARTBEAT_TTL_SECONDS`,
      `WATCHDOG_EVENTS_HEARTBEAT_INTERVAL_SECONDS`, cada una con un comentario
      de una línea y su valor default comentado (igual formato que las
      variables de `disk_alert_*` ya documentadas ahí).
      *Criterio de aceptación*: `rg -n "WATCHDOG_" .env.example` muestra las
      8 variables.
      **NOTA DE VERIFICACIÓN**: ni el orquestador ni ningún sub-agente de
      esta sesión tuvieron permiso de Bash/Read/Edit sobre `.env.example`
      — la sandbox del harness rechaza cualquier acceso a ese archivo
      (`Permission ... has been denied` / `File is in a directory that is
      denied by your permission settings`), incluso para lectura, y esto
      persistió en dos sub-agentes distintos lanzados en momentos
      diferentes (bloqueo de directorio a nivel de configuración de sesión,
      no un permiso puntual). El usuario aplicó el bloque de abajo a mano y
      confirmó explícitamente ("copié y pegué tal cual, con los # en todas
      las líneas") — dado por completado por esa confirmación, SIN
      verificación automatizada por `rg`. Si en una sesión futura con
      permisos distintos se puede confirmar con
      `rg -n "WATCHDOG_" .env.example`, hacerlo. Contenido aplicado:
      ```
      # Watchdog de servicios (Railway)
      # WATCHDOG_ENABLED=true SOLO en el servicio watchdog dedicado — detecta
      # el caso que Railway no puede ver: un proceso vivo pero que dejó de
      # producir algo útil ("falso vivo").
      # WATCHDOG_ENABLED=false
      # Topic ntfy dedicado, separado del de disk_alert.
      # WATCHDOG_NTFY_TOPIC_URL=https://ntfy.sh/geospectrum-watchdog-02d73c9b7f34
      # Ciclo del loop principal, en segundos.
      # WATCHDOG_INTERVAL_SECONDS=300
      # WATCHDOG_API_URL=https://api.geospectrum.org/health
      # URL pública del dashboard en Vercel. Sin configurar, ese chequeo se
      # salta (no bloquea a los otros tres).
      # WATCHDOG_UI_URL=
      # 600s = 2 ciclos del watchdog. Ver settings.py para el razonamiento
      # completo de por qué no es 300 ni 900.
      # WATCHDOG_SEEDLINK_STALE_AFTER_SECONDS=600
      # TTL del heartbeat de events_ingestor en Redis (3x el intervalo).
      # WATCHDOG_EVENTS_HEARTBEAT_TTL_SECONDS=180
      # Intervalo de escritura del heartbeat (coincide con el poll de USGS).
      # WATCHDOG_EVENTS_HEARTBEAT_INTERVAL_SECONDS=60
      ```
- [x] 1.4 Test de settings: en `tests/unit/test_settings.py` (crear si no
      existe un archivo de tests de settings; si existe uno, agregar ahí),
      verificar que `Settings()` sin ninguna variable de entorno de watchdog
      seteada produce `watchdog_enabled is False`,
      `watchdog_ui_url is None`, `watchdog_seedlink_stale_after_seconds == 600`
      y `watchdog_api_url == "https://api.geospectrum.org/health"`. Este test
      NO es crítico (no necesita mutación) — es un test de regresión de
      defaults, cubre que un despliegue sin las env vars nuevas sigue
      arrancando con el watchdog apagado.
      **[x] Hecho.** Creado `tests/unit/test_settings.py` con
      `test_watchdog_settings_tienen_defaults_seguros_sin_env_vars`, siguiendo
      el patrón `Settings(_env_file=None)` + `monkeypatch.delenv(...)` ya
      usado en `test_auth_service.py` para `google_oauth_configured`. Verde:
      `1 passed in 0.10s`.

---

## Phase 2: Los 4 chequeos como funciones puras

**Estado desplegable al cerrar la fase**: existen `check_api`, `check_ui`,
`check_seedlink`, `check_events` en `src/services/watchdog.py`, cada una
100% testeada y verificada por mutación. Todavía NO hay loop, NO hay
persistencia de estado, NO hay notificación ntfy — cada función es pura
respecto de sus dependencias inyectadas (cliente httpx, pool asyncpg, cliente
Redis), sin efectos secundarios propios.

- [x] 2.1 Crear `src/services/watchdog.py` con el docstring de módulo (español,
      mismo tono que `disk_alert.py`: qué dolor resuelve — citar el caso
      "falso vivo" del proposal — y qué NO cubre — la caída total que Railway
      ya reinicia solo). Definir `COMPONENTS = ("api", "ui", "seedlink", "events")`
      y la dataclass/NamedTuple:
      ```python
      @dataclass(frozen=True)
      class CheckResult:
          up: bool
          detail: str  # para el body de ntfy: "HTTP 503", "sin datos de 3/3 canales", etc.
      ```
- [x] 2.2 (RED) Escribir `tests/unit/test_watchdog_checks.py::test_check_api_up_en_200`
      y `test_check_api_down_en_500` ANTES de implementar `check_api` — deben
      fallar por `ImportError`/`AttributeError` (la función no existe aún).
      Mockear `httpx.AsyncClient.get` (usar `respx` si ya está en
      `requirements.txt`, o un mock manual de `AsyncClient` — verificar cuál
      patrón ya usa el proyecto para mockear httpx en tests existentes de
      `disk_alert.py`/`fdsn_warmup` antes de introducir una dependencia nueva).
- [x] 2.3 (GREEN) Implementar
      `async def check_api(client: httpx.AsyncClient, url: str, timeout: float) -> CheckResult`
      en `watchdog.py`: `GET url` con `timeout=timeout`; si el status no es
      200, `CheckResult(up=False, detail=f"HTTP {response.status_code}")`; si
      `httpx.TimeoutException` o `httpx.ConnectError`,
      `CheckResult(up=False, detail="timeout")` o `"error de conexión"`
      respectivamente — capturados con `try/except`, NUNCA dejar que la
      excepción de red se propague fuera de `check_api`. Si 200,
      `CheckResult(up=True, detail="HTTP 200")`.
      *Criterio de aceptación*: los dos tests de 2.2 pasan.
- [x] 2.4 (RED) Escribir
      `test_check_api_down_por_timeout_no_bloquea_el_ciclo` — mockear el
      cliente para que lance `httpx.TimeoutException` y verificar que
      `check_api` devuelve `CheckResult(up=False, ...)` en vez de propagar la
      excepción (cubre el escenario de spec "API no responde dentro del
      timeout" — el chequeo no debe bloquear indefinidamente el resto del
      ciclo).
- [x] 2.5 **Mutación crítica sobre `check_api`**: invertir la condición
      `if response.status_code != 200` → `if response.status_code == 200`
      (o equivalente), confirmar con `rg -n "status_code" src/services/watchdog.py`
      que el archivo cambió, correr
      `./venv/bin/python -m pytest tests/unit/test_watchdog_checks.py -k check_api -q`,
      registrar en `mutation-log.md` cuál test se puso rojo, revertir y
      confirmar verde de nuevo.
- [x] 2.6 (RED+GREEN) Implementar `check_ui` como copia estructural de
      `check_api` (mismo criterio de timeout/status, distinto parámetro de
      URL), con sus propios tests
      `test_check_ui_up_en_200`, `test_check_ui_down_en_timeout`. Reutilizar
      helpers de mock de 2.2 si el patrón lo permite, sin duplicar lógica de
      test innecesariamente.
      *Nota de diseño a respetar*: el chequeo de UI es independiente del de
      API — no debe compartir estado ni cliente httpx que acople sus
      resultados (dos `AsyncClient` o el mismo cliente reutilizado sin estado
      compartido entre llamadas, cualquiera de las dos formas es válida
      mientras un fallo de una no contamine a la otra).
- [x] 2.7 **Mutación crítica sobre `check_ui`**: mismo protocolo que 2.5,
      invirtiendo la condición de status en `check_ui`. Registrar en
      `mutation-log.md`.
- [x] 2.8 (RED) Escribir tests de `check_seedlink` ANTES de implementarla, en
      `tests/unit/test_watchdog_checks.py`, cubriendo los 4 escenarios de la
      spec (`observability/spec.md`, Requirement "Chequeo de seedlink_ingestor
      por canales mudos"):
      - `test_check_seedlink_todos_mudos_marca_down`: `fetch_active_channels`
        mockeado devuelve `[]`, catálogo esperado tiene N>0 canales → `down`.
      - `test_check_seedlink_un_canal_mudo_otros_activos_marca_up`:
        `fetch_active_channels` devuelve un subconjunto (falta 1 de N) → `up`,
        sin notificación (esto se verifica en la Fase 3, acá solo el
        `CheckResult`).
      - `test_check_seedlink_todos_activos_marca_up`: `fetch_active_channels`
        devuelve el catálogo completo → `up`.
      - `test_check_seedlink_catalogo_vacio_no_es_caida`: catálogo esperado
        vacío (`expected_channels=[]`) → `up` o un estado explícito que NO sea
        `down` (decidir en la implementación y dejarlo dicho en el docstring
        de la función: catálogo vacío es "no hay nada que chequear", NO es
        "todo mudo").
- [x] 2.9 (GREEN) Implementar
      `async def check_seedlink(pool: asyncpg.Pool, stale_after_s: int, expected_channels: list[str]) -> CheckResult`
      en `watchdog.py`: instanciar o reutilizar `TimescaleColumnWriter` (o
      llamar directo al método si `fetch_active_channels` se expone como
      función libre — usar el mismo objeto/patrón que ya usa
      `src/services/timescale_service.py:88`), pedir
      `fetch_active_channels(minutes=stale_after_s // 60)` (o ajustar la
      conversión a minutos con `math.ceil` si `stale_after_s` no es múltiplo
      exacto de 60 — dejar explícito en un comentario por qué se redondea para
      arriba: un umbral de 600s truncado a 9 minutos sería más estricto que lo
      configurado). Si `expected_channels` está vacío, devolver
      `CheckResult(up=True, detail="sin canales en el catálogo activo")` ANTES
      de tocar la base (no hace falta ni la consulta). Si no está vacío,
      `down` únicamente cuando la intersección entre `expected_channels` y el
      resultado de `fetch_active_channels` esté vacía; `detail` debe indicar
      cuántos de cuántos están mudos (`"sin datos de 3/3 canales"` o
      `"1/3 canales mudos, resto activo"` según el caso).
      *Criterio de aceptación*: los 4 tests de 2.8 pasan.
- [x] 2.10 **Mutación crítica sobre `check_seedlink`**: cambiar la condición
      "TODOS mudos" por "ALGÚN mudo" (ej. invertir de intersección vacía a
      unión incompleta), confirmar con `rg` el cambio real en el archivo,
      correr los tests de 2.8, registrar cuál(es) se pusieron rojos —
      **debe ponerse rojo específicamente `test_check_seedlink_un_canal_mudo_otros_activos_marca_up`**,
      que es el escenario que distingue ambas fórmulas; si ese test queda
      verde con la mutación aplicada, el test está mal escrito y hay que
      corregirlo antes de continuar (misma lección que la mutación #9 del
      change `analiticas-profesionales-senal`: un punto de prueba donde ambas
      fórmulas coinciden no prueba nada). Revertir y confirmar verde.
- [x] 2.11 (RED) Escribir tests de `check_events` ANTES de implementarla:
      `test_check_events_heartbeat_ausente_marca_down` (mock de Redis
      `get()` devuelve `None`), `test_check_events_heartbeat_reciente_marca_up`
      (mock devuelve un timestamp ISO8601 de hace pocos segundos),
      `test_check_events_heartbeat_viejo_marca_down` (mock devuelve un
      timestamp ISO8601 de hace más que el TTL esperado — cubre el caso de
      key presente pero vieja, no solo ausente).
- [x] 2.12 (GREEN) Implementar
      `async def check_events(redis_client, ttl_grace_s: int = 0) -> CheckResult`
      en `watchdog.py`: `GET events_ingestor:heartbeat`; si `None`,
      `CheckResult(up=False, detail="heartbeat ausente (expiró o nunca se escribió)")`;
      si presente, parsear el ISO8601 y comparar contra `now()` — como Redis
      ya aplica TTL nativo, la key presente implica que está dentro del TTL,
      así que el chequeo de "vieja" es defensivo (ej. reloj desincronizado
      entre procesos) y usa `ttl_grace_s` como margen adicional si aplica;
      documentar en el docstring que la responsabilidad principal de
      "vencido" recae en el TTL de Redis, no en este cálculo.
      *Criterio de aceptación*: los 3 tests de 2.11 pasan.
- [x] 2.13 **Mutación crítica sobre `check_events`**: invertir la condición de
      "key ausente marca down" (ej. `if raw is None: down` →
      `if raw is not None: down`), confirmar con `rg`, correr los tests de
      2.11, registrar cuál se puso rojo, revertir.
- [x] 2.14 Correr `./venv/bin/python -m pytest tests/unit/test_watchdog_checks.py -q`
      completo y confirmar que las 4 mutaciones (2.5, 2.7, 2.10, 2.13) están
      registradas en `mutation-log.md` con su salida de `rg` y el test que se
      puso rojo.

---

## Phase 3: Estado en Redis y deduplicación de notificaciones

**Estado desplegable al cerrar la fase**: `WatchdogStateStore` y
`evaluate_and_notify` existen y están probados contra un Redis simulado (mock)
y, si el testcontainer está disponible, contra uno real. Todavía no hay loop
principal ni `__main__` — esta fase cierra la lógica de decisión, no el
proceso completo.

- [x] 3.1 (RED) Escribir `tests/unit/test_watchdog_state_store.py` ANTES de
      implementar `WatchdogStateStore`:
      - `test_get_state_devuelve_none_si_no_existe_la_key`.
      - `test_set_state_y_get_state_roundtrip`: guardar `{"status": "down", "since": "<iso>"}`
        para un componente y leerlo de vuelta igual.
      - `test_get_state_degradado_si_redis_falla`: mock del cliente Redis que
        lanza una excepción en `get()` → `get_state` devuelve `None` (no
        propaga).
      - `test_set_state_degradado_si_redis_falla`: mock que lanza en `set()`
        → `set_state` no propaga (se loguea y sigue).
- [x] 3.2 (GREEN) Implementar `WatchdogStateStore` en `watchdog.py` siguiendo
      el patrón de `MetricsStore` (`src/services/metrics_store.py:22-41`):
      ```python
      class WatchdogStateStore:
          def __init__(self, redis_client) -> None: ...
          async def get_state(self, component: str) -> Optional[dict]: ...
          async def set_state(self, component: str, status: str, since: str) -> None: ...
      ```
      Key: `watchdog:state:{component}`, valor JSON `{"status": ..., "since": ...}`,
      **sin TTL** (a diferencia de `MetricsStore.set_snapshot`, que sí usa TTL
      — dejar explícito en el docstring de la clase POR QUÉ acá no aplica: el
      registro de un incidente debe sobrevivir mientras dure la caída, aunque
      sean días). `get_state`/`set_state` envuelven CUALQUIER excepción de
      Redis en `try/except` y devuelven `None`/no-op respectivamente,
      logueando con `logger.warning(..., exc_info=True)`.
      *Criterio de aceptación*: los 4 tests de 3.1 pasan.
- [x] 3.3 **Mutación crítica sobre `WatchdogStateStore.get_state`**: quitar el
      `try/except` (dejar que la excepción de Redis propague), confirmar con
      `rg` que el archivo cambió, correr
      `./venv/bin/python -m pytest tests/unit/test_watchdog_state_store.py -q`,
      confirmar que `test_get_state_degradado_si_redis_falla` se pone rojo
      (con un error no controlado en vez de devolver `None`), registrar en
      `mutation-log.md`, revertir.
- [x] 3.4 (RED) Escribir `tests/unit/test_watchdog_evaluate_and_notify.py`
      ANTES de implementar `evaluate_and_notify`, cubriendo TODOS los
      escenarios de la spec (Requirement "Deduplicación de notificaciones de
      caída" + "Notificación de recuperación con duración de la caída" +
      "Comportamiento con Redis caído"):
      - `test_primera_deteccion_de_caida_notifica`: estado previo `up`,
        resultado actual `down` → se llama al POST de ntfy UNA vez, y
        `set_state` se llama con `status="down"` y un `since` nuevo.
      - `test_caida_sostenida_no_repite_notificacion`: estado previo
        `{"status": "down", "since": "<t0>"}`, resultado actual `down` → el
        POST de ntfy NO se llama, y `set_state` NO se llama (o se llama sin
        cambiar `since` — decidir en la implementación y fijarlo en el test).
      - `test_recuperacion_notifica_con_duracion`: estado previo
        `{"status": "down", "since": "<t0>"}`, resultado actual `up` → se
        llama al POST de ntfy UNA vez con la duración calculada
        (`now - t0`) en el body, y `set_state` se llama con `status="up"`.
      - `test_recuperacion_sin_caida_previa_no_notifica`: estado previo `up`,
        resultado actual `up` → ningún POST, ningún `set_state`.
      - `test_redis_caido_notifica_down_sin_deduplicar`: `store.get_state`
        devuelve `None` (simulando degradación), resultado actual `down` → SÍ
        se llama al POST de ntfy (con el mensaje indicando que no se pudo
        confirmar si es una caída nueva), y no revienta al no poder comparar
        contra un estado inexistente.
      - `test_redis_caido_no_notifica_recuperacion_fantasma`: `store.get_state`
        devuelve `None`, resultado actual `up` → NO se llama al POST de ntfy
        (no hay "since" del cual calcular duración, y no hay evidencia de que
        antes estuviera caído — comportamiento explícito del design.md,
        Decision "Redis caído → notificar igual, degradando SIN estado").
      Mockear `_notify_ntfy` (o el cliente httpx que usa) para capturar el
      payload exacto en cada caso, no solo si fue llamado.
- [x] 3.5 (GREEN) Implementar
      ```python
      async def evaluate_and_notify(
          component: str, result: CheckResult, store: WatchdogStateStore, ntfy_topic_url: str,
      ) -> None:
      ```
      en `watchdog.py`, con la lógica exacta descrita en los tests de 3.4:
      leer `store.get_state(component)`; si es `None` (Redis caído), notificar
      `down` siempre y nunca `up`; si hay estado previo, comparar
      `previous["status"]` contra `"down" if not result.up else "up"` y
      notificar solo en transición, actualizando `store.set_state(...)` con
      el `since` correspondiente (nuevo timestamp en la transición a `down`,
      preservado tal cual en la transición a `up` para poder calcular la
      duración en el mensaje).
      *Criterio de aceptación*: los 6 tests de 3.4 pasan.
- [x] 3.6 **Mutación crítica sobre `evaluate_and_notify`**: quitar la
      comparación de transición (hacer que notifique SIEMPRE,
      independientemente del estado previo), confirmar con `rg` el cambio,
      correr los tests de 3.4, confirmar que
      `test_caida_sostenida_no_repite_notificacion` y
      `test_recuperacion_sin_caida_previa_no_notifica` se ponen rojos (deben
      ser los únicos, o al menos estar entre los que fallan — si TODOS los
      tests se ponen rojos, revisar que los que dependen de la primera
      transición no estén mal aislados), registrar en `mutation-log.md`,
      revertir.
- [x] 3.7 Implementar `_notify_ntfy(component, event, extra)` en `watchdog.py`
      según la tabla de tags/prioridad del design.md (Decision "Mensaje de
      ntfy"): título, tags y prioridad por componente (`api`/`ui`/`seedlink`/`events`),
      body distinto para caída vs. recuperación (con duración si se pudo
      calcular, o el mensaje de "duración desconocida — Redis no disponible
      durante la caída" si no). Test
      `test_notify_ntfy_arma_el_payload_correcto_por_componente` parametrizado
      sobre los 4 componentes, verificando título/tags/priority exactos
      capturando el `httpx.AsyncClient.post` mockeado — este test NO necesita
      mutación (es un mapeo de datos estático, no lógica de decisión), pero sí
      debe cubrir los 4 casos de la tabla, no solo uno.
- [x] 3.8 Si el testcontainer de Redis (o Postgres, según lo que aplique) está
      disponible en este entorno (ver memoria del proyecto: "tests de
      integración usan testcontainer", verificar Docker arriba antes de
      correr), escribir un test de integración
      `tests/integration/test_watchdog_state_store_redis_real.py` con
      `WatchdogStateStore` contra un Redis real: escribir estado `down`, leerlo
      de vuelta, simular una caída sostenida de 3 ciclos verificando que el
      `since` no cambia (cubre el escenario de spec "Caída simulada
      prolongada verificable en Redis"). Si Docker no está disponible en este
      entorno, dejar el test escrito pero marcado con el skip que ya usa el
      resto de la suite de integración del proyecto, y decirlo explícito en
      el reporte de esta tarea.
      **[x] Hecho, PERO SIN VERIFICACIÓN VERDE — Docker caído en este
      entorno (misma causa raíz que la baseline de la Fase 0).** Se creó
      `tests/integration/test_watchdog_state_store_redis_real.py` con 3
      tests: roundtrip contra Redis real, ausencia de TTL en
      `watchdog:state:{componente}` (`ttl == -1`, a diferencia de
      `MetricsStore`), y una caída sostenida de 3+1 ciclos verificando UNA
      sola notificación y que el `since` no cambia entre ciclos (escenario
      de spec "Caída simulada prolongada verificable en Redis"). Se verificó
      que el resto de la suite de integración del proyecto (`test_metrics_store.py`,
      `test_redis_pubsub_bus.py`, etc.) NO usa un patrón de `pytest.mark.skip`
      explícito para Docker caído — todos dependen de la fixture
      `redis_container`/`redis_url` de `tests/integration/conftest.py`, que
      simplemente falla en el `setup` si Docker no responde (esto genera
      `error`, no `skipped` — el mismo comportamiento que ya documentan los
      330 `errors` de la baseline). Se siguió ese mismo patrón sin agregar
      un skip manual ad-hoc que rompería la consistencia del resto de la
      suite. Se intentó levantar Docker (el intento quedó corriendo en
      background varios minutos) y correr el test igual: falló con
      `docker.errors.DockerException: Error while fetching server API
      version: 503 Server Error for http+docker://localhost/version: Service
      Unavailable ("Docker Desktop is unable to start")` — confirma que
      Docker Desktop está caído de verdad en este entorno, no es un timeout
      transitorio. **Esta tarea NO se da por verificada en verde**: el test
      está escrito y estructuralmente correcto (mismo patrón exacto de
      `test_metrics_store.py`, usando las fixtures `redis_url`/`redis_client`
      ya existentes), pero requiere Docker arriba en una sesión futura para
      confirmar que pasa de verdad.

---

## Phase 4: Heartbeat de `events_ingestor.py`

**Estado desplegable al cerrar la fase**: `events_ingestor.py` escribe su
heartbeat en cada vuelta de su loop, de forma comprobadamente inofensiva para
la ingesta real de EMSC/USGS incluso si Redis está caído. Ningún otro
componente del watchdog depende de que esta fase esté terminada (el chequeo
`check_events` de la Fase 2 ya está probado con mocks), así que esta fase NO
bloquea a la Fase 5 si se prefiere paralelizar, pero SÍ requiere revisión
extra por tocar un proceso ya en producción.

- [x] 4.1 (RED) Escribir `tests/unit/test_events_ingestor_heartbeat.py`
      ANTES de tocar `events_ingestor.py`:
      - `test_heartbeat_loop_escribe_key_con_ttl`: mock de cliente Redis,
        verificar que se llama `set("events_ingestor:heartbeat", <iso8601>, ex=<ttl configurado>)`
        al menos una vez tras dejar correr el loop un ciclo corto (usar un
        intervalo de test pequeño inyectado, no el default de 60s — el loop
        debe aceptar el intervalo como parámetro para poder testear sin
        esperar minutos reales).
      - `test_heartbeat_independiente_de_eventos_procesados`: verificar que
        `_heartbeat_loop` escribe la key SIN que se haya llamado
        `handle_event` ni una sola vez en el período del test (cubre
        explícitamente el escenario de spec "Heartbeat expirado sin sismos
        nuevos en el período" — la independencia de si hubo sismos).
      - **`test_heartbeat_con_excepcion_en_redis_no_tumba_el_gather` (CRÍTICO,
        es el test que protege contra "el ingestor salía con exit 0")**: un
        stub de cliente Redis cuyo `set()` lanza una excepción en la primera
        llamada y responde normalmente en la segunda; correr
        `asyncio.gather(self.emsc.run(), self.usgs.run(), self._heartbeat_loop())`
        con `emsc.run()`/`usgs.run()` mockeados para correr indefinidamente
        (o durante el período del test) y verificar que NINGUNA de las tres
        corrutinas se cancela por la excepción del heartbeat — el `gather()`
        sigue vivo tras el fallo, y en la segunda vuelta el `set()` se
        reintenta y tiene éxito.
      - `test_heartbeat_solo_repropaga_cancelled_error`: simular
        `asyncio.CancelledError` dentro del loop del heartbeat y verificar que
        SÍ se re-propaga (comportamiento distinto de cualquier otra
        excepción) — cubre que el shutdown del proceso sigue funcionando.
- [x] 4.2 (GREEN) Implementar `EventsIngestor._heartbeat_loop(self) -> None`
      en `src/services/events_ingestor.py`, inyectando el cliente Redis por
      constructor (agregar parámetro `redis_client` a `EventsIngestor.__init__`,
      mismo criterio que `metrics_store` en `seedlink_ingestor.py` — se pasa
      ya conectado desde el `__main__`). Estructura exacta según el design.md
      (Interfaces / Contracts): `while True`, cada
      `settings.watchdog_events_heartbeat_interval_seconds` escribe
      `events_ingestor:heartbeat` = `datetime.now(timezone.utc).isoformat()`
      con `ex=settings.watchdog_events_heartbeat_ttl_seconds`; el
      `try/except` envuelve ÚNICAMENTE la escritura individual (nunca el
      `while` completo), solo `asyncio.CancelledError` se re-propaga, todo lo
      demás se loguea con `logger.warning(..., exc_info=True)` y el loop
      sigue a la siguiente vuelta sin `raise`.
      *Criterio de aceptación*: los 4 tests de 4.1 pasan.
- [x] 4.3 Modificar `EventsIngestor.run()` (línea 111) para sumar
      `self._heartbeat_loop()` al `asyncio.gather()` existente:
      `asyncio.gather(self.emsc.run(), self.usgs.run(), self._heartbeat_loop())`.
      **NO envolver esta línea en ningún try/except adicional** — el
      `try/except BaseException` que ya rodea el `gather()` en `run()`
      (líneas 110-119) sigue siendo el único punto de captura para un fallo
      REAL de las tres corrutinas juntas; la protección del heartbeat vive
      DENTRO de `_heartbeat_loop`, no acá.
- [x] 4.4 **Mutación crítica sobre `_heartbeat_loop`**: sacar el `try/except`
      interno (dejar que la excepción del `set()` de Redis propague fuera del
      loop), confirmar con `rg -n "try:" src/services/events_ingestor.py` (o
      un patrón más específico) que el archivo cambió, correr
      `./venv/bin/python -m pytest tests/unit/test_events_ingestor_heartbeat.py -q`
      y confirmar que
      `test_heartbeat_con_excepcion_en_redis_no_tumba_el_gather` se pone rojo
      —**este es el test más importante de todo el change**: si con el
      `try/except` sacado el test sigue verde, el test no está probando lo
      que dice probar y hay que corregirlo antes de continuar. Registrar en
      `mutation-log.md` con la marca "CRÍTICO — protege contra el incidente
      del ingestor con exit 0". Revertir y confirmar verde.
- [x] 4.5 Actualizar el `__main__` de `events_ingestor.py` (línea ~149) para
      conectar el cliente Redis (`redis.asyncio.from_url(settings.redis_url, decode_responses=True)`,
      o reutilizar `RedisPubSubBus` si ya expone un cliente crudo utilizable —
      verificar en `src/services/event_bus.py` antes de crear una conexión
      Redis duplicada) y pasarlo al constructor de `EventsIngestor` antes de
      `ingestor.run()`. Actualizar también el `finally` (línea ~181) para
      cerrar esa conexión Redis igual que se cierra `store`/`bus`.
- [x] 4.6 Correr la suite completa de `tests/unit/test_events_ingestor*.py`
      (los tests existentes de `EventsIngestor` más los nuevos de heartbeat) y
      confirmar que ningún test previo se rompió por el cambio de firma del
      constructor (si `EventsIngestor.__init__` gana un parámetro nuevo
      obligatorio, actualizar todos los call sites de test existentes — no
      dejar un parámetro con default silencioso que enmascare un cliente
      Redis nunca inyectado en producción, salvo que el design ya lo permita
      explícitamente; si se opta por default `None` con un check de "si no
      hay cliente, el heartbeat se salta con un log", dejarlo dicho en el
      docstring y agregar un test específico de ese camino).

---

## Phase 5: Loop principal y proceso standalone

**Estado desplegable al cerrar la fase**: `src/services/watchdog.py` es un
proceso ejecutable de punta a punta (`python -m src.services.watchdog`), con
los 4 chequeos, el store de estado y las notificaciones ya integrados en un
ciclo real con `stop_event`.

- [x] 5.1 (RED) Escribir `tests/unit/test_watchdog_loop.py::test_run_watchdog_loop_corre_los_4_chequeos_y_para_con_stop_event`
      ANTES de implementar `run_watchdog_loop`: con los 4 `check_*` mockeados
      (o stubs simples que devuelven `CheckResult` fijo), un `stop_event` que
      se setea tras la primera vuelta (usando `asyncio.Event` + una tarea que
      lo setea después de `await asyncio.sleep(0)` o un `interval_seconds`
      muy chico), verificar que se llamaron los 4 chequeos exactamente una
      vez y que la corrutina retorna (no queda colgada) tras el `stop_event.set()`.
      **[x] Hecho.** Test escrito con los 4 `check_*` y `evaluate_and_notify`
      monkeypatcheados a nivel de módulo (stubs simples, sin `unittest.mock`);
      el propio stub de `evaluate_and_notify` para el componente `events`
      (último de los 4 en el orden del loop) dispara `stop_event.set()` al
      cierre de ese mismo ciclo, y todo corre envuelto en
      `asyncio.wait_for(..., timeout=5.0)` para blindar contra un colgado
      real del test. Confirmado RED antes de implementar: `ImportError`/
      `AttributeError` por `run_watchdog_loop` inexistente.
- [x] 5.2 (GREEN) Implementar
      ```python
      async def run_watchdog_loop(
          client: httpx.AsyncClient,
          pool: asyncpg.Pool,
          redis_client,
          store: WatchdogStateStore,
          settings_snapshot,  # o pasar los valores individuales — decidir según legibilidad
          stop_event: asyncio.Event,
      ) -> None:
      ```
      en `watchdog.py`, calcando el patrón `while not stop_event.is_set(): ... await asyncio.wait_for(stop_event.wait(), timeout=interval_seconds)`
      de `disk_alert.py:75-94` (el `stop_event` esperado, NO un `sleep`
      pelado). Cada uno de los 4 chequeos + su `evaluate_and_notify` va en su
      propio `try/except Exception` individual dentro del ciclo (mismo
      criterio que `disk_alert.py:85-90`): si `check_seedlink` revienta con
      una excepción no anticipada, los otros 3 chequeos del mismo ciclo deben
      ejecutarse igual (cubre el escenario de spec "Aislamiento de fallos
      entre chequeos").
      *Criterio de aceptación*: el test de 5.1 pasa.
      **[x] Hecho.** `run_watchdog_loop` implementado con la firma exacta del
      contrato de design.md. `settings_snapshot` se pasa como `dict` (más
      legible en los tests que un objeto de Settings completo, y desacopla el
      loop de la clase `Settings` concreta — el `__main__` arma el dict a
      partir de `settings.*`). El chequeo de `ui` tiene una rama extra: si
      `settings_snapshot["ui_url"]` es `None` (WATCHDOG_UI_URL sin
      configurar), se loguea `logger.info` y se salta ese chequeo SIN tocar
      `check_ui` ni `evaluate_and_notify` para `ui` en ese ciclo — mismo
      criterio que design.md "Nombres de settings nuevos" (no bloquea a los
      otros tres). Verde: los 2 tests de 5.1 pasan.
- [x] 5.3 (RED+GREEN) Escribir y hacer pasar
      `test_run_watchdog_loop_excepcion_en_un_chequeo_no_aborta_el_ciclo`: uno
      de los 4 `check_*` mockeado para lanzar una excepción no controlada, los
      otros 3 mockeados normalmente; verificar que los otros 3 SÍ llegan a
      `evaluate_and_notify` (o su equivalente observable) en ese mismo ciclo,
      y que el loop no muere (sigue vivo para el próximo `stop_event.wait()`).
      **[x] Hecho.** `check_seedlink` mockeado para lanzar `ConnectionError`
      (una excepción NO anticipada, distinta del `CheckResult(up=False,...)`
      que la función real ya sabe devolver sola ante un fallo esperado); los
      otros 3 mockeados normales. Verificado que `api`, `ui` y `events` SÍ
      llegan a `evaluate_and_notify` en el mismo ciclo (`seedlink` no, porque
      su propio `try/except` capturó la excepción antes de producir un
      `CheckResult`), y que el loop completa el ciclo y retorna al setear
      `stop_event` — no queda colgado. Verde de entrada (implementado junto
      con 5.2, no hubo un RED separado adicional más allá del de 5.1: la
      implementación de 5.2 ya incluía los 4 `try/except` individuales desde
      el principio). **Además, se hizo la mutación de aislamiento extra
      pedida explícitamente** (quitar el `try/except` del bloque de
      `check_seedlink` en `run_watchdog_loop`, confirmado con `rg`): el test
      se puso ROJO como se esperaba (la excepción propagó y abortó la
      corrutina completa en vez de quedar aislada), confirmando que el test
      SÍ distingue "aislado" de "no aislado" — no es un punto de prueba donde
      ambos comportamientos coinciden. Revertido y confirmado verde de
      nuevo. Registrado como mutación #8 en `mutation-log.md`.
- [x] 5.4 Implementar el bloque `if __name__ == "__main__":` en `watchdog.py`,
      calcado del patrón de `events_ingestor.py:126-200`: `logging.basicConfig`,
      chequeo de `settings.watchdog_enabled` al inicio — si es `False`, loguear
      un mensaje informativo y salir con código 0 SIN levantar ninguna
      excepción (es un servicio opt-in, apagarlo vía env var debe ser un
      no-op limpio, no un error); si está habilitado, conectar
      `httpx.AsyncClient`, el pool de `asyncpg` (solo lectura — no requiere
      permisos de escritura nuevos, mismo DSN que `TimescaleColumnWriter`) y
      el cliente `redis.asyncio`; instanciar `WatchdogStateStore`; armar
      `expected_channels` desde `DEFAULT_CHANNELS` /
      `channels_from_catalog(LIVE_CANDIDATES_BY_CITY)` (reutilizar tal cual
      de `seedlink_ingestor.py:432-461`, sin duplicar la lista); registrar un
      manejador de señal (`SIGTERM`/`SIGINT`) que setee el `stop_event`, mismo
      patrón que ya usan `seedlink_ingestor.py`/`events_ingestor.py` para
      cerrar limpio en Railway; llamar `asyncio.run(_main())`.
      **[x] Hecho, con una desviación deliberada del patrón calcado.** A
      diferencia de `events_ingestor.py`/`seedlink_ingestor.py` (que definen
      `_main()` como corrutina ANIDADA dentro del `if __name__ ==
      "__main__":`), acá `_main()` se definió a NIVEL DE MÓDULO, fuera del
      bloque `if __name__`. Motivo: así queda IMPORTABLE Y TESTEABLE
      directamente desde `tests/unit/test_watchdog_loop.py`
      (`from src.services.watchdog import _main` +
      `await watchdog_module._main()`), lo que permite escribir el test 5.5
      como una llamada real a la función en vez de tener que ejecutar el
      módulo completo como script vía `runpy`/subproceso (no hay precedente
      de eso en el proyecto). El comportamiento es idéntico al patrón
      original — mismo orden de chequeos, misma conexión, mismo cierre en
      `finally` — solo cambia el nivel de indentación de la definición; el
      bloque `if __name__ == "__main__":` que queda solo hace
      `logging.basicConfig(...)` + `asyncio.run(_main())`. `expected_channels`
      se arma con `[f"{net}.{sta}.{cha}" for net, sta, cha in
      DEFAULT_CHANNELS]`, mismo formato de string que
      `seedlink_ingestor.py:387` escribe en `spectrogram_columns.channel`
      (`DEFAULT_CHANNELS` es `list[tuple[str,str,str]]`, no `list[str]`
      directo — se verificó el formato real ANTES de asumirlo). Manejo de
      señales con `loop.add_signal_handler(sig, stop_event.set)` para
      `SIGTERM`/`SIGINT`, mismo patrón de cierre limpio en Railway.
- [x] 5.5 (RED+GREEN) Test de arranque
      `test_main_no_arranca_el_loop_si_watchdog_enabled_es_false`: con
      `settings.watchdog_enabled = False` (monkeypatch), verificar que
      `run_watchdog_loop` NUNCA se llama y el proceso no intenta conectar a
      Postgres/Redis/httpx (evita tráfico saliente innecesario en un
      despliegue con el flag apagado).
      **[x] Hecho.** Test llama a `watchdog_module._main()` directamente
      (posible gracias a la desviación documentada en 5.4). Con
      `settings.watchdog_enabled = False`, se monkeypatchea
      `asyncpg.create_pool`, `aioredis.from_url` y `httpx.AsyncClient` para
      que cada uno haga `raise AssertionError(...)` si se llegan a invocar —
      no un simple mock que registra la llamada, sino uno que hace fallar el
      test inmediatamente si `_main()` los toca — y se confirma que
      `run_watchdog_loop` (también mockeado) nunca corrió. Verde. También
      verificado manualmente como proceso real (ver 5.6): `WATCHDOG_ENABLED=false
      ./venv/bin/python -m src.services.watchdog` logueó el mensaje
      informativo y salió con `EXIT: 0`, sin tocar red ni DB.
- [ ] 5.6 Verificar manualmente (no automatizable con pytest puro, pero sí
      ejecutable localmente) que `python -m src.services.watchdog` arranca
      sin excepciones con `WATCHDOG_ENABLED=true` y las demás env vars
      apuntando a un entorno local/de prueba (Postgres y Redis del
      `docker-compose` local ya existente), corre al menos un ciclo completo,
      y termina limpio con `Ctrl+C` (SIGINT). Documentar en el PR o en el
      reporte de esta tarea el resultado exacto (logs relevantes), no solo
      "funcionó".
      **PARCIAL — NO VERIFICADO EN VERDE, misma causa raíz que la Fase 0/3.8
      (Docker caído).** Se verificó lo que SÍ es verificable sin Docker: con
      `WATCHDOG_ENABLED=false`, `./venv/bin/python -m src.services.watchdog`
      corrió como proceso real (no como test) y terminó con `EXIT: 0` tras
      loguear `"watchdog: WATCHDOG_ENABLED=false — el proceso no arranca el
      loop (no-op limpio, ver proposal.md 'Rollback Plan')"` — confirma que
      el camino opt-in funciona de punta a punta como script, no solo en el
      test unitario de 5.5. El camino `WATCHDOG_ENABLED=true` contra
      Postgres/Redis del `docker-compose` local NO se pudo ejecutar: se
      intentó `docker info` dos veces (una en background, otra con matado
      manual del proceso a los 15s) y en ambas Docker Desktop no respondió
      (ni 200 ni error, quedó colgado) — mismo síntoma exacto ya documentado
      en `mutation-log.md` (Fase 0: `docker.errors.DockerException: 503
      Server Error ... Docker Desktop is unable to start`) y en la tarea 3.8
      de este mismo tasks.md. Esta tarea NO se da por completada de verdad:
      falta, en una sesión futura con Docker arriba, levantar el
      `docker-compose` local, correr
      `WATCHDOG_ENABLED=true WATCHDOG_NTFY_TOPIC_URL=... WATCHDOG_UI_URL=...
      python -m src.services.watchdog` contra esos contenedores, confirmar
      que completa al menos un ciclo real (los 4 chequeos contra
      Postgres/Redis reales, no mocks) y que `Ctrl+C` (SIGINT) lo cierra
      limpio vía el `stop_event`.

---

## Phase 6: Dockerfile del servicio nuevo

**Estado desplegable al cerrar la fase**: existe una imagen Docker
construible para el servicio `watchdog`, lista para configurarse en Railway.

- [x] 6.1 Crear `deploy/docker/Dockerfile.watchdog` como calco EXACTO de
      `deploy/docker/Dockerfile.seedlink` (mismas dos stages `base`/`dependencies`/`production`,
      mismo `requirements.txt`, mismo `.env.example`), con dos diferencias
      deliberadas: (a) el comentario de cabecera debe explicar que este es el
      Dockerfile del watchdog, no del seedlink, y qué hace ese proceso en una
      frase; (b) `CMD ["python", "-m", "src.services.watchdog"]` en vez de
      `src.services.seedlink_ingestor`.
      Antes de decidir si el `COPY --chown=appuser:appuser dashboard/lib/seismic-constants.json ...`
      es necesario, verificar con
      `rg -n "seismic-constants|signal_picks" src/services/watchdog.py src/services/timescale_service.py`
      si `watchdog.py` importa (aunque sea transitivamente, vía
      `timescale_service.py` u otro módulo) algo que cargue ese JSON al
      importar. Si NINGÚN import transitivo lo requiere, omitir esa línea del
      Dockerfile y dejarlo dicho en un comentario (`# No se necesita
      seismic-constants.json: watchdog.py no importa signal_picks ni nada que
      lo cargue — verificado con rg el <fecha>`). Si hay CUALQUIER duda,
      mantener el `COPY` (cuesta una línea y evita repetir el
      `FileNotFoundError` del 2026-08-26, ya documentado en la memoria del
      proyecto).
      Resultado del rg: sin matches en `watchdog.py` ni `timescale_service.py`.
      Se verificó además la cadena transitiva completa de imports de
      `watchdog.py` (vía `seedlink_ingestor.py`: `channel_watchdog`,
      `metrics_store`, `swarm_rsam`, `swarm_spectra`, `ephemeral_channels`,
      `event_bus`, `spectrogram_service`, `timescale_service`) — ninguno
      referencia `seismic-constants` ni `signal_picks`. El único módulo que
      carga ese JSON es `src/services/signal_picks.py`, importado solo por
      `src/main.py`, `src/api/routers/picks.py` y `src/models/signal_pick.py`
      (fuera de la cadena de `watchdog.py`). Se omitió el `COPY` con
      comentario explicativo en el Dockerfile, fecha 2026-08-30.
- [x] 6.2 Verificar que el build funciona localmente:
      `docker build -f deploy/docker/Dockerfile.watchdog -t geospectrum-watchdog:test .`
      desde la raíz del repo, sin necesitar levantar el contenedor (no hace
      falta `docker run` — solo confirmar que el build termina sin errores).
      Si Docker no está disponible en este entorno de ejecución, dejarlo
      explícito en el reporte de la tarea en vez de asumir que "debería
      funcionar porque es igual a Dockerfile.seedlink" — verificar de verdad,
      no por analogía (memoria del proyecto: "correr el proceso de verdad
      antes del PR").
      Resultado real (2026-08-30): se intentó `docker info` (colgado sin
      respuesta) y luego el build real
      (`docker build -f deploy/docker/Dockerfile.watchdog -t geospectrum-watchdog:test .`),
      que devolvió `ERROR: Error response from daemon: Docker Desktop is
      unable to start`. Docker está CAÍDO en este entorno de ejecución —
      NO VERIFICADO por esta razón concreta, no por analogía con
      `Dockerfile.seedlink`. Falta correr este build en un entorno con Docker
      Desktop funcionando antes de dar la Fase 6 por cerrada de verdad.

---

## Phase 7: Verificación final

- [x] 7.1 Correr la suite completa del backend:
      `./venv/bin/python -m pytest tests/ -q` y comparar el conteo total
      contra la baseline registrada en la tarea 0.1 — el delta debe ser
      exactamente los tests nuevos agregados en las Fases 1-5 (contarlos:
      settings + 4 chequeos + state store + evaluate_and_notify + notify_ntfy
      + heartbeat de events_ingestor + loop principal + arranque), sin
      ninguna regresión en los tests preexistentes.
      **[x] Hecho.** Resultado real: `9 failed, 701 passed, 2 skipped, 8
      warnings, 333 errors in 56.99s` contra la baseline de 0.1
      (`9 failed, 658 passed, 2 skipped, 8 warnings, 330 errors`).
      **Delta de `passed`: +43, exactamente los tests nuevos** (contados por
      archivo con `--collect-only`): 1 (`test_settings.py`) + 14
      (`test_watchdog_checks.py`) + 4 (`test_watchdog_state_store.py`) + 16
      (`test_watchdog_evaluate_and_notify.py`, incluye los 4 casos
      parametrizados de `_notify_ntfy` de la tarea 3.7) + 5
      (`test_events_ingestor_heartbeat.py`, archivo enteramente nuevo — los
      10 tests preexistentes de `test_events_ingestor.py` se re-verificaron
      sin cambio de conteo, confirmando que el parámetro `redis_client` con
      default no rompió ningún call site existente) + 3
      (`test_watchdog_loop.py`) = 43. **Delta de `errors`: +3**, explicado
      por completo por los 3 tests nuevos de
      `tests/integration/test_watchdog_state_store_redis_real.py` (tarea
      3.8), que fallan en el `setup` del fixture con el mismo
      `docker.errors.DockerException: 503 ... Docker Desktop is unable to
      start` que ya afecta a los 330 preexistentes — no son parte de una
      regresión, son el mismo problema de entorno de siempre. `failed` se
      mantuvo exactamente en 9, y se confirmó con `rg "^FAILED"` que los 9
      son todos en `tests/unit/test_ws_events.py` — ningún archivo tocado
      por este change (`watchdog.py`, `events_ingestor.py`, `settings.py`)
      aparece entre ellos. `skipped` se mantuvo en 2. **Sin ninguna
      regresión en tests preexistentes.**
- [x] 7.2 `tsc --noEmit` **NO aplica a este change** — es puro backend Python,
      no toca `dashboard/`. Dejarlo dicho explícitamente en el reporte final
      para que quede registrado que se consideró y se descartó por motivo
      concreto, no por omisión.
      **[x] Hecho.** Confirmado explícitamente: este change no agrega ni
      modifica ningún archivo bajo `dashboard/` (todo vive en
      `src/services/`, `src/config/`, `deploy/docker/`), por lo tanto no
      existe superficie TypeScript que verificar.
- [x] 7.3 Cerrar `openspec/changes/watchdog-servicios-railway/mutation-log.md`:
      confirmar que las mutaciones de las Fases 2, 3 y 4 (mínimo: check_api,
      check_ui, check_seedlink, check_events, WatchdogStateStore.get_state,
      evaluate_and_notify, y la crítica de `_heartbeat_loop`) están todas
      registradas con su salida de `rg`, el test que se puso rojo, y
      confirmación de que se revirtieron. Reemplazar el bloque HTML comentado
      de "mutaciones pendientes" del final del archivo por una nota de cierre
      (fecha + conteo total de mutaciones verificadas).
      **[x] Hecho.** Confirmadas las 8 filas de la tabla "Registro" (incluye
      la mutación #8, de aislamiento en `run_watchdog_loop`, que no tenía
      número explícito en tasks.md pero está registrada igual). Reemplazado
      el bloque HTML comentado del final por una nota de cierre fechada
      2026-08-30 con el conteo total: 8 mutaciones verificadas.
- [x] 7.4 Revisar los `Risks` del proposal.md uno por uno y confirmar (con
      referencia a la tarea concreta que lo cubrió) que cada uno tiene su
      mitigación implementada: falsos positivos por red transitoria (Fase 3,
      sin reintentos por diseño), Redis caído (Fase 3, tests 3.4/3.6), costo
      del servicio nuevo (Fase 6, no requiere tarea de código — dejarlo dicho
      como "aceptado, verificar consumo real post-deploy"), el heartbeat
      tumbando `events_ingestor` (Fase 4, mutación 4.4), y la confusión entre
      heartbeat y "último sismo" (Fase 2 tests de `check_events` + Fase 4
      test de independencia).
      **[x] Hecho.** Ver la tabla completa en el reporte final de esta tarea
      (mensaje de cierre de sesión) — los 5 riesgos del proposal.md tienen
      cobertura concreta verificada, ninguno quedó sin mitigación
      implementada.
- [x] 7.5 **Checklist de QA manual post-deploy (NO automatizable — requiere
      al usuario provocando caídas reales en Railway/Vercel y confirmando la
      notificación en su celular)**. Escribir esta checklist en el reporte
      final de esta tarea (o en un comentario del PR), para que el usuario la
      ejecute después del deploy, replicando los `Success Criteria` del
      proposal.md:
      - [ ] Apagar (o degradar) el servicio `api` en Railway → confirmar que
            llega la notificación de caída al topic ntfy dentro de ≤5 minutos,
            y que al reactivarlo llega la de recuperación con la duración.
      - [ ] Apagar la UI en Vercel (o simular con una URL rota temporalmente)
            → confirmar notificación de caída de `ui` SIN que se notifique
            `api` como afectado, y su recuperación.
      - [ ] Detener `seedlink_ingestor` (o cortar su acceso a la fuente
            SeedLink) el tiempo suficiente para superar los 600s configurados
            → confirmar notificación de `seedlink` caído, y que NO se disparó
            antes de esos 600s por una reconexión normal.
      - [ ] Detener (o bloquear su acceso a Redis) `events_ingestor` → esperar
            a que expire el heartbeat (>180s) → confirmar notificación de
            `events` caído, incluso si en ese lapso no hubo sismos nuevos de
            EMSC/USGS.
      - [ ] Durante una caída sostenida de cualquier componente por al menos
            3 ciclos (~15 min), confirmar que llegó UNA sola notificación de
            caída, no una por ciclo.
      - [ ] Confirmar que el usuario está efectivamente suscripto desde el
            celular al topic `https://ntfy.sh/geospectrum-watchdog-02d73c9b7f34`
            antes de dar el change por verificado en producción (dependencia
            ya señalada en el proposal).
</content>
