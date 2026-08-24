# Proposal: Analíticas profesionales de señal (paridad moderna con SWARM)

## Intent

SWARM (USGS / Alaska Volcano Observatory, Java de escritorio, CC0) es la
herramienta con la que un sismólogo hace su trabajo diario: abre una ventana de
tiempo concreta, mira la onda, la filtra, le saca la FFT, marca las fases P y S,
mide la coda y anota. Nuestro proyecto ya iguala o supera a SWARM en varias
piezas (espectrograma con paridad de cálculo, RSAM calculado en casa, muro
multi-canal en vivo que SWARM no tiene), pero el trabajo del sismólogo sigue
siendo imposible acá: **hoy no se puede mirar un evento de ayer**.

El bloqueante es un solo parámetro que falta. `GET /stations/{channel}/waveform`
(`src/main.py:2580-2586`) sólo acepta ventana RELATIVA hacia atrás desde ahora:

```python
minutes: int = Query(1440, ge=1, le=1440, description="Ventana hacia atrás")
```

El flujo real de SWARM es exactamente el opuesto: descarga una ventana ABSOLUTA
de FDSN (`starttime=2019-04-18T20:00:00&endtime=2019-04-19T20:00:00`) y la
analiza. Sin `start`/`end` quedan bloqueadas CUATRO features de una: wave view,
espectro 1D, wave clipboard y picking.

El objetivo NO es portar SWARM feature por feature. SWARM es una app de 2004:
su picking son menús anidados de tres niveles (fase → onset → polaridad → peso
0-4) sin ninguna detección automática, y su localizador Hypo71 es un binario
Fortran de los 70 que exige todas las estaciones en el mismo cuadrante. El
criterio de este cambio es preguntarse **qué trabajo hacía el sismólogo con cada
feature** y resolverlo con herramientas de hoy.

El vehículo para no ahogar al principiante es la **escalera de perfiles**: no son
cuatro productos, es profundidad creciente sobre la misma pantalla.

```
Divulgación   ->  ve el mapa, la magnitud, comparte
Aficionado    ->  ...y abre la señal, mira el espectrograma
Estudiante    ->  ...y marca las fases, mide S-P, aprende
Sismólogo     ->  ...y exporta las mediciones a su flujo
```

## Scope

### In Scope

Cinco fases de costo creciente. **Cada fase entrega valor por sí sola y es
mergeable sin la siguiente.**

**Fase 1 — Ventana absoluta (el desbloqueo).**
1. `GET /stations/{channel}/waveform` acepta `start`/`end` ISO-8601 UTC,
   mutuamente excluyentes con `minutes`; techo de 24 h; `end > start`.
   La `cache_key` (hoy `f"waveform:{channel}:{minutes}:{points}:{filter}"`) pasa
   a incorporar la ventana absoluta cuando se usa.
2. `lib/helicorder-hit.ts`: traducir un clic del helicorder a `{startMs, endMs}`.
3. El clic en `HelicorderCanvas` navega a la ventana seleccionada.

**Fase 2 — Wave view (escalón "aficionado").**
4. Pestaña `wave` de `enabled: false` a `true` (`stations/[channel]/page.tsx:37`).
5. `lib/waveform-scale.ts` puro: `timeToX`/`xToTime` con ida-y-vuelta,
   `clampWindow` (ventana mínima ~1 s: 0 s es división por cero),
   `zoomWindow` anclado al cursor, `dragSelection` normalizado.
6. Zoom por arrastre que **re-pide la ventana al backend** (nunca hacer zoom
   sobre datos ya decimados min/max), pila de "volver atrás", reset.
7. Toggle del filtro Butterworth — el backend YA lo tiene y el frontend YA lo
   manda (`HelicorderCanvas.tsx:98`). No hay que construirlo, hay que exponerlo.

