# Design: Analíticas profesionales de señal (paridad moderna con SWARM)

## Technical Approach

El cambio NO agrega un pipeline nuevo: **reusa el que ya existe y le cambia una
sola cosa — de dónde salen los límites temporales del `Stream`**.

Hoy el camino es:

```
GET /stations/{ch}/waveform?minutes=1440
      │
      ├─ split SCNL → 422 si no son 4 partes
      ├─ cache.get("waveform:{ch}:{minutes}:{points}:{filter}")
      ├─ SpectrogramService.get_waveform_data(duration_hours=ceil(minutes/60))
      │       └─ _get_waveform_sync: end = UTCDateTime(); start = end - h*3600   ← ACÁ está el candado
      ├─ trace = max(stream, key=npts)          (gaps: el trace más largo)
      └─ build_waveform_response(trace, ch, points, apply_filter)
              demean → butterworth(opcional) → decimate_minmax → tipos nativos
```

`_get_waveform_sync` **ancla `end` en `UTCDateTime()`**, o sea "ahora". Esa
línea (`src/services/spectrogram_service.py:520-521`) es el único motivo por el
que no se puede mirar un evento de ayer. Todo lo demás del pipeline es agnóstico
de cuándo ocurrió la señal.

La estrategia, entonces:

1. **Fase 1** — abrir `_get_waveform_sync` a una ventana absoluta opcional y
   exponerla como `start`/`end` en el endpoint. Sin tocar el resto.
2. **Fases 2-4** — construir consumidores nuevos SOBRE ese mismo `Stream`:
   el wave view lo dibuja, el espectro 1D le hace una FFT única, la serie RSAM
   le corre `rsam_sample()` por ventanas contiguas. Los tres comparten un helper
   de resolución de ventana; ninguno duplica lógica FDSN.
3. **Fase 5** — la única fase con estado propio: tabla `signal_picks`, servicio
   con las dos fórmulas, y UI de un nivel.
4. **Transversal** — la progresividad es una lib pura de frontend que decide
   qué se renderiza; ningún componente decide por su cuenta.

Regla de oro que atraviesa todo el diseño y que sale de la historia de este
repo: **la lógica que se puede probar sin canvas y sin red se saca a una función
pura**. El canvas dibuja, el hook trae datos, la lib decide. Cuando algo falla,
falla en un test unitario y no en un QA visual.

---

## Architecture Decisions

### Decision 1: La ventana absoluta se resuelve en el SERVICE, no en el endpoint

**Choice**: `SpectrogramService.get_waveform_data` (y su `_get_waveform_sync`)
aceptan `starttime`/`endtime` opcionales de tipo `datetime` (UTC-aware). Cuando
vienen, se usan tal cual; cuando no, se conserva el comportamiento actual
(`end = now`, `start = end - duration_hours*3600`). El endpoint sólo valida y
traduce.

**Alternatives considered**:
- (a) Calcular `duration_hours` desde `start`/`end` en el endpoint y seguir
  usando la firma relativa. Rechazado: la ventana quedaría anclada a "ahora"
  igual — pedir `duration_hours=48` para un evento de la semana pasada devuelve
  las últimas 48 h, no las que se pidieron. Es exactamente el bug que
  desbloquear.
- (b) Un método nuevo `get_waveform_window()` paralelo. Rechazado: duplica el
  loop de failover entre servidores FDSN (`servers_to_try`,
  `spectrogram_service.py:526-548`), que es la parte que más caro sale mantener
  en dos lugares.

**Rationale**: el parámetro que falta es de la CAPA DE DATOS, no de la capa
HTTP. Meterlo donde vive el `UTCDateTime()` mantiene una sola implementación del
failover y hace que las Fases 3 y 4 (espectro y RSAM) lo reusen gratis sin pasar
por el endpoint de waveform.

**Consecuencia de compatibilidad**: los parámetros son opcionales y `minutes`
sigue siendo el default ⇒ ningún cliente existente (`HelicorderCanvas.tsx:96-99`)
cambia de comportamiento. El rollback de la Fase 1 es un `git revert` limpio.

---

### Decision 2: El espectro 1D se calcula SERVER-SIDE

**Choice**: `GET /stations/{channel}/spectra` devuelve `freqs[]` y
`power_db[]` ya calculados. El cliente sólo dibuja.

**Alternatives considered**: mandar la onda al cliente y hacer la FFT en JS
(con un worker, o con la Web Audio API).

**Rationale** — tres razones independientes, cada una suficiente:

1. **El cliente NO TIENE la señal.** Lo que recibe hoy es
   `build_waveform_response` → `decimate_minmax`, o sea pares (min, max) por
   bloque. Eso NO es una señal muestreada uniformemente: es una envolvente.
   Una FFT sobre pares min/max produce un espectro **falso** — con energía
   inventada en la frecuencia del bloqueo de decimación, que ni siquiera es una
   frecuencia física. Para hacerlo bien en el cliente habría que mandarle la
   señal cruda, que es exactamente lo que el endpoint de waveform evita a
   propósito (millones de muestras por 24 h de un canal de 40 Hz).
2. **Paridad de constantes.** `KAISER_BETA`, `DB_MULTIPLIER`, `MAX_FREQ_HZ` y
   `_EPS` viven en `src/services/swarm_spectra.py:14-25`. Calcularlo en el
   cliente obliga a duplicarlas en TS, y este repo YA pagó ese precio: la escala
   de magnitud tuvo CUATRO fuentes de verdad y un token CSS inexistente cayendo
   al fallback en silencio. Server-side hay una sola definición.
3. **Coherencia con el espectrograma.** El espectrograma 2D ya se calcula
   server-side con esas mismas constantes. Que el corte 1D y el 2D de la misma
   ventana den números distintos sería un bug indefendible ante un sismólogo.

---

### Decision 3: El zoom RE-PIDE la ventana; nunca re-escala local

**Choice**: cada gesto de zoom dispara un `fetch` nuevo con la ventana
`{start, end}` resultante. El estado local guarda la pila de ventanas, no los
datos de cada nivel.

**Alternatives considered**: guardar la respuesta de 24 h y hacer zoom
recortando el array en memoria (el patrón que usa hoy `HelicorderCanvas` para
`clipMult`/`barMult`).

**Rationale**: el array que hay en memoria son **pares min/max ya decimados**.
Hacer zoom sobre él no revela detalle nuevo — revela los mismos pares, más
gordos. A 24 h con `points=50000` cada par resume ~1,7 s de señal; al hacer zoom
a 10 s el usuario vería SEIS pares estirados a lo ancho de la pantalla y creería
que eso es la onda. Es un mentiroso silencioso: no falla, dibuja algo plausible
y equivocado. Re-pedir 10 s con `points=38400` da ~800 muestras reales por
segundo de señal.

La distinción es la misma que el repo ya documentó para el helicorder:
`clipMult`/`barMult` cambian **cómo se dibuja** (repintan local), el filtro y la
ventana cambian **el dato** (re-piden). El zoom cae del lado del dato.

**Criterio de aceptación verificable** (ya en la propuesta): en la pestaña de
red del navegador tiene que aparecer un request nuevo por cada zoom. Si no
aparece, la implementación está mal por definición.

---

### Decision 4: RSAM ON-DEMAND, no persistido (decisión cerrada del usuario)

**Choice**: `GET /stations/{channel}/rsam` baja la ventana absoluta de FDSN
—el mismo camino de la Fase 1— y corre `rsam_sample()` sobre ventanas
contiguas de `period_seconds`. No se persiste ninguna muestra. **No se toca
`src/services/seedlink_ingestor.py` y no hay migración en la Fase 4.**

**Alternatives considered**: persistir las muestras que ya produce el ingestor
SeedLink en una hypertable de TimescaleDB.

**Rationale** (input cerrado, se documenta el porqué para el que lea el código
en seis meses):
- El ingestor **ya se cayó en silencio una vez**: hilo daemon sin
  `try/except` + falta de `PYTHONUNBUFFERED` ⇒ `exit 0`, deploy verde y mudo.
  Agregarle una escritura a base por una feature de LECTURA le suma superficie
  de falla al proceso más frágil del sistema, a cambio de nada que el usuario
  vea.
- Persistir sólo sirve **desde el deploy hacia adelante**. On-demand funciona
  sobre cualquier fecha que FDSN tenga — que es justamente el caso de uso
  (mirar el evento de ayer, o el de 2019).
- El costo es **latencia** (segundos por ventana), no storage. Si duele en uso
  real, la persistencia se evalúa DESPUÉS con datos.

**Convivencia explícita**: el `deque` de `RsamAccumulator`
(`swarm_rsam.py:36-75`) SIGUE existiendo y sigue siendo el que alimenta el
número instantáneo del muro (`il` en `station-metrics.ts`). Son dos caminos
distintos con dos propósitos distintos y está bien que lo sean:

| | `RsamAccumulator` (hoy) | Serie on-demand (Fase 4) |
|---|---|---|
| Fuente | SeedLink en vivo | FDSN, ventana absoluta |
| Alcance temporal | última hora | cualquier fecha con dato |
| Persistencia | RAM, se pierde al reiniciar | ninguna, se recalcula |
| Consumidor | métrica `il` del muro | `RsamChart` de la pestaña |
| Código compartido | **`rsam_sample()`** — la fórmula es UNA | idem |

