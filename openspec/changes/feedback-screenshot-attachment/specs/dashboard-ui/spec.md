# Delta for Dashboard UI — Captura de pantalla opcional en el widget de feedback

Delta sobre `openspec/changes/feedback-beta-testers/specs/dashboard-ui/spec.md`
(mergeado a `main`; sin spec archivada aún en `openspec/specs/dashboard-ui/`
que cubra feedback — la fuente vigente es la del change base). Todo lo de acá
es **ADDED**: captura automática al abrir el widget, aviso de limitación
WebGL, subida a la URL prefirmada, thumbnail y lightbox en el tablero. Ningún
requirement del spec base se modifica: el widget y el tablero siguen
funcionando exactamente igual cuando la captura falla, se descarta o no
existe.

## Decisiones tomadas en esta spec (heredadas del spec de `feedback` de este
mismo change; ver ahí la justificación completa)

| Tema | Decisión |
|------|----------|
| Cap de tamaño/dimensión | 1920px lado largo, 2 MB tras compresión; si excede, se descarta la captura (no se sube, no bloquea el envío) |
| Momento de la captura y subida | Al ABRIR el widget, no al enviar: `POST /feedback/upload-url` se llama al abrir, la subida a R2 corre en paralelo mientras el tester escribe |
| Qué pasa si presign/captura/subida fallan | El widget sigue funcionando como si la captura no existiera: `POST /feedback` se envía SIN `screenshot_key` |

## ADDED Requirements

### Requirement: Captura automática del viewport al abrir el widget

Al abrir el dialog del widget de feedback, el sistema MUST disparar
`modern-screenshot` sobre el contenedor de la app para producir un PNG del
viewport visible, EN PARALELO con que el tester elige tipo y escribe el
`body` — la captura MUST NOT bloquear ni demorar la apertura del dialog ni la
edición del texto.

El PNG MUST redimensionarse/comprimirse client-side a un máximo de 1920px en
el lado largo y 2 MB de tamaño final (decidido en spec de `feedback`, ver
tabla). Si tras comprimir sigue excediendo 2 MB, el sistema MUST descartar la
captura silenciosamente (sin mostrar error bloqueante) y comportarse como si
la captura hubiera fallado.

Inmediatamente después de producir el PNG (o de descartarlo por tamaño), el
widget MUST llamar a `POST /feedback/upload-url` y, si obtiene una URL
válida, MUST subir el PNG con `PUT` directo a esa URL — nunca a través del
backend FastAPI. Si el `PUT` a R2 tiene éxito antes de que el tester envíe el
reporte, el `screenshot_key` devuelto por el presign MUST viajar en el body
de `POST /feedback`; si no, `POST /feedback` MUST enviarse sin ese campo.

Cualquier fallo en cualquier paso de este flujo — `modern-screenshot` lanza
excepción, `POST /feedback/upload-url` falla o responde no-200, el `PUT` a R2
falla o no termina antes del envío del reporte — MUST degradar
silenciosamente: el dialog MUST NOT mostrar ningún error de captura al
tester salvo el aviso de WebGL (requirement siguiente), y el envío del
reporte MUST proceder sin `screenshot_key`.

#### Scenario: La captura se sube en paralelo mientras el tester escribe

- GIVEN un tester que abre el widget de feedback
- WHEN el widget dispara la captura y el presign al abrir, y el tester tarda
  15 segundos en elegir tipo y escribir el `body`
- THEN para cuando el tester hace click en enviar, la subida a R2 ya
  terminó (o falló) sin haber bloqueado la escritura del texto
- AND si la subida tuvo éxito, `POST /feedback` incluye el `screenshot_key`
  devuelto por el presign

#### Scenario: Un PNG demasiado grande se descarta sin bloquear el envío

- GIVEN un tester en una vista con un DOM muy grande cuya captura, tras
  comprimir a 1920px de lado largo, sigue superando 2 MB
- WHEN el tester envía el reporte
- THEN `POST /feedback` se envía SIN `screenshot_key`
- AND el envío responde 201 igual que si no hubiera captura, sin ningún
  mensaje de error visible por el descarte

#### Scenario: Un fallo de captura, presign o subida no bloquea el envío

- GIVEN que `modern-screenshot` lanza una excepción al capturar (o
  `POST /feedback/upload-url` responde 503, o el `PUT` a R2 falla por red)
