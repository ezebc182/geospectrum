"""
Metricas Prometheus extendidas para el stream real-time.

Se cargan al import: el dispatcher, listeners y SSE handler las incrementan
directamente. Prometheus scrapea /metrics del API (la unica que expone
endpoint HTTP). El ingestor no expone metrics endpoint en esta fase para
evitar otro puerto; sus metricas se publican via push a Redis (TODO en
phase futura) o se inspeccionan via stdout en debug.

Ver tambien las metricas existentes en src/main.py (requests_total, etc.).
"""

from prometheus_client import Counter, Gauge, Histogram

# ---------------------------------------------------------------------------
# Ingestor: EMSC WebSocket
# ---------------------------------------------------------------------------

emsc_websocket_connected = Gauge(
    "seismic_emsc_websocket_connected",
    "1 si EMSC WebSocket esta conectado, 0 si no",
)

emsc_last_message_seconds_ago = Gauge(
    "seismic_emsc_last_message_seconds_ago",
    "Segundos desde el ultimo mensaje recibido por EMSC WS",
)

emsc_parse_errors_total = Counter(
    "seismic_emsc_parse_errors_total",
    "Frames de EMSC que fallaron al parsear",
)

emsc_reconnections_total = Counter(
    "seismic_emsc_reconnections_total",
    "Veces que el listener EMSC reconecto",
)

# ---------------------------------------------------------------------------
# Ingestor: USGS poller
# ---------------------------------------------------------------------------

usgs_rate_limited_total = Counter(
    "seismic_usgs_rate_limited_total",
    "Respuestas 429 de USGS",
)

# ---------------------------------------------------------------------------
# Dispatcher
# ---------------------------------------------------------------------------

dispatcher_events_processed = Counter(
    "seismic_dispatcher_events_processed_total",
    "Eventos procesados por el dispatcher",
    ["event_type"],  # 'new' | 'update' | 'noop' | 'invalid'
)

dispatcher_collisions_total = Counter(
    "seismic_dispatcher_collisions_total",
    "Veces que un UPDATE difiere demasiado en magnitud " "(potencial colision de canonical_id)",
)

dispatcher_local_buffer_size = Gauge(
    "seismic_dispatcher_local_buffer_size",
    "Tamano actual del buffer local cuando Redis esta caido",
)

# ---------------------------------------------------------------------------
# Redis
# ---------------------------------------------------------------------------

redis_errors_total = Counter(
    "seismic_redis_errors_total",
    "Errores al hablar con Redis",
    ["operation"],
)

# ---------------------------------------------------------------------------
# SSE
# ---------------------------------------------------------------------------

sse_active_clients = Gauge(
    "seismic_sse_active_clients",
    "Clientes SSE actualmente conectados",
)

sse_messages_sent_total = Counter(
    "seismic_sse_messages_sent_total",
    "Mensajes SSE enviados",
    ["event_type"],  # 'new' | 'update' | 'snapshot' | 'replay' | 'heartbeat'
)

sse_replay_truncated_total = Counter(
    "seismic_sse_replay_truncated_total",
    "Veces que un cliente pidio replay >24h y fue truncado",
)

# ---------------------------------------------------------------------------
# Archive (JSONL)
# ---------------------------------------------------------------------------

archive_writes_total = Counter(
    "seismic_archive_writes_total",
    "Eventos escritos al archivo JSONL",
)

archive_write_errors_total = Counter(
    "seismic_archive_write_errors_total",
    "Errores al escribir al archivo JSONL",
)


# ---------------------------------------------------------------------------
# Source fetch observability (M1.4)
# ---------------------------------------------------------------------------

source_fetch_duration_seconds = Histogram(
    "geospectrum_source_fetch_duration_seconds",
    "Time spent fetching events from external sources",
    labelnames=["source", "status"],
    buckets=(0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0),
)

source_errors_total = Counter(
    "geospectrum_source_errors_total",
    "Total errors fetching from external sources",
    labelnames=["source", "error_type"],
)
