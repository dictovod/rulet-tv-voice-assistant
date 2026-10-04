"""Синтез речи: Yandex SpeechKit TTS, REST API v3 (utteranceSynthesis), потоковый разбор ответа."""
from __future__ import annotations

import base64
import json
import re
from typing import AsyncIterator

import httpx

from config import Settings

TTS_URL = "https://tts.api.cloud.yandex.net/tts/v3/utteranceSynthesis"
MAX_CHARS = 240                      # лимит длины текста на один запрос синтеза — с запасом
_SENTENCE_RE = re.compile(r"(?<=[.!?…])\s+")


class YandexError(RuntimeError):
    """Ошибка сервиса Яндекса."""


def split_text(text: str, limit: int = MAX_CHARS) -> list[str]:
    """Делит текст на предложения (не длиннее limit): первое предложение озвучивается быстрее."""
    parts: list[str] = []
    for sentence in _SENTENCE_RE.split(text.strip()):
        sentence = sentence.strip()
        while len(sentence) > limit:
            cut = sentence.rfind(" ", 0, limit) or limit
            cut = cut if cut > 0 else limit
            parts.append(sentence[:cut].strip())
            sentence = sentence[cut:].strip()
        if sentence:
            parts.append(sentence)
    return parts


class YandexTTS:
    def __init__(self, http: httpx.AsyncClient, settings: Settings):
        self.http = http
        self.cfg = settings.tts
        self.yandex = settings.yandex

    @property
    def sample_rate(self) -> int:
        return self.cfg.sample_rate

    async def stream(self, text: str) -> AsyncIterator[bytes]:
        """Отдаёт PCM16 mono (sample_rate) кусками. Длина каждого куска чётная."""
        hints: list[dict] = [{"voice": self.cfg.voice}]
        if self.cfg.role:
            hints.append({"role": self.cfg.role})
        hints.append({"speed": self.cfg.speed})
        body = {
            "text": text,
            "hints": hints,
            "outputAudioSpec": {
                "rawAudio": {"audioEncoding": "LINEAR16_PCM", "sampleRateHertz": self.cfg.sample_rate}
            },
            "loudnessNormalizationType": "LUFS",
        }
        carry = b""
        async with self.http.stream(
            "POST", TTS_URL, json=body, headers=self.yandex.headers(), timeout=self.cfg.timeout_s
        ) as resp:
            if resp.status_code != 200:
                detail = (await resp.aread()).decode("utf-8", "replace")[:300]
                raise YandexError(f"TTS HTTP {resp.status_code}: {detail}")
            # Ответ — поток JSON-объектов, по одному на строку; аудио в result.audioChunk.data (base64).
            async for line in resp.aiter_lines():
                line = line.strip()
                if not line:
                    continue
                obj = json.loads(line)
                if "error" in obj:
                    raise YandexError(f"TTS error: {obj['error']}")
                b64 = (obj.get("result") or {}).get("audioChunk", {}).get("data")
                if not b64:
                    continue
                data = carry + base64.b64decode(b64)
                even = len(data) & ~1
                carry = data[even:]
                if even:
                    yield data[:even]
