# Tasks: Mega Wall de Estaciones del Cuaderno

> **Orden estricto de fases**: 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8.
> La Fase 1 (investigación) bloquea a TODAS las demás — no se puede armar
> ningún catálogo de código sobre estaciones sin verificar. La Fase 2
> (catálogo + GEOFON como proceso) y la Fase 3 (watchdog) pueden avanzar en
> paralelo entre sí una vez cerrada la Fase 1, pero la Fase 4 (smoke test)
> necesita 2 y 3 completas — el watchdog debe conocer el catálogo GEOFON
> ANTES de desplegar el proceso GEOFON, o reporta falsos "mudos" desde el
> primer minuto. La Fase 5 (walls temáticos) necesita el catálogo completo de
> la Fase 6 (rollout completo), no solo el subconjunto de humo. La Fase 7
> cierra contra los Success Criteria exactos del proposal. La Fase 8 es
> limpieza/documentación.
>
> **Convenciones no negociables de este change:**
> - Identificadores en INGLÉS, comentarios y docstrings en ESPAÑOL.
> - Backend: `./venv/bin/python -m pytest` (el venv está en `venv/`, NO en `.venv/`).
> - **Nunca correr `next build`** (no aplica a este change — es puro backend
>   Python y un script de datos one-off, pero queda dicho para no romper el
>   server de dev de otra sesión concurrente).
> - **Nivel de rigor por tipo de código, no uniforme**: `watchdog.py` (Fase 3)
>   toca un proceso YA en producción que monitorea 74 canales activos — recibe
>   el MISMO rigor TDD + mutación crítica que ya demostró
>   `openspec/changes/watchdog-servicios-railway/tasks.md` (RED antes que
>   GREEN, mutación que invierte la condición y confirma rojo antes de dar el
>   test por bueno, registro en `mutation-log.md`). `scripts/seed_thematic_walls.py`
>   (Fase 5) es un script de datos de uso único — NO corre en ningún
>   Dockerfile, no es parte del código de arranque de ningún proceso — recibe
>   tests de forma/contrato (respeta `MAX_WALL_CHANNELS`/`MAX_WALL_COLUMNS`)
>   pero NO mutación crítica: no hay lógica de decisión de producción que
>   proteger, es composición de datos que se ejecuta una vez y se descarta.
> - Cada chequeo/loop que toque `watchdog.py` va envuelto en su propio
>   `try/except` — un fallo aislado no debe tumbar el ciclo completo ni el
>   proceso (mismo criterio ya aplicado en el change anterior).
> - Ninguna estación se suma al catálogo de código sin haber sido verificada
>   con datos vivos reales (protocolo `INFO STREAMS`) — la spec
>   `live-station-catalog` lo exige con MUST, no es opcional ni se puede
>   aproximar con una estación "parecida".
> - Cada tarea que registre un resultado de verificación (Docker caído, un
>   país sin servidor, un smoke test observado) debe documentar el resultado
>   REAL obtenido, nunca "debería funcionar" — mismo estándar que dejó
>   `watchdog-servicios-railway/tasks.md` en sus tareas 3.8/5.6/6.2.

---

## Phase 0: Preparación transversal

**Estado desplegable al cerrar la fase**: baseline de tests registrada, para
poder medir después que el delta de la Fase 3 (watchdog) y el resto del
change no introdujo regresiones.

- [x] 0.1 Correr `./venv/bin/python -m pytest tests/ -q` en la raíz del
      proyecto ANTES de tocar cualquier archivo y registrar el conteo exacto
      (`passed`/`failed`/`skipped`/`errors`) en un archivo
      `openspec/changes/mega-wall-estaciones-cuaderno/mutation-log.md` nuevo,
      sección "Baseline registrada" — mismo formato que usó
      `watchdog-servicios-railway/mutation-log.md`. Sin la baseline no se
      puede afirmar después que la suite quedó verde sin regresiones.
- [x] 0.2 Crear `openspec/changes/mega-wall-estaciones-cuaderno/mutation-log.md`
      con las columnas `#`, `archivo`, `mutación`, `salida del rg`, `test que
      se puso rojo`, `revertido (sí/no)` — mismo esquema que el change
      anterior. Solo aplica a las mutaciones de `watchdog.py` (Fase 3); el
      resto del change (catálogo, script one-off) no requiere mutación por la
      convención fijada arriba.

---

## Phase 1: Verificación del catálogo pendiente (bloqueante, sin código todavía)

**Estado desplegable al cerrar la fase**: ningún archivo de producción
tocado todavía — esta fase es 100% investigación contra los dos servidores
SeedLink reales (`rtserve.earthscope.org`, `geofon.gfz-potsdam.de`), usando
el protocolo `INFO STREAMS` crudo por socket ya usado para las 12/19
entradas "(cualquiera)" confirmadas en
`docs/superpowers/plans/2026-08-31-mega-wall-catalogo-cuaderno.md`. El
resultado de esta fase (una tabla país→estación→servidor→verificado)
alimenta directamente el catálogo de código de la Fase 2 — sin esta fase
cerrada, la Fase 2 no tiene qué escribir.

