# Tasks: Analíticas profesionales de señal (paridad moderna con SWARM)

> **Orden estricto de fases**: 1 → (2, 3, 4 en cualquier orden) → 5.
> Las Fases 2-5 NO pueden empezar sin la Fase 1.
> **Cada fase cierra en un estado desplegable**: al terminar sus tareas el
> producto está mergeable y desplegable sin la siguiente.
>
> **Convenciones no negociables de este change:**
> - Identificadores en INGLÉS, comentarios y docstrings en ESPAÑOL.
> - Comillas simples en TS (el repo no tiene config de prettier).
> - Backend: `./venv/bin/python -m pytest` (el venv está en `venv/`, NO en `.venv/`).
> - Frontend: `export PATH="$HOME/.nvm/versions/node/v22.16.0/bin:$PATH"` y
>   `cd dashboard && ./node_modules/.bin/vitest run` — **NUNCA `npx`** (se baja
>   un vitest ajeno y da errores falsos de JSX).
> - Tipos: `cd dashboard && ./node_modules/.bin/tsc --noEmit`.
> - **NUNCA correr `next build`**: comparte `.next` con el server de dev y se lo
>   rompe al usuario en la pantalla.
> - Tests de integración: necesitan Docker arriba (testcontainer `postgres:16-alpine`).
> - Baseline al abrir el change: **633 tests / 65 archivos** en frontend.

---

## Phase 0: Preparación transversal (una sola vez, antes de la Fase 1)

- [x] 0.1 **HECHO (2026-08-24)**: backend **852 passed** (81% cov), frontend
      **772 passed / 74 archivos**. La estimación del diseño (633/65) estaba
      vieja. Registrado en `mutation-log.md`.
      Registrar la baseline real ANTES de tocar nada: correr
      `./venv/bin/python -m pytest tests/ -q` y
      `cd dashboard && ./node_modules/.bin/vitest run`, y anotar el conteo exacto
      (esperado frontend: 633 tests / 65 archivos). Sin la baseline registrada no
      se puede afirmar después que "la suite quedó verde".
- [x] 0.2 **HECHO**: creado con el protocolo de 5 pasos, la baseline y las 12
      mutaciones pendientes listadas.
      Crear `openspec/changes/analiticas-profesionales-senal/mutation-log.md`
      con una tabla vacía de columnas: `#`, `archivo`, `mutación`, `salida del rg`,
      `test que se puso rojo`, `revertido (sí/no)`. Es el registro que exige el
      criterio de aceptación de la propuesta; cada tarea de mutación de las fases
      siguientes escribe una fila acá.

---

## Phase 1: Ventana absoluta — el desbloqueo (backend + clic del helicorder)

**Estado desplegable al cerrar la fase**: el endpoint acepta `start`/`end`, el
clic del helicorder produce una ventana, y ningún cliente existente cambió de
comportamiento. Nada de UI nueva.

### 1.A — El candado del SERVICE (esto es lo que hace que la feature funcione)

- [x] 1.1 **HECHO**. En `src/services/spectrogram_service.py`, modificar `_get_waveform_sync`
      (línea 503, el `end_time = UTCDateTime()` de la **línea 520** es el candado)
      para aceptar `starttime: datetime | None` y `endtime: datetime | None`
      opcionales (UTC-aware). Cuando vienen, se usan tal cual convertidos a
      `UTCDateTime`; cuando no, el comportamiento es idéntico al actual
      (`end = UTCDateTime()`, `start = end - duration_hours*3600`).
      **El loop de failover entre servidores FDSN (líneas ~526-548) NO se duplica
      ni se toca**: es la misma implementación para ambos modos.
      *Criterio de aceptación*: `rg -n "UTCDateTime\(\)" src/services/spectrogram_service.py`
      muestra que ese `UTCDateTime()` ya sólo se evalúa en la rama sin ventana.
- [x] 1.2 **HECHO** (ojo: `run_in_executor` pasa argumentos POSICIONALES; los dos
      nuevos van al final y el orden debe coincidir con la firma).
      En el mismo archivo, propagar los dos parámetros opcionales por
      `get_waveform_data` (línea 563) hasta `_get_waveform_sync`, con la misma
      semántica y los mismos defaults `None`.
      **Nota de por qué esta tarea existe**: si sólo se toca el handler de
      `main.py`, la feature "se implementa" y devuelve la ventana de AHORA
      igual — el parámetro que falta es de la capa de datos (Decision 1).
- [x] 1.3 **HECHO**: `tests/unit/test_spectrogram_service_window.py`, 6 tests que
      asertan sobre los kwargs de `get_waveforms`. **Verificado por mutación**
      (`if ... :` → `if False:`): 4 rojos, y los 2 del modo relativo quedaron
      verdes, que es lo correcto. Registrado en `mutation-log.md`.
      Test unitario en `tests/unit/test_station_waveform.py` (o archivo nuevo
      `tests/unit/test_spectrogram_service_window.py`) con el cliente FDSN
      mockeado: verificar que al pasar `starttime`/`endtime` el mock recibe
      EXACTAMENTE esos límites, y que sin ellos recibe una ventana anclada a ahora.
      *No basta con "devuelve datos"*: el aserto es sobre los argumentos con los
      que se llamó a `get_waveforms`.

### 1.B — El endpoint y su validación

- [x] 1.4 En `src/main.py:2580-2586` (`get_station_waveform`), cambiar la firma de
      `minutes` a `int | None = Query(None, ge=1, le=1440, ...)` y resolver el
      default 1440 **aguas abajo, dentro del handler**, sólo cuando no hay
      `start`/`end`. Es la única forma de distinguir "no lo mandaron" de "lo
      mandaron en 1440" y poder validar la exclusión mutua (FastAPI no distingue
      un default de un valor pasado igual al default).
- [x] 1.5 Agregar los parámetros `start: datetime | None` y `end: datetime | None`
      al handler, y normalizar en el BORDE: cualquier datetime sin `tzinfo` se
      interpreta como UTC con `replace(tzinfo=timezone.utc)`. **Nunca
      `datetime.utcnow()`** (este repo ya rotuló 5:10 "UTC" siendo las 02:10).
- [x] 1.6 Implementar las 5 validaciones, todas 422 con body `{"detail": ...}` y
      **antes de cualquier fetch a FDSN** (una ventana inválida no debe producir
      tráfico saliente):
      | Condición | Mensaje |
      |---|---|
      | sólo uno de `start`/`end` | `start y end deben ir juntos` |
      | `start`/`end` + `minutes` explícito | `start/end y minutes son mutuamente excluyentes` |
      | `end <= start` | `end debe ser posterior a start` |
      | `end - start > 24 h` | `la ventana no puede superar 24 horas` |
      | `channel` sin 4 partes | `channel debe ser NET.STA.LOC.CHA` (existente, no romper) |
