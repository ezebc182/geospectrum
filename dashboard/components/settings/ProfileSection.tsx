'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';

import { updateProfile } from '@/lib/auth';
import {
  APP_LOCALES,
  setLocaleCookie,
  toAppLocale,
  type AppLocale,
} from '@/lib/locale';
import type { UserProfile } from '@/lib/types';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Sección "Perfil" de /settings. Edita `full_name`/`address`/`phone` — todos
 * opcionales — vía `PATCH /account/profile`, y expone el selector de idioma
 * persistente (spec dashboard-ui, "Settings muestra y edita la preferencia").
 *
 * El selector de idioma reutiliza la LÓGICA del LocaleSwitcher del header
 * (cookie + router.refresh() + PATCH best-effort), no su UI: acá es un
 * select nativo con label, coherente con el resto del formulario. Aplica el
 * cambio EN CALIENTE (no espera el submit del form) y ambos selectores
 * quedan sincronizados solos: los dos derivan el idioma activo de
 * useLocale(), que cambia con el refresh.
 *
 * El `GET /account/profile` inicial NO se hace acá: lo hace el padre
 * (`SettingsPage`) una sola vez y lo pasa como prop `profile`, para evitar
 * dos GET redundantes al montar la página (este componente y
 * `TwoFactorSection` necesitaban el mismo `UserProfile`). Tras un PATCH
 * exitoso, el `UserProfile` actualizado se reporta al padre vía
 * `onProfileUpdate` para que su estado (y el de `TwoFactorSection`, que lee
 * `totp_enabled` del mismo objeto) no quede desactualizado.
 *
 * IMPORTANTE: `full_name` (este formulario) es un campo DISTINTO de
 * `user.name` (poblado por Google OAuth, mostrado en el header/UserMenu,
 * read-only). Este formulario deliberadamente NO muestra ni edita `name` —
 * solo se referencia como texto informativo de solo lectura, para que quede
 * claro que son dos conceptos separados (ver tasks.md nota de nomenclatura).
 */
export function ProfileSection({
  profile,
  loading,
  error: loadError,
  onProfileUpdate,
}: {
  profile: UserProfile | null;
  loading: boolean;
  error: string | null;
  onProfileUpdate: (profile: UserProfile) => void;
}) {
  const t = useTranslations('settings.profile');
  const tCommon = useTranslations('common');
  const router = useRouter();
  const { user } = useAuth();
  // El idioma efectivo de la UI: preferencia guardada si existe, si no el
  // que resolvió la cascada (cookie/navegador). Es lo que el select refleja.
  const activeLocale = toAppLocale(useLocale());
  const [fullName, setFullName] = React.useState('');
  const [address, setAddress] = React.useState('');
  const [phone, setPhone] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  // Se guarda el HECHO de la falla, no el mensaje: el texto se resuelve al
  // render para que un cambio de idioma en caliente lo re-traduzca.
  const [saveFailed, setSaveFailed] = React.useState(false);
  const [saved, setSaved] = React.useState(false);

  React.useEffect(() => {
    if (!profile) return;
    setFullName(profile.full_name ?? '');
    setAddress(profile.address ?? '');
    setPhone(profile.phone ?? '');
  }, [profile]);

  // Elección hecha en ESTA visita, todavía sin confirmar por el PATCH:
  // evita que el select "revierta" al valor viejo del perfil mientras el
  // PATCH está en vuelo (la cookie ya cambió y en este navegador manda).
  const [pendingLocale, setPendingLocale] = React.useState<AppLocale | null>(null);

  // El select muestra la preferencia de cuenta si existe; si es null ("nunca
  // eligió"), muestra el idioma efectivo actual — nunca un estado vacío.
  const selectedLocale: AppLocale = pendingLocale ?? profile?.locale ?? activeLocale;

  function handleLocaleChange(next: AppLocale) {
    if (next === selectedLocale) return;

    // Misma mecánica que el switcher del header: la cookie manda YA en este
    // navegador; el PATCH persiste la preferencia para otros dispositivos.
    setPendingLocale(next);
    setLocaleCookie(next);
    router.refresh();

    updateProfile({ locale: next })
      .then((updated) => {
        onProfileUpdate(updated);
        setPendingLocale(null);
      })
      .catch((error) => {
        // Best-effort deliberado (spec "La falla del PATCH no bloquea el
        // cambio visual"): la UI ya cambió, solo se pierde la sincronización
        // con otros dispositivos hasta un cambio exitoso. pendingLocale se
        // conserva: el select sigue mostrando lo que rige en este navegador.
        console.error('No se pudo persistir el idioma en la cuenta', error);
      });
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaveFailed(false);
    setSaved(false);
    setSaving(true);

    try {
      const updated = await updateProfile({
        full_name: fullName.trim() || null,
        address: address.trim() || null,
        phone: phone.trim() || null,
      });
      onProfileUpdate(updated);
      setSaved(true);
    } catch {
      setSaveFailed(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent>
        {user?.name && (
          <p className="mb-4 text-xs text-muted-foreground">
            {t('googleNameNote')}{' '}
            <span className="font-medium text-foreground">{user.name}</span>
          </p>
        )}

        {loading ? (
          <p className="text-sm text-muted-foreground">{t('loading')}</p>
        ) : loadError && !profile ? (
          <p role="alert" className="text-sm text-destructive">
            {loadError}
          </p>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="full_name" className="text-sm font-medium text-foreground">
                {t('fullName')}
              </label>
              <Input
                id="full_name"
                name="full_name"
                type="text"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                disabled={saving}
                placeholder={t('fullNamePlaceholder')}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="address" className="text-sm font-medium text-foreground">
                {t('address')}
              </label>
              <Input
                id="address"
                name="address"
                type="text"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                disabled={saving}
                placeholder={t('addressPlaceholder')}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="phone" className="text-sm font-medium text-foreground">
                {t('phone')}
              </label>
              <Input
                id="phone"
                name="phone"
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                disabled={saving}
                placeholder={t('phonePlaceholder')}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="profile-locale" className="text-sm font-medium text-foreground">
                {t('language')}
              </label>
              {/* Select nativo a propósito (misma razón que en el panel de
                  invitaciones): no hay componente Select en ui/ y el cambio
                  aplica al instante, fuera del submit del form. */}
              <select
                id="profile-locale"
                value={selectedLocale}
                onChange={(event) => handleLocaleChange(event.target.value as AppLocale)}
                className="flex h-9 w-40 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {APP_LOCALES.map((locale) => (
                  <option key={locale} value={locale}>
                    {tCommon(`localeNames.${locale}`)}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">{t('languageHint')}</p>
            </div>

            {saveFailed && (
              <p role="alert" className="text-sm text-destructive">
                {t('saveError')}
              </p>
            )}
            {saved && !saveFailed && (
              <p className="text-sm text-emerald-600 dark:text-emerald-400">{t('saved')}</p>
            )}

            <Button type="submit" disabled={saving || !profile} className="self-start">
              {saving ? t('saving') : t('save')}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
