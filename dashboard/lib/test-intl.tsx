/**
 * Config de next-intl para tests, derivada de la config REAL de la app.
 *
 * Por qué existe: cada test montaba `<NextIntlClientProvider>` a mano y le
 * pasaba `timeZone="UTC"` para callar el warning ENVIRONMENT_FALLBACK. Ese
 * parche escondió un bug real durante todo el PR-W3: la app NO tenía
 * `timeZone` global, así que `format.dateTime(d, {opciones inline})`
 * renderizaba en la zona del navegador mientras el test — con su timeZone
 * regalado — pasaba en verde. El andamio probaba una app que no existía.
 *
 * La regla: el harness NO inventa config. Importa `formats` de
 * `i18n/request.ts` y usa la MISMA `APP_TIME_ZONE`, así un test solo pasa
 * si producción está bien configurada.
 */
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';

import { APP_TIME_ZONE, formats } from '@/i18n/request';
import es from '@/messages/es.json';
import { ToastProvider } from '@/components/ui/toast';

/**
 * La zona de la app, re-exportada desde `i18n/request.ts` — NO declarada acá.
 * Una constante paralela dejaría los tests en verde aunque producción
 * perdiera su timeZone, que es el falso verde que este helper viene a matar.
 */
export { APP_TIME_ZONE };

type Props = {
  children: ReactNode;
  locale?: string;
  messages?: Record<string, unknown>;
};

/**
 * Provider con la config de producción. Preferilo a montar
 * `<NextIntlClientProvider>` suelto: pasar `timeZone` a mano en un test es
 * exactamente el error que este helper viene a impedir.
 */
export function IntlTestProvider({ children, locale = 'es-AR', messages = es }: Props) {
  return (
    <NextIntlClientProvider
      locale={locale}
      messages={messages}
      formats={formats}
      timeZone={APP_TIME_ZONE}
    >
      {/* Igual que en app/layout.tsx: el ToastProvider vive DENTRO del de
          i18n porque el toast guarda claves y las traduce al renderizar.
          Montarlo acá replica el árbol real — un componente que notifica
          debe poder testearse sin que cada test arme el andamio. */}
      <ToastProvider>{children}</ToastProvider>
    </NextIntlClientProvider>
  );
}
