# Delta for backend-api — Analíticas profesionales de señal

Delta sobre `openspec/specs/backend-api/spec.md`. Ese documento cubre la fusión
de fuentes sísmicas (`/report`, `/events`, `/alerts`) y NO toca los endpoints de
estación; por lo tanto todo lo de acá es **ADDED** o **MODIFIED** sobre el
comportamiento vigente de `src/main.py`.

## Convención de errores (aplica a TODOS los requirements de este delta)

Verificado contra el código de hoy: los endpoints de estación levantan
`HTTPException` desde el cuerpo del handler (`src/main.py:2597`), y FastAPI
serializa eso como `{"detail": "..."}`. La forma `{"error": "..."}` sólo la
producen los handlers de auth que devuelven `JSONResponse` explícitos
(`src/main.py:1114` y siguientes).

Por lo tanto: **todo 4xx de los endpoints especificados en este delta MUST tener
body `{"detail": "<mensaje>"}`**. Ningún endpoint de este delta MUST devolver
`{"error": ...}`.

---

## MODIFIED Requirements

### Requirement: Ventana absoluta en GET /stations/{channel}/waveform

`GET /stations/{channel}/waveform` MUST aceptar, además de la ventana relativa
`minutes`, una ventana ABSOLUTA expresada por los query params `start` y `end`
en ISO-8601 UTC.

(Previously: el endpoint SÓLO aceptaba `minutes: int = Query(1440, ge=1, le=1440)`,
una ventana relativa hacia atrás desde "ahora". No había forma de pedir un evento
de una fecha pasada.)

Reglas normativas:

1. `start` y `end` MUST usarse juntos: pedir uno sin el otro MUST ser rechazado.
2. `start`/`end` y `minutes` MUST ser mutuamente excluyentes: si el cliente envía
   `start` (o `end`) explícitamente junto con `minutes` explícito, la petición
   MUST ser rechazada.
3. `end` MUST ser estrictamente mayor que `start`.
4. La duración `end - start` MUST ser menor o igual a 24 horas (mismo techo que
   `minutes`, que ya está acotado a `le=1440`).
5. Cuando no se envía ni `start` ni `end`, el comportamiento MUST ser idéntico al
   actual (ventana relativa por `minutes`, default 1440). Este requisito es de
   retrocompatibilidad: ningún cliente existente cambia de comportamiento.
6. Todo rechazo de validación de ventana MUST devolver HTTP 422 con body
   `{"detail": "<mensaje que nombra el parámetro ofensor>"}`.
7. La validación de ventana MUST ejecutarse ANTES de cualquier fetch a FDSN: una
   ventana inválida no MUST producir tráfico de red saliente.

#### Scenario: Ventana absoluta válida devuelve la ventana pedida

- GIVEN el canal `AK.FIRE..BHZ` con datos disponibles en FDSN
- WHEN se hace `GET /stations/AK.FIRE..BHZ/waveform?start=2026-08-20T10:00:00Z&end=2026-08-20T11:00:00Z`
- THEN la respuesta HTTP es 200
- AND el rango temporal cubierto por la respuesta está contenido en `[start, end]`
- AND el primer timestamp de la respuesta es mayor o igual a `start`
- AND el último timestamp de la respuesta es menor o igual a `end`

#### Scenario: Retrocompatibilidad — sin start/end se comporta como hoy

- GIVEN un cliente que NO envía `start` ni `end`
- WHEN se hace `GET /stations/AK.FIRE..BHZ/waveform?minutes=90`
- THEN la respuesta HTTP es 200
- AND la ventana devuelta es relativa hacia atrás desde ahora, igual que antes de
  este cambio
- AND el `duration_hours` pedido a FDSN sigue siendo `max(1, ceil(90/60)) = 2`

#### Scenario: end menor o igual a start es rechazado

