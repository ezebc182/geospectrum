# Design: Mega Wall de Estaciones del Cuaderno

## Technical Approach

Este change amplía el catálogo de estaciones en vivo y agrega un segundo servidor SeedLink (GEOFON), sin tocar la arquitectura existente de streaming. La estrategia técnica se apoya en tres decisiones que se refuerzan entre sí:

1. **El catálogo de GEOFON vive en un dict separado**, paralelo a `LIVE_CANDIDATES_BY_CITY`, para que ningún consumidor existente de esa estructura (`resolve_live_catalog`, `station_catalog`, `channels_from_catalog`, `WallManager.build_global_wall`, cuatro endpoints de `main.py`) tenga que cambiar de forma.
2. **GEOFON corre como un segundo proceso Railway**, instanciando `SeedLinkIngestor(bus, server="geofon.gfz-potsdam.de")` en un `__main__` nuevo — la clase no se toca, el proceso de `rtserve.earthscope.org` no se toca.
3. **`watchdog.py` combina ambos catálogos por concatenación de listas**, no por lógica nueva de merge — mismo patrón de list comprehension que ya usa hoy para `DEFAULT_CHANNELS`.

Esto respeta el Approach del proposal punto por punto: catálogo aditivo (§1), aislamiento total de procesos (§2), varios walls sin tocar guardrails (§3), prueba de humo antes del catálogo completo (§4), watchdog actualizado sin rediseñar (§5).

## Architecture Decisions

### Decision: Catálogo de GEOFON en un dict separado (`LIVE_CANDIDATES_GEOFON_BY_CITY`)

**Choice**: Crear una segunda constante en `spectrogram_service.py`, misma forma que la existente:

```python
LIVE_CANDIDATES_GEOFON_BY_CITY: Dict[str, List[str]] = {
    "trieste": ["MN.TRI..HHZ"],
    "kabul": ["GE.KBU..BHZ", "GE.KBU..SHZ"],
    "casablanca": ["WM.AVE..HHZ", "WM.AVE..BHZ"],
    # ... el resto de estaciones confirmadas contra geofon.gfz-potsdam.de
}
```

La lista de candidatas por zona NO es decorativa: ver la decisión
"Las candidatas de GEOFON son por CANAL, no por estación" más abajo.

**Alternatives considered**:

- **Opción B: anotar el servidor dentro del dict existente** (cambiar `List[str]` por `List[dict]` tipo `{"seed_id": ..., "server": ...}`, o `List[tuple[str, str]]`). Descartada tras verificar con `rg -n "LIVE_CANDIDATES_BY_CITY"` los consumidores reales:
  - `src/main.py` (4 sitios: `_CATALOG_CHANNELS` línea 2345 con `for seed_id in candidates`, y tres llamadas a `resolve_live_catalog`/`station_catalog` que reciben el dict entero)
  - `src/services/wall_service.py:65` (`candidates[0]` para el canal primario del muro global)
  - `src/services/seedlink_ingestor.py` (`channels_from_catalog()`, que hace `seed_id.split(".")` sobre cada elemento de la lista)
  - `resolve_live_catalog()` y `station_catalog()` en `spectrogram_service.py`, ambas con `candidates[0]` y `for index, channel in enumerate(candidates)`
  - 4 archivos de test que iteran `.values()` esperando strings (`test_ws_spectrogram.py`, `test_station_catalog.py`, `test_wall_service.py`, `test_wall_layout_validation.py`)

  Cambiar la forma del valor de `List[str]` a `List[dict]`/`List[tuple]` obliga a tocar CADA uno de esos sitios (desempaquetar un campo extra en cada `.split(".")`, cada `candidates[0]`, cada comparación con `active_channels` que hoy son strings SEED comparados 1:1 contra `spectrogram_columns.channel`, que TAMBIÉN es un string SEED plano sin discriminador de servidor). Es un diff de forma que atraviesa 3 servicios + 1 router + 4 suites de test para resolver un problema que un dict nuevo resuelve sin tocar una sola línea existente.

**Rationale**: `LIVE_CANDIDATES_BY_CITY` NUNCA necesitó saber su servidor — siempre fue `rtserve.earthscope.org` implícito, hardcodeado como default de `SeedLinkIngestor.__init__`. El servidor no es un atributo de la estación, es un atributo de QUÉ PROCESO la consume. Modelarlo como un dict paralelo (mismo patrón que "otro catálogo de candidatas") mantiene esa separación: cada proceso Railway (`rtserve`, `geofon`) sabe su propio dict a partir de su propio `__main__`, y ningún código que ya funciona con `LIVE_CANDIDATES_BY_CITY` necesita enterarse de que existe un segundo servidor. El costo es duplicar un puñado de funciones de composición (`channels_from_catalog`, `resolve_live_catalog`, `station_catalog` deben poder recibir CUALQUIER dict de ese `Dict[str, List[str]]`, cosa que YA hacen hoy — reciben el dict como parámetro, no como global fija) — no hay que escribirlas de nuevo, solo invocarlas con el dict de GEOFON donde corresponda.

