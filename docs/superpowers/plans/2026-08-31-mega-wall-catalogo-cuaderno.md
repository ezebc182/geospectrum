# Mega Wall de ~60 estaciones — Catálogo fuente (transcripción del cuaderno)

Transcripción literal del cuaderno del usuario (fotos compartidas 2026-08-30 y
2026-08-31), con las ambigüedades ya resueltas en conversación. Este documento
es la ÚNICA fuente de verdad del alcance — no inventar estaciones que no
figuren acá.

## Criterios generales (confirmados en conversación)

- **`(cualquiera)`** y **entradas sin especificar** (Ecuador, Colombia,
  Venezuela, Nicaragua, Costa Rica, Guatemala, Afganistán, Pakistán,
  Filipinas, Sumatra, Java, Nueva Zelanda, Samoa): buscar CUALQUIER estación
  con canal SeedLink real y datos vivos disponibles ahora, sin catálogo
  específico en mente.
- **Europa incompleta a propósito**: solo Portugal/España/Francia/Italia/
  Grecia/Islandia entran en esta ronda. El resto de Europa queda reservado
  para un listado futuro — no completar de más.
- **Corrección "BELLA BC"**: tachado bajo Washington en la página 1,
  descartado. La entrada válida es **Mount Bella (Columbia Británica)**,
  bajo Canadá.
- **Yellowstone**: NO cargar las 46 estaciones al mega wall — pero SÍ
  investigarlas y tener el listado disponible por si se agregan más
  adelante. Cargar solo las 4 principales (Old Faithful + 2-3 más).
- **Verificación de disponibilidad**: armar el catálogo completo tal cual
  está escrito primero; filtrar/marcar las que no tengan datos vivos en una
  segunda pasada (no investigar estación por estación antes de armar nada).

## América

| País | Estaciones/zonas |
|---|---|
| Argentina | Salta (+o-), San Juan, Mendoza, Ushuaia |
| Chile | Zona N (Antofagasta), Zona M (Valparaíso/Santiago), Zona S (Bio Bio/Los Lagos) |
| Perú | Lima / algunos buenos (sin especificar cuáles) |
| Ecuador | *(cualquiera con datos vivos)* |
| Colombia | *(cualquiera con datos vivos)* |
| Venezuela | *(cualquiera con datos vivos)* |
| Puerto Rico | Zona N, Zona S |
| Nicaragua | *(cualquiera con datos vivos)* |
| Costa Rica | *(cualquiera con datos vivos)* |
| Guatemala | *(cualquiera con datos vivos)* |
| México | Zona N (Golfo California), México DF, Zonas (Oaxaca / Chiapas) |

### USA

| Región | Estaciones |
|---|---|
| California (de S a N) | Capetown (California), Mount Shasta, Long Valley, Salton |
| Oregon | *(sin especificar)* |
| Washington (el Estado, no DC) | Mount Rainier, Volcán St. Helens, Volcán 3 Sisters (1 solo) — "las 3 est. principales" |
| ~~Bella BC~~ | tachado — ver Mount Bella bajo Canadá |
| Texas | *(sin especificar)* |
| Yellowstone | Al menos las 4 principales (Old Faithful + 2-3 más si se encuentran). **NO cargar las 46 al wall, pero SÍ investigarlas y tenerlas listadas** para agregar más adelante si se quiere |
| Alaska | Anchorage + volcanes: Redoubt, Shishaldin, Okmok, Gareloi |
| Hawaii | Mauna Loa, Kilauea |

### Canadá

| Estación |
|---|
| Mount Bella (Columbia Británica) |

## Europa (incompleta a propósito)

| País | Estaciones |
|---|---|
| — (islas) | Isla Santa Elena, Islas Azores, Islas Canarias |
| Portugal | Lisboa |
| España | *(cualquiera)* — "ahora está Granada en la mira" |
| Francia | *(cualquiera)* |
| Italia | *(cualquiera)* — podría ser 1 continental + 1 en Sicilia, o más cerca del Vesubio (Nápoles) y del Etna (Sicilia) |
| Grecia | *(cualquiera)* en el continente + Islas de Dodecaneso |
| Islandia | *(cualquiera)* |

**Nota literal del cuaderno**: "los demás países europeos no calientan. Si
hay algo, más adelante tendremos 1 listado reservado p/ agregar en el
momento."

## Medio Oriente / Asia Central

| País | Estaciones |
|---|---|
| Turquía | (No hay acceso a muchos) Lo ideal: Estambul, Gaziantep |
| UAE | `II.UOSS` (Univ. of Sharjah) — ver investigación por bounding box abajo |
| Afganistán | `GE.KBU` (Kabul) — ver investigación GEOFON abajo |
| Pakistán | *(cualquiera con datos vivos)* |

## Asia

| País | Estaciones |
|---|---|
| Nepal | (Hay o había 1 en el Everest) |
| India | (1 sola) |
| China | (No oficial, tiene el USGS) |
| Japón | Zona N, Tokio, Zonas S |
| Rusia | Kamchatka |

## Asia y Oceanía

| País | Estaciones |
|---|---|
| Filipinas | *(cualquiera con datos vivos)* |
| Sumatra | *(cualquiera con datos vivos)* |
| Java | *(cualquiera con datos vivos)* |
| Indonesia | *(sin especificar — separado de Sumatra/Java)* |
| Nueva Zelanda | *(cualquiera con datos vivos)* |
| Samoa | *(cualquiera con datos vivos)* |
| Australia | N y S |

## África

Agregado el 2026-08-31 (fuera de las fotos originales del cuaderno, pedido
explícito posterior del usuario).

| País | Estaciones |
|---|---|
| Marruecos | `WM.AVE` (Averroes) — ver investigación abajo |
| Sudán | *(sin servidor SeedLink público conocido)* |
| Somalia | *(sin servidor SeedLink público conocido)* |
| Madagascar | *(cualquiera con datos vivos)* |
| Afganistán | `GE.KBU` (Kabul) — ver investigación abajo |

## Decisiones de arquitectura (2026-08-31, post-exploración)

