# PR C — WaveView: clic en el helicorder → onda con zoom, filtro y espectro

Spec: `docs/superpowers/specs/2026-08-20-station-detail-swarm-design.md` (§58, §65).
Estado previo: PR A (helicorder) y PR B (espectrograma grande) mergeados/terminados.

## Por qué existe este PR

El usuario reportó, con captura: *"no puedo hacer zoom in-out, no puedo analizar,
no hay interacción con el helicorder"*.

Es correcto, y **no se arregla dentro del helicorder**. En SWARM el helicorder es
el ÍNDICE de las 24 h: se hace clic en lo que llama la atención y esa ventana se
abre en el **WaveView**, que es donde viven el zoom, el filtro y la FFT. Este PR
es esa pieza.

Dato del reporte: en la vista de 15 min son 96 filas en 640 px = **6,6 px por
fila**, con las etiquetas de hora pisándose. Esa vista es un mapa, no una lupa —
no se analiza un sismo en 6 píxeles de alto. La solución es navegar al WaveView,
no agrandar el helicorder.

## Hallazgo bloqueante (verificado en esta sesión, NO saltear)

`GET /stations/{channel}/waveform` (`src/main.py:2429`) sólo acepta ventana
RELATIVA:

```python
minutes: int = Query(1440, ge=1, le=1440, description="Ventana hacia atrás")
points:  int = Query(38400, ge=100, le=50000)
filter:  str = Query("none", pattern="^(none|bp)$")
```

**No hay `start` ni `end`.** Para abrir el evento de las 13:23Z de ayer hace falta
ventana ABSOLUTA. El spec no lo menciona: es trabajo de backend que este PR tiene
que hacer primero. Sin esto, el clic no puede funcionar.

## Tareas

### Fase 1 — Backend: ventana absoluta

1. **`GET /stations/{channel}/waveform` acepta `start`/`end` ISO-8601 UTC.**
   - `start`+`end` son mutuamente excluyentes con `minutes`; si vienen los tres, 422 con mensaje claro.
   - Validar `end > start` y que la ventana no exceda 24 h (mismo techo que `minutes`).
   - Reusar `build_waveform_response` tal cual: ya hace demean → filtro → decimación min/max y devuelve tipos nativos de Python (los escalares de numpy revientan `json.dumps`).
   - Tests: ventana válida, `end <= start`, ventana > 24 h, combinación inválida con `minutes`, y que el `filter=bp` siga funcionando con ventana absoluta.

2. **`GET /stations/{channel}/spectra?start=&end=&filter=` — NUEVO, no existe.**
   - Verificado: `rg "spectra" src/main.py` no devuelve nada.
   - Kaiser beta=5 sobre la ventana COMPLETA (no por bins como el espectrograma), `20·log10` (multiplicador 20 = amplitud, no 10).
   - Reusar `KAISER_BETA` de `src/services/swarm_spectra.py` — no redefinir la constante.
   - **Se calcula sobre la señal SIN decimar** (spec §39): el cliente nunca computa FFT sobre datos ya decimados min/max, daría un espectro falso.
   - Respuesta `{freqs, power_db, sampling_rate}`.
   - Techo de frecuencia: `min(MAX_FREQ_HZ, fs/2)`, igual que `_freq_mask`. **Devolverlo en la respuesta** — ver la lección del eje de abajo.
   - Tests con señal sintética: una sinusoide de frecuencia conocida tiene que dar el pico en ese bin. Verificar por mutación (cambiar beta o el multiplicador 20→10 tiene que romper un test).

### Fase 2 — Frontend: lib pura (TDD, antes de tocar el canvas)

3. **`lib/waveform-scale.ts`** — sin canvas, todo testeable:
   - `timeToX` / `xToTime` con la ventana visible, y su ida-y-vuelta (invariante: `xToTime(timeToX(t)) === t`).
   - `clampWindow(start, end, limits)`: no dejar arrastrar fuera del rango disponible ni por debajo de una ventana mínima (~1 s) — una ventana de 0 s es una división por cero al escalar.
   - `zoomWindow(window, factor, anchorFraction)`: el zoom se ancla donde está el cursor, no en el centro.
   - `dragSelection(x0, x1)`: normalizar (arrastrar hacia la izquierda es válido) y descartar clics accidentales (< ~5 px).

4. **`lib/helicorder-hit.ts`** — traducir un clic del helicorder a una ventana de tiempo:
   - Entrada: `(x, y, width, height, timeChunkMinutes, startMs)` + los mismos márgenes del canvas.
   - Salida: `{startMs, endMs}` centrada en el instante clickeado, con padding configurable (default ±30 s).
   - **Invariante obligatorio**: para todo píxel dentro del área de dibujo, la ventana devuelta cae dentro de las 24 h del helicorder. Es el mismo tipo de test de invariantes que ya atrapó bugs en `helicorder-layout.test.ts`.
   - Un clic en los márgenes (etiquetas) devuelve `null`, no una ventana inventada.

