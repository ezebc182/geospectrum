/**
 * Banner de colaboración de la app autenticada.
 *
 * Vive en el layout de (app) porque es global a toda la app logueada — la
 * misma razón por la que están ahí LocaleSync y OnboardingGate.
 *
 * DESCARTABLE A PROPÓSITO: esta es una herramienta de trabajo, y un pedido de
 * plata clavado arriba de la pantalla molesta a quien la usa todos los días.
 * Se cierra y no vuelve (localStorage). La landing sigue teniendo la sección
 * completa para quien quiera buscarla.
 *
 * El estado inicial es `false` (oculto) y recién un efecto lo prende si no
 * está descartado: en SSR no hay localStorage, así que arrancar en `true`
 * pintaría el banner en el HTML del servidor y lo haría desaparecer al
 * hidratar — un parpadeo en cada carga para quien ya lo cerró.
 */

'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Heart, X } from 'lucide-react';

import { configuredSupportLinks } from '@/lib/support-links';
import { Button } from '@/components/ui/button';

const DISMISSED_KEY = 'geospectrum:support-banner-dismissed';

export function SupportBanner() {
  const t = useTranslations('supportBanner');
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // localStorage puede tirar (modo privado, cookies bloqueadas). Si no se
    // puede leer la preferencia, NO mostramos: ante la duda, no molestar.
    try {
      if (window.localStorage.getItem(DISMISSED_KEY) === null) setVisible(true);
    } catch {
      /* sin storage, el banner no se muestra */
    }
  }, []);

  // Sin plataformas configuradas el botón no llevaría a ningún lado.
  if (configuredSupportLinks().length === 0) return null;
  if (!visible) return null;

  const dismiss = () => {
    setVisible(false);
    try {
      window.localStorage.setItem(DISMISSED_KEY, '1');
    } catch {
      /* el cierre vale para esta sesión aunque no se pueda persistir */
    }
  };

  return (
    <div className="flex items-center gap-3 border-b border-border bg-card/60 px-4 py-2 text-sm">
      <Heart className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
      <p className="min-w-0 flex-1 text-muted-foreground">{t('text')}</p>
      <Button asChild size="sm" variant="secondary" className="shrink-0">
        <Link href="/landing#colaborar">{t('cta')}</Link>
      </Button>
      <button
        type="button"
        onClick={dismiss}
        aria-label={t('dismiss')}
        className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
