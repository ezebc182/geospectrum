'use client';

import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Check, Languages } from 'lucide-react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAuth } from '@/hooks/use-auth';
import { updateProfile } from '@/lib/auth';
import { APP_LOCALES, setLocaleCookie, toAppLocale, type AppLocale } from '@/lib/locale';

/**
 * Selector de idioma reutilizable (header, Settings, landing, invite —
 * design i18n-dashboard, Decision 3). Al cambiar:
 * 1. Escribe la cookie NEXT_LOCALE y hace router.refresh() — re-corre
 *    getRequestConfig y el provider re-renderiza con los mensajes nuevos.
 *    Sin reload: la caché de SWR y el estado de cliente quedan intactos.
 * 2. Si hay sesión, PATCH /account/profile {locale} en paralelo,
 *    best-effort: una falla se loguea y no bloquea ni revierte la UI (la
 *    cookie ya manda para este navegador). Sin sesión NO se llama a
 *    ninguna API de cuenta.
 */
export function LocaleSwitcher() {
  const router = useRouter();
  const { user } = useAuth();
  const t = useTranslations('common');
  // useLocale() devuelve el locale de FORMATO (es-AR/en-US); se colapsa
  // al identificador de app para comparar y persistir.
  const activeLocale = toAppLocale(useLocale());

  function handleSelect(locale: AppLocale) {
    if (locale === activeLocale) return;

    setLocaleCookie(locale);
    router.refresh();

    if (user) {
      // Best-effort deliberado: la preferencia de cuenta es para OTROS
      // dispositivos; en este navegador la cookie ya ganó.
      updateProfile({ locale }).catch((error) => {
        console.error('No se pudo persistir el idioma en la cuenta', error);
      });
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('language')}
          className="rounded-md p-2 hover:bg-accent"
        >
          <Languages className="h-4 w-4" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="bottom" className="w-40">
        {APP_LOCALES.map((locale) => (
          <DropdownMenuItem key={locale} onClick={() => handleSelect(locale)}>
            {/* Cada idioma se muestra en su propio idioma (Español /
                English) — misma etiqueta en ambos diccionarios. */}
            <span className="flex-1">{t(`localeNames.${locale}`)}</span>
            {locale === activeLocale && <Check className="h-4 w-4" aria-hidden="true" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
