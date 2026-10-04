"""Локальный сервер автоответчика: FastAPI + WebSocket.

Запуск:  python main.py
"""
from __future__ import annotations

import json
import logging
from contextlib import asynccontextmanager

import httpx
import uvicorn
from fastapi import FastAPI, WebSocket

from config import load_settings
from session import CallSession, Services
from yandex_gpt import YandexGPT
from yandex_stt import YandexSTT
from yandex_tts import YandexTTS

settings = load_settings()
logging.basicConfig(
    level=settings.server.log_level.upper(),
    format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
)
log = logging.getLogger("server")


@asynccontextmanager
async def lifespan(app: FastAPI):
    if not settings.yandex.api_key or not settings.yandex.folder_id:
        log.warning("Не заданы YC_API_KEY / YC_FOLDER_ID — запросы к Яндексу работать не будут (см. .env)")
    async with httpx.AsyncClient() as http:
        app.state.services = Services(
            stt=YandexSTT(http, settings),
            llm=YandexGPT(http, settings),
            tts=YandexTTS(http, settings),
        )
        yield


app = FastAPI(title="Rulet.tv Voice Assistant", lifespan=lifespan)


@app.get("/health")
async def health():
    return {"status": "ok"}


def _origin_allowed(ws: WebSocket) -> bool:
    """Пускаем только расширение Chrome: иначе любой сайт смог бы тратить ваши деньги в Яндекс Облаке."""
    cfg = settings.server
    if cfg.allow_any_origin:
        return True
    origin = ws.headers.get("origin", "")
    if not origin.startswith("chrome-extension://"):
        return False
    if cfg.allowed_extension_ids:
        return origin.removeprefix("chrome-extension://").rstrip("/") in cfg.allowed_extension_ids
    return True


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    cfg = settings.server
    if not _origin_allowed(ws) or (cfg.auth_token and ws.query_params.get("token") != cfg.auth_token):
        log.warning("Отклонено подключение, origin=%r", ws.headers.get("origin"))
        await ws.close(code=1008)
        return

    await ws.accept()
    session = CallSession(ws, settings, app.state.services)
    log.info("Клиент подключён")
    try:
        while True:
            message = await ws.receive()
            if message["type"] == "websocket.disconnect":
                break
            if message.get("bytes") is not None:
                await session.on_audio(message["bytes"])
            elif message.get("text") is not None:
                await session.on_control(json.loads(message["text"]))
    except Exception as exc:  # noqa: BLE001
        log.warning("Соединение прервано: %s", exc)
    finally:
        await session.close()
        log.info("Клиент отключён")


if __name__ == "__main__":
    uvicorn.run(app, host=settings.server.host, port=settings.server.port, log_level="warning")