- **Sistema**: el mega wall usa el `WallManager`/`wall_service.py` EXISTENTE,
  no una vista nueva.
- **Varios walls por región/continente**, NO un solo wall gigante — respeta
  el guardrail existente `MAX_WALL_CHANNELS = 120` (puesto a propósito en
  PR-W2, no un olvido) sin tener que reabrirlo. Por ejemplo: wall
  "América", wall "Europa", wall "Asia-Oceanía", etc.
- **Prueba de humo primero**: antes de cargar las 60-90 estaciones del
  cuaderno completo, cargar un subconjunto chico (20-30) y medir de
  verdad si `rtserve.earthscope.org` (una sola conexión TCP bloqueante en
  `seedlink_ingestor.py`, sirve TODO el catálogo — si se satura, cae la
  ingesta completa, no solo las nuevas) y los WebSockets del navegador
  (una conexión por tira, nunca probado con 90+ simultáneas) aguantan el
  volumen antes de comprometerse a todo.
- **Investigación de estaciones "(cualquiera)"**: la hace el asistente,
  consultando el catálogo real de `rtserve.earthscope.org` (mismo método
  usado para diagnosticar MAJO/GUMO/SNZO el 2026-08-31 — protocolo SeedLink
  crudo `INFO STREAMS` por socket), antes de armar la prueba de humo.
  Países pendientes de esta investigación: Ecuador, Colombia, Venezuela,
  Nicaragua, Costa Rica, Guatemala, España, Francia, Italia, Grecia,
  Islandia, UAE, Afganistán, Pakistán, Filipinas, Sumatra, Java, Nueva
  Zelanda, Samoa.

## Riesgos identificados en la exploración (sdd-explore, 2026-08-31)

- `rtserve.earthscope.org` es un servicio de terceros sin SLA — un límite
  de conexiones/ancho de banda ahí puede tumbar los 74 canales YA en
  producción si se satura con 90 más, porque todo corre en UN SOLO
  cliente SeedLink (`seedlink_ingestor.py`).
- 90+ WebSockets simultáneos por navegador no está probado ni en tests
  unitarios ni en QA visual conocido.
- `MAX_WALL_CHANNELS = 120` y `MAX_WALL_COLUMNS = 8`
  (`src/services/wall_service.py`) son guardrails deliberados — la
  decisión de "varios walls" los respeta sin subirlos.

## Investigación de estaciones "(cualquiera)" contra rtserve.earthscope.org

Consultado el 2026-08-31 vía `INFO STREAMS` (protocolo SeedLink crudo por
socket), catálogo completo descargado (3665 estaciones), filtrado por red
FDSN conocida por país y verificado canal vertical con `end_time` reciente
(~04:46 UTC, datos prácticamente en vivo al momento de la consulta).

### Confirmadas (10 de 19)

| País | Estación propuesta | Canal | Verificado |
|---|---|---|---|
| España | `WM.CART` (Cartagena) | BHZ | Sí, dato reciente |
| Francia | `G.SSB` (Saint-Sauveur-en-Rue) | BHZ | Sí, dato reciente |
| Grecia | `HL.ITM` (continental) | HHZ | Sí, canal disponible |
| Islandia | `II.BORG` | BHZ | Sí, dato reciente |
| Ecuador | `OV.VPCC` | HHZ | Sí, dato reciente (ya en catálogo actual como candidata de Quito) |
| Colombia | `CM.RUS` | HHZ | Sí, dato reciente |
| Nicaragua | `NU.MASN` (Masaya) | EHZ | Sí, dato reciente |
| Costa Rica | `TC.TCS1` | HHZ | Sí, dato reciente |
| Filipinas | `PS.PATS` | BNZ | Sí, dato reciente |
| Indonesia (Sumatra) | `GE.SUMG` | BHZ | Sí, dato reciente |
| Nueva Zelanda | `NZ.BFZ` | HHZ | Sí, dato reciente (ya en catálogo actual) |
| Samoa | `IU.AFI` (Afiamalu) | BHZ | Sí, dato reciente |
| Pakistán | `II.NIL` (Nilore) | BHZ | Sí, canal disponible |
| Madagascar | `II.ABPO` (Ambohimpanompo) | BHZ | Sí, dato reciente (agregado 2026-08-31, pedido posterior a la investigación original) |

### NO disponibles en rtserve.earthscope.org (requieren otro servidor FDSN)

| País/zona | Qué se buscó | Resultado |
|---|---|---|
| Italia continental (Vesubio/Nápoles, Etna/Sicilia) | Redes `IV` (INGV, la red oficial italiana) y `MN` (MedNet) | `IV` no tiene NINGUNA estación en este servidor; `MN` solo tiene `MN.WDD` (Malta, no Italia) |
| UAE | Sin red FDSN conocida a priori, búsqueda por redes candidatas | Nada encontrado |
| Afganistán | Red `AF` (nombre engañoso: es Antarctic/Australian, no Afganistán) | Nada real encontrado |
| Java (Indonesia, específico) | Redes `IA`, `MY` | `MY` sí existe pero son estaciones de Malasia, no Java específicamente — pendiente de revisar más |
| Venezuela | Red `VE` | 0 estaciones en el catálogo de este servidor |
| Guatemala | Redes `GU`, `GI` | 0 estaciones en el catálogo de este servidor |
| Marruecos | Redes `MJ`, `MA` | 0 estaciones en el catálogo de rtserve.earthscope.org (SÍ está en GEOFON, ver más abajo) |
| Sudán | Sin red FDSN conocida a priori | Nada encontrado (agregado 2026-08-31) |
| Somalia | Sin red FDSN conocida a priori | Nada encontrado (agregado 2026-08-31) |
| Afganistán | Red `AF` (nombre engañoso: es Antarctic/Australian) | Nada en rtserve.earthscope.org (SÍ está en GEOFON, ver más abajo) |

### Segundo servidor investigado: GEOFON (geofon.gfz-potsdam.de:18000)

