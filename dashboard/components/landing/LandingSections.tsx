/**
 * Secciones intermedias de la landing: cómo funciona, capacidades y CTA.
 *
 * Los textos salen del ns `landing` vía useTranslations (i18n-dashboard,
 * Fase 7); acá sólo viven la estructura y los íconos, que no dependen del
 * idioma. Las listas (pasos/capacidades) se leen con t.raw porque en el
 * diccionario son arrays — misma jerarquía que el viejo LANDING_COPY. El
 * footer tiene su propio componente (LandingFooter) porque además de
 * contenido tiene comportamiento: el form de alta a la beta.
 */

'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  ArrowRight,
  AudioWaveform,
  BellRing,
  BrainCircuit,
  Globe2,
  History,
  Map,
  MapPin,
  Satellite,
} from 'lucide-react';

import { Button } from '@/components/ui/button';

// Ícono por posición, paralelo a how.steps / features.items del diccionario:
// la estructura (cuántos pasos, qué ícono) es fija; sólo el texto se traduce.
const STEP_ICONS = [Satellite, BrainCircuit, BellRing] as const;
const FEATURE_ICONS = [Globe2, Map, AudioWaveform, MapPin, History, BellRing] as const;

/** Ítem título+descripción de las listas del diccionario. */
interface TitledItem {
  title: string;
  description: string;
}

export function LandingSections() {
  const t = useTranslations('landing');
  const steps = t.raw('how.steps') as readonly TitledItem[];
  const features = t.raw('features.items') as readonly TitledItem[];

  return (
    <>
      {/* Cómo funciona */}
      <section id="como-funciona" className="border-t border-border">
        <div className="mx-auto max-w-6xl px-6 py-20 md:py-28">
          <p className="font-mono text-xs uppercase tracking-widest text-primary">
            {t('how.kicker')}
          </p>
          <h2 className="mt-3 max-w-2xl font-heading text-3xl font-bold tracking-tight md:text-4xl">
            {t('how.title')}
          </h2>

          <ol className="mt-12 grid gap-10 md:grid-cols-3">
            {steps.map((step, index) => {
              const Icon = STEP_ICONS[index];
              return (
                <li key={step.title} className="relative">
                  <span
                    className="font-mono text-5xl font-bold text-primary/15"
                    aria-hidden="true"
                  >
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <div className="mt-3 flex items-center gap-3">
                    <Icon className="h-5 w-5 text-primary" aria-hidden="true" />
                    <h3 className="font-heading text-lg font-semibold">{step.title}</h3>
                  </div>
                  <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                    {step.description}
                  </p>
                </li>
              );
            })}
          </ol>
        </div>
      </section>

      {/* Capacidades */}
      <section id="capacidades" className="border-t border-border bg-card/40">
        <div className="mx-auto max-w-6xl px-6 py-20 md:py-28">
          <p className="font-mono text-xs uppercase tracking-widest text-primary">
            {t('features.kicker')}
          </p>
          <h2 className="mt-3 max-w-2xl font-heading text-3xl font-bold tracking-tight md:text-4xl">
            {t('features.title')}
          </h2>

          <ul className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {features.map((item, index) => {
              const Icon = FEATURE_ICONS[index];
              return (
                <li
                  key={item.title}
                  className="rounded-xl border border-border bg-background/60 p-6 transition-colors hover:border-primary/40"
                >
                  <Icon className="h-6 w-6 text-primary" aria-hidden="true" />
                  <h3 className="mt-4 font-heading text-base font-semibold">
                    {item.title}
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                    {item.description}
                  </p>
                </li>
              );
            })}
          </ul>
        </div>
      </section>

      {/* CTA final */}
      <section className="border-t border-border">
        <div className="mx-auto max-w-6xl px-6 py-20 text-center md:py-28">
          <h2 className="mx-auto max-w-2xl font-heading text-3xl font-bold tracking-tight md:text-4xl">
            {t('cta.titleTop')}
            <br />
            <span className="text-primary">{t('cta.titleAccent')}</span>
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-muted-foreground">{t('cta.subtitle')}</p>
          <div className="mt-8">
            <Button asChild size="lg" className="min-h-12 px-8 text-base">
              <Link href="/login">
                {t('cta.button')}
                <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
              </Link>
            </Button>
          </div>
        </div>
      </section>
    </>
  );
}