- GIVEN una petición con `start=2026-08-20T11:00:00Z` y `end=2026-08-20T10:00:00Z`
- WHEN se hace `GET /stations/AK.FIRE..BHZ/waveform` con esos parámetros
- THEN la respuesta HTTP es 422
- AND el body es `{"detail": ...}` y el mensaje menciona que `end` debe ser
  posterior a `start`
- AND no se realizó ninguna llamada al servicio FDSN

#### Scenario: end exactamente igual a start es rechazado

- GIVEN una petición con `start=2026-08-20T10:00:00Z` y `end=2026-08-20T10:00:00Z`
- WHEN se hace `GET /stations/AK.FIRE..BHZ/waveform` con esos parámetros
- THEN la respuesta HTTP es 422
- AND no se realizó ninguna llamada al servicio FDSN

Nota de falsabilidad: este escenario y el anterior son distintos a propósito.
Cambiar la comparación de `end > start` a `end >= start` deja el anterior en
verde y pone ESTE en rojo.

#### Scenario: Ventana mayor a 24 horas es rechazada

- GIVEN una petición con `start=2026-08-19T00:00:00Z` y `end=2026-08-20T00:00:01Z`
  (24 h + 1 s)
- WHEN se hace `GET /stations/AK.FIRE..BHZ/waveform` con esos parámetros
- THEN la respuesta HTTP es 422
- AND el mensaje de `detail` menciona el techo de 24 horas
- AND no se realizó ninguna llamada al servicio FDSN

#### Scenario: Ventana de exactamente 24 horas es aceptada

- GIVEN una petición con `start=2026-08-19T00:00:00Z` y `end=2026-08-20T00:00:00Z`
  (exactamente 24 h)
- WHEN se hace `GET /stations/AK.FIRE..BHZ/waveform` con esos parámetros
- THEN la respuesta NO es 422 por techo de ventana

Nota de falsabilidad: el par de escenarios de 24 h fija el borde en `<=`.
Cambiar la comparación a `<` pone este escenario en rojo; cambiarla a un techo
de 25 h pone en rojo el escenario anterior.

#### Scenario: start junto con minutes es rechazado

- GIVEN una petición que envía `start=2026-08-20T10:00:00Z`, `end=2026-08-20T11:00:00Z`
  Y ADEMÁS `minutes=60` de forma explícita
- WHEN se hace `GET /stations/AK.FIRE..BHZ/waveform` con esos parámetros
- THEN la respuesta HTTP es 422
- AND el mensaje de `detail` indica que `start`/`end` y `minutes` son mutuamente
  excluyentes

#### Scenario: start sin end es rechazado

- GIVEN una petición que envía `start=2026-08-20T10:00:00Z` y omite `end`
- WHEN se hace `GET /stations/AK.FIRE..BHZ/waveform` con ese parámetro
- THEN la respuesta HTTP es 422
- AND el mensaje de `detail` indica que `start` y `end` deben usarse juntos

#### Scenario: Formato de fecha inválido es rechazado

- GIVEN una petición con `start=ayer` y `end=hoy`
- WHEN se hace `GET /stations/AK.FIRE..BHZ/waveform` con esos parámetros
- THEN la respuesta HTTP es 422
- AND el body es `{"detail": ...}`
- AND no se realizó ninguna llamada al servicio FDSN

#### Scenario: Ventana absoluta sin datos en FDSN

- GIVEN una ventana absoluta sintácticamente válida para la que FDSN no devuelve
  ninguna traza (stream vacío o `None`)
- WHEN se hace `GET /stations/AK.FIRE..BHZ/waveform?start=...&end=...`
- THEN la respuesta HTTP es 404
- AND el body es `{"detail": ...}` y el mensaje nombra el canal
- AND el resultado vacío NO se guarda en cache (un vacío puede venir de un
  timeout transitorio y cachearlo dejaría la ventana muerta por todo el TTL)