`rtserve.iris.washington.edu` es el MISMO servidor que `rtserve.earthscope.org`
(mismo banner "EarthScope Ring Server" — alias histórico, no cuenta como
alternativa real). `eida.ingv.it` no respondió en el puerto SeedLink
estándar (timeout). `geofon.gfz-potsdam.de` SÍ es un servidor SeedLink real
y distinto (GEOFON, GFZ Potsdam, Alemania), confirmado con `HELLO` y
catálogo `INFO STREAMS` descargado (270 estaciones).

| País/zona | Resuelto en GEOFON | Estación | Canal | Nota |
|---|---|---|---|---|
| Italia continental | Sí | `MN.TRI` (Trieste) | HHZ | Dato MUY reciente (12:12 UTC); NO cerca del Vesubio como pedía la nota original, pero es Italia continental real |
| Italia — Sicilia/Etna | No | — | — | Ninguna estación de red `MN`/`IV` en GEOFON está en Sicilia |
| UAE | No | — | — | Sin resultado en GEOFON tampoco |
| Afganistán | **Sí (corregido, ver reverificación 2026-08-31 más abajo)** | `GE.KBU` | BHZ | — |
| Java (específico) | No | — | — | Red `GE` (68 estaciones) tiene cobertura de Indonesia en general, sin confirmar cuál es específicamente Java vs. otra isla — pendiente de revisión estación por estación si se retoma |
| Venezuela | No revisado en GEOFON todavía | — | — | — |
| Guatemala | No revisado en GEOFON todavía | — | — | — |
| Marruecos | **Sí (corregido, ver reverificación 2026-08-31 más abajo)** | `WM.AVE` | BHZ | `WM.TIO` también existe pero desfasada; `WM.IFR` no existe |
| Sudán | No | — | — | Confirmado también en la reverificación (391 estaciones, ninguna en Sudán) |
| Somalia | No | — | — | Confirmado también en la reverificación (391 estaciones, ninguna en Somalia) |

### Reverificación de GEOFON (2026-08-31, segunda vuelta — corrige la tabla de arriba)

La primera pasada por GEOFON (arriba) usó un dump de 270 estaciones bajo
protocolo `SeedLink v3`. El usuario trajo una respuesta de web search
afirmando que `geofon.gfz.de:18000` sirve `GE.KBU` (Kabul, Afganistán) y
`WM.AVE`/`WM.IFR`/`WM.TIO` (Marruecos) — dato que contradecía directamente
lo ya documentado ("Sin resultado en GEOFON tampoco"). Se decidió NO confiar
en la web search a ciegas y reverificar contra el servidor real con
`INFO STREAMS` crudo por socket.

**Resultado**: el servidor ahora responde `SeedLink v4.0 [HMB SeedLink v0.2
(2026.110)] :: SLPROTO:4.0` (protocolo distinto al de la primera pasada) y
devuelve un catálogo de **391 estaciones**, sensiblemente mayor al de la vez
anterior — el catálogo de GEOFON se amplió entre una consulta y otra, o la
primera pasada tuvo cobertura incompleta por el protocolo v3.

| Candidata (web search) | Verificación real | Resultado |
|---|---|---|
| `GE.KBU` (Kabul, Afganistán) | Existe, canal `BHZ`, `end_time` ~15:09 UTC (dato en vivo al momento de la consulta) | **Confirmada** |
| `WM.AVE` (Averroes, Marruecos) | Existe, canal `BHZ`, `end_time` ~15:09 UTC (dato en vivo) | **Confirmada** |
| `WM.TIO` (Tiouine, Marruecos) | Existe, pero `end_time` más reciente de todos sus canales es `2026/08/28` — 3 días de atraso al momento de la consulta | **Existe pero inestable** — no tratar como fuente de dato vivo sin re-chequear antes de cargarla |
| `WM.IFR` (Ifrane, Marruecos) | Ninguna estación con ese código en las 391 del catálogo | **No existe — la web search la inventó/confundió** |

**Lección**: una respuesta de web search puede tener aciertos reales (KBU y
AVE lo eran) mezclados con datos inventados (IFR) en la misma lista — no se
puede aceptar ni rechazar en bloque, hay que verificar entrada por entrada
contra la fuente primaria. Mismo criterio aplicado a un segundo mensaje
recibido en paralelo (aportado como "Mamá") con nombres de redes FDSN
(`MA`, `DH`, `EG`) que no coinciden con ningún código visto en las
verificaciones reales — descartado sin uso por falta de verificación.

**Tercer servidor probado, sin éxito**: `rtserve.resif.fr:18000` (RESIF, Francia) no respondió (timeout de conexión). `auspass.edu.au` sí respondió (SeedLink v3.3, ANU) pero es un servidor australiano, geográficamente no candidato para redes africanas — no se investigó su catálogo completo.

**Pista sin confirmar para Afganistán**: `seismology.az` (Centro Republicano
de Servicio Sismológico de Azerbaiyán, AMEA) — sugerido por el usuario por
cercanía geográfica a Afganistán. Verificado: el sitio responde HTTP 200 en
`https://seismology.az/az` (portal institucional en azerí), pero NO responde
en el puerto SeedLink estándar (18000, timeout). No se encontró evidencia de
un servidor SeedLink público expuesto — puede que solo sea un sitio web
informativo, o que use otro puerto/protocolo (FDSN Web Services) no
verificado en esta sesión. **El usuario va a buscar por su cuenta con un
prompt de búsqueda web armado en la conversación** (Azerbaiyán/red EIDA/
otro nodo FDSN para Afganistán, Marruecos, Sudán, Somalia) — pendiente de
retomar en la próxima sesión con el hostname/puerto concreto que encuentre.

### Decisión de arquitectura: RESUELTA por /sdd-explore (2026-08-31)

**Recomendación confirmada**: proceso Railway separado, reusando
`SeedLinkIngestor` tal cual (ya acepta `server: str` en el constructor,
sin tocar la clase). Mismo molde que `watchdog.py` (Dockerfile propio,
`CMD` distinto, cero cambio al proceso de `rtserve.earthscope.org` que
sirve los 74 canales actuales en producción). Se descartó la alternativa
de threads dentro de la misma clase por el riesgo directo de tocar código
de producción activo sin necesidad — el aislamiento de fallos (un servidor
caído no tumba al otro) sale gratis con procesos separados del SO, en vez
de tener que reimplementarlo a mano.

