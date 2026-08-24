# Delta for dashboard-ui — Analíticas profesionales de señal

Delta sobre `openspec/specs/dashboard-ui/spec.md`. Todo lo de acá es **ADDED** o
**MODIFIED** sobre el comportamiento vigente del detalle de estación
(`dashboard/app/(app)/stations/[channel]/page.tsx`).

---

## MODIFIED Requirements

### Requirement: Pestañas wave y rsam habilitadas

Las pestañas `wave` y `rsam` del detalle de estación MUST estar habilitadas
(`enabled: true`) y navegables.

(Previously: ambas están declaradas con `enabled: false` en
`dashboard/app/(app)/stations/[channel]/page.tsx:37-38`, visibles como
"próximamente" y sin contenido.)

Cada pestaña MUST habilitarse en la fase que entrega su contenido: `wave` en la
Fase 2 y `rsam` en la Fase 4. Una pestaña MUST NOT quedar habilitada apuntando a
una vista vacía.

#### Scenario: La pestaña wave abre el wave view

- GIVEN el detalle de la estación `AK.FIRE..BHZ`
- WHEN el usuario selecciona la pestaña `wave`
- THEN se renderiza el wave view con la ventana activa
- AND la pestaña NO muestra el rótulo de "próximamente"

#### Scenario: La pestaña rsam abre la serie temporal

- GIVEN el detalle de una estación
- WHEN el usuario selecciona la pestaña `rsam`
- THEN se renderiza el gráfico de la serie RSAM sobre la ventana activa

#### Scenario: Un clic en el helicorder abre esa ventana en el wave view

- GIVEN el helicorder de `AK.FIRE..BHZ` mostrando 24 h
- WHEN el usuario hace clic sobre un evento visible
- THEN la vista cambia al wave view
- AND la ventana cargada es la que devuelve la traducción del clic (ver
  `signal-analysis`, requirement de traducción clic→ventana)
- AND se emitió una petición al backend con `start`/`end` absolutos

#### Scenario: El cursor indica que el helicorder es clickeable sólo si lo es

- GIVEN un `HelicorderCanvas` renderizado SIN el callback de selección de ventana
- WHEN el puntero se ubica sobre el área de trazas
- THEN el cursor NO cambia a `pointer`
- AND un clic no dispara navegación

---

## ADDED Requirements

### Requirement: Progresividad por interacción

Las herramientas avanzadas de análisis MUST aparecer en función de la
interacción previa del usuario, no de un toggle básico/avanzado ni de un
"mostrar todo" permanente.

La regla de aparición MUST vivir en una función pura testeable
(`dashboard/lib/progressive-disclosure.ts`), NO dispersa en condicionales de JSX.

Los umbrales MUST ser constantes nombradas y explícitas. Los niveles son:

| Nivel | Se desbloquea cuando | Habilita |
|-------|----------------------|----------|
| 0 — inicial | siempre | onda + espectrograma |
| 1 — espectro | el usuario abrió al menos `WINDOWS_FOR_SPECTRUM` ventanas | espectro 1D |
| 2 — picking | el usuario ya usó el espectro 1D al menos una vez | picking P/S/coda y export |

El estado de progreso MUST persistir entre visitas, siguiendo el mismo patrón de
`dashboard/lib/helicorder-settings.ts`: clamps, fallback a defaults y tolerancia
a JSON corrupto.

#### Scenario: Un usuario nuevo no ve el picking

- GIVEN un usuario sin estado de progreso guardado
- WHEN abre el detalle de una estación por primera vez
- THEN ve la onda y el espectrograma
- AND NO ve el control de espectro 1D
- AND NO ve los controles de picking

#### Scenario: El espectro 1D aparece al alcanzar el umbral de ventanas

- GIVEN un usuario con `WINDOWS_FOR_SPECTRUM - 1` ventanas abiertas registradas
- WHEN abre una ventana más
- THEN el espectro 1D pasa a estar visible
- AND el picking sigue oculto

#### Scenario: Justo por debajo del umbral el espectro sigue oculto

- GIVEN un usuario con exactamente `WINDOWS_FOR_SPECTRUM - 1` ventanas abiertas
- WHEN se evalúa la regla de aparición
- THEN el espectro 1D NO está visible

Nota de falsabilidad: este escenario y el anterior existen como PAR. Con uno solo,
cambiar la comparación de `>=` a `>` (o el umbral a 0) dejaría el test en verde.
El par fija el borde exacto.

#### Scenario: El picking aparece después de usar el espectro

- GIVEN un usuario que ya tiene el espectro 1D desbloqueado y NO lo usó nunca
- WHEN se evalúa la regla
- THEN el picking está oculto
- WHEN el usuario usa el espectro 1D una vez
- THEN el picking pasa a estar visible

#### Scenario: El progreso sobrevive a recargar

- GIVEN un usuario que ya desbloqueó el espectro 1D
- WHEN recarga la página
- THEN el espectro 1D sigue visible sin tener que volver a abrir ventanas

