# TECT-2: dorsales divergentes punteadas

Continúa `2026-07-27-plate-boundaries-usgs-style-design.md` (TECT-1), que dejó la capa con dos
trazos. Este documento cubre el tercero y el cambio de dataset que lo hace posible.

## Intent

El USGS dibuja los límites de placas con **tres** trazos, no dos: sólido con dientes de sierra
(subducción), sólido (transformantes) y **punteado (divergentes)**. TECT-1 implementó los dos
primeros porque el dataset vendorizado no permitía distinguir el tercero.

## Scope

### In Scope

- Migrar el dataset de `PB2002_boundaries` a `PB2002_steps`, que trae el tipo de contacto.
- Preprocesamiento offline del dataset (`scripts/build_plate_boundaries.py`).
- Tercer trazo punteado para los límites divergentes.

### Out of Scope

- Leyenda visual de los tres trazos en el mapa (ticket propio).
- Vista 3D (globe.gl): reusa `plate-boundaries.ts` sin cambios.
- Tooltip con el tipo de contacto por feature.

## Hallazgo 1: `boundaries.json` no puede clasificar divergentes

Sus properties son exactamente seis, idénticas en los 241 features:

```json
{"LAYER":"plate boundary","Name":"AF-AN","Source":"Mueller et al. [1987]",
 "PlateA":"AF","PlateB":"AN","Type":""}
```

`Type` solo toma `"subduction"` o cadena vacía. No hay ningún campo que separe una dorsal de una
falla transformante: las dos caen en la cadena vacía. **No existe camino barato**; el tercer trazo
obliga a cambiar de dataset.

`PB2002_steps.json` (mismo autor, mismo modelo) trae `STEPCLASS` con los siete tipos reales:

| STEPCLASS | Features | Contacto | Trazo |
|---|---|---|---|
| OSR | 1875 | dorsal oceánica | punteado |
| CRB | 474 | rift continental | punteado |
| SUB | 1129 | subducción | grueso + dientes |
| OTF | 1147 | transformante oceánica | fino |
| CTF | 457 | transformante continental | fino |
| CCB | 401 | convergente continental | fino |
| OCB | 341 | convergente océano-continente | fino |

## Hallazgo 2: el costo está en los vértices, no en los features

`steps.json` crudo son **9,9 MB y 269.153 vértices**, contra los 6.292 que renderiza hoy la capa.
Servirlo tal cual sería una regresión de performance de 43x a cambio de un estilo de línea.

La intuición inicial fue **unir tramos contiguos** del mismo `STEPCLASS`. Se midió y **no alcanza**:

| Pipeline | Features | Vértices |
|---|---|---|
| Crudo | 5824 | 269.153 |
| Solo fusión | 1687 | 264.987 (**−1,5%**) |
| Fusión + Douglas-Peucker ε=0,01° | 1687 | **5.748 (−97,9%)** |

Fusionar solo elimina el vértice duplicado de cada juntura. Lo que reduce el costo es
**simplificar**: el 53% de los segmentos del dataset mide menos de 1,1 km, detalle invisible a
cualquier zoom al que se dibuja una capa mundial.

La fusión sigue siendo necesaria, pero como **paso previo** a la simplificación: simplificar los
5824 tramos por separado conservaría los extremos de todos ellos.

## Decisión 1: preprocesar offline y vendorizar el resultado

`scripts/build_plate_boundaries.py` descarga `steps.json`, fusiona, simplifica (ε=0,01° ≈ 1,1 km),
redondea a 3 decimales y escribe `dashboard/public/geo/plate-boundaries.json`. El output se
commitea; el crudo descargado va a `.cache/`, ignorado por git.

**Trade-off explícito.** El asset servido pasa de **12,3 KB a 38,0 KB gzip** (3x). No es una
mejora de peso: es el precio de tener 1687 features clasificados en vez de 241 con dos categorías.
Se acepta porque es un asset estático cacheable, y porque **el eje que sí importa para el render
mejora**: los vértices bajan de 6.292 a 5.748 y el decorador de símbolos corre sobre 73 features en
vez de 65 (prácticamente igual que antes).

## Decisión 2: la polaridad sigue saliendo del separador