### Fase 3 — Frontend: componentes

5. **`HelicorderCanvas` acepta `onSelectWindow?: (w) => void`.**
   - Cursor `pointer` sólo cuando el prop está presente.
   - **Trampa conocida del proyecto (ya mordió TRES veces)**: si el handler lee un valor que no está en las deps del `useEffect`, corre una vez y nunca más. El componente ya tiene los efectos separados (carga / dibujo) — el handler de clic va como listener del elemento, no dentro del efecto de dibujo.

6. **`WaveView` + `SpectrumView`**:
   - Render min/max de la ventana pedida al backend.
   - Zoom por arrastre con caja amarilla `rgba(255,255,0,0.5)` (paridad SWARM), que RE-PIDE la ventana al backend. No se hace zoom sobre datos ya decimados: se pide de nuevo con más resolución.
   - Botones: volver atrás (pila de ventanas), reset a la ventana original.
   - Toggle Butterworth → `filter=bp`. El backend ya lo tiene implementado con los parámetros exactos de SWARM (orden 4, 1–10 Hz, `filtfilt` zero-phase, tope en Nyquist para canales lentos).
   - Espectro FFT log-log de la ventana visible, pedido a `/spectra` con la ventana EXACTA.

7. **Página**: pestaña "Onda + Espectro" a `enabled: true`; el clic en el helicorder cambia a esa pestaña con la ventana seleccionada. i18n ES/EN (hay paridad de claves, no romperla).

8. **Settings manuales** (spec §61): rango de amplitud y toggle del filtro, persistidos en `localStorage` por canal. Reusar el patrón de `lib/helicorder-settings.ts` (clamps + fallback a defaults + JSON corrupto no rompe la vista).

## Lecciones de esta sesión que aplican directo

- **El eje se deriva del DATO, no de una constante.** Medido en la base: el techo de frecuencia varía por canal (10 / 20 / 25 Hz) y hasta dentro del mismo canal. Un eje hardcodeado miente por factor 2. Ver `lib/spectrogram-frequency-axis.ts` y la memoria `eje-frecuencia-cambia-por-canal`. **El espectro de este PR tiene el mismo riesgo**: usar el `fs` que devuelve el endpoint.
- **El spec es una intención, no la realidad.** El spec decía "0–25 Hz"; el dato decía 10. Ir a la base primero evitó repetir un bug que este proyecto YA tuvo (ver docstring de `spectrogram-axis.ts`).
- **Verificar por mutación.** Verde no prueba nada: romper la feature a propósito y confirmar que un test se pone rojo. Y confirmar que la mutación se APLICÓ (`rg` sobre el archivo) antes de leer el resultado — una mutación que no muta no prueba nada.
- **Correr el proceso de verdad.** 736 tests verdes y el worker moría al arrancar. Después de los tests: levantar el stack y pegarle al endpoint con curl.
- **NO correr prettier.** El proyecto no tiene config de prettier; corrió con defaults y reformateó un archivo entero a comillas dobles sobre un codebase de comillas simples. El proyecto usa **comillas simples**.

## Entorno (verificado)

- Node del shell es viejo: `export PATH="$HOME/.nvm/versions/node/v22.16.0/bin:$PATH"`.
- Tests: `./node_modules/.bin/vitest` desde `dashboard/` (nunca `npx`, se baja un vitest ajeno).
- Python: `./venv/bin/python` (el venv está en `venv/`, no `.venv/`).
- API local: `./venv/bin/python -m uvicorn src.main:app --host 127.0.0.1 --port 8000`.
- Base: contenedor `timescaledb`, user y db `seismic`.
- **Canal de prueba con datos**: `AK.FIRE..BHZ` o `CN.BOIB..HHZ`. `IU.MAJO..BHZ` NO tiene columnas de espectrograma guardadas.
- El dashboard redirige a `/login` sin sesión: un 307 confirma que la ruta compila.

## Criterio de terminado

- Suite completa verde (baseline al cerrar esta sesión: **633 tests / 65 archivos**) y `tsc --noEmit` en 0.
- Endpoints nuevos probados con curl contra el servidor real, no sólo con mocks.
- Verificación por mutación de: ventana absoluta, cálculo del espectro, y el mapeo clic→ventana.
- QA visual del usuario: clic en uno de los eventos visibles de `AK.FIRE..BHZ` tiene que abrir esa ventana en el WaveView, con zoom por arrastre y el toggle del filtro funcionando.
