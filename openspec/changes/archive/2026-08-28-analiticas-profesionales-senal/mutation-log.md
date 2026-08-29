# Registro de verificación por mutación

Este archivo es **criterio de aceptación** del change
`analiticas-profesionales-senal`, no documentación opcional.

## Por qué existe

Este repo produjo **tres tests verdes que no podían fallar nunca**: uno
verificaba la variable equivocada, otro mockeaba un símbolo inexistente, el
tercero esperaba un valor idéntico al fallback. **Dos de los tres los especificó
el plan.** Con fórmulas sismológicas el daño es peor: un test verde certifica una
distancia falsa que el usuario exporta a un CSV y le manda a un colega.

Un test que no puede ponerse rojo no prueba nada, y la única forma de saber si
puede es romperlo a propósito.

## Protocolo — sin atajos

1. Aplicar la mutación.
2. **Confirmar con `rg` que el archivo cambió.** Este repo ya tuvo un `sd`
   multilínea que falló en silencio: no cambió nada y el verde se leyó como si
   probara algo. **Una mutación que no muta no prueba nada.**
3. Correr el test.
4. Registrar la fila acá: qué se rompió, la salida del `rg`, qué test se puso rojo.
5. Revertir y confirmar que vuelve a verde.

**Una mutación sin la salida del `rg` registrada NO cuenta como verificada.**

## Baseline registrada (tarea 0.1, 2026-08-24)

Medida en la rama `feat/analiticas-senal-fase1`, antes de tocar código:

| Suite | Comando | Resultado |
|---|---|---|
| Backend | `./venv/bin/python -m pytest tests/ -q` | **852 passed**, 8 warnings, 81% coverage |
| Frontend | `./node_modules/.bin/vitest run` (desde `dashboard/`) | **772 passed**, 74 archivos |

> Nota: el diseño estimaba 633 tests / 65 archivos en el frontend. La cifra real
> es 772 / 74 — la estimación venía del PR #38 y quedó vieja. Vale la medida, no
> la estimación.

## Registro