**Fase 3 — Espectro 1D (Power vs Hz).**
8. `GET /stations/{channel}/spectra?start=&end=&filter=` — NUEVO, verificado que
   no existe (`rg "spectra" src/main.py` no devuelve nada).
9. Kaiser beta=5 sobre la ventana COMPLETA (no por bins como el espectrograma),
   `20·log10`. Reusar `KAISER_BETA` y `DB_MULTIPLIER` de
   `src/services/swarm_spectra.py` — NO redefinir constantes.
10. Calculado sobre la señal SIN decimar. El cliente nunca computa FFT sobre
    datos min/max: daría un espectro falso.
11. La respuesta DEVUELVE `sampling_rate` y el techo de frecuencia efectivo
    (`min(MAX_FREQ_HZ, fs/2)`). El eje se dibuja con ese dato, nunca con una
    constante.

**Fase 4 — RSAM como serie temporal (escalón "aficionado avanzado").**
12. Hoy RSAM es un número suelto: `RsamSeries` en `src/services/swarm_rsam.py`
    es un `deque` en memoria (línea 45) poblado por
    `src/services/seedlink_ingestor.py`, y el frontend lo muestra como el campo
    `il` en `dashboard/lib/station-metrics.ts`. Falta la SERIE en el tiempo.
13. Endpoint de serie RSAM sobre ventana absoluta + pestaña `rsam` habilitada
    (`page.tsx:38`).
14. **DECIDIDO (usuario, 2026-08-24): la serie se calcula ON-DEMAND desde la
    onda, NO se persisten muestras.** El endpoint baja la ventana de FDSN
    (reusando el camino de la Fase 1) y calcula el RSAM ahí, reusando
    `rsam_sample()` de `swarm_rsam.py`. Consecuencias que el diseño debe honrar:
    - **NO se toca `seedlink_ingestor.py`** ni se agrega migración en esta fase.
      Ese proceso ya se cayó en silencio una vez (exit 0, deploy verde y mudo);
      no se le agrega superficie de falla por una feature de lectura.
    - Funciona sobre CUALQUIER fecha que tenga FDSN, no sólo desde el deploy.
    - El costo es latencia (segundos por ventana), no storage. Si en uso real
      duele, la persistencia se evalúa DESPUÉS con datos, no por adelantado.
    - El `deque` en memoria sigue existiendo para el número instantáneo del
      muro; son dos caminos distintos y está bien que lo sean.

**Fase 5 — Picking P/S/coda persistido (escalones "estudiante" y "sismólogo").**
15. Migración `deploy/sql/migrations/015_signal_picks.sql` (siguiente número
    libre; verificado: el último es `014_seismic_events.sql`). Tabla por usuario,
    patrón de `013_walls.sql`: `user_id UUID REFERENCES users(id) ON DELETE
    CASCADE`, índices `IF NOT EXISTS`, bloque de rollback comentado al pie.
16. CRUD de picks + servicio con las dos fórmulas sismológicas de SWARM
    (verificadas en `swarm .../event/PickData.java`, CC0):
    - S-P a distancia: `d = (tS - tP) * (vp * vs) / (vp - vs)`, vp = 6.0 km/s,
      vp/vs = 1.73
    - Coda a magnitud: `Mc = 1.86 * log10(t) - 0.85`
17. UI de picking de UN nivel (marcar P, marcar S, marcar coda). NO replicar los
    menús de tres niveles de SWARM.
18. Export de las mediciones (CSV) para el flujo del sismólogo.

**Transversal a todas las fases — progresividad por interacción.**
19. Las herramientas avanzadas aparecen cuando el usuario ya usó las básicas.
    **NO es un toggle básico/avanzado y NO es todo visible siempre.** El estado
    de progreso se persiste (mismo patrón que `lib/helicorder-settings.ts`:
    clamps + fallback a defaults + JSON corrupto no rompe la vista).
20. Paridad i18n ES/EN obligatoria: toda cadena nueva va en
    `dashboard/messages/es.json` Y `en.json`.