Lo único que comparten es la fórmula, y eso es a propósito: si el número del
muro y la serie del gráfico se calcularan distinto, la comparación entre
pantallas sería una mentira.

---

### Decision 5: Las constantes de FFT tienen UNA fuente

**Choice**: el módulo del espectro 1D **importa** `KAISER_BETA`,
`DB_MULTIPLIER`, `MAX_FREQ_HZ` y `_EPS` de `swarm_spectra.py`. No redefine
ninguna. El frontend NO tiene constantes de FFT: recibe `sampling_rate` y
`max_freq_hz` en la respuesta.

**Alternatives considered**: un módulo `signal_spectrum.py` autocontenido con
sus propios valores.

**Rationale**: antecedente documentado y caro. La escala de magnitud de este
repo llegó a tener cuatro fuentes de verdad; una de ellas era un token CSS
(`--color-severity-low`) que **nunca existió** y caía al fallback sin error, sin
warning y sin test rojo. Una constante duplicada no falla, **deriva** — y cuando
deriva, dos pantallas del mismo dato muestran números distintos y nadie sabe
cuál creer.

Verificación por mutación asociada (obligatoria, ver Testing Strategy): cambiar
`KAISER_BETA = 5` → `8` en `swarm_spectra.py` DEBE poner en rojo un test del
espectro 1D. Si sigue verde, el espectro 1D tiene su propia copia escondida.

---

### Decision 9: El modelo de velocidades tiene UNA fuente: un JSON compartido

**Contexto**: la Decision 7 duplica las fórmulas sismológicas a propósito —
Python las necesita para el CSV, TypeScript para el feedback inmediato al marcar
una fase. El riesgo declarado era "requiere disciplina en la implementación".
**Eso no alcanza.** La disciplina es exactamente lo que falló en la escala de
magnitud (cuatro fuentes de verdad) y en el token CSS que nunca existió.

**Choice**: las cuatro constantes del modelo de velocidades viven en UN archivo
JSON que ambos lados leen. Ninguno las declara.

```
dashboard/lib/seismic-constants.json      <- la única fuente
{
  "pVelocityKmS": 6.0,
  "vpVsRatio": 1.73,
  "codaA": 1.86,
  "codaB": -0.85
}
```

**Por qué vive dentro de `dashboard/`** (verificado, no es arbitrario):
`dashboard/tsconfig.json` tiene `"paths": {"@/*": ["./*"]}` e
`"include": ["**/*.ts", ...]`, ambos relativos a `dashboard/`. TypeScript **no
puede importar nada fuera de ese directorio**. Python sí puede leer hacia arriba.
Así que la restricción del lenguaje más rígido decide la ubicación.

- TS: `import C from '@/lib/seismic-constants.json'` (`resolveJsonModule: true`
  ya está activo, verificado en `tsconfig.json:12`).
- Python: `signal_picks.py` lo carga con `json.load` desde una ruta calculada
  relativa al repo, **una sola vez a nivel de módulo**, y expone
  `P_VELOCITY_KM_S`, `VP_VS_RATIO`, `CODA_A`, `CODA_B`. Si el archivo falta o le
  falta una clave, **revienta al importar** — nunca cae a un default silencioso.
  Ese es el punto: un `KeyError` al arrancar es infinitamente mejor que una
  distancia equivocada en un CSV.

**Qué resuelve y qué NO resuelve** (honestidad sobre el alcance):

| Modo de falla | ¿Lo cubre el JSON? |
|---|---|
| Alguien cambia `vp` en Python y olvida TS | **Sí, por construcción.** Imposible: hay un solo valor. |
| Alguien escribe `(vp - vs)` donde va `(vp * vs)` en un lado | **No.** Los números son idénticos y la cuenta está mal. |

Para el segundo modo, la defensa son las mutaciones #1-#5 de la Testing
Strategy, que ahora cambian de forma: mutar el JSON DEBE poner en rojo tests de
**ambas** suites. Si sólo se pone roja una, hay una copia escondida de la
constante en el otro lado.

**Alternatives considered**:
- *Vectores de prueba compartidos* (un archivo de casos input→output que
  ejecutan ambas suites): cubre también la deriva de fórmula, pero es un test
  que alguien puede no correr. Queda como mejora futura, no descartado.
- *Sólo backend* (el frontend pide la medición por HTTP al marcar la fase): cero
  duplicación posible, pero mete un round-trip de red entre el clic y el número.
  Descartado por UX: marcar una fase tiene que sentirse instantáneo.

**Mutación de verificación específica de esta decisión**: cambiar
`"pVelocityKmS": 6.0` → `7.0` en el JSON debe poner en rojo el test de distancia
S-P **de Python Y el de TypeScript**. Un solo rojo = deriva presente.

---

### Decision 6: El eje de frecuencia se deriva del DATO

**Choice**: la respuesta de `/spectra` incluye `sampling_rate` y
`max_freq_hz = min(MAX_FREQ_HZ, fs/2)`. El frontend dibuja el eje con esos
valores. Ninguna constante de frecuencia máxima vive en TS.

**Alternatives considered**: dibujar el eje 0-25 Hz fijo (el `MAX_FREQ_HZ` de
SWARM).

**Rationale**: medido en producción — el techo efectivo varía por canal (10 /
20 / 25 Hz) e incluso dentro del mismo canal según qué servidor FDSN respondió.
Un canal de fs=20 Hz tiene Nyquist en 10 Hz: dibujarle un eje que llega a 25
**miente por factor 2,5** y hace que un pico de 8 Hz se lea como si estuviera en
3 Hz. No es un detalle cosmético, es una lectura falsa del dato.

**Nota sobre la escala dB**: `MIN_POWER_DB=20` / `MAX_POWER_DB=120`
(`swarm_spectra.py:22-23`) NO se derivan del dato: son fijas A PROPÓSITO para
que el color signifique lo mismo entre estaciones. Eso está fuera de alcance
(la propuesta lo marca explícitamente). El eje de FRECUENCIA se deriva; el eje
de POTENCIA es fijo. Son decisiones distintas y opuestas por buenas razones
distintas.

---

### Decision 7: Los picks van a la BASE, no a localStorage

**Choice**: tabla `signal_picks` con `user_id UUID REFERENCES users(id) ON
DELETE CASCADE`. CRUD autenticado, ownership en el `WHERE`.

**Alternatives considered**: localStorage, como `helicorder-settings.ts`.

**Rationale**: son datos de naturaleza distinta. `helicorder-settings` es una
**preferencia de visualización** — perderla es un inconveniente menor y por eso
el módulo tolera JSON corrupto devolviendo defaults. Un pick es una
**medición científica**: el usuario invirtió tiempo en decidir dónde llega la
onda P. Perderlo al cambiar de navegador o al limpiar el storage es inaceptable,
y el criterio de éxito de la propuesta lo dice literal: *"los picks sobreviven a
recargar la página y a cerrar sesión"*.

Ownership por `user_id` en el `WHERE` (no por rol), patrón idéntico a
`wall_service.py:193-211`: un pick ajeno devuelve 404, indistinguible de uno
inexistente. No hay picks compartidos en este cambio.

---

### Decision 8: La progresividad es una LIB PURA, no condicionales de JSX

**Choice**: `dashboard/lib/progressive-disclosure.ts` — función pura
`visibleTools(progress) → ToolVisibility`. Los componentes preguntan; no
deciden.

**Alternatives considered**: `{openedWindows > 3 && <SpectrumView/>}` esparcido
por los componentes.

**Rationale**: la propuesta lista como riesgo *"la progresividad esconde algo
que el usuario ya necesita, o no aparece nunca"*. Ese riesgo sólo es testeable
si la regla es una función. Con condicionales dispersos hay que montar el árbol
de React entero para preguntar "¿cuándo aparece el picking?", y cuando alguien
agregue una quinta herramienta va a copiar el umbral a mano en un quinto lugar
— que es el mismo pecado que la Decision 5, con otra ropa.

---

## Data Flow

### Vista general de las cinco fases

```
                      ┌─────────────────────────────────────────┐
                      │  SpectrogramService.get_waveform_data   │
   FDSN (IRIS/…) ────▶│   starttime/endtime opcionales (F1)     │
                      │   failover entre servidores (existente) │
                      └────────────────┬────────────────────────┘
                                       │  ObsPy Stream → trace más largo
                 ┌─────────────────────┼──────────────────────┐
                 │                     │                      │
                 ▼                     ▼                      ▼
   build_waveform_response     signal_spectrum.py      swarm_rsam.rsam_sample()
   (existente, F1+F2)          (nuevo, F3)             (existente, F4)
   demean→filtro→minmax        Kaiser sobre ventana    media |x| por ventana
                               COMPLETA, sin decimar   contigua
                 │                     │                      │
                 ▼                     ▼                      ▼
        GET …/waveform          GET …/spectra          GET …/rsam
                 │                     │                      │
                 ▼                     ▼                      ▼
            WaveView              SpectrumView            RsamChart
                 │
                 ▼  (F5, estado propio)
          PickingOverlay ──▶ POST/GET/DELETE /stations/{ch}/picks
                                        │
                                        ▼
                            signal_picks (Postgres, por usuario)
```

### Diagrama de secuencia: loop de zoom (Fase 2) — requerido por config.yaml

Este es el flujo más delicado del cambio: hay red, hay gestos que se pisan y hay
una pila de historial. El punto no negociable es que **el zoom cruza la red**.