**Naming**: se eligió `LIVE_CANDIDATES_GEOFON_BY_CITY` (servidor en el medio del nombre) en vez de `GEOFON_LIVE_CANDIDATES_BY_CITY`, para que ambas constantes ordenen adyacentes alfabéticamente en el módulo y el `import` (`grep LIVE_CANDIDATES`) las encuentre juntas.

### Decision: Las candidatas de GEOFON son por CANAL, no por estación (corrección post-relevamiento)

**Contexto**: la versión original de este design proponía arrancar con
`{"trieste": ["MN.TRI..HHZ"]}` — una estación, un canal, sin respaldo. El
relevamiento del 2026-08-31 (`scripts/station_survey/`) midió que **el catálogo
SeedLink rota en minutos**: `II.BORG` (Islandia) e `IN.MNC` (India)
desaparecieron por completo del catálogo de `rtserve` con veinte minutos de
diferencia entre dos dumps, y eran la única estación de su zona. Una entrada de
catálogo sin respaldo es una zona que se apaga sola.

`LIVE_CANDIDATES_BY_CITY` ya resuelve esto y lo dice en su propio comentario:
*"Las estaciones se caen de a una y perseguir a la 'viva de hoy' editando el
catálogo es un juego perdido: el failover lo resuelve `resolve_live_catalog`
contra las columnas frescas de TimescaleDB."* El catálogo de GEOFON tiene que
nacer con la misma propiedad.

**Choice**: cada zona de `LIVE_CANDIDATES_GEOFON_BY_CITY` lleva **más de una
candidata siempre que exista una**, y cuando no hay una segunda ESTACIÓN viva
en la zona, las candidatas adicionales son **otros canales verticales de la
misma estación**.

**Por qué por canal y no por estación**: se midió. Bounding box sobre el
catálogo GEOFON vivo (`<30 min`) el 2026-08-31, cruzado contra los dos
metadatas FDSN:

| Zona | Estación | 2ª estación viva en GEOFON | Canales verticales vivos |
|---|---|---|---|
| Trieste | `MN.TRI` | ninguna | `HHZ` solo |
| Kabul | `GE.KBU` | ninguna | `BHZ`, `SHZ` (+`LHZ`) |
| Marruecos | `WM.AVE` | ninguna útil (`WM.SFS` está en San Fernando, **España**, cruzando el estrecho) | `HHZ`, `BHZ`, `HLZ`, `BLZ` (+`LHZ`, `LLZ`) |

El respaldo por estación **no existe** en GEOFON para estas zonas — no es una
decisión de diseño, es lo que hay en el servidor. El respaldo por canal sí
existe en 2 de las 3, y es real: son digitalizadores y sensores distintos del
mismo sitio. Si el flujo `HHZ` se corta, `BHZ` sigue llegando.

**Canales que NO entran como candidatas**: `LHZ`/`LLZ` son banda larga a **1 Hz
de muestreo**. El espectrograma de este proyecto grafica hasta Nyquist, así que
un canal de 1 Hz da un eje de frecuencia que muere en 0,5 Hz — inservible para
el uso que le da el muro, aunque el canal esté vivo. `SHZ` (corto período, alta
frecuencia) sí entra. El filtro es el sample rate, no el estar vivo.

**Trieste queda con una sola candidata**, documentado y a propósito: no hay
segundo canal vertical en `MN.TRI` ni segunda estación en la zona. Es la
excepción medida, no un descuido — y es la primera zona que va a apagarse
cuando GEOFON rote. Se registra como riesgo conocido, no se rellena con una
estación de otro país para que la tabla se vea completa.

**Consecuencia sobre las Fases 2 y 6**: la Fase 2 ya no carga "solo `MN.TRI`".
Carga las tres zonas confirmadas vivas con todas sus candidatas — sigue siendo
un subconjunto chico (3 zonas, 5 canales) frente al catálogo completo del
cuaderno que entra en la Fase 6, así que el escalonamiento que pedía el
proposal (§4, prueba de humo antes del catálogo completo) se mantiene intacto.