| # | Archivo | Mutación | Salida del `rg` | Test que se puso rojo | Revertido |
|---|---|---|---|---|---|
| extra (QA Fase 1) | `dashboard/lib/helicorder-layout.ts` | `rowsForWindow`: `(endMs - startMs) / 60_000` → `1440` (volver a la constante) | `43:  const spanMinutes = 1440; // MUTACION: volver a la constante` | **3 de 24**, incluido el del caso real de 18,75 h. El test *"una ventana completa de 24 h sigue dando las filas de siempre"* quedó **VERDE**, y es correcto: con 24 h reales la constante y el dato **coinciden**. Mismo fenómeno que la mutación de `helicorder-hit`: el caso donde ambas fórmulas dan lo mismo no puede detectar nada, por eso el test del caso real es el que vale. | Sí — `rg` sin coincidencias y 24 passed |
| extra (tarea 1.15) | `dashboard/components/HelicorderCanvas.tsx` | Sacar la conversión de coordenadas CSS→canvas: `((clientX - left) * width) / rect.width` → `clientX - left` | `256:      x: event.clientX - rect.left, // MUTACION: sin escalar` | **1 de 12**: `escala las coordenadas cuando el canvas está redimensionado por CSS`. Los otros 11 usan un `rect` a tamaño real, donde ambas fórmulas coinciden — **por eso ese test existe**, aplicando la lección de la mutación anterior. | Sí — `rg` sin coincidencias y 12 passed |
| extra (tarea 1.14) | `dashboard/lib/helicorder-hit.ts` | `(x - marginLeft) / plotWidth` → `x / width` (usar el canvas en vez del plot) | `76:  const offsetInRow = x / width; // MUTACION: usar el canvas en vez del plot` | **Primer intento: 2 de 10**, y el test llamado *"el offset horizontal se calcula sobre el plot, no sobre el canvas"* — escrito específicamente para esta mutación — **quedó VERDE**. Causa: con `x=556, width=1112`, `x/width = 0.5` y `(556-56)/1000 = 0.5` **dan lo mismo**; el punto elegido no separaba las fórmulas. Corregido a `x=306` (0.25 vs ~0.275). **Segundo intento: 3 rojos**, incluido el que antes era ciego. | Sí — `rg` sin coincidencias y 10 passed |
| **#9** (tarea 1.12) | `src/main.py` | Sacar `window_part` de la f-string de la `cache_key` | `2661:    cache_key = f"waveform:{channel}:{points}:{filter}"  # MUTACION 9` | **2 de 24**: `test_dos_ventanas_distintas_no_colisionan_en_cache` y `test_ventana_relativa_y_absoluta_no_colisionan`. Los otros 22 no dependen de la key y quedaron verdes, que es lo correcto. | Sí — `rg` sin coincidencias y 24 passed |
| **#10** (tarea 2.3) | `dashboard/lib/waveform-scale.ts` | `MIN_WINDOW_MS 1_000 → 0` | `25:export const MIN_WINDOW_MS = 0;` | **Primer intento: 3 de 27**, y el test nombrado por el plan — *"una ventana degenerada (start === end) queda con duración MIN_WINDOW_MS"* — **quedó VERDE**. Causa: el aserto era `toBe(MIN_WINDOW_MS)`, o sea comparaba contra la constante que la mutación cambia; con `MIN_WINDOW_MS = 0` medía `0 === 0`. Un test que no puede fallar por el motivo que dice cubrir. Corregido a `toBe(1_000)` literal + `toBeGreaterThan(0)`. **Segundo intento: 4 rojos**, incluido el que antes era ciego. *(Cuarta vez en este change que el test nombrado por la mutación queda verde, y la cuarta con una causa distinta.)* | Sí — `rg` da `1_000` y 37 passed (con `helicorder-hit`) |
| **#12** (tarea 2.14) | `dashboard/lib/progressive-disclosure.ts` | `spectrumAfterWindows 3 → 0` | `43:  spectrumAfterWindows: 0,` | **1 de 36 al primer intento**, y es exactamente el que el plan nombra: *"spectrum: 2 ventanas ⇒ oculto, 3 ⇒ visible"*. Los otros 35 no dependen de ese umbral y quedaron verdes, que es lo correcto. **Salió bien al primer intento por la lección de la #10**: los valores esperados de los pares de borde van LITERALES (`2`, `3`), no leídos de `DISCLOSURE_THRESHOLDS` — si los leyeran de la constante, se moverían con la mutación y quedarían verdes. | Sí — `rg` da `3,` y 73 passed (con las otras dos libs) |
| extra (tarea 2.6) | `dashboard/hooks/use-wave-window.ts` | Pila de zoom de `useState` → `useRef` (romper la invariante 2 del diseño) | `86:  const stackRef = useRef<TimeWindow[]>([]); // MUTACION: pila en ref` | **0 de 12. Ninguno.** Dos intentos de escribir un test que la detectara fallaron; una sonda que contaba renders mostró la causa: las tres operaciones públicas (`setWindow`, `goBack`, `reset`) llaman TODAS a `setWindowState` con un objeto nuevo, y ese cambio de estado dispara el render que hace visible el valor del ref. **Conclusión: con la API actual la invariante 2 no es observable desde afuera.** Se descartó agregar `clearHistory()` sólo para hacerla testeable (ampliar la API pública para que un test pueda fallar). La pila queda en `useState` por robustez —la primera operación que toque la pila sin mover la ventana rompería el ref en silencio— y la ausencia de test quedó documentada en el archivo de tests y en el hook, en vez de dejar un comentario que prometa una cobertura inexistente. | Sí — `rg` sin coincidencias y 12 passed |
| extra (tarea 1.3) | `src/services/spectrogram_service.py` | Anular la rama de ventana absoluta: `if starttime is not None and endtime is not None:` → `if False:` | `532:        if False:  # MUTACION TEMPORAL` | **4 de 6**: `test_ventana_absoluta_se_pide_tal_cual`, `test_ventana_absoluta_ignora_duration_hours`, `test_ventana_absoluta_naive_se_interpreta_como_utc`, `test_ventana_absoluta_con_offset_equivale_a_su_utc`. Los 2 de modo relativo siguieron VERDES, que es lo correcto: la mutación no toca ese camino. Si se hubieran puesto rojos los 6, los tests estarían mal aislados. | Sí — `rg` sin coincidencias y 6 passed |

| **#6** (tarea 3.6) | `src/services/swarm_spectra.py` | `KAISER_BETA 5 → 8` | `14:KAISER_BETA = 8` | **1 de 18**: `test_valor_en_db_contra_la_referencia_a_mano`, que recalcula la referencia con LITERALES (`np.kaiser(n, 5)`) — si el módulo 1D tuviera una copia escondida de la constante, habría quedado verde. El test del pico siguió VERDE y es correcto: beta cambia los valores, no dónde cae el pico de una sinusoide fuerte. | Sí — `rg` da `= 5` y 18 passed |
| **#7** (tarea 3.6) | `src/services/swarm_spectra.py` | `DB_MULTIPLIER 20 → 10` | `17:DB_MULTIPLIER = 10  # ...` | **1 de 18**: el mismo test de valor en dB (literal `20 * np.log10`). Exactamente el escenario que el plan advierte: el multiplicador NO mueve el pico, así que sin un test de VALOR esta mutación pasaba desapercibida. | Sí — `rg` da `= 20` y 18 passed |
| **#8** (tarea 3.6) | `src/services/swarm_spectra.py` | `MAX_FREQ_HZ 25.0 → 50.0` | `18:MAX_FREQ_HZ = 50.0  # ...` | **3 de 18**: `test_canal_rapido_manda_la_vista_swarm` (módulo, fs=100 ⇒ 50≠25), `test_dos_canales_dos_ejes_distintos` (endpoint) y el de valor en dB (la máscara se agranda y las longitudes divergen). El caso fs=40 siguió VERDE, correcto: Nyquist 20 < 50 y el techo no participa. | Sí — `rg` da `= 25.0` y 18 passed |

