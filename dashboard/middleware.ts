import { NextResponse, type NextRequest } from 'next/server';
import { jwtVerify } from 'jose';

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
 * `jose` (no `python-jose` ni `jsonwebtoken`) porque es la librería
 * edge-compatible estándar para verificar JWT en Next.js Middleware — no
 * depende de APIs de Node (`crypto` de Node no está disponible en el
 * Edge runtime), usa Web Crypto. Firma el mismo HS256 que el backend
 * (ver src/services/auth_service.py, JWT_ALGORITHM).
 *
 * AUTH_SECRET_KEY debe ser EXACTAMENTE el mismo valor que
 * settings.auth_secret_key en el backend (src/config/settings.py) — si no
 * coinciden, todo token válido emitido por la API es rechazado acá. Se lee
 * como variable de entorno server-side (sin prefijo NEXT_PUBLIC_ — nunca
 * debe llegar al bundle del cliente), documentada en dashboard/.env.local
 * y dashboard/README.md.
 */

const SESSION_COOKIE_NAME = 'session';
const LOGIN_PATH = '/login';

// Rutas que deben seguir siendo accesibles sin sesión. /login en sí mismo
// (evita loop de redirección) y /landing, la página pública de marketing —
// todo lo demás bajo app/ consume datos vía la API pública pero la
// UI del dashboard en sí requiere sesión (ver design.md: distinto de la
// decisión de dejar /report, /events, /alerts públicos en el backend).
const LANDING_PATH = '/landing';
const PUBLIC_PATHS = [LOGIN_PATH, LANDING_PATH];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

async function hasValidSession(request: NextRequest): Promise<boolean> {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return false;

  const secret = process.env.AUTH_SECRET_KEY;
  if (!secret) {
    // Configuración de servidor faltante, no una condición de sesión
    // inválida del cliente — mismo criterio que el fail-fast del backend
    // (src/main.py lifespan(): AUTH_SECRET_KEY ausente es un error de
    // arranque, no un 401). Acá no podemos abortar el proceso Next.js,
    // así que se trata como "sin sesión válida" y se loguea para que no
    // pase desapercibido en desarrollo.
    console.error(
      '[middleware] AUTH_SECRET_KEY no está configurada — todas las rutas protegidas van a redirigir a /login hasta que se configure.'
    );
    return false;
  }

  try {
    await jwtVerify(token, new TextEncoder().encode(secret), { algorithms: ['HS256'] });
    return true;
  } catch {
    // Firma inválida o token expirado: mismo resultado que el backend
    // (401 en /auth/me) — acá simplemente no hay sesión válida.
    return false;
  }
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
  matcher: ['/((?!_next/static|_next/image|favicon.ico|textures|geo).*)'],
};
