# Delta for Observability

Nota: el spec base de este dominio (`openspec/specs/observability/spec.md`)
todavía no existe en `openspec/specs/` porque el change que lo introdujo
(`watchdog-servicios-railway`) sigue activo y no fue archivado. Este delta se
escribe contra la versión más reciente conocida del comportamiento del
watchdog, definida en
`openspec/changes/watchdog-servicios-railway/specs/observability/spec.md`,
específicamente contra el Requirement "Chequeo de seedlink_ingestor por
canales mudos". Este delta MUST aplicarse después (o junto con) la
sincronización de ese spec a `openspec/specs/observability/`.

## MODIFIED Requirements

### Requirement: Chequeo de seedlink_ingestor por canales mudos

El watchdog MUST determinar el estado de `seedlink_ingestor` consultando
`TimescaleColumnWriter.fetch_active_channels(minutes)` contra
`spectrogram_columns`, usando un umbral de silencio configurable
(`watchdog_seedlink_stale_after_seconds`). El catálogo de canales activos
esperados contra el que se compara (`expected_channels`) MUST incluir tanto
los canales servidos por el proceso de ingesta `rtserve.earthscope.org`
existente como los canales servidos por el proceso de ingesta
`geofon.gfz-potsdam.de` nuevo, combinados en una única lista de comparación.
El componente `seedlink_ingestor` SHALL marcarse como `down` ÚNICAMENTE
cuando TODOS los canales de ese catálogo combinado están mudos por encima del
umbral. Un subconjunto de canales mudos, mientras al menos uno del catálogo
combinado siga activo dentro del umbral, MUST NOT disparar ninguna
notificación.

(Previamente: `expected_channels` se derivaba únicamente de `DEFAULT_CHANNELS`
del catálogo servido por `rtserve.earthscope.org`, sin considerar ningún otro
servidor de ingesta.)

#### Scenario: Todos los canales de ambos servidores mudos por encima del umbral

- GIVEN que el catálogo combinado de canales activos esperados incluye
  canales de `rtserve.earthscope.org` y de `geofon.gfz-potsdam.de`, y
  `fetch_active_channels(minutes)` devuelve una lista vacía para todos ellos
  (ningún canal de ninguno de los dos servidores actualizó
  `spectrogram_columns` dentro del umbral)
- WHEN corre el ciclo de chequeo del watchdog
- THEN el componente `seedlink_ingestor` se marca como `down`

#### Scenario: Canales GEOFON mudos con canales rtserve activos no alertan

- GIVEN que todos los canales servidos por `geofon.gfz-potsdam.de` están
  mudos por encima del umbral, pero los canales servidos por
  `rtserve.earthscope.org` siguen actualizando `spectrogram_columns` dentro
  del umbral
- WHEN corre el ciclo de chequeo del watchdog
- THEN el componente `seedlink_ingestor` se marca como `up`
- AND NO se genera ninguna notificación de caída total por los canales
  GEOFON mudos

#### Scenario: Canales rtserve mudos con canales GEOFON activos no alertan

- GIVEN que todos los canales servidos por `rtserve.earthscope.org` están
  mudos por encima del umbral, pero los canales servidos por
  `geofon.gfz-potsdam.de` siguen actualizando `spectrogram_columns` dentro del
  umbral
- WHEN corre el ciclo de chequeo del watchdog
- THEN el componente `seedlink_ingestor` se marca como `up`
- AND NO se genera ninguna notificación de caída total por los canales
  rtserve mudos

#### Scenario: Canal GEOFON nuevo no genera falso "mudo" por ausencia en el catálogo esperado

- GIVEN que un canal servido por el proceso `geofon.gfz-potsdam.de` está
  activo y actualizando `spectrogram_columns` con normalidad, y el catálogo
  `expected_channels` del watchdog fue actualizado para incluirlo
- WHEN corre el ciclo de chequeo del watchdog
- THEN ese canal se reconoce como parte del catálogo esperado y contribuye a
  marcar `seedlink_ingestor` como `up`
- AND el watchdog NO lo reporta como canal mudo inexistente en el catálogo

#### Scenario: Catálogo GEOFON ausente del catálogo esperado produce falsos mudos (regresión a evitar)

- GIVEN que el catálogo `expected_channels` del watchdog NO fue actualizado
  para incluir los canales del proceso `geofon.gfz-potsdam.de` nuevo, mientras
  ese proceso ya está en producción sirviendo canales reales
- WHEN se compara el catálogo esperado desactualizado contra los canales
  realmente configurados en ambos procesos de ingesta
- THEN se detecta una discrepancia entre el catálogo esperado y los canales
  reales servidos
- AND esta discrepancia MUST resolverse antes de considerar completo este
  change, dado que el watchdog reportaría "mudos" sobre canales que nunca
  estuvieron en su `expected_channels` original
</content>
