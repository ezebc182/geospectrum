/**
 * Sección de colaboración de la landing.
 *
 * Mismo patrón que LandingSections: los textos salen del ns `landing.support`
 * vía useTranslations y acá sólo viven estructura e íconos. El ícono va por
 * `id` y no por posición (a diferencia de STEP_ICONS/FEATURE_ICONS) porque
 * esta lista SE FILTRA: con la lista recortada, el índice ya no alinea con el
 * diccionario y un botón mostraría el ícono de otro.
 *
 * Si no hay ninguna plataforma configurada la sección entera no se renderiza
 * — una sección de donaciones sin botones es peor que no tenerla.
 */

'use client';

import { useTranslations } from 'next-intl';
import { Coffee, Github, HeartHandshake } from 'lucide-react';

import { configuredSupportLinks, type SupportLink } from '@/lib/support-links';

const SUPPORT_ICONS: Record<SupportLink['id'], typeof Coffee> = {
  cafecito: Coffee,
  kofi: HeartHandshake,
  sponsors: Github,
};

export function LandingSupport() {
  const t = useTranslations('landing.support');
  const links = configuredSupportLinks();

  if (links.length === 0) return null;

  return (
    <section id="colaborar" className="border-t border-border bg-card/40">
      <div className="mx-auto max-w-6xl px-6 py-20 md:py-28">
        <p className="font-mono text-xs uppercase tracking-widest text-primary">
          {t('kicker')}
        </p>
        <h2 className="mt-3 max-w-2xl font-heading text-3xl font-bold tracking-tight md:text-4xl">
          {t('title')}
        </h2>
        <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          {t('body')}
        </p>
        <p className="mt-3 font-mono text-xs text-muted-foreground/80">{t('costNote')}</p>

        <ul className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {links.map((link) => {
            const Icon = SUPPORT_ICONS[link.id];
            return (
              <li key={link.id}>
                <a
                  href={link.url}
                  target="_blank"
                  // noopener/noreferrer: el destino es un tercero y la pestaña
                  // nueva no debe poder tocar window.opener.
                  rel="noopener noreferrer"
                  className="flex min-h-16 items-center gap-4 rounded-xl border border-border bg-background/60 p-5 transition-colors hover:border-primary/40"
                >
                  <Icon className="h-6 w-6 shrink-0 text-primary" aria-hidden="true" />
                  <span>
                    <span className="block font-heading text-base font-semibold">
                      {t(link.id)}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {t(`${link.id}Hint`)}
                    </span>
                  </span>
                </a>
              </li>
            );
          })}
        </ul>

        <p className="mt-8 text-sm text-muted-foreground">{t('thanks')}</p>
      </div>
    </section>
  );
}