- [x] 1.7 Modificar la `cache_key` (`src/main.py:2604`) a la forma con `window_part`:
      `window_part = f"{start.isoformat()}~{end.isoformat()}" if start else f"m{minutes}"`
      y `cache_key = f"waveform:{channel}:{window_part}:{points}:{filter}"`.
      El prefijo `m` es obligatorio para que un `minutes=1440` no pueda colisionar
      con un timestamp. **Los datetime se normalizan a UTC ANTES de formatear**:
      `14:00Z` y `11:00-03:00` son la misma ventana y deben dar la MISMA key.
      La ventana absoluta **reemplaza** a `minutes` en la key, no se suma.
- [x] 1.8 Verificar que el resultado vacío de FDSN (404) NO se guarda en cache
      (un vacío puede venir de un timeout transitorio y cachearlo deja la ventana
      muerta por todo el TTL). Si el código actual ya lo hace, dejar constancia en
      el test; si no, arreglarlo.

### 1.C — Tests del endpoint (spec `backend-api`)

- [x] 1.9 En `tests/unit/test_station_waveform_endpoint.py`, agregar los escenarios
      de validación de la spec, uno por regla: `end < start` → 422; `end == start`
      → 422 (**escenario separado a propósito**: fija el borde en `>` y no `>=`);
      24 h + 1 s → 422; exactamente 24 h → NO 422; `start` sin `end` → 422;
      `start`+`end`+`minutes` explícito → 422; `start=ayer` (formato inválido) →
      422. En todos: verificar el body `{"detail": ...}` **y** que el servicio
      FDSN mockeado no fue llamado.
- [x] 1.10 **Test explícito de retro-compatibilidad** (obligatorio): reproducir el
      llamado actual de `dashboard/components/HelicorderCanvas.tsx:96-99`, que NO
      manda `minutes` — `GET /stations/AK.FIRE..BHZ/waveform?points=...&filter=...`
      — y verificar que sigue devolviendo 24 h (`duration_hours` pedido a FDSN es
      el de 1440 min). **Esta es la tarea que impide que el cambio de `minutes` a
      `None` rompa al único cliente en producción.** Agregar también el caso
      `minutes=90` → `duration_hours = max(1, ceil(90/60)) = 2`.
- [x] 1.11 Tests de la `cache_key`: dos ventanas absolutas distintas ⇒ keys
      distintas y **la segunda produce una llamada NUEVA a FDSN**; la misma
      ventana ⇒ se sirve del cache sin segunda llamada; ventana relativa de 60 min
      y ventana absoluta de 60 min ⇒ keys distintas; `filter=none` vs `filter=bp`
      ⇒ keys distintas; `14:00Z` y `11:00-03:00` ⇒ MISMA key.
- [x] 1.12 **Mutación #9** (tabla del diseño): sacar `window_part` de la f-string
      de la `cache_key` en `src/main.py`. Protocolo completo: aplicar → confirmar
      con `rg -n "cache_key = f\"waveform" src/main.py` que el archivo cambió →
      correr `./venv/bin/python -m pytest tests/unit/test_station_waveform_endpoint.py -q`
      → registrar en `mutation-log.md` qué test se puso rojo (debe ser el de
      colisión de ventanas) → revertir. **Si la mutación no aparece en el `rg`, la
      mutación no se aplicó y el verde no prueba nada.**

### 1.D — Clic del helicorder → ventana (frontend, lógica pura)

- [x] 1.13 Crear `dashboard/lib/helicorder-hit.ts` con `helicorderHitToWindow`
      según el contrato del diseño: recibe `{x, y, width, height, marginLeft,
      marginRight, rows, timeChunkMinutes, startMs, windowSeconds = 120}` y
      devuelve `TimeWindow | null`. La ventana se abre **centrada** en el instante
      clickeado (`T - W/2`, `T + W/2`), recortada al rango del helicorder.
      Devuelve `null` cuando el clic cae en un margen: no hay instante ahí y
      devolver el borde más cercano abriría una ventana que el usuario no señaló.
      El tipo `TimeWindow` se declara acá o en `waveform-scale.ts`, pero **una
      sola vez** (si la Fase 2 no está hecha, va acá y la Fase 2 lo importa).
- [x] 1.14 Crear `dashboard/lib/helicorder-hit.test.ts` con los 5 escenarios de la
      spec `signal-analysis`, cada uno con valor esperado calculado a mano: clic en
      la primera columna de la primera fila ⇒ `T0`; clic en la última columna de la
      última fila ⇒ `endMs <= T0 + 24h`; ventana centrada (`T - W/2`, `T + W/2`);
      clic a menos de `W/2` del inicio ⇒ `startMs === T0` exacto y duración > 0;
      clic en el margen ⇒ `null`. *Un test que sólo verifique `startMs < endMs`
      pasaría con un mapeo lineal completamente equivocado.*
- [x] 1.15 En `dashboard/components/HelicorderCanvas.tsx`, agregar la prop
      **opcional** `onSelectWindow?: (w: TimeWindow) => void`. Con la prop
      presente: `cursor: pointer` y `onClick` que llama a `helicorderHitToWindow`
      con la geometría que el componente ya tiene. Sin la prop: el componente se
      comporta **exactamente como hoy**. La opcionalidad es lo que permite mergear
      la Fase 1 sin la Fase 2.
- [x] 1.16 En `dashboard/components/HelicorderCanvas.test.tsx`, agregar el
      escenario de la spec `dashboard-ui`: renderizado SIN el callback, el cursor
      NO cambia a `pointer` y un clic no dispara nada.
- [x] 1.17 Agregar en `dashboard/lib/api.ts` el soporte de `start`/`end` en el
      método de waveform (parámetros opcionales, sin cambiar la firma para los
      llamadores actuales).

### 1.E — Cierre de fase

- [x] 1.18 Correr la suite completa de ambos lados y `tsc --noEmit`. Frontend
      `>=` baseline (633) y 0 errores de tipos.
- [x] 1.19 **Verificación con curl contra el servidor REAL** (criterio de éxito de
      la propuesta, no se sustituye con mocks): levantar el backend y ejecutar
      `curl "http://localhost:8000/stations/AK.FIRE..BHZ/waveform?start=2026-08-20T10:00:00Z&end=2026-08-20T11:00:00Z"`,
      confirmar 200 y que `starttime`/`endtime` de la respuesta caen dentro de la
      ventana pedida. Probar también los 422 de la tabla 1.6.
