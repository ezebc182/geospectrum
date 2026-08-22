'use client';

/**
 * Indicador del stream de eventos (PR-W4, T12).
 *
 * Reemplaza el contador "Actualización en 23s" de la cartelera: ese número era
 * la cara visible del polling encadenado que este PR elimina.
 *
 * El vocabulario visual es el MISMO del punto de LiveSpectrogramCanvas
 * (:195-199): punto de 2×2, verde con `animate-pulse` cuando hay datos,
 * amarillo cuando reintenta, rojo cuando se dio por vencido. Que las dos
 * superficies usen el mismo lenguaje evita que el usuario tenga que aprender
 * dos semáforos distintos en la misma app.
 */

import { useTranslations } from 'next-intl';

import type { StreamStatus } from '@/hooks/use-event-stream';
import { cn } from '@/lib/utils';

const DOT_CLASSES: Record<StreamStatus, string> = {
  live: 'bg-green-400 animate-pulse',
  connecting: 'bg-yellow-400',
  reconnecting: 'bg-yellow-400 animate-pulse',
  offline: 'bg-red-500',
};

/** Clave de i18n por estado, bajo el namespace `common.live`. */
const LABEL_KEYS: Record<StreamStatus, 'connected' | 'connecting' | 'reconnecting' | 'offline'> = {
  live: 'connected',
  connecting: 'connecting',
  reconnecting: 'reconnecting',
  offline: 'offline',
};

export function LiveIndicator({
  status,
  showLabel = true,
  labelClassName,
  className,
}: {
  status: StreamStatus;
  /** false deja sólo el punto (el texto sigue disponible para lectores). */
  showLabel?: boolean;
  /**
   * Clases del texto. El sidebar colapsado (`collapsible="icon"`) sólo tiene
   * lugar para el punto y le pasa `group-data-[collapsible=icon]:hidden` —
   * la misma utilidad con la que oculta "GeoSpectrum".
   */
  labelClassName?: string;
  className?: string;
}) {
  const t = useTranslations('common.live');
  const label = t(LABEL_KEYS[status]);

  return (
    <span
      className={cn('flex items-center gap-1.5 text-xs', className)}
      // role="status" + aria-live para que un lector de pantalla anuncie la
      // caída del stream: el color no comunica nada sin vista.
      role="status"
      aria-live="polite"
      // El title cubre el caso del sidebar colapsado, donde el texto no se ve.
      title={label}
    >
      <span
        className={cn('h-2 w-2 shrink-0 rounded-full', DOT_CLASSES[status])}
        aria-hidden="true"
      />
      {showLabel ? (
        <span className={cn('truncate text-muted-foreground', labelClassName)}>{label}</span>
      ) : (
        /* Sin showLabel el texto igual viaja para el lector de pantalla. */
        <span className="sr-only">{label}</span>
      )}
    </span>
  );
}
