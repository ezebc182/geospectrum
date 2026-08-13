/**
 * Fuerza de contraseña client-side, sin dependencias: score 0–4 por longitud
 * y variedad de clases de caracteres. Es SOLO feedback visual — la política
 * real (mínimo 8) la valida el backend en /auth/register.
 *
 * Vivía en el diccionario casero de /invite; se mudó acá cuando ese
 * diccionario se retiró (i18n-dashboard, Fase 7) — es lógica pura, no copy.
 */
export function passwordStrength(password: string): number {
  if (password.length === 0) return 0;

  let classes = 0;
  if (/[a-z]/.test(password)) classes += 1;
  if (/[A-Z]/.test(password)) classes += 1;
  if (/[0-9]/.test(password)) classes += 1;
  if (/[^a-zA-Z0-9]/.test(password)) classes += 1;

  let score = 1;
  if (password.length >= 8) score += 1;
  if (password.length >= 12 && classes >= 2) score += 1;
  if (password.length >= 12 && classes >= 3) score += 1;

  return score;
}