- [ ] 1.20 **QA visual del usuario — Fase 1.** Preparar y entregarle: (a) levantar
      el stack (backend + `cd dashboard && npm run dev`, **sin `next build`**);
      (b) URL exacta: `http://localhost:3000/es/stations/AK.FIRE..BHZ`;
      (c) lista de qué mirar: el helicorder se ve igual que antes; el cursor NO es
      `pointer` todavía (la prop no está cableada aún en esta pantalla); nada se
      rompió en la pestaña de espectrograma. **El QA visual lo hace el usuario**:
      canvas + MCP de navegador no funcionan en este entorno.

---

## Phase 2: Wave view (escalón "aficionado") + progresividad inicial

**Estado desplegable al cerrar la fase**: la pestaña `wave` funciona con zoom que
re-pide al backend, pila de "volver atrás" y toggle de filtro. Las Fases 3-5 no
existen todavía y no hacen falta.

### 2.A — Escalado puro

- [x] 2.1 Crear `dashboard/lib/waveform-scale.ts` con `TimeWindow`,
      `MIN_WINDOW_MS = 1_000`, `MAX_WINDOW_MS = 24*60*60*1000`, y las firmas
      `timeToX`, `xToTime`, `clampWindow`, `zoomWindow`, `dragSelection` del
      diseño. `clampWindow` expande **simétrico alrededor del centro** (mover sólo
      un extremo desplazaría lo que el usuario quiso mirar). `zoomWindow` deja el
      instante bajo el cursor en el MISMO píxel. `dragSelection` normaliza el
      arrastre invertido y devuelve `null` si `|x2-x1|` está por debajo del
      umbral (un clic accidental no debe disparar un fetch).
      *Por qué `MIN_WINDOW_MS` no es un número de gusto*: `timeToX` divide por
      `(endMs - startMs)`; con 0 da `Infinity`/`NaN` y el canvas no dibuja NADA
      sin lanzar ninguna excepción.
- [x] 2.2 Crear `dashboard/lib/waveform-scale.test.ts` con la tabla completa de
      tests del diseño, todos con valores esperados a mano:
      ida y vuelta `xToTime(timeToX(t)) ≈ t` para 5 valores de `t`;
      `timeToX(start) === 0` y `timeToX(end) === 1000`;
      `clampWindow` con `start === end` ⇒ duración exactamente `MIN_WINDOW_MS`;
      `clampWindow` expande simétrico (el centro NO se mueve);
      **`zoomWindow` sobre `[0,100]` con ancla en `25` y factor 0.5 ⇒ `[12.5, 62.5]`**
      (valor distinto del `[25,75]` que daría un zoom centrado — un test que sólo
      verificara "la duración se redujo a la mitad" no distinguiría ambos);
      `dragSelection(800, 200) === dragSelection(200, 800)`;
      `dragSelection` con Δx=1 ⇒ `null`.
- [x] 2.3 **Mutación #10**: `MIN_WINDOW_MS 1000 → 0` en `waveform-scale.ts`.
      Aplicar → `rg -n "MIN_WINDOW_MS" dashboard/lib/waveform-scale.ts` para
      confirmar → correr vitest → registrar en `mutation-log.md` que el test de
      ventana degenerada quedó rojo → revertir.

### 2.B — El hook (las 3 trampas de React son criterios de aceptación)

- [x] 2.4 Crear `dashboard/hooks/use-wave-window.ts` con el contrato del diseño:
      `{window, data, status, canGoBack, setWindow, goBack, reset}`.
      **Criterios de aceptación explícitos, no comentarios:**
      1. El estado de la ventana **arranca en `null`** y se siembra por un efecto
         con `channel` en deps. **Prohibido** `useState(initial ?? derivarDeAlgoAsync())`:
         con una prop asíncrona el estado queda clavado en el default y NUNCA se
         recalcula (este repo tiene CUATRO variantes del mismo pecado).
      2. La pila va en **`useState`**, NO en `useRef`. Un ref no dispara re-render
         y `canGoBack` quedaría muerto para siempre aunque la pila tenga
         elementos. Además, un efecto que LEE un ref sin tenerlo en deps corre una
         vez y nunca más (pisado TRES veces en este repo).
      3. El `AbortController` va en `useRef` pero se **usa dentro del mismo efecto
         que lo crea**; ningún efecto lee un ref que no está en sus deps.
- [x] 2.5 Implementar las tres defensas de race condition del diagrama de
      secuencia: ① abortar el request en vuelo al iniciar el siguiente;
      ④ descartar la respuesta si el `AbortSignal` ya está abortado;
      ⑤ **guarda de ventana tardía**: comparar la ventana de la respuesta contra la
      ventana ACTUAL del estado antes de aplicar; distinta ⇒ se descarta.
      Cleanup del efecto con `abort()` + flag `cancelled` al desmontar (mismo
      patrón que `HelicorderCanvas.tsx:87,113-115`).
- [x] 2.6 Crear `dashboard/hooks/use-wave-window.test.ts` con `fetch` mockeado:
      dos zooms seguidos ⇒ el primero queda abortado; **una respuesta tardía de
      una ventana vieja NO pisa el estado** (este es el test que prueba la guarda
      ⑤); la pila permite volver atrás `W2 → W1 → W0` y una tercera vez sigue en
      `W0` sin desbordar a `null`; `canGoBack` es `false` con pila vacía y `true`
      con elementos (si este aserto no se puede poner rojo moviendo la pila a un
      ref, el test está mirando la variable equivocada).

### 2.C — El componente y la pestaña

- [x] 2.7 Crear `dashboard/components/WaveView.tsx`: dibuja la onda de UNA ventana
      y captura el arrastre. **No decide la ventana ni hace fetch** (eso es del
      hook) y **no tiene geometría propia** (delega en `waveform-scale.ts`).
      Durante el `mousemove` sólo pinta el rectángulo de selección; el fetch sale
      recién en el `mouseup`.
- [x] 2.8 Exponer el toggle del filtro Butterworth en `WaveView`. **El backend ya
      lo tiene y el frontend ya lo manda** (`HelicorderCanvas.tsx:98`): esta tarea
      es exponer el control existente, no construir el filtro. Cambiar el filtro
      **re-pide** (cambia el dato), a diferencia de `clipMult`/`barMult` del
      helicorder que sólo repintan.
- [x] 2.9 En `dashboard/app/(app)/stations/[channel]/page.tsx:37`, pasar la
      pestaña `wave` a `enabled: true` y renderizar `WaveView`. Cablear
      `onSelectWindow` en el `HelicorderCanvas` de esa página para que el clic
      cambie a la pestaña `wave` con la ventana traducida.
      **Regla**: una pestaña NO queda habilitada apuntando a una vista vacía.
- [x] 2.10 Crear `dashboard/components/WaveView.test.tsx`: la pestaña `wave` no
      muestra el rótulo "próximamente"; un arrastre dispara **una petición nueva**
      (aserto sobre el contador de llamadas al fetch, **no sobre el resultado
      visual**: un re-render sin petición se ve parecido y es incorrecto).