### Out of Scope

- **Localización de hipocentro (Hypo71 o equivalente)**. Requiere multi-estación
  y un modelo de velocidades. La distancia S-P de la Fase 5 es la aproximación
  de una estación; la localización real es otro cambio.
- **Detección automática de fases (STA/LTA, ML)**. La Fase 5 es picking manual
  asistido. La automatización se evalúa DESPUÉS de tener picks reales guardados
  con los que medir su acierto.
- **Upload de miniSEED/SAC**. ObsPy 1.4.1 ya está en requirements y el pipeline
  trabaja sobre `Stream`, así que la fuente del Stream es lo único que cambiaría
  — pero importar miniSEED cuesta ~8x en RAM (ObsPy descomprime a float64) y
  "cachear por usuario" no es cache, es almacenamiento disfrazado. Necesita su
  propia decisión de storage.
- **Wave clipboard (comparar N señales lado a lado)**. Se desbloquea con la
  Fase 1 pero es una pantalla nueva completa.
- **Estaciones sismológicas dibujadas en el mapa**. Hoy el mapa dibuja eventos y
  ciudades. Es un cambio de la capa de mapa, no de análisis de señal.
- **Cambiar la escala dB fija 20-120**. Es DELIBERADA para comparabilidad entre
  estaciones (`swarm_spectra.py:22-23` y `dashboard/lib/spectrogram-scale.ts:13-14`).
  No es un pendiente.
- **"Arreglar" el filtro Butterworth**. Ya está conectado end-to-end.

## Approach

**1. Desbloquear primero, construir después.** La Fase 1 es un parámetro de
query y su validación. Es la fase más barata y la que habilita las otras cuatro.
Ninguna fase posterior puede empezar sin ella.

**2. Reusar el pipeline, cambiar sólo la fuente.** `build_waveform_response` ya
hace demean → filtro → decimación min/max y devuelve tipos nativos de Python
(los escalares de numpy revientan `json.dumps`). La ventana absoluta cambia de
dónde sale el `Stream`, nada más.

**3. Constantes de una sola fuente.** `KAISER_BETA` y `DB_MULTIPLIER` viven en
`src/services/swarm_spectra.py`. El espectro 1D los importa. Este repo ya tiene
el antecedente de la escala de magnitud con cuatro fuentes de verdad y un token
CSS que nunca existió cayendo al fallback en silencio.

**4. El eje se deriva del DATO, no de una constante.** Medido en la base: el
techo de frecuencia varía por canal (10 / 20 / 25 Hz) y hasta dentro del mismo
canal. Un eje constante miente por factor 2. El endpoint de espectro DEVUELVE su
`sampling_rate` y su techo; el frontend los usa.

**5. Progresividad por interacción, no por toggle.** El principiante ve onda +
espectrograma. Cuando ya abrió N ventanas, aparece el espectro 1D. Cuando ya usó
el espectro, aparece el picking. La regla de aparición vive en una lib pura
testeable, no dispersa en condicionales de JSX.

**6. Lógica pura antes que canvas.** El escalado, el mapeo clic→ventana, las
fórmulas sismológicas y la regla de progresividad son funciones puras con tests.
El canvas sólo dibuja.

**7. Verificación por mutación, obligatoria.** Ver la sección de Riesgos: no es
una buena práctica opcional en este cambio, es un requisito de aceptación.

## Affected Areas

