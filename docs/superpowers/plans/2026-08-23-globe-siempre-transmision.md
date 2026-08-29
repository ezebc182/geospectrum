# /globe siempre en modo transmisión — Plan de implementación

> **Para agentes ejecutores:** SUB-SKILL REQUERIDA: usar
> `superpowers:subagent-driven-development` (recomendado) o
> `superpowers:executing-plans` para implementar tarea por tarea. Los pasos
> usan checkbox (`- [ ]`) para seguimiento.

**Goal:** Eliminar la vista "globo pelado" de `/globe` — el HUD de transmisión
pasa a ser el único estado de la página, con una X que sale de pantalla
completa en vez de apagar el HUD.

**Architecture:** El overlay ya tiene toda su estructura interna en `absolute`
relativa a su raíz; sólo la raíz es `fixed inset-0` + portal a `<body>`. Se
parametriza esa raíz con un prop `fullscreen`: en `true` mantiene el
comportamiento actual (portal + fixed), en `false` renderiza embebido en el
layout con alto de viewport calculado. La página deja de tener estado
`isBroadcast` y el `?event=` pasa a sembrar el spotlight inicial del HUD.

**Tech Stack:** Next 15 (App Router), React 19, Tailwind, SWR, vitest +
@testing-library/react, react-globe.gl.

**Spec:** No hay spec formal — el alcance sale del diagnóstico de esta sesión
y de dos decisiones del usuario (2026-08-23):
1. `?event=` abre la transmisión con ESE evento enfocado (no un modo aparte).
2. La X sale de pantalla completa, NO navega fuera de la página.

## Contexto del diagnóstico (por qué este plan existe)

El reporte inicial fue "al cerrar la transmisión el globo queda chico y
cambia de 148 a 18 eventos". Verificado:

- **148 vs 18 NO es un bug.** Está documentado como deliberado en
  `GlobeBroadcastOverlay.tsx:11-13`: la transmisión es global de 24 h
  (`/events/search`), la página respeta el área activa (`/report`). NO TOCAR.
- **El globo chico tampoco lo causa cerrar la transmisión.** Verificado por
  el usuario abriendo `/globe?event=x` (que impide que el overlay abra, ver
  `page.tsx:91-93`): el globo se ve igual de chico sin haber pasado nunca por
  la transmisión. La página del globo SIEMPRE se vio así — `height={600}` fijo
  en `page.tsx:183` con contenedor `w-full` de ~1300 px deja el globo cabiendo
  en 600 px de alto y vacío a los costados.

La vista pelada es el estado anterior al modo transmisión, quedó como fallback
y hoy no aporta nada: ni tiene el HUD ni tiene función propia.

## Global Constraints

- Node del shell es v12: usar el de nvm.
  `export PATH="$HOME/.nvm/versions/node/v22.16.0/bin:$PATH"`
- Correr vitest con el binario local desde `dashboard/`:
  `./node_modules/.bin/vitest` — `npx vitest` se baja uno ajeno de internet.
- NO correr `next build` mientras el server de dev está levantado: comparten
  `.next` y rompe la pantalla del usuario con ENOENT de vendor-chunks.
- Idioma del código: identificadores en inglés, comentarios en español.
- Todo texto visible va por `next-intl` con paridad es/en. No hardcodear.
- Conventional commits. Sin atribución de IA en ningún lado.

---

### Task 1: Parametrizar la raíz del overlay con `fullscreen`

Hoy la raíz es siempre `fixed inset-0` + `createPortal(overlay, document.body)`.
Se agrega un prop para poder renderizar embebido sin tocar el HUD interno
(que ya es todo `absolute` relativo a la raíz).

**Files:**
- Modify: `dashboard/components/GlobeBroadcastOverlay.tsx`
  (interface en `:156-158`, raíz en `:547`, return en `:1018`)
- Test: `dashboard/components/GlobeBroadcastOverlay.test.tsx`

