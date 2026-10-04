"""Генерация ответа: YandexGPT (Foundation Models, синхронный completion)."""
from __future__ import annotations

import httpx

from config import Settings

LLM_URL = "https://llm.api.cloud.yandex.net/foundationModels/v1/completion"


class YandexGPT:
    def __init__(self, http: httpx.AsyncClient, settings: Settings):
        self.http = http
        self.cfg = settings.llm
        self.yandex = settings.yandex

    async def complete(self, system_prompt: str, history: list[dict]) -> str:
        """history — список {"role": "user"|"assistant", "text": str}."""
        messages = [{"role": "system", "text": system_prompt}]
        messages += [{"role": m["role"], "text": m["text"]} for m in history]
        body = {
            "modelUri": f"gpt://{self.yandex.folder_id}/{self.cfg.model}",
            "completionOptions": {
                "stream": False,
                "temperature": self.cfg.temperature,
                "maxTokens": str(self.cfg.max_tokens),
            },
            "messages": messages,
        }
        resp = await self.http.post(
            LLM_URL, json=body, headers=self.yandex.headers(), timeout=self.cfg.timeout_s
        )
        resp.raise_for_status()
        alternatives = resp.json()["result"]["alternatives"]
        return alternatives[0]["message"]["text"].strip()
