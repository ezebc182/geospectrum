# Kubernetes Deployment

Manifests para deployment production-ready en Kubernetes.

## Prerequisitos

- Kubernetes cluster (v1.24+)
- kubectl configurado
- Ingress controller (NGINX recomendado)
- cert-manager (opcional, para TLS automático)
- Prometheus Operator (opcional, para métricas)

## Deployment rápido

```bash
# Aplicar todos los manifests
kubectl apply -k deploy/k8s/

# O manualmente
kubectl apply -f deploy/k8s/namespace.yaml
kubectl apply -f deploy/k8s/configmap.yaml
kubectl apply -f deploy/k8s/secret.yaml
kubectl apply -f deploy/k8s/deployment.yaml
kubectl apply -f deploy/k8s/deployment-inpres-adapter.yaml
kubectl apply -f deploy/k8s/service.yaml
kubectl apply -f deploy/k8s/hpa.yaml
kubectl apply -f deploy/k8s/ingress.yaml
```

## Verificación

```bash
# Pods
kubectl get pods -n seismic-monitor

# Services
kubectl get svc -n seismic-monitor

# Ingress
kubectl get ingress -n seismic-monitor

# Logs
kubectl logs -f -n seismic-monitor -l app=seismic-monitor
```

## Configuración

### Secrets

Antes de deploy, actualizar `secret.yaml` con credenciales reales o usar:

```bash
# Crear secret desde archivo
kubectl create secret generic seismic-monitor-secrets \
  --from-literal=TIMESCALEDB_PASSWORD=your-password \
  --from-literal=SENTRY_DSN=your-dsn \
  -n seismic-monitor
```

### Ingress

Editar `ingress.yaml` y cambiar:
- `seismic.example.com` → tu dominio real
- Anotar con tu ingress controller específico

### Images

Editar `kustomization.yaml` y actualizar:
- Registry path
- Tags de versiones

## HPA (Auto-scaling)

El HPA escala automáticamente entre 2-10 réplicas basado en:
- CPU: 70% utilization
- Memory: 80% utilization

Ajustar según tu carga esperada.

## Monitoring

Si usas Prometheus Operator:

```bash
kubectl apply -f deploy/k8s/servicemonitor.yaml
```

## Security Considerations

- Pods corren como non-root (UID 1000)
- readOnlyRootFilesystem habilitado
- Capabilities dropped
- NetworkPolicy recomendado (crear según tu cluster)
