/**
 * URLs de las plataformas de colaboración.
 *
 * PARA ACTIVAR UN BOTÓN: pegue la URL completa en la constante y listo.
 * Una entrada vacía NO se renderiza — así el proyecto puede mergearse sin
 * cuentas creadas todavía, sin exponer un link roto en producción. Ese es el
 * motivo de que el filtrado viva acá y no en el componente: el criterio de
 * "está configurado" es una propiedad del dato, no de cómo se pinta.
 *
 * Cómo obtener cada una:
 * - Cafecito:  https://cafecito.app  → alta con email → su URL es
 *              https://cafecito.app/<usuario>
 * - Ko-fi:     https://ko-fi.com     → alta inmediata, sin aprobación → su URL
 *              es https://ko-fi.com/<usuario>
 * - Sponsors:  https://github.com/sponsors → requiere aprobación de GitHub y
 *              cuenta de cobro → su URL es https://github.com/sponsors/<usuario>
 */

/** Una plataforma de colaboración con su clave de i18n. */
export interface SupportLink {
  /** Clave dentro del ns `landing.support`: el id ES la clave, sin tabla de mapeo. */
  readonly id: 'cafecito' | 'kofi' | 'sponsors';
  /** URL completa. Vacía = todavía no configurada = no se muestra. */
  readonly url: string;
}

/**
 * Orden de declaración = orden de renderizado. Cafecito primero porque el
 * público inicial es de Argentina y paga en pesos; los otros dos cubren el
 * resto del mundo.
 */
const SUPPORT_LINKS: readonly SupportLink[] = [
  { id: 'cafecito', url: 'https://cafecito.app/ezebc182' },
  { id: 'kofi', url: 'https://ko-fi.com/B8D026Y7L1' },
  { id: 'sponsors', url: '' }, // TODO: https://github.com/sponsors/<usuario>
] as const;

/**
 * Las plataformas efectivamente configuradas, en orden de declaración.
 *
 * Se descarta la URL en blanco Y la que quedó con el placeholder `<usuario>`
 * a medio pegar: las dos llevarían al visitante a un 404, que es peor que no
 * ofrecer el botón.
 */
export function configuredSupportLinks(): readonly SupportLink[] {
  return SUPPORT_LINKS.filter(
    (link) => link.url.trim() !== '' && !link.url.includes('<usuario>'),
  );
}
