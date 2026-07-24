-- Migration 004: agrega nombre y avatar de perfil, poblados desde Google OAuth.
--
-- `name` y `avatar_url` son nullable: SOLO se completan para usuarios que
-- se loguean vía Google (claims estándar OpenID Connect `name`/`picture` del
-- ID token, ver src/main.py google_callback() y
-- AuthService.resolve_or_create_google_user()). Un usuario registrado
-- exclusivamente por password (POST /auth/register) nunca los recibe —
-- quedan NULL a propósito, no es un dato faltante a "arreglar": el frontend
-- resuelve un fallback de iniciales derivadas del email cuando avatar_url
-- es NULL (ver dashboard/components/UserMenu.tsx).
--
-- Un usuario auto-linkeado (ya existía por password, se logueó por Google
-- por primera vez) SÍ recibe name/avatar_url en ese momento — Google es la
-- fuente de verdad de esos datos de perfil una vez vinculada la cuenta (ver
-- AuthService.resolve_or_create_google_user(), rama de auto-link).
--
-- Convención de este proyecto (ver 001/002/003): archivos numerados en
-- deploy/sql/migrations/, aplicados manualmente contra el Postgres del
-- perfil `storage`. No se editan 001/002/003 (historia ya aplicada).

ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;

-- Rollback:
--
-- ALTER TABLE users DROP COLUMN IF EXISTS avatar_url;
-- ALTER TABLE users DROP COLUMN IF EXISTS name;
--
-- Rollback libre de pérdida de datos crítica en el sentido estricto (no hay
-- checks/constraints dependientes de estas columnas), pero SÍ pierde
-- irreversiblemente el nombre/avatar cacheado de los usuarios de Google —
-- se re-poblaría recién en su próximo login por Google.
