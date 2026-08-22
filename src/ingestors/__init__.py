"""
Ingestores de eventos sísmicos en tiempo real (PR-W4).

Corren dentro del worker `src.services.events_ingestor`, que es un PROCESO
SEPARADO del API — mismo patrón que `src.services.seedlink_ingestor`.

Cada ingestor sólo produce `SeismicEvent` y los entrega por callback. No
deduplican, no persisten y no publican: de eso se ocupa el worker, que es
quien tiene el store y el bus. Así se testean con un callback que acumula en
una lista, sin base ni Redis.
"""
