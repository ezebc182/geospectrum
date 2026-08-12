-- Migration 011: idioma del usuario y del interesado en la beta (i18n-dashboard).
--
-- Un solo archivo para las dos columnas porque es UN concepto (el idioma de
-- la persona), en dos tablas:
--
-- * `users.locale` es NULLABLE a propósito: NULL = "nunca eligió" y deja que
--   la cascada del frontend (cookie -> Accept-Language -> 'es') decida. Un
--   default 'es' clavaría a todo usuario existente en español aunque su
--   navegador pida inglés (design.md Decision 7).
-- * `beta_signups.locale` es NOT NULL DEFAULT 'es', espejo exacto de
--   `invitations.locale` (010): las filas históricas vienen de la landing en
--   español, y el alta siempre conoce el idioma del toggle.
--
-- Convención del proyecto (ver 001-010): manual, sin Alembic, idempotente.
-- Se aplica sola al arranque de la API (scripts/apply_migrations.py).
--
-- Idempotente: ADD COLUMN IF NOT EXISTS; el CHECK va con nombre explícito y
-- DROP CONSTRAINT IF EXISTS previo (mismo guard que 002/010) — re-ejecutar
-- la migración no duplica ni falla.

-- users.locale: NULL = "nunca eligió" (la cascada cookie/Accept-Language decide).
ALTER TABLE users ADD COLUMN IF NOT EXISTS locale TEXT;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_locale_check;

ALTER TABLE users ADD CONSTRAINT users_locale_check
    CHECK (locale IS NULL OR locale IN ('es', 'en'));

-- beta_signups.locale: espejo de invitations.locale (010). Filas viejas = 'es'.
ALTER TABLE beta_signups ADD COLUMN IF NOT EXISTS locale TEXT NOT NULL DEFAULT 'es';

ALTER TABLE beta_signups DROP CONSTRAINT IF EXISTS beta_signups_locale_check;

ALTER TABLE beta_signups ADD CONSTRAINT beta_signups_locale_check
    CHECK (locale IN ('es', 'en'));

-- Rollback (cada mitad es independiente; se puede revertir una sin la otra):
--
-- users (la cuenta sobrevive; solo se pierde la preferencia guardada y la UI
-- vuelve a resolver por cookie/Accept-Language):
-- ALTER TABLE users DROP CONSTRAINT IF EXISTS users_locale_check;
-- ALTER TABLE users DROP COLUMN IF EXISTS locale;
--
-- beta_signups (el alta sobrevive; los emails de beta volverían a salir con
-- el default en español del template):
-- ALTER TABLE beta_signups DROP CONSTRAINT IF EXISTS beta_signups_locale_check;
-- ALTER TABLE beta_signups DROP COLUMN IF EXISTS locale;
