"""Загрузка и валидация настроек из config.yaml (+ переменные окружения из .env)."""
from __future__ import annotations

import os
import re
from pathlib import Path

import yaml
from dotenv import load_dotenv
from pydantic import BaseModel

APP_VERSION = "0.4.3"
BASE_DIR = Path(__file__).resolve().parent
_ENV_RE = re.compile(r"\$\{(\w+)(?::-([^}]*))?\}")


def _expand_env(value):
    """Рекурсивно подставляет ${VAR} и ${VAR:-по_умолчанию}."""
    if isinstance(value, str):
        return _ENV_RE.sub(lambda m: os.environ.get(m.group(1), m.group(2) or ""), value)
    if isinstance(value, dict):
        return {k: _expand_env(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_expand_env(v) for v in value]
    return value


class ServerCfg(BaseModel):
    host: str = "127.0.0.1"
    port: int = 8765
    auth_token: str = ""
    allowed_extension_ids: list[str] = []
    allow_any_origin: bool = False
    log_level: str = "info"


class YandexCfg(BaseModel):
    api_key: str = ""
    folder_id: str = ""
    disable_data_logging: bool = True

    def headers(self) -> dict[str, str]:
        """Заголовки авторизации. API-ключ → Api-Key, IAM-токен (t1.…) → Bearer."""
        scheme = "Bearer" if self.api_key.startswith("t1.") else "Api-Key"
        headers = {"Authorization": f"{scheme} {self.api_key}"}
        if self.folder_id:
            headers["x-folder-id"] = self.folder_id
        if self.disable_data_logging:
            headers["x-data-logging-enabled"] = "false"
        return headers


class SttCfg(BaseModel):
    lang: str = "ru-RU"
    topic: str = "general"
    timeout_s: float = 15


class LlmCfg(BaseModel):
    model: str = "yandexgpt-lite/latest"
    temperature: float = 0.3
    max_tokens: int = 150
    timeout_s: float = 20


class TtsCfg(BaseModel):
    voice: str = "alena"
    role: str = ""
    speed: float = 1.0
    sample_rate: int = 48000
    timeout_s: float = 20


class VadCfg(BaseModel):
    frame_ms: int = 30
    start_ms: int = 120
    silence_ms: int = 800
    preroll_ms: int = 300
    min_utterance_ms: int = 300
    max_utterance_s: int = 20
    energy_threshold: float = 0.01
    noise_ratio: float = 3.0


class DialogCfg(BaseModel):
    default_mode: str = "auto"
    system_prompt_file: str = "system_prompt.txt"
    speak_greeting: bool = True
    greeting: str = "Привет, я Марина"
    protect_greeting: bool = True
    response_pause_ms: int = 300
    fallback_phrase: str = ""
    max_history_turns: int = 10
    max_reply_chars: int = 400
    barge_in: bool = True


class Settings(BaseModel):
    server: ServerCfg = ServerCfg()
    yandex: YandexCfg = YandexCfg()
    stt: SttCfg = SttCfg()
    llm: LlmCfg = LlmCfg()
    tts: TtsCfg = TtsCfg()
    vad: VadCfg = VadCfg()
    dialog: DialogCfg = DialogCfg()

    def load_system_prompt(self) -> str:
        path = BASE_DIR / self.dialog.system_prompt_file
        return path.read_text(encoding="utf-8").strip()


def load_settings(path: Path | None = None) -> Settings:
    load_dotenv(BASE_DIR / ".env")
    raw = yaml.safe_load((path or BASE_DIR / "config.yaml").read_text(encoding="utf-8")) or {}
    return Settings(**_expand_env(raw))
