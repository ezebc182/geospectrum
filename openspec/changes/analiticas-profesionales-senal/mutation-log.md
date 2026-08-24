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
| extra (tarea 1.14) | `dashboard/lib/helicorder-hit.ts` | `(x - marginLeft) / plotWidth` → `x / width` (usar el canvas en vez del plot) | `76:  const offsetInRow = x / width; // MUTACION: usar el canvas en vez del plot` | **Primer intento: 2 de 10**, y el test llamado *"el offset horizontal se calcula sobre el plot, no sobre el canvas"* — escrito específicamente para esta mutación — **quedó VERDE**. Causa: con `x=556, width=1112`, `x/width = 0.5` y `(556-56)/1000 = 0.5` **dan lo mismo**; el punto elegido no separaba las fórmulas. Corregido a `x=306` (0.25 vs ~0.275). **Segundo intento: 3 rojos**, incluido el que antes era ciego. | Sí — `rg` sin coincidencias y 10 passed |
| **#9** (tarea 1.12) | `src/main.py` | Sacar `window_part` de la f-string de la `cache_key` | `2661:    cache_key = f"waveform:{channel}:{points}:{filter}"  # MUTACION 9` | **2 de 24**: `test_dos_ventanas_distintas_no_colisionan_en_cache` y `test_ventana_relativa_y_absoluta_no_colisionan`. Los otros 22 no dependen de la key y quedaron verdes, que es lo correcto. | Sí — `rg` sin coincidencias y 24 passed |
| extra (tarea 1.3) | `src/services/spectrogram_service.py` | Anular la rama de ventana absoluta: `if starttime is not None and endtime is not None:` → `if False:` | `532:        if False:  # MUTACION TEMPORAL` | **4 de 6**: `test_ventana_absoluta_se_pide_tal_cual`, `test_ventana_absoluta_ignora_duration_hours`, `test_ventana_absoluta_naive_se_interpreta_como_utc`, `test_ventana_absoluta_con_offset_equivale_a_su_utc`. Los 2 de modo relativo siguieron VERDES, que es lo correcto: la mutación no toca ese camino. Si se hubieran puesto rojos los 6, los tests estarían mal aislados. | Sí — `rg` sin coincidencias y 6 passed |

<!--
Mutaciones pendientes (tabla del design.md, sección Testing Strategy):
  #1  seismic-constants.json   pVelocityKmS 6.0 -> 7.0      (rojo en AMBAS suites)
  #2  seismic-constants.json   vpVsRatio 1.73 -> 1.60       (rojo en AMBAS suites)
  #3  seismic-constants.json   codaA 1.86 -> 2.00           (rojo en AMBAS; ojo: t=1s queda verde)
  #4  seismic-constants.json   codaB -0.85 -> -0.50         (rojo en AMBAS suites)
  #5  seismic-constants.json   borrar clave pVelocityKmS    (Python revienta al IMPORTAR)
  #6  swarm_spectra.py         KAISER_BETA 5 -> 8           (test del espectro 1D)
  #7  swarm_spectra.py         DB_MULTIPLIER 20 -> 10       (test del espectro 1D)
  #8  swarm_spectra.py         MAX_FREQ_HZ 25 -> 50         (test de dos canales, dos ejes)
  #9  main.py                  sacar window_part de cache_key (test de colisión de ventanas)
  #10 waveform-scale.ts        MIN_WINDOW_MS 1000 -> 0      (test de ventana degenerada)
  #11 swarm_rsam.py            np.mean(np.abs(x)) -> np.mean(x) (test de rsam_series)
  #12 progressive-disclosure.ts spectrumAfterWindows 3 -> 0  (test del umbral "justo debajo")

Recordatorio sobre #1-#5: un solo rojo significa que hay una copia escondida de
la constante en el otro lado. Deben ponerse rojos tests de Python Y de TS.
-->