### Decision: Segundo proceso Railway como módulo `__main__` separado (`seedlink_ingestor_geofon.py`), no una env var en el mismo archivo

**Choice**: Archivo nuevo `src/services/seedlink_ingestor_geofon.py`, con un `__main__` calcado línea por línea del de `seedlink_ingestor.py:488-561`, cambiando solo:
- `server="geofon.gfz-potsdam.de"` explícito en el constructor de `SeedLinkIngestor`
- El catálogo de canales: `channels_from_catalog(LIVE_CANDIDATES_GEOFON_BY_CITY)` en vez de `DEFAULT_CHANNELS`
- Sin `ephemeral_redis`: la suscripción efímera (`ephemeral_channels.py`) es una feature de exploración ad-hoc del catálogo principal — fuera de alcance para el proceso GEOFON en este change (no lo pide el proposal, y sumarlo implica decidir cómo el usuario elegiría "efímero contra qué servidor", pregunta que no está resuelta)
- Logs con prefijo `seedlink_ingestor_geofon:` en vez de `seedlink_ingestor:`, para poder diferenciar cuál proceso logueó qué en Railway

**Alternatives considered**:

- **Mismo `seedlink_ingestor.py`, parametrizado por env var `SEEDLINK_SERVER`** (ej. `settings.seedlink_server`, default `"rtserve.earthscope.org"`, y el `__main__` elige el catálogo según el valor de esa env var). Descartada por dos razones concretas:
  1. **Acoplamiento de rollback**: el proposal es explícito en que "apagar `seedlink-geofon` no debe afectar a `rtserve`" (Rollback Plan, punto 1) y que el riesgo principal es "tocar código de producción activo... sin necesidad" (Approach §2). Un solo archivo con un `if/else` sobre una env var significa que CUALQUIER cambio futuro al `__main__` (agregar una línea de logging, cambiar el orden de conexión de Redis) se despliega a AMBOS procesos a la vez en el próximo build, aunque solo se haya tocado un Dockerfile — Railway no permite "buildear el mismo Dockerfile con distinto código fuente" sin ese código ya estando en la imagen. El aislamiento de fallos que el proposal pide (Approach §2: "el aislamiento de fallos... sale gratis con un proceso del SO separado") se diluye si ambos procesos ejecutan el mismo módulo: un bug introducido "solo para GEOFON" corre también en el proceso de `rtserve` desde el día en que se mergea, aunque nunca se dispare (branch muerta en producción hasta que alguien cambie la env var).
  2. **El propio proposal ya fijó el patrón a calcar**: "mismo molde que `watchdog.py`/`Dockerfile.watchdog`" (Approach §2, Affected Areas). `watchdog.py` es un archivo propio con su propio `__main__`, no una rama condicional dentro de otro proceso existente — replicar ESE patrón exactamente es lo que el proposal pide, no inventar uno nuevo (aunque sea razonable en abstracto).

  Se reconoce que la alternativa de env var es más DRY en líneas de código, pero el proposal prioriza explícitamente aislamiento sobre reutilización en este punto — no es una decisión libre de este design, es la que ya vino tomada.

**Rationale**: Archivo separado + Dockerfile separado es exactamente lo que ya existe para `watchdog.py` vs. `seedlink_ingestor.py` vs. `events_ingestor.py`: tres procesos, tres archivos, tres Dockerfiles, un mismo `requirements.txt` y código fuente compartido vía `COPY src/`. Es el patrón establecido del proyecto, no uno nuevo — cero curva de aprendizaje para quien mantenga esto después, y el diff de implementación es "copiar 70 líneas y cambiar 3".

### Decision: `watchdog.py` combina catálogos por concatenación de listas, no por una función de merge nueva

**Choice**: En `src/services/watchdog.py`, la línea 514 (`expected_channels = [f"{net}.{sta}.{cha}" for net, sta, cha in DEFAULT_CHANNELS]`) pasa a:

```python
from src.services.seedlink_ingestor import DEFAULT_CHANNELS
from src.services.seedlink_ingestor_geofon import DEFAULT_CHANNELS_GEOFON

# ...

expected_channels = [
    f"{net}.{sta}.{cha}"
    for net, sta, cha in DEFAULT_CHANNELS + DEFAULT_CHANNELS_GEOFON
]
```

`DEFAULT_CHANNELS_GEOFON` se define en `seedlink_ingestor_geofon.py` con el mismo patrón que ya existe: `DEFAULT_CHANNELS_GEOFON = channels_from_catalog(LIVE_CANDIDATES_GEOFON_BY_CITY)`, reutilizando la función `channels_from_catalog()` de `seedlink_ingestor.py` (se importa, no se duplica — ya acepta cualquier `Dict[str, List[str]]` como parámetro, no está atada a la constante global).