**Pendiente antes de `/sdd-propose`**: cómo modelar "qué candidata
pertenece a qué servidor" en `LIVE_CANDIDATES_BY_CITY` — dict separado
(`LIVE_CANDIDATES_GEOFON_BY_CITY`) vs. anotar el servidor dentro del dict
existente. Decisión chica pero determina la forma exacta del diff en
`spectrogram_service.py`/`channels_from_catalog()`.

**Riesgos a llevar al proposal**:
- `watchdog.py` externo (`check_seedlink`) necesita sumar los canales del
  proceso GEOFON a `expected_channels`, o va a reportar falsos "mudos"
  sobre estaciones que nunca estuvieron en su catálogo — cambio de una
  línea, fácil de olvidar si no se documenta junto al cambio principal.
- Colisión teórica de `channel` (PK de `spectrogram_columns`) si dos
  servidores sirvieran el mismo código FDSN — improbable (códigos de red
  son globalmente únicos por convención) pero el esquema no lo garantiza.
- Un proceso más = una conexión más a Redis y TimescaleDB (volumen bajo,
  pocos canales de GEOFON comparado con los 74 actuales).

## Búsqueda por bounding box geográfico contra FDSN Station Web Service (2026-08-31)

El usuario preguntó cómo resuelve esto "la gente real" (ej. SWARM) — la
respuesta es que ningún cliente SeedLink/SWARM tiene un listado propio de
"endpoints por país": el usuario configura manualmente un `Data Source`
apuntando a un host:puerto. Para DESCUBRIR qué host sirve una estación en
una zona dada, el método real es consultar el **FDSN Station Web Service**
(`service.iris.edu/fdsnws/station/1/query`) filtrando por **bounding box
geográfico** (`minlatitude`/`maxlatitude`/`minlongitude`/`maxlongitude`),
en vez de adivinar códigos de red de 1-2 letras — que es lo que veníamos
haciendo hasta ahora y lo que nos había hecho fallar con UAE y Afganistán
en la primera pasada.

**Importante — el bounding box trae ruido, hay que filtrarlo con criterio**:
la consulta devuelve TODAS las estaciones (activas y dadas de baja hace
décadas) dentro del rectángulo, sin filtrar por país real — un rectángulo
generoso para "Sudán" trae estaciones de Etiopía si el rectángulo se solapa
con la frontera, y lo mismo pasó con "Somalia" trayendo Yibuti. Verificar
lat/lon de cada resultado contra el país real, no confiar en que "cae
dentro del bounding box" = "está en el país".

### Resultados de esta ronda

| País | Resultado | Servidor con dato en vivo |
|---|---|---|
| **UAE** | `II.UOSS` (Univ. of Sharjah) — CONFIRMADA, canal `BHZ`, dato vivo (~15:25 UTC) | `rtserve.iris.washington.edu:18000` (mismo servidor ya usado para el resto del catálogo, red `II` = Global Seismographic Network) |
| **Java** | `GE.SMRI` (Semarang) y `GE.JAGI` (Jajag) existen en metadata FDSN Y en el catálogo actual de GEOFON, pero con `end_time` desfasado 3 días (`2026/08/28`) — no hay candidata con dato vivo hoy. `GE.CISI`, `GE.UGM`, `GE.YOGI` no aparecen en el catálogo GEOFON actual pese a estar en el metadata histórico | Ninguno con dato vivo confirmado hoy |
| **Sudán** | Sin resultado real — los "hits" del bounding box (`AF.AAUS`, `IU.FURI`) tienen lat/lon en Etiopía, no en Sudán | — |
| **Somalia** | Sin resultado real — el único "hit" (`G.ATD`) tiene lat/lon en Yibuti, no en Somalia | — |

**Conclusión sobre Sudán/Somalia**: confirmado con evidencia geográfica
dura (no solo "no encontramos el código de red correcto") que no hay
ninguna estación FDSN pública dentro de esos dos países. Coincide con lo
que reportó el mensaje "Mamá" en la sesión (GRAS en Sudán y el Ministerio
somalí no exponen feed público) y con el propio manual conceptual: si no
hay estación instalada transmitiendo a un data center público, no hay
ningún endpoint que "SWARM" ni nadie pueda usar — no es una limitación de
nuestra búsqueda.

**Pendiente**: Venezuela y Guatemala devolvieron 273 y 236 filas
respectivamente en el bounding box (mucho ruido de países vecinos —
Colombia/Aruba/Grenada para Venezuela, redes de Santa María/Fuego para
Guatemala que sí parecen genuinas) — falta filtrar por lat/lon real y
verificar canal en vivo, no se completó esta ronda.

## Tercera verificación (2026-08-31 ~16:58 UTC) — cierra el catálogo de arranque

Reverificación directa por socket contra los tres hostnames, con medición de
`end_time` real (no solo "está en el catálogo") para separar estación viva de
estación presente-pero-muerta.

### Alias confirmados: son DOS servidores, no tres

| Hostname | Banner `HELLO` | Estaciones en `INFO STREAMS` |
|---|---|---|
| `rtserve.earthscope.org` | `SeedLink v4.0 (RingServer/4.5.6)` — EarthScope Ring Server | 4074 |
| `rtserve.iris.washington.edu` | idéntico | 4088 |
| `geofon.gfz-potsdam.de` | `SeedLink v4.0 [HMB SeedLink v0.2]` — GEOFON | 382 |
| `geofon.gfz.de` | idéntico a `gfz-potsdam.de` | (mismo) |

Los dos `rtserve.*` son **el mismo RingServer de EarthScope** (la diferencia de
4074 vs. 4088 es el catálogo moviéndose entre dos consultas separadas por
minutos, no dos catálogos distintos). Los dos `geofon.*` también son alias.
**El diseño de dos procesos (rtserve + GEOFON) es correcto: no hace falta un
tercero.**

### Frescura medida, estación por estación

