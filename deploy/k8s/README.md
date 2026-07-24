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
kubectl get pods -n geospectrum

# Services
kubectl get svc -n geospectrum

# Ingress
kubectl get ingress -n geospectrum

# Logs
kubectl logs -f -n geospectrum -l app=geospectrum
```

## Configuración

### Secrets

Antes de deploy, actualizar `secret.yaml` con credenciales reales o usar:

```bash
# Crear secret desde archivo
kubectl create secret generic geospectrum-secrets \
  --from-literal=TIMESCALEDB_PASSWORD=your-password \
  --from-literal=SENTRY_DSN=your-dsn \
  -n geospectrum
```

### Auth / Google OAuth (pendiente — fuera de alcance)

Ni `multi-user-auth` ni `google-oauth` definieron alcance de Kubernetes en sus
respectivos `proposal.md`/`design.md`. Por eso `secret.yaml` y `configmap.yaml`
NO incluyen `AUTH_SECRET_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` ni
`GOOGLE_REDIRECT_URI` — el rollout de auth en K8s queda pendiente de definir
(ver `.env.example` en la raíz del repo y `deploy/docker/docker-compose.yml`
para el equivalente ya documentado en Docker).

Riesgo si se deployea igual a K8s sin definir esto:
- Sin `AUTH_SECRET_KEY`: el proceso falla fail-fast al arrancar (`lifespan()`
  en `src/main.py`) → el pod entra en CrashLoopBackOff.
- Sin `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_REDIRECT_URI`: el pod
  arranca igual (`google_oauth_configured=False`), los endpoints
  `/auth/google/*` responden `503` y el resto del sistema (incluido login por
  password, si `AUTH_SECRET_KEY` está seteado) no se ve afectado — riesgo
  menor que el de `AUTH_SECRET_KEY`.

### Ingress

Editar `ingress.yaml` y cambiar:
- `geospectrum.org` → tu dominio real
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