**Alternatives considered**:

- **Una función `merged_expected_channels()` nueva en `watchdog.py`** que encapsule la concatenación: descartada por ser una abstracción de una sola línea sin ningún comportamiento propio (no dedupea, no valida, no transforma — literalmente `a + b`). `check_seedlink()` ya trata `expected_channels` como un `set` internamente (`set(expected_channels)`, línea 133), así que un duplicado teórico entre catálogos (imposible por convención FDSN, ver riesgo de colisión del proposal) se resolvería solo ahí sin que la concatenación necesite dedupear antes.
- **Un tercer catálogo combinado `ALL_DEFAULT_CHANNELS` a nivel de módulo**, calculado en algún lugar común: descartada porque no hay un módulo natural que sea dueño de "la unión de ambos servidores" sin crear un acoplamiento nuevo entre `seedlink_ingestor.py` y `seedlink_ingestor_geofon.py` (el primero no debe importar del segundo — invertiría la dependencia y ensuciaría el proceso de producción actual con un import de un módulo que ni siquiera corre en su Dockerfile). `watchdog.py` es el ÚNICO consumidor que necesita la unión (ningún proceso de ingesta necesita saber del catálogo del otro sistema), así que la concatenación vive ahí, donde se usa una sola vez.

**Rationale**: Sigue el criterio que el proposal ya fijó para este punto exacto (Approach §5: "el cambio es sumar los canales del proceso GEOFON a la lista... sin tocar la lógica de comparación de canales activos"). `check_seedlink()` no cambia ni una línea — sigue recibiendo `list[str]`, exactamente como hoy. El cambio entero vive en cómo se arma `expected_channels` dentro de `_main()`, que es configuración de arranque, no lógica de dominio.

### Decision: Walls temáticos se crean con un script de datos one-off que llama a `WallService`, no manualmente vía UI

**Choice**: Un script Python de uso único (`scripts/seed_thematic_walls.py`, ejecutado manualmente contra la base de producción una sola vez, NO parte del código de arranque de ningún proceso) que:
1. Lee el catálogo confirmado (ambos dicts, `LIVE_CANDIDATES_BY_CITY` ampliado + `LIVE_CANDIDATES_GEOFON_BY_CITY`) agrupado por región (mismo mapeo `CITY_REGIONS` que ya usa `wall_service.py:19-32`, extendido con las ciudades nuevas).
2. Arma un `layout` por región (América / Europa / Asia-Oceanía / Medio Oriente-Asia Central) con la MISMA función `pack_groups_into_columns()` que ya usa `build_global_wall()` — reutilizada, no reimplementada.
3. Llama a `WallService.create(user_id, name, layout)` una vez por región, contra el `asyncpg.Pool` de producción.

Se ejecuta manualmente (`./venv/bin/python -m scripts.seed_thematic_walls`) desde la terminal del desarrollador contra el DSN de producción — no es un endpoint HTTP nuevo, no corre en ningún Dockerfile, no es parte de ninguna migración.

**Alternatives considered**:

- **Crear los walls a mano vía la UI existente** (el usuario arma cada wall manualmente arrastrando ciudades en el armador de muros): descartada como mecanismo PRINCIPAL porque con 60-90 estaciones nuevas agrupadas en 3-4 walls temáticos, el armado manual en la UI es un trabajo de arrastrar decenas de tiras una por una — exactamente el tipo de tarea mecánica y propensa a errores que `build_global_wall()` ya automatiza para el wall "Global" existente. El proposal dice "usando la API existente" (Approach §3), y `WallService.create()` ES esa API — un script que la invoca directamente es más fiel a esa frase que pedirle al usuario que reproduzca a mano lo que el código ya sabe generar.
- **Un endpoint HTTP nuevo `POST /walls/seed-thematic`**: descartada por ser código de producción permanente para una operación que se ejecuta una vez (o unas pocas veces, si se ajusta el agrupamiento). Un script de una sola corrida no necesita autenticación, rate limiting, ni vivir en el árbol de rutas de `main.py` — agregar un endpoint solo para esto viola el criterio de "no gold-plating": nadie va a volver a crear estos walls por HTTP después de esta ronda.

**Rationale**: El script es la opción que más se parece a cómo el proyecto ya resuelve este problema exacto (`build_global_wall()` es, literalmente, la misma idea — "generar un layout agrupado por región a partir del catálogo" — ya escrita, solo que hoy no persiste el resultado, lo devuelve inline al armar el wall "Global" default). Reusar `pack_groups_into_columns` en vez de reinventar el agrupamiento evita divergencia entre cómo se ve el wall "Global" (todas las ciudades) y cómo se ven los walls temáticos nuevos (subconjunto por región).

