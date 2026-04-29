# Seismic Monitor API Documentation

Complete API reference for Seismic Monitor Service.

**Base URL**: `https://seismic.example.com` (replace with your deployment)

**OpenAPI Docs**: `https://seismic.example.com/docs`

---

## Authentication

Currently no authentication required for public endpoints.

For production, implement:
- API key authentication
- JWT tokens
- mTLS for service-to-service

Add via API Gateway (NGINX, Kong, etc.) or FastAPI middleware.

---

## Endpoints

### `GET /`

**Info endpoint** - Service metadata

**Response**:
```json
{
  "service": "Seismic Monitor",
  "version": "1.0.0",
  "status": "operational",
  "docs": "/docs",
  "health": "/health",
  "metrics": "/metrics",
  "endpoints": {
    "report": "/report",
    "events": "/events",
    "alerts": "/alerts"
  }
}
```

---

### `GET /health`

**Health check** - For liveness/readiness probes

**Response**: `200 OK` with body `"ok"`

**Use case**: Kubernetes probes, load balancer health checks

---

### `GET /metrics`

**Prometheus metrics** - Observability data

**Response**: Plain text Prometheus format

**Example metrics**:
```
# HELP seismic_monitor_requests_total Total de requests por endpoint
# TYPE seismic_monitor_requests_total counter
seismic_monitor_requests_total{endpoint="/report",status="200"} 142

# HELP seismic_monitor_events_fetched_total Total de eventos obtenidos
# TYPE seismic_monitor_events_fetched_total counter
seismic_monitor_events_fetched_total{source="USGS"} 87
seismic_monitor_events_fetched_total{source="INPRES"} 12
```

---

### `GET /report`

**Full seismic report** - KPIs + alerts + events

**Response**: `200 OK`

```json
{
  "timestamp_utc_generacion": "2025-10-28T23:59:59Z",
  "region_monitorizada": {
    "minlat": -40,
    "maxlat": -20,
    "minlon": -75,
    "maxlon": -60
  },
  "data_source_errors": ["INPRES_TIMEOUT:..."],
  "kpis": {
    "total_eventos": 12,
    "tasa_eventos_por_hora": 12.0,
    "magnitud_max": 4.5,
    "magnitud_promedio_ponderada_por_energia": 3.8,
    "profundidad_media_M_ge_4": 95.3,
    "eventos_sentidos": 3,
    "porcentaje_eventos_sentidos": 0.25,
    "minutos_desde_M_ge_5": 480
  },
  "alertas": [
    {
      "tipo": "enjambre",
      "descripcion": "4 eventos M≥3 en ≤15min y ≤20km",
      "eventos_relacionados": ["us123", "us124", "us125", "inpres1"]
    }
  ],
  "eventos": [
    {
      "id": "us123",
      "fuentes": ["USGS", "INPRES"],
      "hora_utc": "2025-10-28T22:15:30Z",
      "lat": -31.875,
      "lon": -68.296,
      "prof_km": 108.0,
      "mag": 4.2,
      "mag_tipo": "Mw",
      "lugar": "43 km SE de San Juan, Argentina",
      "sentido": true,
      "revisado": true
    }
  ]
}
```

**Fields**:

| Field                                  | Type    | Description                                    |
|----------------------------------------|---------|------------------------------------------------|
| `timestamp_utc_generacion`             | string  | ISO8601 UTC timestamp of report generation     |
| `region_monitorizada`                  | object  | Bounding box (lat/lon)                         |
| `data_source_errors`                   | array   | Errors from external APIs (if any)             |
| `kpis`                                 | object  | Calculated KPIs                                |
| `kpis.total_eventos`                   | int     | Event count                                    |
| `kpis.tasa_eventos_por_hora`           | float   | Hourly event rate                              |
| `kpis.magnitud_max`                    | float   | Max magnitude                                  |
| `kpis.magnitud_promedio_ponderada...` | float   | Energy-weighted average magnitude              |
| `kpis.profundidad_media_M_ge_4`        | float   | Avg depth of M≥4 events (km)                   |
| `kpis.eventos_sentidos`                | int     | Felt event count                               |
| `kpis.porcentaje_eventos_sentidos`     | float   | % of felt events (0.0-1.0)                     |
| `kpis.minutos_desde_M_ge_5`            | float   | Minutes since last M≥5                         |
| `alertas`                              | array   | Active alerts                                  |
| `alertas[].tipo`                       | string  | Alert type: `enjambre`, `evento_significativo`, `actividad_sentida` |
| `alertas[].descripcion`                | string  | Human-readable description                     |
| `alertas[].eventos_relacionados`       | array   | Event IDs triggering this alert                |
| `eventos`                              | array   | Seismic events                                 |
| `eventos[].id`                         | string  | Unique event ID                                |
| `eventos[].fuentes`                    | array   | Sources: `["USGS"]`, `["INPRES"]`, or both     |
| `eventos[].hora_utc`                   | string  | ISO8601 UTC timestamp                          |
| `eventos[].lat`                        | float   | Epicenter latitude                             |
| `eventos[].lon`                        | float   | Epicenter longitude                            |
| `eventos[].prof_km`                    | float   | Depth in kilometers (nullable)                 |
| `eventos[].mag`                        | float   | Magnitude                                      |
| `eventos[].mag_tipo`                   | string  | Magnitude type: `Mw`, `ML`, `Md`, etc          |
| `eventos[].lugar`                      | string  | Location description                           |
| `eventos[].sentido`                    | bool    | Was felt by population                         |
| `eventos[].revisado`                   | bool    | Reviewed by seismologist                       |