| **#11** (tarea 4.3) | `src/services/swarm_rsam.py` | `rsam_sample`: dos variantes — (a) quitar el `abs`: `np.mean(centered)`; (b) quitar el demean: `np.mean(np.abs(data))` | (a) `33: return float(np.mean(centered))` (b) `33: return float(np.mean(np.abs(data.astype(np.float64))))` | **(a) 2 de 15**: el de la onda alternante (±100 ⇒ 0 en vez de 100) y el unitario de `rsam_sample`. El de señal constante quedó VERDE **y es correcto**: sin `abs` pero con demean, la constante sigue dando 0 — la predicción del plan ("devolvería 1000") corresponde a la variante (b). **(b) 2 de 15**: el de señal constante (1000 en vez de 0, la predicción exacta del plan) y el unitario. Entre ambas variantes, las dos mitades de la fórmula quedan vigiladas por tests DISTINTOS. | Sí — (a) se revirtió con `git checkout` y se llevó `rsam_series` sin commitear (la trampa ya documentada: repuesto y verificado); (b) se revirtió con `sd` inverso, `rg` da 1 y 15 passed |

| **#1** (tarea 5.10) | `dashboard/lib/seismic-constants.json` | `pVelocityKmS 6.0 → 7.0` | `2:  "pVelocityKmS": 7.0,` | **Python 4 de 17 Y TS 4 de 17** — los mismos cuatro de cada lado: el de constantes y los tres de distancia S-P (10 s ⇒ 95.89 en vez de 82.1918, la predicción exacta del plan). Los de coda quedaron verdes, correcto: vp no participa en Mc. Rojo en AMBAS suites ⇒ ninguna copia escondida. | Sí — `rg` da `6.0` y 17+17 passed |
| **#2** (tarea 5.11) | `dashboard/lib/seismic-constants.json` | `vpVsRatio 1.73 → 1.60` | `3:  "vpVsRatio": 1.60,` | **Python 4 de 17 Y TS 4 de 17**: constantes + los tres de distancia S-P, en ambos lados. Coda verde, correcto. | Sí — `rg` da `1.73` y 17+17 passed |
| **#3** (tarea 5.12) | `dashboard/lib/seismic-constants.json` | `codaA 1.86 → 2.00` | `4:  "codaA": 2.00,` | **Python 4 de 17 Y TS 4 de 17**: constantes + coda de 100, 10 y 60 s. **El caso `t=1 s` quedó VERDE en los dos lados, tal como el plan predijo** (`log10(1)=0` anula el coeficiente) — y el caso de 60 s, que existe exactamente para esto, se puso rojo. Distancia S-P verde, correcto. | Sí — `rg` da `1.86` y 17+17 passed |
| **#4** (tarea 5.13) | `dashboard/lib/seismic-constants.json` | `codaB -0.85 → -0.50` | `5:  "codaB": -0.50` | **Python 5 de 17 Y TS 5 de 17**: constantes + los CUATRO casos numéricos de coda (100, 10, 1 y 60 s) — el término independiente afecta a todos, incluida la coda de 1 s que en la #3 quedaba verde. | Sí — `rg` da `-0.85` y 17+17 passed |
| **#5** (tarea 5.14) | `dashboard/lib/seismic-constants.json` | Borrar la clave `pVelocityKmS` | `rg -n "pVelocityKmS"` sin coincidencias (clave ausente) | **Python REVENTÓ AL IMPORTAR** con `KeyError: 'pVelocityKmS'` en la línea `P_VELOCITY_KM_S: float = _C["pVelocityKmS"]` — sin caer a ningún default silencioso, que es el comportamiento exigido. **Nota de protocolo**: el primer intento con `sd` multilínea NO mutó (el `rg -c` siguió dando 1) y se descartó ese verde; se reaplicó con edición determinística vía `json` de Python. La trampa del `sd` que falla en silencio, por segunda vez en este change. | Sí — `rg` da `"pVelocityKmS": 6.0` y 17 passed |

<!--
Mutaciones pendientes (tabla del design.md, sección Testing Strategy):
  (ninguna) — las 12 de la tabla del diseño están registradas arriba.
-->
