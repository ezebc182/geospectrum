// @vitest-environment node
/**
 * Tests del template de email de invitación (pulido post-rollout: monolingüe).
 *
 * Se renderiza con `render()` de `@react-email/components` (el mismo camino
 * que usa el SDK de Resend vía la prop `react:`) y se asserta sobre el HTML
 * final — lo que efectivamente le llega al destinatario. El template es
 * MONOLINGÜE según la prop `locale` (el admin elige el idioma al invitar):
 * con 'en' no debe aparecer NADA de español y viceversa, y el rol ya no va
 * en el cuerpo (decisión del usuario: información innecesaria).
 */

import { render } from '@react-email/components';
import { describe, expect, it } from 'vitest';

import { InvitationEmail } from './InvitationEmail';

const PROPS = {
  email: 'invitada@example.com',
  // 12:00 UTC = 09:00 en Buenos Aires → mismo día calendario en ambos locales
  expiresAt: '2026-08-17T12:00:00Z',
  inviteUrl: 'https://geospectrum.org/invite/tok_ABC123xyz-_',
};

async function renderHtml(
  overrides: Partial<typeof PROPS> & { locale?: 'es' | 'en' } = {},
): Promise<string> {
  return render(<InvitationEmail {...PROPS} {...overrides} />);
}

describe('InvitationEmail', () => {
  it('el cuerpo incluye el inviteUrl EXACTO (CTA + fallback)', async () => {
    const html = await renderHtml();

    // 2 apariciones: botón y fallback. Si un refactor del template rompe el
    // link en cualquiera de los dos lugares, el invitado pierde el único
    // camino de alta.
    const occurrences = html.split(PROPS.inviteUrl).length - 1;
    expect(occurrences).toBe(2);
  });

  it("sin locale renderiza en español (default 'es')", async () => {
    const html = await renderHtml();

    expect(html).toContain('Te invitaron a GeoSpectrum');
    expect(html).toContain('Aceptar invitación');
  });

  it("con locale 'es' NO aparece texto en inglés", async () => {
    const html = await renderHtml({ locale: 'es' });

    expect(html).toContain('Te invitaron a GeoSpectrum');
    expect(html).toContain('Aceptar invitación');
    expect(html).toContain('17/08/2026');
    // Nada del copy inglés — ni cuerpo, ni CTA, ni pie del layout.
    expect(html).not.toContain('been invited to GeoSpectrum');
    expect(html).not.toContain('Accept invitation');
    expect(html).not.toContain('automated email');
    expect(html).not.toContain('Aug 17, 2026');
  });

  it("con locale 'en' NO aparece texto en español", async () => {
    const html = await renderHtml({ locale: 'en' });

    expect(html).toContain('been invited to GeoSpectrum');
    expect(html).toContain('Accept invitation');
    expect(html).toContain('Aug 17, 2026');
    // Nada del copy español — ni cuerpo, ni CTA, ni pie del layout.
    expect(html).not.toContain('Te invitaron a GeoSpectrum');
    expect(html).not.toContain('Aceptar invitación');
    expect(html).not.toContain('email automático');
    expect(html).not.toContain('17/08/2026');
  });

  it('el rol NO aparece en el HTML (decisión del usuario: dato innecesario)', async () => {
    for (const locale of ['es', 'en'] as const) {
      const html = await renderHtml({ locale });

      for (const label of [
        'Superadministrador',
        'Administrador',
        'Moderador',
        'Visualizador',
        'Superadmin',
        'Admin',
        'Moderator',
        'Viewer',
      ]) {
        expect(html).not.toContain(label);
      }
    }
  });

  it('incluye el email invitado (la invitación está atada a ese email)', async () => {
    const html = await renderHtml();

    expect(html).toContain('invitada@example.com');
  });

  it('una fecha no parseable cae al string crudo sin romper el render', async () => {
    const html = await renderHtml({ expiresAt: 'no-es-una-fecha' });

    expect(html).toContain('no-es-una-fecha');
  });
});