### 2.D — Progresividad (arranca acá: antes no hay nada que revelar)

- [x] 2.11 Crear `dashboard/lib/progressive-disclosure.ts` con el contrato completo
      del diseño: `UserProgress`, `ToolId`, `ToolVisibility`,
      `DISCLOSURE_THRESHOLDS`, `PROGRESS_DEFAULTS`, `MAX_COUNTER = 9_999`,
      `visibleTools`, `recordInteraction`, `revealAllTools`, `progressStorageKey`
      (`'signal-progress'` — **global, no por canal**), `loadProgress`,
      `saveProgress`.
      El progreso es global porque mide **qué aprendió el usuario**, no cómo
      quiere ver un canal: quien ya marcó fases en `AK.FIRE..BHZ` no es
      principiante al abrir `IU.MAJO.00.BHZ`.
- [x] 2.12 Implementar la tolerancia copiando el patrón de
      `dashboard/lib/helicorder-settings.ts:102-141`:
      `typeof localStorage === 'undefined'` ⇒ defaults (SSR y modo privado son el
      caso normal, no un error); `JSON.parse` en `try/catch` ⇒ defaults;
      cada contador por `clampCounter(Number(v))` (`NaN`, negativo, `Infinity`,
      `"3"` ⇒ entero en `[0, MAX_COUNTER]`); `revealAll` sólo `true` si es
      **literalmente** `true` (un `"true"` string NO cuenta); `saveProgress` en
      `try/catch` para la cuota llena.
- [x] 2.13 Crear `dashboard/lib/progressive-disclosure.test.ts` con los pares de
      borde de la spec: para CADA umbral, "justo debajo ⇒ oculto" y "justo encima
      ⇒ visible" (**el par es obligatorio**: con un solo test, cambiar `>=` por
      `>` o el umbral a 0 quedaría en verde); `revealAll` gana sobre cualquier
      umbral; JSON corrupto (`"{no-es-json"`) ⇒ defaults sin lanzar; contador
      negativo y absurdamente grande ⇒ recortados; el string `"true"` NO activa
      `revealAll`; **subir los umbrales por encima del progreso registrado esconde
      la herramienta y NO borra el progreso** (esto prueba que la regla se evalúa
      en cada render y que no se persiste el nivel resuelto).
- [x] 2.14 **Mutación #12**: `spectrumAfterWindows 3 → 0` en
      `progressive-disclosure.ts`. Aplicar → confirmar con
      `rg -n "spectrumAfterWindows" dashboard/lib/progressive-disclosure.ts` →
      correr vitest → registrar que el test "justo debajo ⇒ oculto" quedó rojo →
      revertir.
- [x] 2.15 Cablear el progreso en la página de estación: **cargarlo en un
      `useEffect`, NUNCA en `useState(loadProgress())`** — leer `localStorage`
      durante el render da HTML distinto en servidor y cliente (hydration
      mismatch); es el mismo motivo por el que `page.tsx:49-63` ya carga los
      settings por efecto. Registrar `recordInteraction(p, 'window')` en cada
      ventana abierta (clic del helicorder o zoom).
- [x] 2.16 Agregar el escape hatch "mostrar todas las herramientas" en la UI,
      persistente entre visitas.

### 2.E — i18n y cierre de fase

- [x] 2.17 Agregar todas las cadenas nuevas de la Fase 2 en
      `dashboard/messages/es.json` **Y** `dashboard/messages/en.json`. Cero
      literales de interfaz en el JSX. Correr
      `./node_modules/.bin/vitest run messages/parity.test.ts` (el test de paridad
      ya existe en `dashboard/messages/parity.test.ts`).
- [x] 2.18 Suite completa verde en ambos lados + `tsc --noEmit` en 0. Conteo
      frontend `>=` baseline.
- [ ] 2.19 **QA visual del usuario — Fase 2.** Entregarle: (a) levantar el stack
      (backend + `npm run dev`, sin `next build`); (b) URL exacta
      `http://localhost:3000/es/stations/AK.FIRE..BHZ`; (c) lista de qué mirar:
      la pestaña `wave` ya no dice "próximamente"; el cursor sobre el helicorder
      es `pointer`; un clic sobre un evento visible abre esa ventana en el wave
      view; arrastrar sobre la onda hace zoom **y en la pestaña de red del
      navegador aparece un request NUEVO** (si no aparece, está mal por
      definición); "volver atrás" vuelve al nivel anterior; el toggle del filtro
      cambia el trazo; en la primera visita NO se ven controles de espectro 1D ni
      de picking.

---

## Phase 3: Espectro 1D (Power vs Hz)

**Estado desplegable al cerrar la fase**: endpoint `/spectra` + `SpectrumView`
detrás de su umbral de progresividad. Las Fases 4 y 5 siguen sin existir.

- [x] 3.1 Crear `src/services/signal_spectrum.py` con `window_spectrum_db(data, fs)`
      y `effective_max_freq_hz(fs)` según el diseño. **IMPORTA** `KAISER_BETA`,
      `DB_MULTIPLIER`, `MAX_FREQ_HZ` y `_EPS` de `src/services/swarm_spectra.py`.
      **PROHIBIDO declarar literales `5` para beta o `20` para el multiplicador en
      este módulo**: el corte 1D y el 2D de la misma ventana tienen que dar los
      mismos números (Decision 5). Ventaneo sobre la ventana COMPLETA (una sola
      FFT), no por bins como el espectrograma.
- [x] 3.2 Test `tests/unit/test_signal_spectrum.py` — sinusoide sintética de 5.0 Hz
      muestreada a 100.0 Hz, de duración suficiente para resolución < 0.5 Hz: el
      `argmax(power_db)` cae en un bin a ±0.5 Hz de 5.0 Hz.
- [x] 3.3 Test de `effective_max_freq_hz`: `fs=20 ⇒ 10.0` y `fs=100 ⇒ 25.0`.
      **El valor 10.0 es distinto tanto de `MAX_FREQ_HZ` (25.0) como de `fs`
      (20.0)**: un test cuyo valor esperado coincidiera con la constante no podría
      distinguir la implementación correcta de una que devuelve la constante —
      exactamente el defecto de "valor esperado igual al fallback" que este repo
      ya produjo.
- [x] 3.4 Test del invariante de longitud: `len(freqs) == len(power_db)`. Un
      desalineo de un elemento corre TODO el espectro y no lanza ninguna excepción.
- [x] 3.5 Test de que el espectro NO se calcula sobre datos decimados: comparar el
      espectro del módulo contra el que resultaría de aplicar la FFT a los pares
      min/max de `build_waveform_response` para la misma señal; sólo el primero
      pone el pico en el bin real.
