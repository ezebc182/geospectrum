# Signal Analysis Specification — Fórmulas sismológicas y lógica pura

Dominio NUEVO: no existe `openspec/specs/signal-analysis/spec.md`, por lo que
este documento es una spec COMPLETA (no delta), acotada al alcance de este change.

## Purpose

Especifica el comportamiento de la lógica pura de análisis de señal: las dos
fórmulas sismológicas portadas de SWARM (CC0, `PickData.java`), el mapeo de un
clic del helicorder a una ventana absoluta, y el escalado tiempo↔píxel del wave
view.

Todo lo especificado acá son FUNCIONES PURAS: mismo input, mismo output, sin I/O.
El canvas sólo dibuja; ninguna de estas reglas MUST vivir en condicionales de JSX.

## Requisito transversal de calidad — verificación por mutación

Este repositorio ya produjo TRES tests verdes que no podían fallar nunca (uno
verificaba la variable equivocada, otro mockeaba un símbolo inexistente, el
tercero esperaba un valor idéntico al fallback), y DOS de los tres los especificó
el plan. Por lo tanto, para este dominio:

1. Cada escenario numérico MUST llevar un valor esperado CONCRETO calculado a
   mano. Un aserto de la forma "devuelve un número", "es mayor que cero" o "no es
   `NaN`" NO satisface ningún requirement de este documento.
2. Para cada constante física y cada invariante nombrado abajo, el criterio de
   aceptación MUST incluir una verificación por mutación: romper la constante a
   propósito, **confirmar por `rg` que la mutación quedó escrita en el archivo
   ANTES de correr los tests**, y registrar qué test se puso rojo.
3. La confirmación previa por `rg` no es opcional: en este repo ya ocurrió que un
   reemplazo multilínea con `sd` falló en silencio y produjo un falso verde. Una
   mutación que no muta no prueba nada.

## Requirements

### Requirement: Distancia epicentral a partir del intervalo S-P

El sistema MUST calcular la distancia epicentral aproximada a partir del intervalo
S-P con la fórmula de SWARM:

```
d = (tS - tP) * (vp * vs) / (vp - vs)
```

con `vp = 6.0` km/s y `vp / vs = 1.73` (de donde `vs = 6.0 / 1.73 ≈ 3.4682` km/s).

Las constantes `vp` y la razón `vp/vs` MUST estar declaradas UNA sola vez y ser
importadas por todo consumidor. El sistema MUST NOT redeclararlas en el frontend
y en el backend con valores independientes.

#### Scenario: S-P de 10 segundos da 82.19 km

- GIVEN `tP` y `tS` separados por exactamente 10.0 segundos
- WHEN se calcula la distancia
- THEN el resultado es `82.1918` km con tolerancia de ±0.001 km

Cálculo a mano: `vs = 6.0 / 1.73 = 3.4682080924855490`;
`vp * vs = 20.809248554913294`; `vp - vs = 2.531791907514451`;
cociente `= 8.219178082191782`; por 10.0 → `82.19178082191782`.

#### Scenario: S-P de 5 segundos da la mitad

- GIVEN `tP` y `tS` separados por exactamente 5.0 segundos
- WHEN se calcula la distancia
- THEN el resultado es `41.0959` km con tolerancia de ±0.001 km

Cálculo a mano: `5.0 * 8.219178082191782 = 41.09589041095891`.

#### Scenario: S-P de 1 segundo da el factor de escala desnudo

- GIVEN `tP` y `tS` separados por exactamente 1.0 segundo
- WHEN se calcula la distancia
- THEN el resultado es `8.2192` km con tolerancia de ±0.001 km

Nota de falsabilidad: los tres escenarios anteriores usan valores esperados
DISTINTOS entre sí y distintos de cualquier constante del código (ni 6.0 ni 1.73
ni el intervalo aparecen como resultado). Un test que esperara "un número
positivo" pasaría con cualquier fórmula equivocada.

#### Scenario: Mutación de vp pone la fórmula en rojo

- GIVEN la constante `vp = 6.0` mutada a `7.0`
- AND confirmado por `rg` que el archivo contiene `7.0` en esa constante
- WHEN se corren los tests de distancia S-P
- THEN al menos un test queda en ROJO
- AND el valor calculado con vp mutado (`vs = 7.0/1.73 = 4.046242774566474`,
  factor `= 9.589041095890414`, para S-P de 10 s → `95.8904` km) NO coincide con
  el esperado de `82.1918` km

#### Scenario: Mutación de la razón vp/vs pone la fórmula en rojo

- GIVEN la constante `vp/vs = 1.73` mutada a `1.80`
- AND confirmado por `rg` que el archivo contiene `1.80`
- WHEN se corren los tests de distancia S-P
- THEN al menos un test queda en ROJO

#### Scenario: S-P nulo o negativo no produce distancia