- [ ] 1.1 Verificar contra `rtserve.earthscope.org` (`INFO STREAMS`) las
      entradas de **Sudamérica con zona/ciudad específica** del cuaderno que
      todavía NO están en `LIVE_CANDIDATES_BY_CITY`: Argentina (Salta, San
      Juan, Mendoza, Ushuaia), Chile (Zona N/Antofagasta ya cubierta
      parcialmente — verificar Zona M/Valparaíso-Santiago ya cubierta,
      confirmar Zona S/Bio Bio-Los Lagos nueva), Perú (Lima ya cubierta,
      verificar 1-2 estaciones adicionales "buenas" sin ciudad específica),
      Puerto Rico (Zona N, Zona S), México (Zona N/Golfo California, México
      DF ya cubierta, Zonas Oaxaca/Chiapas). Para cada una: código
      red.estación propuesto, canal vertical (`BHZ`/`HHZ`/`EHZ`), `end_time`
      reciente confirmado. Registrar resultado (confirmado con SEED ID exacto,
      o "sin datos vivos verificables — pendiente fuera de scope") en una
      tabla nueva dentro de
      `docs/superpowers/plans/2026-08-31-mega-wall-catalogo-cuaderno.md`, bajo
      un encabezado `## Verificación completa (Fase 1 de mega-wall-estaciones-cuaderno)`.
      *Criterio de aceptación*: cada estación de esta lista tiene una fila con
      veredicto explícito, sin ninguna fila "pendiente" sin investigar.
- [ ] 1.2 Verificar contra `rtserve.earthscope.org` **USA por región** que
      todavía NO están en el catálogo: California (Capetown, Mount Shasta,
      Long Valley, Salton — Los Angeles/San Diego/San Francisco/Portland ya
      cubiertas), Washington (Mount Rainier, Volcán St. Helens, Volcán 3
      Sisters — "las 3 estaciones principales", Seattle ya cubierta), Alaska
      (volcanes: Redoubt, Shishaldin, Okmok, Gareloi — Anchorage ya cubierta),
      Hawaii (Mauna Loa, Kilauea), y las **4 estaciones principales de
      Yellowstone** (Old Faithful + 2-3 más — buscar red `WY`/`IW` u otra
      conocida de YVO). Oregon y Texas quedan "(sin especificar)" en el
      cuaderno: buscar 1 estación con datos vivos cada una si existe una
      candidata obvia (mismo criterio "(cualquiera)"), sin forzar una si no
      aparece con facilidad. Registrar resultado en la misma tabla de 1.1,
      incluyendo explícitamente el listado completo de las 46 estaciones de
      Yellowstone SOLO como referencia documentada (no verificadas una por
      una, no cargadas — ver Out of Scope del proposal).