**Errors**:

- `500 Internal Server Error` - Service error (check logs)
- Data source errors gracefully handled in `data_source_errors` field

---

### `GET /events`

**Events only** - No KPIs or alerts

**Response**: `200 OK`

```json
[
  {
    "id": "us123",
    "fuentes": ["USGS"],
    "hora_utc": "2025-10-28T22:15:30Z",
    "lat": -31.875,
    "lon": -68.296,
    "prof_km": 108.0,
    "mag": 4.2,
    "mag_tipo": "Mw",
    "lugar": "43 km SE de San Juan, Argentina",
    "sentido": true,
    "revisado": true
  }
]
```

**Use case**: Lightweight endpoint for applications that only need event list.

---

### `GET /alerts`

**Alerts only** - No events or KPIs

**Response**: `200 OK`

```json
[
  {
    "tipo": "enjambre",
    "descripcion": "4 eventos M≥3 en ≤15min y ≤20km",
    "eventos_relacionados": ["us123", "us124", "us125", "inpres1"]
  }
]
```

**Returns**: Empty array `[]` if no active alerts.

**Use case**: Alert notification systems, dashboards showing only critical events.

---

## Rate Limiting

Default: No rate limiting

Recommended for production:
- 60 requests/minute per IP
- Implement at API Gateway or ingress level

---

## CORS

Default: CORS enabled for all origins (`*`)

For production:
- Restrict to specific domains
- Configure in ingress annotations or FastAPI middleware

---

## Pagination

Not implemented (all events returned in single response).

Typical window (60 min) contains <200 events.

If needed for larger windows:
- Add `?limit=N&offset=M` query params
- Implement in FastAPI route

---

## Webhook Integration (Future)

Planned feature: Push alerts to webhooks

```json
POST https://your-webhook.com/alerts
{
  "timestamp": "2025-10-28T23:59:59Z",
  "alert_type": "enjambre",
  "description": "...",
  "event_ids": ["..."]
}
```

---

## Error Responses

All errors follow standard HTTP status codes:

| Code | Meaning                          |
|------|----------------------------------|
| 200  | Success                          |
| 400  | Bad Request (malformed input)    |
| 404  | Not Found                        |
| 429  | Too Many Requests (rate limited) |
| 500  | Internal Server Error            |
| 503  | Service Unavailable              |

**Example error**:
```json
{
  "detail": "Error message here"
}
```

---

## Client Examples

### cURL

```bash
# Full report
curl https://seismic.example.com/report | jq

# Health check
curl https://seismic.example.com/health

# Events only
curl https://seismic.example.com/events | jq '.[] | {mag, lugar}'
```

### Python

```python
import httpx

response = httpx.get("https://seismic.example.com/report")
data = response.json()

for alert in data["alertas"]:
    print(f"⚠️  {alert['tipo']}: {alert['descripcion']}")
```

### JavaScript

```javascript
fetch('https://seismic.example.com/report')
  .then(res => res.json())
  .then(data => {
    console.log(`Total events: ${data.kpis.total_eventos}`);
    console.log(`Max magnitude: ${data.kpis.magnitud_max}`);
  });
```

---

## Interactive Documentation

Full interactive API docs with request/response examples:

**Swagger UI**: `https://seismic.example.com/docs`

**ReDoc**: `https://seismic.example.com/redoc`

---

## Changelog

| Version | Date       | Changes                          |
|---------|------------|----------------------------------|
| 1.0.0   | 2025-10-28 | Initial release                  |