| Área | Impacto | Descripción |
|------|--------|-------------|
| `src/main.py` (~2580) | Modified | `waveform` acepta `start`/`end`; cache_key incorpora la ventana |
| `src/main.py` | New | `GET /stations/{channel}/spectra`; serie RSAM; CRUD de picks |
| `src/services/station_waveform.py` | Modified | Ventana absoluta hacia `build_waveform_response` |
| `src/services/swarm_spectra.py` | Modified | Exportar `KAISER_BETA`/`DB_MULTIPLIER` para el espectro 1D |
| `src/services/swarm_rsam.py` | Modified | Serie temporal sobre ventana absoluta (hoy sólo buffer en memoria) |
| `src/services/` | New | `signal_picks.py` — CRUD + fórmulas S-P y coda |
| `src/adapters/` | None | Sin cambios: la fuente de datos no cambia |
| `src/services/seedlink_ingestor.py` | Modified | Sólo si la serie RSAM requiere persistir muestras. **`src/workers/` NO EXISTE** pese a que `openspec/config.yaml` lo nombra: el ingestor que puebla RSAM vive acá |
| `deploy/sql/migrations/` | New | `015_signal_picks.sql` |
| `dashboard/app/(app)/stations/[channel]/page.tsx` | Modified | Pestañas `wave` (:37) y `rsam` (:38) a `enabled: true` |
| `dashboard/components/HelicorderCanvas.tsx` | Modified | Prop `onSelectWindow?`; cursor pointer condicional |
| `dashboard/components/` | New | `WaveView`, `SpectrumView`, `RsamChart`, `PickingOverlay` |
| `dashboard/lib/` | New | `waveform-scale.ts`, `helicorder-hit.ts`, `signal-picks.ts`, `progressive-disclosure.ts` |
| `dashboard/lib/station-metrics.ts` | Modified | RSAM deja de ser sólo el campo `il` |
| `dashboard/hooks/` | New | Hook de fetch de ventana con pila de zoom |
| `dashboard/messages/{es,en}.json` | Modified | Paridad obligatoria de las claves nuevas |

## Risks

| Riesgo | Probabilidad | Mitigación |
|------|------------|------------|
| **Tests verdes que no pueden fallar nunca.** Este repo YA produjo TRES: uno verificaba la variable equivocada, otro mockeaba un símbolo inexistente, el tercero esperaba un valor idéntico al fallback. **Dos de los tres los especificó el plan.** Con fórmulas sismológicas el daño es peor: un test verde certifica una distancia falsa. | **Alta** (ya pasó 3 veces) | Verificación por mutación OBLIGATORIA para cada fórmula y cada invariante: romper a propósito (cambiar vp 6.0→7.0, el 1.86 del Mc, beta 5→8, el multiplicador 20→10) y **confirmar con `rg` que la mutación se aplicó ANTES de leer el resultado** — una mutación que no muta no prueba nada. Las fórmulas se testean con valores esperados calculados A MANO, nunca con "devuelve un número". |
| El eje de frecuencia dibujado con una constante miente por factor 2 | Alta | El endpoint devuelve `sampling_rate` y techo efectivo; test que verifique que dos canales con fs distinto producen ejes distintos |
| FFT sobre datos ya decimados min/max da un espectro falso | Media | El espectro se calcula server-side sobre la señal sin decimar. Test con sinusoide de frecuencia conocida: el pico DEBE caer en ese bin |
| Ventana absoluta grande satura RAM (ObsPy a float64, ~8x) | Media | Techo de 24 h igual que `minutes`; validación en el endpoint; 422 con mensaje claro |
| Cache envenenada: la key vieja no distingue ventana absoluta | Media | La key incorpora `start`/`end`; test de que dos ventanas distintas no colisionan |
| La progresividad esconde algo que el usuario ya necesita, o no aparece nunca | Media | Regla en lib pura con tests de los umbrales; escape hatch para revelar todo manualmente; el estado persiste tolerando JSON corrupto |
| Deriva de i18n (paridad ES/EN de ~504 claves) | Media | Test de paridad de claves como parte del criterio de terminado |
| Alcance de 5 fases se desborda | Media | Cada fase mergea sola. Si se corta después de la 2, el producto quedó mejor que hoy |
| `next build` rompe el server de dev (comparten `.next`) | Alta si se olvida | NUNCA correr `next build` durante el desarrollo. `tsc --noEmit` para verificar tipos |

## Rollback Plan

