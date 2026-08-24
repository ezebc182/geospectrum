"""Reducción de columnas de espectrograma al ancho del canvas.

Por qué existe: las tarjetas de /spectrograms-live pedían un PNG generado con
matplotlib en el servidor (24 h de FDSN + render + base64 = ~152 KB y decenas
de segundos por tarjeta). El dato ya vive en TimescaleDB, pero devolverlo
crudo es peor: 24 h de un canal son ~21.600 columnas, y `/history` ya entrega
1,3 MB con apenas 655.

El canvas mide ~400 px y dibuja UNA columna por píxel: todo lo que exceda ese
ancho se descarta al pintar. Reducir en el backend es mandar exactamente lo
que se va a ver.
"""

import numpy as np

from src.services.spectrogram_downsample import downsample_columns


def _col(endtime: str, power: list[float]) -> dict:
    return {"endtime": endtime, "freqs": [1.0, 2.0, 3.0], "power_db": power}


class TestDownsampleColumns:
    def test_menos_columnas_que_el_ancho_pasan_intactas(self):
        # Sin dato de sobra no hay nada que reducir: agregar acá sólo
        # inventaría columnas que nadie midió.
        cols = [_col("2026-08-24T01:00:00Z", [10.0, 20.0, 30.0])]
        assert downsample_columns(cols, 400) == cols

    def test_reduce_al_ancho_pedido(self):
        cols = [_col(f"2026-08-24T01:00:{i:02d}Z", [float(i)] * 3) for i in range(60)]
        assert len(downsample_columns(cols, 10)) == 10

    def test_conserva_el_PICO_y_no_el_promedio(self):
        """El criterio de dominio: un sismo ES el pico.

        Promediar en dB —que además es logarítmico— aplanaría justo el evento
        que el operador está buscando. Mismo razonamiento que la decimación
        min/max de station_waveform.py.
        """
        # Bloque de ruido bajo con UN pico: el pico tiene que sobrevivir.
        cols = [_col(f"2026-08-24T01:00:{i:02d}Z", [20.0] * 3) for i in range(9)]
        cols.append(_col("2026-08-24T01:00:09Z", [95.0, 20.0, 20.0]))

        reducido = downsample_columns(cols, 1)

        assert len(reducido) == 1
        # 95 dB (el sismo), no 27.5 (el promedio que lo escondería).
        assert reducido[0]["power_db"][0] == 95.0

    def test_conserva_el_pico_por_cada_bin_de_frecuencia(self):
        # El pico puede estar en frecuencias distintas en columnas distintas:
        # colapsar bin por bin, no elegir "la columna más fuerte".
        cols = [
            _col("2026-08-24T01:00:00Z", [90.0, 20.0, 20.0]),
            _col("2026-08-24T01:00:01Z", [20.0, 80.0, 20.0]),
        ]
        reducido = downsample_columns(cols, 1)
        assert reducido[0]["power_db"] == [90.0, 80.0, 20.0]

    def test_el_endtime_es_el_del_final_del_bloque(self):
        # El eje de tiempo del canvas se lee de estos timestamps: usar el del
        # final mantiene la columna alineada con el instante que representa.
        cols = [_col(f"2026-08-24T01:00:{i:02d}Z", [20.0] * 3) for i in range(5)]
        reducido = downsample_columns(cols, 1)
        assert reducido[0]["endtime"] == "2026-08-24T01:00:04Z"

    def test_conserva_los_freqs(self):
        # El eje de frecuencia cambia por canal (10/20/25 Hz según estación):
        # perderlo acá dibujaría el espectrograma con la escala equivocada.
        cols = [_col(f"2026-08-24T01:00:{i:02d}Z", [20.0] * 3) for i in range(10)]
        assert downsample_columns(cols, 2)[0]["freqs"] == [1.0, 2.0, 3.0]

    def test_lista_vacia_no_revienta(self):
        assert downsample_columns([], 400) == []

    def test_ancho_cero_o_negativo_no_revienta(self):
        cols = [_col("2026-08-24T01:00:00Z", [20.0] * 3)]
        assert downsample_columns(cols, 0) == []
        assert downsample_columns(cols, -5) == []

    def test_el_peso_baja_de_verdad(self):
        """La razón de ser de todo esto, medida en columnas."""
        crudas = [_col(f"2026-08-24T01:00:{i:04d}Z", [20.0] * 3) for i in range(21600)]
        reducido = downsample_columns(crudas, 400)
        assert len(reducido) == 400
        # 54x menos columnas que las 24 h crudas de un canal.
        assert len(crudas) / len(reducido) == 54

    def test_columnas_con_distinta_cantidad_de_bins_no_revientan(self):
        # Defensa: el eje de frecuencia puede cambiar DENTRO de un mismo canal
        # (documentado en el proyecto). Mezclar largos no debe tirar la vista.
        cols = [
            _col("2026-08-24T01:00:00Z", [90.0, 20.0, 20.0]),
            {"endtime": "2026-08-24T01:00:01Z", "freqs": [1.0, 2.0], "power_db": [30.0, 40.0]},
        ]
        reducido = downsample_columns(cols, 1)
        assert len(reducido) == 1
        assert len(reducido[0]["power_db"]) == len(reducido[0]["freqs"])