- [x] 3.6 **Mutaciones #6, #7 y #8** (una fila cada una en `mutation-log.md`):
      #6 `KAISER_BETA 5 → 8` en `swarm_spectra.py` ⇒ debe poner rojo un test del
      espectro 1D (si queda verde, hay una copia escondida de la constante);
      #7 `DB_MULTIPLIER 20 → 10` ⇒ debe poner rojo un test que verifique un
      **valor de potencia en dB**, no sólo la posición del pico (el multiplicador
      NO cambia dónde cae el pico — si no hay un test de valor en dB, hay que
      escribirlo);
      #8 `MAX_FREQ_HZ 25 → 50` ⇒ debe poner rojo el test de dos canales, dos ejes.
      En las tres: confirmar con `rg -n "KAISER_BETA|DB_MULTIPLIER|MAX_FREQ_HZ" src/services/swarm_spectra.py`
      ANTES de leer el resultado, y revertir después.
- [x] 3.7 Agregar `GET /stations/{channel}/spectra` en `src/main.py` con la firma
      del diseño. `start`/`end` son **obligatorios** acá (un espectro "de las
      últimas 24 h" no tiene sentido físico: promediaría el día entero en una sola
      FFT). Reusar el helper de validación de ventana de la Fase 1.
- [x] 3.8 Validaciones adicionales del endpoint: `end - start > 1 h` ⇒ 422
      `el espectro se calcula sobre ventanas de hasta 1 hora` (el techo protege la
      RAM: la FFT es sobre la señal SIN decimar; a 50 Hz, 24 h son 4,3 M de
      muestras en float64 ≈ 35 MB por array, y `np.kaiser` + `rfft` crean
      temporales del mismo tamaño); señal de menos de 2 muestras ⇒ 422; sin datos
      FDSN ⇒ 404 con `{"detail": ...}`; `end <= start` ⇒ 422.
- [x] 3.9 `cache_key = f"spectra:{channel}:{start_utc.isoformat()}~{end_utc.isoformat()}:{filter}"`
      — sin `points`: el espectro no se decima, así que no hay parámetro de
      resolución. Test de que dos ventanas distintas no colisionan.
- [x] 3.10 Tests del endpoint en `tests/unit/`: la respuesta declara
      `sampling_rate` y `max_frequency_hz`; con `fs=40.0` ⇒ `max_frequency_hz ==
      20.0` (manda Nyquist sobre `MAX_FREQ_HZ`); dos canales `fs=20` y `fs=100` ⇒
      ejes `10.0` y `25.0`, **y los dos ejes NO son iguales entre sí**.
- [x] 3.11 Crear `dashboard/components/SpectrumView.tsx`: dibuja Power vs Hz con el
      eje derivado de `sampling_rate`/`max_frequency_hz` **de la respuesta**.
      **Ninguna constante de frecuencia máxima vive en TS**: medido en producción,
      el techo varía entre 10, 20 y 25 Hz y un eje constante miente por factor 2,5.
      El componente no calcula FFT.
- [x] 3.12 Cablear `SpectrumView` detrás de `visibleTools(progress).spectrum` y
      registrar `recordInteraction(p, 'spectrum')` en cada uso.
- [x] 3.13 Test de `SpectrumView` que verifique que el eje se dibuja con el valor
      de la respuesta: dos respuestas mockeadas con `max_frequency_hz` distinto
      producen ejes distintos.
- [x] 3.14 Método de `/spectra` en `dashboard/lib/api.ts` + cadenas nuevas en
      `es.json` **Y** `en.json` con el test de paridad verde.
- [x] 3.15 Suite completa verde + `tsc --noEmit` en 0 + curl real contra
      `/stations/{channel}/spectra` con una ventana concreta.
- [ ] 3.16 **QA visual del usuario — Fase 3.** Entregarle: URL
      `http://localhost:3000/es/stations/AK.FIRE..BHZ` con la pestaña `wave`
      abierta; qué mirar: después de abrir 3 ventanas aparece el control de
      espectro 1D (antes NO); el espectro muestra un eje de frecuencia cuyo máximo
      coincide con el `max_frequency_hz` de la respuesta (verificable en la
      pestaña de red); el pico visual se corresponde con lo que se ve en el
      espectrograma 2D de la misma ventana.

---

## Phase 4: RSAM como serie temporal (ON-DEMAND, sin ingestor, sin migración)

**Estado desplegable al cerrar la fase**: pestaña `rsam` con la serie sobre
ventana absoluta. **Decisión cerrada del usuario**: NO se persisten muestras, NO
se toca `src/services/seedlink_ingestor.py`, NO hay migración en esta fase.

- [x] 4.1 Agregar `rsam_series(data, fs, period_s=RSAM_PERIOD_SECONDS)` en
      `src/services/swarm_rsam.py`. **Reusa `rsam_sample()`**: el número del muro
      y el punto del gráfico salen de la MISMA fórmula; si divergieran, comparar
      las dos pantallas sería una mentira. Ventanas **contiguas y NO solapadas**
      (RSAM es una media móvil por período, no una STFT). La cola parcial se
      **descarta a propósito**: una ventana de 90 s promediada como si fuera de
      600 s da un valor no comparable con los demás.
      **`RsamAccumulator` (líneas 36-75) NO se toca.**
- [x] 4.2 Tests en `tests/unit/test_swarm_rsam.py`: señal constante 1000 ⇒ todas
      las muestras valen exactamente `0.0` (la media de `|x - mean(x)|` de una
      constante es 0); onda que alterna exactamente entre `+100` y `-100` con la
      misma cantidad de cada signo ⇒ muestra exactamente `100.0`; cola parcial
      descartada (una señal de 1,5 períodos da 1 muestra, no 2).
- [x] 4.3 **Mutación #11**: cambiar `np.mean(np.abs(...))` por `np.mean(...)` en
      `rsam_sample` (o sea, omitir el demean/valor absoluto). Aplicar → confirmar
      con `rg -n "np.mean" src/services/swarm_rsam.py` → correr los tests →
      registrar que el test de señal constante quedó rojo (devolvería `1000.0` en
      vez de `0.0`) → revertir.
- [x] 4.4 Agregar `GET /stations/{channel}/rsam` en `src/main.py` con la firma del
      diseño (`start`, `end` obligatorios; `period_seconds` con default
      `RSAM_PERIOD_SECONDS = 600`, `ge=1, le=3600`). Reusar el helper de
      validación de ventana de la Fase 1 y el mismo camino FDSN.
      *Nota de orden de rutas*: `rsam` es un segmento fijo DESPUÉS del parámetro,
      así que no compite con `/stations/search`; la regla se anota igual para quien
      agregue una ruta estática nueva bajo `/stations/`.
