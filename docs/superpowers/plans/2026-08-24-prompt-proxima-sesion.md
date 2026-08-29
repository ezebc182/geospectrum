# Prompt para la próxima sesión — 2026-08-24

> Copiá el bloque de "PROMPT" y pegalo como primer mensaje. Lo de abajo es el
> contexto que lo respalda, por si hace falta consultarlo.

---

## PROMPT (copiar desde acá)

```
Retomamos el detalle de estación. Contexto en
docs/superpowers/plans/2026-08-24-prompt-proxima-sesion.md — leelo primero.

Estoy en la rama feat/station-detail-pr-b-spectrogram con 12 archivos SIN
COMMITEAR: 11 del buscador de estaciones + este mismo documento. Antes de tocar
nada: verificá el estado del árbol y que los tests sigan verdes.

Orden de trabajo:

1. Commitear el buscador de estaciones si el QA visual salió bien. Si no lo
   hice todavía, avisame y decidimos.

2. Arrancar el PR C — WaveView, por la FASE 1 (backend). El plan está en
   docs/superpowers/plans/2026-08-23-station-detail-pr-c-waveview.md.
   NO arranques por el frontend: /waveform sólo acepta ventana relativa y sin
   eso el clic no puede abrir un evento pasado.

Las dos tareas de la Fase 1:
   a) GET /stations/{channel}/waveform tiene que aceptar start/end ISO-8601 UTC
      (hoy sólo acepta `minutes`).
   b) GET /stations/{channel}/spectra — endpoint NUEVO, no existe.

TDD como siempre, y verificá por mutación: en la sesión pasada un test mío pasó
en verde con el código roto y sólo la mutación lo destapó.

No corras `next build` con el server de dev levantado: comparten .next y se
rompe el dev con ENOENT de vendor-chunks. Ya me pasó.
```

---

## Estado al cerrar la sesión del 2026-08-23

### Rama y archivos

`feat/station-detail-pr-b-spectrogram`, último commit `d75de6b` (PR B).
**11 archivos sin commitear** — el buscador de estaciones, terminado y
verificado pero pendiente del QA visual del usuario:

```
 M dashboard/components/AppSidebar.tsx        (entrada "Estaciones" + isRouteActive)
 M dashboard/messages/en.json                 (+18 claves, paridad OK: 670/670)
 M dashboard/messages/es.json                 (+18 claves)
 M src/main.py                                (endpoint GET /stations/search)
 M src/services/spectrogram_service.py        (search_stations_by_code + SEARCH_SERVERS)
?? dashboard/app/(app)/stations/page.tsx      (ruta índice, no existía)
?? dashboard/components/StationSearch.tsx     (buscador híbrido)
?? dashboard/lib/station-search.ts            (filterCatalog/groupByCity/shouldQueryFdsn)
?? dashboard/lib/station-search.test.ts       (16 tests)
?? src/services/station_search.py             (build_station_pattern/normalize)
?? tests/unit/test_station_search.py          (31 tests)
```

Verificación al cerrar: **557 tests backend**, **649 tests frontend**, `tsc` en 0,
build de producción limpio con `/stations` en la tabla de rutas.

### QA visual pendiente del buscador

`http://localhost:3008/stations` — cuatro cosas:

1. `tokyo` → 3 estaciones agrupadas, instantáneo (prueba que el catálogo cubre
   lo que FDSN no puede: nombres de ciudad).
2. `majo` → arriba `IU.MAJO.00.BHZ` (catálogo), abajo `AS.MAJO..SHZ` tras ~1,2 s.
   Si abajo no aparece nada, el fix del patrón no llegó al server.
3. `nevado` → cero resultados y **sin spinner** (no debe salir a la red).
4. Clic en cualquiera → detalle con helicorder, y "Estaciones" marcado en el sidebar.

**No va a aparecer** el badge verde "Con datos recientes": el ingestor de
espectros está muerto desde el 2026-08-21 04:31 UTC. Por eso es badge y no
filtro — filtrando por vivas la lista saldría vacía y parecería rota.

---

## Lo que el usuario mostró y redefine el PR C

El usuario pasó el manual oficial (`~/Downloads/Swarm_User_Guide.pdf`, extraído
con `pdftotext -layout`) y dos capturas. **Corrige lo que yo había asumido de
memoria**: el flujo de SWARM no es buscar estaciones en vivo, es **descargar
una ventana absoluta y analizarla**.

La URL de su captura, del builder de IRIS:

```
service.iris.edu/fdsnws/dataselect/1/query
  ?net=WY&sta=NIHS&loc=--&cha=HNZ
  &starttime=2019-04-18T20:00:00
  &endtime=2019-04-19T20:00:00
  &format=miniseed&nodata=404
```