Nota de falsabilidad: el 404 y el 422 son códigos distintos a propósito. Si la
implementación colapsara "sin datos" y "ventana inválida" en un mismo código,
uno de los dos escenarios queda en rojo.

#### Scenario: channel malformado sigue siendo 422

- GIVEN el canal `AK.FIRE` (2 partes en vez de 4)
- WHEN se hace `GET /stations/AK.FIRE/waveform?start=...&end=...`
- THEN la respuesta HTTP es 422
- AND el body es `{"detail": "channel debe ser NET.STA.LOC.CHA"}`

### Requirement: La clave de cache incorpora la ventana absoluta

La clave de cache de `waveform` MUST incorporar la ventana absoluta cuando se
usa. Dos peticiones al MISMO canal con ventanas absolutas DISTINTAS MUST NOT
colisionar en cache.

(Previously: `cache_key = f"waveform:{channel}:{minutes}:{points}:{filter}"`
—`src/main.py:2604`— que no contiene `start` ni `end`: con ventana absoluta, dos
ventanas distintas del mismo canal producirían la misma clave y la segunda
recibiría los datos de la primera.)

#### Scenario: Dos ventanas absolutas distintas del mismo canal no colisionan

- GIVEN un cache vacío y el canal `AK.FIRE..BHZ`
- WHEN se pide `?start=2026-08-20T10:00:00Z&end=2026-08-20T11:00:00Z`
- AND luego se pide `?start=2026-08-20T14:00:00Z&end=2026-08-20T15:00:00Z`
- THEN las dos peticiones producen claves de cache DISTINTAS
- AND la segunda petición produce una llamada NUEVA al servicio FDSN (no se
  sirve desde el cache de la primera)
- AND los datos devueltos por la segunda corresponden a su propia ventana

Nota de falsabilidad: la mutación que rompe este escenario es dejar la
`cache_key` sin `start`/`end` (o sea, revertirla a la forma de hoy). Ese es
exactamente el bug que el escenario existe para prevenir.

#### Scenario: La misma ventana absoluta sí se sirve del cache

- GIVEN un TTL de cache mayor a 0 y una petición absoluta ya servida
- WHEN se repite la MISMA petición (mismo `channel`, `start`, `end`, `points`,
  `filter`)
- THEN se devuelve el resultado cacheado
- AND NO se realiza una segunda llamada al servicio FDSN

#### Scenario: Ventana relativa y ventana absoluta no colisionan entre sí

- GIVEN una petición relativa `?minutes=60` ya servida y cacheada
- WHEN se pide una ventana absoluta de 60 minutos del mismo canal, mismos
  `points` y `filter`
- THEN las claves de cache son distintas
- AND la petición absoluta NO recibe el resultado de la relativa

#### Scenario: points y filter siguen discriminando la clave

- GIVEN la misma ventana absoluta del mismo canal
- WHEN se pide con `filter=none` y luego con `filter=bp`
- THEN las claves de cache son distintas
- AND las dos respuestas son distintas entre sí (la filtrada no es la cruda)

---

## ADDED Requirements

### Requirement: Endpoint de espectro 1D GET /stations/{channel}/spectra

El sistema MUST exponer `GET /stations/{channel}/spectra` que devuelva el
espectro de potencia (Power vs Hz) de una ventana absoluta de un canal.

Verificado que no existe hoy: `rg "spectra" src/main.py` no devuelve nada.

Reglas normativas:

1. Los parámetros de ventana (`start`, `end`) MUST seguir EXACTAMENTE las mismas
   reglas de validación del requirement "Ventana absoluta en
   GET /stations/{channel}/waveform" (mutuamente excluyentes con relativa, techo
   24 h, `end > start`, 422 con `{"detail": ...}`).
2. `filter` MUST aceptar los mismos valores que `waveform` (`none` | `bp`).
3. El cálculo MUST usar `KAISER_BETA` y `DB_MULTIPLIER` IMPORTADOS de
   `src/services/swarm_spectra.py`. El módulo del espectro 1D MUST NOT declarar
   sus propias constantes con esos valores.
