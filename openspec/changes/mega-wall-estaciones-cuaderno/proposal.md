# Proposal: Mega Wall de Estaciones del Cuaderno

## Intent

El dashboard hoy expone 27 ciudades / 74 canales en vivo (`LIVE_CANDIDATES_BY_CITY`, `src/services/spectrogram_service.py:88-128`), todos servidos por una única conexión SeedLink bloqueante a `rtserve.earthscope.org` (`src/services/seedlink_ingestor.py`). El usuario armó en su cuaderno un catálogo mucho más amplio (~60-90 estaciones potenciales, América/Europa/Medio Oriente/Asia/Oceanía) para poder mirar la actividad sísmica global de un vistazo, agrupada en muros temáticos por región — no una lista de ciudades sueltas.

Ese catálogo no puede simplemente "cargarse": el ingestor actual sirve TODO el streaming en vivo hoy en producción desde un solo cliente TCP, y ni ese cliente ni los WebSockets del navegador (uno por tira del wall) se probaron nunca con un volumen 2-3x mayor. Este change existe para incorporar el catálogo confirmado del cuaderno de forma medida — con una prueba de humo antes de comprometerse al volumen completo — y para resolver la necesidad de un segundo servidor SeedLink (GEOFON) para las estaciones que `rtserve.earthscope.org` no sirve, sin arriesgar la ingesta que ya funciona.

## Scope

### In Scope

- Catálogo ampliado en `LIVE_CANDIDATES_BY_CITY` (o estructura equivalente) con las estaciones del cuaderno **confirmadas con datos vivos** contra `rtserve.earthscope.org` y `geofon.gfz-potsdam.de`, agrupadas por país/región según la transcripción en `docs/superpowers/plans/2026-08-31-mega-wall-catalogo-cuaderno.md`.
- Varios walls temáticos nuevos creados con el `WallManager`/`wall_service.py` EXISTENTE (ej. "América", "Europa", "Asia-Oceanía"), cada uno respetando `MAX_WALL_CHANNELS = 120` (`src/services/wall_service.py:89`) y `MAX_WALL_COLUMNS = 8` (`src/services/wall_service.py:88`) sin modificar esos guardrails.
- Segundo proceso Railway de ingesta SeedLink contra `geofon.gfz-potsdam.de:18000`, reusando `SeedLinkIngestor` tal cual — el parámetro `server: str` ya existe en el constructor (`src/services/seedlink_ingestor.py:88`) — con Dockerfile y `CMD` propios, mismo molde que `watchdog.py`/`Dockerfile.watchdog`.
- Prueba de humo: cargar primero un subconjunto chico (20-30 estaciones nuevas, mezcla de ambos servidores) y medir en producción si `rtserve.earthscope.org` y los WebSockets del navegador aguantan el volumen antes de cargar el catálogo completo.
- Actualizar `expected_channels` del watchdog (`src/services/watchdog.py:514`, hoy derivado de `DEFAULT_CHANNELS` de un solo catálogo) para que incluya también los canales servidos por el proceso GEOFON nuevo.
- Las 4 estaciones principales de Yellowstone (Old Faithful + 2-3 más) cargadas al wall de USA; el resto del listado completo de Yellowstone (46 estaciones) queda documentado pero NO cargado.

### Out of Scope

- **5 países sin servidor SeedLink público conocido tras la investigación**: UAE, Afganistán, Java (específico, distinto de Indonesia/Sumatra), Venezuela, Guatemala. Quedan documentados como pendientes futuros — no bloquean este change.
- Resto de Europa más allá de Portugal/España/Francia/Italia/Grecia/Islandia — reservado a propósito para un listado futuro, según nota literal del cuaderno.
- Las 46 estaciones completas de Yellowstone — solo las 4 principales entran a esta ronda.
- Decidir la forma exacta de modelar "qué candidata pertenece a qué servidor" (dict separado `LIVE_CANDIDATES_GEOFON_BY_CITY` vs. anotar el servidor en el dict existente) — es una decisión de `design.md`, no de esta propuesta.
- Subir `MAX_WALL_CHANNELS` o `MAX_WALL_COLUMNS` — la estrategia de "varios walls" existe precisamente para no tocar esos guardrails.
- Cualquier UI nueva de selección/gestión de walls más allá de lo que `WallManager` ya ofrece.
- Reintentos o balanceo de carga entre servidores SeedLink — cada servidor sirve su propio subconjunto fijo de estaciones, sin failover cruzado entre `rtserve` y GEOFON.

## Approach

1. **Catálogo primero, verificación en paralelo**: el catálogo completo del cuaderno ya está transcripto en `docs/superpowers/plans/2026-08-31-mega-wall-catalogo-cuaderno.md`, con 12 de 19 países "(cualquiera)" ya confirmados contra `rtserve.earthscope.org` (10 estaciones) y `geofon.gfz-potsdam.de` (Italia continental vía `MN.TRI`). Las estaciones con zona/ciudad específica del cuaderno (Argentina, Chile, México, USA por región, Canadá, Japón, Rusia, Australia, etc.) se verifican con el mismo protocolo `INFO STREAMS` antes de sumarse al catálogo de código.