```
Usuario      WaveView(canvas)   waveform-scale.ts   useWaveWindow(hook)   API /waveform   FDSN
  │                │                    │                   │                  │           │
  │ mousedown x=120│                    │                   │                  │           │
  ├───────────────▶│ dragStart=120      │                   │                  │           │
  │ mousemove x=380│ (sólo pinta el     │                   │                  │           │
  ├───────────────▶│  rectángulo, no    │                   │                  │           │
  │                │  pide nada)        │                   │                  │           │
  │ mouseup  x=380 │                    │                   │                  │           │
  ├───────────────▶│                    │                   │                  │           │
  │                │ dragSelection(120,380, w, window)      │                  │           │
  │                ├───────────────────▶│                   │                  │           │
  │                │  normaliza (x2<x1 ⇒ swap)              │                  │           │
  │                │  xToTime en ambos extremos             │                  │           │
  │                │◀───────────────────┤ {startMs, endMs}  │                  │           │
  │                │                    │                   │                  │           │
  │                │ clampWindow(sel)   │                   │                  │           │
  │                ├───────────────────▶│  · dur < MIN_WINDOW_MS (1000) ⇒ expandir          │
  │                │                    │    simétrico alrededor del centro                 │
  │                │                    │    (0 s ⇒ división por cero en timeToX)           │
  │                │                    │  · dur > MAX_WINDOW_MS (24 h) ⇒ recortar          │
  │                │◀───────────────────┤ ventana válida    │                  │           │
  │                │                    │                   │                  │           │
  │                │ pushWindow(w)      │                   │                  │           │
  │                ├────────────────────┼──────────────────▶│                  │           │
  │                │                    │  ①  ¿hay request en vuelo?                       │
  │                │                    │      SÍ ⇒ abortController.abort()                │
  │                │                    │  ②  stack.push(ventanaActual)                    │
  │                │                    │  ③  setWindow(w)  (estado ⇒ efecto)              │
  │                │                    │                   │                  │           │
  │                │                    │                   │ GET ?start&end   │           │
  │                │                    │                   ├─────────────────▶│           │
  │                │                    │                   │                  │ get_waveforms
  │                │                    │                   │                  ├──────────▶│
  │                │                    │                   │                  │◀──────────┤
  │                │                    │                   │  demean→filtro→minmax        │
  │                │                    │                   │◀─────────────────┤           │
  │                │                    │  ④ ¿el AbortSignal está abortado?                │
  │                │                    │     SÍ ⇒ descartar, NO tocar el estado           │
  │                │                    │  ⑤ ¿la ventana de la respuesta === la actual?   │
  │                │                    │     NO ⇒ descartar (llegó tarde)                 │
  │                │◀───────────────────┼───────────────────┤ setData(wf)      │           │
  │◀───────────────┤ repinta con la onda REAL de esa ventana │                  │           │
  │                │                    │                   │                  │           │
  │ "volver atrás" │                    │                   │                  │           │
  ├────────────────┼────────────────────┼──────────────────▶│ popWindow()      │           │
  │                │                    │                   │ (mismo ①-⑤)     │           │
```

**Race conditions — las tres y cómo se cierran:**

| Escenario | Qué pasa sin defensa | Defensa |
|---|---|---|
| El usuario arrastra de nuevo con un request en vuelo | Dos respuestas llegan en orden arbitrario; la vieja pisa a la nueva y el canvas queda con una ventana que no es la pedida | `AbortController` por request: al iniciar el siguiente se aborta el anterior (paso ①) |
| El `abort` no llega a tiempo (la respuesta ya estaba en el pipe) | Igual que arriba | Guarda ⑤: comparar la ventana de la respuesta contra la ventana ACTUAL del estado antes de aplicar. Distinta ⇒ se descarta |
| El componente se desmonta con un request en vuelo | `setState` sobre un componente muerto | Cleanup del efecto: `abort()` + flag `cancelled` (mismo patrón que `HelicorderCanvas.tsx:87,113-115`) |

**Estado de la pila y las trampas de React que este repo ya pisó:**

```ts
// dashboard/hooks/use-wave-window.ts

// NO: useState(initialWindow ?? computeDefault(channelMeta))
// `channelMeta` llega por SWR (async): en el primer render es undefined, el
// estado queda clavado en el default y NUNCA se recalcula. Este repo tiene
// CUATRO variantes de ese mismo pecado documentadas.
//
// SÍ: el estado arranca en null y un efecto con `channel` en deps lo siembra
// cuando el dato llega; el render trata null como "cargando".
const [window, setWindow] = useState<TimeWindow | null>(null);

// La pila va en useState y NO en useRef. Un ref no dispara re-render: el botón
// "volver atrás" quedaría deshabilitado para siempre aunque la pila tenga
// elementos. Además, un useEffect que LEE un ref sin tenerlo en deps corre una
// vez y nunca más — el repo lo pisó TRES veces.
const [stack, setStack] = useState<TimeWindow[]>([]);

// El AbortController SÍ va en un ref (es un objeto mutable que no se dibuja),
// pero se usa DENTRO del efecto que lo crea, nunca leído desde otro efecto.
const inFlight = useRef<AbortController | null>(null);
```

### Diagrama de secuencia: persistencia de picks (Fase 5) — requerido por config.yaml

```
Usuario   PickingOverlay   signal-picks.ts   API /picks   signal_picks_service   Postgres
  │             │                 │               │                │               │
  │ tecla "P"   │                 │               │                │               │
  │ clic x=340  │                 │               │                │               │
  ├────────────▶│ xToTime(340) ⇒ tP = 1745...123  │                │               │
  │             │ (waveform-scale: MISMA función que el zoom;      │               │
  │             │  dos mapeos distintos darían un pick corrido)    │               │
  │             │                 │               │                │               │
  │             │ POST {phase:'P', pick_time, channel}             │               │
  │             ├─────────────────┼──────────────▶│ user_id ← sesión (NUNCA del body)
  │             │                 │               ├───────────────▶│ INSERT … ON CONFLICT
  │             │                 │               │                │  (user_id,channel,phase,
  │             │                 │               │                │   pick_time) DO UPDATE
  │             │                 │               │                ├──────────────▶│
  │             │                 │               │                │◀──────────────┤
  │             │◀────────────────┼───────────────┤ 201 {id, …}    │               │
  │◀────────────┤ pinta la línea P                │                │               │
  │             │                 │               │                │               │
  │ tecla "S"   │                 │               │                │               │
  │ clic x=512  │                 │               │                │               │
  ├────────────▶│ xToTime(512) ⇒ tS               │                │               │
  │             │                 │               │                │               │
  │             │ computeSPDistance(tP, tS)  ← LIB PURA, en el cliente            │
  │             ├────────────────▶│  d = (tS-tP) * (vp*vs)/(vp-vs)                │
  │             │                 │  vp=6.0, vp/vs=1.73 ⇒ vs=6.0/1.73             │
  │             │◀────────────────┤  d ≈ 82.4 km                                   │
  │             │  (el backend tiene la MISMA fórmula para el CSV; el test de     │
  │             │   mutación tiene que romper AMBAS o sobra una)                   │
  │             │ POST {phase:'S', …}             │                │               │
  │             ├─────────────────┼──────────────▶├───────────────▶├──────────────▶│
  │◀────────────┤ muestra "S-P = 11.4 s → 82 km"  │                │               │
  │             │                 │               │                │               │
  ╞═════════ el usuario cierra sesión / cambia de máquina ═════════════════════════╡
  │             │                 │               │                │               │
  │ abre …/stations/AK.FIRE..BHZ  │               │                │               │
  ├────────────▶│ GET /picks?channel=&start=&end= │                │               │
  │             ├─────────────────┼──────────────▶├───────────────▶│ SELECT … WHERE
  │             │                 │               │                │  user_id=$1 AND
  │             │                 │               │                │  channel=$2 AND
  │             │                 │               │                │  pick_time BETWEEN
  │             │                 │               │                ├──────────────▶│
  │             │◀────────────────┼───────────────┤ [{P…},{S…}]    │◀──────────────┤
  │◀────────────┤ redibuja las líneas EN SU POSICIÓN ABSOLUTA                      │
  │             │  (por eso el pick guarda un instante UTC y no un x ni un offset: │
  │             │   la misma ventana con otro `points` da otro x)                  │
  │             │                 │               │                │               │
  │ "Exportar"  │                 │               │                │               │
  ├────────────▶│ GET /picks/export.csv?channel=  │                │               │
  │             ├─────────────────┼──────────────▶│ el CSV se arma en el BACKEND: │
  │             │                 │               │ incluye d y Mc calculados con  │
  │             │                 │               │ las fórmulas del service       │
  │             │◀────────────────┼───────────────┤ text/csv + Content-Disposition │
  │◀────────────┤ el navegador baja el archivo    │                │               │
```

**Por qué el CSV se arma server-side**: es el entregable que se va al flujo del
sismólogo. Si lo armara el cliente, las columnas `distance_km` y `coda_magnitude`
saldrían de la copia TS de las fórmulas — y una deriva entre las dos copias
produce un CSV con números que no coinciden con lo que la pantalla mostró. El
cliente calcula para el FEEDBACK INMEDIATO (mostrar "82 km" mientras se marca);
el backend calcula para el ARTEFACTO. Ambas copias se testean contra los mismos
valores calculados a mano, y la verificación por mutación rompe las dos.

---

