'use client';

import * as React from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { ShieldCheck, ShieldOff } from 'lucide-react';

import { disableTotp, setupTotp, verifyTotpSetup } from '@/lib/auth';
import type { TotpSetupResponse } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

type Step = 'idle' | 'scanning' | 'backup-codes';

/**
 * Sección "2FA" de /settings. El backend solo entrega `otpauth_uri` (texto),
 * el QR se renderiza 100% client-side con `qrcode.react` a partir de ese URI
 * (ver design.md Decision 7 — el backend no genera imagen). Los backup codes
 * se muestran UNA sola vez, inmediatamente después de verificar el setup
 * (ver spec.md Requirement: Backup codes expuestos una única vez).
 */
export function TwoFactorSection({
  totpEnabled,
  onTotpEnabledChange,
}: {
  totpEnabled: boolean;
  onTotpEnabledChange: (enabled: boolean) => void;
}) {
  const [step, setStep] = React.useState<Step>('idle');
  const [setupData, setSetupData] = React.useState<TotpSetupResponse | null>(null);
  const [code, setCode] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  async function handleStartSetup() {
    setError(null);
    setSubmitting(true);
    try {
      const data = await setupTotp();
      setSetupData(data);
      setStep('scanning');
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'No se pudo iniciar el setup de 2FA.'
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function handleVerify(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await verifyTotpSetup(code);
      setStep('backup-codes');
      setCode('');
      onTotpEnabledChange(true);
    } catch {
      setError('Código inválido. Verificá la hora de tu dispositivo e intentá de nuevo.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDisable() {
    setError(null);
    setSubmitting(true);
    try {
      await disableTotp();
      onTotpEnabledChange(false);
      setStep('idle');
      setSetupData(null);
    } catch {
      setError('No se pudo deshabilitar 2FA. Intentá de nuevo.');
    } finally {
      setSubmitting(false);
    }
  }

  function handleFinish() {
    setStep('idle');
    setSetupData(null);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Autenticación en dos pasos (2FA)</CardTitle>
        <CardDescription>
          Agregá una capa extra de seguridad con una app de autenticación (Google
          Authenticator, Authy, etc.).
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        {step === 'idle' && totpEnabled && (
          <div className="flex flex-col gap-3">
            <p className="flex items-center gap-2 text-sm text-foreground">
              <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              2FA está activado en tu cuenta.
            </p>
            <Button
              type="button"
              variant="destructive"
              onClick={handleDisable}
              disabled={submitting}
              className="self-start"
            >
              <ShieldOff />
              {submitting ? 'Desactivando…' : 'Desactivar 2FA'}
            </Button>
          </div>
        )}

        {step === 'idle' && !totpEnabled && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              2FA no está activado en tu cuenta. Solo disponible para cuentas con
              contraseña propia (no cuentas 100% Google).
            </p>
            <Button
              type="button"
              onClick={handleStartSetup}
              disabled={submitting}
              className="self-start"
            >
              {submitting ? 'Iniciando…' : 'Activar 2FA'}
            </Button>
          </div>
        )}

        {step === 'scanning' && setupData && (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-foreground">
              Escaneá este código QR con tu app de autenticación:
            </p>
            <div className="flex justify-center rounded-lg bg-white p-4">
              <QRCodeSVG value={setupData.otpauth_uri} size={200} />
            </div>
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer select-none">
                ¿No podés escanear el QR?
              </summary>
              <p className="mt-1 break-all font-mono">{setupData.otpauth_uri}</p>
            </details>

            <form onSubmit={handleVerify} className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="totp-setup-code" className="text-sm font-medium text-foreground">
                  Código de verificación
                </label>
                <Input
                  id="totp-setup-code"
                  name="code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  required
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  disabled={submitting}
                  placeholder="123456"
                />
              </div>
              <div className="flex gap-2">
                <Button type="submit" disabled={submitting}>
                  {submitting ? 'Verificando…' : 'Verificar y activar'}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={handleFinish}
                  disabled={submitting}
                >
                  Cancelar
                </Button>
              </div>
            </form>
          </div>
        )}

        {step === 'backup-codes' && setupData && (
          <div className="flex flex-col gap-4">
            <p className="flex items-center gap-2 text-sm font-medium text-foreground">
              <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              2FA activado exitosamente.
            </p>
            <p className="text-sm text-destructive">
              Guardá estos backup codes ahora: no se van a volver a mostrar. Cada uno
              solo se puede usar una vez, como alternativa al código de tu app si la
              perdés.
            </p>
            <ul className="grid grid-cols-2 gap-2 rounded-lg bg-muted p-4 font-mono text-sm">
              {setupData.backup_codes.map((backupCode) => (
                <li key={backupCode}>{backupCode}</li>
              ))}
            </ul>
            <Button type="button" onClick={handleFinish} className="self-start">
              Ya los guardé
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