2. **Segundo servidor SeedLink como proceso Railway aislado**: se descartó extender `SeedLinkIngestor` con threads internos para manejar 2 servidores en la misma clase — el riesgo de tocar código de producción activo (74 canales hoy) sin necesidad no se justifica cuando el aislamiento de fallos sale gratis con un proceso del SO separado. Se instancia una segunda `SeedLinkIngestor(bus, server="geofon.gfz-potsdam.de")` en su propio `__main__`, calcado del patrón ya usado por `watchdog.py` (Dockerfile propio, `RAILWAY_DOCKERFILE_PATH` distinto, cero cambios al proceso de `rtserve.earthscope.org`).

3. **Varios walls, no un wall gigante**: `WallManager`/`wall_service.py` ya soporta múltiples walls con columnas/grupos; se crean walls temáticos por continente/región usando la API existente, cada uno dentro de `MAX_WALL_CHANNELS = 120`. Esto también mitiga el riesgo de WebSockets: el usuario abre un wall por vez (≤120 tiras), no 90+ simultáneas de una sola vista.

4. **Prueba de humo antes del catálogo completo**: se carga un subconjunto de 20-30 estaciones nuevas (mezcla de ambos servidores) a un wall de prueba, se mide en producción — no en local — si el cliente único de `rtserve.earthscope.org` sigue sirviendo los 74 canales actuales sin degradación y si el navegador sostiene las conexiones WebSocket nuevas. Solo tras confirmar esto se carga el resto del catálogo confirmado.

