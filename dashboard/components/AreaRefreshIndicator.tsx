/**
 * Señal visual de "estoy trayendo los datos del área nueva".
 *
 * Existe porque `isLoading` de SWR sólo es true en la PRIMERA carga: al cambiar
 * de área ya hay datos en caché, SWR revalida en background con isLoading en
 * false y el spinner de carga inicial nunca aparece. El usuario veía la pantalla
 * anterior congelada 1-4 segundos (latencia real de USGS/EMSC) sin ninguna
 * señal, y la app parecía colgada.
 *
 * Deliberadamente NO se engancha a `isValidating`: eso incluiría los refrescos
 * automáticos (30s en /live, 60s en el dashboard) y la barra parpadearía sola
 * cada medio minuto. Sólo se enciende ante una acción explícita del usuario,
 * que es lo que `useAreaRefresh` reporta.
 */

'use client';

import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

interface AreaRefreshIndicatorProps {
  /** Si hay una revalidación por cambio de área en curso. */
  isRefreshing: boolean;
  /** El contenido de la página, que se atenúa mientras dura la revalidación. */
  children: ReactNode;
  /**
   * Clases del contenedor del contenido, no del wrapper externo: es ahí donde
   * las páginas necesitan su `space-y-*`, porque el wrapper sólo aloja además
   * la barra en posición absoluta y un `space-y` en él la separaría del borde.
   */
  className?: string;
}

export function AreaRefreshIndicator({
  isRefreshing,
  children,
  className,
}: AreaRefreshIndicatorProps) {
  return (
    <div className="relative" aria-busy={isRefreshing}>
      {/* La barra se monta sólo cuando hace falta para que la animación arranque
          desde el principio en cada cambio, en vez de quedar corriendo oculta. */}
      {isRefreshing && (
        <div
          role="status"
          aria-live="polite"
          className="absolute inset-x-0 -top-2 z-20 h-1 overflow-hidden rounded-full bg-muted"
        >
          <div className="h-full w-1/4 animate-indeterminate-bar rounded-full bg-seismic-600" />
          <span className="sr-only">Actualizando datos del área seleccionada…</span>
        </div>
      )}

      {/* El contenido viejo sigue visible —mantiene el contexto— pero atenuado y
          sin clicks: durante esos segundos la tabla y el mapa muestran eventos
          de la región anterior, y clickearlos seleccionaría algo que está por
          desaparecer. `transition-opacity` evita el corte brusco. */}
      <div
        className={cn(
          'transition-opacity duration-200',
          isRefreshing && 'pointer-events-none opacity-60',
          className
        )}
      >
        {children}
      </div>
    </div>
  );
}