## Interfaces / Contracts

### 1. `GET /stations/{channel}/waveform` — MODIFICADO (Fase 1)

```python
@app.get("/stations/{channel}/waveform", tags=["stations"])
async def get_station_waveform(
    channel: str,
    minutes: int = Query(1440, ge=1, le=1440, description="Ventana hacia atrás"),
    points: int = Query(38400, ge=100, le=50000, description="Pares min/max a devolver"),
    filter: str = Query("none", pattern="^(none|bp)$", description="bp = Butterworth 1-10 Hz"),
    start: datetime | None = Query(None, description="Inicio ISO-8601 UTC (ventana absoluta)"),
    end: datetime | None = Query(None, description="Fin ISO-8601 UTC (ventana absoluta)"),
) -> dict:
```

**Reglas de validación** (todas 422, con `detail` explícito):

| Condición | Mensaje |
|---|---|
| `channel` no tiene 4 partes | `channel debe ser NET.STA.LOC.CHA` (existente) |
| sólo uno de `start`/`end` | `start y end deben ir juntos` |
| `start`/`end` + `minutes` explícito | `start/end y minutes son mutuamente excluyentes` |
| `end <= start` | `end debe ser posterior a start` |
| `end - start > 24 h` | `la ventana no puede superar 24 horas` |
| `start` naive (sin tz) | se asume UTC — **no** se rechaza (ver nota) |

> **Nota sobre naive vs aware**: este repo ya se quemó con `utcnow()` naive
> desplazando la hora rotulada. La regla acá es explícita: **cualquier datetime
> sin tzinfo se interpreta como UTC y se convierte a aware con
> `replace(tzinfo=timezone.utc)` en el borde del endpoint**. De ahí para adentro
> todo es aware. Nunca se usa `datetime.utcnow()`.

> **Detección de "`minutes` explícito"**: FastAPI no distingue un default de un
> valor pasado igual al default. La forma correcta es cambiar el default de
> `minutes` a `None` y resolverlo a 1440 dentro del handler cuando no hay
> `start`/`end`. Así `minutes=None` ⇒ no lo pasaron. **Esto no cambia el
> OpenAPI de forma incompatible**: el parámetro sigue siendo opcional con el
> mismo comportamiento efectivo.

**Response**: sin cambios de forma (`build_waveform_response` ya devuelve
`starttime`/`endtime` reales del trace, que es lo que el frontend necesita para
`timeToX`).

```jsonc
{
  "channel": "AK.FIRE..BHZ",
  "sampling_rate": 50.0,
  "starttime": "2026-08-23T14:00:00.000000Z",
  "endtime":   "2026-08-23T14:10:00.000000Z",
  "mins": [-1234.5, ...],
  "maxs": [ 1180.2, ...]
}
```

**Cache key**:

```python
# La ventana absoluta reemplaza a `minutes` en la key, no se suma:
# incluir ambos daría dos keys distintas para la misma ventana efectiva.
window_part = f"{start.isoformat()}~{end.isoformat()}" if start else f"m{minutes}"
cache_key = f"waveform:{channel}:{window_part}:{points}:{filter}"
```

- Con `minutes` ⇒ `waveform:AK.FIRE..BHZ:m1440:38400:none` (prefijo `m` para que
  un `minutes=1440` no pueda colisionar nunca con un timestamp).
- Con ventana ⇒ `waveform:AK.FIRE..BHZ:2026-08-23T14:00:00+00:00~2026-08-23T14:10:00+00:00:38400:none`
- Los `datetime` se normalizan a UTC ANTES de formatear: `14:00Z` y `11:00-03:00`
  son la misma ventana y deben dar la misma key.

**Test de mutación obligatorio de la key**: sacar `window_part` de la f-string y
confirmar por `rg` que se aplicó ⇒ el test de "dos ventanas distintas no
colisionan" DEBE ponerse rojo.

**Nota de TTL**: `spectrogram_cache_ttl_seconds` es el mismo para ventanas
relativas y absolutas. Es subóptimo (una ventana histórica es inmutable y podría
cachearse para siempre) pero **no se cambia en este cambio**: agregar un TTL
diferenciado es una optimización sin evidencia de que haga falta.

---

### 2. `GET /stations/{channel}/spectra` — NUEVO (Fase 3)

```python
@app.get("/stations/{channel}/spectra", tags=["stations"])
async def get_station_spectrum(
    channel: str,
    start: datetime = Query(..., description="Inicio ISO-8601 UTC"),
    end: datetime = Query(..., description="Fin ISO-8601 UTC"),
    filter: str = Query("none", pattern="^(none|bp)$"),
) -> dict:
```

`start`/`end` son **obligatorios** acá: un espectro "de las últimas 24 h" no
tiene sentido físico (promediaría el día entero en una sola FFT). Este endpoint
existe para una ventana concreta.

**Validación adicional a las de waveform**:

| Condición | Código | Mensaje |
|---|---|---|
| `end - start > 1 h` | 422 | `el espectro se calcula sobre ventanas de hasta 1 hora` |
| señal más corta que 2 muestras | 422 | `ventana demasiado corta para calcular espectro` |
| sin datos FDSN | 404 | `Sin datos FDSN para {channel}` (igual que waveform) |

> El techo de 1 h (más estricto que las 24 h de waveform) NO es arbitrario:
> la FFT es sobre la ventana COMPLETA sin decimar. A 50 Hz, 24 h son 4,3 M de
> muestras en float64 = ~35 MB por array, y `np.kaiser(n)` + `rfft` crean
> temporales del mismo tamaño. El techo protege la RAM del mismo modo que el de
> 24 h protege el de waveform.

**Response**:

```jsonc
{
  "channel": "AK.FIRE..BHZ",
  "sampling_rate": 50.0,          // ← el eje se dibuja con ESTO
  "max_freq_hz": 25.0,            // ← min(MAX_FREQ_HZ, fs/2); nunca una constante en TS
  "starttime": "2026-08-23T14:00:00.000000Z",
  "endtime":   "2026-08-23T14:01:00.000000Z",
  "npts": 3000,                   // muestras usadas (sin decimar) — auditable
  "filter": "none",
  "freqs":    [0.0, 0.0166, ...], // Hz, ya enmascarado a <= max_freq_hz
  "power_db": [42.1, 51.8, ...]   // 20*log10(|FFT|), MISMA longitud que freqs
}
```

Invariante que el test verifica: `len(freqs) == len(power_db)`. Un desalineo de
un elemento corre TODO el espectro y no lanza ninguna excepción.

**Módulo nuevo** `src/services/signal_spectrum.py`:

```python
"""Espectro 1D (Power vs Hz) de una ventana completa — paridad SWARM.

A diferencia de swarm_spectrogram_db (que corta la señal en bins solapados y
devuelve una matriz), acá la ventana ENTERA es un solo bin: una FFT, un
espectro. Es el corte 1D que SWARM muestra bajo la onda.

Las constantes se IMPORTAN de swarm_spectra: son la misma referencia física.
Redefinirlas acá haría que el corte 1D y el 2D de la misma ventana dieran
números distintos.
"""

import numpy as np

from src.services.swarm_spectra import (
    DB_MULTIPLIER,
    KAISER_BETA,
    MAX_FREQ_HZ,
    _EPS,
)


def window_spectrum_db(data: np.ndarray, fs: float) -> tuple[np.ndarray, np.ndarray]:
    """(freqs, power_db) de la ventana completa. Demean + Kaiser + rfft."""
    signal = np.asarray(data, dtype=np.float64)
    if signal.size < 2:
        raise ValueError(f"ventana de {signal.size} muestras: insuficiente")
    signal = signal - signal.mean()
    spec = np.abs(np.fft.rfft(signal * np.kaiser(signal.size, KAISER_BETA)))
    freqs = np.fft.rfftfreq(signal.size, 1.0 / fs)
    mask = freqs <= effective_max_freq_hz(fs)
    return freqs[mask], DB_MULTIPLIER * np.log10(spec[mask] + _EPS)


def effective_max_freq_hz(fs: float) -> float:
    """Techo real del eje: Nyquist si el canal es más lento que la vista SWARM."""
    return float(min(MAX_FREQ_HZ, fs / 2))
```

**Cache key**:

```python
cache_key = f"spectra:{channel}:{start_utc.isoformat()}~{end_utc.isoformat()}:{filter}"
```

Sin `points`: el espectro no se decima, así que no hay parámetro de resolución.
La longitud de salida la determina la ventana y `fs`.

---

### 3. `GET /stations/{channel}/rsam` — NUEVO (Fase 4)

**Decisión de ruta**: `/stations/{channel}/rsam`, hermana de `waveform` y
`spectra`.

**Alternativas descartadas y por qué**:
- `/rsam/{channel}` — rompe el agrupamiento. Los tres endpoints responden la
  pregunta *"¿qué muestra este canal en esta ventana?"*; ponerlos bajo prefijos
  distintos obliga a recordar tres formas de URL para la misma pantalla.
- `/stations/{channel}/metrics?kind=rsam` — un endpoint genérico con un
  discriminador. Rechazado: hoy hay un solo tipo de serie; el parámetro sería
  una abstracción sin segundo caso, y el `response_model` tendría que ser una
  unión para nada.
- `/stations/{channel}/rsam/series` — el sufijo `/series` no distingue nada
  porque no existe un `/rsam` escalar en esta ruta (el número instantáneo del
  muro sale del payload de live-channels, no de acá).