- WHEN el tester completa el reporte y lo envía
- THEN `POST /feedback` se envía SIN `screenshot_key`
- AND la respuesta es 201 con la confirmación normal de envío del spec base
- AND el tester NO ve ningún mensaje de error relacionado con la captura

### Requirement: Aviso de limitación con vistas WebGL

Al abrir el widget, el sistema MUST detectar si la página actual tiene
montado un `<canvas>` cuyo contexto es WebGL o WebGL2
(`canvas.getContext('webgl')` / `'webgl2'` no nulo) — un detector genérico,
no acoplado a `SeismicGlobe.tsx` ni a la ruta `/live` específicamente. Si lo
detecta, el dialog MUST mostrar, antes de enviar, un aviso visible de que la
captura puede no incluir el contenido 3D/WebGL de la página. Si no lo
detecta, el aviso MUST NOT mostrarse. El aviso MUST NOT bloquear el envío del
reporte en ningún caso: es informativo, no un gate.

#### Scenario: El aviso aparece en una vista con globo WebGL

- GIVEN un tester en `/live` (u otra vista que monte `SeismicGlobe.tsx`, con
  su `<canvas>` WebGL activo en el DOM)
- WHEN abre el widget de feedback
- THEN el dialog muestra el aviso de que la captura puede no incluir el
  contenido 3D

#### Scenario: El aviso no aparece en una vista de espectrograma pura

- GIVEN un tester en una vista de espectrograma o análisis que solo usa
  `<canvas>` 2D (sin contexto WebGL en ningún canvas de la página)
- WHEN abre el widget de feedback
- THEN el dialog NO muestra el aviso de limitación WebGL

#### Scenario: El aviso no bloquea el envío

- GIVEN el aviso de WebGL visible en el dialog
- WHEN el tester envía el reporte sin modificar nada más
- THEN el envío procede igual que en cualquier otro caso (con o sin
  `screenshot_key` según haya terminado la subida)

### Requirement: Thumbnail condicional en la tarjeta del tablero

`FeedbackCard.tsx` MUST renderizar un thumbnail de la captura ÚNICAMENTE
cuando `report.screenshot_key` no es `null`/`undefined`. Cuando es
`null`/`undefined`, la tarjeta MUST NOT reservar espacio visual para una
imagen ni mostrar ningún placeholder de "sin captura" — el layout de una
tarjeta sin captura MUST ser idéntico al de antes de este change.

El thumbnail MUST ser clickeable/operable por teclado y, al activarse, MUST
abrir un lightbox (requirement siguiente) con la captura completa.

#### Scenario: Una tarjeta con captura muestra thumbnail

- GIVEN una tarjeta cuyo `screenshot_key` no es `null`
- WHEN se renderiza en el tablero
- THEN la tarjeta muestra un thumbnail de la imagen

#### Scenario: Una tarjeta sin captura no muestra ningún control de imagen

- GIVEN una tarjeta cuyo `screenshot_key` es `null`
- WHEN se renderiza en el tablero
- THEN la tarjeta no muestra thumbnail, placeholder ni ningún control
  relacionado a imagen
- AND su layout es indistinguible del de una tarjeta del spec base sin este
  change

### Requirement: Lightbox de la captura completa en el detalle

`FeedbackCardDetail.tsx` MUST mostrar la captura completa en un
lightbox/vista ampliada cuando `screenshot_key` está presente, activable
desde el thumbnail de la tarjeta o desde el propio detalle. Cuando
`screenshot_key` es `null`, el detalle MUST NOT renderizar ningún control de
imagen (ni botón para abrir lightbox, ni sección vacía de "captura").

#### Scenario: El lightbox muestra la imagen completa

- GIVEN una tarjeta con `screenshot_key` presente
- WHEN el usuario abre el detalle y activa el thumbnail
- THEN se abre un lightbox mostrando la captura a tamaño completo (o el
  máximo que el viewport permita, sin recortar por CSS)
- AND el lightbox es cerrable y devuelve el foco al control que lo abrió

#### Scenario: Sin captura, el detalle no ofrece lightbox

- GIVEN una tarjeta con `screenshot_key = null`
- WHEN el usuario abre su detalle
- THEN no existe ningún control de imagen ni de lightbox en esa vista
