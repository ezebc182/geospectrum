import type { formats } from './i18n/request';
import type es from './messages/es.json';

/**
 * Augmentation de next-intl v4 (design, Decision 4): ES es la fuente del
 * tipo — una clave inexistente pasada a t() falla en compile-time. La
 * paridad de contenido con EN la garantiza messages/parity.test.ts.
 */
declare module 'next-intl' {
  interface AppConfig {
    Messages: typeof es;
    Formats: typeof formats;
  }
}