### Decision: La prueba de humo es un wall real (`"Prueba de humo — Mega Wall"`) con un subconjunto real de 20-30 estaciones, no un flag de catálogo

**Choice**: El subconjunto de la prueba de humo se implementa cargando primero SOLO una porción del catálogo ampliado a `LIVE_CANDIDATES_BY_CITY`/`LIVE_CANDIDATES_GEOFON_BY_CITY` (20-30 ciudades nuevas, mezcla deliberada de ambos servidores para poder medir el riesgo de cada uno por separado) y creando UN wall de prueba con ese subconjunto vía el mismo script `seed_thematic_walls.py` (con una bandera de línea de comandos `--smoke-test` que limita las regiones/ciudades incluidas a una lista fija). No hay tabla, columna ni flag nuevo en la base — el "subconjunto de prueba" es, literalmente, un subconjunto del código fuente del catálogo en un commit intermedio, antes de que el commit con el catálogo COMPLETO se mergee.

**Alternatives considered**:

- **Un flag `is_smoke_test: bool` por estación en el catálogo, filtrado en runtime**: descartada por ser infraestructura permanente (una columna/campo que vive para siempre en el código) para resolver un problema transitorio (una ronda de validación de un solo despliegue). El proposal es explícito: "cargar primero un subconjunto... antes de cargar el resto del catálogo confirmado" (Approach §4) — es una secuencia de DOS commits/deploys, no un modo de operación permanente del sistema.
- **Un wall separado sin subconjunto de catálogo** (cargar el catálogo COMPLETO de una sola vez, pero armar un wall que solo muestre 20-30 tiras): descartada porque no prueba lo que el proposal pide probar. El riesgo real (Approach §4, Risks del proposal) es que `rtserve.earthscope.org` — la conexión TCP única y bloqueante — se sature al SUSCRIBIRSE a más canales, no al MOSTRARLOS en un wall. Si el catálogo completo ya está suscripto (`channels_from_catalog()` ya generó 90+ pares nuevos y `SeedLinkIngestor.run()` ya los pidió todos vía `select_stream()`), el daño ya está hecho aunque el wall de prueba solo muestre 20 tiras — la prueba de humo debe frenar la SUSCRIPCIÓN, no solo la vista.

**Rationale**: Dos deploys secuenciales y reversibles (subconjunto → catálogo completo) es exactamente lo que permite el Rollback Plan del proposal ("revertir el commit que agrega las entradas nuevas restaura el catálogo actual") sin inventar ningún mecanismo de feature-flagging nuevo. El commit del subconjunto de prueba se mergea, se observa en producción (Success Criteria del proposal: gaps, reconexiones, WebSockets), y solo si pasa se mergea el commit con el resto del catálogo — el control de versiones ES el mecanismo de habilitación progresiva, no hace falta duplicarlo en runtime.

## Data Flow

```
                    ┌───────────────────────────────────────────┐
                    │  spectrogram_service.py                    │
                    │  LIVE_CANDIDATES_BY_CITY (rtserve, ampliado)│
                    │  LIVE_CANDIDATES_GEOFON_BY_CITY (nuevo)     │
                    └───────────────────────────────────────────┘
                          │                              │
              channels_from_catalog()          channels_from_catalog()
                          │                              │
                          ▼                              ▼
        ┌─────────────────────────────┐   ┌──────────────────────────────────┐
        │ seedlink_ingestor.py         │   │ seedlink_ingestor_geofon.py       │
        │ (proceso Railway "seedlink") │   │ (proceso Railway "seedlink-geofon")│
        │ DEFAULT_CHANNELS              │   │ DEFAULT_CHANNELS_GEOFON            │
        │ SeedLinkIngestor(             │   │ SeedLinkIngestor(                  │
        │   server="rtserve...")        │   │   server="geofon.gfz-potsdam.de") │
        └──────────────┬────────────────┘   └──────────────┬─────────────────┘
                        │                                    │
                        ▼                                    ▼
                 EventBus (Redis Pub/Sub)  ◄──────── mismo bus, misma instancia
                        │
                        ▼
              TimescaleDB (spectrogram_columns) ◄── column_writer de AMBOS procesos
                        │                              (misma tabla, misma columna
                        │                               `channel`, SEED ID global-
                        │                               mente único por convención)
                        ▼
              FastAPI WebSocket /ws/spectrogram/{channel}
                        │
                        ▼
                   dashboard/ (walls temáticos, uno por región)


   watchdog.py (proceso Railway "watchdog"):
        DEFAULT_CHANNELS (rtserve)  +  DEFAULT_CHANNELS_GEOFON  →  expected_channels
                                              │
                                              ▼
                              check_seedlink(pool, stale_after_s, expected_channels)
                              (sin cambios: sigue siendo un solo chequeo contra UNA
                               tabla — TimescaleDB no distingue de qué servidor vino
                               cada columna, ni necesita hacerlo)


   scripts/seed_thematic_walls.py (ejecución manual, una vez):
        LIVE_CANDIDATES_BY_CITY + LIVE_CANDIDATES_GEOFON_BY_CITY
                     │
          agrupar por CITY_REGIONS (extendido) + pack_groups_into_columns()
                     │
                     ▼
          WallService.create(user_id, "América", layout)
          WallService.create(user_id, "Europa", layout)
          WallService.create(user_id, "Asia-Oceanía", layout)
          (respetando MAX_WALL_CHANNELS=120 / MAX_WALL_COLUMNS=8 por wall)
```

