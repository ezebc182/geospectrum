'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Trash2 } from 'lucide-react';

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

const CONFIRM_WORD = 'ELIMINAR';

/**
 * Sección "Zona de riesgo" de /settings. El borrado es hard-delete e
 * irreversible (ver proposal.md Risk "Hard-delete irreversible") — la
 * mitigación de UX es requerir que el usuario escriba "ELIMINAR" antes de
 * habilitar el botón de confirmación final.
 */
export function DangerZoneSection() {
  const router = useRouter();
  const { deleteAccount } = useAuth();
  const [confirmText, setConfirmText] = React.useState('');
  const [deleting, setDeleting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [open, setOpen] = React.useState(false);

  const canConfirm = confirmText.trim().toUpperCase() === CONFIRM_WORD;

  async function handleDelete() {
    setError(null);
    setDeleting(true);
    try {
      await deleteAccount();
      router.push('/login');
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'No se pudo eliminar la cuenta. Intentá de nuevo.'
      );
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
        <CardTitle className="text-destructive">Zona de riesgo</CardTitle>
        <CardDescription>
          Eliminar tu cuenta borra tus datos de forma permanente. Esta acción no se
          puede deshacer.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <AlertDialog open={open} onOpenChange={handleOpenChange}>
          <AlertDialogTrigger asChild>
            <Button type="button" variant="destructive">
              <Trash2 />
              Eliminar mi cuenta
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>¿Eliminar tu cuenta definitivamente?</AlertDialogTitle>
              <AlertDialogDescription>
                Esta acción borra tu cuenta y todos tus datos de forma permanente. No
                hay vuelta atrás. Escribí <strong>{CONFIRM_WORD}</strong> para
                confirmar.
              </AlertDialogDescription>
            </AlertDialogHeader>

            <div className="flex flex-col gap-1.5 px-4">
              <Input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={CONFIRM_WORD}
                disabled={deleting}
                autoFocus
              />
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
            </div>

            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleting}>Cancelar</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={!canConfirm || deleting}
                onClick={(event) => {
                  event.preventDefault();
                  void handleDelete();
                }}
              >
                {deleting ? 'Eliminando…' : 'Eliminar mi cuenta'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}
