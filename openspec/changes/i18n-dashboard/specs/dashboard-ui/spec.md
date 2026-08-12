# Delta for Dashboard UI — Internacionalización ES/EN de toda la app Next

## Contexto

Este delta EXTIENDE `openspec/specs/dashboard-ui/spec.md` (spec principal del dashboard) y el delta `openspec/changes/email-invitations/specs/dashboard-ui/spec.md` (invitaciones, `/invite`, onboarding). Internacionaliza a ES/EN **toda** la superficie user-facing de la app Next: el dashboard autenticado (`app/(app)`), `/login`, la landing pública y la página `/invite` — estas dos últimas MIGRAN de su patrón i18n casero (`lib/landing-i18n.ts`, `lib/invite-i18n.ts`) a la infraestructura común (decisión del usuario, 2026-08-12).

Decisiones cerradas que este delta asume (no reabrir): motor next-intl en modo *without i18n routing* (locale por cookie, provider en el root layout, SIN reestructurar a `app/[locale]/` — `middleware.ts`, rutas y callbacks de OAuth no se tocan); persistencia doble cookie + `users.locale`; strings de error del backend API fuera de alcance (el cliente arma sus propios mensajes, y esos SÍ se traducen acá).

Convenciones de este delta: "locale soportado" significa `es` o `en`; "cookie de locale" es la cookie única que toda la app (landing, `/invite`, `/login` y dashboard) lee y escribe; "superficie user-facing" incluye texto visible, `aria-label`, `placeholder`, `title`/tooltips, popups de mapas, tooltips de charts y mensajes de error generados por el cliente. Los NOMBRES DE DATOS no se traducen: ciudades (`lib/major-cities.ts`, `lib/seismic-cities.ts`), placas tectónicas, nombres de áreas del backend (`src/config/regions.py`) y el `place` de USGS/EMSC.

## ADDED Requirements

### Requirement: Resolución del locale por cascada

El sistema MUST resolver el locale efectivo de cada request con esta cascada, en orden estricto: (1) cookie de locale con valor soportado; (2) `users.locale` si hay sesión activa y el usuario tiene preferencia guardada; (3) idioma del navegador (`Accept-Language` server-side / `navigator.language` client-side) si mapea a un locale soportado; (4) default `es` (mismo default que backend y emails). Un valor NO soportado en cualquier eslabón (ej. cookie `fr`) MUST tratarse como ausente y continuar la cascada, nunca romper el render.

#### Scenario: La cookie explícita gana sobre la preferencia de cuenta

- GIVEN un usuario con sesión activa cuyo `users.locale` es `es` y una cookie de locale con valor `en`
- WHEN carga cualquier página del dashboard
- THEN toda la UI se renderiza en inglés (la cookie, elección explícita más reciente en este navegador, gana)

#### Scenario: Sin cookie, la preferencia de cuenta decide

- GIVEN un usuario con sesión activa, `users.locale = 'en'` y ningún navegador con cookie de locale (dispositivo nuevo)
- WHEN inicia sesión y carga el dashboard
- THEN toda la UI se renderiza en inglés sin que el usuario tenga que volver a elegir idioma

#### Scenario: Visitante nuevo con navegador en inglés

- GIVEN un visitante sin cookie de locale y sin sesión, cuyo navegador declara `Accept-Language: en-US,en;q=0.9`
- WHEN abre la landing pública o `/login`
- THEN la página se muestra en inglés

#### Scenario: Idioma no soportado cae al default

- GIVEN un visitante sin cookie ni sesión cuyo navegador declara `Accept-Language: fr-FR,fr;q=0.9`
- WHEN abre cualquier página
- THEN la página se muestra en español (default `es`)

#### Scenario: Cookie con valor inválido no rompe la cascada

- GIVEN una cookie de locale con valor `xx` (no soportado) y un usuario con sesión y `users.locale = 'en'`
- WHEN carga el dashboard
- THEN la cookie inválida se ignora, la cascada continúa y la UI se renderiza en inglés
- AND no se produce ningún error de render ni página en blanco

### Requirement: Cambio de idioma en caliente, sin recargar ni perder sesión