5. **Watchdog actualizado, no rediseñado**: `check_seedlink` (`src/services/watchdog.py:108-133`) ya recibe `expected_channels` como parámetro externo — el cambio es sumar los canales del proceso GEOFON a la lista que arma `watchdog.py:514`, sin tocar la lógica de comparación de canales activos.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/services/spectrogram_service.py` (`LIVE_CANDIDATES_BY_CITY`) | Modified | Catálogo ampliado con las estaciones confirmadas del cuaderno; forma exacta (dict separado por servidor vs. anotación inline) a decidir en `design.md` |
| `src/services/seedlink_ingestor.py` | Read-only (reused) | `SeedLinkIngestor` se instancia una segunda vez con `server="geofon.gfz-potsdam.de"` en un `__main__` nuevo; la clase NO se modifica — el parámetro `server` ya existe (línea 88) |
| `src/services/seedlink_ingestor_geofon.py` (o `__main__` alternativo) | New | Punto de entrada del segundo proceso de ingesta, calcado del `__main__` de `seedlink_ingestor.py:488-561` con `server="geofon.gfz-potsdam.de"` y su propio catálogo de canales |
| `deploy/docker/Dockerfile.seedlink-geofon` | New | Dockerfile del proceso nuevo en Railway, mismo molde que `Dockerfile.watchdog` / `Dockerfile.seedlink` |
| `src/services/watchdog.py` | Modified | `expected_channels` (línea 514) debe sumar los canales del catálogo GEOFON, o reporta falsos "mudos" sobre canales que nunca estuvieron en su `DEFAULT_CHANNELS` original |
| `src/services/wall_service.py` | Read-only (reused) | `WallManager` se usa tal cual para crear los walls temáticos nuevos; `MAX_WALL_CHANNELS`/`MAX_WALL_COLUMNS` no se modifican |
| Railway (infraestructura) | New | Servicio nuevo `seedlink-geofon` con `RAILWAY_DOCKERFILE_PATH` propio, misma conexión a Redis/TimescaleDB que el ingestor actual, sin puerto expuesto |
| `dashboard/` (walls existentes) | Read-only | Los walls temáticos nuevos se crean con la UI/API de walls ya existente; no se anticipan cambios de componentes React para este change |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| `rtserve.earthscope.org` se satura con el volumen nuevo y tumba los 74 canales YA en producción, porque `seedlink_ingestor.py` es una única conexión TCP bloqueante que sirve todo el catálogo actual | Med | Prueba de humo con 20-30 estaciones antes del catálogo completo; el proceso GEOFON es un servicio Railway separado, así que aunque `rtserve` se sature, no arrastra al segundo servidor consigo |
| 90+ WebSockets simultáneos por navegador (uno por tira del wall) nunca se probaron y podrían degradar el navegador del usuario o el servidor de WebSocket del API | Med | Estrategia de "varios walls" limita la exposición real a ≤120 tiras por wall abierto a la vez, no 90+ de una sola vista; se valida en la misma prueba de humo |
| El watchdog reporta falsos "mudos" sobre estaciones GEOFON si `expected_channels` (`watchdog.py:514`) no se actualiza junto con el catálogo nuevo | Med | Cambio explícito documentado en Affected Areas; se verifica en `design.md`/`tasks.md` como paso obligatorio, no opcional, del mismo change |
| Colisión teórica de `channel` (PK de `spectrogram_columns`) si ambos servidores sirvieran el mismo código FDSN de red.estación.canal | Low | Códigos de red FDSN son globalmente únicos por convención (asignados por la FDSN); se valida en `design.md` si el esquema necesita un discriminador por servidor o si la convención basta |
| Estaciones "(cualquiera)" sin verificar todavía (más allá de las 12/19 ya confirmadas) resultan no tener datos vivos al momento de cargar el catálogo completo | Low | Criterio ya establecido en el cuaderno: armar el catálogo completo tal cual está escrito primero, filtrar/marcar las que no tengan datos vivos en una segunda pasada — no bloquea el resto del catálogo confirmado |
| Un proceso Railway más (GEOFON) suma una conexión adicional a Redis y TimescaleDB, con costo/huella extra 24/7 | Low | Volumen de canales de GEOFON es bajo comparado con los 74 actuales; mismo patrón de costo ya aceptado para `watchdog.py`, verificar consumo real post-deploy |

## Rollback Plan

El catálogo nuevo es **aditivo**: agregar entradas a `LIVE_CANDIDATES_BY_CITY` (o su estructura equivalente por servidor) no modifica ni elimina las 27 ciudades / 74 canales actuales — revertir el commit que agrega las entradas nuevas restaura el catálogo actual sin tocar nada más.

El segundo servidor GEOFON es un **proceso Railway completamente aislado**:
1. Apagar el servicio `seedlink-geofon` en Railway no afecta al servicio `seedlink` (rtserve) existente — son procesos del SO independientes, sin dependencia cruzada en tiempo de ejecución.
2. Si el volumen nuevo degrada `rtserve.earthscope.org` durante la prueba de humo, se revierte el catálogo agregado a `LIVE_CANDIDATES_BY_CITY` sin necesidad de tocar el proceso GEOFON, que sirve un subconjunto disjunto de estaciones.
3. Revertir el cambio en `expected_channels` de `watchdog.py:514` junto con el catálogo si se revierte el catálogo — de lo contrario el watchdog reportaría "mudos" sobre canales que dejaron de existir.
4. No hay migraciones de base de datos: los walls nuevos usan las tablas existentes de `wall_service.py`; borrarlos vía la API/UI existente de walls basta para deshacer esa parte, sin necesidad de tocar el esquema.
5. Los guardrails `MAX_WALL_CHANNELS`/`MAX_WALL_COLUMNS` no se tocan en ningún punto de este change, así que no hay nada que revertir ahí.

## Dependencies

- Confirmación de disponibilidad de datos vivos para las estaciones del cuaderno con zona/ciudad específica (Argentina, Chile, Perú, México, USA por región, Canadá, Japón, Rusia/Kamchatka, Australia, etc.) — pendiente de verificar con el mismo protocolo `INFO STREAMS` usado para los 12/19 países "(cualquiera)" ya confirmados.
- `geofon.gfz-potsdam.de:18000` como servidor SeedLink real y accesible — confirmado el 2026-08-31 vía `HELLO` + `INFO STREAMS` (270 estaciones en catálogo), sin SLA formal conocido (mismo nivel de garantía que `rtserve.earthscope.org` hoy).
- Acceso de Railway para desplegar un servicio nuevo (`seedlink-geofon`) con su propio `RAILWAY_DOCKERFILE_PATH`, misma conexión a Redis y TimescaleDB que el ingestor actual.
- Resultado de la prueba de humo (20-30 estaciones) antes de comprometerse a cargar el catálogo completo — es una dependencia de secuencia dentro del propio change, no un bloqueo externo.

## Success Criteria

- [ ] La prueba de humo (20-30 estaciones nuevas cargadas a un wall de prueba) confirma que `rtserve.earthscope.org` sigue sirviendo los 74 canales actuales sin degradación medible (columnas de espectrograma sin gaps nuevos, sin reconexiones adicionales en los logs del ingestor) durante al menos una ventana de observación sostenida.
- [ ] La misma prueba de humo confirma que el navegador sostiene las conexiones WebSocket nuevas (un wall de hasta ~30 tiras) sin caídas de conexión ni degradación visible de framerate/actualización.
- [ ] El proceso `seedlink-geofon` ingiere datos en vivo de al menos las estaciones GEOFON confirmadas (Italia continental `MN.TRI` como mínimo) de forma independiente del proceso `rtserve` existente, verificable con columnas frescas en `spectrogram_columns`.
- [ ] Apagar el servicio `seedlink-geofon` en Railway no interrumpe ni degrada el streaming de los 74 canales servidos por `rtserve.earthscope.org` (verificación directa del aislamiento de fallos).
- [ ] `watchdog.py` no reporta falsos "mudos" sobre canales del catálogo GEOFON tras la actualización de `expected_channels` — verificable comparando el catálogo esperado contra los canales realmente configurados en ambos procesos.
- [ ] Al menos un wall temático por región (ej. "América") queda creado y funcional con `WallManager`, respetando `MAX_WALL_CHANNELS = 120` / `MAX_WALL_COLUMNS = 8` sin necesidad de modificar esas constantes.
- [ ] El catálogo final documenta explícitamente los 5 países sin servidor SeedLink conocido (UAE, Afganistán, Java específico, Venezuela, Guatemala) como pendientes fuera de scope, sin estaciones inventadas o aproximadas en su lugar.