**Interfaces:**
- Produces: `GlobeBroadcastOverlayProps` gana
  `fullscreen?: boolean` (default `true`) y
  `embeddedHeight?: number` (alto en px cuando `fullscreen` es `false`).

- [ ] **Step 1: Escribir el test que falla**

En `GlobeBroadcastOverlay.test.tsx`, dentro del `describe` existente. El
helper `renderOverlay` del archivo ya arma los providers — extenderlo para
que acepte props extra en vez de duplicarlo.

```tsx
it('en fullscreen usa fixed y portalea a body', () => {
  const { container } = renderOverlay();
  // El portal saca el overlay del container de RTL.
  expect(container.querySelector('.fixed')).toBeNull();
  expect(document.body.querySelector('.fixed.inset-0')).toBeTruthy();
});

it('embebido renderiza en el árbol, sin fixed, con el alto pedido', () => {
  const { container } = renderOverlay({ fullscreen: false, embeddedHeight: 720 });
  const root = container.querySelector('[data-testid="broadcast-root"]');
  expect(root).toBeTruthy();
  expect(root?.className).not.toContain('fixed');
  expect((root as HTMLElement).style.height).toBe('720px');
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

```bash
export PATH="$HOME/.nvm/versions/node/v22.16.0/bin:$PATH"
cd dashboard && ./node_modules/.bin/vitest run components/GlobeBroadcastOverlay.test.tsx
```

Esperado: FAIL — no existe `data-testid="broadcast-root"` y `fullscreen` no
es un prop reconocido.

- [ ] **Step 3: Implementar**

En la interface de props (`:156-158`):

```tsx
interface GlobeBroadcastOverlayProps {
  onClose: () => void;
  /** Pantalla completa (portal a <body> + fixed). En `false` se renderiza
   *  embebido en el layout de la página, con `embeddedHeight` de alto. */
  fullscreen?: boolean;
  /** Alto en px cuando `fullscreen` es `false`. Ignorado en fullscreen,
   *  que siempre usa el viewport. */
  embeddedHeight?: number;
}
```

En la firma (`:160`):

```tsx
export function GlobeBroadcastOverlay({
  onClose,
  fullscreen = true,
  embeddedHeight,
}: GlobeBroadcastOverlayProps) {
```

El alto que consume el globo pasa a depender del modo. Reemplazar el uso de
`viewportHeight` en `:550-553` por un valor derivado:

```tsx
  // En fullscreen el globo ocupa el viewport; embebido, el alto que le pasa
  // la página. Se mantiene `viewportHeight` como fuente en fullscreen porque
  // ya sigue el resize de la ventana.
  const globeHeight = fullscreen ? viewportHeight : (embeddedHeight ?? null);
```

Y en el JSX del globo:

```tsx
        {globeHeight !== null && (
          <SeismicGlobe
            eventos={eventos ?? []}
            height={globeHeight}
```

La raíz (`:547`) pasa a ser condicional:

```tsx
    <div
      data-testid="broadcast-root"
      className={
        fullscreen
          ? 'fixed inset-0 z-[100] overflow-hidden bg-background'
          : 'relative w-full overflow-hidden rounded-xl border border-border bg-background'
      }
      style={fullscreen ? undefined : { height: embeddedHeight }}
    >
```

Y el return (`:1018`):

```tsx
  // Portal SÓLO en fullscreen: el layout de (app) tiene ancestros con
  // transform (SidebarInset, indicadores) que convierten `fixed` en "fixed
  // relativo al ancestro" y el overlay quedaba debajo del navbar (visto en
  // producción el 2026-08-20). Embebido no hay `fixed` que rescatar, y
  // portalear lo sacaría del flujo donde justamente lo queremos.
  return fullscreen ? createPortal(overlay, document.body) : overlay;
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

```bash
cd dashboard && ./node_modules/.bin/vitest run components/GlobeBroadcastOverlay.test.tsx
```

Esperado: PASS, incluidos los ~20 tests que ya existían del overlay.

- [ ] **Step 5: Commit**

```bash
git add dashboard/components/GlobeBroadcastOverlay.tsx dashboard/components/GlobeBroadcastOverlay.test.tsx
git commit -m "refactor(globo): el overlay de transmision acepta modo embebido"
```

---

### Task 2: La X alterna pantalla completa en vez de cerrar

Hoy la X (`:768`) llama `onClose()`, que apaga el overlay entero. Pasa a
alternar `fullscreen`. Escape mantiene el escalonado: primero cartelera,
después salir de pantalla completa.

**Files:**
- Modify: `dashboard/components/GlobeBroadcastOverlay.tsx`
  (efecto de Escape en `:350-362`, botón en `:762-772`)
- Modify: `dashboard/messages/es.json`, `dashboard/messages/en.json`
- Test: `dashboard/components/GlobeBroadcastOverlay.test.tsx`

**Interfaces:**
- Consumes: `fullscreen` de Task 1.
- Produces: el prop `onClose` cambia de semántica — ahora significa "salir de
  pantalla completa", no "cerrar la transmisión". Sigue llamándose `onClose`
  porque el gesto del usuario es el mismo; el padre decide qué hacer.

- [ ] **Step 1: Escribir el test que falla**

```tsx
it('la X llama a onClose para salir de pantalla completa', async () => {
  const onClose = vi.fn();
  renderOverlay({ onClose });
  await userEvent.click(screen.getByRole('button', { name: /pantalla completa/i }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

it('embebido, el boton pide volver a pantalla completa', () => {
  renderOverlay({ fullscreen: false, embeddedHeight: 720 });
  expect(screen.getByRole('button', { name: /pantalla completa/i })).toBeTruthy();
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

```bash
cd dashboard && ./node_modules/.bin/vitest run components/GlobeBroadcastOverlay.test.tsx
```

Esperado: FAIL — el botón hoy tiene el `aria-label` de cerrar.

- [ ] **Step 3: Agregar las claves de i18n**

En `dashboard/messages/es.json`, dentro de `globe.broadcast`:

```json
"exitFullscreen": "Salir de pantalla completa",
"enterFullscreen": "Pantalla completa"
```

En `dashboard/messages/en.json`, mismas claves:

```json
"exitFullscreen": "Exit fullscreen",
"enterFullscreen": "Fullscreen"
```

- [ ] **Step 4: Implementar el botón y Escape**

El botón (`:762-772`) cambia de icono y etiqueta según el modo. Importar
`Minimize2` y `Maximize2` de `lucide-react` junto a los iconos que ya usa:

```tsx
          <button
            type="button"
            onClick={onClose}
            aria-label={fullscreen ? t('broadcast.exitFullscreen') : t('broadcast.enterFullscreen')}
            className="rounded-lg p-1.5 transition-colors hover:bg-muted/60"
          >
            {fullscreen ? (
              <Minimize2 className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Maximize2 className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
```

El efecto de Escape (`:350-362`) sólo actúa en fullscreen — embebido, Escape
no tiene de qué salir y robarlo molestaría a otros controles de la página:

```tsx
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Escape sale por capas: primero la cartelera, después la pantalla
      // completa. Embebido no hay pantalla completa de la que salir.
      if (billboard) {
        setBillboard(false);
      } else if (fullscreen) {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, billboard, fullscreen]);
```

- [ ] **Step 5: Correr los tests y verificar que pasan**

```bash
cd dashboard && ./node_modules/.bin/vitest run components/GlobeBroadcastOverlay.test.tsx
```

Esperado: PASS.

- [ ] **Step 6: Commit**

```bash
git add dashboard/components/GlobeBroadcastOverlay.tsx dashboard/components/GlobeBroadcastOverlay.test.tsx dashboard/messages/es.json dashboard/messages/en.json
git commit -m "feat(globo): la X alterna pantalla completa en vez de cerrar la transmision"
```

---

### Task 3: El spotlight inicial sale del `?event=`

Para que un link compartido abra la transmisión CON ese evento enfocado, el
overlay acepta un id inicial. Hoy el spotlight lo elige `pickSpotlight` según
`focusMode` (`:427-463`); el id inicial gana la primera vez y después el ciclo
sigue normal.

**Files:**
- Modify: `dashboard/components/GlobeBroadcastOverlay.tsx` (`:397-470`)
- Test: `dashboard/components/GlobeBroadcastOverlay.test.tsx`

**Interfaces:**
- Consumes: `fullscreen` de Task 1.
- Produces: `GlobeBroadcastOverlayProps` gana `initialEventId?: string | null`.
  El id se compara con `globePointId(evento)` (de `@/lib/globe-data`), la
  misma función que usa la página para armar el `?event=`.

- [ ] **Step 1: Escribir el test que falla**

El helper de test ya tiene eventos mockeados; usar el id del segundo para que
no coincida con el que elegiría `pickSpotlight` en modo `latest`.

```tsx
it('arranca con el evento del link como spotlight', async () => {
  renderOverlay({ initialEventId: globePointId(EVENTO_SECUNDARIO) });
  await waitFor(() => {
    const fila = screen.getByTestId('feed-row-focused');
    expect(fila.textContent).toContain(EVENTO_SECUNDARIO.lugar);
  });
});

it('sin initialEventId el spotlight lo elige el focusMode', async () => {
  renderOverlay();
  await waitFor(() => expect(screen.getByTestId('feed-row-focused')).toBeTruthy());
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

```bash
cd dashboard && ./node_modules/.bin/vitest run components/GlobeBroadcastOverlay.test.tsx
```

Esperado: FAIL — `initialEventId` no existe, el spotlight lo elige el modo.

- [ ] **Step 3: Implementar**

Agregar a la interface de props:

```tsx
  /** Evento que arranca como spotlight (viene del `?event=` de un link
   *  compartido). Gana UNA vez: después el ciclo sigue según `focusMode`. */
  initialEventId?: string | null;
```

Importar `globePointId` de `@/lib/globe-data`.

En el bloque del spotlight, antes del efecto que llama a `pickSpotlight`
(`:429-463`), consumir el id inicial una sola vez:

```tsx
  // El id del link gana la primera elección y se consume: si siguiera
  // ganando, el ciclo automático quedaría trabado en ese evento para
  // siempre y la transmisión dejaría de rotar.
  const initialEventConsumedRef = useRef(false);
```

Y dentro del efecto que elige spotlight, antes de `pickSpotlight`:

```tsx
    if (!initialEventConsumedRef.current && initialEventId) {
      initialEventConsumedRef.current = true;
      const delLink = pool.find((e) => globePointId(e) === initialEventId);
      if (delLink) {
        setSpotlightEvent(delLink);
        lastFocusedIdRef.current = delLink.id;
        return;
      }
      // Si el evento del link ya no está en la ventana de 24 h, se sigue
      // con la elección normal en vez de dejar la transmisión sin spotlight.
    }
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

```bash
cd dashboard && ./node_modules/.bin/vitest run components/GlobeBroadcastOverlay.test.tsx
```

Esperado: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/components/GlobeBroadcastOverlay.tsx dashboard/components/GlobeBroadcastOverlay.test.tsx
git commit -m "feat(globo): el link compartido siembra el spotlight de la transmision"
```

---

### Task 4: La página deja de tener dos modos

`page.tsx` pierde el estado `isBroadcast`, el botón "Modo transmisión", el
encabezado, el `SeismicGlobe` propio y el `GlobeEventPanel`. Queda sólo el
overlay, alternando fullscreen.

**Files:**
- Modify: `dashboard/app/(app)/globe/page.tsx`
- Modify: `dashboard/app/(app)/globe/broadcast-default.test.tsx`

**Interfaces:**
- Consumes: `fullscreen`, `embeddedHeight`, `initialEventId` de Tasks 1-3.

- [ ] **Step 1: Reescribir el test**

`broadcast-default.test.tsx` hoy verifica que el overlay abre por default y
NO abre con `?event=`. Esa segunda expectativa ya no aplica.

```tsx
it('el overlay es el unico estado de la pagina', () => {
  render(<GlobePage />);
  expect(screen.getByTestId('broadcast-overlay')).toBeTruthy();
});

it('tambien con ?event= en la URL', () => {
  mockSearchParams.set(EVENT_PARAM, 'algun-evento');
  render(<GlobePage />);
  expect(screen.getByTestId('broadcast-overlay')).toBeTruthy();
});

it('ya no hay boton de entrar a transmision', () => {
  render(<GlobePage />);
  expect(screen.queryByRole('button', { name: /transmisi/i })).toBeNull();
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

```bash
cd dashboard && ./node_modules/.bin/vitest run "app/(app)/globe/broadcast-default.test.tsx"
```

Esperado: FAIL en el segundo y tercer test — con `?event=` hoy no abre y el
botón sigue existiendo.

- [ ] **Step 3: Reescribir `GlobeView`**

El componente queda así. Se van: `isBroadcast`, `selectedEventId`, el efecto
que sincroniza la URL, `focusArea`, `useAreaRefresh`, `SeismicGlobe`,
`GlobeEventPanel`, `AreaRefreshIndicator` y el encabezado.

Se mantiene el `Suspense` de `GlobePage` (`useSearchParams` lo exige en Next
15) y el esqueleto de carga.

```tsx
function GlobeView() {
  const searchParams = useSearchParams();

  // El `?event=` de un link compartido siembra el spotlight; la transmisión
  // arranca apuntando a ese sismo en vez de al ciclo automático.
  const initialEventId = searchParams.get(EVENT_PARAM);

  // Pantalla completa por default: /globe ES la transmisión. La X la achica
  // al layout de la app sin cambiar de página.
  const [fullscreen, setFullscreen] = useState(true);

  // Embebido el HUD necesita alto en px (el globo no acepta %). Se descuenta
  // el chrome del layout (navbar + padding del <main>) del viewport.
  const [embeddedHeight, setEmbeddedHeight] = useState<number | null>(null);
  useEffect(() => {
    const update = () => setEmbeddedHeight(Math.max(420, window.innerHeight - EMBEDDED_CHROME_PX));
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  if (fullscreen) {
    return <GlobeBroadcastOverlay fullscreen onClose={() => setFullscreen(false)} initialEventId={initialEventId} />;
  }

  if (embeddedHeight === null) return <GlobeSkeleton />;

  return (
    <GlobeBroadcastOverlay
      fullscreen={false}
      embeddedHeight={embeddedHeight}
      onClose={() => setFullscreen(true)}
      initialEventId={initialEventId}
    />
  );
}
```

Arriba del componente, la constante:

```tsx
/** Navbar del layout (app) + padding vertical del <main>. Medido sobre
 *  `app/(app)/layout.tsx`: navbar ~56 px + py-8 (32 px arriba y abajo). */
const EMBEDDED_CHROME_PX = 120;
```

Los imports que quedan sin uso (`useSWR`, `reportFetcher`, `getActiveArea`,
`areaViewBounds`, `globeFocusFromBounds`, `globePointId`, `useAreaRefresh`,
`AreaRefreshIndicator`, `GlobeEventPanel`, `SeismicGlobe`, `dynamic`,
`Globe2`, `RefreshCw`, `Tv`, `useTranslations`, `SeismicEvent`, `useMemo`)
se borran. `GlobeSkeleton` se conserva y sigue usando `useTranslations`.

- [ ] **Step 4: Correr los tests y verificar que pasan**

```bash
cd dashboard && ./node_modules/.bin/vitest run "app/(app)/globe/"
```

Esperado: PASS.

- [ ] **Step 5: Verificar que no quedaron imports muertos ni tipos rotos**

```bash
cd dashboard && ./node_modules/.bin/tsc --noEmit
```

Esperado: 0 errores.

- [ ] **Step 6: Commit**

```bash
git add "dashboard/app/(app)/globe/page.tsx" "dashboard/app/(app)/globe/broadcast-default.test.tsx"
git commit -m "feat(globo): /globe es siempre modo transmision"
```

---

### Task 5: Verificación completa y QA visual

**Files:**
- Sin cambios de código salvo que aparezca una regresión.

- [ ] **Step 1: Suite completa del dashboard**

```bash
export PATH="$HOME/.nvm/versions/node/v22.16.0/bin:$PATH"
cd dashboard && ./node_modules/.bin/vitest run
```

Esperado: PASS. Ojo con los tests de Leaflet: un fallo que pasa aislado y
falla en suite es flaky por concurrencia, no regresión — confirmarlo
corriendo ese archivo solo antes de investigarlo.

- [ ] **Step 2: Verificar por mutación que los tests nuevos muerden**

Romper a propósito y confirmar que el test correspondiente falla:

1. En `GlobeBroadcastOverlay.tsx`, forzar `fullscreen = true` siempre en la
   raíz → deben fallar los tests de embebido de Task 1.
2. Quitar el bloque de `initialEventId` del efecto de spotlight → debe fallar
   el test de Task 3.

Revertir cada mutación y confirmar que vuelve a verde. **Verificar que el
reemplazo se aplicó antes de leer el verde**: una mutación que no muta no
prueba nada.

- [ ] **Step 3: Paridad de i18n**

```bash
cd dashboard && ./node_modules/.bin/vitest run lib/i18n-parity.test.ts
```

Esperado: PASS con las dos claves nuevas en es y en. Si no existe ese test,
comparar a mano que `globe.broadcast.exitFullscreen` y
`globe.broadcast.enterFullscreen` estén en los dos archivos.

- [ ] **Step 4: QA visual del usuario**

El QA visual lo hace el usuario: el MCP de navegador está caído y el canvas
de WebGL no se puede verificar desde acá. Pasarle la lista exacta:

1. `http://localhost:3008/globe` → abre en pantalla completa, HUD entero
   (regiones a la izquierda, feed a la derecha, ticker abajo).
2. Clic en la X (arriba a la derecha) → el HUD se achica al layout de la app,
   con sidebar y navbar visibles. **El globo NO queda chico y pelado.**
3. Clic en el mismo botón (ahora "Pantalla completa") → vuelve a full-bleed.
4. Escape en pantalla completa → sale a embebido. Escape embebido → no hace
   nada.
5. `http://localhost:3008/globe?event=<id de un evento del feed>` → abre en
   transmisión con ESE evento como spotlight (tarjeta sobre el globo + fila
   resaltada en el feed).
6. Cambiar de idioma → el botón de pantalla completa traduce su `aria-label`.

- [ ] **Step 5: Commit final si hubo ajustes de QA**

```bash
git add -A
git commit -m "fix(globo): ajustes del QA visual de la transmision unificada"
```

---

## Notas para el ejecutor

**Lo que NO hay que tocar:**

- La diferencia 148 vs 18 eventos entre transmisión y página. Es deliberada y
  está documentada en `GlobeBroadcastOverlay.tsx:11-13`. La transmisión es
  global de 24 h; `/report` recorta al área activa. Ya casi la "arreglo" una
  vez por no leer el docstring de al lado.
- El portal a `<body>` en fullscreen. Resuelve un bug real de producción
  (2026-08-20): ancestros con `transform` convierten `fixed` en fixed relativo
  al ancestro.

**Riesgo conocido:** `EMBEDDED_CHROME_PX = 120` es una estimación del chrome
del layout. Si en el QA visual el HUD embebido genera scroll o queda corto,
ajustar esa constante — es el único número mágico del plan y está aislado a
propósito.

**Deuda que este plan NO resuelve:** `SeismicGlobe` sigue recibiendo alto en
píxeles en vez de ser responsive por CSS, y `page.tsx` ya no lo usa pero el
componente sigue vivo para el Dashboard y la landing. El `height={600}` fijo
que causaba el globo chico desaparece de `/globe`, pero el patrón sigue en
otros consumidores.