Al cambiar de idioma desde cualquier selector de la app, la UI MUST re-renderizarse en el idioma nuevo sin una recarga completa del navegador, sin perder la sesión y sin cambiar de ruta. El cambio MUST escribir la cookie de locale. El estado de cliente no persistido (filtros aplicados, posición del mapa) SHOULD preservarse.

#### Scenario: Alternar ES→EN en una página interna

- GIVEN un usuario autenticado en `/explore` con filtros de eventos aplicados y la UI en español
- WHEN usa el selector de idioma y elige inglés
- THEN sidebar, encabezados, filtros, tablas y KPIs pasan a inglés sin navegación a otra ruta ni recarga completa
- AND la cookie de sesión sigue intacta (no hay redirect a `/login`)
- AND la cookie de locale queda en `en`, y una navegación posterior a cualquier otra página renderiza en inglés

#### Scenario: El cambio alcanza strings generados fuera de JSX

- GIVEN la UI en español con el mapa mostrando popups de eventos y un chart con tooltips
- WHEN el usuario cambia a inglés
- THEN los popups de Leaflet, los tooltips de Recharts y todo texto generado fuera de JSX que se abra a partir de ese momento aparecen en inglés (las traducciones llegan por parámetro desde componentes con acceso al diccionario)

### Requirement: Selector de idioma en el header y en Settings, con persistencia en cuenta

La app MUST ofrecer el selector de idioma en dos lugares: acceso rápido en el header (visible en toda la app autenticada) y en la página de Settings. Para un usuario autenticado, cambiar el idioma desde CUALQUIERA de los dos MUST además persistir la preferencia en su cuenta vía el `PATCH /account/profile` existente (ver delta de `account-settings`), de modo que la elección sobreviva a otro dispositivo/navegador. Para un visitante sin sesión (landing, `/login`, `/invite`), el cambio MUST persistir solo en la cookie y MUST NOT llamar a ninguna API de cuenta.

#### Scenario: Cambio desde el header persiste en la cuenta

- GIVEN un usuario autenticado con `users.locale = 'es'`
- WHEN cambia a inglés desde el acceso rápido del header
- THEN la UI pasa a inglés en caliente y se llama a `PATCH /account/profile` con la preferencia `en`
- AND en un dispositivo nuevo (sin cookie), su siguiente login renderiza el dashboard en inglés

#### Scenario: Settings muestra y edita la preferencia

- GIVEN un usuario autenticado en la página de Settings
- WHEN abre la sección de perfil
- THEN ve un selector de idioma reflejando su preferencia actual
- AND al cambiarlo, la UI cambia de idioma en caliente y la preferencia se guarda en la cuenta

#### Scenario: Visitante anónimo cambia idioma sin tocar la API

- GIVEN un visitante sin sesión en la landing pública
- WHEN alterna el idioma con el toggle
- THEN la landing re-renderiza en el idioma elegido y la cookie de locale se escribe
- AND no se realiza ninguna llamada a `PATCH /account/profile` ni a ningún endpoint autenticado

#### Scenario: La falla del PATCH no bloquea el cambio visual

- GIVEN un usuario autenticado con el backend momentáneamente inaccesible
- WHEN cambia el idioma desde el header
- THEN la UI cambia de idioma igual (la cookie manda para este navegador)
- AND la falla de persistencia en cuenta no produce un estado bloqueante (a lo sumo, otro dispositivo no verá la preferencia hasta un cambio exitoso)

### Requirement: Cobertura total — ningún string user-facing hardcodeado en español

Todo string user-facing de `app/(app)`, `app/login`, `app/invite`, la landing y `components/` + labels de UI en `lib/` (períodos de tiempo, grupos de áreas, textos de compartir, etc.) MUST provenir de los diccionarios de mensajes ES/EN — cero español hardcodeado en código. Los comentarios de código (convención del repo: español) y los datos exentos (ciudades, placas, nombres de áreas, `place` de fuentes) MUST NOT contar como violación. El criterio MUST ser auditable: una búsqueda con `rg` de caracteres españoles (`[áéíóúñÁÉÍÓÚÑ¿¡]`) sobre los archivos `.ts`/`.tsx` de `dashboard/app` y `dashboard/components` y los archivos de labels de `dashboard/lib`, excluyendo comentarios, los archivos de datos exentos y los propios diccionarios, MUST devolver cero strings user-facing.

