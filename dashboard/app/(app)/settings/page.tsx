'use client';

import * as React from 'react';
import { Settings } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { getProfile } from '@/lib/auth';
import type { UserProfile } from '@/lib/types';
import { ProfileSection } from '@/components/settings/ProfileSection';
import { TwoFactorSection } from '@/components/settings/TwoFactorSection';
import { ExportDataSection } from '@/components/settings/ExportDataSection';
import { DangerZoneSection } from '@/components/settings/DangerZoneSection';

/**
 * Página de configuración de cuenta (`/settings`, dentro del route group
 * `(app)` para heredar el layout autenticado con sidebar/header — misma URL
 * pública que design.md especifica para `dashboard/app/settings/`, sin
 * duplicar el shell de la app).
 *
 * `GET /account/profile` se pide UNA sola vez acá (el padre) y se distribuye
 * como prop a los hijos que lo necesitan (`ProfileSection`, `TwoFactorSection`
 * para leer `totp_enabled`) — antes cada hijo hacía su propio fetch, dos GET
 * redundantes al montar la página. `totp_enabled` (fix puntual post-Phase 4,
 * ver src/models/user.py `UserProfile`) viaja en este mismo `UserProfile`, ya
 * no se lee de `GET /account/export` (ese endpoint sigue existiendo solo para
 * el botón real de "Exportar mis datos" en `ExportDataSection`, no se toca
 * acá).
 */
export default function SettingsPage() {
  const t = useTranslations('settings');
  const [profile, setProfile] = React.useState<UserProfile | null>(null);
  const [loadingProfile, setLoadingProfile] = React.useState(true);
  // Se guarda el HECHO de la falla, no el mensaje: el texto se resuelve al
  // render para que un cambio de idioma en caliente lo re-traduzca.
  const [profileFailed, setProfileFailed] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;

    getProfile()
      .then((data) => {
        if (!cancelled) setProfile(data);
      })
      .catch(() => {
        if (!cancelled) setProfileFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoadingProfile(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-8">
      <div className="flex items-center gap-3">
        <Settings className="h-8 w-8 text-seismic-600" />
        <h1 className="text-2xl font-bold text-foreground">{t('pageTitle')}</h1>
      </div>

      <ProfileSection
        profile={profile}
        loading={loadingProfile}
        error={profileFailed ? t('profileLoadError') : null}
        onProfileUpdate={setProfile}
      />

      {!loadingProfile && profile && (
        <TwoFactorSection
          totpEnabled={Boolean(profile.totp_enabled)}
          onTotpEnabledChange={(enabled) =>
            setProfile((prev) => (prev ? { ...prev, totp_enabled: enabled } : prev))
          }
        />
      )}

      <ExportDataSection />

      <DangerZoneSection />
    </div>
  );
}