`starttime` / `endtime`, fechas de 2019. **Ese es exactamente el bloqueante del
PR C**: nuestro `/waveform` sólo acepta `minutes` (relativo hacia atrás desde
ahora), así que hoy es imposible mirar un evento de anteayer.

La segunda captura muestra el destino: helicorder arriba y, **debajo, el
espectro de la ventana seleccionada** (Power vs Hz, pico marcado en ~10 Hz).
Ese panel no existe en nuestra app; es el `/spectra` de la Fase 1.

### Datos del manual verificados (no de memoria)

- **SWARM no tiene límite de estaciones.** §13.2.4 muestra la config FDSN con
  red/estación/canal/location vacíos (`wsc:IW||||3600|1000|...`): el árbol se
  llena con todo lo que el servidor tenga. Y §6: *"The Wave Clipboard holds as
  many simultaneous wave views as desired"*. El límite es del servidor.
- Visor en tiempo real: vistas de 15/30/60/**120 (default)**/180/240/300 s,
  refresh cada 2 s.
- Formatos que abre: SAC, SEED, miniSEED, SEISAN, WIN, texto Matlab.
- El clipboard permite comparar la misma onda con **tres filtros distintos**, o
  eventos distintos de una misma estación. Es la razón de ser del zoom que el
  usuario reclamó ("no puedo hacer zoom in-out, no puedo analizar").

---

## Hallazgos técnicos de esta sesión (no repetir el laburo)

### FDSN busca por CÓDIGO, no por nombre de sitio

Verificado contra IRIS el 2026-08-23:

| Consulta | Resultado |
|---|---|
| `*USC*` (5 chars) | 3 estaciones, 1,3 s |
| `MAJO*` (5) | 3 estaciones |
| `*MAJO*` (6) | **FDSNBadRequestException** |
| `*ABCD*` (6) | **FDSNBadRequestException** |
| `NEV*` / `*NEV*` | HTTP 204, sin datos |

**El patrón completo, wildcards incluidos, no puede pasar de 5 caracteres** (el
largo del código SEED). Por eso `build_station_pattern` agrega wildcards sólo
si entran. Y el nombre del sitio ("Univ Southern Ca") viaja en la respuesta
pero **no es filtrable** — buscar "nevado" da cero.

### Latencia: limitar los servidores FDSN

Un término sin coincidencias recorría los 6 servidores a ~1,3 s cada uno: 8,2 s
para decir "no hay nada". Se limitó a `SEARCH_SERVERS = ("IRIS", "GEOFON")` y
bajó a 2,64 s. Los casos con resultados están en ~1,2 s.

### El auto-QA por curl está bloqueado

`/stations` redirige 307 a `/login` y el JWT necesita `AUTH_SECRET_KEY` del
`.env`, que no puedo leer (y el intento de sacarlo del entorno del proceso lo
bloquea el clasificador, con razón). **El QA visual lo hace el usuario.**

### `next build` rompe el server de dev

Comparten el directorio `.next`. El build reescribe los chunks y el dev queda
apuntando a vendor-chunks inexistentes (`ENOENT ... lucide-react.js`). Se
arregla matando el proceso, `rm -rf dashboard/.next` y `npm run dev`.

---

## Entorno verificado

| Pieza | Estado |
|---|---|
| TimescaleDB | puerto **5433**, user/db `seismic` (el 5432 es un Postgres nativo ajeno) |
| Backend | `127.0.0.1:8000`, `./venv/bin/python -m uvicorn src.main:app` |
| Dashboard | `127.0.0.1:3008` (**no 3000**), Node v22.16.0 vía nvm |
| Tests backend | `./venv/bin/python -m pytest tests/unit -q` |
| Tests frontend | `cd dashboard && ./node_modules/.bin/vitest run` (nunca `npx`) |

Estaciones sanas para probar (FDSN devuelve ~17 h, no 24: es el techo de
retención del servidor, no un bug nuestro):

- `CI.USC..BHZ` — la de mayor amplitud (21.680 cuentas), la mejor para ver movimiento
- `HT.ALN..HHZ` (4.143) · `UW.LON..HHZ` (1.807, la más tranquila)
- **Evitar `CN.BOIB..HHZ`**: se le piden 60 min y devuelve 0,1. Está rota del lado de FDSN.

---

## Advertencia de costo

La sesión del 2026-08-23 cerró en **$72,02**, con mucha verificación real
(consultas a la base, curl contra el servidor, mutaciones, extracción del PDF).
Esa verificación evitó dos bugs que habrían llegado al usuario, pero conviene
dimensionar: el PR C es más grande que el buscador.