| Estación | Servidor | Canal | `end_time` | Atraso | Veredicto |
|---|---|---|---|---|---|
| `II.UOSS` (UAE) | **rtserve.earthscope.org** | `00.BHZ` | `2026-08-31T16:58:15Z` | 0 min | **VIVA** |
| `GE.KBU` (Afganistán) | geofon | `BHZ` | `2026/08/31 16:58:11` | 0,1 min | **VIVA** |
| `WM.AVE` (Marruecos) | geofon | `BHZ`, `HHZ`, `HLZ` | `2026/08/31 16:58:13-16` | 0 min | **VIVA** (3 canales) |
| `MN.TRI` (Trieste) | geofon | `HHZ` | `2026/08/31 16:58:09` | 0,1 min | **VIVA** |
| `WM.TIO` (Marruecos) | geofon | `BHZ`/`HHZ` | `2026/08/28` | **3,3 días** | Confirmada MUERTA — no cargar |

### Corrección al catálogo: UAE NO necesita servidor nuevo

`II.UOSS` está **PRESENTE en `rtserve.earthscope.org`** (verificado por
pertenencia al set de 4074 estaciones y por `end_time` vivo). La nota de la
línea 321 que la atribuye a `rtserve.iris.washington.edu` como si fuera otro
servidor es engañosa: es el mismo. **UAE entra al catálogo de rtserve
existente (`LIVE_CANDIDATES_BY_CITY`), sin proceso nuevo.**

Contrapartida verificada: `GE.KBU` y `WM.AVE` están **AUSENTES** de los 4074
de rtserve, y `II.UOSS` está **AUSENTE** de las 382 de GEOFON. Los catálogos
son disjuntos donde importa — el particionado por servidor tiene base real,
no es una suposición.

### Gotchas de parseo confirmados (los dos servidores difieren)

