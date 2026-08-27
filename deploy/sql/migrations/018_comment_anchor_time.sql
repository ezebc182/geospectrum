-- 018: apuntes anclados a la onda (extiende window_comments de la 017).
--
-- Un comentario CON anchor_time es un apunte sobre un INSTANTE de la señal
-- ("acá arranca el evento"): el wave view lo dibuja como bandera en ese
-- momento exacto. Anclar al instante y no a píxeles es lo que hace que el
-- apunte sobreviva zoom, filtros y re-renders. Sin ancla, es un mensaje
-- común del hilo — el campo es NULL y todo lo anterior sigue igual.

ALTER TABLE window_comments
    ADD COLUMN IF NOT EXISTS anchor_time TIMESTAMPTZ NULL;
