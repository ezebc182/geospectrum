// @vitest-environment node
/**
 * Tests del template de email de invitación (tarea 8.3 de email-invitations).
 *
 * Se renderiza con `render()` de `@react-email/components` (el mismo camino
 * que usa el SDK de Resend vía la prop `react:`) y se asserta sobre el HTML
 * final — lo que efectivamente le llega al destinatario. El template es
 * BILINGÜE ES/EN en un solo envío (nota de 5.3 en tasks.md): cada bloque
 * tiene su heading, su rol traducido, su CTA y su fecha con locale explícito.
 */

import { render } from '@react-email/components';
import { describe, expect, it } from 'vitest';

import { InvitationEmail } from './InvitationEmail';

const PROPS = {
  email: 'invitada@example.com',
  role: 'moderador',
  // 12:00 UTC = 09:00 en Buenos Aires → mismo día calendario en ambos locales
  expiresAt: '2026-08-17T12:00:00Z',
  inviteUrl: 'https://geospectrum.org/invite/tok_ABC123xyz-_',
};

async function renderHtml(overrides: Partial<typeof PROPS> = {}): Promise<string> {
  return render(<InvitationEmail {...PROPS} {...overrides} />);
}

describe('InvitationEmail', () => {
  it('el cuerpo incluye el inviteUrl EXACTO (CTA + fallback, en ambos idiomas)', async () => {
    const html = await renderHtml();

    // 4 apariciones: botón ES, fallback ES, botón EN, fallback EN. Si un
    // refactor del template rompe el link en cualquiera de los cuatro
    // lugares, el invitado pierde el único camino de alta.
    const occurrences = html.split(PROPS.inviteUrl).length - 1;
    expect(occurrences).toBe(4);
  });

  it('muestra la fecha de expiración en ambos formatos de locale', async () => {
    const html = await renderHtml();

    // es-AR con campos numéricos explícitos (no dateStyle short, que
    // abreviaba el año a 17/8/26) y en-US medium.
    expect(html).toContain('17/08/2026');
    expect(html).toContain('Aug 17, 2026');
  });

  it('es bilingüe: heading, rol y CTA presentes en español y en inglés', async () => {
    const html = await renderHtml();

    expect(html).toContain('Te invitaron a GeoSpectrum');
    expect(html).toContain('been invited to GeoSpectrum');
    expect(html).toContain('Moderador');
    expect(html).toContain('Moderator');
    expect(html).toContain('Aceptar invitación');
    expect(html).toContain('Accept invitation');
  });

  it('incluye el email invitado (la invitación está atada a ese email)', async () => {
    const html = await renderHtml();

    expect(html).toContain('invitada@example.com');
  });

  it('un rol desconocido cae al valor crudo sin romper el render', async () => {
    const html = await renderHtml({ role: 'rol-nuevo' });

    expect(html).toContain('rol-nuevo');
  });

  it('una fecha no parseable cae al string crudo sin romper el render', async () => {
    const html = await renderHtml({ expiresAt: 'no-es-una-fecha' });

    expect(html).toContain('no-es-una-fecha');
  });
});
