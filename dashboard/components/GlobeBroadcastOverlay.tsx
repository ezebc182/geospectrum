'use client';

/**
 * Modo transmisión: overlay de pantalla completa pensado para compartir en
 * un stream (referencia visual: paneles tipo "Earthquakes Live"). Globo
 * full-bleed + HUD con contadores en vivo y countdown de refresco.
 *
 * Es un overlay `fixed` montado por la página del globo — no toca el layout
 * de (app) ni crea una ruta nueva: salir es desmontar (Escape o el botón X).
 *
 * Los datos NO reusan /report: el modo transmisión es global y de 24 h
 * (ventana explícita en /events/search), mientras /report recorta a la
 * ventana corta y al área activa del usuario.
 */

import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import dynamic from 'next/dynamic';
import useSWR from 'swr';
import { X, Radio } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { seismicAPI } from '@/lib/api';
import { computeBroadcastStats } from '@/lib/broadcast-stats';
import type { SeismicEvent } from '@/lib/types';

// three.js accede a `window` al importarse: mismo motivo que en la página
// del globo, el componente solo puede cargarse client-side.
const SeismicGlobe = dynamic(
  () => import('@/components/SeismicGlobe').then((m) => m.SeismicGlobe),
  { ssr: false }
);

// Ventana y piso de magnitud de la vista (explícitos: los defaults del
// backend coinciden HOY, pero el modo transmisión no debe depender de eso).
const WINDOW_MINUTES = 24 * 60;
const MIN_MAG = 3;
// Cadencia de refresco, como el "Next update in: Ns" de la referencia.
const REFRESH_SECONDS = 90;

const broadcastFetcher = (): Promise<SeismicEvent[]> =>
  seismicAPI.searchEvents({ windowMinutes: WINDOW_MINUTES, minMag: MIN_MAG });

interface GlobeBroadcastOverlayProps {
  onClose: () => void;
}

export function GlobeBroadcastOverlay({ onClose }: GlobeBroadcastOverlayProps) {
  const t = useTranslations('globe.broadcast');
  const { data: eventos } = useSWR('broadcast-events', broadcastFetcher, {
    refreshInterval: REFRESH_SECONDS * 1000,
  });

  // El globo pide alto en píxeles (no %): se sigue el viewport a mano.
  const [viewportHeight, setViewportHeight] = useState<number | null>(null);
  useEffect(() => {
    const update = () => setViewportHeight(window.innerHeight);
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // Countdown sincronizado con el ciclo de SWR: se rearma con cada tanda de
  // datos. Es informativo (el refresco real lo maneja SWR), por eso clava en
  // cero en vez de irse a negativo si una respuesta tarda.
  const [secondsLeft, setSecondsLeft] = useState(REFRESH_SECONDS);
  const [statsNow, setStatsNow] = useState<Date | null>(null);
  useEffect(() => {
    if (eventos === undefined) return;
    setStatsNow(new Date());
    setSecondsLeft(REFRESH_SECONDS);
    const interval = setInterval(() => {
      setSecondsLeft((s) => Math.max(0, s - 1));
    }, 1000);
    return () => clearInterval(interval);
  }, [eventos]);

  const stats = useMemo(
    () => computeBroadcastStats(eventos ?? [], statsNow ?? new Date(0)),
    [eventos, statsNow]
  );

  // Portal a <body>: el layout de (app) tiene ancestros con transform
  // (SidebarInset, indicadores) que convierten `fixed` en "fixed relativo
  // al ancestro" — el overlay quedaba DEBAJO del navbar de la app en vez
  // de tapar el viewport entero. Visto en producción el 2026-08-20.
  const overlay = (
    <div className="fixed inset-0 z-[100] bg-background">
      {/* Globo full-bleed detrás del HUD */}
      <div className="absolute inset-0">
        {viewportHeight !== null && (
          <SeismicGlobe
            eventos={eventos ?? []}
            height={viewportHeight}
            showControls={false}
            enableZoom={false}
            pointScale={1.6}
            // Misma altitud full-bleed que el hero de la landing: con el
            // default (2.5) el globo flotaba chico en un mar de fondo vacío.
            initialAltitude={1.35}
          />
        )}
      </div>

      {/* HUD: barra superior */}
      <div className="absolute top-0 inset-x-0 z-10 flex items-center justify-between gap-4 bg-background/85 backdrop-blur border-b border-border px-4 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <Radio className="h-4 w-4 text-severity-critical animate-pulse shrink-0" />
          <span className="font-heading font-bold text-foreground whitespace-nowrap">
            {t('title')}
          </span>
        </div>

        <div className="flex items-center gap-6 font-data text-sm">
          <div className="text-center">
            <div className="text-[10px] uppercase text-muted-foreground font-sans">
              {t('last24h')}
            </div>
            <div className="text-lg font-bold text-foreground leading-tight">
              {eventos === undefined ? '—' : stats.last24h}
            </div>
          </div>
          <div className="text-center">
            <div className="text-[10px] uppercase text-muted-foreground font-sans">
              {t('todayM5')}
            </div>
            <div className="text-lg font-bold text-severity-high leading-tight">
              {eventos === undefined ? '—' : stats.todayM5}
            </div>
          </div>
          <div className="text-center">
            <div className="text-[10px] uppercase text-muted-foreground font-sans">
              {t('todayM6')}
            </div>
            <div className="text-lg font-bold text-severity-critical leading-tight">
              {eventos === undefined ? '—' : stats.todayM6}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground font-data whitespace-nowrap">
            {t('nextUpdate', { seconds: secondsLeft })}
          </span>
          <button
            onClick={onClose}
            aria-label={t('exit')}
            title={t('exit')}
            className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}