- GIVEN `tS - tP` igual a `0`
- WHEN se calcula la distancia
- THEN la función NO devuelve un número de distancia
- AND señala explícitamente que el intervalo es inválido (excepción tipada o
  resultado nulo, según el contrato de la capa; nunca `0`, `NaN` ni `Infinity`
  silenciosos)

#### Scenario: S de antes que P es rechazado

- GIVEN `tS` anterior a `tP` (intervalo negativo, por ejemplo `-3.0` segundos)
- WHEN se calcula la distancia
- THEN la función señala el intervalo inválido de la misma forma
- AND MUST NOT devolver una distancia negativa

Nota de falsabilidad: sin esta guarda, un S-P de `-3.0` s devolvería
`-24.657` km — un número perfectamente serializable que la UI dibujaría como si
fuera una medición. La mutación de verificación es eliminar la guarda y comprobar
que este escenario queda en rojo.

### Requirement: Magnitud de coda

El sistema MUST calcular la magnitud de coda con la fórmula de SWARM:

```
Mc = 1.86 * log10(t) - 0.85
```

donde `t` es la duración de la coda en segundos. Los coeficientes `1.86` y `0.85`
MUST estar declarados una sola vez.

#### Scenario: Coda de 100 segundos da Mc 2.87

- GIVEN una coda de duración exactamente `100.0` segundos
- WHEN se calcula la magnitud de coda
- THEN el resultado es `2.87` con tolerancia de ±0.001

Cálculo a mano: `log10(100) = 2`; `1.86 * 2 = 3.72`; `3.72 - 0.85 = 2.87`.

#### Scenario: Coda de 10 segundos da Mc 1.01

- GIVEN una coda de duración exactamente `10.0` segundos
- WHEN se calcula la magnitud de coda
- THEN el resultado es `1.01` con tolerancia de ±0.001

Cálculo a mano: `log10(10) = 1`; `1.86 - 0.85 = 1.01`.

#### Scenario: Coda de 1 segundo da Mc -0.85

- GIVEN una coda de duración exactamente `1.0` segundo
- WHEN se calcula la magnitud de coda
- THEN el resultado es `-0.85` con tolerancia de ±0.001

Cálculo a mano: `log10(1) = 0`; `0 - 0.85 = -0.85`. El resultado es NEGATIVO y
eso es correcto: una coda de 1 s es un evento diminuto. La implementación MUST NOT
recortar a cero.

#### Scenario: Coda de 60 segundos da Mc 2.4574

- GIVEN una coda de duración exactamente `60.0` segundos
- WHEN se calcula la magnitud de coda
- THEN el resultado es `2.4574` con tolerancia de ±0.001

Cálculo a mano: `log10(60) = 1.7781512503836436`;
`1.86 * 1.7781512503836436 = 3.307361325713577`; menos `0.85` →
`2.457361325713577`. Este escenario existe porque los tres anteriores usan
potencias exactas de 10, donde `log10` da enteros: si la implementación usara
`log` natural en vez de `log10`, los tres seguirían fallando pero éste es el que
detecta además cualquier atajo basado en contar dígitos.

#### Scenario: Mutación del coeficiente 1.86 pone la fórmula en rojo

- GIVEN el coeficiente `1.86` mutado a `2.00`
- AND confirmado por `rg` que el archivo contiene el valor mutado
- WHEN se corren los tests de magnitud de coda
- THEN al menos un test queda en ROJO
- AND, en particular, el escenario de 1 segundo SIGUE EN VERDE (porque
  `log10(1) = 0` anula el coeficiente): por eso ese escenario NO alcanza por sí
  solo y la batería MUST incluir al menos uno con `t != 1`

#### Scenario: Mutación del término -0.85 pone la fórmula en rojo

- GIVEN el término `0.85` mutado a `0.95`
- AND confirmado por `rg` que el archivo contiene el valor mutado
- WHEN se corren los tests de magnitud de coda
- THEN TODOS los escenarios numéricos de coda quedan en ROJO (el término
  independiente afecta a los cuatro)

#### Scenario: Duración de coda cero es rechazada

- GIVEN `t = 0`
- WHEN se calcula la magnitud de coda
- THEN la función señala explícitamente la entrada inválida
- AND MUST NOT devolver `-Infinity` (que es lo que `log10(0)` produce)

#### Scenario: Duración de coda negativa es rechazada

- GIVEN `t = -5.0`
- WHEN se calcula la magnitud de coda
- THEN la función señala explícitamente la entrada inválida
- AND MUST NOT devolver `NaN` (que es lo que `log10(-5)` produce)

Nota de falsabilidad: sin las guardas, `t = 0` propaga `-Infinity` y `t < 0`
propaga `NaN` hasta la UI y hasta el CSV exportado. La mutación de verificación es
eliminar las guardas: los dos escenarios anteriores MUST quedar en rojo.

### Requirement: Traducción de un clic del helicorder a ventana absoluta

