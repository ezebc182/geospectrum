/**
 * Panel de detalle del evento seleccionado en el globo.
 *
 * Vive aparte del globo a propósito: el canvas de WebGL se re-renderiza caro y
 * no conviene que el detalle del evento lo arrastre en cada apertura.
 *
 * Los formatos y los colores de severidad se toman de los mismos helpers que
 * usa EventsTable: un M5.5 tiene que verse igual acá que en la tabla, o el
 * usuario cree que son datos distintos.
 */

'use client';

import { useMemo, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { Check, Share2 } from 'lucide-react';

import {
  eventUrl,
  shareEvent,
  type ShareMessages,
  type ShareOutcome,
} from '@/lib/share-event';
import { globePointId } from '@/lib/globe-data';
import { MagnitudeScale } from '@/components/MagnitudeScale';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import {
  cn,
  formatDepth,
  formatMagnitude,
  getMagnitudeSeverity,
} from '@/lib/utils';
import type { SeismicEvent } from '@/lib/types';

const magnitudeBadgeVariant: Record<
  ReturnType<typeof getMagnitudeSeverity>,
  'secondary' | 'outline' | 'destructive'
> = {
  low: 'secondary',
  light: 'outline',
  moderate: 'outline',
  high: 'outline',
  critical: 'destructive',
};

// El Record explícito es a propósito: sin él, agregar un tramo a
// getMagnitudeSeverity no rompe la compilación acá y el badge sale sin color
// en runtime. Con el tipo, TypeScript exige la clave nueva.
const magnitudeBadgeClass: Record<ReturnType<typeof getMagnitudeSeverity>, string> = {
  low: 'bg-severity-low/15 text-severity-low',
  light: 'bg-severity-light/15 text-severity-light',
  moderate: 'bg-severity-moderate/15 text-severity-moderate',
  high: 'bg-severity-high/15 text-severity-high',
  critical: 'bg-severity-critical/15 text-severity-critical',
};

interface GlobeEventPanelProps {
  /** Evento a mostrar. Con null el panel queda cerrado. */
  evento: SeismicEvent | null;
  onClose: () => void;
}

/** Fila etiqueta/valor del detalle. */
function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border/60 py-2 last:border-0">
      <dt className="shrink-0 text-sm text-muted-foreground">{label}</dt>
      <dd className="text-right text-sm font-medium">{children}</dd>
    </div>
  );
}

export function GlobeEventPanel({ evento, onClose }: GlobeEventPanelProps) {
  const t = useTranslations('globe.panel');
  const tShare = useTranslations('share');
  const tCommon = useTranslations('common');
  const format = useFormatter();
  const [outcome, setOutcome] = useState<ShareOutcome | null>(null);

  // Mensajes del texto compartido, en el idioma activo (Decision 5: la lib es
  // pura y los recibe por parámetro). Los parametrizados delegan en ICU.
  const shareMessages = useMemo<ShareMessages>(
    () => ({
      title: tShare('title'),
      headline: (magnitude, place) => tShare('headline', { magnitude, place }),
      depth: (depth) => tShare('depth', { depth }),
      unknownLocation: tShare('unknownLocation'),
      unknownDate: tShare('unknownDate'),
      unreviewedNotice: tShare('unreviewedNotice'),
    }),
    [tShare],
  );

  // Texto del botón según cómo haya salido el último intento. Se guarda el
  // OUTCOME (no el texto resuelto): si el idioma cambia con el estado puesto,
  // el label se re-traduce solo.
  const shareLabel =
    outcome === 'copied' ? t('copied') : outcome === 'failed' ? t('shareFailed') : t('share');

  const handleShare = async () => {
    if (!evento) return;
    // La URL lleva ?event=<id> para que quien la abra caiga en este mismo
    // sismo. Sin el parámetro el link abre el globo girando y el mensaje
    // pierde la mitad de su sentido.
    setOutcome(await shareEvent(evento, shareMessages, eventUrl(globePointId(evento))));
  };

  // Radix cierra el Sheet con onOpenChange(false); el estado real del evento
  // seleccionado vive en el padre, así que se le delega el cierre.
  const handleOpenChange = (open: boolean) => {
    if (!open) onClose();
  };

  if (!evento) return null;

  const severity = getMagnitudeSeverity(evento.mag);

  return (
    <Sheet open onOpenChange={handleOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-3">
            <Badge
              variant={magnitudeBadgeVariant[severity]}
              className={cn('font-data text-base font-bold', magnitudeBadgeClass[severity])}
            >
              M{formatMagnitude(evento.mag)}
            </Badge>
            <span className="text-base">{evento.lugar ?? t('unknownLocation')}</span>
          </SheetTitle>
          <SheetDescription>
            {format.dateTime(new Date(evento.hora_utc), 'medium')} {tCommon('utcSuffix')}
          </SheetDescription>
        </SheetHeader>

        <dl className="px-4">
          <DetailRow label={t('depth')}>{formatDepth(evento.prof_km)}</DetailRow>

          <DetailRow label={t('coordinates')}>
            <span className="font-data">
              {evento.lat.toFixed(3)}, {evento.lon.toFixed(3)}
            </span>
          </DetailRow>

          {evento.mag_tipo && (
            <DetailRow label={t('magnitudeType')}>
              <span className="font-data uppercase">{evento.mag_tipo}</span>
            </DetailRow>
          )}

          <DetailRow label={t('sources')}>
            <span className="flex flex-wrap justify-end gap-1">
              {evento.fuentes.map((fuente) => (
                <Badge key={fuente} variant="secondary" className="font-data">
                  {fuente}
                </Badge>
              ))}
            </span>
          </DetailRow>

          <DetailRow label={t('reportedFelt')}>
            {evento.sentido ? t('yes') : t('no')}
          </DetailRow>

          <DetailRow label={t('reviewedByAnalyst')}>
            {evento.revisado ? t('yes') : t('noAutomaticSolution')}
          </DetailRow>
        </dl>

        <div className="px-4 pt-4">
          <MagnitudeScale magnitude={evento.mag} />
        </div>

        <div className="px-4 pt-4">
          <button
            onClick={handleShare}
            className="flex w-full items-center justify-center gap-2 rounded-lg border-2 border-gray-300 px-3 py-2 text-sm transition-colors hover:bg-muted/60 dark:border-gray-700"
          >
            {outcome === 'copied' ? (
              <Check className="h-4 w-4 text-severity-low" aria-hidden="true" />
            ) : (
              <Share2 className="h-4 w-4" aria-hidden="true" />
            )}
            {shareLabel}
          </button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