## File Changes

| File | Action | Description |
|------|--------|--------------|
| `src/services/spectrogram_service.py` | Modify | Ampliar `LIVE_CANDIDATES_BY_CITY` con las estaciones confirmadas del cuaderno contra `rtserve.earthscope.org`; agregar `LIVE_CANDIDATES_GEOFON_BY_CITY` nuevo con las confirmadas contra GEOFON (mínimo `MN.TRI` Trieste) |
| `src/services/seedlink_ingestor_geofon.py` | Create | `__main__` standalone calcado de `seedlink_ingestor.py:488-561`, con `server="geofon.gfz-potsdam.de"`, `DEFAULT_CHANNELS_GEOFON = channels_from_catalog(LIVE_CANDIDATES_GEOFON_BY_CITY)`, sin `ephemeral_redis`, logs con prefijo propio |
| `src/services/seedlink_ingestor.py` | Read-only (reused) | `SeedLinkIngestor` y `channels_from_catalog()` se importan tal cual desde el módulo nuevo; la clase y la función no se modifican |
| `deploy/docker/Dockerfile.seedlink-geofon` | Create | Calco de `Dockerfile.seedlink`, único cambio: `CMD ["python", "-m", "src.services.seedlink_ingestor_geofon"]` |
| `src/services/watchdog.py` | Modify | `_main()`: importar `DEFAULT_CHANNELS_GEOFON` de `seedlink_ingestor_geofon.py` y concatenarlo a `DEFAULT_CHANNELS` al armar `expected_channels` (línea ~514) |
| `src/services/wall_service.py` | Modify | Extender `CITY_REGIONS`/`CITY_LABELS` con las ciudades nuevas del catálogo ampliado, para que `build_global_wall()` (wall "Global" existente) siga agrupando correctamente sin dejar ciudades nuevas cayendo en "OTROS" |
| `scripts/seed_thematic_walls.py` | Create | Script one-off: agrupa ambos catálogos por región, arma layouts con `pack_groups_into_columns()` (reutilizada de `wall_service.py`), crea los walls temáticos vía `WallService.create()`. Acepta `--smoke-test` para limitar el subconjunto de la prueba de humo |
| Railway (dashboard, fuera del repo) | New | Servicio nuevo `seedlink-geofon`: `RAILWAY_DOCKERFILE_PATH=deploy/docker/Dockerfile.seedlink-geofon`, mismas variables compartidas (`REDIS_URL`, `TIMESCALEDB_*`) que el servicio `seedlink` existente, sin puerto expuesto |
| `tests/unit/test_wall_service.py`, `tests/unit/test_station_catalog.py` | Modify | Ajustar aserciones de conteo (`len(LIVE_CANDIDATES_BY_CITY)`, `len(result) > ...`) al catálogo ampliado — sin cambio de contrato, solo de cardinalidad |

## Interfaces / Contracts

```python
# src/services/spectrogram_service.py

# Ya existe, sin cambio de forma — solo más entradas:
LIVE_CANDIDATES_BY_CITY: Dict[str, List[str]] = {...}

# Nuevo, MISMA forma (Dict[str, List[str]]) — decisión de diseño clave:
LIVE_CANDIDATES_GEOFON_BY_CITY: Dict[str, List[str]] = {
    "trieste": ["MN.TRI..HHZ"],
    # ... resto de estaciones confirmadas contra geofon.gfz-potsdam.de
}
```

