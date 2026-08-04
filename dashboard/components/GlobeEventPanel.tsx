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

import { useState } from 'react';
import { Check, Share2 } from 'lucide-react';

import { eventUrl, shareEvent, type ShareOutcome } from '@/lib/share-event';
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
  formatDateTime,
  formatDepth,
  formatMagnitude,
  getMagnitudeSeverity,
} from '@/lib/utils';
import type { SeismicEvent } from '@/lib/types';

const magnitudeBadgeVariant = {
  low: 'secondary' as const,
  moderate: 'outline' as const,
  high: 'outline' as const,
  critical: 'destructive' as const,
};

const magnitudeBadgeClass = {
  low: 'bg-severity-low/15 text-severity-low',
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

/** Texto del botón según cómo haya salido el último intento. */
function shareLabel(outcome: ShareOutcome | null): string {
  if (outcome === 'copied') return 'Copiado al portapapeles';
  if (outcome === 'failed') return 'No se pudo compartir';
  return 'Compartir';
}

export function GlobeEventPanel({ evento, onClose }: GlobeEventPanelProps) {
  const [outcome, setOutcome] = useState<ShareOutcome | null>(null);

  const handleShare = async () => {
    if (!evento) return;
    // La URL lleva ?event=<id> para que quien la abra caiga en este mismo
    // sismo. Sin el parámetro el link abre el globo girando y el mensaje
    // pierde la mitad de su sentido.
    setOutcome(await shareEvent(evento, eventUrl(globePointId(evento))));
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
            <span className="text-base">{evento.lugar ?? 'Ubicación desconocida'}</span>
          </SheetTitle>
          <SheetDescription>{formatDateTime(evento.hora_utc)}</SheetDescription>
        </SheetHeader>

        <dl className="px-4">
          <DetailRow label="Profundidad">{formatDepth(evento.prof_km)}</DetailRow>

          <DetailRow label="Coordenadas">
            <span className="font-data">
              {evento.lat.toFixed(3)}, {evento.lon.toFixed(3)}
            </span>
          </DetailRow>

          {evento.mag_tipo && (
            <DetailRow label="Tipo de magnitud">
              <span className="font-data uppercase">{evento.mag_tipo}</span>
            </DetailRow>
          )}

          <DetailRow label="Fuentes">
            <span className="flex flex-wrap justify-end gap-1">
              {evento.fuentes.map((fuente) => (
                <Badge key={fuente} variant="secondary" className="font-data">
                  {fuente}
                </Badge>
              ))}
            </span>
          </DetailRow>

          <DetailRow label="Reportado como sentido">
            {evento.sentido ? 'Sí' : 'No'}
          </DetailRow>

          <DetailRow label="Revisado por analista">
            {evento.revisado ? 'Sí' : 'No — solución automática'}
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
            {shareLabel(outcome)}
          </button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
