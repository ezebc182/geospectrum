/**
 * Panel de beta testers — pestaña "Lista de espera" de /admin/access. Antes
 * vivía como página propia en /beta; se movió acá al unificar la
 * administración de accesos (pulido post-QA).
 *
 * Es la cola de aprobación del flujo landing → lista de espera → aprobar →
 * email de bienvenida. El backend es la autoridad de permisos (GET/POST
 * exigen admin+ vía require_min_role); el gate client-side vive en la página
 * contenedora (/admin/access).
 */

'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { CheckCircle2, Clock, Mail, UserCheck } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';

import { approveBetaSignup, getBetaSignups } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import type { BetaSignup } from '@/lib/types';

/** Opciones de fecha del listado (día + mes corto + hora): antes un
 * toLocaleDateString con es-AR fijo, ahora el locale activo vía useFormatter
 * (Decision 6). */
const DATE_OPTIONS = {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
} as const;

export function BetaSignupsPanel() {
  const t = useTranslations('admin.waitlist');
  const format = useFormatter();
  const { data, error, isLoading, mutate } = useSWR<BetaSignup[]>(
    'beta-signups',
    getBetaSignups,
  );

  // Id en vuelo: deshabilita SOLO el botón clickeado, no toda la tabla.
  const [approvingId, setApprovingId] = useState<string | null>(null);
  // Se guarda el email de la falla, no el mensaje resuelto: el texto se
  // traduce al render, así el cambio de idioma re-traduce el error visible.
  const [approveFailedEmail, setApproveFailedEmail] = useState<string | null>(null);

  async function handleApprove(signup: BetaSignup) {
    setApproveFailedEmail(null);
    setApprovingId(signup.id);
    try {
      await approveBetaSignup(signup.id);
      // Revalidar trae approved_at real del backend — sin estado optimista
      // que pueda mentir si el POST falló a mitad de camino.
      await mutate();
    } catch {
      setApproveFailedEmail(signup.email);
    } finally {
      setApprovingId(null);
    }
  }

  const pendientes = data?.filter((s) => s.approved_at === null).length ?? 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <UserCheck className="h-4 w-4 text-primary" aria-hidden="true" />
          {t('title')}
          {data && (
            <Badge variant="secondary" className="ml-2 font-mono">
              {t('pendingCount', { count: pendientes })}
            </Badge>
          )}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent>
        {approveFailedEmail && (
          <p role="alert" className="mb-4 text-sm text-destructive">
            {t('approveError', { email: approveFailedEmail })}
          </p>
        )}

        {isLoading && (
          <div className="space-y-3">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        )}

        {error && <p className="text-sm text-destructive">{t('loadError')}</p>}

        {data && data.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <Mail className="h-8 w-8 text-muted-foreground/50" aria-hidden="true" />
            <p className="text-sm text-muted-foreground">{t('empty')}</p>
          </div>
        )}

        {data && data.length > 0 && (
          <ul className="divide-y divide-border">
            {data.map((signup) => {
              const aprobado = signup.approved_at !== null;
              return (
                <li
                  key={signup.id}
                  className="flex flex-wrap items-center gap-3 py-3"
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-sm">
                    {signup.email}
                  </span>
                  <span className="font-mono text-xs tabular-nums text-muted-foreground">
                    {format.dateTime(new Date(signup.created_at), DATE_OPTIONS)}
                  </span>
                  {aprobado ? (
                    <Badge
                      variant="outline"
                      className="gap-1 border-primary/40 text-primary"
                    >
                      <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                      {t('approved')}
                    </Badge>
                  ) : (
                    <>
                      <Badge variant="outline" className="gap-1 text-muted-foreground">
                        <Clock className="h-3 w-3" aria-hidden="true" />
                        {t('pending')}
                      </Badge>
                      <Button
                        size="sm"
                        className="min-h-9"
                        disabled={approvingId === signup.id}
                        onClick={() => handleApprove(signup)}
                      >
                        {approvingId === signup.id ? t('approving') : t('approve')}
                      </Button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