**Gotcha de orden de rutas ya documentado en el repo**: cualquier ruta
ESTÁTICA bajo `/stations/` (como `/stations/search`, `main.py:2548-2549`) va
declarada ANTES de las paramétricas. `rsam` es un segmento fijo DESPUÉS del
parámetro, así que no compite — pero la regla se anota igual para que quien
agregue `/stations/compare` no lo olvide.

```python
@app.get("/stations/{channel}/rsam", tags=["stations"])
async def get_station_rsam(
    channel: str,
    start: datetime = Query(..., description="Inicio ISO-8601 UTC"),
    end: datetime = Query(..., description="Fin ISO-8601 UTC"),
    period_seconds: int = Query(
        RSAM_PERIOD_SECONDS, ge=1, le=3600,
        description="Segundos por muestra RSAM (default: el de SWARM, 600)",
    ),
) -> dict:
```

**Response**:

```jsonc
{
  "channel": "AK.FIRE..BHZ",
  "sampling_rate": 50.0,
  "period_seconds": 600,
  "starttime": "2026-08-23T00:00:00.000000Z",
  "endtime":   "2026-08-24T00:00:00.000000Z",
  "samples": [
    {"t": "2026-08-23T00:05:00.000000Z", "value": 34.2},   // t = CENTRO de la ventana
    {"t": "2026-08-23T00:15:00.000000Z", "value": 41.7}
  ]
}
```

- `t` es el **centro** de cada ventana, coherente con `computeTime()` de SWARM
  que ya usa `swarm_spectrogram_db` (`swarm_spectra.py:84`). Poner el borde
  izquierdo desalinearía el gráfico RSAM del espectrograma por medio período.
- Sin filtro: RSAM se define sobre la señal cruda demeaned (`rsam_sample` ya
  hace su propio demean por ventana). Agregar `filter` acá sería inventar una
  variante que SWARM no tiene.
- La última ventana parcial se **descarta**: una ventana de 90 s promediada como
  si fuera de 600 s produce un valor que no es comparable con los demás.

**Función nueva en `src/services/swarm_rsam.py`** (no toca `RsamAccumulator`):

```python
def rsam_series(
    data: np.ndarray, fs: float, period_s: int = RSAM_PERIOD_SECONDS
) -> list[float]:
    """Una muestra RSAM por ventana contigua de `period_s`.

    Reusa rsam_sample(): el número del muro y el punto del gráfico salen de la
    MISMA fórmula. Si divergieran, comparar las dos pantallas sería mentira.

    Las ventanas son contiguas y NO solapadas (a diferencia del espectrograma):
    RSAM es una media móvil por período, no una STFT.
    """
    per_window = int(period_s * fs)
    if per_window <= 0 or data.size < per_window:
        return []
    n_windows = data.size // per_window  # la cola parcial se descarta a propósito
    blocks = np.asarray(data[: n_windows * per_window], dtype=np.float64)
    return [rsam_sample(block) for block in blocks.reshape(n_windows, per_window)]
```

**Cache key**:

```python
cache_key = f"rsam:{channel}:{start_utc.isoformat()}~{end_utc.isoformat()}:{period_seconds}"
```

---

### 4. CRUD de picks — NUEVO (Fase 5)

Router propio en `src/api/routers/picks.py` (patrón `walls.py`), montado con
`app.include_router(picks_router.router)`. **No van en `main.py`**: los
endpoints autenticados de este repo viven en routers.

```python
router = APIRouter(prefix="/stations/{channel}/picks", tags=["picks"])
```

**Modelos** (`src/models/signal_pick.py`, patrón `wall.py` — `user_id` NUNCA en
el body):

```python
class PickPhase(str, Enum):
    P = "P"
    S = "S"
    CODA = "coda"


class SignalPickCreate(BaseModel):
    phase: PickPhase
    pick_time: datetime          # instante ABSOLUTO UTC de la fase
    note: str | None = Field(None, max_length=280)


class SignalPickPublic(BaseModel):
    id: UUID
    channel: str
    phase: PickPhase
    pick_time: datetime
    note: str | None
    created_at: datetime
    updated_at: datetime


class PickMeasurements(BaseModel):
    """Derivadas de los picks de una ventana. None cuando faltan las fases."""
    sp_seconds: float | None      # tS - tP
    distance_km: float | None     # d = (tS-tP)*(vp*vs)/(vp-vs)
    coda_seconds: float | None    # tCoda - tP
    coda_magnitude: float | None  # Mc = 1.86*log10(t) - 0.85
```

**Endpoints**:

| Método | Ruta | Auth | Request | Response |
|---|---|---|---|---|
| `GET` | `/stations/{channel}/picks?start=&end=` | sesión | query `start`/`end` opcionales | `{picks: [SignalPickPublic], measurements: PickMeasurements}` |
| `POST` | `/stations/{channel}/picks` | sesión | `SignalPickCreate` | `201 SignalPickPublic` |
| `PUT` | `/stations/{channel}/picks/{pick_id}` | sesión | `SignalPickCreate` | `200 SignalPickPublic` / `404` |
| `DELETE` | `/stations/{channel}/picks/{pick_id}` | sesión | — | `204` / `404` |
| `GET` | `/stations/{channel}/picks/export.csv?start=&end=` | sesión | — | `text/csv` |

> Gotcha del repo, verificado en `walls.py:76-77`: el `DELETE` con `status_code=204`
> **no lleva anotación de retorno**. Un `-> None` con 204 aborta el arranque de
> FastAPI.

> Gotcha de orden de rutas: `export.csv` es un segmento estático que compite con
> `{pick_id}`. Va declarado ANTES, igual que `/walls/global` antes de
> `/walls/{wall_id}`.

**Formato del CSV** (una fila por pick, columnas derivadas repetidas por grupo):

```csv
channel,phase,pick_time_utc,note,sp_seconds,distance_km,coda_seconds,coda_magnitude
AK.FIRE..BHZ,P,2026-08-23T14:03:12.400Z,,11.400,82.371,,
AK.FIRE..BHZ,S,2026-08-23T14:03:23.800Z,,11.400,82.371,,
AK.FIRE..BHZ,coda,2026-08-23T14:04:45.000Z,,,,92.600,2.812
```

**Servicio** `src/services/signal_picks.py` — dos partes claramente separadas:

```python
# --- Fórmulas sismológicas (SWARM event/PickData.java, CC0) ---------------
# Las constantes NO se declaran acá: vienen del JSON compartido con el frontend
# (ver Decision 9). Declararlas en este archivo reintroduce exactamente la
# deriva que la Decision 9 elimina.
#
# Carga a nivel de módulo, UNA vez. Si el archivo falta o le falta una clave,
# esto revienta al importar — y así tiene que ser: un KeyError al arrancar es
# infinitamente mejor que una distancia equivocada en un CSV.
_CONSTANTS_PATH = (
    Path(__file__).resolve().parents[2] / "dashboard" / "lib" / "seismic-constants.json"
)
_C = json.loads(_CONSTANTS_PATH.read_text(encoding="utf-8"))

P_VELOCITY_KM_S: float = _C["pVelocityKmS"]
VP_VS_RATIO: float = _C["vpVsRatio"]
S_VELOCITY_KM_S = P_VELOCITY_KM_S / VP_VS_RATIO

# Mc = CODA_A * log10(t) + CODA_B  (t en segundos)
CODA_A: float = _C["codaA"]
CODA_B: float = _C["codaB"]


def sp_distance_km(sp_seconds: float) -> float | None:
    """Distancia epicentral desde el intervalo S-P de UNA estación.

    d = (tS - tP) * (vp * vs) / (vp - vs)

    Una sola estación da DISTANCIA, no ubicación: el epicentro está en algún
    punto del círculo de radio d. La localización real necesita tres estaciones
    y está explícitamente fuera del alcance de este cambio.
    """
    if not math.isfinite(sp_seconds) or sp_seconds <= 0:
        return None
    vp, vs = P_VELOCITY_KM_S, S_VELOCITY_KM_S
    return sp_seconds * (vp * vs) / (vp - vs)


def coda_magnitude(coda_seconds: float) -> float | None:
    """Mc = 1.86 * log10(t) - 0.85 — magnitud por duración de coda."""
    if not math.isfinite(coda_seconds) or coda_seconds <= 0:
        return None
    return CODA_A * math.log10(coda_seconds) + CODA_B


# --- CRUD (patrón WallService: pool prestado, ownership en el WHERE) -------
class SignalPickNotFoundError(Exception): ...


class SignalPickService:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool
    ...
```

La copia TS (`dashboard/lib/signal-picks.ts`) exporta las mismas constantes con
los mismos nombres y las mismas fórmulas, y su test usa **los mismos valores
esperados calculados a mano** que el test de Python. Si un día divergen, los dos
tests no pueden estar verdes a la vez.

---

## Database Design: `signal_picks`

### Qué identifica un pick

Un pick es **una fase marcada por un usuario en un canal en un instante**. Las
cuatro dimensiones son necesarias:

- **canal** — la misma onda P se ve en varias estaciones; son picks distintos.
- **instante absoluto** — NO un offset dentro de una ventana ni un `x` de
  píxel. La misma ventana con otro `points` da otro `x`; una ventana distinta
  da otro offset. El instante UTC es lo único invariante, y es lo que permite
  redibujar el pick al volver con otro zoom.