- [x] 4.5 Cada muestra lleva su timestamp UTC y **`t` es el CENTRO de la ventana**,
      coherente con `computeTime()` de SWARM que ya usa `swarm_spectra.py:84`.
      Poner el borde izquierdo desalinearía el gráfico RSAM del espectrograma por
      medio período. Sin parámetro `filter`: RSAM se define sobre la señal cruda
      demeaned y `rsam_sample` ya hace su propio demean por ventana.
- [x] 4.6 `cache_key = f"rsam:{channel}:{start_utc.isoformat()}~{end_utc.isoformat()}:{period_seconds}"`
      con test de no colisión.
- [x] 4.7 Tests del endpoint: la serie cubre la ventana con timestamps
      **estrictamente crecientes**, el primero `>= start` y el último `<= end`;
      ventana > 24 h ⇒ 422 con `{"detail": ...}`.
- [x] 4.8 **Test de no-regresión del ingestor** (escenario de la spec): verificar
      en el diff de la fase que `src/services/seedlink_ingestor.py` no tiene
      cambios y que no se agregó ninguna migración —
      `git diff --name-only main -- src/services/seedlink_ingestor.py deploy/sql/migrations/`
      debe salir vacío. Verificar además que el `deque` en memoria sigue
      alimentando el campo `il` del muro sin cambio de comportamiento.
- [x] 4.9 Crear `dashboard/components/RsamChart.tsx`: dibuja la serie de
      `samples[]`. **No calcula RSAM.**
- [x] 4.10 En `dashboard/app/(app)/stations/[channel]/page.tsx:38`, pasar la
      pestaña `rsam` a `enabled: true` y renderizarla detrás de
      `visibleTools(progress).rsam`; registrar `recordInteraction(p, 'rsam')`.
- [x] 4.11 Actualizar `dashboard/lib/station-metrics.ts`: RSAM deja de ser sólo el
      campo `il`. **Sin romper el consumo actual del muro** (test de regresión del
      valor instantáneo).
- [x] 4.12 Método de `/rsam` en `dashboard/lib/api.ts` + cadenas nuevas en
      `es.json` **Y** `en.json`, test de paridad verde.
- [x] 4.13 Suite completa verde + `tsc --noEmit` en 0 + curl real contra
      `/stations/{channel}/rsam`.
- [ ] 4.14 **QA visual del usuario — Fase 4.** Entregarle: URL
      `http://localhost:3000/es/stations/AK.FIRE..BHZ`, pestaña `rsam`; qué mirar:
      la pestaña ya no dice "próximamente"; la serie dibuja puntos fechados sobre
      la ventana activa; el número instantáneo del muro (`/es/spectrograms`) sigue
      mostrándose igual que antes; cambiar la ventana en el wave view cambia la
      serie RSAM.

---

## Phase 5: Picking P/S/coda persistido (migración 015)

**Estado desplegable al cerrar la fase**: picks en la base por usuario, mediciones
S-P y coda, export CSV. Es la única fase con esquema.

### 5.A — La fuente única de constantes (VA PRIMERO, antes de cualquier fórmula)

- [x] 5.1 Crear `dashboard/lib/seismic-constants.json` con exactamente:
      ```json
      {
        "pVelocityKmS": 6.0,
        "vpVsRatio": 1.73,
        "codaA": 1.86,
        "codaB": -0.85
      }
      ```
      **Vive dentro de `dashboard/` y no es arbitrario**: `dashboard/tsconfig.json`
      tiene `"paths": {"@/*": ["./*"]}` e `"include"` relativos a `dashboard/`, así
      que TypeScript **no puede importar nada fuera de ese directorio**; Python sí
      puede leer hacia arriba. La restricción del lenguaje más rígido decide la
      ubicación.
- [x] 5.2 Verificar que `resolveJsonModule: true` sigue activo en
      `dashboard/tsconfig.json` (está en la línea 12) — sin eso el import de TS no
      compila.
- [x] 5.3 **Esta tarea es un candado, no una sugerencia**: NI Python NI TypeScript
      declaran esas cuatro constantes en su propio código. Al terminar la fase,
      `rg -n "6\.0|1\.73|1\.86|0\.85" src/services/signal_picks.py dashboard/lib/signal-picks.ts`
      NO debe mostrar ninguna de las cuatro como literal declarado.

### 5.B — Fórmulas: Python

- [x] 5.4 Crear `src/services/signal_picks.py` con la carga del JSON **a nivel de
      módulo, UNA sola vez**:
      `_CONSTANTS_PATH = Path(__file__).resolve().parents[2] / "dashboard" / "lib" / "seismic-constants.json"`
      (verificado que resuelve a la raíz del repo) y
      `_C = json.loads(_CONSTANTS_PATH.read_text(encoding="utf-8"))`.
      Exponer `P_VELOCITY_KM_S`, `VP_VS_RATIO`, `S_VELOCITY_KM_S = P/RATIO`,
      `CODA_A`, `CODA_B`. **Si el archivo falta o le falta una clave, revienta al
      IMPORTAR** — nunca cae a un default silencioso: un `KeyError` al arrancar es
      infinitamente mejor que una distancia equivocada en un CSV.
- [x] 5.5 Implementar `sp_distance_km(sp_seconds)` con
      `d = sp * (vp*vs)/(vp-vs)` y guarda para `sp <= 0` o no finito ⇒ `None`
      (nunca `0`, `NaN` ni `Infinity` silenciosos; nunca una distancia negativa).
      Docstring en español que aclare que una sola estación da **distancia**, no
      ubicación: el epicentro está en algún punto del círculo de radio `d`.
- [x] 5.6 Implementar `coda_magnitude(coda_seconds)` con
      `Mc = CODA_A * log10(t) + CODA_B` y guarda para `t <= 0` o no finito ⇒
      `None` (sin la guarda, `t=0` propaga `-Infinity` y `t<0` propaga `NaN` hasta
      la UI y el CSV). **No recortar a cero**: `Mc(1 s) = -0.85` es negativo y es
      correcto.
- [x] 5.7 Crear `tests/unit/test_signal_picks_formulas.py` con los valores
      **calculados a mano** de la spec, ninguno "devuelve un número":
      S-P 10.0 s ⇒ `82.1918` km (±0.001); S-P 5.0 s ⇒ `41.0959`; S-P 1.0 s ⇒
      `8.2192`; S-P `0` ⇒ `None`; S-P `-3.0` ⇒ `None` (sin la guarda daría
      `-24.657`, un número perfectamente serializable que la UI dibujaría como
      medición);
      coda 100 s ⇒ `2.87`; coda 10 s ⇒ `1.01`; coda 1 s ⇒ `-0.85`;
      **coda 60 s ⇒ `2.4574`** (este existe porque los otros tres usan potencias
      exactas de 10 donde `log10` da enteros: es el que detecta un `log` natural o
      un atajo por conteo de dígitos); coda `0` ⇒ `None`; coda `-5.0` ⇒ `None`.