4. El ventaneo MUST aplicarse sobre la ventana COMPLETA (una sola FFT), no por
   bins como el espectrograma 2D.
5. La respuesta MUST incluir `sampling_rate` (float, Hz) y el techo de frecuencia
   efectivo `max_frequency_hz = min(MAX_FREQ_HZ, sampling_rate / 2)`.

#### Scenario: La respuesta declara su sampling_rate y su techo efectivo

- GIVEN un canal cuya traza tiene `sampling_rate = 40.0` Hz
- WHEN se pide su espectro sobre una ventana absoluta válida
- THEN la respuesta contiene `sampling_rate == 40.0`
- AND contiene `max_frequency_hz == 20.0`, porque `MAX_FREQ_HZ` vale 25.0,
  `fs / 2` vale 20.0 y `min(25.0, 20.0) = 20.0` (manda Nyquist)

Nota de falsabilidad: el valor esperado (20.0) es DISTINTO tanto de `MAX_FREQ_HZ`
(25.0) como de `sampling_rate` (40.0). Un test cuyo valor esperado coincidiera con
la constante no podría distinguir la implementación correcta de una que devuelve
la constante — ese es exactamente el defecto de "valor esperado igual al fallback"
que este repo ya produjo.

#### Scenario: Dos canales con sampling_rate distinto producen ejes distintos

- GIVEN el canal A con `sampling_rate = 20.0` Hz y el canal B con
  `sampling_rate = 100.0` Hz, sobre la misma ventana absoluta
- WHEN se pide el espectro de cada uno
- THEN el `max_frequency_hz` de A es `min(25.0, 10.0) = 10.0`
- AND el `max_frequency_hz` de B es `min(25.0, 50.0) = 25.0`
- AND la frecuencia máxima presente en el array de frecuencias de A es menor o
  igual a 10.0
- AND la frecuencia máxima presente en el array de frecuencias de B es menor o
  igual a 25.0
- AND los dos ejes NO son iguales entre sí

Nota de falsabilidad y mutación de verificación: la mutación es reemplazar el
cálculo `min(MAX_FREQ_HZ, fs/2)` por la constante `MAX_FREQ_HZ`. Antes de leer
el resultado del test se MUST confirmar por `rg` que la mutación quedó aplicada
en el archivo. Con la mutación aplicada, el aserto sobre A (10.0) MUST quedar en
rojo. Hay evidencia medida en este repo de que el techo real varía entre 10, 20
y 25 Hz según el canal: un eje constante miente por factor 2.

#### Scenario: El pico de una sinusoide sintética cae en su bin

- GIVEN una traza sintética de una sinusoide pura de 5.0 Hz, muestreada a
  100.0 Hz, de duración suficiente para que la resolución en frecuencia sea
  menor a 0.5 Hz
- WHEN se calcula su espectro 1D
- THEN el bin de mayor potencia corresponde a una frecuencia dentro de
  ±0.5 Hz de 5.0 Hz

#### Scenario: El espectro NO se calcula sobre datos decimados min/max

- GIVEN la misma ventana absoluta del mismo canal
- WHEN se compara el espectro calculado por el endpoint contra el espectro que
  resultaría de aplicar la FFT a los pares min/max que devuelve `/waveform` para
  esa misma ventana
- THEN el pico del espectro del endpoint cae en el bin de la frecuencia real de
  la señal
- AND el espectro derivado de los pares min/max NO cumple esa propiedad

Nota de falsabilidad: si la implementación calculara la FFT sobre el resultado
de la decimación min/max, el escenario de la sinusoide sintética también caería.
La mutación de verificación es alimentar la FFT con la salida de
`build_waveform_response` en lugar de la traza cruda.

#### Scenario: Kaiser beta y el multiplicador de dB vienen de swarm_spectra