1. **Formato de fecha distinto por servidor**: GEOFON emite
   `end_time="2026/08/31 16:58:11.7450"` (barras + espacio); rtserve emite
   ISO-8601 `end_time="2026-08-31T16:58:15.444538Z"`. Un parser escrito
   contra uno **falla en silencio** contra el otro (devuelve "sin canal
   vertical", que se lee como "estación muerta" sin serlo).
2. **Paquetes `SLINFO` binarios inyectados en medio del XML**: ambos
   servidores parten atributos por la mitad
   (`seednam` + basura binaria + `e="BHZ"`). Un regex que exija
   `<station ...>...</station>` bien formado no matchea nunca. Hay que
   trocear por lookahead al siguiente `<station name=` y parsear cada
   `<stream .../>` como unidad independiente.
3. **Una estación puede reportar el mismo canal dos veces** con `end_time`
   distinto (`WM.AVE.BHZ` aparece a las 13:04 y a las 16:58). Quedarse con
   la primera coincidencia da un falso "desfasada" — hay que tomar el
   máximo.

## Relevamiento COMPLETO de las 76 zonas (2026-08-31, cerrado)

Informe publicado: https://claude.ai/code/artifact/69022860-f32b-45c2-a8a0-214686586863

**61 de 76 zonas aseguradas** (dato vivo < 30 min), 8 con reserva, 7 sin
cobertura pública. Método, scripts y las cuatro trampas de parseo quedaron
documentados en `scripts/station_survey/` (reusable: re-medir cuesta dos
consultas y unos minutos).

### El hallazgo que cambia el problema

Se midió dos veces con **veinte minutos** de diferencia y el catálogo ya era
otro: `II.BORG` (Islandia) e `IN.MNC` (India) desaparecieron por completo
—cero ocurrencias en el dump crudo, no es fallo de parseo— y las dos eran la
única estación de su zona. En sentido inverso, `IU.MAJO`, `IU.GUMO` e
`IU.SNZO` volvieron con 2 min de atraso: las tres que se cayeron en agosto y
motivaron el fix de cuarentena (12721f2), lo que confirma que el
`RELEASE_EVERY` cada 12 reconexiones era la decisión correcta.

**Consecuencia**: el problema no es armar una buena lista, es que el sistema
rote a la siguiente candidata cuando una desaparece. `LIVE_CANDIDATES_BY_CITY`
ya mapea ciudad → lista ordenada por preferencia, así que la estructura lo
soporta — hay que cargar las candidatas de respaldo, no solo la titular.

### Fragilidad: 24 zonas cuelgan de UNA sola estación

De esas 24, **15 tienen respaldo** dentro de 600 km (las mejores: Long Valley
a 48 km, Mount Shasta a 51 km, Lisboa a 163 km, Tokio a 165 km con `IU.MAJO`).
**9 no tienen ninguna**: UAE, Islandia, India, Perú (Lima y otras), Filipinas,
Kamchatka, Canarias y Santa Elena. Las dos últimas son islas oceánicas — no
hay alternativa técnica, se cargan sabiendo que son frágiles.

### Correcciones a lo documentado más arriba en este mismo archivo

- **Venezuela NO está sin servidor**: `IU.SDV` (Santo Domingo) está viva. La
  búsqueda previa falló por mirar la red `VE` (0 estaciones) en vez de buscar
  por geografía. Mismo error que había ocultado UAE.
- **Turquía/Estambul resuelto**: `2Q.BUAD` (Büyükada) en GEOFON, red del
  GFZ/AFAD. No estaba en ninguna lista previa.
- **Argentina/Salta resuelto**: `GE.SALTA`, estación conjunta GEOFON/INPRES.
- **Java y Sumatra no están muertas, están cortadas**: las 9 estaciones `GE`
  de Indonesia tienen EXACTAMENTE 3,54 días de atraso — el mismo número. Es el
  feed de BMKG hacia GEOFON cortado en un punto, no 9 equipos fallando. Si se
  restablece entran las 9 juntas. Volver a medir antes de descartarlas.
- **Guatemala confirmado sin cobertura**: lo más cercano son estaciones de El
  Salvador (red `SV`), a ~150 km.

## Pendiente de resolver

- Confirmar lectura de las páginas restantes (si hay más allá de lo ya
  fotografiado).
- Relación con [[spectronet-wall-serie-progreso]] (W1/W2 mergeados, W3/W4 sin
  arrancar) — verificar si el mega wall se apoya en esa serie.
- Investigar servidores FDSN alternativos para Italia continental, Java (sin
  candidata con dato vivo), Venezuela, Guatemala (ver tabla arriba) — EN
  CURSO. Afganistán, Marruecos y UAE ya RESUELTOS: `GE.KBU` y `WM.AVE` en
  GEOFON; **`II.UOSS` en `rtserve.earthscope.org`** — el servidor que YA
  usamos, no uno nuevo (ver tercera verificación arriba: `rtserve.iris.
  washington.edu` es un alias del mismo RingServer). Sudán y Somalia
  CONFIRMADOS sin servidor público — no reabrir sin un dato nuevo concreto.
- ~~Explorar el cambio de arquitectura de multi-servidor SeedLink~~ **HECHO**:
  el change completo (proposal + design + specs + tasks) vive en
  `openspec/changes/mega-wall-estaciones-cuaderno/`. Decisión: segundo proceso
  Railway con `SeedLinkIngestor(bus, server="geofon.gfz-potsdam.de")`, dict
  paralelo `LIVE_CANDIDATES_GEOFON_BY_CITY`, watchdog concatenando ambos
  catálogos. Ninguna tarea ejecutada todavía (Fase 0 en adelante sin arrancar).
- **Propuesta del usuario (2026-08-31)**: agregar una funcionalidad de
  búsqueda de estaciones por bounding box geográfico. `/sdd-explore`
  corrido — resultado y decisiones en
  [[busqueda-por-bounding-box-destraba-uae]] y
  [[bounding-box-search-decisiones-alcance]]. **BLOQUEADA** hasta resolver
  el multi-servidor SeedLink (decisión explícita del usuario: "esperar a
  resolver multi-servidor primero", no acotar al servidor actual). Alcance
  ya decidido: herramienta INTERNA para el equipo, no feature de usuario
  final — reduce mucho el trabajo de filtrado/UI cuando se retome.

## Verificación completa (Fase 1 de mega-wall-estaciones-cuaderno)

**Medido el 2026-09-01 14:10 UTC** contra `rtserve.earthscope.org:18000` y
`geofon.gfz-potsdam.de:18000` (`INFO STREAMS` crudo por socket) + los dos
metadatas FDSN de EarthScope y GEOFON. Herramienta: `scripts/station_survey/`.

**Sanity check del parser previo a leer un solo resultado: 5/5.** `II.UOSS`
3,7 min · `GE.KBU` 2,1 min · `WM.AVE` 2,0 min · `MN.TRI` 2,1 min (las cuatro
vivas) y `WM.TIO` 5705 min = 3,96 días (muerta, esperada muerta). Sin este
control no hay forma de distinguir un falso negativo del parser de una caída
real — ya pasó una vez, casi se publica "Emiratos se cayó" como conclusión.

Umbral de "viva": `end_time` a menos de 30 min. Los ceros se re-verificaron a
60 min y a 24 h antes de darlos por ausencia real.

**Resultado: 63 de 76 zonas con estación viva, 13 en cero.**

| País | Zona | SEED ID | Servidor | Canal | Atraso | Veredicto |
|---|---|---|---|---|---|---|
| Argentina | Salta | `GE.SALTA` | geofon | HHZ | 3.4 min | Confirmada. **UNICA candidata** |
| Argentina | San Juan | `WA.ZON` | rtserve | HHZ | 4.9 min | Confirmada. **UNICA candidata** |
| Argentina | Mendoza | `C1.MT08` | rtserve | HHZ | 4.9 min | Confirmada. 4 candidatas |
| Argentina | Ushuaia / Tierra del Fuego | `C1.MG01` | rtserve | BHZ | 4.9 min | Confirmada. **UNICA candidata** |
| Chile | Zona N (Antofagasta) | `CX.PB02` | geofon | HHZ | 3.4 min | Confirmada. 17 candidatas |
| Chile | Zona M (Valparaiso/Santiago) | `C1.BO04` | rtserve | HHZ | 4.9 min | Confirmada. 24 candidatas |
| Chile | Zona S (Bio Bio/Los Lagos) | `C1.BI05` | rtserve | HHZ | 4.9 min | Confirmada. 13 candidatas |
| Peru | Lima | `II.NNA` | rtserve | BHZ | 5.2 min | Confirmada. **UNICA candidata** |
| Peru | otras | `II.NNA` | rtserve | BHZ | 5.2 min | Confirmada. **UNICA candidata** |
| Ecuador | (cualquiera) | `EC.PULU` | rtserve | HHZ | 4.9 min | Confirmada. 8 candidatas |
| Colombia | (cualquiera) | `CM.ARGC` | rtserve | HLZ | 4.9 min | Confirmada. 7 candidatas |
| Venezuela | (cualquiera) | `IU.SDV` | rtserve | BHZ | 4.9 min | Confirmada. **UNICA candidata** |
| Puerto Rico | Zona N | `PR.CG01` | rtserve | HNZ | 5.0 min | Confirmada. 14 candidatas |
| Puerto Rico | Zona S | `PR.BRR1` | rtserve | HNZ | 5.0 min | Confirmada. 15 candidatas |
| Nicaragua | (cualquiera) | `GE.BOAB` | geofon | HHZ | 3.4 min | Confirmada. 8 candidatas |
| Costa Rica | (cualquiera) | `TC.QUEP` | rtserve | EHZ | 4.9 min | Confirmada. 11 candidatas |
| Guatemala | (cualquiera) | — | — | — | — | SIN COBERTURA confirmada: los 7 hits del box son red SV (El Salvador), lat 13,7-14,4 / lon -89,2 a -89,8 |
| Mexico | Zona N (Golfo California) | `MX.SRIG` | rtserve | BHZ | 5.0 min | FALSO NEGATIVO del filtro: Santa Rosalia (27.32,-112.24), Baja California Sur. El sitio no dice "Mexico" |
| Mexico | Mexico DF | `G.UNM` | rtserve | HNZ | 4.9 min | Confirmada. **UNICA candidata** |
| Mexico | Oaxaca | — | — | — | — | SIN ESTACION VIVA. Confirmado a 24 h. |
| Mexico | Chiapas | `MX.CCIG` | rtserve | BHZ | 5.5 min | Confirmada. **UNICA candidata** |
| USA CA | Capetown (Cape Mendocino) | `PB.B045` | rtserve | EHZ | 5.1 min | Confirmada. 3 candidatas |
| USA CA | Mount Shasta | `PB.B039` | rtserve | EHZ | 5.0 min | Confirmada. **UNICA candidata** |
| USA CA | Long Valley | `CI.MLAC` | rtserve | HNZ | 4.9 min | Confirmada. **UNICA candidata** |
| USA CA | Salton | `CI.BC3` | rtserve | HHZ | 4.9 min | Confirmada. 13 candidatas |
| USA | Oregon | `UO.SLPT` | rtserve | ENZ | 4.9 min | Confirmada. 197 candidatas |
| USA WA | Mount Rainier | `UW.STAR` | rtserve | HNZ | 4.9 min | Confirmada. 34 candidatas |
| USA WA | Volcan St. Helens | `PB.B201` | rtserve | EHZ | 4.9 min | Confirmada. 21 candidatas |
| USA | Volcan 3 Sisters | `CC.PRLK` | rtserve | HHZ | 5.0 min | Confirmada. 5 candidatas |
| USA | Texas | `TX.PH02` | rtserve | HNZ | 4.9 min | Confirmada. 24 candidatas |
| USA | Yellowstone | `US.LKWY` | rtserve | HHZ | 5.0 min | Confirmada. 38 candidatas |
| USA AK | Anchorage | `AK.ER02` | rtserve | HNZ | 4.9 min | Confirmada. 16 candidatas |
| USA AK | Volcan Redoubt | `AV.RDJH` | rtserve | BHZ | 5.1 min | Confirmada. 8 candidatas |
| USA AK | Volcan Shishaldin | `AV.SSLN` | rtserve | BHZ | 5.0 min | Confirmada. 5 candidatas |
| USA AK | Volcan Okmok | `AV.OKCF` | rtserve | BHZ | 5.0 min | Confirmada. 9 candidatas |
| USA AK | Volcan Gareloi | `AV.GALA` | rtserve | BHZ | 5.2 min | Confirmada. 4 candidatas |
| USA HI | Mauna Loa | `PT.KHU` | rtserve | HHZ | 4.9 min | Confirmada. 15 candidatas |
| USA HI | Kilauea | `HV.DEVL` | rtserve | HNZ | 5.0 min | Confirmada. 25 candidatas |
| Canada | Mount Bella (BC) | `CN.BBB` | rtserve | HHZ | 4.9 min | Confirmada. 2 candidatas |
| Islas | Santa Elena | `II.SHEL` | rtserve | BHZ | 5.1 min | Confirmada. **UNICA candidata** |
| Islas | Azores | `PM.ROSA` | rtserve | BHZ | 5.3 min | Confirmada. 2 candidatas |
| Islas | Canarias | `IU.MACI` | rtserve | BHZ | 5.0 min | Confirmada. **UNICA candidata** |
| Portugal | Lisboa | `PM.PESTR` | rtserve | HHZ | 4.9 min | Confirmada. 2 candidatas |
| Espana | (cualquiera) | `WM.CART` | geofon | BLZ | 3.4 min | Confirmada. 6 candidatas |
| Espana | Granada | — | — | — | — | SIN ESTACION VIVA. Confirmado a 24 h. |
| Francia | (cualquiera) | `G.SSB` | rtserve | HNZ | 4.9 min | Confirmada. 2 candidatas |
| Italia | continental | `MN.TUE` | geofon | BHZ | 3.4 min | Confirmada. 5 candidatas |
| Italia | Vesubio/Napoles | — | — | — | — | SIN ESTACION VIVA. Confirmado a 24 h. |
| Italia | Etna/Sicilia | — | — | — | — | SIN ESTACION VIVA. Confirmado a 24 h. |
| Grecia | continental | `GE.APE` | geofon | HHZ | 3.5 min | Confirmada. 5 candidatas |
| Grecia | Dodecaneso | `GE.KARP` | geofon | BHZ | 4.0 min | Confirmada. 2 candidatas |
| Islandia | (cualquiera) | — | — | — | — | II.BORG desaparecio del catalogo otra vez (cero ocurrencias). Confirmado a 24 h |
| Turquia | Estambul | `2Q.BUAD` | geofon | HNZ | 3.4 min | Confirmada. **UNICA candidata** |
| Turquia | Gaziantep | — | — | — | — | SIN ESTACION VIVA. Confirmado a 24 h. |
| UAE | II.UOSS (Sharjah) | `II.UOSS` | rtserve | BHZ | 5.1 min | Confirmada. **UNICA candidata** |
| Afganistan | Kabul | `GE.KBU` | geofon | SHZ | 3.6 min | Confirmada. **UNICA candidata** |
| Pakistan | (cualquiera) | `II.NIL` | rtserve | BHZ | 5.2 min | Confirmada. **UNICA candidata** |
| Nepal | Everest | `IO.EVN` | geofon | HHZ | 3.6 min | Confirmada. **UNICA candidata** |
| India | (1 sola) | `IN.MNC` | rtserve | HHZ | 5.0 min | Confirmada. **UNICA candidata** |
| China | (no oficial) | `IC.BJT` | rtserve | HHZ | 34.7 min | VIVA pero con 34,7 min de atraso (fuera del umbral de 30 min). Tambien IC.MDJ / IC.QIZ / IC.HIA |
| Japon | Zona N | `JP.JMM` | rtserve | BHZ | 4.9 min | Confirmada. 6 candidatas |
| Japon | Tokio | — | — | — | — | CERO REAL: cero a 30 min, 60 min y 24 h, con y sin filtro. Perdio su unica estacion |
| Japon | Zona S | `JP.JMZ` | rtserve | BHZ | 5.0 min | Confirmada. 5 candidatas |
| Rusia | Kamchatka | `IU.MA2` | rtserve | BHZ | 5.1 min | Confirmada. **UNICA candidata** |
| Filipinas | (cualquiera) | `IU.DAV` | rtserve | LHZ | 8.3 min | Confirmada. **UNICA candidata** |
| Indonesia | Sumatra | `GE.PMBI` | geofon | BHZ | 3.6 min | Confirmada. **UNICA candidata** |
| Indonesia | Java | — | — | — | — | EXISTE SIN DATO: GE.BBJI/JAGI/SMRI/UGM en catalogo, las 4 con 6314 min (4,38 d). Feed BMKG cortado |
| Indonesia | otras | `GE.SOEI` | geofon | HHZ | 3.5 min | Confirmada. 3 candidatas |
| Nueva Zelanda | (cualquiera) | `NZ.BKZ` | rtserve | HNZ | 4.9 min | Confirmada. 9 candidatas |
| Samoa | (cualquiera) | `IU.AFI` | rtserve | BHZ | 5.0 min | Confirmada. **UNICA candidata** |
| Australia | Norte | `AU.BMEBF` | rtserve | HHZ | 4.9 min | Confirmada. 91 candidatas |
| Australia | Sur | `AU.ARPS` | rtserve | BNZ | 4.9 min | Confirmada. 134 candidatas |
| Marruecos | WM.AVE (Averroes) | `WM.AVE` | geofon | BHZ | 3.5 min | Confirmada. **UNICA candidata** |
| Sudan | (sin servidor conocido) | — | — | — | — | SIN ESTACION VIVA. Confirmado a 24 h. |
| Somalia | (sin servidor conocido) | — | — | — | — | SIN ESTACION VIVA. Confirmado a 24 h. |
| Madagascar | (cualquiera) | `GE.VOI` | geofon | SHZ | 3.4 min | Confirmada. 3 candidatas |
### Cierre de la Fase 1 — zonas sin dato vivo (tarea 1.6)

Las 13 zonas en cero **no son todas el mismo caso**. Mezclarlas sería el error:
una cosa es "no existe estación pública" y otra muy distinta "existe y hoy no
publica". Solo la primera categoría es definitiva.

**A. Sin servidor SeedLink público conocido (definitivo, no reabrir sin dato nuevo)**

| Zona | Evidencia |
|---|---|
| Sudán | Box 8,7–22,2 / 21,8–38,6 vacío. Los "hits" previos caían en Etiopía |
| Somalia | Box −1,7–12,0 / 40,9–51,4 vacío. Los "hits" previos caían en Yibuti |
| Guatemala | 7 estaciones en el box, **todas red `SV`** (El Salvador), a ~150 km |
| España / Granada | Cero a 24 h. España sí tiene cobertura vía `WM.CART` |
| Italia / Vesubio-Nápoles | Cero a 24 h. Italia continental cubierta por `MN.TUE` |
| Italia / Etna-Sicilia | Cero a 24 h. **Re-verificado**: sigue sin resultado, como en la medición previa |
| Turquía / Gaziantep | Cero a 24 h. Turquía cubierta vía `2Q.BUAD` (Estambul) |
| México / Oaxaca | Cero a 24 h, con y sin filtro por país |

**B. Estación existente sin dato vivo (transitorio — volver a medir, NO descartar)**

| Zona | Evidencia |
|---|---|
| Indonesia / Java | `GE.BBJI`, `GE.JAGI`, `GE.SMRI`, `GE.UGM` en catálogo, las **cuatro con 6314 min exactos** (4,38 d). Es el feed BMKG cortado en un punto, no cuatro equipos fallando: toda la red `GE` de Indonesia comparte el número. Excepciones vivas: `GE.PMBI` (Sumatra) y `GE.SOEI` (Timor). Ayer eran 3,54 d — sumó exactamente un día, el feed sigue congelado |
| Islandia | `II.BORG` **desapareció del catálogo otra vez** (cero ocurrencias literales). Ya había desaparecido y vuelto en 20 min el 2026-08-31. Rotación, no baja |
| Japón / Tokio | Cero a 30 min, 60 min y 24 h, con y sin filtro. Perdió su única estación. Japón N (`JP.JMM`) y S (`JP.JMZ`) siguen vivas |

**C. Reclasificadas — el filtro automático mentía**

| Zona | Corrección |
|---|---|
| México / Zona N | **TIENE cobertura**: `MX.SRIG` (Santa Rosalía, Baja California Sur, 27,32/−112,24) viva a 5,0 min. El filtro `["mexico"]` la descartó porque el SiteName dice "SANTA ROSALIA". Es el falso negativo que el README de `station_survey` predijo textualmente |
| China | **TIENE cobertura**: red `IC` viva — `IC.BJT` (Beijing), `IC.MDJ`, `IC.QIZ`, `IC.HIA` — pero a **34,7 min**, fuera del umbral de 30 min. No es ausencia, es retardo. Responde la pregunta abierta del cuaderno ("no oficial, tiene el USGS"): sí hay vía redes internacionales |

**D. Fragilidad — el riesgo real del catálogo**

**23 de las 63 zonas cubiertas cuelgan de UNA sola candidata.** Entre ellas
Salta, San Juan, Ushuaia, Lima, Venezuela, México DF, México/Chiapas,
Marruecos, UAE, Afganistán, Pakistán, Nepal, India, Kamchatka, Samoa,
Filipinas, Canarias, Santa Elena. Si esa estación rota fuera del catálogo —
como acaba de pasar con `II.BORG` y con Tokio — la zona cae entera. Este es
el argumento por el que `LIVE_CANDIDATES_BY_CITY` debe cargar **listas
ordenadas de candidatas por zona**, no una estación por zona.

**Advertencia de vigencia**: este relevamiento es una foto. Medido con 20 min
de diferencia el 2026-08-31, `II.BORG` e `IN.MNC` desaparecieron y `IU.MAJO`,
`IU.GUMO`, `IU.SNZO` volvieron. Re-medir antes de cargar el catálogo definitivo.
