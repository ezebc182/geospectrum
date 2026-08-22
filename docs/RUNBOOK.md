# GeoSpectrum Service - Operational Runbook

**For on-call engineers and SREs**

---

## Service Overview

**Purpose**: Real-time seismic monitoring with USGS + INPRES integration

**Criticality**: High (infrastructure protection, public safety)

**SLA**: 99.9% uptime, <10s p99 latency

**On-call**: #geospectrum-ops Slack channel

---

## Architecture Summary

```
External APIs → GeoSpectrum → Prometheus/Alerts → PagerDuty
     ↓               ↓
  USGS INPRES   Dashboard/CLI
```

**Dependencies**:
- USGS ComCat API (external)
- INPRES website (external, fragile)
- Kubernetes cluster
- Prometheus
- (Optional) TimescaleDB

---

## Monitoring & Alerts

### Key Metrics

| Metric                                      | Alert Threshold       |
|---------------------------------------------|-----------------------|
| `geospectrum_requests_total`                | Rate of API requests  |
| `geospectrum_events_fetched_total`          | Events by source      |
| `geospectrum_data_source_errors_total`      | >10/min               |
| `geospectrum_request_duration_seconds`      | p99 >5s               |
| `up{job="geospectrum"}`                     | 0 (down)              |

### Dashboards

- **Grafana**: `https://grafana.example.com/d/geospectrum`
- **Prometheus**: `https://prometheus.example.com`

### Log Aggregation

- **Kibana/CloudWatch/Loki**: Search `namespace:geospectrum`

---

## Common Incidents

### 1. Service Down / Pod CrashLooping

**Symptoms**:
- PagerDuty alert: "GeoSpectrum Down"
- `/health` returning 503
- Pods in CrashLoopBackOff

**Diagnosis**:

```bash
# Check pod status
kubectl get pods -n geospectrum

# Check logs
kubectl logs -n geospectrum -l app=geospectrum --tail=100

# Describe pod for events
kubectl describe pod <pod-name> -n geospectrum
```

**Common Causes**:

a) **Config error** (bad env var)
   - Fix: Check ConfigMap/Secret
   - `kubectl edit configmap geospectrum-config -n geospectrum`

b) **Upstream source unreachable** (INPRES / USGS / EMSC down)
   - INPRES is read in-process from `https://www.inpres.gob.ar/mapa/sismos.xml`
     (no separate service). Check it directly: `curl -sI https://www.inpres.gob.ar/mapa/sismos.xml`
   - The failure surfaces as an `INPRES_*` string in the `errors` array of `/report`,
     and in the `source_errors_total{source="inpres"}` metric

c) **OOMKilled** (out of memory)
   - Increase memory limit in deployment.yaml
   - `kubectl set resources deployment/geospectrum --limits=memory=1Gi -n geospectrum`

**Resolution**:

```bash
# Restart deployment
kubectl rollout restart deployment/geospectrum -n geospectrum

# Monitor rollout
kubectl rollout status deployment/geospectrum -n geospectrum
```

**Escalation**: If restart doesn't fix, escalate to platform team.

---

### 2. High Data Source Error Rate

**Symptoms**:
- Alert: "Seismic data source errors >10/min"
- Reports returning with `data_source_errors` field populated

**Diagnosis**:

```bash
# Check error rate in Prometheus
# Query: rate(geospectrum_data_source_errors_total[5m])

# Check service logs
kubectl logs -n geospectrum -l app=geospectrum | grep ERROR
```

**Common Causes**:

a) **USGS API timeout/unavailable**
   - External service issue
   - Check USGS status: https://earthquake.usgs.gov/
   - Service degrades gracefully (returns USGS-only or INPRES-only data)

b) **INPRES feed broken** (XML schema changed)
   - Check the feed directly: `curl -s https://www.inpres.gob.ar/mapa/sismos.xml | head -20`
   - Expected: `<lista>` root with `<item>` children carrying `idSismo`, `latitud`,
     `longitud`, `mg`, `color_link`
   - A schema change surfaces as `INPRES_INVALID_FORMAT:*` in `/report`'s `errors`
     array — never as a silent empty list
   - Requires a code fix in `src/adapters/inpres_adapter.py`; update the fixture at
     `tests/fixtures/inpres_sismos.xml` with a fresh capture so the tests reflect reality

**Resolution**:

- **Short-term**: Service continues with degraded mode (single source)
- **Long-term**: Fix adapter, deploy new version

**Escalation**: If both sources fail, escalate immediately.

---

### 3. High Latency (p99 >5s)

**Symptoms**:
- Slow API responses
- Prometheus alert: "GeoSpectrum High Latency"

**Diagnosis**:

```bash
# Check request duration
# Prometheus query: histogram_quantile(0.99, rate(geospectrum_request_duration_seconds_bucket[5m]))

# Check pod CPU/memory
kubectl top pods -n geospectrum

# Check HPA status
kubectl get hpa -n geospectrum
```

**Common Causes**:

a) **High load** (spike in requests)
   - HPA should auto-scale
   - Verify: `kubectl get hpa geospectrum-hpa -n geospectrum`
   - If not scaling → check HPA config

