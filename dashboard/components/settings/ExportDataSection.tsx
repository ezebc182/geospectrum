'use client';

import * as React from 'react';
import { Download } from 'lucide-react';

import { exportData } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Sección "Exportar datos" de /settings. `GET /account/export` ya garantiza
 * (backend) que nunca incluye `password_hash`/`totp_secret`/backup codes —
 * este componente solo dispara la descarga del JSON como archivo.
 */
export function ExportDataSection() {
  const [downloading, setDownloading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function handleExport() {
    setError(null);
    setDownloading(true);
    try {
      const data = await exportData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `geospectrum-datos-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch {
      setError('No se pudieron exportar los datos. Intentá de nuevo.');
    } finally {
      setDownloading(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Exportar mis datos</CardTitle>
        <CardDescription>
          Descargá una copia de tus datos de cuenta en formato JSON.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
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
          {downloading ? 'Exportando…' : 'Descargar mis datos'}
        </Button>
      </CardContent>
    </Card>
  );
}