#### Scenario: Auditoría con rg queda limpia

- GIVEN la migración completa
- WHEN se ejecuta la búsqueda de caracteres españoles descrita (excluyendo comentarios, datos exentos y diccionarios)
- THEN ningún resultado corresponde a un string user-facing (solo comentarios y datos)
- AND la misma auditoría con palabras españolas sin tilde frecuentes ("Cargando", "Buscar", "Eventos", "Compartir") sobre literales JSX tampoco encuentra strings fuera de los diccionarios

#### Scenario: Un usuario EN no ve español residual en flujos secundarios

- GIVEN la UI en inglés
- WHEN el usuario recorre estados vacíos, mensajes de error del cliente, toasts/notificaciones, diálogos de confirmación y textos de accesibilidad (`aria-label`, `placeholder`)
- THEN todos aparecen en inglés
- AND los nombres de áreas, ciudades y lugares de eventos se muestran tal como vienen del dato (sin traducir), en ambos idiomas por igual

### Requirement: Paridad de claves ES/EN verificada por test

Los diccionarios de mensajes ES y EN MUST tener exactamente el mismo conjunto de claves, y un test automatizado (Vitest) MUST fallar ante cualquier divergencia (clave presente en uno y ausente en el otro), en ambas direcciones.

#### Scenario: Divergencia de claves rompe la suite

- GIVEN los diccionarios ES/EN en paridad
- WHEN se elimina una clave solo del diccionario EN (o se agrega una clave solo al ES)
- THEN el test de paridad falla identificando la clave divergente
- AND al restaurar la paridad, el test vuelve a verde

### Requirement: Fechas y números formateados según el locale activo

Toda fecha, hora, número y tiempo relativo mostrado en la UI (tablas de eventos, KPIs, charts, paneles admin, notificaciones) MUST formatearse según el locale activo — `es` mapea a formato `es-AR` y `en` a `en-US` (mismo criterio que `app/invite/[token]/page.tsx` hoy). MUST NOT quedar ningún `toLocaleString`/`Intl.*` con locale hardcodeado (`'es-AR'`, `'es-ES'`) en superficie user-facing; el formateo MUST salir de un mecanismo centralizado parametrizado por el locale activo.

#### Scenario: La tabla de eventos re-formatea fechas al cambiar de idioma

- GIVEN la tabla de eventos con la UI en español mostrando fechas en formato `es-AR`
- WHEN el usuario cambia a inglés
- THEN las mismas fechas se muestran en formato `en-US` (ej. "Aug 12, 2026" en lugar de "12 ago 2026")
- AND los ejes y tooltips de los charts de magnitud/tiempo siguen el mismo criterio

#### Scenario: No queda locale de formateo hardcodeado

- GIVEN la migración completa
- WHEN se busca con `rg` `toLocaleString\('es-|toLocaleDateString\('es-|DateTimeFormat\('es-` en `dashboard/app`, `dashboard/components` y `dashboard/lib`
- THEN no hay ocurrencias en código de superficie user-facing (el mapeo locale→formato vive solo en el mecanismo centralizado)

### Requirement: Onboarding wizard y tour en el locale activo

El wizard de onboarding y los pasos del tour guiado (títulos, contenidos, botones "siguiente/saltar") MUST mostrarse en el locale activo, preservando intactos el comportamiento y las anclas `data-tour-id` especificados en el delta de `email-invitations`.

#### Scenario: Invitado EN ve el tour en inglés en su primer login

- GIVEN un usuario recién creado por invitación con locale efectivo `en` y `onboarding_completed_at: null`
- WHEN aterriza en el dashboard y el wizard se dispara
- THEN todos los pasos del tour (mapa, globo 3D, áreas de interés, alertas) se muestran en inglés
- AND completar o saltar persiste vía `POST /auth/me/onboarding-complete` exactamente igual que antes de este change

### Requirement: Migración de la landing pública a la infraestructura común con paridad