- **tipo de fase** — P, S y coda del mismo evento son tres filas.
- **usuario** — dos personas marcan la P del mismo sismo en instantes
  ligeramente distintos y las dos tienen razón. No hay picks compartidos.

**Qué NO se pone**: `event_id`. Agrupar picks por evento sísmico requiere
decidir qué es "el mismo evento" (¿ventana temporal? ¿correlación?) y eso es un
diseño propio. En esta fase los picks se agrupan **por ventana consultada**, que
es lo que la UI necesita y lo que el `GET ?start=&end=` ya da.

### Migración

```sql
-- deploy/sql/migrations/015_signal_picks.sql
--
-- Picking manual de fases sísmicas por usuario (spec analiticas-profesionales-senal,
-- Fase 5). Patrón de 013_walls.sql: tabla propia, ownership por user_id con
-- CASCADE, índices IF NOT EXISTS para que la migración sea re-ejecutable.
--
-- Por qué tabla propia y no un JSON en users.settings: los picks son N por
-- usuario Y por canal, se consultan por rango temporal (el wave view pide los
-- picks de la ventana visible) y se exportan a CSV. Un JSONB no se indexa por
-- rango sin trabajo extra y la consulta natural es un BETWEEN.
--
-- pick_time es TIMESTAMPTZ y NO un offset dentro de una ventana: la misma onda
-- se mira con zooms distintos, y un offset sólo tiene sentido relativo a la
-- ventana en la que se marcó. El instante absoluto sobrevive a cualquier zoom.
--
-- La UNIQUE (user_id, channel, phase, pick_time) hace idempotente el POST desde
-- un doble clic: marcar la MISMA fase en el MISMO instante dos veces es un
-- accidente de UI, no dos mediciones. Marcar dos P en instantes distintos SÍ es
-- legítimo (dos eventos en la misma ventana), y por eso pick_time está en la
-- clave: no se restringe a una P por canal.

CREATE TABLE IF NOT EXISTS signal_picks (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel    TEXT NOT NULL,
    phase      TEXT NOT NULL,
    pick_time  TIMESTAMPTZ NOT NULL,
    note       TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- El CHECK va inline (no como índice) porque no necesita ser re-ejecutable
    -- por separado: si la tabla existe, el constraint ya está.
    CONSTRAINT signal_picks_phase_check CHECK (phase IN ('P', 'S', 'coda')),
    CONSTRAINT signal_picks_note_len CHECK (note IS NULL OR char_length(note) <= 280)
);

-- Idempotencia del POST (ver comentario de cabecera). Índice separado, no
-- constraint inline, para que la migración sea re-ejecutable con IF NOT EXISTS
-- (mismo criterio que walls_user_id_name_key).
CREATE UNIQUE INDEX IF NOT EXISTS signal_picks_user_channel_phase_time_key
    ON signal_picks (user_id, channel, phase, pick_time);

-- La consulta caliente es exactamente esta: "los picks de ESTE usuario en ESTE
-- canal dentro de ESTA ventana". El orden de las columnas es el de la
-- selectividad de la query, no alfabético.
CREATE INDEX IF NOT EXISTS signal_picks_user_channel_time_idx
    ON signal_picks (user_id, channel, pick_time);

-- Rollback:
-- ATENCIÓN: dropear la tabla BORRA mediciones reales de usuarios. Si hay picks
-- guardados, el rollback correcto es revertir el código de la UI y dejar la
-- tabla huérfana hasta decidir qué hacer con esos datos. Sólo dropear si
-- SELECT count(*) FROM signal_picks; devuelve 0.
--
-- DROP INDEX IF EXISTS signal_picks_user_channel_time_idx;
-- DROP INDEX IF EXISTS signal_picks_user_channel_phase_time_key;
-- DROP TABLE IF EXISTS signal_picks;
```

**Nota sobre `phase`**: `TEXT` + `CHECK` y no un `ENUM` de Postgres. Los enums
de Postgres necesitan `ALTER TYPE ... ADD VALUE` para crecer y eso no corre
dentro de una transacción en versiones viejas; un `CHECK` se cambia con un
`ALTER TABLE` normal. El repo no usa enums de Postgres en ninguna migración
existente.

---

## Frontend Modules

### `dashboard/lib/waveform-scale.ts` (Fase 2) — lógica pura

```ts
/** Ventana temporal absoluta. Los dos extremos en ms epoch UTC. */
export interface TimeWindow {
  startMs: number;
  endMs: number;
}

/**
 * Ventana mínima. NO es un número de gusto: `timeToX` divide por
 * (endMs - startMs). Con 0 el resultado es Infinity/NaN y el canvas no dibuja
 * NADA sin lanzar ninguna excepción — el mismo modo de falla silenciosa que
 * `effectiveClip` evita en helicorder-settings.ts.
 */
export const MIN_WINDOW_MS = 1_000;
/** Techo del backend (24 h). Pedir más da 422; clampear acá evita el viaje. */
export const MAX_WINDOW_MS = 24 * 60 * 60 * 1_000;

/** Instante → píxel. Inversa exacta de xToTime. */
export function timeToX(tMs: number, w: TimeWindow, plotWidth: number): number;

/** Píxel → instante. timeToX(xToTime(x)) === x salvo redondeo de float. */
export function xToTime(x: number, w: TimeWindow, plotWidth: number): number;

/**
 * Ventana válida: extremos ordenados, duración en [MIN, MAX].
 * Al expandir una ventana degenerada, expande SIMÉTRICO alrededor del centro
 * (mover sólo un extremo desplazaría lo que el usuario quiso mirar).
 */
export function clampWindow(w: TimeWindow): TimeWindow;

/**
 * Zoom anclado al cursor: el instante bajo el cursor queda en el MISMO píxel
 * después del zoom. Sin el anclaje, hacer zoom sobre un evento lo saca de
 * pantalla y el usuario tiene que buscarlo de nuevo.
 * `factor` < 1 acerca, > 1 aleja. Devuelve una ventana YA clampeada.
 */
export function zoomWindow(
  w: TimeWindow, anchorX: number, plotWidth: number, factor: number,
): TimeWindow;

/**
 * Arrastre → ventana. Normaliza: arrastrar de derecha a izquierda es un gesto
 * legítimo y debe dar la misma ventana que el inverso.
 * Devuelve null si el arrastre fue un clic (|x2-x1| por debajo del umbral):
 * un clic accidental no debe disparar un fetch.
 */
export function dragSelection(
  x1: number, x2: number, plotWidth: number, w: TimeWindow,
): TimeWindow | null;
```

**Tests obligatorios** (con verificación por mutación):

| Test | Mutación que lo DEBE romper |
|---|---|
| ida y vuelta `timeToX(xToTime(x)) ≈ x` para 5 valores de x | invertir el signo en `xToTime` |
| `clampWindow` con `start === end` devuelve `MIN_WINDOW_MS` | `MIN_WINDOW_MS = 0` |
| `clampWindow` expande simétrico (el centro no se mueve) | expandir sólo `endMs` |
| `zoomWindow` deja el instante del ancla en el mismo píxel | ignorar `anchorX` y centrar |
| `dragSelection(380, 120)` === `dragSelection(120, 380)` | sacar el swap |
| `dragSelection` con Δx=1 devuelve `null` | bajar el umbral a 0 |

### `dashboard/lib/helicorder-hit.ts` (Fase 1)

```ts
/**
 * Clic en el helicorder → ventana absoluta.
 *
 * El helicorder dibuja `rows` filas de `timeChunkMinutes` cada una, con
 * MARGIN_LEFT/MARGIN_RIGHT reservados para las etiquetas. La fila sale de `y`,
 * el offset dentro de la fila sale de `x` — y ese offset sólo es válido dentro
 * del área de trazado, no sobre los márgenes.
 *
 * Devuelve null cuando el clic cayó en un margen: no hay instante ahí, y
 * devolver el borde más cercano abriría una ventana que el usuario no señaló.
 */
export function helicorderHitToWindow(params: {
  x: number; y: number;
  width: number; height: number;
  marginLeft: number; marginRight: number;
  rows: number; timeChunkMinutes: number;
  startMs: number;          // `starttime` de la respuesta, ya parseado
  windowSeconds?: number;   // duración a abrir alrededor del clic (default 120)
}): TimeWindow | null;
```

La ventana se abre **centrada** en el instante clickeado (`±windowSeconds/2`),
no empezando en él: el usuario hace clic sobre el evento que ve, y quiere verlo
con contexto a ambos lados.

`HelicorderCanvas` recibe una prop nueva `onSelectWindow?: (w: TimeWindow) => void`.
Cuando está presente: `cursor: pointer` y `onClick` que llama a
`helicorderHitToWindow` con la geometría que el componente ya tiene. Cuando no
está: el componente se comporta exactamente como hoy (**la prop es opcional para
que el helicorder siga funcionando en la pestaña actual sin cambios**).

### `dashboard/lib/progressive-disclosure.ts` (transversal)

