# Seismic Monitor Service - Operational Runbook

**For on-call engineers and SREs**

---

## Service Overview

**Purpose**: Real-time seismic monitoring with USGS + INPRES integration

**Criticality**: High (infrastructure protection, public safety)

**SLA**: 99.9% uptime, <10s p99 latency

**On-call**: #seismic-ops Slack channel

---

## Architecture Summary

```
External APIs → Seismic Monitor → Prometheus/Alerts → PagerDuty
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
| `seismic_monitor_requests_total`            | Rate of API requests  |
| `seismic_monitor_events_fetched_total`      | Events by source      |
| `seismic_monitor_data_source_errors_total`  | >10/min               |
| `seismic_monitor_request_duration_seconds`  | p99 >5s               |
| `up{job="seismic-monitor"}`                 | 0 (down)              |

### Dashboards

- **Grafana**: `https://grafana.example.com/d/seismic-monitor`
- **Prometheus**: `https://prometheus.example.com`

### Log Aggregation

- **Kibana/CloudWatch/Loki**: Search `namespace:seismic-monitor`

---

## Common Incidents

### 1. Service Down / Pod CrashLooping

**Symptoms**:
- PagerDuty alert: "Seismic Monitor Down"
- `/health` returning 503
- Pods in CrashLoopBackOff

**Diagnosis**:

```bash
# Check pod status
kubectl get pods -n seismic-monitor

# Check logs
kubectl logs -n seismic-monitor -l app=seismic-monitor --tail=100

# Describe pod for events
kubectl describe pod <pod-name> -n seismic-monitor
```

**Common Causes**:

a) **Config error** (bad env var)
   - Fix: Check ConfigMap/Secret
   - `kubectl edit configmap seismic-monitor-config -n seismic-monitor`

b) **Dependency unreachable** (INPRES adapter down)
   - Check: `kubectl get pods -n seismic-monitor | grep inpres`
   - Restart: `kubectl rollout restart deployment/inpres-adapter -n seismic-monitor`

c) **OOMKilled** (out of memory)
   - Increase memory limit in deployment.yaml
   - `kubectl set resources deployment/seismic-monitor --limits=memory=1Gi -n seismic-monitor`

**Resolution**:

```bash
# Restart deployment
kubectl rollout restart deployment/seismic-monitor -n seismic-monitor

# Monitor rollout
kubectl rollout status deployment/seismic-monitor -n seismic-monitor
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
# Query: rate(seismic_monitor_data_source_errors_total[5m])

# Check service logs
kubectl logs -n seismic-monitor -l app=seismic-monitor | grep ERROR
```

**Common Causes**:

a) **USGS API timeout/unavailable**
   - External service issue
   - Check USGS status: https://earthquake.usgs.gov/
   - Service degrades gracefully (returns USGS-only or INPRES-only data)

b) **INPRES scraper broken** (site structure changed)
   - Check INPRES adapter: `curl http://<adapter-url>:8001/recent`
   - If empty/error → INPRES site changed
   - Requires code fix in `src/adapters/inpres_adapter.py`

**Resolution**:

- **Short-term**: Service continues with degraded mode (single source)
- **Long-term**: Fix adapter, deploy new version

**Escalation**: If both sources fail, escalate immediately.

---

### 3. High Latency (p99 >5s)

**Symptoms**:
- Slow API responses
- Prometheus alert: "Seismic Monitor High Latency"

**Diagnosis**:

```bash
# Check request duration
# Prometheus query: histogram_quantile(0.99, rate(seismic_monitor_request_duration_seconds_bucket[5m]))

# Check pod CPU/memory
kubectl top pods -n seismic-monitor

# Check HPA status
kubectl get hpa -n seismic-monitor
```

**Common Causes**:

a) **High load** (spike in requests)
   - HPA should auto-scale
   - Verify: `kubectl get hpa seismic-monitor-hpa -n seismic-monitor`
   - If not scaling → check HPA config

b) **Slow external API** (USGS/INPRES timeout)
   - Check external service status
   - Increase timeout: `USGS_TIMEOUT_S`, `INPRES_TIMEOUT_S`

c) **Resource contention** (CPU throttling)
   - Check: `kubectl describe pod <pod-name> -n seismic-monitor`
   - Increase CPU limits

**Resolution**:

```bash
# Manual scale (if HPA not working)
kubectl scale deployment/seismic-monitor --replicas=5 -n seismic-monitor

# Increase timeouts (if external APIs slow)
kubectl set env deployment/seismic-monitor USGS_TIMEOUT_S=10 -n seismic-monitor
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
kubectl set env deployment/seismic-monitor MIN_MAG_ALERT=4.0 -n seismic-monitor

# Decrease window
kubectl set env deployment/seismic-monitor WINDOW_MINUTES=30 -n seismic-monitor
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
kubectl logs -n seismic-monitor -l app=seismic-monitor | grep -i "events"
```

**Common Causes**:

a) **Legitimately no seismic activity** (good news!)
   - Verify with external sources (USGS website, news)

b) **Region misconfigured** (bbox wrong)
   - Check: `kubectl get configmap seismic-monitor-config -n seismic-monitor -o yaml`
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
kubectl set image deployment/seismic-monitor seismic-monitor=<new-image> -n seismic-monitor

# Monitor rollout
kubectl rollout status deployment/seismic-monitor -n seismic-monitor

# Rollback if issues
kubectl rollout undo deployment/seismic-monitor -n seismic-monitor
```

### Configuration Change

```bash
# Edit config
kubectl edit configmap seismic-monitor-config -n seismic-monitor

# Restart to pick up changes
kubectl rollout restart deployment/seismic-monitor -n seismic-monitor
```

### Scaling

```bash
# Manual scale
kubectl scale deployment/seismic-monitor --replicas=5 -n seismic-monitor

# Adjust HPA
kubectl edit hpa seismic-monitor-hpa -n seismic-monitor
```

---

## Maintenance Windows

### Planned Maintenance

1. Announce in #seismic-ops Slack 24h in advance
2. Schedule during low-activity hours (if possible)
3. Put service in maintenance mode (optional):
   ```bash
   kubectl scale deployment/seismic-monitor --replicas=0 -n seismic-monitor
   ```
4. Perform maintenance
5. Restore:
   ```bash
   kubectl scale deployment/seismic-monitor --replicas=2 -n seismic-monitor
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
   kubectl get all -n seismic-monitor
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
| Service down              | #seismic-ops → PagerDuty     | Immediate    |
| Data source issue         | #seismic-ops                 | 1 hour       |
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
