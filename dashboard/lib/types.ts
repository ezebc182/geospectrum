/**
 * Tipos TypeScript para la API de GeoSpectrum
 */

import type { AppLocale } from './locale';

export interface SeismicEvent {
  id: string;
  fuentes: string[];
  hora_utc: string;
  lat: number;
  lon: number;
  prof_km: number | null;
  mag: number;
  mag_tipo: string | null;
  lugar: string | null;
  sentido: boolean;
  revisado: boolean;
}

export interface KPIs {
  total_eventos: number;
  tasa_eventos_por_hora: number;
  magnitud_max: number | null;
  magnitud_promedio_ponderada_por_energia: number | null;
  profundidad_media_M_ge_4: number | null;
  eventos_sentidos: number;
  porcentaje_eventos_sentidos: number;
  minutos_desde_M_ge_5: number | null;
}

export interface Alert {
  tipo: 'enjambre' | 'evento_significativo' | 'actividad_sentida';
  descripcion: string;
  eventos_relacionados: string[];
}

export interface MonitorReport {
  timestamp_utc_generacion: string;
  region_monitorizada: {
    minlat: number;
    maxlat: number;
    minlon: number;
    maxlon: number;
  };
  data_source_errors: string[];
  kpis: KPIs;
  alertas: Alert[];
  eventos: SeismicEvent[];
}

export type AlertType = Alert['tipo'];

/**
 * Áreas de interés (AOI-1).
 *
 * `geometry` es GeoJSON crudo (Polygon o MultiPolygon) — el mapa lo dibuja tal
 * cual con L.geoJSON. `bbox` viaja además de la geometría porque es lo que usa
 * el mapa para encuadrar la vista sin recorrer todos los vértices. Mismo shape
 * que `MonitorReport.region_monitorizada`, a propósito: las dos cosas son "la
 * región que estoy mirando" y se consumen igual.
 */
export interface AreaBbox {
  minlat: number;
  maxlat: number;
  minlon: number;
  maxlon: number;
}

/**
 * GeoJSON mínimo, declarado a mano en vez de traer @types/geojson: es el mismo
 * criterio que ya usa lib/plate-boundaries.ts, y son dos tipos.
 *
 * Anillos de Polygon: [lon, lat][][]  — ojo el orden, GeoJSON va al revés de
 * como se nombran las coordenadas en el resto del proyecto.
 */
export interface AreaPolygon {
  type: 'Polygon';
  coordinates: [number, number][][];
}

export interface AreaMultiPolygon {
  type: 'MultiPolygon';
  coordinates: [number, number][][][];
}

export type AreaGeometry = AreaPolygon | AreaMultiPolygon;

export interface Area {
  id: string;
  slug: string;
  name: string;
  is_system: boolean;
  geometry: AreaGeometry;
  bbox: AreaBbox;
  created_at: string;
  updated_at: string;
}

/**
 * `is_default=true` significa que el usuario NO eligió nada y está viendo el
 * preset por defecto. El selector lo necesita para no marcar como seleccionada
 * un área que el usuario nunca eligió.
 */
export interface ActiveAreaResponse {
  area: Area;
  is_default: boolean;
}

/**
 * Roles de usuario, jerarquía estricta descendente (ver
 * openspec/changes/multi-user-auth/design.md, Decision 6). El backend
 * serializa `role` como este mismo string en /auth/register, /auth/login
 * y /auth/me — no hay traducción de shape entre API y frontend.
 */
export type UserRole = 'superadmin' | 'admin' | 'moderador' | 'viewer';

/** Nivel jerárquico de cada rol (mayor = más privilegios). Espejo de
 * ROLE_LEVEL en src/models/user.py, solo para uso de UI condicional. */
export const ROLE_LEVEL: Record<UserRole, number> = {
  superadmin: 3,
  admin: 2,
  moderador: 1,
  viewer: 0,
};

/** Orden de PRESENTACIÓN de los roles en un selector, de mayor a menor
 * privilegio. Es sólo orden de render: el filtro de qué roles puede otorgar
 * cada actor es aparte (ver `assignableRoles` en UsersPanel, que usa `<`
 * ESTRICTO sobre ROLE_LEVEL). */
export const ROLE_ORDER: UserRole[] = ['superadmin', 'admin', 'moderador', 'viewer'];

/** Body de `POST /auth/users/{user_id}/role`. El backend valida contra su
 * propio enum: un rol inexistente es 422, no un guard. */
export interface RoleChangePayload {
  role: UserRole;
}

/** Shape de usuario devuelto por /auth/register, /auth/login y /auth/me.
 *
 * name/avatar_url (extensión google-oauth, migración 004): solo presentes
 * (no null) para usuarios que se loguearon vía Google — un usuario
 * registrado exclusivamente por password los recibe en `null`. La UI
 * (AppSidebar) resuelve un fallback de iniciales derivadas del email cuando
 * avatar_url es null. */
export interface UserPublic {
  id: string;
  email: string;
  role: UserRole;
  name?: string | null;
  avatar_url?: string | null;
}

/**
 * Respuesta de `GET /auth/me` (email-invitations, Decision 6): el shape de
 * `UserPublic` + `onboarding_completed_at` leído de la BASE en cada request
 * (nunca del JWT — dato mutable). `null` = onboarding pendiente, el layout
 * de `(app)` monta el wizard. Espejo de `MeResponse` en src/models/user.py.
 */
export interface MeResponse extends UserPublic {
  onboarding_completed_at: string | null;
}

/**
 * Invitaciones (email-invitations). El `status` viene DERIVADO de los
 * timestamps por el backend (no existe columna status, design.md Decision 1);
 * la UI lo muestra tal cual sin recalcularlo.
 */
