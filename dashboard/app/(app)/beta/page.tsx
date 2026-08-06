/**
 * Administración de beta testers: la cola de aprobación del flujo
 * landing → lista de espera → aprobar → email de bienvenida.
 *
 * El backend es la autoridad de permisos (GET/POST exigen admin+ vía
 * require_min_role); el guard client-side de abajo sólo evita mostrarle a
 * un viewer una tabla que la API le va a negar igual.
 */

'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { CheckCircle2, Clock, Mail, UserCheck } from 'lucide-react';

import { approveBetaSignup, getBetaSignups } from '@/lib/api';
import { useAuth } from '@/hooks/use-auth';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import type { BetaSignup } from '@/lib/types';

const ADMIN_ROLES = ['admin', 'superadmin'];

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('es-AR', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function BetaAdminPage() {
  const { user } = useAuth();
  const { data, error, isLoading, mutate } = useSWR<BetaSignup[]>(
    'beta-signups',
    getBetaSignups,
  );

  // Id en vuelo: deshabilita SOLO el botón clickeado, no toda la tabla.
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function handleApprove(signup: BetaSignup) {
    setActionError(null);
    setApprovingId(signup.id);
    try {
      await approveBetaSignup(signup.id);
      // Revalidar trae approved_at real del backend — sin estado optimista
      // que pueda mentir si el POST falló a mitad de camino.
      await mutate();
    } catch {
      setActionError(
        `No se pudo aprobar a ${signup.email}. Probá de nuevo en unos segundos.`,
      );
    } finally {
      setApprovingId(null);
    }
  }

  if (user && !ADMIN_ROLES.includes(user.role)) {
    return (
      <div className="p-6">
        <Card>
          <CardHeader>
            <CardTitle>Beta testers</CardTitle>
            <CardDescription>
              Esta sección es para administradores. Tu rol actual no tiene
              permisos para ver la lista de espera.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  const pendientes = data?.filter((s) => s.approved_at === null).length ?? 0;

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="font-heading text-2xl font-bold tracking-tight">Beta testers</h1>
        <p className="text-sm text-muted-foreground">
          Interesados anotados desde la landing. Aprobar crea la invitación y
          dispara el email de bienvenida con el acceso.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <UserCheck className="h-4 w-4 text-primary" aria-hidden="true" />
            Lista de espera
            {data && (
              <Badge variant="secondary" className="ml-2 font-mono">
                {pendientes} pendiente{pendientes === 1 ? '' : 's'}
              </Badge>
            )}
          </CardTitle>
          <CardDescription>
            Pendientes primero, más recientes arriba.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {actionError && (
            <p role="alert" className="mb-4 text-sm text-destructive">
              {actionError}
            </p>
          )}

          {isLoading && (
            <div className="space-y-3">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          )}

          {error && (
            <p className="text-sm text-destructive">
              No se pudo cargar la lista. Verificá tu sesión e intentá de nuevo.
            </p>
          )}

          {data && data.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <Mail className="h-8 w-8 text-muted-foreground/50" aria-hidden="true" />
              <p className="text-sm text-muted-foreground">
                Todavía no hay interesados. Cuando alguien se anote en la
                landing, aparece acá (y te llega un aviso por email).
              </p>
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
                      {formatDate(signup.created_at)}
                    </span>
                    {aprobado ? (
                      <Badge
                        variant="outline"
                        className="gap-1 border-primary/40 text-primary"
                      >
                        <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                        Aprobado
                      </Badge>
                    ) : (
                      <>
                        <Badge variant="outline" className="gap-1 text-muted-foreground">
                          <Clock className="h-3 w-3" aria-hidden="true" />
                          Pendiente
                        </Badge>
                        <Button
                          size="sm"
                          className="min-h-9"
                          disabled={approvingId === signup.id}
                          onClick={() => handleApprove(signup)}
                        >
                          {approvingId === signup.id ? 'Aprobando…' : 'Aprobar'}
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
    </div>
  );
}