#### Scenario: JSON corrupto en el almacenamiento no rompe la vista

- GIVEN un estado de progreso guardado con contenido no parseable (por ejemplo
  `"{no-es-json"`)
- WHEN se carga el detalle de la estación
- THEN la vista renderiza sin lanzar
- AND el estado usado es el de defaults (nivel 0)

#### Scenario: Valores fuera de rango se recortan

- GIVEN un estado guardado con un contador de ventanas negativo o absurdamente
  grande
- WHEN se carga
- THEN el valor se recorta al rango válido
- AND la regla de aparición se evalúa sobre el valor recortado

#### Scenario: Escape hatch para revelar todo manualmente

- GIVEN un usuario en nivel 0
- WHEN activa el control explícito de "mostrar todas las herramientas"
- THEN todas las herramientas avanzadas quedan visibles inmediatamente, sin
  esperar a cumplir umbrales
- AND esa elección persiste entre visitas

#### Scenario: Subir los umbrales esconde las herramientas sin desplegar código

- GIVEN un usuario que ya tenía el picking visible
- WHEN los umbrales se elevan por encima de su progreso registrado
- THEN el picking deja de estar visible
- AND el estado de progreso del usuario NO se borra

Nota de falsabilidad: este escenario verifica que la regla de aparición se
evalúa contra los umbrales EN CADA RENDER, y no que el nivel alcanzado se
congele al desbloquearse. La mutación de verificación es persistir el nivel
resuelto en vez de los contadores crudos: el escenario MUST quedar en rojo.

### Requirement: UI de picking de un solo nivel

La UI de picking MUST ofrecer acciones directas de un solo nivel: marcar P,
marcar S, marcar coda. El sistema MUST NOT replicar los menús anidados de tres
niveles de SWARM (fase → onset → polaridad → peso 0-4).

#### Scenario: Marcar P es una sola acción

- GIVEN el wave view con el picking visible
- WHEN el usuario marca una fase P en un instante
- THEN el pick queda registrado sin pasar por ningún submenú
- AND se muestra en el wave view en la posición del instante marcado

#### Scenario: Con P y S se muestra la distancia

- GIVEN un pick P y un pick S marcados en la misma traza
- WHEN se muestran las mediciones
- THEN aparece la distancia calculada según el requirement de distancia S-P del
  dominio `signal-analysis`
- AND el valor mostrado corresponde al del cálculo, no a un placeholder

#### Scenario: Con S antes que P no se muestra distancia

- GIVEN un pick S marcado en un instante ANTERIOR al pick P
- WHEN se muestran las mediciones
- THEN NO se muestra un valor de distancia
- AND se indica que el orden de fases es inválido
- AND la vista NO muestra `NaN` ni un número negativo

#### Scenario: Con coda se muestra la magnitud

- GIVEN un pick P y un pick de fin de coda
- WHEN se muestran las mediciones
- THEN aparece la magnitud de coda según el requirement correspondiente
- AND una duración de coda de 100 s se muestra como `2.87`

#### Scenario: Borrar un pick actualiza las mediciones

- GIVEN P, S y coda marcados con sus mediciones visibles
- WHEN el usuario borra el pick S
- THEN la distancia S-P desaparece de las mediciones
- AND la magnitud de coda sigue mostrándose

### Requirement: Paridad de claves i18n ES/EN

Toda cadena de interfaz nueva introducida por este change MUST existir en
`dashboard/messages/es.json` Y en `dashboard/messages/en.json`.

#### Scenario: Cero claves huérfanas en cualquier dirección

- GIVEN los archivos `es.json` y `en.json` después de este change
- WHEN se comparan sus conjuntos de claves (recursivamente, por path completo)
- THEN el conjunto de claves de `es.json` es exactamente igual al de `en.json`
- AND no hay ninguna clave presente en uno y ausente en el otro

#### Scenario: Ninguna cadena visible queda hardcodeada

- GIVEN las vistas nuevas (wave view, espectro 1D, serie RSAM, picking, export)
- WHEN se inspecciona su código
- THEN todos los textos visibles provienen del sistema de traducciones
- AND no hay literales de interfaz en español ni en inglés incrustados en el JSX

### Requirement: Convenciones de código y presupuesto de regresión

#### Scenario: La suite completa queda verde

- GIVEN la baseline al abrir este change: 633 tests en 65 archivos de frontend
- WHEN se corre la suite completa después de cada fase
- THEN no hay tests en rojo
- AND el conteo de tests es mayor o igual a la baseline (las fases sólo agregan)

#### Scenario: Los tipos compilan

- GIVEN el código de la fase terminada
- WHEN se corre la verificación de tipos sin emitir
- THEN termina con 0 errores

#### Scenario: Idioma del código

- GIVEN los archivos nuevos de este change
- WHEN se inspeccionan
- THEN los identificadores están en inglés
- AND los comentarios están en español
