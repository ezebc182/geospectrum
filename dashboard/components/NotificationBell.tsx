'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { useTranslations } from 'next-intl';
import { Bell, AlertTriangle, Users, Activity } from 'lucide-react';

import { reportFetcher } from '@/lib/api';
import { getAlertIcon, getAlertSeverity, cn } from '@/lib/utils';
import type { Alert, AlertType } from '@/lib/types';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Badge } from '@/components/ui/badge';

/** Orden de los chips de filtro — mismo orden en que suelen aparecer. El label
 * lo resuelve el componente con `t(`types.${id}`)` (Decision 5: las constantes
 * de módulo no llaman a t()). */
const ALERT_TYPE_IDS: AlertType[] = [
  'evento_significativo',
  'enjambre',
  'actividad_sentida',
];

/**
 * Campana de alertas en el header, con el mismo contenido que antes vivía
 * apilado arriba del Dashboard (AlertBanner en el flujo de la página).
 *
 * Con 13+ alertas activas ese bloque empujaba el mapa y la tabla varias
 * pantallas hacia abajo — acá el mismo contenido vive en un dropdown, sin
 * ocupar espacio salvo que el usuario lo abra.
 *
 * `useSWR('/report', reportFetcher)` con la MISMA key que usa el Dashboard:
 * SWR dedupea por key, así que esto no dispara un fetch de red aparte, sólo
 * se suscribe al cache ya existente (o lo llena si esta página es la
 * primera en pedirlo, p. ej. /explore o /live).
 */
export function NotificationBell() {
  const t = useTranslations('notifications');
  const { data } = useSWR('/report', reportFetcher, {
    refreshInterval: 60000,
    revalidateOnFocus: true,
  });

  const alertas = data?.alertas ?? [];
  const hasAlerts = alertas.length > 0;

  // Vacío = sin filtro, se muestran todas. Igual criterio que el toggle de
  // categorías de la leyenda del mapa: activo por selección explícita, no al
  // revés (evita que abrir el dropdown con 0 tipos elegidos muestre "nada").
  const [activeTypes, setActiveTypes] = useState<Set<AlertType>>(() => new Set());
  const toggleType = (tipo: AlertType) => {
    setActiveTypes((prev) => {
      const next = new Set(prev);
      if (next.has(tipo)) next.delete(tipo);
      else next.add(tipo);
      return next;
    });
  };
  const alertasFiltradas =
    activeTypes.size === 0 ? alertas : alertas.filter((a) => activeTypes.has(a.tipo));

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        // Ancla del tour de onboarding (Decision 7 de email-invitations).
        data-tour-id="alerts-bell"
        aria-label={t('bellAria', { count: alertas.length })}
        className="relative flex h-8 w-8 items-center justify-center rounded-md hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Bell className="h-4 w-4" aria-hidden="true" />
        {hasAlerts && (
          <Badge
            variant="destructive"
            className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 font-data text-[10px] leading-none"
          >
            {alertas.length}
          </Badge>
        )}
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="end"
        collisionPadding={12}
        // El z-[1100] que antes vivía acá como parche puntual hoy es el
        // default de DropdownMenuContent (fix sistémico vs mapa Leaflet).
        className="max-h-[min(28rem,var(--radix-dropdown-menu-content-available-height))] w-[22rem] overflow-y-auto"
      >
        <DropdownMenuLabel className="flex items-center justify-between text-xs uppercase tracking-wider text-muted-foreground">
          <span>{t('activeAlerts')}</span>
          {hasAlerts && (
            <Badge variant="destructive" className="font-data">
              {alertas.length}
            </Badge>
          )}
        </DropdownMenuLabel>

        {hasAlerts && (
          <div className="flex flex-wrap gap-1.5 px-2 pb-2 pt-1">
            {ALERT_TYPE_IDS.map((id) => {
              const isActive = activeTypes.has(id);
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => toggleType(id)}
                  aria-pressed={isActive}
                  className={cn(
                    'rounded-full border px-2 py-0.5 text-xs transition-colors',
                    isActive
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border text-muted-foreground hover:bg-accent'
                  )}
                >
                  {t(`types.${id}`)}
                </button>
              );
            })}
          </div>
        )}

        <DropdownMenuSeparator />

        {!hasAlerts ? (
          <div className="px-2 py-6 text-center text-sm text-muted-foreground">
            {t('empty')}
          </div>
        ) : alertasFiltradas.length === 0 ? (
          <div className="px-2 py-6 text-center text-sm text-muted-foreground">
            {t('noneMatchFilter')}
          </div>
        ) : (
          // divs planos, no DropdownMenuItem: las alertas son contenido a
          // leer, no comandos a ejecutar — mismo criterio que el buscador
          // sin-Item de AreaSelector.
          <div className="space-y-2 p-2">
            {alertasFiltradas.map((alerta, idx) => (
              <AlertRow key={idx} alerta={alerta} />
            ))}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const severityStyles = {
  danger: 'border-severity-critical bg-severity-critical/10 text-foreground',
  warning: 'border-severity-moderate bg-severity-moderate/10 text-foreground',
  info: 'border-severity-low bg-severity-low/10 text-foreground',
};

function getAlertIconComponent(tipo: string) {
  switch (tipo) {
    case 'evento_significativo':
      return <AlertTriangle className="h-4 w-4" />;
    case 'enjambre':
      return <Activity className="h-4 w-4" />;
    case 'actividad_sentida':
      return <Users className="h-4 w-4" />;
    default:
      return null;
  }
}

function AlertRow({ alerta }: { alerta: Alert }) {
  const t = useTranslations('notifications');
  const severity = getAlertSeverity(alerta.tipo);

  return (
    <div className={cn('rounded-lg border-l-4 p-3', severityStyles[severity])}>
      <div className="flex items-start gap-2">
        <div className="mt-0.5">{getAlertIconComponent(alerta.tipo)}</div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm" aria-hidden>
              {getAlertIcon(alerta.tipo)}
            </span>
            <span className="text-xs font-medium uppercase tracking-wide">
              {t(`types.${alerta.tipo}`)}
            </span>
          </div>
          <p className="mt-1 text-sm font-medium">{alerta.descripcion}</p>
          <p className="mt-1 font-data text-xs opacity-75">
            {t('relatedEvents', { count: alerta.eventos_relacionados.length })}
          </p>
        </div>
      </div>
    </div>
  );
}