Los dientes de sierra se orientan con la polaridad codificada en el separador (`/` vs `\`), que
TECT-1 leía de `Name`. `steps.json` no tiene ese campo, lo que parecía un riesgo de migración.

Se verificó que **`PLATEBOUND` conserva el separador**: los 73 tramos de subducción del dataset
generado lo traen (50 con `/`, 23 con `\`). Cobertura 100%, cero features sin polaridad.
`parsePolarity()` no cambia; solo cambia el campo del que lee.

Se evaluó y **descartó** derivar la polaridad de `AZIMUTHCEN`/`VELOCITYAZ`: el ángulo relativo cae
en (0°, 180°) en 1126 de los 1129 tramos SUB del dataset crudo. Es un invariante de construcción
—Bird orienta cada step para que la velocidad relativa quede a la derecha—, no una señal. Una regla
basada en ese signo clasificaría todo igual y fallaría en Chile, Japón y Cascadia.

Validación geológica de la regla del separador, 6/6 zonas de control: Perú-Chile (E), Japón (W),
Cascadia (E), Java (NE), Aleutianas (N), Tonga (W).

## Decisión 3: mapeo de siete tipos a tres trazos

`KIND_BY_STEP_CLASS` en `plate-boundaries.ts`:

| Trazo | STEPCLASS | Features | Estilo |
|---|---|---|---|
| `subduction` | SUB | 73 | `weight: 2`, `opacity: 0.85`, dientes cada ~40px |
| `divergent` | OSR, CRB | 698 | `weight: 1.5`, `opacity: 0.75`, `dashArray: '6 5'` |
| `other` | OTF, CTF, CCB, OCB | 916 | `weight: 1.2`, `opacity: 0.65` |

Los divergentes agrupan dorsales oceánicas y rifts continentales: en ambos las placas se separan,
que es lo que el punteado representa. Las convergencias sin subducción (CCB, OCB) van con el trazo
neutro porque PB2002 no identifica en ellas una placa cabalgante, así que no hay lado hacia el cual
orientar dientes.

Se conserva el rojo `#dc2626` para los tres: la diferenciación es por grosor, opacidad y patrón.

El orden de dibujo es `other` → `divergent` → `subduction`, para que el trazo grueso quede encima
en los cruces.

## Manejo de errores

Sin cambios respecto de TECT-1: `classify()` degrada a `'other'` ante un `STEPCLASS` desconocido, y
el decorador de símbolos sigue envuelto en try/catch para que una falla del plugin deje las líneas
dibujadas en vez de romper el mapa.

## Testing

29 tests en `plate-boundaries.test.ts` (antes 20). Los nuevos cubren:

- Clasificación de los siete `STEPCLASS` a los tres trazos.
- Que solo el trazo divergente lleve `dashArray`.
- Contrato con el dataset regenerado: 1687 features, 73/698/916 por trazo, 100% de subducción con
  polaridad parseable, y ningún `STEPCLASS` fuera de los siete conocidos.
- **Presupuesto de vértices**: falla si una regeneración supera los 6.292 del dataset anterior.
- Los 15 tramos que no son de subducción y traen separador: se fija como propiedad conocida del
  dataset, no como síntoma de desalineación.

Se conservó el test geológico de Chile/Perú de TECT-1 (`NZ\SA` → dientes al este), que es el que
protege contra el bug de orientación de `03f2ffc`.

## Verificación

Tests y typecheck no alcanzan: en TECT-1 los 37 tests pasaban con la capa sin renderizar. Se
verificó en navegador contando paths del SVG por firma de estilo:

| Estilo en el DOM | Paths | Esperado |
|---|---|---|
| `w=1.2 op=0.65` sólido | 916 | 916 `other` |
| `w=1.5 op=0.75 dash=6 5` | 698 | 698 `divergent` |
| `w=2 op=0.85` sólido | 73 | 73 `subduction` |

Los dientes de sierra se dibujan por viewport (1 en el Atlántico, 16 en Chile, 27 en Japón): el
decorador solo pinta lo visible. Fetch de `/geo/plate-boundaries.json` con status 200, y dorsal
Atlántica confirmada punteada en la captura.

## Rollback

Revertir el commit restaura `plate-boundaries.json` al dataset anterior junto con el código que lo
lee: los dos viajan en el mismo commit, así que no hay estado intermedio donde el módulo espere un
esquema que el asset no tiene.
