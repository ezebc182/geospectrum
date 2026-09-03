# Design: Captura de pantalla opcional en el panel de feedback

## Technical Approach

Este change extiende `feedback-beta-testers` (mergeado a `main`, PR #46) sin tocar ningún
contrato existente: agrega UNA columna nullable, UN endpoint nuevo, UN servicio aislado y
campos condicionales en el frontend. Sigue tres precedentes verificados del propio repo:

1. **Servicio "degrade gracefully" con flag `enabled`**: `EmailService` (`src/services/email_service.py:139-163`)
   se construye SIEMPRE en `app.state` con `api_key: Optional[str]`, expone `enabled = bool(self._api_key)`
   y cada método revisa `self.enabled` antes de tocar la red — nunca lanza por falta de config, loguea
   y devuelve un valor que el caller interpreta como "no se hizo". `ScreenshotStorageService` calca
   exactamente ese molde con las 4 variables R2 en vez de 1.
2. **Presign es CPU-ligero, no hace I/O de red**: firmar una URL S3-compatible es criptografía local
   (HMAC-SHA256 sobre la request), no un round-trip HTTP a R2. `boto3` (síncrono) alcanza sin bloquear
   el loop de forma perceptible — ver Decision 1.
3. **El binario nunca pasa por el proceso Python**: mismo criterio que evitó el costo de 8x en RAM de
   importar miniSEED (`costo-en-ram-de-importar-miniseed`) — el navegador sube directo a R2 con la URL
   prefirmada; FastAPI solo firma y persiste una key de texto.

## Architecture Decisions

### Decision 1: `boto3` síncrono (no `aioboto3`) para el presign, sin cliente en el hot path de requests concurrentes

**Choice**: `src/services/screenshot_storage.py` usa `boto3.client("s3", endpoint_url=..., ...)` —
el cliente SDK estándar de AWS, apuntado al endpoint de Cloudflare R2. El único método relevante,
`generate_presigned_url("put_object", ...)`, es **cómputo local**: construye la firma canónica
(HMAC-SHA256) sin abrir ningún socket. No hay `await` real que perder por bloquear el loop.

**Alternatives considered**:

- **`aioboto3`** — descartada. Trae `aiobotocore` + `aiohttp` como dependencias transitivas nuevas
  (el proposal ya marca a `boto3` como "relativamente pesada" para un backend que hoy no toca object
  storage; duplicar esa superficie para una operación que no hace I/O de red es peor, no mejor).
  Su ventaja real es no bloquear el loop en operaciones que SÍ hacen I/O (`put_object`, `list_objects`)
  — pero este backend nunca las llama: el `PUT` del binario lo hace el browser directo a R2, nunca
  el proceso Python (Approach del proposal, punto 2). Sin esa operación, `aioboto3` no compra nada.
- **Ejecutar el presign en threadpool (`run_in_executor`)** — descartada por sobre-ingeniería: firmar
  una URL toma microsegundos (sin red); medir antes de paralelizar es la disciplina de este repo
  (`report-lento-el-cuello-es-el-fetch` — "medido, no intuido"). Si un profiling real en prod mostrara
  latencia perceptible, este es el primer lugar para envolver — pero no se justifica sin medir.
- **Cliente creado por request** — descartada: `boto3.client(...)` valida credenciales y arma
  configuración en cada construcción; un singleton en `app.state`, igual que `EmailService`, evita
  ese costo repetido y es el patrón ya establecido para servicios con config externa.

### Decision 2: Config en `settings.py` con `Optional[str] = None`, sin fail-fast; degradación vía `ScreenshotStorageService.enabled`

**Choice**: cuatro variables nuevas en `src/config/settings.py`, mismo bloque de estilo que
`resend_api_key`/`beta_notify_email` (Optional, sin default no-vacío — "eso disfrazaría la falta de
configuración como una clave real"):

```python
# Cloudflare R2 (screenshot attachment). Optional[str] = None a propósito: sin
# configurar, POST /feedback/upload-url responde 503 y el widget sigue
# funcionando sin captura (criterio "degrada, no rompe" del proposal) — mismo
# patrón que resend_api_key/EmailService.enabled, NO fail-fast como
# auth_secret_key.
s3_endpoint_url: Optional[str] = None
s3_bucket: Optional[str] = None
s3_access_key_id: Optional[str] = None
s3_secret_access_key: Optional[str] = None
```

`ScreenshotStorageService.__init__` recibe las cuatro (todas `Optional[str]`) y construye el cliente
`boto3` de forma perezosa SOLO si las cuatro están presentes; si falta alguna, `self._client = None`.
`enabled = self._client is not None`. El servicio se instancia SIEMPRE en `app.state` (nunca
condicional en `main.py`, igual que `EmailService`) — así el router lo resuelve con el mismo
`Depends` sin ramas.

**Detección: al construir el servicio (arranque), no per-request.** La causa raíz de la config
faltante no cambia entre requests — leer 4 atributos de `Settings` en cada llamada es trabajo
repetido sin beneficio: `Settings()` ya es un singleton cargado una vez al importar el módulo
(`settings = Settings()`, última línea de `settings.py`), así que "en cada request" y "al
construir el servicio" son el mismo costo real, pero construir el cliente boto3 una vez evita
repetir esa construcción (validación de forma de las credenciales) en cada llamada al endpoint.

**Alternatives considered**:

- **Fail-fast si faltan las 4 variables** (patrón `auth_secret_key`) — descartada explícitamente:
  el proposal fija "R2 mal configurado o inalcanzable en prod tras el deploy" como riesgo con
  mitigación "el envío del reporte debe seguir funcionando sin captura" — es análogo a
  `resend_api_key`, no a `auth_secret_key` (que protege la sesión y no tiene modo degradado
  aceptable). Un fail-fast rompería el servicio `api` completo por falta de un bucket opcional.
- **Chequeo de config solo dentro del endpoint (`if not settings.s3_bucket: raise 503`)** sin un
  servicio dedicado — descartada: dispersaría la lógica de "¿está configurado?" en el router en vez
  de en un solo lugar testeable, y no da un punto único para el mock en tests (`app.state.screenshot_storage`
  reemplazable, igual que los demás servicios).
- **`ScreenshotStorageService` como método libre / helper sin clase** — descartada: rompe el patrón
  uniforme "servicio en `app.state`, resuelto por `Depends` en el router" de los otros 7 servicios de
  `main.py` (`area_service`, `wall_service`, `feedback_service`, etc.); un caso especial sin razón
  aumenta la carga cognitiva de leer `main.py`.

### Decision 3: `POST /feedback/upload-url` sin body, respuesta `{upload_url, key, expires_at}`; `POST /feedback` (create) y `PUT` no cambian su contrato salvo `screenshot_key` opcional

**Choice**:

| Endpoint | Auth | Request | Response |
|---|---|---|---|
| `POST /feedback/upload-url` | `Depends(get_current_user)` (cualquier autenticado, mismo criterio que crear un reporte) | — (sin body; el `Content-Type: image/png` lo fija el cliente en el `PUT` a R2, no en este request) | `201` + `{key: str, upload_url: str, expires_at: datetime}`; `503` si `not screenshot_storage.enabled` |
| `POST /feedback` | `Depends(get_current_user)` (sin cambio) | `FeedbackReportCreate` **+ `screenshot_key: Optional[str] = None`** | `201` + `FeedbackReportCreated` (sin cambio de forma) |
| `GET /feedback` | sin cambio | — | `FeedbackReportItem` **+ `screenshot_key: Optional[str]`** |
| `PUT /feedback/{id}/status`, `PUT /feedback/{id}/comment` | sin cambio | sin cambio | `FeedbackReportItem` con `screenshot_key` incluido (mismo `SELECT`) |

`POST /feedback/upload-url` genera `key = f"feedback-screenshots/{uuid4()}.png"` **en el backend**
(no lo manda el cliente — así el formato queda garantizado sin validarlo contra un patrón enviado
por fuera) y llama `generate_presigned_url("put_object", Params={"Bucket": ..., "Key": key,
"ContentType": "image/png"}, ExpiresIn=300)` (5 min). La URL resultante autoriza **solo** un
`PUT` de ese objeto exacto con `Content-Type: image/png` — no lista ni lee el bucket, no autoriza
ninguna otra key (scoping de S3 SigV4: la firma cubre método + bucket + key + headers exactos).

`FeedbackReportCreate.screenshot_key` se valida con un `Field(pattern=...)` que exige el formato
exacto `feedback-screenshots/{uuid}.png` — **validación de forma únicamente, sin llamar a R2**
(el proposal lo fija explícito: "basic shape validation only, no R2 existence check"). Un
`screenshot_key` con formato inválido ⇒ 422 antes de tocar la base; uno bien formado pero que no
existe en el bucket (upload falló pero el cliente igual lo mandó) se persiste igual — el
`FeedbackCard` que intente mostrar un thumbnail roto es un problema de UI, no de integridad de
datos, y es exactamente el caso "capture/upload falla → clave se descarta en el cliente" que el
flujo del widget evita en el 99% de los casos (Decision 5).

**Por qué DOS round-trips (`POST /feedback/upload-url` antes de `POST /feedback`) y no un presign
plegado dentro del create**: el proposal deja la elección abierta con el criterio "argumentar
contra diff mínimo al submit existente". La captura ocurre al ABRIR el widget (decisión de usuario
no negociable), minutos antes de que el tester escriba el body y envíe — el presign y el `PUT` a
R2 YA terminaron (o fallaron) antes de que exista un `POST /feedback` que hacer. Plegar el presign
dentro del create obligaría a: (a) hacerlo síncrono con el submit (recapturar la latencia que la
captura-al-abrir buscaba evitar), o (b) mandar el PNG en el body del create (exactamente el
"backend nunca proxea el binario" que el proposal prohíbe). Dos endpoints separados son la única
forma consistente con "captura automática al abrir, no bloqueante".

**Alternatives considered**:

- **Presign plegado en `POST /feedback`** (mencionada en el proposal como opción) — descartada por
  la razón temporal de arriba: el momento de la captura (abrir) y el del submit (después de
  escribir) no coinciden, así que un solo round-trip no es posible sin cambiar la UX ya decidida.
- **Content-Type hint en el request de `POST /feedback/upload-url`** — descartada: el backend fija
  `image/png` siempre (`modern-screenshot` solo produce PNG en este flujo, es la única librería
  usada); aceptar un hint del cliente sin validarlo contra nada es superficie sin beneficio.
- **`GET /feedback/upload-url`** (semánticamente "leer una URL") — descartada: la operación tiene
  efecto observable (genera y reserva una key nueva cada vez que se llama, aunque no persista nada
  todavía) — `POST` es el verbo correcto para "creame algo", con precedente en `POST /feedback`
  mismo.
- **Respuesta sin `expires_at`** — descartada: el cliente no lo necesita para operar (el `PUT`
  simplemente falla tras el vencimiento), pero incluirlo es gratis y documenta el contrato para
  quien lea la respuesta en devtools durante debugging.

### Decision 4: Admin board — URLs de lectura firmadas por request (`GET /feedback/{id}/screenshot-url`), NO bucket público ni URL embebida en `FeedbackReportItem`

**Choice**: R2 no es público por default y no hay ninguna decisión previa en el proposal de
hacerlo público (el Risk del proposal ya trata la superficie de escritura con cautela; una lectura
pública sería más laxa, no menos). Se agrega un quinto endpoint, `GET
/feedback/{report_id}/screenshot-url`, `Depends(get_current_user)` (mismo criterio que `GET
/feedback`: cualquier autenticado ve todo el tablero) — responde `{url: str, expires_at: datetime}`
con `generate_presigned_url("get_object", ...)`, `ExpiresIn=300`, `404` si `screenshot_key is None`.
El frontend lo llama de forma perezosa (al abrir el lightbox o al entrar en viewport de la tarjeta,
a definir en tasks) y usa la URL resultante como `src` de un `<img>` normal.

**Por qué NO devolver una URL firmada dentro de `FeedbackReportItem` (en el `GET /feedback` que
lista TODO el tablero)**: firmar `N` URLs de lectura en cada `GET /feedback` es trabajo (HMAC) que
se paga aunque nadie abra el thumbnail, y las URLs firmadas heredadas expiran a los 5 min —
un tablero abierto 10 min tendría thumbnails rotos sin que el usuario refrescara. Firmar bajo
demanda (un endpoint por reporte, llamado cuando el thumbnail realmente se renderiza o se abre)
paga el costo solo cuando hace falta y evita el problema de expiración silenciosa.

**Alternatives considered**:

- **Bucket R2 público + URL derivada de `S3_PUBLIC_URL_BASE`** (mencionado en el proposal como
  posible variable de settings) — descartada para este change: expone el contenido de CUALQUIER
  captura (que puede incluir sesión/datos de otro tester en pantalla, Risk ya documentado en el
  proposal) a cualquiera con la URL, sin auth. Queda como variable de settings **no usada todavía**
  (`s3_public_url_base` NO se agrega — no hay caso de uso sin la decisión explícita de hacer el
  bucket público, y agregar una variable sin consumidor es la clase de "config fantasma" que este
  repo evita).
- **Backend proxea el binario en la lectura** (`GET /feedback/{id}/screenshot` devuelve los bytes) —
  descartada: exactamente el patrón que el proposal prohíbe para la escritura ("el backend FastAPI
  nunca hace proxy del binario"); no hay razón para tratar la lectura distinto — el mismo argumento
  de costo en RAM/latencia aplica.
- **URL firmada embebida en cada `FeedbackReportItem`** — descartada por la razón de expiración de
  arriba.

## Data Flow

```
Camino feliz (captura y subida exitosas):

  FeedbackWidget se abre
       │
       ▼
  modern-screenshot captura <body> (no bloqueante, en paralelo a que el
  tester empieza a escribir el body)
       │
       ├─ walk DOM: algún <canvas> con getContext('webgl'|'webgl2') no-null?
       │      sí → aviso "puede no incluir el globo 3D" (no bloquea)
       │      no → sin aviso
       ▼
  PNG en memoria (blob) ── preview/spinner en el widget
       │
       ▼
  POST /feedback/upload-url ── get_current_user ──► 503 si R2 no configurado
       │                                             (screenshot_storage.enabled == False)
       ▼
  201 {key, upload_url, expires_at}
       │
       ▼
  PUT upload_url  (browser → R2 directo, binario nunca pasa por FastAPI)
       │
       ├─ éxito ──► key queda en el estado del widget
       └─ falla  ──► key se descarta, sin aviso al usuario (no accionable)
       ▼
  tester completa type + body, click enviar
       ▼
  POST /feedback  { type, body, route, url, user_agent, screenshot_key? }
       │                    get_current_user (401) · Pydantic 422 (formato de key o límites)
       ▼
  201 {id, created_at}                    FeedbackService.create(): INSERT con
                                           screenshot_key (o NULL si no hubo captura)


Camino sin captura (fallo en cualquier paso previo, o R2 no configurado):

  captura falla / WebGL detectado sin más acción / presign 503 / PUT falla
       │
       ▼
  key permanece null en el estado del widget — SIN error visible al tester
       ▼
  POST /feedback  { ..., screenshot_key: null }  ── idéntico al flujo actual
       ▼
  201 {id, created_at}   (criterio de éxito del proposal: nunca bloquea el envío)


Lectura en el tablero admin:

  FeedbackCard con screenshot_key != null
       │
       ▼
  GET /feedback/{id}/screenshot-url ── get_current_user ──► 404 si screenshot_key es null
       │
       ▼
  200 {url, expires_at}  (presigned GET, 5 min)
       │
       ▼
  <img src={url}> como thumbnail; click abre lightbox con la misma URL a tamaño completo
  (o refetch si expiró entre el thumbnail y el click — a definir el margen exacto en tasks)
```

## File Changes

| File | Action | Description |
|------|--------|--------------|
| `deploy/sql/migrations/020_feedback_screenshot.sql` | Create | `ALTER TABLE feedback_reports ADD COLUMN IF NOT EXISTS screenshot_key TEXT NULL`, idempotente |
| `src/config/settings.py` | Modify | 4 variables `Optional[str] = None`: `s3_endpoint_url`, `s3_bucket`, `s3_access_key_id`, `s3_secret_access_key` |
| `src/services/screenshot_storage.py` | Create | `ScreenshotStorageService`: `__init__` perezoso (cliente `None` si falta config), `enabled` property, `create_upload_url()`, `create_download_url(key)` |
| `src/models/feedback.py` | Modify | `screenshot_key: Optional[str]` en `FeedbackReportCreate` (con `Field(pattern=...)`) y en `FeedbackReportItem`; nuevos `ScreenshotUploadUrl` `{key, upload_url, expires_at}` y `ScreenshotDownloadUrl` `{url, expires_at}` |
| `src/services/feedback_service.py` | Modify | `create()` inserta `screenshot_key`; `_row_to_item` lo lee; `_ITEM_COLUMNS` incluye la columna |
| `src/api/routers/feedback.py` | Modify | `POST /feedback/upload-url` y `GET /feedback/{id}/screenshot-url` nuevos; `_get_screenshot_storage(request)` (molde `_get_feedback_service`) |
| `src/main.py` | Modify | Aditivo: `app.state.screenshot_storage = ScreenshotStorageService(...)` (junto a `feedback_service`, l.393) |
| `requirements.txt` | Modify | Agregar `boto3` |
| `dashboard/package.json` | Modify | Agregar `modern-screenshot` |
| `dashboard/lib/feedback.ts` | Modify | `screenshot_key` en `FeedbackPayload`/`FeedbackReport`; `requestScreenshotUploadUrl()`, `getScreenshotDownloadUrl(id)` |
| `dashboard/lib/screenshot.ts` | Create | `captureScreenshot()` (wrapper de `modern-screenshot`), `detectWebglCanvas()` (walk DOM), `uploadScreenshot(blob)` (presign + `PUT` directo a R2, retorna `key | null`) |
| `dashboard/lib/screenshot.test.ts` | Create | `detectWebglCanvas`: true/false con canvas mockeado; `uploadScreenshot`: éxito devuelve key, fallo en presign o PUT devuelve `null` sin lanzar |
| `dashboard/components/feedback/FeedbackWidget.tsx` | Modify | Dispara captura al abrir (no al submit); estado `screenshotKey`, spinner/preview, aviso WebGL no bloqueante; incluye `screenshot_key` en el submit |
| `dashboard/components/feedback/FeedbackCard.tsx` | Modify | Thumbnail condicional (`screenshot_key !== null`) vía `GET .../screenshot-url` perezoso |
| `dashboard/components/feedback/FeedbackCardDetail.tsx` | Modify | Lightbox (a implementar — ver Decision de UI en tasks; sin primitivo Radix de imagen en `ui/`, se evalúa `ui/dialog.tsx` con `<img>` a tamaño completo como opción mínima) |
| `dashboard/messages/{es,en}.json` | Modify | Strings del aviso WebGL, estado de subida, thumbnail/lightbox (paridad es/en) |

## Interfaces / Contracts

```python
# src/models/feedback.py — agregados

import re
from pydantic import Field, field_validator

_SCREENSHOT_KEY_PATTERN = re.compile(
    r"^feedback-screenshots/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$"
)


class FeedbackReportCreate(BaseModel):
    # ...campos existentes sin cambio...
    screenshot_key: Optional[str] = None

    @field_validator("screenshot_key")
    @classmethod
    def _validate_screenshot_key(cls, value: Optional[str]) -> Optional[str]:
        # Validación de FORMA únicamente — el proposal excluye explícitamente
        # verificar existencia contra R2 (costaría una llamada de red por
        # cada creación de reporte, y el objeto puede llegar unos segundos
        # después por eventual consistency de todos modos).
        if value is not None and not _SCREENSHOT_KEY_PATTERN.match(value):
            raise ValueError("screenshot_key must match feedback-screenshots/{uuid}.png")
        return value


class FeedbackReportItem(BaseModel):
    # ...campos existentes sin cambio...
    screenshot_key: Optional[str] = None


class ScreenshotUploadUrl(BaseModel):
    """Respuesta de POST /feedback/upload-url."""
    key: str
    upload_url: str
    expires_at: datetime


class ScreenshotDownloadUrl(BaseModel):
    """Respuesta de GET /feedback/{id}/screenshot-url."""
    url: str
    expires_at: datetime
```

```python
# src/services/screenshot_storage.py — firmas

class ScreenshotStorageService:
    def __init__(
        self,
        endpoint_url: Optional[str],
        bucket: Optional[str],
        access_key_id: Optional[str],
        secret_access_key: Optional[str],
    ) -> None:
        self._bucket = bucket
        self._client = (
            boto3.client(
                "s3",
                endpoint_url=endpoint_url,
                aws_access_key_id=access_key_id,
                aws_secret_access_key=secret_access_key,
                # R2 usa el sigv4 estándar de S3; region_name es requerido por
                # el SDK aunque R2 lo ignore ("auto" es la convención de Cloudflare).
                region_name="auto",
            )
            if all([endpoint_url, bucket, access_key_id, secret_access_key])
            else None
        )

    @property
    def enabled(self) -> bool:
        return self._client is not None

    def create_upload_url(self, *, expires_in: int = 300) -> tuple[str, str, datetime]:
        """key, upload_url, expires_at. Llamar solo si self.enabled."""
        ...

    def create_download_url(self, key: str, *, expires_in: int = 300) -> tuple[str, datetime]:
        """url, expires_at. Llamar solo si self.enabled."""
        ...
```

```python
# src/api/routers/feedback.py — firmas nuevas

def _get_screenshot_storage(request: Request) -> ScreenshotStorageService:
    return request.app.state.screenshot_storage


@router.post("/upload-url", response_model=ScreenshotUploadUrl, status_code=201)
async def create_upload_url(
    current_user: CurrentUser = Depends(get_current_user),
    storage: ScreenshotStorageService = Depends(_get_screenshot_storage),
) -> ScreenshotUploadUrl:
    if not storage.enabled:
        raise HTTPException(status_code=503, detail="screenshot storage not configured")
    key, upload_url, expires_at = storage.create_upload_url()
    return ScreenshotUploadUrl(key=key, upload_url=upload_url, expires_at=expires_at)


@router.get("/{report_id}/screenshot-url", response_model=ScreenshotDownloadUrl)
async def get_screenshot_url(
    report_id: UUID,
    current_user: CurrentUser = Depends(get_current_user),
    feedback_service: FeedbackService = Depends(_get_feedback_service),
    storage: ScreenshotStorageService = Depends(_get_screenshot_storage),
) -> ScreenshotDownloadUrl:
    # 404 si el reporte no existe O no tiene screenshot_key (mismo código,
    # el cliente no distingue "no existe" de "no tiene captura").
    ...
```

```typescript
// dashboard/lib/screenshot.ts — contrato

export async function captureScreenshot(): Promise<Blob | null>;
/** Recorre document.querySelectorAll('canvas'); true ante el primer
 *  getContext('webgl'|'webgl2') no-null. Falsos positivos aceptables,
 *  falsos negativos son el riesgo real (proposal). */
export function detectWebglCanvas(): boolean;
/** presign + PUT directo a R2. Nunca lanza: cualquier fallo devuelve null. */
export async function uploadScreenshot(blob: Blob): Promise<string | null>;
```

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit (backend) | `FeedbackReportCreate.screenshot_key`: `None` OK, formato válido OK, `"../etc/passwd"` / sin extensión `.png` / UUID malformado ⇒ error. `ScreenshotStorageService`: las 4 vars presentes ⇒ `enabled=True`; falta 1 de las 4 (las 4 combinaciones) ⇒ `enabled=False`, sin excepción al construir | pytest, sin base ni mocks de red (`tests/unit/test_feedback_models.py`, `tests/unit/test_screenshot_storage.py`) |
| Integration (backend) — presign auth | `POST /feedback/upload-url` sin sesión ⇒ 401; con sesión (cualquier rol, viewer incluido) ⇒ 201 con `{key, upload_url, expires_at}`; `key` matchea el patrón `feedback-screenshots/{uuid}.png` | testcontainer, molde `test_feedback_api.py`; mockear `ScreenshotStorageService` en `app.state` con credenciales fake de un R2 de test, o inyectar un stub con `enabled=True` fijo si no hay bucket de test disponible en CI |
| Integration (backend) — degradación | `app.state.screenshot_storage` construido con las 4 vars en `None` (config real de un entorno sin R2) ⇒ `POST /feedback/upload-url` responde 503; `POST /feedback` CON `screenshot_key` válido en el body sigue respondiendo 201 igual (el create no depende de `storage.enabled`) | ídem, verificación explícita del criterio de éxito "R2 mal configurado no rompe el envío" |
| Integration (backend) — create con/sin key | `POST /feedback` sin `screenshot_key` ⇒ 201, SELECT muestra `screenshot_key IS NULL`; con key válida ⇒ 201, SELECT la persiste tal cual; con key de formato inválido ⇒ 422 y cero filas | ídem |
| Integration (backend) — lectura de screenshot-url | `GET /feedback/{id}/screenshot-url` con reporte sin `screenshot_key` ⇒ 404; con key ⇒ 200 `{url, expires_at}`; UUID inexistente ⇒ 404 | ídem |
| Integration (backend) — migración | `_migrated` aplica la 020 tras la 019 por orden de glob; segundo `apply_migrations` no-op; columna nullable no rompe filas insertadas por la 019 sin `screenshot_key` (no aplica, la columna nace en la 020, pero si hay filas de una corrida previa de la 019 sola, deben seguir válidas) | ídem |
| Unit (frontend) | `detectWebglCanvas`: `document.querySelectorAll` mockeado con canvases stub (`getContext` devolviendo un objeto para `'webgl'`/`'webgl2'` vs `null` para ambos) ⇒ true/false; `uploadScreenshot`: `fetch` mockeado — presign 503 ⇒ `null` sin lanzar; presign 201 + `PUT` que rechaza (network error o !ok) ⇒ `null`; ambos éxito ⇒ devuelve la `key` | Vitest, `mockFetch` de `walls.test.ts` |
| Component (frontend) | `FeedbackWidget`: al abrir dispara `captureScreenshot` (mock) sin bloquear el render del formulario (el tester puede escribir antes de que resuelva); si `uploadScreenshot` resuelve `null`, el submit manda `screenshot_key: undefined`/ausente sin mostrar error; si resuelve una key, el submit la incluye. `FeedbackCard`: con `screenshot_key` no-null renderiza el thumbnail (mock de `GET screenshot-url`); sin key, no renderiza nada de imagen | Vitest + Testing Library |
| Manual (usuario) | Aviso WebGL aparece en `/live` (SeismicGlobe) y NO en una vista de espectrograma pura; captura real sube a R2 y se ve en el tablero; URL prefirmada expirada (reintentada tras 5+ min) es rechazada por R2 con 403; reporte enviado con R2 mal configurado en Railway sigue creando la fila | criterios de éxito explícitos del proposal, QA del usuario |

### Mutaciones críticas para la fase de tasks

| # | Mutación | Test que debe morir |
|---|---|---|
| M1 | Quitar `Depends(get_current_user)` en `POST /feedback/upload-url` | sin sesión ⇒ debe seguir dando 401, no 201 |
| M2 | Quitar el chequeo `if not storage.enabled: raise 503` | R2 sin configurar ⇒ debe dar 503, no lanzar `AttributeError`/500 al llamar boto3 con cliente `None` |
| M3 | Quitar `_validate_screenshot_key` (o el regex) | `screenshot_key` con formato inválido ⇒ debe dar 422, no persistir basura |
| M4 | `ExpiresIn=300` → un valor mucho mayor o ausente (URL sin expiración real) | una URL vieja reintentada tras 5+ min debe ser rechazada por R2 (test de integración contra R2 real o de contrato con el SDK) |
| M5 | Hacer que `POST /feedback` dependa de `storage.enabled` (agregar un chequeo que no debería estar ahí) | `POST /feedback` con `screenshot_key=None` y R2 sin configurar debe seguir dando 201 |
| M6 | Quitar el 404 cuando `screenshot_key is None` en `GET .../screenshot-url` | debe dar 404, no intentar firmar `create_download_url(None)` |
| M7 | En el frontend, hacer que un fallo de `uploadScreenshot` bloquee o retrase el submit | el submit debe seguir habilitado y funcionar con `screenshot_key` ausente aunque la captura/subida no haya terminado o haya fallado |

## Migration / Rollout

1. **Deploy backend**: la 020 se auto-aplica al arranque (mismo mecanismo verificado desde la 015);
   aditiva e idempotente, no requiere que la 019 haya corrido en una release separada (pueden
   aplicarse ambas en el mismo arranque si este change se despliega junto con `feedback-beta-testers`,
   o después, si esa ya está en prod — el glob ordenado las aplica en secuencia cualquiera sea el caso).
2. **Deploy frontend**: Vercel, aditivo.
3. **Bloqueante de rollout (no de implementación/verify)**: bucket R2 + token API creados manualmente
   en Cloudflare, credenciales cargadas en los secrets del servicio `api` de Railway. Sin esto,
   `ScreenshotStorageService.enabled` es `False` en prod: `POST /feedback/upload-url` responde 503,
   el widget no adjunta captura, pero el envío de reportes sigue funcionando de punta a punta
   (mismo criterio que "promover a admin" del change base — el SDD avanza entero sin esto resuelto).
4. **Rollback**: revertir el commit (todo aditivo: columna nullable, dos endpoints nuevos, servicio
   aislado). Limpieza manual opcional: `ALTER TABLE feedback_reports DROP COLUMN screenshot_key;`.
   El bucket R2 queda huérfano sin costo (nada más del stack lo lee).

## Open Questions

- [ ] **Componente de lightbox**: no existe ningún primitivo de imagen/carousel en `dashboard/components/ui/`
  (verificado: solo `alert-dialog`, `dialog`, `dropdown-menu`, `sheet`, etc., ninguno pensado para
  media). La opción mínima es reusar `ui/dialog.tsx` con un `<img>` a `max-width/max-height` — la
  fase de tasks debe decidir si eso alcanza o si vale la pena un componente `Lightbox` dedicado
  (zoom, cerrar con Escape ya lo da `Dialog`). No bloquea el resto del design.
- [ ] **Margen de expiración thumbnail→lightbox**: si el thumbnail firma una URL de lectura y el
  tester tarda más de 5 min en hacer click para el lightbox, esa URL ya expiró. La fase de tasks
  debe decidir si el lightbox re-pide `GET .../screenshot-url` en vez de reusar la URL del
  thumbnail (recomendado: re-pedir siempre al abrir, nunca cachear la URL firmada más allá del
  render inmediato).
- [ ] **`s3_public_url_base`** mencionada en el proposal como variable "para later display" —
  decisión explícita de este design: NO se agrega todavía (Decision 4). Si una futura decisión de
  producto hace público el bucket, se agrega en un change aparte con su propia justificación de
  riesgo.
