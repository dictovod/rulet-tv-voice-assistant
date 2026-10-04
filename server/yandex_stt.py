"""Распознавание речи: Yandex SpeechKit STT, REST API v1 (синхронное, до 30 с / 1 МБ)."""
from __future__ import annotations

import httpx

from config import Settings

STT_URL = "https://stt.api.cloud.yandex.net/speech/v1/stt:recognize"


class YandexSTT:
    def __init__(self, http: httpx.AsyncClient, settings: Settings):
        self.http = http
        self.cfg = settings.stt
        self.yandex = settings.yandex

    async def recognize(self, pcm: bytes, sample_rate: int = 16000) -> str:
        """PCM16 mono → текст. Пустая строка, если речь не распознана."""
        params = {
            "lang": self.cfg.lang,
            "topic": self.cfg.topic,
            "format": "lpcm",
            "sampleRateHertz": str(sample_rate),
        }
        if self.yandex.folder_id:
            params["folderId"] = self.yandex.folder_id
        resp = await self.http.post(
            STT_URL,
            params=params,
            content=pcm,
            headers=self.yandex.headers(),
            timeout=self.cfg.timeout_s,
        )
        resp.raise_for_status()
        return (resp.json().get("result") or "").strip()
