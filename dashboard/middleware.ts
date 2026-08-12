import { NextResponse, type NextRequest } from 'next/server';

import { SESSION_COOKIE_NAME, verifySession } from '@/lib/verify-session';

/**
 * Guard de rutas protegidas — Next.js Middleware (Edge), no wrapper
 * client-side.
 *
 * Por qué middleware.ts y no un wrapper condicional en layout.tsx (decisión
 * ya tomada, ver openspec/changes/multi-user-auth/design.md Decision 1 y
 * tasks.md 4.7): la cookie de sesión es httpOnly a propósito (mitiga robo
 * de token vía XSS), así que un guard client-side NUNCA puede leerla
 * directamente — tendría que esperar a un round-trip a getMe() antes de
 * saber si redirigir, produciendo un flash-of-unauthenticated-content (el
 * layout protegido se renderiza primero, y recién después de que getMe()
 * resuelve se decide redirigir a /login). El middleware corre en el Edge,
 * ANTES de que se arme cualquier respuesta, y sí puede leer
 * `request.cookies` de forma síncrona — permite redirigir sin renderizar
 * un solo frame de contenido protegido.
 *
 * La verificación del JWT en sí vive en `lib/verify-session.ts`, compartida
 * con las API routes de Next (`app/api/invitations/send/route.ts` necesita
 * la MISMA verificación más el claim `role`). Ahí se documentan `jose`,
 * HS256 y `AUTH_SECRET_KEY`.
 */

const LOGIN_PATH = '/login';

// Rutas que deben seguir siendo accesibles sin sesión. /login en sí mismo
// (evita loop de redirección), /landing (la página pública de marketing) e
// /invite (la página de aceptación de invitaciones: por definición la abre
// alguien que TODAVÍA no tiene cuenta — redirigirla a /login haría el link
// del email inservible). El match por prefijo de `isPublicPath()` cubre
// /invite/{token}. Todo lo demás bajo app/ consume datos vía la API pública
// pero la UI del dashboard en sí requiere sesión (ver design.md: distinto
// de la decisión de dejar /report, /events, /alerts públicos en el backend).
const LANDING_PATH = '/landing';
const INVITE_PATH = '/invite';
const PUBLIC_PATHS = [LOGIN_PATH, LANDING_PATH, INVITE_PATH];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

async function hasValidSession(request: NextRequest): Promise<boolean> {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  // El middleware solo necesita el sí/no; el payload (rol incluido) lo usa
  // la API route de envío de invitaciones.
  return (await verifySession(token)) !== null;
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  if (await hasValidSession(request)) {
    return NextResponse.next();
  }

  // La raíz sin sesión muestra la landing pública vía rewrite (la URL del
  // navegador queda en `/`): un visitante anónimo ve el producto, no un
  // formulario de login. Con sesión, `/` sigue siendo el dashboard — por eso
  // esto va DESPUÉS del chequeo de sesión.
  if (pathname === '/') {
    return NextResponse.rewrite(new URL(LANDING_PATH, request.url));
  }

  const loginUrl = new URL(LOGIN_PATH, request.url);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  // Excluye assets estáticos y de Next.js internos del guard — no tiene
  // sentido (ni es seguro en términos de performance) correr jwtVerify en
  // cada request de _next/static, favicon, etc. `textures` y `geo` son los
  // assets de /public que consume el globo 3D: sin excluirlos, un visitante
  // anónimo en la landing recibiría un redirect a /login en vez de la
  // textura de la Tierra y el globo se vería negro.
  //
  // `api` también queda fuera: las routes de /api son contratos JSON que
  // manejan su propia autenticación con verifySession() y responden 401/403
  // (p. ej. /api/invitations/send). Un redirect 307 a la página HTML de
  // /login rompería a cualquier cliente fetch que espere esos códigos.
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|textures|geo).*)'],
};