b) **Slow external API** (USGS/INPRES timeout)
   - Check external service status
   - Increase timeout: `USGS_TIMEOUT_S`, `INPRES_TIMEOUT_S`

c) **Resource contention** (CPU throttling)
   - Check: `kubectl describe pod <pod-name> -n geospectrum`
   - Increase CPU limits

**Resolution**:

```bash
# Manual scale (if HPA not working)
kubectl scale deployment/geospectrum --replicas=5 -n geospectrum

# Increase timeouts (if external APIs slow)
kubectl set env deployment/geospectrum USGS_TIMEOUT_S=10 -n geospectrum
```

---

### 4. False Positive Alerts (Too Many Seismic Alerts)

**Symptoms**:
- Flooding alerts for minor events
- Alert fatigue

**Diagnosis**:

Check alert configuration:
- `MIN_MAG_ALERT` too low?
- Analysis window too large?

**Resolution**:

Adjust thresholds:

```bash
# Increase minimum magnitude
kubectl set env deployment/geospectrum MIN_MAG_ALERT=4.0 -n geospectrum

# Decrease window
kubectl set env deployment/geospectrum WINDOW_MINUTES=30 -n geospectrum
```

Coordinate with stakeholders on acceptable thresholds.

---

### 5. No Events Detected (Data Gap)

**Symptoms**:
- `/report` shows `total_eventos: 0` for extended period
- No recent seismic activity in monitored region (unusual)

**Diagnosis**:

```bash
# Check if sources responding
curl https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=$(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%S)&minmagnitude=3

# Check INPRES adapter
curl http://<adapter-url>:8001/recent

# Check service logs
kubectl logs -n geospectrum -l app=geospectrum | grep -i "events"
```

**Common Causes**:

a) **Legitimately no seismic activity** (good news!)
   - Verify with external sources (USGS website, news)

b) **Region misconfigured** (bbox wrong)
   - Check: `kubectl get configmap geospectrum-config -n geospectrum -o yaml`
   - Verify lat/lon bounds

c) **Data sources failing silently**
   - Check error counters in Prometheus

**Resolution**:

- If config issue → fix ConfigMap, restart pods
- If source issue → see incident #2

---

## Deployment Procedures

### Rolling Update

```bash
# Update image
kubectl set image deployment/geospectrum geospectrum=<new-image> -n geospectrum

# Monitor rollout
kubectl rollout status deployment/geospectrum -n geospectrum

# Rollback if issues
kubectl rollout undo deployment/geospectrum -n geospectrum
```

### Configuration Change

```bash
# Edit config
kubectl edit configmap geospectrum-config -n geospectrum

# Restart to pick up changes
kubectl rollout restart deployment/geospectrum -n geospectrum
```

### Scaling

```bash
# Manual scale
kubectl scale deployment/geospectrum --replicas=5 -n geospectrum

# Adjust HPA
kubectl edit hpa geospectrum-hpa -n geospectrum
```

---

## Maintenance Windows

### Planned Maintenance

1. Announce in #geospectrum-ops Slack 24h in advance
2. Schedule during low-activity hours (if possible)
3. Put service in maintenance mode (optional):
   ```bash
   kubectl scale deployment/geospectrum --replicas=0 -n geospectrum
   ```
4. Perform maintenance
5. Restore:
   ```bash
   kubectl scale deployment/geospectrum --replicas=2 -n geospectrum
   ```
6. Verify health: `curl https://seismic.example.com/health`

---

## Disaster Recovery

### Complete Cluster Failure

1. **Restore from manifests**:
   ```bash
   kubectl apply -k deploy/k8s/
   ```

2. **Restore secrets** (from backup):
   ```bash
   kubectl apply -f backup/secrets.yaml
   ```

3. **Verify services**:
   ```bash
   kubectl get all -n geospectrum
   curl https://seismic.example.com/health
   ```

### Data Loss

Service is **stateless** by design. No data loss possible unless using optional TimescaleDB.

If using TimescaleDB:
- Restore from daily backups
- See TimescaleDB runbook

---

## Contact & Escalation

| Issue Type                | Contact                      | Response SLA |
|---------------------------|------------------------------|--------------|
| Service down              | #geospectrum-ops → PagerDuty | Immediate    |
| Data source issue         | #geospectrum-ops             | 1 hour       |
| INPRES adapter broken     | Platform team                | 4 hours      |
| Feature request/bug       | GitHub issues                | Best effort  |
| Kubernetes cluster issue  | Platform team → PagerDuty    | Immediate    |

**Escalation Path**:
1. On-call engineer (PagerDuty)
2. Team lead
3. Platform team
4. CTO

---

## Change Log

| Date       | Change                               | Author      |
|------------|--------------------------------------|-------------|
| 2025-10-28 | Initial runbook                      | Ops Team    |

---

## Additional Resources

- [README.md](../README.md) - Developer docs
- [Architecture Diagram](docs/architecture.png)
- [USGS API Docs](https://earthquake.usgs.gov/fdsnws/event/1/)
- [FastAPI Docs](https://fastapi.tiangolo.com/)