Por fase, de la más barata a la más cara:

- **Fases 1-4 (sin esquema).** Todo es aditivo. `git revert` del commit de la
  fase. Los parámetros `start`/`end` son opcionales: revertir no rompe ningún
  cliente porque `minutes` sigue siendo el default. Las pestañas `wave` y `rsam`
  vuelven a `enabled: false` y la UI queda como hoy.
- **Fase 3 y 4 (endpoints nuevos).** Los endpoints nuevos no tienen consumidores
  fuera de este cambio: borrarlos no afecta nada preexistente.
- **Fase 5 (con migración).** `015_signal_picks.sql` lleva su bloque de rollback
  comentado al pie (`DROP TABLE IF EXISTS signal_picks;`), igual que
  `013_walls.sql`. **La tabla se droppea sólo si no hay picks reales de
  usuarios**; si los hay, el rollback correcto es revertir el código de la UI y
  dejar la tabla huérfana hasta decidir la migración de esos datos. La tabla es
  aditiva: ninguna tabla existente se modifica, así que revertir el código no
  deja el esquema inconsistente.
- **Feature flag.** La progresividad por interacción da un rollback parcial
  gratis: subir los umbrales al infinito esconde las herramientas avanzadas sin
  desplegar código.

## Dependencies

- ObsPy 1.4.1 — ya en `requirements.txt`, sin versión nueva.
- Sin dependencias externas nuevas ni en backend ni en frontend.
- La Fase 5 depende de la tabla `users` (existe, `001_create_users_table.sql`).
- **Prerequisito de orden**: las Fases 2-5 NO pueden empezar sin la Fase 1.
- Entorno verificado: venv en `venv/` (NO `.venv/`), tests de integración con
  testcontainer `postgres:16-alpine`, Node de nvm v22.16.0, vitest desde
  `dashboard/` con `./node_modules/.bin/vitest` (nunca `npx`).

## Success Criteria

- [ ] `GET /stations/{channel}/waveform?start=&end=` devuelve la ventana pedida,
      probado con **curl contra el servidor real**, no sólo con mocks
- [ ] Un clic en un evento visible del helicorder de `AK.FIRE..BHZ` abre esa
      ventana exacta en el wave view
- [ ] El zoom por arrastre re-pide la ventana al backend (verificable en la
      pestaña de red: hay un request nuevo, no un re-render)
- [ ] El espectro 1D de una sinusoide sintética de frecuencia conocida tiene su
      pico en ese bin
- [ ] Dos canales con `sampling_rate` distinto producen ejes de frecuencia
      distintos (el eje NO es constante)
- [ ] `d = (tS-tP) * (vp*vs)/(vp-vs)` y `Mc = 1.86*log10(t) - 0.85` tienen tests
      con valores esperados **calculados a mano**
- [ ] **Verificación por mutación documentada**: para cada fórmula y cada
      invariante, consta qué se rompió, la confirmación por `rg` de que la
      mutación se aplicó, y qué test se puso rojo
- [ ] Los picks sobreviven a recargar la página y a cerrar sesión (están en la
      base, no en localStorage)
- [ ] El export CSV abre en una planilla con las mediciones de una sesión
- [ ] Un usuario nuevo NO ve el picking en su primera visita; aparece después de
      haber usado las herramientas básicas
- [ ] Paridad ES/EN: cero claves en `es.json` que falten en `en.json` y viceversa
- [ ] Suite completa verde (baseline al abrir este cambio: **633 tests / 65
      archivos** en frontend) y `tsc --noEmit` en 0
- [ ] Nombres de identificadores en inglés, comentarios en español (convención
      del repo); comillas simples en TS (el proyecto no tiene config de prettier
      y los defaults reformatean a comillas dobles)
- [ ] QA visual del usuario aprobado por fase (el QA visual lo hace el usuario:
      levantar el stack y pasarle la URL exacta con la lista de qué mirar)
