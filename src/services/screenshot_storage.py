"""Servicio de captura de pantalla en Cloudflare R2 (feedback-screenshot-attachment).

Calca el molde "degrade gracefully" de EmailService (src/services/email_service.py):
se construye SIEMPRE en app.state con las 4 variables Optional[str], expone
`enabled = client is not None` y NUNCA lanza por falta de configuración — el
caller (el router) revisa `enabled` antes de llamar. `boto3.client(...)` NO
valida credenciales contra R2 al construirse (no abre socket), así que armar
el cliente perezoso solo cuesta la validación local de forma.

`generate_presigned_url` es cómputo local (HMAC-SHA256 sobre la request, sin
I/O de red) — ver design.md Decision 1: `boto3` síncrono alcanza sin bloquear
el loop de forma perceptible, no hace falta `aioboto3`.
"""

import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

import boto3


class ScreenshotStorageService:
    """Presign de subida (PUT) y lectura (GET) sobre un bucket R2.

    Ambos métodos asumen `self.enabled` ya chequeado por el caller — el
    servicio no valida la precondición internamente (ver tasks.md 2.2: el
    router siempre guardia con `if not storage.enabled` antes de llamar).
    """

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
        """key, upload_url, expires_at. Llamar solo si self.enabled.

        La key la genera el SERVIDOR (uuid4, nunca el cliente) — garantiza el
        formato exacto sin tener que validarlo contra un valor externo. La
        URL autoriza únicamente un PUT de Content-Type image/png sobre esa
        key exacta (scoping de S3 SigV4: la firma cubre método + bucket +
        key + headers).
        """
        key = f"feedback-screenshots/{uuid.uuid4()}.png"
        upload_url = self._client.generate_presigned_url(
            "put_object",
            Params={"Bucket": self._bucket, "Key": key, "ContentType": "image/png"},
            ExpiresIn=expires_in,
        )
        expires_at = datetime.now(timezone.utc) + timedelta(seconds=expires_in)
        return key, upload_url, expires_at

    def create_download_url(self, key: str, *, expires_in: int = 300) -> tuple[str, datetime]:
        """url, expires_at. Llamar solo si self.enabled."""
        url = self._client.generate_presigned_url(
            "get_object",
            Params={"Bucket": self._bucket, "Key": key},
            ExpiresIn=expires_in,
        )
        expires_at = datetime.now(timezone.utc) + timedelta(seconds=expires_in)
        return url, expires_at
