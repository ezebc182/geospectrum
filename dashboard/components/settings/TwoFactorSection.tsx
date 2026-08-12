'use client';

import * as React from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { ShieldCheck, ShieldOff } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { disableTotp, setupTotp, verifyTotpSetup } from '@/lib/auth';
import type { TotpSetupResponse } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

type Step = 'idle' | 'scanning' | 'backup-codes';

/**
 * Error del flujo 2FA: se guarda la CLAVE del mensaje (no el texto resuelto)
 * para que un cambio de idioma en caliente re-traduzca un error visible;
 * `message` (si viene del backend en el setup) tiene prioridad y se muestra
 * tal cual — los `detail` del backend están fuera del alcance de i18n.
 */
type TwoFactorError = {
  key: 'setupError' | 'invalidCode' | 'disableError';
  message?: string;
};

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
  const t = useTranslations('settings.twoFactor');
  const [step, setStep] = React.useState<Step>('idle');
  const [setupData, setSetupData] = React.useState<TotpSetupResponse | null>(null);
  const [code, setCode] = React.useState('');
  const [error, setError] = React.useState<TwoFactorError | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  async function handleStartSetup() {
    setError(null);
    setSubmitting(true);
    try {
      const data = await setupTotp();
      setSetupData(data);
      setStep('scanning');
    } catch (err) {
      setError({
        key: 'setupError',
        message: err instanceof Error ? err.message : undefined,
      });
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
      setError({ key: 'invalidCode' });
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
      setError({ key: 'disableError' });
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
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error.message ?? t(error.key)}
          </p>
        )}

        {step === 'idle' && totpEnabled && (
          <div className="flex flex-col gap-3">
            <p className="flex items-center gap-2 text-sm text-foreground">
              <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              {t('enabled')}
            </p>
            <Button
              type="button"
              variant="destructive"
              onClick={handleDisable}
              disabled={submitting}
              className="self-start"
            >
              <ShieldOff />
              {submitting ? t('disabling') : t('disable')}
            </Button>
          </div>
        )}

        {step === 'idle' && !totpEnabled && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">{t('notEnabled')}</p>
            <Button
              type="button"
              onClick={handleStartSetup}
              disabled={submitting}
              className="self-start"
            >
              {submitting ? t('starting') : t('enable')}
            </Button>
          </div>
        )}

        {step === 'scanning' && setupData && (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-foreground">{t('scanQr')}</p>
            <div className="flex justify-center rounded-lg bg-white p-4">
              <QRCodeSVG value={setupData.otpauth_uri} size={200} />
            </div>
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer select-none">{t('cantScan')}</summary>
              <p className="mt-1 break-all font-mono">{setupData.otpauth_uri}</p>
            </details>

            <form onSubmit={handleVerify} className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="totp-setup-code" className="text-sm font-medium text-foreground">
                  {t('verificationCode')}
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
                  placeholder={t('codePlaceholder')}
                />
              </div>
              <div className="flex gap-2">
                <Button type="submit" disabled={submitting}>
                  {submitting ? t('verifying') : t('verifyAndEnable')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={handleFinish}
                  disabled={submitting}
                >
                  {t('cancel')}
                </Button>
              </div>
            </form>
          </div>
        )}

        {step === 'backup-codes' && setupData && (
          <div className="flex flex-col gap-4">
            <p className="flex items-center gap-2 text-sm font-medium text-foreground">
              <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              {t('enabledSuccess')}
            </p>
            <p className="text-sm text-destructive">{t('backupCodesWarning')}</p>
            <ul className="grid grid-cols-2 gap-2 rounded-lg bg-muted p-4 font-mono text-sm">
              {setupData.backup_codes.map((backupCode) => (
                <li key={backupCode}>{backupCode}</li>
              ))}
            </ul>
            <Button type="button" onClick={handleFinish} className="self-start">
              {t('savedThem')}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