El sistema MUST traducir un clic sobre el canvas del helicorder a una ventana
absoluta `{startMs, endMs}`, mediante una función pura.

#### Scenario: Un clic en el inicio del rango mapea al inicio del rango

- GIVEN un helicorder que cubre desde `T0` hasta `T0 + 24 h`
- WHEN se traduce un clic en la primera columna de la primera línea
- THEN el `startMs` resultante corresponde a `T0` (con tolerancia de la duración
  de un píxel)

#### Scenario: Un clic en el final del rango mapea al final del rango

- GIVEN el mismo helicorder
- WHEN se traduce un clic en la última columna de la última línea
- THEN el `endMs` resultante es menor o igual a `T0 + 24 h`

#### Scenario: La ventana devuelta está centrada en el instante clickeado

- GIVEN un helicorder y un clic que cae en el instante `T`
- WHEN se traduce con una duración de ventana `W`
- THEN `startMs` es `T - W/2` y `endMs` es `T + W/2`, ambos recortados al rango
  del helicorder

#### Scenario: La ventana nunca excede los bordes del helicorder

- GIVEN un clic a menos de `W/2` del inicio del rango
- WHEN se traduce
- THEN `startMs` es exactamente `T0` (no un valor anterior)
- AND `endMs - startMs` sigue siendo mayor a cero

#### Scenario: Un clic fuera del área de datos no produce ventana

- GIVEN un clic en el margen del canvas, fuera del área de trazas
- WHEN se traduce
- THEN la función devuelve nulo (no una ventana degenerada)

Nota de falsabilidad: cada escenario nombra un valor concreto (`T0`, `T - W/2`,
nulo). Un test que sólo verificara `startMs < endMs` pasaría con un mapeo lineal
completamente equivocado.

### Requirement: Escalado tiempo↔píxel del wave view

El sistema MUST proveer funciones puras `timeToX` / `xToTime`, `clampWindow`,
`zoomWindow` y `dragSelection` para el wave view.

#### Scenario: Ida y vuelta timeToX / xToTime

- GIVEN una ventana `[start, end]` y un ancho de canvas de `1000` píxeles
- WHEN se aplica `xToTime(timeToX(t))` a un instante `t` cualquiera dentro de la
  ventana
- THEN se recupera `t` con un error menor a la duración de un píxel

#### Scenario: Los extremos mapean a los extremos

- GIVEN una ventana `[start, end]` y un ancho de `1000` píxeles
- WHEN se calcula `timeToX(start)` y `timeToX(end)`
- THEN dan `0` y `1000` respectivamente

#### Scenario: La ventana mínima es de 1 segundo

- GIVEN una ventana de duración `0`
- WHEN se aplica `clampWindow`
- THEN la duración resultante es exactamente `1` segundo

Nota de falsabilidad: la razón de existir de este clamp es que una ventana de
duración 0 hace división por cero en `timeToX`. La mutación de verificación es
quitar el clamp: el escenario MUST quedar en rojo o producir `Infinity`.

#### Scenario: El zoom queda anclado al cursor

- GIVEN una ventana `[0, 100]` (segundos) y el cursor en el instante `25`
- WHEN se aplica un zoom que reduce la ventana a la mitad (duración `50`)
- THEN el instante `25` sigue cayendo en la MISMA posición horizontal en píxeles
  que antes del zoom
- AND la nueva ventana es `[12.5, 62.5]`

Nota de falsabilidad: el valor esperado `[12.5, 62.5]` es distinto del que
produciría un zoom centrado en la ventana (`[25, 75]`). Un test que sólo
verificara que la duración se redujo a la mitad NO distinguiría ambos.

#### Scenario: La selección por arrastre se normaliza

- GIVEN un arrastre desde el píxel `800` hasta el píxel `200` (de derecha a
  izquierda)
- WHEN se calcula `dragSelection`
- THEN el resultado tiene `start` correspondiente al píxel `200` y `end` al `800`
- AND `start < end`

#### Scenario: El zoom re-pide la ventana al backend

- GIVEN una ventana ya cargada y dibujada
- WHEN el usuario hace zoom por arrastre sobre una subventana
- THEN se emite una petición NUEVA al backend con la subventana absoluta
- AND el dibujo NO se hace re-escalando los pares min/max ya recibidos

Nota de falsabilidad: hacer zoom sobre datos ya decimados min/max muestra
artefactos de la decimación como si fueran señal. La verificación MUST observar
la petición (contador de llamadas al fetch o pestaña de red), no el resultado
visual: un re-render sin petición se ve parecido y es incorrecto.

#### Scenario: La pila de zoom permite volver atrás

- GIVEN una ventana inicial `W0` sobre la que se hizo zoom a `W1` y luego a `W2`
- WHEN se aplica "volver atrás" una vez
- THEN la ventana activa es `W1`
- AND aplicándolo otra vez es `W0`
- AND aplicándolo una tercera vez sigue siendo `W0` (la pila no se desborda a
  nulo)
