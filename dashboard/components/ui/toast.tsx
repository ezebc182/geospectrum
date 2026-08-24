'use client';

/**
 * Sistema de notificaciones de la app, sobre @radix-ui/react-toast.
 *
 * Radix ya venía en node_modules como dependencia del paquete umbrella
 * `radix-ui` — no se instaló nada nuevo. Se eligió sobre un componente
 * propio porque resuelve de fábrica lo que es fácil hacer mal a mano: el
 * `aria-live` correcto por variante, el manejo del foco, el swipe para
 * descartar y la pausa del temporizador al pasar el mouse.
 *
 * USO:
 *   const { notify } = useToast();
 *   notify('success', 'charts.spectrogramsPage.wall.saved');
 *   notify('error', 'admin.waitlist.approveError', { email });
 *
 * El segundo argumento es la CLAVE i18n, nunca el texto — ver toast-queue.ts.
 */

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import * as ToastPrimitive from '@radix-ui/react-toast';
import { useTranslations } from 'next-intl';
import { AlertCircle, CheckCircle2, Info, TriangleAlert } from 'lucide-react';

import { cn } from '@/lib/utils';
import {
  TOAST_DURATION_MS,
  addToast,
  dismissToast,
  type Toast,
  type ToastMessageKey,
  type ToastVariant,
} from '@/lib/toast-queue';

interface ToastContextValue {
  notify: (
    variant: ToastVariant,
    messageKey: ToastMessageKey,
    values?: Record<string, string | number>,
  ) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (ctx === null) {
    throw new Error('useToast necesita <ToastProvider> arriba en el árbol');
  }
  return ctx;
}

const VARIANT_STYLES: Record<ToastVariant, string> = {
  success: 'border-success/40 bg-success/10 text-success',
  error: 'border-destructive/40 bg-destructive/10 text-destructive',
  warning: 'border-warning/40 bg-warning/10 text-warning',
  info: 'border-border bg-muted text-foreground',
};

const VARIANT_ICONS: Record<ToastVariant, typeof CheckCircle2> = {
  success: CheckCircle2,
  error: AlertCircle,
  warning: TriangleAlert,
  info: Info,
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  // Contador en vez de Date.now()/random: dos toasts disparados en el mismo
  // milisegundo compartirían id y React reusaría el nodo del anterior.
  const nextId = useRef(0);

  const notify = useCallback<ToastContextValue['notify']>((variant, messageKey, values) => {
    nextId.current += 1;
    setToasts((cola) =>
      addToast(cola, { id: String(nextId.current), variant, messageKey, values }),
    );
  }, []);

  // `notify` es estable (useCallback sin deps), así que el value del contexto
  // también debe serlo: si no, cada render del provider re-renderiza TODA la
  // app que consume el hook.
  const value = useMemo(() => ({ notify }), [notify]);

  return (
    <ToastContext.Provider value={value}>
      <ToastPrimitive.Provider swipeDirection="right">
        {children}
        {toasts.map((toast) => (
          <ToastItem
            key={toast.id}
            toast={toast}
            onDismiss={() => setToasts((cola) => dismissToast(cola, toast.id))}
          />
        ))}
        <ToastPrimitive.Viewport className="fixed bottom-0 right-0 z-[100] flex w-full max-w-sm flex-col gap-2 p-4 outline-none" />
      </ToastPrimitive.Provider>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  // El diccionario COMPLETO: las claves vienen de cualquier namespace
  // (charts.spectrogramsPage.wall.saved, profile.saved, admin.users.roleError...).
  const t = useTranslations();
  const Icon = VARIANT_ICONS[toast.variant];

  return (
    <ToastPrimitive.Root
      duration={TOAST_DURATION_MS[toast.variant]}
      onOpenChange={(open) => {
        if (!open) onDismiss();
      }}
      // Un error interrumpe; un "guardado" no debe cortar lo que el lector
      // esté leyendo. Radix mapea esto a aria-live assertive/polite.
      type={toast.variant === 'error' ? 'foreground' : 'background'}
      className={cn(
        'flex items-start gap-2 rounded-lg border p-3 text-sm shadow-lg backdrop-blur',
        'data-[state=open]:animate-in data-[state=open]:slide-in-from-right-full',
        'data-[state=closed]:animate-out data-[state=closed]:fade-out',
        VARIANT_STYLES[toast.variant],
      )}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <ToastPrimitive.Description className="min-w-0 flex-1">
        {t(toast.messageKey, toast.values)}
      </ToastPrimitive.Description>
    </ToastPrimitive.Root>
  );
}
