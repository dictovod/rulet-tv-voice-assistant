"""Сессия одного звонка: VAD → STT → YandexGPT → TTS, режимы auto/listen, барж-ин."""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass

from fastapi import WebSocket

from config import Settings
from vad import UtteranceVAD
from yandex_gpt import YandexGPT
from yandex_stt import YandexSTT
from yandex_tts import YandexTTS, split_text

log = logging.getLogger("session")
END_CONVERSATION_MARKER = "[[END_CONVERSATION]]"


def split_end_marker(text: str) -> tuple[str, bool]:
    text = text.strip()
    if text.endswith(END_CONVERSATION_MARKER):
        return text[:-len(END_CONVERSATION_MARKER)].strip(), True
    return text, False


@dataclass
class Services:
    stt: YandexSTT
    llm: YandexGPT
    tts: YandexTTS


class CallSession:
    def __init__(self, ws: WebSocket, settings: Settings, services: Services):
        self.ws = ws
        self.cfg = settings
        self.svc = services
        self.mode = settings.dialog.default_mode
        self.system_prompt = settings.load_system_prompt()
        self.vad = UtteranceVAD(settings.vad)
        self.greeting_enabled = settings.dialog.speak_greeting
        self.greeting = settings.dialog.greeting
        self.protect_greeting = settings.dialog.protect_greeting
        self.response_pause_ms = settings.dialog.response_pause_ms
        self.dialog_ended = False
        self.history: list[dict] = []

        self._queue: asyncio.Queue[bytes] = asyncio.Queue()
        self._worker: asyncio.Task | None = None
        self._reply_task: asyncio.Task | None = None
        self._greeting_task: asyncio.Task | None = None
        self._play_end = 0.0          # момент (loop.time()), когда закончится озвучка у клиента
        self._greeting_play_end = 0.0
        self._closed = False

    # ───────────── вход от клиента ─────────────

    async def on_control(self, msg: dict) -> None:
        kind = msg.get("type")
        if kind == "start":
            self.mode = msg.get("mode", self.mode)
            self._apply_user_settings(msg)
            if self._worker is None:
                self._worker = asyncio.create_task(self._worker_loop())
            log.info("Звонок начат, режим: %s", self.mode)
            d = self.cfg.dialog
            if self.mode == "auto" and self.greeting_enabled and self.greeting and not msg.get("resumed"):
                self._history_add("assistant", self.greeting)
                self._greeting_task = asyncio.create_task(self._say(self.greeting, greeting=True))
                self._reply_task = self._greeting_task
        elif kind == "settings":
            self.mode = msg.get("mode", self.mode)
            self._apply_user_settings(msg)
            log.info("Режим изменён: %s", self.mode)
            if self.mode != "auto":
                await self._interrupt()
        elif kind == "stop":
            await self.close()

    def _apply_user_settings(self, msg: dict) -> None:
        if isinstance(msg.get("greeting_enabled"), bool):
            self.greeting_enabled = msg["greeting_enabled"]
        greeting = msg.get("greeting")
        if isinstance(greeting, str):
            self.greeting = greeting[:500].strip()
        if isinstance(msg.get("protect_greeting"), bool):
            self.protect_greeting = msg["protect_greeting"]
        response_pause_ms = msg.get("response_pause_ms")
        if isinstance(response_pause_ms, int):
            self.response_pause_ms = max(0, min(3000, response_pause_ms))
        silence_ms = msg.get("silence_ms")
        if isinstance(silence_ms, int):
            self.vad.set_silence_ms(max(300, min(3000, silence_ms)))

    async def on_audio(self, pcm: bytes) -> None:
        if self.dialog_ended:
            return
        for event in self.vad.feed(pcm):
            if event.kind == "start":
                await self._on_speech_start()
            else:
                self._queue.put_nowait(event.audio)

    async def close(self) -> None:
        self._closed = True
        for task in (self._reply_task, self._worker):
            if task and not task.done():
                task.cancel()
        await asyncio.gather(*(t for t in (self._reply_task, self._worker) if t), return_exceptions=True)

    # ───────────── конвейер ─────────────

    async def _worker_loop(self) -> None:
        """Последовательно распознаёт реплики; ответ запускается отдельной отменяемой задачей."""
        while True:
            audio = await self._queue.get()
            try:
                text = await self.svc.stt.recognize(audio)
            except Exception as exc:  # noqa: BLE001
                log.warning("STT: %s", exc)
                await self._send_json({"type": "error", "message": f"STT: {exc}"})
                continue
            if not text:
                continue
            await self._send_json({"type": "transcript", "role": "user", "text": text})
            self._history_add("user", text)
            if self.dialog_ended:
                continue
            if self.mode != "auto":
                continue                      # режим «только слушать»
            if self._reply_busy():
                if self.protect_greeting and self._greeting_busy():
                    while self.protect_greeting and self._greeting_busy():
                        await asyncio.sleep(0.05)
                if self._reply_busy():
                    await self._interrupt()
            self._reply_task = asyncio.create_task(self._reply())

    async def _reply(self) -> None:
        end_conversation = False
        try:
            text, end_conversation = split_end_marker(await self.svc.llm.complete(self.system_prompt, self.history))
            if end_conversation:
                self.dialog_ended = True
                while not self._queue.empty():
                    self._queue.get_nowait()
            text = text[: self.cfg.dialog.max_reply_chars].strip()
            if not text:
                if end_conversation:
                    await self._send_json({"type": "dialog_ended"})
                return
            self._history_add("assistant", text)
            if self.response_pause_ms:
                await asyncio.sleep(self.response_pause_ms / 1000)
            await self._say(text)
            if end_conversation:
                await self._send_json({"type": "dialog_ended"})
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            log.warning("Ответ не получился: %s", exc)
            await self._send_json({"type": "error", "message": f"GPT/TTS: {exc}"})
            fallback = self.cfg.dialog.fallback_phrase
            if fallback:
                try:
                    await self._say(fallback)
                except Exception:  # noqa: BLE001
                    pass
            if end_conversation:
                await self._send_json({"type": "dialog_ended"})

    async def _say(self, text: str, greeting: bool = False) -> None:
        """Синтезирует и стримит аудио клиенту, отмечая, сколько ему ещё играть."""
        await self._send_json({"type": "transcript", "role": "assistant", "text": text})
        rate = self.svc.tts.sample_rate
        await self._send_json({"type": "tts_start", "sample_rate": rate})
        loop = asyncio.get_running_loop()
        for part in split_text(text):
            async for chunk in self.svc.tts.stream(part):
                await self._send_bytes(chunk)
                self._play_end = max(loop.time(), self._play_end) + len(chunk) / (rate * 2)
                if greeting:
                    self._greeting_play_end = self._play_end
        await self._send_json({"type": "tts_end"})

    # ───────────── барж-ин ─────────────

    def _reply_busy(self) -> bool:
        running = self._reply_task is not None and not self._reply_task.done()
        return running or asyncio.get_running_loop().time() < self._play_end

    def _greeting_busy(self) -> bool:
        running = self._greeting_task is not None and not self._greeting_task.done()
        return running or asyncio.get_running_loop().time() < self._greeting_play_end

    async def _on_speech_start(self) -> None:
        if self.mode == "auto" and self.cfg.dialog.barge_in and self._reply_busy():
            if self.protect_greeting and self._greeting_busy():
                return
            log.info("Барж-ин: собеседник заговорил, прерываю бота")
            await self._interrupt()

    async def _cancel_reply(self) -> None:
        if self._reply_task and not self._reply_task.done():
            self._reply_task.cancel()
            await asyncio.gather(self._reply_task, return_exceptions=True)

    async def _interrupt(self) -> None:
        await self._cancel_reply()
        self._play_end = 0.0
        self._greeting_play_end = 0.0
        await self._send_json({"type": "interrupt"})

    # ───────────── вспомогательное ─────────────

    def _history_add(self, role: str, text: str) -> None:
        if self.history and self.history[-1]["role"] == role:     # склеиваем подряд идущие реплики
            self.history[-1]["text"] += " " + text
        else:
            self.history.append({"role": role, "text": text})
        limit = self.cfg.dialog.max_history_turns * 2
        if len(self.history) > limit:
            del self.history[: len(self.history) - limit]
            while self.history and self.history[0]["role"] != "user":
                self.history.pop(0)

    async def _send_json(self, obj: dict) -> None:
        if self._closed:
            return
        try:
            await self.ws.send_json(obj)
        except Exception:  # noqa: BLE001
            self._closed = True

    async def _send_bytes(self, data: bytes) -> None:
        if self._closed:
            return
        try:
            await self.ws.send_bytes(data)
        except Exception:  # noqa: BLE001
            self._closed = True
