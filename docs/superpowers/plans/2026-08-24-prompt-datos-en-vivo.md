# Prompt próxima sesión — la app no muestra datos en vivo

Copie el bloque marcado **PROMPT** y péguelo como primer mensaje. Lo que sigue
después es el contexto que lo respalda.

**Son DOS problemas distintos con el mismo síntoma** ("la app no muestra el
ahora"), y conviene atacarlos en ese orden: el globo vacío es más urgente
(pantalla principal, dato disponible) y probablemente más barato.

---

## PROMPT

```
La app no está mostrando datos en vivo. Hay DOS problemas distintos, ambos
verificados por mí, y quiero que los trates por separado.

═══ PROBLEMA 1: el globo en transmisión muestra 0 eventos ═══

/globe abre en modo transmisión y los tres contadores dicen 0 (ÚLTIMAS 24 H,
HOY ≥M5.0, HOY ≥M6.0). "Regiones más activas" sale sin filas y "Actividad por
hora" es una línea plana. El HUD está entero — no falta nada de la UI, está
vacío de datos.

Lo que YA verifiqué:

- `curl "localhost:8000/events/search?window_minutes=1440&min_mag=3"` SÍ
  devuelve eventos reales (ej. us6000tn0t, M5.3, "127 km W of Lata, Solomon
  Islands", 2026-08-23T21:32:21 UTC). O sea: EL DATO EXISTE.
- `curl "localhost:8000/events/recent"` devuelve `{"eventos":[],"total":0}`
- El overlay usa `/events/search` como fuente principal
  (`GlobeBroadcastOverlay.tsx:82-83`, vía `seismicAPI.searchEvents`) y
  `/events/recent` como fallback.
- Dato CLAVE: `GlobeBroadcastOverlay.tsx:792` muestra `—` cuando `eventos ===
  undefined` y el número cuando hay array. La pantalla muestra `0`, no `—`.
  Eso significa que el fetch RESOLVIÓ y devolvió una lista VACÍA — no es que
  falló ni que está cargando.

O sea: el endpoint tiene datos, el navegador recibe vacío. Algo pasa en el
medio. Hipótesis a descartar (no las di por buenas, verificalas):
- el área activa filtrando (hay un selector de área global; en mis pruebas
  estaba en "Centroamérica")
- los query params: `lib/api.ts:searchEvents` convierte camelCase a snake_case
  (`windowMinutes` → `window_minutes`) — verificá que la URL final sea la
  misma que yo probé por curl
- la sesión / auth: mi curl fue sin token

Arrancá abriendo /globe en el navegador y mirando la pestaña Network: qué URL
exacta pide, con qué params, y qué devuelve. Comparalo con mi curl.

═══ PROBLEMA 2: los espectrogramas tienen 21 h de desfasaje ═══

La UI dice "Actualizado: 1:28:53 a.m. UTC" cuando son las 22:29 UTC.

Ya descarté la hipótesis obvia: NO es un bug de zona horaria. Verifiqué
`dashboard/i18n/request.ts` y el formateo está bien (`time: { timeStyle:
'medium', timeZone: 'UTC' }` más un `timeZone: 'UTC'` global). Esa hora ES UTC
real. El dato tiene 21 horas de verdad.

Como monitoreo en vivo, así es inutilizable: a nadie le sirve un espectrograma
de hace medio día.

Datos duros que ya recolecté (2026-08-23 ~19:30 -03 / 22:30 UTC):

- `GET localhost:8000/spectrograms/live-channels` devuelve `[]` — CERO canales
- El backend responde 200 en /health (está vivo)
- `ps aux` NO muestra ningún proceso del ingestor de SeedLink. Corre como
  proceso SEPARADO del API (ver el `__main__` de
  `src/services/seedlink_ingestor.py`)
- Redis responde PONG pero `--scan --pattern "spectro*"` no devuelve NI UNA
  clave
- Hay DOS uvicorn corriendo a la vez (PIDs 94525 y 72153, arrancados en días
  distintos) — puede ser ruido o puede ser parte del problema

Usá superpowers:systematic-debugging. Quiero causa raíz, no un "levantalo de
nuevo".

Lo que necesito que averigües, en este orden:

1. ¿POR QUÉ se murió el ingestor? No alcanza con reiniciarlo: si murió una vez
   en silencio, va a volver a pasar. Buscá logs, revisá el manejo de
   excepciones del loop de reconexión (`seedlink_ingestor.py`, alrededor de las
   líneas 302-365 hay varios `except`), y fijate si hay algún camino donde el
   proceso termine sin dejar rastro.

   ANTECEDENTE IMPORTANTE: este proyecto YA tuvo exactamente este bug con el
   ingestor de eventos — salía con exit 0 y Railway lo daba por bueno. Está
   documentado en `docs/superpowers/plans/2026-08-21-spectronet-wall-pr-w4.md`
   ("El worker muere VISIBLE si queda mudo"). Verificá si el arreglo que se
   hizo allá (raise RuntimeError al salir del loop + except BaseException)
   está realmente aplicado en el ingestor de SeedLink, o si sólo se hizo en
   el otro worker.

2. ¿Esto pasa sólo en LOCAL o también en producción? El stack de prod está en
   Railway. Si en prod también está muerto, es urgente. Para consultar prod
   usá `railway ssh` (NO `railway connect`; la base no expone
   DATABASE_PUBLIC_URL).

3. ¿Hay watchdog? Existe `src/services/channel_watchdog.py` — averiguá qué
   vigila exactamente y por qué no detectó esto (o si lo detectó y no avisó
   a nadie).

4. Los dos uvicorn duplicados: ¿son un problema o ruido? Este proyecto ya tuvo
   procesos zombis que hicieron perder tiempo debuggeando cosas que no eran.

Cuando tengas la causa raíz de CADA problema, PARÁ y contame antes de
arreglar. Quiero decidir el alcance con el diagnóstico en la mano.

Empezá por el PROBLEMA 1 (globo vacío): es la pantalla principal, el dato ya
existe en el backend, y probablemente sea el más barato de los dos.

═══ PROBLEMA 3 (de producto, va aparte de los otros dos) ═══

Aunque el ingestor funcione perfecto, la UI NO DEBERÍA MENTIR. Hoy un
espectrograma de hace 21 horas se ve igual que uno de hace 30 segundos: mismo
canvas, misma etiqueta, sin ninguna señal de que el dato está viejo. Eso es
peor que no mostrar nada, porque el usuario asume que está viendo el ahora.

Quiero que la UI degrade con honestidad: si el dato pasa cierta antigüedad, que
se note (estado visual, no sólo el texto de "Actualizado"). Proponeme el umbral
y el tratamiento visual antes de implementar — el dominio es sísmico y no sé si
el corte razonable son 5 minutos o 30.

Contexto del proyecto que te ahorra vueltas:
- El venv está en `venv/`, no `.venv/`. Usá `./venv/bin/python -m pytest`.
- El TimescaleDB escucha en 5433, no 5432 (en 5432 hay un Postgres nativo de
  macOS que NO es el del proyecto).
- Node del shell es v12: `export PATH="$HOME/.nvm/versions/node/v22.16.0/bin:$PATH"`
- Vitest con `./node_modules/.bin/vitest` desde `dashboard/`, nunca `npx`.
- NO corras `next build`: el server de dev comparte `.next` y le rompe la
  pantalla al usuario.
- Comentarios en español, identificadores en inglés. Conventional commits, sin
  atribución de IA.
```

---

## Contexto que respalda el prompt

### El globo vacío NO lo causó el trabajo del globo

Importante para no perseguir un fantasma: el usuario reportó "qué pasó con el
globe, me sacaste todo lo que tenía" al ver la pantalla en cero. **La UI está
completa** — cabecera, contadores, "Regiones más activas", "Actividad por hora",
feed lateral. Lo que está es vacío de DATOS.

La prueba de que el fetch resolvió (y no falló ni quedó cargando) está en
`GlobeBroadcastOverlay.tsx:792`:

```tsx
{eventos === undefined ? '—' : stats.last24h}
```

La pantalla muestra `0`, no `—`. Si el fetch hubiera fallado o estuviera en
vuelo, vería el guión.

Los 5 commits del plan del globo (8bbfba5..77b2cb9) sólo tocaron el
posicionamiento del overlay, el botón de pantalla completa y el spotlight
inicial. Ninguno tocó la cadena de datos. Y el `?event=` que siembra el
spotlight NO filtra la lista — sólo elige cuál enfocar.

### Cómo apareció el desfasaje de los espectrogramas

El usuario reportó "Actualizado: 1:28:53 a.m. UTC" siendo las 22:29 UTC. Su
lectura inicial —y la mía— fue que el sufijo "UTC" estaba pegado a mano sobre
una hora local (`LiveSpectrogramCanvas.tsx:209` hace
`{format.dateTime(new Date(lastUpdate), 'time')} {tCommon('utcSuffix')}`).

**Esa hipótesis está DESCARTADA.** `i18n/request.ts` configura
`timeZone: 'UTC'` tanto en el formato nombrado `time` como en el global del
`getRequestConfig`. La memoria del proyecto además registra que ese fue un bug
real que ya se arregló ([[harness-de-test-que-regala-config]]).

El desfasaje de 3 h entre UTC y la hora local de Argentina (UTC-3) hizo que la
hipótesis de zona horaria pareciera plausible, pero los números no cerraban:
1:28 no es ni 22:29 (UTC) ni 19:29 (local). El dato simplemente es viejo.

### Lo que ya estaba anotado

El inventario de features de la sesión del 2026-08-23 ya había detectado que el
ingestor de espectros estaba muerto desde el **2026-08-21 04:31 UTC** — apareció
como efecto colateral (el badge "Con datos recientes" no salía en ninguna
estación del buscador). Quedó anotado y no se investigó en su momento.

O sea: esto lleva al menos dos días roto.

### Por qué el punto 2 (la UI honesta) va aparte

Son dos problemas independientes y conviene no mezclarlos:

- **El ingestor caído** es un bug de infraestructura. Se arregla y vuelve el
  dato fresco.
- **La UI que no distingue fresco de viejo** es un problema de diseño que
  seguiría existiendo aunque el ingestor ande perfecto. El día que se caiga de
  nuevo —y se va a caer— la app volvería a mentir en silencio.

El segundo es más barato y es el que resuelve la queja de fondo del usuario
("la gente no le interesa cosas de hace 12 hs").

### Estado del repo al momento de escribir esto

Rama `feat/station-detail-pr-b-spectrogram`, 6 commits por delante de `main`:

```
6ca047f  fix(globo): el portal revienta en el prerender del servidor
77b2cb9  feat(globo): /globe es siempre modo transmision
99ec7dd  feat(globo): el link compartido siembra el spotlight
ee571ff  test(globo): endurece los selectores a match exacto
ec04d4b  feat(globo): la X alterna pantalla completa
8bbfba5  refactor(globo): el overlay acepta modo embebido
da83ebc  feat(estaciones): buscador de estaciones por codigo FDSN
```

Verificación al cierre: dashboard 658/658 (66 archivos), backend 552/552, tsc
en 0, i18n con 672 claves parejas es/en.

**Pendiente del usuario:** el QA visual de `/globe` (6 puntos listados en
`docs/superpowers/plans/2026-08-23-globe-siempre-transmision.md`, paso 4 de la
Task 5). El punto clave es cerrar con la X y confirmar que el globo NO queda
chico y pelado.

### Otros pendientes que NO son este bug

No los mezcle con la investigación del ingestor:

1. **Bug del muro** (chico, diagnosticado, decidido): `NZ.KHZ.10.HHZ` aparece
   dos veces en el catálogo A PROPÓSITO (respaldo de wellington, primaria de
   christchurch). `WallBuilder.tsx:84` usa `key={ch.channel}` asumiendo
   unicidad → warning de React. **NO dedupear en el backend** (rompe el
   failover). Fix: dedupear en `WallManager.tsx:65-79` quedándose con la
   entrada `is_primary` (gana Christchurch, decidido por el usuario) y blindar
   la key además del dato.

2. **`GlobeEventPanel` quedó huérfano**: cero consumidores tras eliminar la
   vista pelada del globo. Código muerto verificado.

3. **Subgrupos del muro** (proyecto propio, `/sdd-new`): el usuario quiere
   componer columnas como el SPECTRONET original. El modelo ya tiene
   `columns → groups → channels`; lo que falta es más expresividad (títulos de
   columna, agrupaciones visuales, columnas de branding). Ver
   [[muro-subgrupos-lienzo-componible]].

4. **Análisis de señal** (proyecto grande): la escalera de perfiles y el
   bloqueante de `/waveform` sin ventana absoluta. Ver
   [[analisis-de-senal-escalera-de-perfiles]].
