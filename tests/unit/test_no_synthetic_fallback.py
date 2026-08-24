"""El fallback sintético se borró: generaba imágenes que el frontend descarta.

El cliente filtra por `metadata.network !== 'SYNTHETIC'`
(dashboard/components/SpectrogramViewReal.tsx:74) y muestra el error
`noNearbyStation`. O sea: el backend gastaba matplotlib en una imagen que
nadie mira nunca. Al no haber estación real, ahora se devuelve el error
directo.
"""

import inspect

from src.services.spectrogram_service import SpectrogramService


def test_no_queda_generador_sintetico():
    assert not hasattr(SpectrogramService, "generate_synthetic_spectrogram")


def test_sin_estacion_real_no_se_cae_a_sintetico():
    fuente = inspect.getsource(SpectrogramService.generate_spectrogram_for_location)
    assert "synthetic" not in fuente.lower()


def test_el_servicio_ya_no_menciona_SYNTHETIC():
    fuente = inspect.getsource(SpectrogramService)
    assert "SYNTHETIC" not in fuente