### 5.C — Fórmulas: TypeScript (la copia deliberada)

- [x] 5.8 Crear `dashboard/lib/signal-picks.ts` que importa
      `@/lib/seismic-constants.json` y exporta las mismas constantes con los
      mismos nombres y las mismas fórmulas + los tipos de pick. **No declara
      ninguno de los cuatro valores.** El cliente calcula para el FEEDBACK
      INMEDIATO (mostrar "82 km" mientras se marca); el backend calcula para el
      ARTEFACTO (el CSV).
- [x] 5.9 Crear `dashboard/lib/signal-picks.test.ts` con **exactamente los mismos
      valores esperados calculados a mano** que `test_signal_picks_formulas.py`.
      Si un día las dos implementaciones divergen, los dos tests no pueden estar
      verdes a la vez.

### 5.D — Las 5 mutaciones del JSON compartido (el corazón de la Decision 9)

> Protocolo para las cinco: aplicar → **confirmar con
> `rg -n "pVelocityKmS|vpVsRatio|codaA|codaB" dashboard/lib/seismic-constants.json`
> que el archivo cambió** → correr AMBAS suites → registrar en `mutation-log.md`
> qué test se puso rojo **de cada lado** → revertir.
> **Un solo rojo significa que hay una copia escondida de la constante en el otro
> lado y la tarea NO está terminada.**

- [x] 5.10 **Mutación #1**: `pVelocityKmS 6.0 → 7.0`. Debe poner rojo el test de
      distancia S-P **en Python Y en TS**. Con vp mutado,
      `vs = 7.0/1.73 = 4.046242774566474`, factor `= 9.589041095890414`, y S-P de
      10 s daría `95.8904` km — que NO coincide con el esperado `82.1918`.
- [x] 5.11 **Mutación #2**: `vpVsRatio 1.73 → 1.60`. Rojo en distancia S-P **en
      ambos lados**.
- [x] 5.12 **Mutación #3**: `codaA 1.86 → 2.00`. Rojo en magnitud de coda **en
      ambos lados**. **Ojo**: el caso `t = 1 s` queda VERDE porque `log10(1)=0`
      anula el coeficiente — por eso el caso de 60 s de la tarea 5.7 es
      obligatorio y este chequeo confirma que existe.
- [x] 5.13 **Mutación #4**: `codaB -0.85 → -0.50`. Rojo en magnitud de coda **en
      ambos lados**, y en TODOS los casos numéricos (el término independiente
      afecta a los cuatro).
- [x] 5.14 **Mutación #5**: borrar la clave `pVelocityKmS` del JSON. Python debe
      **reventar al IMPORTAR** con `KeyError`, no caer a un default silencioso.
      Registrar la traza. Revertir.

### 5.E — Esquema y CRUD

- [x] 5.15 Crear `deploy/sql/migrations/015_signal_picks.sql` (siguiente número
      libre; verificado que el último es `014_seismic_events.sql`) con la tabla
      completa del diseño: `id UUID PK DEFAULT gen_random_uuid()`,
      `user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE`, `channel TEXT`,
      **`pick_time TIMESTAMPTZ`** (un instante absoluto, NO un offset ni un `x` de
      píxel: la misma ventana con otro `points` da otro `x`), `note TEXT`,
      `created_at`/`updated_at`, los dos `CONSTRAINT ... CHECK` (phase en
      `('P','S','coda')` y `note <= 280`), el `CREATE UNIQUE INDEX IF NOT EXISTS
      signal_picks_user_channel_phase_time_key`, el
      `CREATE INDEX IF NOT EXISTS signal_picks_user_channel_time_idx`, los
      comentarios de cabecera en español y el **bloque de rollback comentado al
      pie** con la advertencia de que dropear borra mediciones reales.
      `phase` es `TEXT + CHECK` y **no** un `ENUM` de Postgres (el repo no usa
      enums en ninguna migración existente y `ALTER TYPE ... ADD VALUE` no corre
      dentro de una transacción en versiones viejas).
- [x] 5.16 Crear `src/models/signal_pick.py` con `PickPhase(str, Enum)`,
      `SignalPickCreate`, `SignalPickPublic` y `PickMeasurements` según el diseño.
      **`user_id` NUNCA va en el body** (patrón `wall.py`): sale de la sesión.
- [x] 5.17 Agregar `SignalPickService` (CRUD) a `src/services/signal_picks.py`:
      pool prestado, **ownership por `user_id` en el `WHERE`** (patrón
      `wall_service.py:193-211`), no por rol. Un pick ajeno devuelve 404,
      indistinguible de uno inexistente. `SignalPickNotFoundError` tipada.
- [x] 5.18 Crear `src/api/routers/picks.py` con
      `router = APIRouter(prefix="/stations/{channel}/picks", tags=["picks"])` y
      los 5 endpoints de la tabla del diseño (GET lista con mediciones, POST 201,
      PUT, DELETE 204, GET export.csv).
      **Dos gotchas verificados del repo que rompen el arranque si se ignoran:**
      (a) el `DELETE` con `status_code=204` **no lleva anotación de retorno** — un
      `-> None` con 204 aborta el arranque de FastAPI (`walls.py:76-77`);
      (b) `export.csv` es un segmento estático que compite con `{pick_id}` y va
      declarado **ANTES**, igual que `/walls/global` antes de `/walls/{wall_id}`.
- [x] 5.19 En `src/main.py`: `app.include_router(picks_router.router)` y
      `app.state.signal_pick_service` en el lifespan.
- [x] 5.20 Implementar el armado del CSV **server-side** con las columnas
      `channel,phase,pick_time_utc,note,sp_seconds,distance_km,coda_seconds,coda_magnitude`
      y `Content-Disposition`. **Por qué server-side**: es el entregable que se va
      al flujo del sismólogo; si lo armara el cliente, `distance_km` y
      `coda_magnitude` saldrían de la copia TS y una deriva produciría un CSV con
      números que no coinciden con lo que la pantalla mostró.
- [x] 5.21 Tests de integración en `tests/integration/test_picks_api.py` (patrón
      `test_walls_api.py`, testcontainer `postgres:16-alpine`, **Docker arriba**):
      ownership (el pick de A no aparece para B, y B no puede borrarlo — el pick
      de A sigue existiendo); doble POST idéntico ⇒ **una sola fila** (el UNIQUE
      hace idempotente el doble clic); `ON DELETE CASCADE` (borrar el usuario
      borra sus picks); sin sesión ⇒ 401.
