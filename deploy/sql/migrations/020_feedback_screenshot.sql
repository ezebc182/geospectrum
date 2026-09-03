-- 020: captura de pantalla opcional en el panel de feedback
-- (change feedback-screenshot-attachment).
--
-- UNA columna nullable, sin CHECK de formato: la forma de la key
-- (`feedback-screenshots/{uuid4}.png`) se valida en Pydantic al crear el
-- reporte vía API (src/models/feedback.py), no en SQL — una fila sembrada
-- directo en la base por un script de mantenimiento no debe quedar
-- bloqueada por un CHECK de regex. `IF NOT EXISTS` la vuelve idempotente:
-- mismo criterio que el resto de las migraciones del repo (007).

ALTER TABLE feedback_reports
    ADD COLUMN IF NOT EXISTS screenshot_key TEXT NULL;