La landing pública MUST migrar de `lib/landing-i18n.ts` a los diccionarios comunes, con **paridad de contenido**: para cada locale, los textos visibles post-migración MUST ser idénticos a los actuales de `LANDING_COPY` (misma copy, cero regresión visual/textual). El toggle de idioma de la landing MUST escribir la cookie de locale común (reemplaza `localStorage['landing-locale']`), de modo que la elección se propague a `/login` y al dashboard. El comportamiento de detección se preserva: primera visita según idioma del navegador, elección explícita gana. Al final de la migración `lib/landing-i18n.ts` MUST eliminarse. El formulario de alta a la beta MUST enviar el locale activo de la landing en el payload de `POST /beta-signups` (ver delta de `auth`).

#### Scenario: Paridad de contenido post-migración

- GIVEN la landing migrada
- WHEN se compara, para ES y para EN, cada texto visible contra el valor correspondiente del `LANDING_COPY` previo
- THEN los textos son idénticos (la migración mueve strings, no los reescribe)
- AND `lib/landing-i18n.ts` ya no existe en el repo y nada lo importa

#### Scenario: La elección en la landing se propaga al login

- GIVEN un visitante que en la landing alternó a inglés
- WHEN navega a `/login`
- THEN `/login` se muestra en inglés sin volver a elegir idioma (cookie común)

#### Scenario: El signup de beta lleva el idioma elegido

- GIVEN la landing en inglés
- WHEN el visitante completa el formulario de beta y lo envía
- THEN el `POST /beta-signups` incluye el locale `en`

### Requirement: Migración de /invite a la infraestructura común, sembrando el idioma del invitado

La página `/invite/[token]` MUST migrar de `lib/invite-i18n.ts` a los diccionarios comunes con paridad de contenido, preservando su comportamiento actual: la página se muestra en el idioma de la invitación (`invitations.locale`). Además, la visita a una invitación válida MUST sembrar la cookie de locale con el locale de la invitación (si el visitante no eligió otro explícitamente en este navegador), de modo que un invitado EN que acepta su invitación aterrice en un dashboard en inglés en su primer login. Al final de la migración `lib/invite-i18n.ts` MUST eliminarse.

#### Scenario: Invitado EN aterriza en un dashboard en inglés

- GIVEN una invitación con `locale = 'en'` y un navegador sin cookie de locale previa
- WHEN el invitado abre `/invite/T`, ve la página en inglés y completa el alta (password o Google)
- THEN su primer render del dashboard es en inglés, sin acción manual de idioma
- AND las fechas de expiración en `/invite` se formatean `en-US` como hoy

#### Scenario: La elección explícita previa del visitante gana sobre la invitación

- GIVEN un navegador donde el visitante ya eligió explícitamente español (cookie `es`) y una invitación con `locale = 'en'`
- WHEN abre `/invite/T`
- THEN la cookie explícita no es pisada por la siembra: la cascada del Requirement "Resolución del locale por cascada" se respeta

#### Scenario: Paridad de contenido y eliminación del patrón viejo

- GIVEN la página `/invite` migrada
- WHEN se comparan sus textos ES y EN contra los del `invite-i18n.ts` previo, incluido el estado de token inválido
- THEN los textos son idénticos por locale
- AND `lib/invite-i18n.ts` ya no existe en el repo y nada lo importa

## MODIFIED Requirements

### Requirement: Login sin alta abierta y con error claro de invitación

(Modifica el Requirement homónimo de `openspec/changes/email-invitations/specs/dashboard-ui/spec.md`. Previamente: el mensaje de rechazo por falta de invitación debía mostrarse "claro y en español".)

La página `/login` MUST NOT ofrecer ninguna afordancia de creación de cuenta abierta (sin cambios). Cuando el backend rechaza un login de Google por falta de invitación (redirect a `/login` con el parámetro de error correspondiente), la página MUST mostrar un mensaje claro **en el locale activo** (resuelto por la cascada de este delta) indicando que el acceso es solo por invitación. Todos los demás textos y mensajes de error de `/login` MUST igualmente mostrarse en el locale activo.

#### Scenario: Rechazo de invitación mostrado en inglés

- GIVEN un visitante con locale efectivo `en` (cookie o navegador) que intentó "Continuar con Google" sin invitación
- WHEN el backend lo redirige a `/login` con el parámetro de error de invitación faltante
- THEN el mensaje "solo por invitación" se muestra en inglés
- AND con locale efectivo `es`, el mismo flujo muestra el mensaje en español
- AND el botón de Google y el formulario de login siguen disponibles en ambos casos
