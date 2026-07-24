'use client';

import * as React from 'react';

import { updateProfile } from '@/lib/auth';
import type { UserProfile } from '@/lib/types';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Sección "Perfil" de /settings. Edita `full_name`/`address`/`phone` — todos
 * opcionales — vía `PATCH /account/profile`.
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
  const { user } = useAuth();
  const [fullName, setFullName] = React.useState('');
  const [address, setAddress] = React.useState('');
  const [phone, setPhone] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);

  React.useEffect(() => {
    if (!profile) return;
    setFullName(profile.full_name ?? '');
    setAddress(profile.address ?? '');
    setPhone(profile.phone ?? '');
  }, [profile]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
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
      setError('No se pudo guardar el perfil. Intentá de nuevo.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Perfil</CardTitle>
        <CardDescription>
          Datos personales opcionales. Ninguno es obligatorio para usar la plataforma.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {user?.name && (
          <p className="mb-4 text-xs text-muted-foreground">
            Nombre de tu cuenta de Google (solo lectura, gestionado por Google):{' '}
            <span className="font-medium text-foreground">{user.name}</span>
          </p>
        )}

        {loading ? (
          <p className="text-sm text-muted-foreground">Cargando perfil…</p>
        ) : loadError && !profile ? (
          <p role="alert" className="text-sm text-destructive">
            {loadError}
          </p>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="full_name" className="text-sm font-medium text-foreground">
                Nombre completo
              </label>
              <Input
                id="full_name"
                name="full_name"
                type="text"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                disabled={saving}
                placeholder="Tu nombre completo"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="address" className="text-sm font-medium text-foreground">
                Domicilio
              </label>
              <Input
                id="address"
                name="address"
                type="text"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                disabled={saving}
                placeholder="Av. Siempre Viva 742"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="phone" className="text-sm font-medium text-foreground">
                Teléfono
              </label>
              <Input
                id="phone"
                name="phone"
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                disabled={saving}
                placeholder="+54 9 11 5555-5555"
              />
            </div>

            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            {saved && !error && (
              <p className="text-sm text-emerald-600 dark:text-emerald-400">
                Perfil actualizado.
              </p>
            )}

            <Button type="submit" disabled={saving || !profile} className="self-start">
              {saving ? 'Guardando…' : 'Guardar cambios'}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
