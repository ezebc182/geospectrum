/**
 * Vista de globo 3D.
 *
 * Es una vista más, no un reemplazo de los mapas Leaflet: se agregó en su
 * propia ruta a propósito, para poder evaluarla sin tocar el Dashboard ni
 * /live ni /explore.
 *
 * /globe ES la transmisión: no hay un "globo pelado" al que volver, el
 * overlay de `GlobeBroadcastOverlay` es el único estado de la página,
 * alternando entre pantalla completa y embebido en el layout.
 *
 * Pendiente: marcar eventos como favoritos.
 */

'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { LoadingSurface } from '@/components/ui/loading';

import { EVENT_PARAM } from '@/lib/share-event';
import { GlobeBroadcastOverlay } from '@/components/GlobeBroadcastOverlay';

/** Navbar del layout (app) + padding vertical del <main>. Medido sobre
 *  `app/(app)/layout.tsx`: navbar ~56 px + py-8 (32 px arriba y abajo). */
const EMBEDDED_CHROME_PX = 120;

// three.js accede a `window` al importarse: con SSR el build revienta. El
// esqueleto de carga evita que el layout salte cuando aparece el canvas.
/**
 * Esqueleto de carga del globo. Es un componente con hook (no un string en el
 * módulo): el texto sale del diccionario y se re-traduce con el idioma activo.
 */
function GlobeSkeleton() {
  const t = useTranslations('globe');
  // Usa el primitivo compartido (ui/loading): antes era un texto quieto sobre
  // una caja gris, sin animación ni `role="status"` — para un lector de
  // pantalla la página simplemente no decía nada mientras cargaba.
  return <LoadingSurface label={t('loadingGlobe')} className="h-[600px]" />;
}

/**
 * useSearchParams obliga a un límite de Suspense en Next 15: sin él la página
 * entera queda fuera del prerender y el build falla. El fallback es el mismo
 * esqueleto que usa la carga del globo, así no salta el layout.
 */
export default function GlobePage() {
  return (
    <Suspense fallback={<GlobeSkeleton />}>
      <GlobeView />
    </Suspense>
  );
}

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
