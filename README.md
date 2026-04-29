# Seismic Monitor Service

**Production-grade seismic monitoring system** integrating USGS ComCat and INPRES Argentina.

Real-time earthquake tracking, KPI calculation, and operational alerting for critical infrastructure protection.

---

## Features

- **Multi-source integration**: USGS global catalog + INPRES Argentina regional data
- **Real-time KPIs**: Event rates, magnitudes, depths, felt reports
- **Intelligent alerting**: Swarm detection, significant events, felt activity
- **Production-ready**: Docker, Kubernetes, Prometheus metrics, security hardening
- **Extensible**: Modular architecture, typed Python, comprehensive tests

---

## Quick Start

### Local Development

```bash
# Clone and setup
git clone <repo-url>
cd seismic-monitor

# Run locally (creates venv, installs deps)
./scripts/run-local.sh

# Service available at http://localhost:8000
# API docs: http://localhost:8000/docs
```

### Docker (Recommended)

```bash
# Start all services (main API + INPRES adapter)
./scripts/run-docker.sh

# Logs
docker-compose -f deploy/docker/docker-compose.yml logs -f

# Stop
docker-compose -f deploy/docker/docker-compose.yml down
```

### With Observability Stack

```bash
# Start with Prometheus + Grafana
docker-compose -f deploy/docker/docker-compose.yml --profile observability up -d

# Access:
# - Grafana: http://localhost:3000 (admin/admin)
# - Prometheus: http://localhost:9090
```

---

## API Endpoints

| Endpoint   | Description                              |
|------------|------------------------------------------|
| `GET /`    | Service info                             |
| `GET /health` | Health check (liveness/readiness)     |
| `GET /metrics` | Prometheus metrics                    |
| `GET /report` | Full report (KPIs + alerts + events)  |
| `GET /events` | Events list only                      |
| `GET /alerts` | Active alerts only                    |

### Example: Get Report

```bash
curl http://localhost:8000/report | jq
```

Response:

```json
{
  "timestamp_utc_generacion": "2025-10-28T23:59:59Z",
  "region_monitorizada": {
    "minlat": -40,
    "maxlat": -20,
    "minlon": -75,
    "maxlon": -60
  },
  "data_source_errors": [],
  "kpis": {
    "total_eventos": 4,
    "tasa_eventos_por_hora": 4.0,
    "magnitud_max": 4.2,
    "magnitud_promedio_ponderada_por_energia": 3.8,
    "profundidad_media_M_ge_4": 102.5,
    "eventos_sentidos": 1,
    "porcentaje_eventos_sentidos": 0.25,
    "minutos_desde_M_ge_5": 1800
  },
  "alertas": [
    {
      "tipo": "enjambre",
      "descripcion": "3 eventos M≥3 en ≤15min y ≤20km",
      "eventos_relacionados": ["evt-001", "evt-002", "evt-003"]
    }
  ],
  "eventos": [...]
}
```

---

## CLI Client

Interactive CLI for monitoring:

```bash
# Health check
python scripts/seismic-cli.py health

# Full report
python scripts/seismic-cli.py report

# Only events
python scripts/seismic-cli.py events

# Only alerts
python scripts/seismic-cli.py alerts

# Watch mode (continuous monitoring)
python scripts/seismic-cli.py watch --interval 60
```

---

## Configuration

Environment variables (see `.env.example`):

| Variable              | Description                          | Default         |
|-----------------------|--------------------------------------|-----------------|
| `REGION_MINLAT`       | Bounding box min latitude            | -40             |
| `REGION_MAXLAT`       | Bounding box max latitude            | -20             |
| `REGION_MINLON`       | Bounding box min longitude           | -75             |
| `REGION_MAXLON`       | Bounding box max longitude           | -60             |
| `MIN_MAG_ALERT`       | Minimum magnitude for alerts         | 3.0             |
| `WINDOW_MINUTES`      | Analysis window (minutes)            | 60              |
| `USGS_TIMEOUT_S`      | USGS API timeout                     | 5.0             |
| `INPRES_TIMEOUT_S`    | INPRES adapter timeout               | 5.0             |
| `INPRES_PROXY_URL`    | INPRES adapter URL                   | (internal)      |
| `LOG_LEVEL`           | Logging level                        | INFO            |
| `PROMETHEUS_ENABLED`  | Enable Prometheus metrics            | true            |