```python
# src/services/seedlink_ingestor_geofon.py (nuevo)

from src.services.seedlink_ingestor import SeedLinkIngestor, channels_from_catalog
from src.services.spectrogram_service import LIVE_CANDIDATES_GEOFON_BY_CITY

DEFAULT_CHANNELS_GEOFON = channels_from_catalog(LIVE_CANDIDATES_GEOFON_BY_CITY)

if __name__ == "__main__":
    # Calco de seedlink_ingestor.py __main__, con:
    #   SeedLinkIngestor(bus, server="geofon.gfz-potsdam.de", column_writer=...,
    #                     metrics_store=...)  # SIN ephemeral_redis
    #   thread = threading.Thread(target=ingestor.run,
    #                              args=(DEFAULT_CHANNELS_GEOFON,), daemon=True)
    ...
```

```python
# src/services/watchdog.py — _main(), cambio puntual en la línea ~511-514

from src.services.seedlink_ingestor import DEFAULT_CHANNELS
from src.services.seedlink_ingestor_geofon import DEFAULT_CHANNELS_GEOFON

expected_channels = [
    f"{net}.{sta}.{cha}"
    for net, sta, cha in DEFAULT_CHANNELS + DEFAULT_CHANNELS_GEOFON
]
```

```python
# scripts/seed_thematic_walls.py (nuevo, uso manual)

REGION_WALL_NAMES = {
    "SUDAMÉRICA": "América",       # o desglosar Norte/Centro/Sudamérica en 2-3
    "NORTEAMÉRICA": "América",     # walls si el conteo por región supera
    "CENTROAMÉRICA Y CARIBE": "América",  # MAX_WALL_CHANNELS=120 — a definir
    "EUROPA-MEDITERRÁNEO": "Europa",       # en tasks.md con el conteo real
    "ASIA-PACÍFICO": "Asia-Oceanía",
    "OCEANÍA": "Asia-Oceanía",
    "MEDIO ORIENTE-ASIA CENTRAL": "Asia-Oceanía",
}

async def build_thematic_wall(region_cities: list[dict], wall_name: str) -> dict:
    """Reutiliza pack_groups_into_columns() de wall_service.py."""
    ...

async def main(smoke_test: bool = False) -> None:
    pool = await asyncpg.create_pool(settings.timescaledb_dsn)
    service = WallService(pool)
    # ... agrupar, armar layout, service.create(user_id, name, layout) por región
```

## Testing Strategy

| Layer | What to Test | Approach |
|-------|--------------|----------|
| Unit | `LIVE_CANDIDATES_GEOFON_BY_CITY` tiene la misma forma que `LIVE_CANDIDATES_BY_CITY` (`Dict[str, List[str]]`, cada valor una lista no vacía de SEED IDs con 4 componentes) | Test de forma, mismo patrón que ya valida el catálogo existente (si existe) o nuevo test paramétrico simple |
| Unit | `channels_from_catalog(LIVE_CANDIDATES_GEOFON_BY_CITY)` produce tuplas `(net, sta, cha)` válidas, sin duplicados cruzados con `DEFAULT_CHANNELS` (colisión teórica de SEED ID entre servidores) | pytest, comparar `set(DEFAULT_CHANNELS) & set(DEFAULT_CHANNELS_GEOFON)` es vacío |
| Unit | `watchdog._main()`: `expected_channels` incluye canales de AMBOS catálogos tras el cambio (regresión: que no se pierda `DEFAULT_CHANNELS` original al sumar GEOFON) | pytest, mock de settings + imports, verificar longitud y contenido de la lista combinada |
| Unit | `seed_thematic_walls.build_thematic_wall()`: el layout resultante respeta `MAX_WALL_CHANNELS=120` / `MAX_WALL_COLUMNS=8` para el conteo real de estaciones por región del catálogo final | pytest, invocar `validate_wall_layout()` (ya existe en `wall_service.py`) sobre el layout generado — si falla, la región debe desglosarse en 2 walls antes de mergear |
| Unit | `SeedLinkIngestor` instanciado con `server="geofon.gfz-potsdam.de"` no requiere cambios de la clase (ya cubierto por los tests existentes de `SeedLinkIngestor` con `server` custom, si existen — si no, agregar un test mínimo de construcción) | pytest, verificar `ingestor.server == "geofon.gfz-potsdam.de"` |
| Integration | `check_seedlink()` con `expected_channels` que mezcla canales de ambos catálogos, algunos activos y otros mudos | Reutiliza el patrón de test ya existente para `check_seedlink` (mock de `fetch_active_channels`), sin cambios de la función misma |
| Manual (no automatizable) | Prueba de humo real en producción: 20-30 estaciones nuevas cargadas, observar logs de `seedlink` (sin gaps/reconexiones nuevas) y comportamiento del navegador con el wall de prueba abierto | Ver Success Criteria del proposal — la ejecuta el usuario, no es automatizable por diseño (mide degradación de un servicio de terceros sin SLA) |
| Manual (no automatizable) | Apagar `seedlink-geofon` en Railway y confirmar que `seedlink` (rtserve) sigue sirviendo sin interrupción | Verificación directa de aislamiento de fallos, ver Success Criteria del proposal |

