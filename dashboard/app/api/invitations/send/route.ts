/**
 * Envío del email de invitación (paso 2 del flujo de creación).
 *
 * El paso 1 lo hace la UI admin contra el backend (`POST /auth/invitations`),
 * que devuelve el token en claro UNA sola vez; esta route recibe ese token,
 * arma el link y dispara el email vía Resend (design.md Decision 4).
 *
 * `runtime = 'nodejs'` (no Edge): el SDK de Resend y el render de react-email
 * son server Node.
 *
 * SEGURIDAD — esta route es el único lugar del repo donde se instancia el SDK
 * de Resend. `RESEND_API_KEY` es env server-side SIN prefijo NEXT_PUBLIC_:
 * importar `resend` (o este archivo, o los templates de `emails/`) desde un
 * client component filtraría la key al bundle del navegador. Además, sin el
 * guard de sesión admin+ de abajo, la route sería un relay de spam abierto
 * con la cuenta de Resend de GeoSpectrum (riesgo explícito del proposal).
 */

import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { Resend } from 'resend';

import { InvitationEmail } from '@/emails/InvitationEmail';
import { SESSION_COOKIE_NAME, verifySession } from '@/lib/verify-session';

export const runtime = 'nodejs';

/** Roles habilitados a enviar invitaciones — misma regla que
 *  `require_min_role(UserRole.ADMIN)` del backend, que es el enforcement
 *  real; esto evita gastar una llamada a Resend en un caller sin permiso. */
const ALLOWED_ROLES = ['admin', 'superadmin'];

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

/** Remitente. El dominio geospectrum.org ya está verificado en Resend
 *  (SPF/DKIM); `RESEND_FROM` permite cambiarlo sin tocar código. */
const FROM_ADDRESS = process.env.RESEND_FROM || 'GeoSpectrum <invitaciones@geospectrum.org>';

interface SendRequestBody {
  invitationId?: unknown;
  email?: unknown;
  role?: unknown;
  token?: unknown;
  expiresAt?: unknown;
}

export async function POST(request: Request) {
  // ---------------------------------------------------------------------
  // 1. Sesión y rol — ANTES de tocar nada de Resend.
  //    El orden importa y es un criterio de aceptación: una request sin
  //    sesión (o de un viewer) NO debe producir ninguna llamada a la API de
  //    Resend, ni siquiera instanciar el cliente con la key.
  // ---------------------------------------------------------------------
  const cookieStore = await cookies();
  const session = await verifySession(cookieStore.get(SESSION_COOKIE_NAME)?.value);

  if (!session) {
    return NextResponse.json({ sent: false, error: 'no autenticado' }, { status: 401 });
  }
  if (!ALLOWED_ROLES.includes(session.role)) {
    return NextResponse.json({ sent: false, error: 'permisos insuficientes' }, { status: 403 });
  }

  // ---------------------------------------------------------------------
  // 2. Payload
  // ---------------------------------------------------------------------
  let body: SendRequestBody;
  try {
    body = (await request.json()) as SendRequestBody;
  } catch {
    return NextResponse.json({ sent: false, error: 'body inválido' }, { status: 400 });
  }

  const { invitationId, email, role, token, expiresAt } = body;
  if (
    typeof invitationId !== 'string' ||
    typeof email !== 'string' ||
    typeof role !== 'string' ||
    typeof token !== 'string' ||
    typeof expiresAt !== 'string'
  ) {
    return NextResponse.json({ sent: false, error: 'body incompleto' }, { status: 400 });
  }

  // El link se arma acá y no en el cliente: INVITE_BASE_URL es la URL
  // pública canónica (https://geospectrum.org en Vercel). En desarrollo cae
  // al origin del request, que es exactamente donde corre el dashboard.
  const baseUrl = process.env.INVITE_BASE_URL || new URL(request.url).origin;
  const inviteUrl = `${baseUrl}/invite/${token}`;

  // ---------------------------------------------------------------------
  // 3. Envío
  // ---------------------------------------------------------------------
  const resend = new Resend(process.env.RESEND_API_KEY);

  let resendError: unknown = null;
  try {
    const { error } = await resend.emails.send({
      from: FROM_ADDRESS,
      to: email,
      // Subject bilingüe, igual que el cuerpo del template: el destinatario
      // puede ser hispanohablante o angloparlante y no lo sabemos al invitar.
      subject: "Te invitaron a GeoSpectrum / You've been invited to GeoSpectrum",
      react: InvitationEmail({ email, role, inviteUrl, expiresAt }),
    });
    resendError = error;
  } catch (caught) {
    // Red caída o key ausente: el SDK lanza en vez de devolver `error`.
    resendError = caught;
  }

  if (resendError) {
    // El detalle crudo va al log del servidor; al admin le llega un mensaje
    // contenido. Filtrar la respuesta de Resend tal cual podría exponer
    // fragmentos de la key o del stack.
    console.error('[invitations/send] Resend rechazó el envío', resendError);
    return NextResponse.json(
      {
        sent: false,
        error:
          'No se pudo enviar el email de invitación. La invitación quedó creada: usá "reenviar" para reintentar.',
      },
      { status: 502 }
    );
  }

  // ---------------------------------------------------------------------
  // 4. Confirmación en el backend — BEST-EFFORT.
  //    El email YA salió: si mark-sent falla, la invitación simplemente
  //    queda con el badge "email sin confirmar" en la lista. Reportarle un
  //    error al admin acá sería mentirle (pensaría que el email no salió y
  //    reenviaría, invalidando el link que el invitado ya recibió).
  // ---------------------------------------------------------------------
  try {
    const markSentResponse = await fetch(
      `${API_BASE_URL}/auth/invitations/${invitationId}/mark-sent`,
      {
        method: 'POST',
        headers: { cookie: request.headers.get('cookie') ?? '' },
      }
    );
    if (!markSentResponse.ok) {
      console.error(
        `[invitations/send] mark-sent respondió ${markSentResponse.status} para ${invitationId} — el email ya se envió.`
      );
    }
  } catch (caught) {
    console.error('[invitations/send] mark-sent falló — el email ya se envió.', caught);
  }

  return NextResponse.json({ sent: true });
}