```ts
/**
 * Progresividad POR INTERACCIÓN.
 *
 * No es un toggle básico/avanzado y no es todo visible siempre: las
 * herramientas aparecen cuando el usuario ya usó las anteriores. El objetivo
 * es que el principiante no vea una cabina de avión, y que el que ya sabe no
 * tenga que buscar un switch escondido.
 *
 * Toda la regla vive acá, en funciones puras. Ningún componente decide su
 * propia visibilidad: si la regla estuviera repartida en condicionales de JSX,
 * el riesgo "aparece nunca / aparece de más" sería imposible de testear sin
 * montar el árbol entero — y la sexta herramienta copiaría el umbral a mano en
 * un sexto lugar.
 *
 * Tolerancia idéntica a helicorder-settings.ts: clamps + fallback a defaults +
 * JSON corrupto NO rompe la vista.
 */

/** Lo que el usuario hizo. Contadores monótonos, nunca decrecen. */
export interface UserProgress {
  /** Ventanas de onda abiertas (clic en helicorder o zoom). */
  windowsOpened: number;
  /** Veces que miró el espectro 1D. */
  spectraViewed: number;
  /** Veces que miró la serie RSAM. */
  rsamViewed: number;
  /** Escape hatch: el usuario pidió ver todo. Gana sobre cualquier umbral. */
  revealAll: boolean;
}

export type ToolId = 'wave' | 'spectrum' | 'rsam' | 'picking' | 'export';

export type ToolVisibility = Record<ToolId, boolean>;

/**
 * Umbrales. Un solo objeto: subirlos al infinito es el rollback parcial sin
 * deploy que la propuesta pide como feature flag.
 */
export const DISCLOSURE_THRESHOLDS = {
  /** El wave view está disponible desde el principio: es el escalón base. */
  wave: 0,
  /** Espectro 1D: después de haber abierto ventanas. */
  spectrumAfterWindows: 3,
  /** RSAM: mismo escalón que el espectro, otra puerta. */
  rsamAfterWindows: 3,
  /** Picking: exige haber usado alguna herramienta analítica. */
  pickingAfterSpectraOrRsam: 2,
  /** Export: sólo tiene sentido con picks hechos; lo abre el picking. */
} as const;

export const PROGRESS_DEFAULTS: UserProgress = {
  windowsOpened: 0, spectraViewed: 0, rsamViewed: 0, revealAll: false,
};

/** Techo de los contadores: no cambia ninguna decisión y evita overflow y
 *  claves de storage que crecen sin fin. */
export const MAX_COUNTER = 9_999;

/** LA regla. Función pura: mismo progreso ⇒ misma visibilidad, siempre. */
export function visibleTools(p: UserProgress): ToolVisibility;

/** Registrar una interacción. Devuelve un progreso NUEVO (no muta). */
export function recordInteraction(
  p: UserProgress, event: 'window' | 'spectrum' | 'rsam',
): UserProgress;

/** Escape hatch. Persistente: quien lo pidió una vez no lo pide de nuevo. */
export function revealAllTools(p: UserProgress): UserProgress;

export function progressStorageKey(): string; // 'signal-progress' — global, no por canal
export function loadProgress(): UserProgress;   // tolera ausencia y JSON corrupto
export function saveProgress(p: UserProgress): void; // tolera cuota llena
```

**Por qué el progreso es GLOBAL y no por canal** (a diferencia de
`helicorder-settings`, que es por canal): el progreso mide **qué aprendió el
usuario**, no cómo quiere ver un canal específico. Alguien que ya marcó fases en
`AK.FIRE..BHZ` no es un principiante cuando abre `IU.MAJO.00.BHZ`. Esconderle el
picking ahí sería castigar el haber cambiado de estación.

**Por qué localStorage y no la base** (a diferencia de los picks): el progreso
es una preferencia de UI, no una medición. Perderlo al cambiar de navegador
significa que la primera visita muestra menos herramientas y un clic en "ver
todo" lo arregla. Perder un pick es perder trabajo. **Esa asimetría es
deliberada y es la misma línea que separa `helicorder-settings` de
`signal_picks`.**

**Reglas de tolerancia** (copiadas literalmente del patrón de
`helicorder-settings.ts:102-141`):
- `typeof localStorage === 'undefined'` ⇒ defaults. SSR y modo privado son el
  caso normal, no un error.
- `JSON.parse` en `try/catch` ⇒ defaults al fallar.
- Cada contador pasa por `clampCounter(Number(v))`: `NaN`, negativo, `Infinity`
  y `"3"` ⇒ un entero en `[0, MAX_COUNTER]`.
- `revealAll` sólo es `true` si es literalmente `true` (un `"true"` string no
  cuenta — la coerción silenciosa es exactamente cómo se cuela un valor basura).
- `saveProgress` en `try/catch`: cuota llena ⇒ se pierde la preferencia, no se
  rompe la vista.

**Trampa de React a evitar explícitamente en el consumo**: el progreso se carga
en un `useEffect`, NUNCA en `useState(loadProgress())`. Leer `localStorage`
durante el render da HTML distinto en servidor y cliente (hydration mismatch) —
el mismo motivo por el que `page.tsx:49-63` ya carga los settings por efecto.

### Componentes nuevos

| Componente | Fase | Responsabilidad | Qué NO hace |
|---|---|---|---|
| `WaveView` | 2 | Dibuja la onda de UNA ventana; captura el arrastre; delega geometría a `waveform-scale.ts` | No decide la ventana ni hace fetch (eso es del hook) |
| `SpectrumView` | 3 | Dibuja Power vs Hz con el eje derivado de `sampling_rate`/`max_freq_hz` de la respuesta | No calcula FFT ni tiene constantes de frecuencia |
| `RsamChart` | 4 | Dibuja la serie temporal de `samples[]` | No calcula RSAM |
| `PickingOverlay` | 5 | Capa sobre `WaveView`: líneas P/S/coda, atajos de teclado, panel de mediciones | No persiste (llama al hook); no calcula las fórmulas (llama a la lib) |

### Hooks nuevos

```ts
// dashboard/hooks/use-wave-window.ts (Fase 2)
export function useWaveWindow(channel: string, initial?: TimeWindow): {
  window: TimeWindow | null;
  data: WaveformResponse | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  canGoBack: boolean;
  setWindow(w: TimeWindow): void;   // pushea la actual a la pila
  goBack(): void;                   // popea
  reset(): void;                    // vacía la pila y vuelve a `initial`
};

// dashboard/hooks/use-signal-picks.ts (Fase 5)
export function useSignalPicks(channel: string, window: TimeWindow | null): {
  picks: SignalPick[];
  measurements: PickMeasurements;
  addPick(phase: PickPhase, tMs: number): Promise<void>;
  removePick(id: string): Promise<void>;
  status: 'idle' | 'loading' | 'ready' | 'error';
};
```

**`useWaveWindow` — invariantes de implementación** (las tres trampas del repo):

1. El estado arranca en `null` y se siembra por efecto. **Nunca**
   `useState(initial ?? derivarDeAlgoAsync())`.
2. La pila va en `useState` (necesita re-render para `canGoBack`), no en `useRef`.
3. El `AbortController` va en `useRef` pero se **usa dentro del mismo efecto que
   lo crea**. Ningún efecto lee un ref que no está en sus deps.

---

## File Changes

### Backend

| File | Action | Fase | Description |
|---|---|---|---|
| `src/services/spectrogram_service.py` | Modify | 1 | `get_waveform_data` y `_get_waveform_sync` aceptan `starttime`/`endtime` opcionales; sin ellos, comportamiento idéntico |
| `src/main.py` (~2580) | Modify | 1 | `waveform` acepta `start`/`end`; validaciones; `cache_key` con `window_part` |
| `src/main.py` | Modify | 3 | `GET /stations/{channel}/spectra` |
| `src/main.py` | Modify | 4 | `GET /stations/{channel}/rsam` |
| `src/main.py` | Modify | 5 | `include_router(picks_router.router)` + `app.state.signal_pick_service` en el lifespan |
| `src/services/signal_spectrum.py` | Create | 3 | `window_spectrum_db`, `effective_max_freq_hz`; importa constantes de `swarm_spectra` |
| `src/services/swarm_rsam.py` | Modify | 4 | `rsam_series()` nueva; `RsamAccumulator` intacto |
| `src/services/signal_picks.py` | Create | 5 | Fórmulas S-P y coda + `SignalPickService` (CRUD) + armado del CSV |
| `src/models/signal_pick.py` | Create | 5 | `PickPhase`, `SignalPickCreate/Public`, `PickMeasurements` |
| `src/api/routers/picks.py` | Create | 5 | CRUD + export, patrón `walls.py` |
| `deploy/sql/migrations/015_signal_picks.sql` | Create | 5 | Tabla, índices, rollback comentado |
| `src/services/seedlink_ingestor.py` | **None** | — | **Decisión cerrada: NO se toca** |
| `src/adapters/` | None | — | La fuente de datos no cambia |
| `src/workers/` | None | — | **No existe** pese a que `config.yaml` lo nombra |

### Frontend