class TestHistoryEndpointWidth:
    """El endpoint reduce en el backend en vez de mandar todo crudo.

    Sin esto la opción A sería PEOR que el PNG: 24 h de un canal son 1,3 MB
    de JSON contra 152 KB del PNG.
    """

    def _client(self):
        from fastapi.testclient import TestClient
        from src.main import app

        return TestClient(app)

    def _columnas(self, n: int) -> list[dict]:
        return [
            {
                "endtime": f"2026-08-24T01:00:{i:04d}Z",
                "freqs": [1.0, 2.0],
                "power_db": [20.0, 20.0],
            }
            for i in range(n)
        ]

    def test_width_reduce_las_columnas_devueltas(self, monkeypatch):
        from unittest.mock import AsyncMock

        import src.main as main

        writer = AsyncMock()
        writer.fetch_history = AsyncMock(return_value=self._columnas(5000))
        monkeypatch.setattr(main, "column_writer", writer)

        resp = self._client().get("/spectrograms/IU.MAJO.00.BHZ/history?minutes=1440&width=400")

        assert resp.status_code == 200
        assert len(resp.json()["columns"]) == 400

    def test_sin_width_no_reduce_y_no_rompe_al_canvas_en_vivo(self, monkeypatch):
        # El canvas en vivo ya pide ventanas chicas y pinta 1 columna por
        # píxel: agregar por default cambiaría lo que hoy funciona.
        from unittest.mock import AsyncMock

        import src.main as main

        writer = AsyncMock()
        writer.fetch_history = AsyncMock(return_value=self._columnas(700))
        monkeypatch.setattr(main, "column_writer", writer)

        resp = self._client().get("/spectrograms/IU.MAJO.00.BHZ/history?minutes=60")

        assert len(resp.json()["columns"]) == 700

    def test_informa_la_cobertura_REAL_del_dato(self, monkeypatch):
        """La base puede no cubrir la ventana pedida (el agujero de 66 h).

        Fingir 24 h con 21 h de negro es la misma mentira que mostraba un
        espectrograma viejo con cara de fresco: la tarjeta necesita saber
        qué rango tiene DE VERDAD para poder rotularlo.
        """
        from unittest.mock import AsyncMock

        import src.main as main

        writer = AsyncMock()
        writer.fetch_history = AsyncMock(return_value=self._columnas(100))
        monkeypatch.setattr(main, "column_writer", writer)

        body = self._client().get(
            "/spectrograms/IU.MAJO.00.BHZ/history?minutes=1440&width=50"
        ).json()

        assert body["coverage"]["from"] == "2026-08-24T01:00:0000Z"
        assert body["coverage"]["to"] == "2026-08-24T01:00:0099Z"

    def test_sin_datos_la_cobertura_es_nula_y_no_revienta(self, monkeypatch):
        from unittest.mock import AsyncMock

        import src.main as main

        writer = AsyncMock()
        writer.fetch_history = AsyncMock(return_value=[])
        monkeypatch.setattr(main, "column_writer", writer)

        body = self._client().get("/spectrograms/XX.NADA..BHZ/history?minutes=1440&width=400").json()

        assert body["columns"] == []
        assert body["coverage"] is None


class TestSharedFreqs:
    """El eje de frecuencia se manda UNA vez por canal, no por columna.

    Son 65 floats idénticos: repetidos en 400 columnas pesaban ~400 KB de la
    misma lista copiada.
    """

    def test_devuelve_el_eje_si_todas_las_columnas_lo_comparten(self):
        from src.services.spectrogram_downsample import extract_shared_freqs

        cols = [_col(f"2026-08-24T01:00:{i:02d}Z", [20.0] * 3) for i in range(5)]
        assert extract_shared_freqs(cols) == [1.0, 2.0, 3.0]

    def test_devuelve_None_si_los_ejes_difieren(self):
        # Antes que dibujar todo el canal con la escala equivocada, se
        # renuncia al ahorro y cada columna conserva el suyo.
        from src.services.spectrogram_downsample import extract_shared_freqs

        cols = [
            _col("2026-08-24T01:00:00Z", [20.0] * 3),
            {"endtime": "2026-08-24T01:00:01Z", "freqs": [5.0, 9.0], "power_db": [20.0, 20.0]},
        ]
        assert extract_shared_freqs(cols) is None

    def test_lista_vacia_devuelve_None(self):
        from src.services.spectrogram_downsample import extract_shared_freqs

        assert extract_shared_freqs([]) is None


class TestPrecision:
    def test_redondea_los_dB_a_un_decimal(self):
        # Serializar el float32 crudo escribía "108.80000305175781": 18
        # dígitos de ruido de coma flotante por bin, en cada columna.
        cols = [_col(f"2026-08-24T01:00:{i:02d}Z", [108.80000305175781] * 3) for i in range(4)]
        assert downsample_columns(cols, 1)[0]["power_db"][0] == 108.8