---

## KPIs Explained

### Activity Metrics

- **total_eventos**: Event count in analysis window
- **tasa_eventos_por_hora**: Hourly event rate
- **magnitud_max**: Maximum magnitude detected
- **magnitud_promedio_ponderada_por_energia**: Energy-weighted average magnitude (larger events weigh more)
- **profundidad_media_M_ge_4**: Average depth of significant events (M≥4)

### Impact Metrics

- **eventos_sentidos**: Count of felt events (reported by population)
- **porcentaje_eventos_sentidos**: Percentage of felt events
- **minutos_desde_M_ge_5**: Minutes since last M≥5 event

---

## Alert Types

### Enjambre (Swarm)

**Trigger**: ≥3 events with M≥3 within ≤15 minutes and ≤20 km radius

Indicates clustering seismic activity, potential precursor to larger event.

### Evento Significativo (Significant Event)

**Trigger**: M≥5 at depth <70 km

Large, shallow earthquake with high potential for structural damage.

### Actividad Sentida (Felt Activity)

**Trigger**: >50% of events in window were felt by population

High human impact, potential for public concern and emergency response needs.

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│            Seismic Monitor Service              │
│                                                 │
│  ┌──────────────┐      ┌──────────────┐        │
│  │  USGS API    │      │   INPRES     │        │
│  │   Client     │      │   Adapter    │        │
│  └──────┬───────┘      └──────┬───────┘        │
│         │                     │                 │
│         └──────────┬──────────┘                 │
│                    │                            │
│         ┌──────────▼──────────┐                 │
│         │   Merge Service     │                 │
│         └──────────┬──────────┘                 │
│                    │                            │
│         ┌──────────▼──────────┐                 │
│         │   KPI Calculator    │                 │
│         │  Alert Detector     │                 │
│         └──────────┬──────────┘                 │
│                    │                            │
│         ┌──────────▼──────────┐                 │
│         │   FastAPI Server    │                 │
│         │  /report /events    │                 │
│         │  /alerts /metrics   │                 │
│         └─────────────────────┘                 │
└─────────────────────────────────────────────────┘
         │              │             │
         ▼              ▼             ▼
   Prometheus      Grafana       CLI/Apps
```

### Components

- **USGS Service**: Queries USGS ComCat API, normalizes events
- **INPRES Adapter**: Scrapes INPRES website, extracts regional events
- **Merge Service**: Deduplicates events reported by both sources
- **KPI Service**: Calculates operational metrics
- **Alert Service**: Detects swarms, significant events, felt activity
- **FastAPI Server**: Exposes REST API with observability

---

## Production Deployment

### Kubernetes

```bash
# Deploy to K8s cluster
kubectl apply -k deploy/k8s/

# Verify
kubectl get pods -n seismic-monitor
kubectl get svc -n seismic-monitor
kubectl logs -f -n seismic-monitor -l app=seismic-monitor
```

See [deploy/k8s/README.md](deploy/k8s/README.md) for detailed K8s deployment guide.

### Security Hardening

- Non-root containers (UID 1000)
- Read-only root filesystem
- Dropped capabilities
- Network policies (recommended)
- Secrets management (use Sealed Secrets or External Secrets in production)
- Rate limiting at ingress
- TLS/mTLS for inter-service communication

### Observability

- **Metrics**: Prometheus endpoint at `/metrics`
- **Logs**: Structured JSON logging
- **Tracing**: Ready for OpenTelemetry integration
- **Dashboards**: Grafana-ready (import dashboards from `/deploy/grafana/`)

---

## Testing

```bash
# Unit tests
pytest tests/unit/