- GIVEN el módulo que implementa el espectro 1D
- WHEN se inspecciona su código fuente
- THEN importa `KAISER_BETA` y `DB_MULTIPLIER` desde `src/services/swarm_spectra.py`
- AND NO define literales `5` para beta ni `20` para el multiplicador de dB en su
  propio ámbito

Notas de mutación de verificación (obligatorias, ambas con confirmación previa
por `rg` de que el cambio quedó escrito en el archivo):

- Mutar `KAISER_BETA = 5` → `8` en `swarm_spectra.py` MUST poner en rojo al menos
  un test del espectro 1D. Si queda verde, el espectro 1D no está usando la
  constante compartida.
- Mutar `DB_MULTIPLIER = 20` → `10` en `swarm_spectra.py` MUST poner en rojo al
  menos un test del espectro 1D que verifique un valor de potencia en dB (no sólo
  la posición del pico: el multiplicador NO cambia dónde cae el pico).

#### Scenario: Ventana inválida en spectra es rechazada igual que en waveform

- GIVEN una petición a `/stations/AK.FIRE..BHZ/spectra` con `end <= start`
- WHEN se ejecuta
- THEN la respuesta HTTP es 422
- AND el body es `{"detail": ...}`

#### Scenario: Sin datos FDSN en spectra

- GIVEN una ventana absoluta válida sin datos en FDSN
- WHEN se pide el espectro
- THEN la respuesta HTTP es 404 con body `{"detail": ...}`

### Requirement: Serie temporal RSAM sobre ventana absoluta

El sistema MUST exponer un endpoint que devuelva la SERIE temporal de RSAM de un
canal sobre una ventana absoluta, calculada ON-DEMAND desde la onda.

Decisión cerrada (usuario, 2026-08-24): la serie se calcula bajando la ventana de
FDSN y aplicando `rsam_sample()` de `src/services/swarm_rsam.py` sobre subventanas
consecutivas. El sistema MUST NOT persistir muestras de RSAM, MUST NOT modificar
`src/services/seedlink_ingestor.py` y esta fase MUST NOT incluir migración de
esquema.

Reglas normativas:

1. Las reglas de validación de ventana MUST ser las mismas de `waveform`.
2. El cálculo de cada muestra MUST reusar `rsam_sample()`; el endpoint MUST NOT
   reimplementar la media de `|señal demeaned|`.
3. Cada muestra devuelta MUST llevar su timestamp UTC.
4. El `deque` en memoria (`RsamAccumulator` / `RsamSeries`) que alimenta el número
   instantáneo del muro MUST seguir existiendo sin cambios de comportamiento: son
   dos caminos distintos y deliberadamente separados.

#### Scenario: La serie cubre la ventana pedida con muestras fechadas

- GIVEN una ventana absoluta de 1 hora sobre un canal con datos
- WHEN se pide la serie RSAM
- THEN la respuesta HTTP es 200
- AND contiene una lista de muestras, cada una con timestamp UTC y valor
- AND el timestamp de la primera muestra es mayor o igual a `start`
- AND el timestamp de la última muestra es menor o igual a `end`
- AND los timestamps son estrictamente crecientes

#### Scenario: Una señal constante da RSAM cero

- GIVEN una traza sintética cuyo valor es la constante 1000 en toda la ventana
- WHEN se calcula su serie RSAM
- THEN todas las muestras valen 0.0 (la media de `|x - mean(x)|` de una constante
  es exactamente 0)

Nota de falsabilidad: si la implementación omitiera el demean (es decir, calculara
`mean(|x|)` en vez de `mean(|x - mean(x)|)`), este escenario devolvería 1000.0 y
quedaría en rojo. Ésa es la mutación de verificación.

#### Scenario: Una onda cuadrada de amplitud conocida da el RSAM esperado

- GIVEN una traza sintética que alterna exactamente entre `+100` y `-100`, con la
  misma cantidad de muestras de cada signo
