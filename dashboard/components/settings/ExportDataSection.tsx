'use client';

import * as React from 'react';
import { Download } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { exportData } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Sección "Exportar datos" de /settings. `GET /account/export` ya garantiza
 * (backend) que nunca incluye `password_hash`/`totp_secret`/backup codes —
 * este componente solo dispara la descarga del JSON como archivo.
 */
export function ExportDataSection() {
  const t = useTranslations('settings.export');
  const [downloading, setDownloading] = React.useState(false);
  // Se guarda el HECHO de la falla, no el mensaje: el texto se resuelve al
  // render para que un cambio de idioma en caliente lo re-traduzca.
  const [failed, setFailed] = React.useState(false);

  async function handleExport() {
    setFailed(false);
    setDownloading(true);
    try {
      const data = await exportData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      // El nombre del archivo también es superficie user-facing: sale del
      // diccionario (geospectrum-datos-… / geospectrum-data-…).
      link.download = t('fileName', { date: new Date().toISOString().slice(0, 10) });
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch {
      setFailed(true);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {failed && (
          <p role="alert" className="text-sm text-destructive">
            {t('error')}
          </p>
        )}
        <Button
          type="button"
          variant="outline"
          onClick={handleExport}
          disabled={downloading}
          className="self-start"
        >
          <Download />
          {downloading ? t('exporting') : t('download')}
        </Button>
      </CardContent>
    </Card>
  );
}