- [x] 5.22 **Test que sólo puede pasar con persistencia real** (no con
      localStorage): el pick se lee desde una conexión/sesión NUEVA, no dentro de
      la misma. *Un test que sólo verifique "se lee después de escribirlo en la
      misma sesión" pasaría igual con `localStorage` y NO sirve.*
- [x] 5.23 Test del CSV: con P, S y coda, las columnas derivadas traen los valores
      del service (no vacíos ni placeholders) y el archivo no tiene corrupción de
      separadores.

### 5.F — UI de picking

- [x] 5.24 Crear `dashboard/hooks/use-signal-picks.ts` con el contrato del diseño
      (`picks`, `measurements`, `addPick`, `removePick`, `status`). Mismas tres
      reglas de React de la tarea 2.4 (estado inicial `null` + efecto; nada de
      estado derivado de props asíncronas; abort controlado dentro de su efecto).
- [x] 5.25 Crear `dashboard/components/PickingOverlay.tsx`: capa sobre `WaveView`
      con líneas P/S/coda, atajos de teclado y panel de mediciones. **UI de UN
      SOLO NIVEL**: marcar P, marcar S, marcar coda. **NO replicar los menús
      anidados de tres niveles de SWARM** (fase → onset → polaridad → peso 0-4).
      No persiste (llama al hook) y no calcula las fórmulas (llama a la lib).
- [x] 5.26 El overlay usa **la misma `xToTime` de `waveform-scale.ts`** que el
      zoom: dos mapeos distintos darían un pick corrido. El pick guarda un
      **instante UTC**, nunca un `x` ni un offset — por eso se puede redibujar al
      volver con otro zoom.
- [x] 5.27 Cablear el picking y el export detrás de `visibleTools(progress).picking`
      y `.export`.
- [x] 5.28 Tests de `PickingOverlay`: marcar P es una sola acción sin submenú y se
      dibuja en el instante marcado; con P y S se muestra la distancia calculada
      (no un placeholder); **con S ANTES que P no se muestra distancia, se indica
      orden inválido y NO aparece `NaN` ni un número negativo**; con coda de 100 s
      se muestra `2.87`; borrar el pick S hace desaparecer la distancia y **deja
      la magnitud de coda visible**.
- [x] 5.29 Cadenas nuevas de la Fase 5 en `es.json` **Y** `en.json` (incluidos los
      mensajes de orden de fases inválido y las etiquetas del export), test de
      paridad verde.

### 5.G — Cierre de fase

- [x] 5.30 Aplicar `015_signal_picks.sql` en local y verificar la tabla y los dos
      índices. **Orden de despliegue: migración primero, código después** (la tabla
      vacía no molesta a nadie; el código sin tabla da 500).
- [x] 5.31 Suite completa verde en ambos lados (integración con Docker arriba) +
      `tsc --noEmit` en 0 + conteo frontend `>=` baseline.
- [x] 5.32 Cerrar `mutation-log.md`: las **12 mutaciones** de la tabla del diseño
      deben tener su fila con la salida del `rg`, el test que se puso rojo y la
      confirmación de reversión. **Una mutación sin salida de `rg` registrada no
      cuenta como verificada.**
- [ ] 5.33 **QA visual del usuario — Fase 5.** Entregarle: URL
      `http://localhost:3000/es/stations/AK.FIRE..BHZ`, pestaña `wave` con el
      picking ya desbloqueado; qué mirar: marcar P con un clic (sin submenús);
      marcar S y ver la distancia; marcar la coda y ver la magnitud; **recargar la
      página y confirmar que los picks siguen ahí**; cerrar sesión, volver a
      entrar y confirmar que siguen; bajar el CSV y abrirlo en una planilla con
      las columnas separadas correctamente; marcar S antes que P y confirmar que
      NO aparece `NaN` ni un número negativo.

---

## Phase 6: Verificación final y cierre del change

- [x] 6.1 Correr la suite completa de backend y frontend + `tsc --noEmit`.
      Registrar el conteo final contra la baseline de 633/65.
      **HECHO 2026-08-26 sobre `a112314`: backend 975 (unit + integración),
      frontend 967, `tsc --noEmit` en 0.** El conteo incluye la feature de
      performance FDSN (cache eterno + warm-up), posterior a la Fase 5.
- [x] 6.2 Verificar la paridad i18n completa con
      `cd dashboard && ./node_modules/.bin/vitest run messages/parity.test.ts`:
      cero claves en `es.json` que falten en `en.json` y viceversa.
      **HECHO 2026-08-26: 4 passed, paridad completa.**
- [x] 6.3 Auditar la convención de idioma en TODOS los archivos nuevos del change:
      identificadores en inglés, comentarios y docstrings en español, comillas
      simples en TS.
      **HECHO 2026-08-26** sobre los 18 archivos nuevos desde el 2026-08-24
      (componentes, hooks, libs, router de picks, modelos y services): cero
      comillas dobles en TS, cero comentarios en inglés, cero identificadores
      en español (heurísticas por rg; los tests de cada fase ya venían con la
      convención aplicada).
- [x] 6.4 ~~Resolver el conflicto de `openspec/config.yaml`~~ **YA RESUELTO el
      2026-08-24**, antes de empezar la implementación. Tres cosas estaban mal en
      esa config y las tres se arreglaron:
      1. `verify.build_command` era `npm run build` (= `next build`, verificado en
         `dashboard/package.json:7`), que rompe el server de dev porque comparten
         `.next`. Ahora es `cd dashboard && ./node_modules/.bin/tsc --noEmit`,
         **probado: exit 0 y `git status` sin un solo archivo tocado**.
         (`package.json` no tiene script de `tsc`, por eso se invoca el binario.)
      2. La ruta decía `cd seismic-monitor/dashboard` estando ya DENTRO de
         `seismic-monitor`.
      3. `verify.test_command` era `pytest` pelado, que revienta con
         `ModuleNotFoundError: asyncpg` porque el venv está en `venv/`, no en
         `.venv/`. Ahora es `./venv/bin/python -m pytest`.
      Además se corrigió la regla de `proposal` que pedía identificar módulos en
      `src/workers/` — **ese directorio no existe**; fue la causa de que la
      propuesta lo listara como afectado. **Sigue vigente: no ejecutar
      `npm run build` durante el desarrollo bajo ninguna circunstancia.**
- [x] 6.5 Repasar los 3 items de "Open Questions" del diseño con el usuario tras el
      QA visual: techo de 1 h para `/spectra`, ventana de 120 s del clic del
      helicorder, y umbrales de progresividad (3 ventanas / 2 usos). Los tres son
      un punto de partida razonable, no un dato medido.
      **HECHO 2026-08-26: el usuario ratificó los tres valores.** Se revisitan
      con evidencia de uso real si los QA visuales pendientes (2.19/3.16/4.14/
      5.33) muestran otra cosa.