- [ ] 1.3 Verificar contra `rtserve.earthscope.org` **Canadá** (Mount Bella,
      Columbia Británica — nota "BELLA BC" tachada bajo Washington, la entrada
      válida es esta) y **Asia** con zona específica: Japón (Zona N, Tokio ya
      cubierta, Zonas S — nuevas además de las ya presentes), Rusia
      (Kamchatka — red `KK`/`IU` u otra conocida), India (1 sola estación),
      Nepal (Everest, si existe una viva), China ("no oficial, tiene el
      USGS" — verificar si hay alguna vía redes internacionales tipo `IC`).
      Registrar en la misma tabla.
- [ ] 1.4 Verificar contra `rtserve.earthscope.org` **Australia** (N y S) y
      re-confirmar que las 12/19 entradas "(cualquiera)" ya listadas como
      confirmadas en el documento (España `WM.CART`, Francia `G.SSB`, Grecia
      `HL.ITM`, Islandia `II.BORG`, Ecuador `OV.VPCC`, Colombia `CM.RUS`,
      Nicaragua `NU.MASN`, Costa Rica `TC.TCS1`, Filipinas `PS.PATS`,
      Indonesia/Sumatra `GE.SUMG`, Nueva Zelanda `NZ.BFZ`, Samoa `IU.AFI`,
      Pakistán `II.NIL`) siguen respondiendo con datos recientes al momento de
      esta verificación (re-chequeo rápido, no la investigación completa de
      nuevo — la fecha de la verificación original fue 2026-08-31, mismo día
      de esta fase salvo que haya pasado más tiempo entre sesiones).
- [ ] 1.5 Verificar contra `geofon.gfz-potsdam.de` (`INFO STREAMS`) las
      entradas que `rtserve.earthscope.org` NO sirve, más allá de la ya
      confirmada `MN.TRI` (Trieste, Italia continental): revisar
      específicamente Venezuela y Guatemala en el catálogo GEOFON (quedaron
      "no revisado en GEOFON todavía" en la investigación previa), Italia —
      Sicilia/Etna (ya se confirmó que ninguna estación `MN`/`IV` en GEOFON
      está en Sicilia, dejar la confirmación explícita de que se re-verificó
      y sigue sin resultado), Java específico dentro de la red `GE` de GEOFON
      (68 estaciones de Indonesia — identificar si alguna es específicamente
      de la isla de Java, no solo "Indonesia en general"). Registrar
      resultado en la tabla.
- [ ] 1.6 Cerrar la Fase 1 documentando explícitamente en
      `docs/superpowers/plans/2026-08-31-mega-wall-catalogo-cuaderno.md` los
      **5 países que quedan sin servidor SeedLink público conocido** tras
      TODA la verificación (UAE, Afganistán, Java específico si 1.5 no
      encontró nada, Venezuela, Guatemala si 1.5 no encontró nada) — esta
      lista es la que va a citar el proposal en su Success Criteria final, y
      no puede tener una estación "aproximada" puesta en su lugar (spec
      `live-station-catalog`, Requirement "Verificación de disponibilidad...",
      escenario "País sin servidor SeedLink público conocido queda
      documentado, no bloquea el resto").

---

## Phase 2: Catálogo de código + proceso GEOFON standalone

**Estado desplegable al cerrar la fase**: `LIVE_CANDIDATES_BY_CITY` incluye
SOLO el subconjunto de la prueba de humo (20-30 estaciones nuevas, ver Fase 4
para el resto), `LIVE_CANDIDATES_GEOFON_BY_CITY` existe con las 3 zonas GEOFON
confirmadas vivas y sus candidatas de respaldo,
`seedlink_ingestor_geofon.py` y su Dockerfile existen y son ejecutables
localmente — pero el catálogo COMPLETO del cuaderno todavía no está cargado
(eso es Fase 6). El proceso `rtserve.earthscope.org` (`seedlink_ingestor.py`)
NO se modifica como clase en ningún punto de esta fase.

- [x] 2.1 En `src/services/spectrogram_service.py`, agregar
      `LIVE_CANDIDATES_GEOFON_BY_CITY: Dict[str, List[str]]` inmediatamente
      después de `LIVE_CANDIDATES_BY_CITY` (mismo módulo, mismo patrón de
      comentario narrativo que ya documenta cómo se armó la constante
      existente — citar que el servidor NO es un atributo de la estación sino
      del proceso que la consume, según `design.md`, Decision "Catálogo de
      GEOFON en un dict separado"). Contenido exacto, con **candidatas de
      respaldo por canal** según `design.md`, Decision "Las candidatas de
      GEOFON son por CANAL, no por estación":
      ```python
      "trieste": ["MN.TRI..HHZ"],
      "kabul": ["GE.KBU..BHZ", "GE.KBU..SHZ"],
      "casablanca": ["WM.AVE..HHZ", "WM.AVE..BHZ"],
      ```
      El comentario debe dejar registrado que (a) Trieste queda con UNA sola
      candidata porque se midió que no hay segunda estación ni segundo canal
      vertical en la zona, y (b) `LHZ`/`LLZ` están vivos pero NO entran por ser
      de 1 Hz de muestreo (eje de frecuencia inservible para el espectrograma).
      El resto del catálogo GEOFON del cuaderno entra en la Fase 6.
      *Criterio de aceptación*: `rg -n "LIVE_CANDIDATES_GEOFON_BY_CITY"
      src/services/spectrogram_service.py` muestra la constante nueva, con
      forma `Dict[str, List[str]]` idéntica a la existente, y ninguna zona con
      candidatas de respaldo disponibles queda con una sola entrada.
- [x] 2.2 Test de forma: en `tests/unit/test_station_catalog.py`, agregar
      `test_live_candidates_geofon_by_city_tiene_la_misma_forma_que_rtserve`:
      cada valor es una lista no vacía de strings SEED con 4 componentes
      separados por punto (`net.sta.loc.cha`, `loc` puede ser vacío), mismo
      patrón de validación que ya existe (si existe) para
      `LIVE_CANDIDATES_BY_CITY`. Si no existe ningún test de forma previo
      para la constante original, escribir uno paramétrico simple que cubra
      ambas constantes.
- [x] 2.2b Test de la regla de muestreo: agregar
      `test_ningun_candidato_geofon_usa_canal_de_1hz` — ningún SEED ID de
      `LIVE_CANDIDATES_GEOFON_BY_CITY` termina en un canal cuya banda sea `L`
      (`LHZ`, `LLZ`, …). Es la regla que separa "canal vivo" de "canal útil"
      y la que evita que una futura carga de catálogo meta un respaldo de 1 Hz
      creyendo que suma redundancia. *Criterio de aceptación*: el test se pone
      ROJO si se agrega `"kabul": [..., "GE.KBU..LHZ"]` al catálogo.
- [x] 2.3 Crear `src/services/seedlink_ingestor_geofon.py`, calco línea por
      línea del `__main__` de `src/services/seedlink_ingestor.py:488-561`,
      con las diferencias exactas que fija `design.md` (Decision "Segundo
      proceso Railway..."):
      ```python
      from src.services.seedlink_ingestor import SeedLinkIngestor, channels_from_catalog
      from src.services.spectrogram_service import LIVE_CANDIDATES_GEOFON_BY_CITY

      DEFAULT_CHANNELS_GEOFON = channels_from_catalog(LIVE_CANDIDATES_GEOFON_BY_CITY)
      ```
      `SeedLinkIngestor(bus, server="geofon.gfz-potsdam.de", column_writer=...,
      metrics_store=...)` — **sin `ephemeral_redis`** (decisión explícita del
      design: la suscripción efímera es feature del catálogo principal, fuera
      de alcance acá). Logs con prefijo `seedlink_ingestor_geofon:` en vez de
      `seedlink_ingestor:`. `SeedLinkIngestor` y `channels_from_catalog` se
      IMPORTAN tal cual — no se modifica ni una línea de
      `seedlink_ingestor.py` en esta tarea.
      *Criterio de aceptación*: `rg -n "server=\"geofon.gfz-potsdam.de\""
      src/services/seedlink_ingestor_geofon.py` confirma el server explícito;
      `rg -n "ephemeral_redis" src/services/seedlink_ingestor_geofon.py` no
      devuelve matches.
- [x] 2.4 Test mínimo de construcción: en `tests/unit/test_seedlink_ingestor.py`
      (o crear `tests/unit/test_seedlink_ingestor_geofon.py`),
      `test_seedlink_ingestor_geofon_instancia_con_server_correcto`: construir
      un `SeedLinkIngestor` con `server="geofon.gfz-potsdam.de"` (mismo patrón
      de mocks/stubs que ya usan los tests existentes de `SeedLinkIngestor`
      para `bus`/`column_writer`/`metrics_store`) y verificar
      `ingestor.server == "geofon.gfz-potsdam.de"`. Si ya existe cobertura
      equivalente para `server` custom en los tests de `SeedLinkIngestor`,
      referenciarla en vez de duplicar.
- [x] 2.5 Test de no colisión: `tests/unit/test_seedlink_ingestor_geofon.py`,
      `test_default_channels_geofon_no_colisiona_con_default_channels_rtserve`:
      `set(DEFAULT_CHANNELS) & set(DEFAULT_CHANNELS_GEOFON)` es un set vacío
      (cubre el riesgo de colisión teórica de `channel` como PK de
      `spectrogram_columns` que señala el proposal). Con el catálogo actual
      (solo `MN.TRI`) el resultado trivialmente no colisiona; este test
      queda como regresión permanente para cuando el catálogo GEOFON crezca
      en la Fase 6.
- [x] 2.6 Crear `deploy/docker/Dockerfile.seedlink-geofon`, calco EXACTO de
      `deploy/docker/Dockerfile.seedlink` (mismas stages, mismo
      `requirements.txt`), con las dos diferencias deliberadas: (a) comentario
      de cabecera que explica que es el Dockerfile del proceso GEOFON, no de
      `rtserve`; (b) `CMD ["python", "-m", "src.services.seedlink_ingestor_geofon"]`.
      Antes de decidir si necesita el `COPY` de `dashboard/lib/seismic-constants.json`,
      verificar con `rg -n "seismic-constants|signal_picks"
      src/services/seedlink_ingestor_geofon.py src/services/seedlink_ingestor.py`
      si hace falta (mismo criterio que la tarea 6.1 del change del watchdog
      — si `seedlink_ingestor.py` ya lo tiene por herencia del Dockerfile
      calcado, mantenerlo sin reabrir la pregunta; si no, omitirlo con el
      mismo comentario explicativo fechado).
- [ ] 2.7 Verificar el build localmente:
      `docker build -f deploy/docker/Dockerfile.seedlink-geofon -t geospectrum-seedlink-geofon:test .`
      desde la raíz del repo. Si Docker no está disponible en el entorno de
      ejecución de esta sesión, dejarlo explícito en el reporte de la tarea
      (mismo estándar que dejaron las tareas 6.2/3.8/5.6 del change anterior
      — "no verificado por Docker caído", nunca "debería funcionar por
      analogía"). No requiere `docker run`, solo que el build termine sin
      errores.
      **BLOQUEADA (2026-08-31)**: Docker Desktop no arranca en esta máquina.
      Verificado, no supuesto: `docker info` cuelga, y un test de integración
      aislado devuelve `docker.errors.DockerException: Error while fetching
      server API version: 503 Server Error ... ("Docker Desktop is unable to
      start")`. Es la misma causa de los 333 errores de la suite, idénticos
      antes y después de este change. El Dockerfile está escrito (tarea 2.6)
      pero **su build NO fue verificado** — queda pendiente para cuando Docker
      levante, ANTES del deploy a Railway.
- [x] 2.8 Correr `./venv/bin/python -m pytest tests/unit/test_station_catalog.py tests/unit/test_seedlink_ingestor_geofon.py -q`
      (o los archivos que correspondan según dónde quedaron los tests de
      2.2/2.4/2.5) y confirmar verde antes de avanzar a la Fase 3.

---

## Phase 3: Watchdog — catálogo combinado (TDD + mutación crítica)

**Estado desplegable al cerrar la fase**: `watchdog.py` conoce
`DEFAULT_CHANNELS_GEOFON` y lo suma a `expected_channels` en `_main()`, sin
tocar la lógica de `check_seedlink()`. Esta fase toca código que corre HOY en
producción monitoreando 74 canales activos — mismo rigor TDD + mutación que
`watchdog-servicios-railway/tasks.md` Fase 2 (tarea 2.10, la mutación crítica
de "TODOS mudos" vs. "ALGÚN mudo").

- [x] 3.1 (RED) Escribir en `tests/unit/test_watchdog_loop.py` (o el archivo
      donde ya viven los tests de `_main()` del change anterior)
      `test_main_expected_channels_incluye_default_channels_geofon` ANTES de
      tocar `watchdog.py` — debe fallar porque `DEFAULT_CHANNELS_GEOFON`
      todavía no se importa ni se concatena. Mockear/monkeypatchear
      `asyncpg.create_pool`, `aioredis.from_url`, `httpx.AsyncClient` igual
      que ya hace `test_main_no_arranca_el_loop_si_watchdog_enabled_es_false`
      del change anterior (reutilizar ese patrón, no reinventarlo), interceptar
      la llamada a `run_watchdog_loop` para capturar el
      `settings_snapshot["expected_channels"]` con el que se lo invoca, y
      verificar que contiene TANTO canales de `DEFAULT_CHANNELS` (rtserve)
      COMO de `DEFAULT_CHANNELS_GEOFON` (regresión explícita: que no se
      pierda el catálogo original al sumar GEOFON — spec `observability`,
      escenario "Catálogo GEOFON ausente del catálogo esperado produce falsos
      mudos (regresión a evitar)", en su forma positiva).
- [x] 3.2 (GREEN) En `src/services/watchdog.py`, agregar el import
      `from src.services.seedlink_ingestor_geofon import DEFAULT_CHANNELS_GEOFON`
      y modificar la línea ~514 (dentro de `_main()`) exactamente como fija
      `design.md`:
      ```python
      expected_channels = [
          f"{net}.{sta}.{cha}"
          for net, sta, cha in DEFAULT_CHANNELS + DEFAULT_CHANNELS_GEOFON
      ]
      ```
      **No crear ninguna función `merged_expected_channels()` nueva** —
      concatenación de listas directa, mismo criterio que descartó el design
      por ser una abstracción de una sola línea sin comportamiento propio.
      `check_seedlink()` NO se toca — sigue recibiendo `list[str]` como
      siempre.
      *Criterio de aceptación*: el test de 3.1 pasa.
- [x] 3.3 **Mutación crítica**: revertir temporalmente la concatenación a
      `expected_channels = [f"{net}.{sta}.{cha}" for net, sta, cha in DEFAULT_CHANNELS]`
      (sin GEOFON), confirmar con `rg -n "DEFAULT_CHANNELS_GEOFON"
      src/services/watchdog.py` que el archivo efectivamente cambió (la línea
      del import puede quedar pero la concatenación no la usa), correr
      `./venv/bin/python -m pytest tests/unit/test_watchdog_loop.py -k expected_channels -q`,
      confirmar que `test_main_expected_channels_incluye_default_channels_geofon`
      se pone rojo, registrar en `mutation-log.md` de este change (creado en
      0.2), revertir y confirmar verde de nuevo.
- [x] 3.4 Test de regresión de aislamiento del chequeo existente: confirmar
      (sin necesidad de mutación nueva, referenciando los tests ya escritos
      en el change anterior) que `check_seedlink()` sigue pasando sus 4 tests
      originales (`tests/unit/test_watchdog_checks.py -k check_seedlink`) SIN
      modificación — si alguno falla tras el cambio de 3.2, es señal de que
      `_main()` filtró algo hacia `check_seedlink()` que no debía (la función
      solo debe recibir la lista ya combinada, sin lógica nueva dentro de
      ella).
- [x] 3.5 Correr `./venv/bin/python -m pytest tests/unit/test_watchdog_loop.py tests/unit/test_watchdog_checks.py -q`
      completo y confirmar verde antes de avanzar a la Fase 4.

---

## Phase 4: Prueba de humo (rollout Fase 1 del design — subconjunto acotado)

**Estado desplegable al cerrar la fase**: 20-30 estaciones nuevas del
catálogo verificado en la Fase 1 están cargadas en `LIVE_CANDIDATES_BY_CITY`/
`LIVE_CANDIDATES_GEOFON_BY_CITY` (mezcla deliberada de ambos servidores),
el servicio Railway `seedlink-geofon` existe y corre, `watchdog` fue
redesplegado con el catálogo combinado, y existe un wall de prueba con ese
subconjunto. Esta fase se OBSERVA en producción antes de decidir si avanzar
a la Fase 6 — es un punto de parada explícito, no un trámite.

- [ ] 4.1 Seleccionar el subconjunto de 20-30 estaciones para la prueba de
      humo a partir del resultado verificado de la Fase 1: mezcla deliberada
      de estaciones `rtserve` nuevas (para medir el riesgo de saturación del
      cliente único) y estaciones GEOFON nuevas más allá de `MN.TRI` (para
      medir el proceso nuevo bajo carga real, no solo con una estación).
      Documentar la selección exacta (lista de SEED IDs elegidos y por qué)
      en `openspec/changes/mega-wall-estaciones-cuaderno/design.md` o en un
      comentario en el propio commit — debe quedar trazable cuál fue el
      subconjunto de prueba, distinto del catálogo completo.
- [ ] 4.2 Agregar el subconjunto elegido a `LIVE_CANDIDATES_BY_CITY` y
      `LIVE_CANDIDATES_GEOFON_BY_CITY` en `src/services/spectrogram_service.py`
      (aditivo — las 27 ciudades/74 canales actuales no se tocan, spec
      `live-station-catalog` Requirement "Catálogo ampliado es aditivo").
      Actualizar `CITY_REGIONS`/`CITY_LABELS` en `src/services/wall_service.py`
      con las ciudades nuevas de este subconjunto, para que `build_global_wall()`
      (el wall "Global" existente) no las deje caer en "OTROS".
- [ ] 4.3 Crear `scripts/seed_thematic_walls.py` con el flag `--smoke-test`
      que exige `design.md` (Decision "La prueba de humo es un wall real..."):
      lee ambos catálogos, agrupa por `CITY_REGIONS` (reutilizando
      `pack_groups_into_columns()` de `wall_service.py`, sin reimplementarla),
      arma UN wall llamado `"Prueba de humo — Mega Wall"` limitado a las
      ciudades del subconjunto de 4.1, y lo crea vía `WallService.create()`
      contra el pool de producción. Sin flag, el script (todavía sin usar en
      esta fase) construiría el resto de walls — esa rama se implementa
      completa recién en la Fase 5, acá solo necesita andar con
      `--smoke-test`.
      *Criterio de aceptación*: `./venv/bin/python -m scripts.seed_thematic_walls --help`
      muestra el flag `--smoke-test`; ejecutarlo con `--dry-run` (si se
      agrega esa opción) o contra una base de prueba local imprime el layout
      generado sin reventar `validate_wall_layout()`.
- [ ] 4.4 Test de contrato: `tests/unit/test_seed_thematic_walls.py`,
      `test_smoke_test_layout_respeta_max_wall_channels_y_columns`: invocar
      la función de armado de layout del script con el subconjunto de 4.1 y
      pasar el resultado por `validate_wall_layout()` (la función real de
      `wall_service.py`, no un mock) — debe pasar sin `InvalidWallLayoutError`.
      Sin mutación crítica (convención fijada arriba: este script no lleva
      ese rigor).
- [ ] 4.5 En Railway: crear el servicio nuevo `seedlink-geofon`
      (`RAILWAY_DOCKERFILE_PATH=deploy/docker/Dockerfile.seedlink-geofon`,
      mismas variables `REDIS_URL`/`TIMESCALEDB_*` compartidas del proyecto,
      sin puerto expuesto). Redeploy del servicio `watchdog` existente (toma
      el `expected_channels` combinado de la Fase 3) y del servicio
      `seedlink` existente (toma el subconjunto ampliado de 4.2). Documentar
      en el reporte de esta tarea la confirmación real de que los 3 servicios
      arrancaron sin excepciones en sus logs de Railway (no "debería andar").
- [ ] 4.6 Ejecutar `./venv/bin/python -m scripts.seed_thematic_walls --smoke-test`
      manualmente, UNA vez, contra el DSN de producción — crea el wall de
      prueba. Confirmar en la UI de walls que aparece y que sus tiras cargan
      datos.
- [ ] 4.7 **Observación en producción (manual, no automatizable — mide un
      servicio de terceros sin SLA)**: durante una ventana sostenida
      (mínimo varias horas, ideal 24h), revisar:
      - Logs del servicio `seedlink` (rtserve): confirmar ausencia de gaps o
        reconexiones nuevas en los 74 canales previos, atribuibles al
        volumen agregado.
      - El wall de prueba abierto en el navegador: framerate, estabilidad de
        WebSocket, sin caídas de conexión.
      - Logs del servicio `seedlink-geofon`: confirmar que efectivamente
        ingiere datos (`MN.TRI` y el resto del subconjunto GEOFON elegido).
      Documentar el resultado EXACTO observado (no una impresión general) en
      el reporte de esta tarea o en `mutation-log.md`/design.md de este
      change — esta observación es la que decide si se avanza a la Fase 6.
- [ ] 4.8 **Punto de decisión explícito**: si 4.7 muestra degradación
      (gaps/reconexiones nuevos en rtserve, o caídas de WebSocket), NO avanzar
      a la Fase 6 — revertir el commit del subconjunto agregado en 4.2 (el
      catálogo de rtserve vuelve a 74 canales; el proceso `seedlink-geofon`
      puede quedar corriendo o apagarse, no afecta la decisión sobre
      rtserve), documentar la causa investigada, y decidir si el change queda
      parcialmente cerrado (solo GEOFON + subconjunto reducido) o si necesita
      una ronda de diagnóstico adicional antes de reintentar. Si 4.7 NO
      muestra degradación, avanzar a la Fase 6.

---

## Phase 5: Walls temáticos por región (script completo)

**Estado desplegable al cerrar la fase**: `scripts/seed_thematic_walls.py`
soporta la corrida completa (sin `--smoke-test`), pero todavía se ejecuta
sobre el catálogo del subconjunto de humo — la corrida real contra el
catálogo COMPLETO se hace en la Fase 6, después de confirmar el conteo real
de estaciones por región.

- [ ] 5.1 Completar `scripts/seed_thematic_walls.py`: implementar la rama sin
      `--smoke-test` que agrupa TODAS las ciudades de ambos catálogos según
      `REGION_WALL_NAMES` (mapeo región→nombre de wall temático, ver
      `design.md` Interfaces/Contracts — América/Europa/Asia-Oceanía como
      punto de partida, sujeto a desglose si el conteo lo exige, ver 5.2) y
      crea un wall por nombre de región resultante vía `WallService.create()`.
- [ ] 5.2 Con el catálogo COMPLETO ya verificado de la Fase 1 (todavía sin
      cargar al código — esto es un cálculo, no una carga), contar cuántos
      canales caerían en cada wall temático según `REGION_WALL_NAMES` y
      confirmar contra `MAX_WALL_CHANNELS = 120`. Si "América" (o cualquier
      otra agrupación) supera 120 canales, desglosarla en 2-3 walls
      (Norteamérica/Centroamérica y Caribe/Sudamérica, por ejemplo) —
      resolviendo la Open Question del `design.md` con el conteo real, no
      antes. Documentar la decisión final de agrupamiento (cuántos walls,
      qué regiones entran en cada uno) actualizando `REGION_WALL_NAMES` en el
      script y dejando la razón en un comentario.
- [ ] 5.3 Test: `tests/unit/test_seed_thematic_walls.py`,
      `test_full_catalog_layout_por_region_respeta_max_wall_channels`:
      parametrizado sobre cada wall temático final (según la decisión de
      5.2), pasar su layout generado por `validate_wall_layout()` y confirmar
      que ninguno excede 120 canales ni 8 columnas — si este test falla para
      alguna región con el catálogo completo real, es la señal de que esa
      región necesita desglosarse más (retroalimenta a 5.2, no se ignora).
- [ ] 5.4 Correr `./venv/bin/python -m pytest tests/unit/test_seed_thematic_walls.py -q`
      y confirmar verde antes de avanzar a la Fase 6.

---

## Phase 6: Rollout completo (Fase 2 del design — catálogo total)

**Estado desplegable al cerrar la fase**: el catálogo completo verificado en
la Fase 1 está cargado en ambos dicts, ambos procesos de ingesta y el
watchdog corren con el catálogo final, y los walls temáticos definitivos
están creados. Esta fase SOLO arranca si la Fase 4 (prueba de humo) no
mostró degradación.

- [ ] 6.1 Agregar el RESTO del catálogo verificado en la Fase 1 (todo lo que
      no entró en el subconjunto de humo de 4.1) a `LIVE_CANDIDATES_BY_CITY`
      y `LIVE_CANDIDATES_GEOFON_BY_CITY`, respetando la exclusión explícita
      de los 5 países sin servidor (spec `live-station-catalog`) y de las 46
      estaciones completas de Yellowstone (solo las 4 principales, ya
      cargadas en la Fase 4 si estaban en el subconjunto, o acá si no lo
      estaban). Actualizar `CITY_REGIONS`/`CITY_LABELS` en `wall_service.py`
      con TODAS las ciudades nuevas restantes.
- [ ] 6.2 Actualizar los tests de cardinalidad existentes
      (`tests/unit/test_wall_service.py`, `tests/unit/test_station_catalog.py`)
      que dependan de `len(LIVE_CANDIDATES_BY_CITY)` o conteos similares — sin
      cambio de contrato, solo de cardinalidad (mismo criterio que
      `design.md`, File Changes, última fila).
- [ ] 6.3 Redeploy de `seedlink` (rtserve) y `seedlink-geofon` con el catálogo
      final. Confirmar en logs de Railway que ambos procesos arrancan sin
      excepciones y comienzan a suscribirse a los canales nuevos.
- [ ] 6.4 Ejecutar `./venv/bin/python -m scripts.seed_thematic_walls` (sin
      `--smoke-test`) contra producción — crea/actualiza los walls temáticos
      definitivos según la decisión de agrupamiento de la Fase 5.2. Confirmar
      en la UI que los walls aparecen con sus canales agrupados por región.
- [ ] 6.5 Correr `./venv/bin/python -m pytest tests/ -q` completo y comparar
      el conteo total contra la baseline de la tarea 0.1 — el delta debe ser
      exactamente los tests nuevos agregados en las Fases 2-5, sin ninguna
      regresión en los tests preexistentes (mismo criterio que la tarea 7.1
      del change anterior).

---

## Phase 7: Verificación final contra los Success Criteria del proposal

- [ ] 7.1 **Success Criterion 1**: revisar los logs de `seedlink` de la
      ventana de observación de la Fase 4.7 (y, si se repitió observación
      tras la Fase 6, también esa) y confirmar por escrito que los 74
      canales originales siguieron sin gaps ni reconexiones adicionales
      durante una ventana sostenida — citar la ventana exacta observada.
- [ ] 7.2 **Success Criterion 2**: confirmar por escrito el resultado de
      framerate/estabilidad de WebSocket del wall de prueba de la Fase 4.7 —
      sin caídas de conexión ni degradación visible con hasta ~30 tiras.
- [ ] 7.3 **Success Criterion 3**: verificar en `spectrogram_columns`
      (consulta directa a TimescaleDB) que existen columnas frescas para al
      menos `MN.TRI` y el resto del subconjunto GEOFON, con timestamps
      recientes, confirmando ingesta independiente del proceso `rtserve`.
- [ ] 7.4 **Success Criterion 4**: apagar deliberadamente el servicio
      `seedlink-geofon` en Railway y confirmar que el servicio `seedlink`
      (rtserve) sigue sirviendo sin interrupción — verificación directa de
      aislamiento de fallos, documentar el resultado exacto observado, luego
      reactivar el servicio.
- [ ] 7.5 **Success Criterion 5**: comparar el catálogo `expected_channels`
      real del watchdog (`DEFAULT_CHANNELS + DEFAULT_CHANNELS_GEOFON`) contra
      los canales realmente configurados en ambos procesos de ingesta y
      confirmar que coinciden — sin falsos "mudos" reportados en los logs del
      watchdog tras el rollout completo de la Fase 6.
- [ ] 7.6 **Success Criterion 6**: confirmar que al menos un wall temático
      por región (ej. "América") quedó creado y funcional con `WallManager`,
      dentro de `MAX_WALL_CHANNELS = 120` / `MAX_WALL_COLUMNS = 8` sin haber
      modificado esas constantes — `rg -n "MAX_WALL_CHANNELS = 120\|MAX_WALL_COLUMNS = 8"
      src/services/wall_service.py` debe seguir mostrando los valores
      originales sin cambios.
- [ ] 7.7 **Success Criterion 7**: confirmar que el catálogo final documenta
      explícitamente los 5 países sin servidor SeedLink conocido (UAE,
      Afganistán, Java específico, Venezuela, Guatemala — o el subconjunto
      real que quedó sin resolver tras la Fase 1) como pendientes fuera de
      scope, sin ninguna estación inventada o aproximada puesta en su lugar —
      referenciar la sección de la Fase 1.6.
- [ ] 7.8 Cerrar `mutation-log.md` de este change: confirmar que la mutación
      crítica de la Fase 3 (tarea 3.3) está registrada con su salida de `rg`,
      el test que se puso rojo, y confirmación de reversión. Agregar nota de
      cierre con fecha y conteo total de mutaciones verificadas (1, a
      diferencia de las 8 del change anterior — coherente con que este change
      toca mucho menos lógica de decisión nueva en `watchdog.py`).
- [ ] 7.9 `tsc --noEmit` en `dashboard/`: verificar si este change tocó algún
      archivo bajo `dashboard/` (no se anticipa ninguno según el proposal,
      Affected Areas — "no se anticipan cambios de componentes React"). Si no
      tocó nada, dejarlo dicho explícitamente en el reporte final (mismo
      criterio que la tarea 7.2 del change anterior); si por algún motivo se
      terminó tocando algo (por ejemplo, si el catálogo de ciudades nuevo
      necesitara reflejarse en `dashboard/lib/seismic-cities.ts` para la UI de
      walls), correr `cd dashboard && ./node_modules/.bin/tsc --noEmit` y
      confirmar exit 0.

---

## Phase 8: Documentación y cierre

- [ ] 8.1 Actualizar la sección "Pendiente de resolver" de
      `docs/superpowers/plans/2026-08-31-mega-wall-catalogo-cuaderno.md`
      marcando como resuelto lo que este change cerró (investigación de
      servidores alternativos, decisión de arquitectura ya ejecutada) y
      dejando explícito lo que sigue pendiente de verdad (si algo del
      catálogo quedó sin verificar, o los 5 países sin servidor conocido).
- [ ] 8.2 Actualizar el comentario narrativo de `LIVE_CANDIDATES_BY_CITY` en
      `src/services/spectrogram_service.py` para que la sección "Cómo se
      armó esta lista" incluya la ronda de ampliación de este change (fecha,
      de cuántas a cuántas ciudades, mismo estilo que ya documenta la ronda
      2026-08-03 de 3 a 26 ciudades) — mantiene la trazabilidad histórica que
      ya tiene el archivo.
- [ ] 8.3 Confirmar que el Rollback Plan del proposal sigue siendo ejecutable
      tal cual está escrito tras el rollout completo (revertir el commit del
      catálogo restaura las 27 ciudades/74 canales originales; apagar
      `seedlink-geofon` no requiere pasos de código adicionales) — no requiere
      código nuevo, es una relectura de verificación antes de cerrar el
      change.
</content>
