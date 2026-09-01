# Mutation log — mega-wall-estaciones-cuaderno

Mismo esquema que `watchdog-servicios-railway/mutation-log.md`.

Alcance de la mutación crítica: **solo `watchdog.py`** (Fase 3), que toca un
proceso YA en producción. El catálogo (Fase 2) y el script one-off de walls
(Fase 5) llevan tests de forma/contrato, por la convención fijada en
`tasks.md` — con una excepción deliberada: el test de la regla de 1 Hz
(`test_ningun_candidato_geofon_usa_canal_de_1hz`) SÍ se muta, porque codifica
una regla de dominio que un futuro editor del catálogo puede violar sin darse
cuenta, y un test verde que no puede fallar ahí no protegería nada.

## Baseline registrada

Corrida ANTES de tocar ningún archivo (tarea 0.1):

```
./venv/bin/python -m pytest tests/ -q
9 failed, 706 passed, 2 skipped, 8 warnings, 333 errors in 66.35s
```

**Los 333 errores NO son una regresión**: son tests de integración que levantan
un testcontainer y Docker Desktop está caído en esta máquina. Verificado
aislando un caso:

```
./venv/bin/python -m pytest "tests/unit/test_user_management.py::test_change_role_of_an_unknown_user_raises_not_found" -q --no-cov
E  docker.errors.DockerException: Error while fetching server API version:
   503 Server Error for http+docker://localhost/version: Service Unavailable
   ("Docker Desktop is unable to start")
```

Es la trampa ya documentada del entorno local (`tests-integracion-usan-testcontainer`).
Los 9 `failed` quedan pendientes de clasificar con Docker arriba — hasta
entonces **no se puede afirmar que este change no introdujo regresiones en la
suite completa**, solo en el subconjunto que corre sin Docker.

**Subconjunto verificable sin Docker** (el que sí sirve como control de este
change): `tests/unit/test_station_catalog.py` — 6 passed antes de tocar nada.

## Mutaciones

| # | archivo | mutación | salida del rg | test que se puso rojo | revertido |
|---|---------|----------|---------------|-----------------------|-----------|
| 1 | `src/services/spectrogram_service.py` | agregar `"GE.KBU..LHZ"` a las candidatas de `kabul` (canal de 1 Hz, vivo pero inservible) | `163: "kabul": ["GE.KBU..BHZ", "GE.KBU..SHZ", "GE.KBU..LHZ"],` | `test_ningun_candidato_geofon_usa_canal_de_1hz` → `1 failed, 8 passed` | sí (`9 passed`) |
| 2 | `src/services/watchdog.py` | quitar GEOFON de la concatenación de `build_expected_channels()` — el watchdog dejaría de vigilar el ingestor nuevo | `397: for net, sta, cha in DEFAULT_CHANNELS` | `test_incluye_los_canales_de_los_dos_ingestores` → `1 failed, 3 passed` | sí |
| 3 | `src/services/watchdog.py` | quitar **rtserve** de la concatenación, dejando solo GEOFON — la regresión peligrosa: apaga la vigilancia de los 74 canales YA en producción | `397: for net, sta, cha in DEFAULT_CHANNELS_GEOFON` | `test_incluye_los_canales_de_los_dos_ingestores` **y** `test_no_pierde_los_canales_de_rtserve_al_sumar_geofon` → `2 failed, 2 passed` | sí (`4 passed`) |

## Prueba de humo del catálogo GEOFON (verificación con datos vivos)

Los tests unitarios confirman que el código está bien, pero no que el catálogo
TRANSMITA. Se abrió un socket SeedLink real contra `geofon.gfz-potsdam.de:18000`
y se suscribió canal por canal (`STATION` / `SELECT` / `DATA`), sin mocks:

```
Servidor: geofon.gfz-potsdam.de:18000
  OK   MN.TRI.HHZ  520 bytes, secuencia 04AEDC
  OK   GE.KBU.BHZ  520 bytes, secuencia ADE5DB
  OK   GE.KBU.SHZ  520 bytes, secuencia ADE5E2
  OK   WM.AVE.HHZ  520 bytes, secuencia 2A9580
  OK   WM.AVE.BHZ  520 bytes, secuencia 2A9588

5/5 canales entregaron datos reales
```

520 bytes = 8 de cabecera SeedLink + 512 de miniSEED. Los números de secuencia
distintos de `GE.KBU.BHZ` y `GE.KBU.SHZ` confirman que **el respaldo por canal
son dos flujos independientes del servidor**, no el mismo dato repetido — que
es exactamente la premisa de la corrección de diseño de la Fase 2.

Nota de método: entre cada mutación y su reversión se corrió
`find . -path ./venv -prune -o -name "__pycache__" -type d -exec rm -rf {} +`.
Sin eso, mutar y revertir dentro del mismo segundo deja un `.pyc` del mismo
tamaño y timestamp, y pytest ejecuta el bytecode viejo — una mutación que
"no muta" no prueba nada.

---

## Fase 4/5 — `scripts/seed_thematic_walls.py` (2026-09-01)

La convención de este change dice que el script de seed NO lleva mutación
crítica. Se corrieron igual tres, y **dos de las tres encontraron un test que
no podía fallar** — que es exactamente el motivo por el que se corren.

### Mutación 1 (INVÁLIDA — no mutaba nada)

Cambiar el fallback `REGION_WALL_NAMES.get(region, REGION_WALL_NAMES["OTROS"])`
por un `continue` cuando la región no está mapeada.

**Resultado: 9/9 verdes.** Parecía un test que no detecta nada, pero la
mutación era el problema: **`"OTROS"` ESTÁ en `REGION_WALL_NAMES`**, así que
`.get(region)` devolvía un nombre válido y el `continue` nunca se ejecutaba.
Una mutación que no muta no prueba nada.

### Mutación 1b (válida) — DETECTADA

La misma, pero borrando además la entrada `"OTROS"` del dict, de modo que las
ciudades sin región se descarten de verdad.

**Resultado: 1 failed** —
`test_no_pierde_ninguna_ciudad_entre_todos_los_walls`. Correcto: las tres
ciudades GEOFON (`trieste`, `kabul`, `casablanca`) no están en `CITY_REGIONS`
(verificado, no supuesto), así que ejercen el camino "OTROS" obligatoriamente.

### Mutación 2 — NO detectada al principio, test agregado

`if total > MAX_WALL_CHANNELS:` → `> MAX_WALL_CHANNELS * 100`.

**Resultado inicial: 9/9 verdes.** El guard no estaba cubierto: el catálogo
real tiene 7 canales en su wall más grande y nunca se acerca a 120, así que
subir el límite no rompía nada. El fallo habría aparecido recién al insertar
en producción con el catálogo completo.

Se agregó `test_una_region_que_excede_el_limite_falla_al_armar_no_al_insertar`,
que fabrica un catálogo de `MAX_WALL_CHANNELS + 5` ciudades.
**Con el test nuevo: 1 failed.** Mutación detectada.

### Mutación 3 — DETECTADA

`candidates[0]` → `candidates[-1]` (usar el último candidato en vez del
primario).

**Resultado: 2 failed** — `test_incluye_una_tira_por_ciudad_de_ambos_catalogos`
y `test_no_pierde_ninguna_ciudad_entre_todos_los_walls`.

### Estado final

Revertido con `diff` contra el backup (sin diferencias), **10/10 verdes**,
`ruff check` limpio. Suite completa: 759 passed / 9 failed — los 9 son los
preexistentes de `test_ws_events.py` (`Event loop is closed`), verificados
antes y después.