export type InvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

/** Idioma del email de invitación — espejo de `InvitationLocale` del backend
 * (migración 010). Lo elige el admin al invitar; el reenvío lo conserva. */
export type InvitationLocale = 'es' | 'en';

/** Shape de `GET /auth/invitations` — espejo de InvitationPublic del backend.
 * NUNCA incluye token ni hash (garantía por construcción de tipos, server-side). */
export interface Invitation {
  id: string;
  email: string;
  role: UserRole;
  /** Idioma en que sale (y salió) el email de esta invitación. */
  locale: InvitationLocale;
  status: InvitationStatus;
  invited_by: string | null;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  /** `null` mientras la route de envío no confirmó el email — la UI lo
   * muestra como badge "email sin confirmar" con "reenviar" como recuperación. */
  email_sent_at: string | null;
}

/** Respuesta de `POST /auth/invitations` y `POST .../resend`: la ÚNICA vez
 * que el token viaja en claro — la UI lo usa de inmediato para el paso 2
 * (envío del email) y no lo persiste en ningún lado. */
export interface InvitationWithToken extends Invitation {
  token: string;
}

/** Respuesta 200 de `GET /auth/invitations/validate?token=` (público). */
export interface InvitationValidation {
  email: string;
  role: UserRole;
  /** La página /invite/[token] muestra su copy en este idioma. */
  locale: InvitationLocale;
  expires_at: string;
}

/**
 * Item de `GET /auth/users` (user-management, design.md Decision 9) — espejo
 * exacto de `UserListItem` en src/models/user.py, con las fechas como string
 * ISO (lo que serializa FastAPI).
 *
 * Tipo DEDICADO, no una extensión de `UserPublic`: `password_hash` y
 * `totp_secret` son inexpresables por construcción, y el contrato de auth
 * (login/register/me) no se contamina con campos de administración.
 *
 * `has_google`/`has_password` son booleanos DERIVADOS por el backend
 * (`google_id IS NOT NULL`, `password_hash IS NOT NULL`): la UI necesita
 * saber CÓMO entra la persona, no su identificador de Google.
 *
 * `deactivated_at`: `null` = cuenta activa (migración 012).
 */
export interface UserListItem {
  id: string;
  email: string;
  role: UserRole;
  name: string | null;
  avatar_url: string | null;
  has_google: boolean;
  has_password: boolean;
  created_at: string;
  deactivated_at: string | null;
}

/**
 * Interesado en la beta (GET /beta-signups, solo admin+). El estado se
 * deriva de approved_at: null = pendiente de aprobación.
 */
export interface BetaSignup {
  id: string;
  email: string;
  created_at: string;
  approved_at: string | null;
}

export interface ChartDataPoint {
  timestamp: number;
  mag: number;
  depth: number | null;
  felt: boolean;
  id: string;
}

/**
 * Perfil extendido del usuario (openspec/changes/account-settings). Vive
 * EXCLUSIVAMENTE en `GET/PATCH /account/profile` — nunca en `/auth/me` ni en
 * el JWT (ver design.md Decisión Cerrada #4). `full_name` es un campo
 * DISTINTO de `UserPublic.name` (ese último viene de Google OAuth, es
 * read-only acá): no deben mezclarse ni mostrarse como si fueran el mismo
 * dato en ningún formulario.
 */
export interface UserProfile {
  full_name: string | null;
  address: string | null;
  phone: string | null;
  /** Preferencia de idioma guardada en cuenta (i18n-dashboard, Fase 1 del
   * backend). `null` = "nunca eligió" — la cascada cookie/Accept-Language
   * decide (LocaleSync solo siembra la cookie cuando NO es null). */
  locale: AppLocale | null;
  /** Único booleano de estado 2FA expuesto acá — nunca el secreto TOTP.
   * Agregado como fix puntual (post-Phase 4): reemplaza el uso lateral que
   * hacía SettingsPage de GET /account/export solo para leer este flag. */
  totp_enabled: boolean;
}

/** Body de `PATCH /account/profile` — mismo shape que `UserProfile`, todos
 * los campos opcionales para permitir edición parcial (campos no enviados
 * no se tocan en el backend, ver design.md Decision Contrato AuthService). */
export interface UserProfileUpdate {
  full_name?: string | null;
  address?: string | null;
  phone?: string | null;
  locale?: AppLocale;
}

/** Respuesta de `POST /auth/2fa/setup`. `otpauth_uri` se usa para renderizar
 * el QR client-side (el backend no genera imagen, ver design.md Decision 7).
 * `backup_codes` viaja en texto claro UNA sola vez en este response. */
export interface TotpSetupResponse {
  otpauth_uri: string;
  backup_codes: string[];
}

/** Respuesta de `GET /account/export`. `account`/`security` son objetos
 * de shape libre definido por el backend (ver design.md Decision 5) — no se
 * tipan campo a campo acá porque el frontend solo necesita serializarlos a
 * un archivo `.json` descargable, no leer campos individuales. */
export interface AccountExport {
  account: Record<string, unknown>;
  profile: UserProfile;
  security: Record<string, unknown>;
  exported_at: string;
}

/**
 * Resultado de `login()`. Cuando el usuario tiene 2FA habilitado, el backend
 * responde `{"requires_2fa": true}` sin otorgar sesión completa (ver
 * spec.md Requirement: Login con 2FA habilitado requiere segundo factor) —
 * este NO es un caso de error, es un resultado válido que el caller debe
 * manejar mostrando el segundo paso del login.
 */
export type LoginResult = { requiresTwoFactor: true } | { requiresTwoFactor: false; user: UserPublic };
