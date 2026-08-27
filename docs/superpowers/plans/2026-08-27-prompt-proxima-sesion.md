# Prompt para la próxima sesión — cierre del 2026-08-27

> Copiá el bloque de PROMPT y pegalo como primer mensaje. Lo de abajo es el
> contexto que lo respalda.

---

## PROMPT (copiar desde acá)

```
Retomamos seismic-monitor. Contexto en
docs/superpowers/plans/2026-08-27-prompt-proxima-sesion.md — leelo primero.

main está en 84023e7, TODO desplegado y verde (986 backend / 1026 frontend /
tsc 0). El árbol arranca limpio salvo 4 planes viejos sin trackear en
docs/superpowers/plans/ (no son de este trabajo).

Orden de trabajo:

1. QA VISUAL (lo hago yo, vos preparás y esperás): pasame las URLs y la
   lista exacta de qué mirar para los 5 QA pendientes del change
   analiticas-profesionales-senal (1.20, 2.19, 3.16, 4.14, 5.33) MÁS lo que
   se implementó el 26/8 sin QA: hover del helicorder, mapa+nombre de
   estación, share en las notas con sello, apuntes anclados a la onda.
   Agrupalo en UNA sola recorrida por pantalla, no una lista por fase.

2. Con mi OK: tildar los 5 QA en tasks.md, sincronizar los specs
   (openspec/specs/) con los deltas del change y archivar en
   openspec/changes/archive/2026-08-26-analiticas-profesionales-senal/.
   Ese archive es lo ÚNICO que falta para cerrar el change.

3. Si sobra sesión, el backlog de features está en el documento.

No corras `next build` con el server de dev levantado (comparten .next).
Docker tiene que estar arriba para los tests de integración.
```

---

## Estado al cerrar (2026-08-27)

`main` en **84023e7**, todo pusheado y desplegado (Railway api + Vercel).
Verificación al cierre: **986 backend** (unit + integración), **1026
frontend**, `tsc --noEmit` en 0.

### Lo que entró en la sesión del 26-27/8

| Commit | Qué |
|---|---|
| `a112314` | Performance FDSN: cache eterno en DB (mig. 016) + warm-up del helicorder |
| `1e4bb71` | Nombre de ciudad/país + miniatura de mapa en el detalle |
| `a5783ef` | Fix: la selección corta ya no deja el lienzo en blanco |
| `4588662` | Hover del helicorder con highlight + preview del zoom |
| `65a829a` | Share de rango (deep link + imagen) |
| `ec2e048` | Hilo de conversación por ventana (mig. 017) |
| `8bb68e1` | Apuntes anclados a la onda (mig. 018) |
| `a9effcb` | Share movido a las notas, con referencia y sello geospectrum.org |
| `84023e7` | Fase 6: 6.1/6.2/6.3/6.5 tildadas |

**Migraciones 016, 017 y 018 se aplican solas en Railway**
(`RUN_MIGRATIONS_ON_STARTUP=true` en el api, verificado). Aplicadas en local
también. `FDSN_WARMUP_ENABLED=true` seteado en el api.

### Performance FDSN: medido en prod, no prometido

- Helicorder 24 h de CI.USC: **1,57 s** (en frío son ~60 s) ⇒ el warm-up barre.
- Ventana histórica repetida: 1,64 s → **0,35 s**.
- Tras reiniciar el proceso (local): **0,81 s con CERO fetches a FDSN** ⇒ el
  cache eterno en DB sobrevive el redeploy.
- **`railway logs` pipeado sin TTY devuelve vacío**: verificar
  FUNCIONALMENTE con curl, no perder tiempo con logs.

### Los 5 QA que bloquean el archive

Todos en `https://geospectrum-dashboard.vercel.app/es/stations/CI.USC..BHZ`
(o `AK.FIRE..BHZ`). El detalle completo de cada uno está en
`openspec/changes/analiticas-profesionales-senal/tasks.md` (1.20, 2.19,
3.16, 4.14, 5.33). Resumen de la recorrida:

1. **Helicorder**: se ve igual que antes; nombre "Los Angeles · USA" y
   miniatura de mapa en el header; hover muestra highlight del fragmento +
   preview flotante; el clic abre esa ventana en Onda.
2. **Wave**: la selección por arrastre YA NO queda en blanco (era el bug de
   passthrough); "volver atrás" y el filtro funcionan; en la pestaña de red
   del navegador cada zoom dispara un request nuevo.
3. **Espectro**: tras abrir 3 ventanas aparece el control; el eje de
   frecuencia coincide con `max_freq_hz` de la respuesta.
4. **RSAM**: la serie dibuja puntos fechados; cambiar la ventana la cambia.
5. **Picking + notas**: marcar P/S/coda, ver distancia y magnitud, CSV;
   **recargar y confirmar que persisten**; el hilo de conversación; el modo
   "Apuntar en la onda" (clic → chip con hora → enviar → bandera en la onda);
   compartir desde el panel y desde una nota (link con geospectrum.org e
   imagen sellada).

### Backlog de features (si sobra sesión)

- **El AreaSelector desaparece en silencio con el api caído** (`return null`).
  Un estado "sin conexión" sería honesto. Anotado y nunca pedido.
- Serie muro SPECTRONET **W3/W4** (sin arrancar).
- **user-management**: falta frontend y rollout (backend en `929f7b4`).
- Contadores en 0 del globo (`globo-contadores-en-cero-pista-statsnow`), SIN
  RESOLVER.
- Fallas como áreas seleccionables; capa de placas en /live.

### Advertencia de costo

La sesión del 26-27/8 cerró en **~$91** con 9 commits en prod. Fue
productiva, pero conviene dimensionar: arrancar una sesión fresca para el QA
y el archive sale mucho más barato que seguir estirando un contexto largo.