## Migration / Rollout

No hay migración de base de datos: los walls temáticos usan la tabla `walls` existente (misma que `WallService` ya maneja), y las columnas de espectrograma siguen escribiéndose en `spectrogram_columns` sin cambio de esquema (el `channel` de GEOFON es un SEED ID más, indistinguible por diseño de uno de rtserve — ver riesgo de colisión del proposal, mitigado por convención FDSN).

Rollout en dos fases, siguiendo la decisión de "prueba de humo primero":

**Fase 1 — Prueba de humo:**
1. Mergear el código: `LIVE_CANDIDATES_GEOFON_BY_CITY` con solo las estaciones YA confirmadas (mínimo `MN.TRI`), un subconjunto de 20-30 ciudades nuevas agregadas a `LIVE_CANDIDATES_BY_CITY` (mezcla de servidores), `seedlink_ingestor_geofon.py`, `Dockerfile.seedlink-geofon`, cambio en `watchdog.py`.
2. En Railway: crear el servicio `seedlink-geofon` nuevo (`RAILWAY_DOCKERFILE_PATH=deploy/docker/Dockerfile.seedlink-geofon`, variables `REDIS_URL`/`TIMESCALEDB_*` compartidas del proyecto). Redeploy del servicio `watchdog` existente (para que tome el `expected_channels` combinado) y del servicio `seedlink` existente (para que tome el catálogo ampliado).
3. Ejecutar `scripts/seed_thematic_walls.py --smoke-test` una vez, manualmente, contra la base de producción — crea el wall de prueba.
4. Observar: logs de `seedlink` (sin reconexiones/gaps nuevos en los 74 canales previos), el wall de prueba abierto en el navegador (framerate, caídas de WebSocket), logs de `seedlink-geofon` (ingiriendo `MN.TRI` u otras confirmadas).
5. Si algo degrada: revertir el commit del subconjunto agregado a `LIVE_CANDIDATES_BY_CITY` (el catálogo de rtserve vuelve a 74 canales); el proceso `seedlink-geofon` puede quedar corriendo o apagarse independientemente, sin afectar la decisión sobre rtserve.

**Fase 2 — Catálogo completo (solo si la Fase 1 no muestra degradación):**
1. Mergear el resto del catálogo confirmado (ambos dicts completos).
2. Redeploy de `seedlink` y `seedlink-geofon` con el catálogo final.
3. Ejecutar `scripts/seed_thematic_walls.py` (sin `--smoke-test`) — crea/actualiza los walls temáticos definitivos por región.
4. Verificar los Success Criteria restantes del proposal (watchdog sin falsos "mudos", aislamiento de fallos confirmado apagando `seedlink-geofon`).

**Rollback** (por fase, ya cubierto en el Rollback Plan del proposal): revertir el commit de catálogo correspondiente; apagar `seedlink-geofon` en Railway no requiere ningún paso adicional de código.

## Open Questions

- [ ] El desglose de "América" en un único wall vs. 2-3 walls (Norteamérica/Centroamérica/Sudamérica) depende del conteo REAL de estaciones tras la fase de verificación pendiente (Argentina, Chile, México por zona, etc. — ver Dependencies del proposal). `MAX_WALL_CHANNELS=120` puede o no alcanzar para toda América en un solo wall; se resuelve en `tasks.md` con el catálogo final ya verificado, no bloquea el diseño (el script `seed_thematic_walls.py` ya soporta múltiples walls por continente si hace falta desglosar).
- [ ] Si al continuar la verificación de estaciones "(cualquiera)" aparece una SEGUNDA estación fuera de `rtserve`/GEOFON (un tercer servidor SeedLink), este diseño no lo cubre — la Decision de "dict separado por servidor" escala a un tercer dict (`LIVE_CANDIDATES_<SERVIDOR>_BY_CITY`) y un tercer proceso Railway, mismo patrón, pero el proposal solo confirmó 2 servidores (Dependencies, Approach §1). Ninguna estación identificada hasta ahora en el cuaderno lo requiere.