| File | Action | Fase | Description |
|---|---|---|---|
| `dashboard/lib/helicorder-hit.ts` | Create | 1 | Clic → `TimeWindow`; `null` en los márgenes |
| `dashboard/components/HelicorderCanvas.tsx` | Modify | 1 | Prop opcional `onSelectWindow?`; cursor condicional |
| `dashboard/lib/waveform-scale.ts` | Create | 2 | `timeToX`/`xToTime`/`clampWindow`/`zoomWindow`/`dragSelection` |
| `dashboard/hooks/use-wave-window.ts` | Create | 2 | Fetch + pila de zoom + abort |
| `dashboard/components/WaveView.tsx` | Create | 2 | Canvas de la onda + captura del arrastre |
| `dashboard/app/(app)/stations/[channel]/page.tsx` | Modify | 2 | Pestaña `wave` a `enabled: true` (línea 37) |
| `dashboard/components/SpectrumView.tsx` | Create | 3 | Power vs Hz, eje derivado del dato |
| `dashboard/components/RsamChart.tsx` | Create | 4 | Serie temporal |
| `dashboard/app/(app)/stations/[channel]/page.tsx` | Modify | 4 | Pestaña `rsam` a `enabled: true` (línea 38) |
| `dashboard/lib/signal-picks.ts` | Create | 5 | Fórmulas (copia TS) + tipos |
| `dashboard/hooks/use-signal-picks.ts` | Create | 5 | CRUD contra la API |
| `dashboard/components/PickingOverlay.tsx` | Create | 5 | Líneas P/S/coda, atajos, panel de mediciones |
| `dashboard/lib/progressive-disclosure.ts` | Create | transversal | Regla pura + persistencia tolerante |
| `dashboard/lib/api.ts` | Modify | 1-5 | Métodos nuevos del cliente |
| `dashboard/lib/station-metrics.ts` | Modify | 4 | RSAM deja de ser sólo el campo `il` |
| `dashboard/messages/es.json` + `en.json` | Modify | 1-5 | Paridad obligatoria de cada clave nueva |

---

## Testing Strategy

| Layer | Qué se testea | Cómo |
|---|---|---|
| Unit (py) | `window_spectrum_db` sobre sinusoide sintética de frecuencia conocida | El pico DEBE caer en ese bin (`argmax(power_db)` ⇒ `freqs[i] ≈ f0` con tolerancia de un bin) |
| Unit (py) | `effective_max_freq_hz` con fs=20 y fs=100 | 10.0 y 25.0 — dos canales, dos techos |
| Unit (py) | `rsam_series` sobre señal constante y sobre señal de amplitud conocida | Valores calculados a mano; cola parcial descartada |
| Unit (py) | `sp_distance_km`, `coda_magnitude` | **Valores calculados a mano**, nunca "devuelve un número" |
| Unit (py) | Validaciones del endpoint | 422 por cada regla de la tabla, con el `detail` esperado |
| Unit (py) | Composición de la `cache_key` | Dos ventanas absolutas distintas ⇒ keys distintas; `14:00Z` y `11:00-03:00` ⇒ MISMA key |
| Unit (ts) | `waveform-scale.ts` | La tabla de tests + mutaciones de arriba |
| Unit (ts) | `helicorder-hit.ts` | Clic en margen ⇒ `null`; clic en fila 3 al 50% ⇒ instante esperado a mano |
| Unit (ts) | `progressive-disclosure.ts` | Cada umbral: justo debajo ⇒ oculto, justo encima ⇒ visible; `revealAll` gana; JSON corrupto ⇒ defaults; `"true"` string NO activa `revealAll` |
| Unit (ts) | `signal-picks.ts` | **Los mismos valores esperados que el test de Python** |
| Integration (py) | CRUD de picks contra testcontainer `postgres:16-alpine` | Ownership: el pick de otro usuario da 404. Doble POST idéntico ⇒ una fila (UNIQUE). CASCADE: borrar el usuario borra sus picks |
| Integration (ts) | `useWaveWindow` con fetch mockeado | Dos zooms seguidos ⇒ el primero abortado; la respuesta tardía de una ventana vieja NO pisa el estado |
| E2E / manual | Curl contra el servidor real | `?start=&end=` devuelve la ventana pedida (criterio de éxito de la propuesta) |
| E2E / manual | QA visual del usuario | Por fase: levantar el stack, URL exacta, lista de qué mirar |

### Verificación por mutación — OBLIGATORIA

No es una buena práctica opcional en este cambio: es criterio de aceptación.
Este repo produjo **tres tests verdes que no podían fallar nunca**, y **dos de
los tres los especificó el plan**. Con fórmulas sismológicas el daño es peor: un
test verde certifica una distancia falsa.

**Protocolo, sin atajos:**

1. Aplicar la mutación.
2. **Confirmar con `rg` que el archivo cambió.** Una mutación que no muta no
   prueba nada — este repo ya tuvo un `sd` multilínea que falló en silencio y el
   verde se leyó como si probara algo.
3. Correr el test.
4. Registrar: qué se rompió, la salida del `rg`, qué test se puso rojo.
5. Revertir.

**Tabla de mutaciones requeridas:**

| # | Archivo | Mutación | Test que DEBE ponerse rojo |
|---|---|---|---|
| 1 | `seismic-constants.json` | `pVelocityKmS 6.0 → 7.0` | distancia S-P **en Python Y en TS** (un solo rojo ⇒ hay una copia escondida) |
| 2 | `seismic-constants.json` | `vpVsRatio 1.73 → 1.60` | distancia S-P **en ambos lados** |
| 3 | `seismic-constants.json` | `codaA 1.86 → 2.00` | magnitud de coda **en ambos lados**. Ojo: el caso `t = 1 s` queda VERDE (`log10(1)=0` anula el coeficiente) — por eso el spec exige el caso de 60 s |
| 4 | `seismic-constants.json` | `codaB -0.85 → -0.50` | magnitud de coda **en ambos lados** |
| 5 | `seismic-constants.json` | Borrar la clave `pVelocityKmS` | Python revienta al IMPORTAR (`KeyError`), no cae a un default silencioso |
| 6 | `swarm_spectra.py` | `KAISER_BETA 5 → 8` | **el test del espectro 1D** (si sigue verde, hay una copia escondida — Decision 5) |
| 7 | `swarm_spectra.py` | `DB_MULTIPLIER 20 → 10` | el test del espectro 1D |
| 8 | `swarm_spectra.py` | `MAX_FREQ_HZ 25 → 50` | el test de dos canales, dos ejes |
| 9 | `main.py` | Sacar `window_part` de la `cache_key` | el test de colisión de ventanas |
| 10 | `waveform-scale.ts` | `MIN_WINDOW_MS 1000 → 0` | el test de ventana degenerada |
| 11 | `swarm_rsam.py` | Cambiar `np.mean(np.abs(...))` por `np.mean(...)` en `rsam_sample` | el test de `rsam_series` con valores a mano |
| 12 | `progressive-disclosure.ts` | `spectrumAfterWindows 3 → 0` | el test del umbral "justo debajo ⇒ oculto" |

### Comandos verificados del entorno

```bash
# Backend (el venv está en venv/, NO en .venv/)
./venv/bin/python -m pytest tests/ -q
# Los tests de integración necesitan Docker arriba (testcontainer postgres:16-alpine)

# Frontend — desde dashboard/, NUNCA con npx (npx se baja un vitest ajeno)
export PATH="$HOME/.nvm/versions/node/v22.16.0/bin:$PATH"
cd dashboard && ./node_modules/.bin/vitest run
cd dashboard && ./node_modules/.bin/tsc --noEmit

# NUNCA: next build  (comparte .next con el server de dev y se lo rompe al usuario)
```

Baseline al abrir el cambio: **633 tests / 65 archivos** en frontend.

---

## Migration / Rollout

**Fases 1-4: sin esquema.** Todo aditivo. `git revert` del commit de la fase.
Los parámetros `start`/`end` son opcionales y `minutes` sigue siendo el default
⇒ ningún cliente existente cambia. Las pestañas vuelven a `enabled: false` y la
UI queda como hoy.

**Fase 5: con migración.** `015_signal_picks.sql` es aditiva: ninguna tabla
existente se modifica. El bloque de rollback está comentado al pie con la
advertencia de que **dropear borra mediciones reales**. Orden de despliegue:
migración primero, código después (la tabla vacía no molesta a nadie; el código
sin tabla da 500).

**Feature flag gratis.** La progresividad da un rollback parcial sin deploy:
subir `DISCLOSURE_THRESHOLDS` esconde las herramientas avanzadas. **Salvedad
honesta**: los umbrales son constantes compiladas en el bundle, así que
"sin deploy" es cierto sólo si se convierten en config remota; tal como está
diseñado, cambiarlos ES un deploy de frontend — pero uno de una línea, sin
tocar backend ni base. Esa es la diferencia real, y conviene no venderla como
más de lo que es.

**Orden de fases.** Estricto: 1 → (2, 3, 4 en cualquier orden) → 5. Las Fases
2-5 no pueden empezar sin la 1. La progresividad se implementa junto con la
Fase 2 (antes no hay nada que revelar) y se extiende en cada fase siguiente.

---

## Open Questions

Ninguna que bloquee la implementación. Tres decisiones tomadas dentro del margen
del diseño, que se registran por si el usuario quiere corregirlas antes de
codificar:

- [x] **Techo de 1 h para `/spectra`** (ratificado por el usuario, 2026-08-26) (vs. las 24 h de waveform). Justificado
      por RAM: la FFT es sobre la señal sin decimar. Si en uso real 1 h se queda
      corta, el número se sube con evidencia.
- [x] **La ventana del clic en el helicorder es de 120 s centrada** (ratificado, 2026-08-26). Es el orden
      de magnitud de un evento local visible en una franja de 30 min. Ajustable
      tras el primer QA visual.
- [x] **Umbrales de progresividad (3 ventanas / 2 usos)** (ratificado, 2026-08-26). Son un punto de
      partida razonable, no un dato medido. La lib pura hace que cambiarlos sea
      una línea y un test.
