/**
 * Primitivos de carga de la app.
 *
 * POR QUÉ EXISTE: el relevamiento del 2026-08-24 encontró 11 patrones
 * distintos para el mismo concepto — tres iconos girando (`Loader2`,
 * `Activity`, `RefreshCw`), un spinner de borde CSS, texto plano, skeletons,
 * una barra indeterminada, un em-dash y varios `return null`. Uno solo de
 * todos ellos tenía accesibilidad.
 *
 * Acá vive la forma canónica. Se construye sobre `ui/skeleton.tsx` (que ya
 * existía y casi nadie usaba) en vez de inventar un decimosegundo patrón.
 *
 * Regla de a11y: todo estado de carga anuncia `role="status"` y `aria-live`
 * — un lector de pantalla tiene que enterarse de que la pantalla está
 * esperando, no quedarse en silencio.
 */

import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Spinner con etiqueta accesible. El texto es opcional en pantalla pero
 * NUNCA opcional para el lector: si no se muestra, viaja en `sr-only`.
 */
export function LoadingSpinner({
  label,
  showLabel = false,
  className,
}: {
  label: string;
  showLabel?: boolean;
  className?: string;
}) {
  return (
    <span role="status" aria-live="polite" className={cn('inline-flex items-center gap-2', className)}>
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      <span className={showLabel ? 'text-sm text-muted-foreground' : 'sr-only'}>{label}</span>
    </span>
  );
}

/**
 * Bloque de carga que ocupa el lugar del contenido que viene.
 *
 * `aria-busy` sobre el contenedor: el bloque no es "contenido vacío", es
 * contenido en camino, y esa diferencia es la que hoy no se comunicaba.
 */
export function LoadingBlock({
  label,
  className,
  lines = 3,
}: {
  label: string;
  className?: string;
  lines?: number;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label={label}
      className={cn('flex flex-col gap-2', className)}
    >
      {Array.from({ length: lines }, (_, i) => (
        // Anchos decrecientes: un bloque de barras idénticas se lee como una
        // tabla rota; escalonarlas se lee como texto que todavía no llegó.
        <Skeleton key={i} className={cn('h-4', i === lines - 1 ? 'w-2/3' : 'w-full')} />
      ))}
      <span className="sr-only">{label}</span>
    </div>
  );
}

/**
 * Placeholder de área grande (un canvas, un mapa, el globo) que además evita
 * que el layout salte cuando aparece el contenido real.
 */
export function LoadingSurface({
  label,
  className,
}: {
  label: string;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className={cn(
        'flex items-center justify-center rounded-xl bg-muted/30 animate-pulse-slow',
        className,
      )}
    >
      <LoadingSpinner label={label} showLabel />
    </div>
  );
}
