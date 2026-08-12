'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';

/**
 * Error del borrado: se guarda el HECHO de la falla (y el mensaje del
 * backend si vino), no el texto resuelto — el fallback se traduce al render
 * para que un cambio de idioma en caliente lo re-traduzca.
 */
type DeleteError = { message?: string };

/**
 * Sección "Zona de riesgo" de /settings. El borrado es hard-delete e
 * irreversible (ver proposal.md Risk "Hard-delete irreversible") — la
 * mitigación de UX es requerir que el usuario escriba la palabra de
 * confirmación (ELIMINAR / DELETE, según el idioma activo, del diccionario:
 * la constante de módulo se mudó a t() por Decision 5) antes de habilitar
 * el botón final. La comparación es case-insensitive contra la palabra del
 * idioma ACTIVO — si el usuario cambia de idioma con el dialog abierto, la
 * palabra pedida en pantalla y la exigida son siempre la misma.
 */
export function DangerZoneSection() {
  const t = useTranslations('settings.danger');
  const router = useRouter();
  const { deleteAccount } = useAuth();
  const [confirmText, setConfirmText] = React.useState('');
  const [deleting, setDeleting] = React.useState(false);
  const [error, setError] = React.useState<DeleteError | null>(null);
  const [open, setOpen] = React.useState(false);

  const confirmWord = t('confirmWord');
  const canConfirm = confirmText.trim().toUpperCase() === confirmWord.toUpperCase();

  async function handleDelete() {
    setError(null);
    setDeleting(true);
    try {
      await deleteAccount();
      router.push('/login');
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : undefined });
      setDeleting(false);
    }
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setConfirmText('');
      setError(null);
    }
  }

  return (
    <Card className="ring-destructive/30">
      <CardHeader>
        <CardTitle className="text-destructive">{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <AlertDialog open={open} onOpenChange={handleOpenChange}>
          <AlertDialogTrigger asChild>
            <Button type="button" variant="destructive">
              <Trash2 />
              {t('deleteButton')}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('dialogTitle')}</AlertDialogTitle>
              <AlertDialogDescription>
                {t.rich('dialogDescription', {
                  word: confirmWord,
                  strong: (chunks) => <strong>{chunks}</strong>,
                })}
              </AlertDialogDescription>
            </AlertDialogHeader>

            <div className="flex flex-col gap-1.5 px-4">
              <Input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={confirmWord}
                disabled={deleting}
                autoFocus
              />
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error.message ?? t('deleteError')}
                </p>
              )}
            </div>

            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleting}>{t('cancel')}</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={!canConfirm || deleting}
                onClick={(event) => {
                  event.preventDefault();
                  void handleDelete();
                }}
              >
                {deleting ? t('deleting') : t('confirmDelete')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}