# Integration tests
pytest tests/integration/

# All tests with coverage
pytest --cov=src --cov-report=html

# View coverage report
open htmlcov/index.html
```

---

## Development

### Project Structure

```
seismic-monitor/
├── src/
│   ├── main.py                 # FastAPI app
│   ├── config/
│   │   └── settings.py         # Configuration
│   ├── models/
│   │   └── event.py            # Data models
│   ├── services/
│   │   ├── usgs_service.py     # USGS client
│   │   ├── inpres_service.py   # INPRES client
│   │   ├── merge_service.py    # Event fusion
│   │   ├── kpi_service.py      # KPI calculator
│   │   └── alert_service.py    # Alert detector
│   ├── adapters/
│   │   └── inpres_adapter.py   # INPRES scraper
│   └── utils/
│       └── geo.py              # Geo calculations
├── tests/
│   ├── unit/
│   └── integration/
├── deploy/
│   ├── docker/
│   │   ├── Dockerfile
│   │   └── docker-compose.yml
│   └── k8s/
│       └── *.yaml
├── scripts/
│   ├── seismic-cli.py          # CLI client
│   ├── run-local.sh
│   └── run-docker.sh
└── docs/
    └── RUNBOOK.md
```

### Adding New Data Sources

1. Create service in `src/services/`
2. Implement `fetch_*_events()` returning `List[SeismicEvent]`
3. Update `merge_service.py` to include new source
4. Add configuration in `settings.py`
5. Write tests

### Code Quality

```bash
# Format
black src/ tests/

# Lint
ruff check src/ tests/

# Type check
mypy src/
```

---

## Troubleshooting

### Service won't start

Check logs:
```bash
docker-compose -f deploy/docker/docker-compose.yml logs seismic-monitor
```

Common issues:
- INPRES adapter not reachable → Check `INPRES_PROXY_URL`
- USGS API timeout → Increase `USGS_TIMEOUT_S`
- Port already in use → Change port in docker-compose.yml

### No INPRES events

INPRES scraper is fragile (HTML parsing). If INPRES site structure changes:

1. Check adapter logs: `docker logs inpres-adapter`
2. Update `src/adapters/inpres_adapter.py` parsing logic
3. Test with: `curl http://localhost:8001/recent`

Service continues to work with USGS-only mode if INPRES fails.

### High memory usage

Adjust resources in:
- Docker: `deploy/docker/docker-compose.yml`
- K8s: `deploy/k8s/deployment.yaml` resources section

---

## Roadmap

- [ ] TimescaleDB integration for historical analysis
- [ ] Webhook notifications (Slack, PagerDuty, Teams)
- [ ] Additional data sources (EMSC, ISC)
- [ ] ML-based anomaly detection
- [ ] Mobile push notifications
- [ ] Public dashboard with real-time map

---

## Contributing

1. Fork repo
2. Create feature branch: `git checkout -b feature/amazing-feature`
3. Commit changes: `git commit -m 'Add amazing feature'`
4. Push: `git push origin feature/amazing-feature`
5. Open Pull Request

Ensure tests pass and coverage stays >80%:
```bash
pytest --cov=src --cov-report=term-missing
```

---

## License

MIT License - see [LICENSE](LICENSE)

---

## References

- [USGS ComCat API Documentation](https://earthquake.usgs.gov/fdsnws/event/1/)
- [INPRES - Instituto Nacional de Prevención Sísmica](https://www.inpres.gob.ar/)
- [FastAPI Documentation](https://fastapi.tiangolo.com/)
- [Prometheus Best Practices](https://prometheus.io/docs/practices/)

---

## Support

For issues, questions, or feature requests, please open an issue on GitHub.

For operational support, see [docs/RUNBOOK.md](docs/RUNBOOK.md).