- WHEN se calcula una muestra RSAM sobre esa ventana
- THEN el valor es exactamente `100.0` (la media es 0, y la media de `|±100|` es
  100)

#### Scenario: El ingestor SeedLink no cambia

- GIVEN el diff completo de esta fase
- WHEN se inspecciona `src/services/seedlink_ingestor.py`
- THEN no tiene cambios
- AND no se agregó ninguna migración de esquema en esta fase

#### Scenario: Ventana inválida en la serie RSAM es rechazada

- GIVEN una petición de serie RSAM con ventana mayor a 24 horas
- WHEN se ejecuta
- THEN la respuesta HTTP es 422 con body `{"detail": ...}`

### Requirement: CRUD de picks de señal persistidos por usuario

El sistema MUST persistir los picks (P, S, coda) que un usuario marca sobre una
señal, en la base de datos, NO en el almacenamiento del navegador.

Reglas normativas:

1. La persistencia MUST usar una tabla nueva creada por
   `deploy/sql/migrations/015_signal_picks.sql` (siguiente número libre;
   verificado: el último es `014_seismic_events.sql`).
2. La tabla MUST referenciar `users(id)` con `ON DELETE CASCADE`, siguiendo el
   patrón de `013_walls.sql`, con índices `IF NOT EXISTS` y bloque de rollback
   comentado al pie.
3. Los endpoints de picks MUST requerir sesión autenticada.
4. Un usuario MUST NOT poder leer, modificar ni borrar los picks de otro usuario.
5. Los picks de una sesión MUST poder exportarse en CSV.

#### Scenario: Un pick creado sobrevive a recargar la página

- GIVEN un usuario autenticado que marcó una fase P sobre `AK.FIRE..BHZ` en un
  instante dado
- WHEN el navegador se recarga por completo y se vuelven a pedir los picks de ese
  canal y ventana
- THEN el pick de P aparece con el mismo instante que se guardó

#### Scenario: Un pick sobrevive a cerrar y reabrir sesión

- GIVEN un usuario autenticado con picks guardados
- WHEN cierra sesión y vuelve a entrar con la misma cuenta
- THEN sus picks siguen estando

Nota de falsabilidad: los dos escenarios anteriores quedan en rojo si la
implementación guardara los picks en `localStorage`. Un test que sólo verifique
"el pick se lee después de escribirlo en la misma sesión" pasaría igual con
`localStorage` y NO sirve.

#### Scenario: Un usuario no ve los picks de otro

- GIVEN el usuario A con picks guardados sobre `AK.FIRE..BHZ`
- AND el usuario B autenticado, sin picks propios sobre ese canal
- WHEN B pide los picks de `AK.FIRE..BHZ`
- THEN la lista devuelta a B está vacía
- AND ninguno de los picks de A aparece en ella

#### Scenario: Un usuario no puede borrar el pick de otro

- GIVEN un pick que pertenece al usuario A
- WHEN el usuario B intenta borrarlo por su identificador
- THEN la operación es rechazada (404 o 403, con body `{"detail": ...}`)
- AND el pick de A sigue existiendo

#### Scenario: Sin sesión no hay picks

- GIVEN una petición sin credenciales válidas
- WHEN se intenta listar o crear picks
- THEN la respuesta es 401

#### Scenario: Borrar el usuario borra sus picks

- GIVEN un usuario con picks guardados
- WHEN se elimina la fila de ese usuario en `users`
- THEN sus picks desaparecen por el `ON DELETE CASCADE`

#### Scenario: Export CSV de las mediciones

- GIVEN un usuario con picks P, S y coda sobre un canal
- WHEN pide el export CSV
- THEN recibe un CSV con una fila por medición
- AND las columnas incluyen canal, tipo de pick, timestamp UTC y, cuando
  corresponda, la distancia S-P y la magnitud de coda derivadas
- AND el archivo abre en una planilla sin corrupción de separadores
