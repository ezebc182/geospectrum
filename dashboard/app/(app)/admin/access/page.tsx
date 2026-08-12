/**
 * Administración unificada de accesos (pulido post-QA): una sola página con
 * dos pestañas — "Lista de espera" (ex /beta) e "Invitaciones" (ex
 * /admin/invitations). Las rutas viejas redirigen acá con ?tab=..., y el
 * sidebar tiene UNA entrada "Accesos" en lugar de dos.
 *
 * La pestaña activa vive en la URL (?tab=waitlist|invitations) para que los
 * deep-links de las redirecciones y el back del navegador funcionen; no hay
 * componente Tabs en ui/, así que son dos botones con aria-selected.
 *
 * El backend es la autoridad de permisos; el gate client-side de acá solo
 * evita renderizar secciones que la API va a negar igual.
 */

'use client';

import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { MailPlus, UserCheck } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useAuth } from '@/hooks/use-auth';
import { BetaSignupsPanel } from '@/components/admin/BetaSignupsPanel';
import { InvitationsPanel } from '@/components/admin/InvitationsPanel';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

const ADMIN_ROLES = ['admin', 'superadmin'];

type AccessTab = 'waitlist' | 'invitations';

/** Labels fuera de la constante de módulo (Decision 5): el componente
 * resuelve t(`tabs.${id}`) con el idioma activo. */
const TABS: { id: AccessTab; icon: typeof UserCheck }[] = [
  { id: 'waitlist', icon: UserCheck },
  { id: 'invitations', icon: MailPlus },
];

function AccessTabs() {
  const t = useTranslations('admin.access');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Cualquier valor desconocido de ?tab cae a la lista de espera — es el
  // primer paso del flujo (landing → espera → invitación).
  const tab: AccessTab = searchParams.get('tab') === 'invitations' ? 'invitations' : 'waitlist';

  function selectTab(next: AccessTab) {
    // replace (no push): cambiar de pestaña no debe apilar historial.
    router.replace(`${pathname}?tab=${next}`, { scroll: false });
  }

  return (
    <>
      <div role="tablist" aria-label={t('tablistAria')} className="flex gap-1 border-b border-border">
        {TABS.map(({ id, icon: Icon }) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => selectTab(id)}
            className={cn(
              '-mb-px inline-flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              tab === id
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
            {t(`tabs.${id}`)}
          </button>
        ))}
      </div>

      <div role="tabpanel">
        {tab === 'waitlist' ? <BetaSignupsPanel /> : <InvitationsPanel />}
      </div>
    </>
  );
}

export default function AccessAdminPage() {
  const t = useTranslations('admin.access');
  const { user } = useAuth();

  if (user && !ADMIN_ROLES.includes(user.role)) {
    return (
      <div className="p-6">
        <Card>
          <CardHeader>
            <CardTitle>{t('title')}</CardTitle>
            <CardDescription>{t('forbidden')}</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="font-heading text-2xl font-bold tracking-tight">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
      </div>

      {/* useSearchParams exige un boundary de Suspense en el App Router. */}
      <React.Suspense fallback={null}>
        <AccessTabs />
      </React.Suspense>
    </div>
  );
}
