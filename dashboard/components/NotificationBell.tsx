'use client';

import { useEffect, useState } from 'react';
import useSWR from 'swr';
import { useTranslations } from 'next-intl';
import { Bell, AlertTriangle, Check, CheckCheck, Users, Activity } from 'lucide-react';

import {
  alertFingerprint,
  loadReadFingerprints,
  saveReadFingerprints,
} from '@/lib/alert-read-state';
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

  /**
   * Huellas de alertas leídas. Se cargan por EFECTO, nunca en
   * `useState(loadReadFingerprints())`: leer localStorage durante el render
   * da HTML distinto en servidor y cliente (hydration mismatch) — misma
   * regla que los settings del helicorder y la progresividad.
   */
  const [readFingerprints, setReadFingerprints] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    setReadFingerprints(loadReadFingerprints());
  }, []);

  const isRead = (alerta: Alert) => readFingerprints.has(alertFingerprint(alerta));
  const unreadCount = alertas.filter((a) => !isRead(a)).length;

  const markRead = (alerta: Alert) => {
    setReadFingerprints((prev) => {
      const next = new Set(prev).add(alertFingerprint(alerta));
      saveReadFingerprints(next);
      return next;
    });
  };

  const markAllRead = () => {
    setReadFingerprints((prev) => {
      const next = new Set(prev);
      for (const alerta of alertas) next.add(alertFingerprint(alerta));
      saveReadFingerprints(next);
      return next;
    });
  };

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
        aria-label={t('bellAria', { count: unreadCount })}
        className="relative flex h-8 w-8 items-center justify-center rounded-md hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Bell className="h-4 w-4" aria-hidden="true" />
        {/* El badge cuenta lo NO LEÍDO: marcar todas limpia la campanita
            aunque las alertas sigan activas en la lista. */}
        {unreadCount > 0 && (
          <Badge
            variant="destructive"
            className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 font-data text-[10px] leading-none"
          >
            {unreadCount}
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
          <span className="flex items-center gap-2">
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={markAllRead}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] normal-case tracking-normal text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <CheckCheck className="h-3.5 w-3.5" aria-hidden="true" />
                {t('markAllRead')}
              </button>
            )}
            {hasAlerts && (
              <Badge variant="destructive" className="font-data">
                {unreadCount}
              </Badge>
            )}
          </span>
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
            {alertasFiltradas.map((alerta) => (
              // La huella como key (no el índice): filtrar por tipo reordena
              // la lista y con índices React re-asociaría estados de fila.
              <AlertRow
                key={alertFingerprint(alerta)}
                alerta={alerta}
                read={isRead(alerta)}
                onMarkRead={() => markRead(alerta)}
              />
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

function AlertRow({
  alerta,
  read,
  onMarkRead,
}: {
  alerta: Alert;
  read: boolean;
  onMarkRead: () => void;
}) {
  const t = useTranslations('notifications');
  const severity = getAlertSeverity(alerta.tipo);

  return (
    <div
      data-read={read || undefined}
      // La leída se ATENÚA, no se oculta: la alerta sigue ACTIVA (el backend
      // la recalcula mientras la condición dure) y esconderla mentiría.
      className={cn('rounded-lg border-l-4 p-3', severityStyles[severity], read && 'opacity-50')}
    >
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
        {!read && (
          <button
            type="button"
            onClick={onMarkRead}
            aria-label={t('markRead')}
            title={t('markRead')}
            className="mt-0.5 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}
