import asyncio
import unittest
import sys
from types import SimpleNamespace
from types import ModuleType
from unittest.mock import Mock

# Keep these protocol tests independent of optional audio/cloud dependencies.
for name, attributes in {
    "fastapi": {"WebSocket": object},
    "config": {"Settings": object},
    "vad": {"UtteranceVAD": object},
    "yandex_gpt": {"YandexGPT": object},
    "yandex_stt": {"YandexSTT": object},
    "yandex_tts": {"YandexTTS": object, "split_text": lambda text: [text]},
}.items():
    module = ModuleType(name)
    for key, value in attributes.items():
        setattr(module, key, value)
    sys.modules[name] = module

from session import CallSession, split_end_marker


class SessionGuardTests(unittest.IsolatedAsyncioTestCase):
    def test_marker_is_removed_from_spoken_text(self):
        self.assertEqual(split_end_marker("Пока. [[END_CONVERSATION]]"), ("Пока.", True))
        self.assertEqual(split_end_marker("Обычный ответ."), ("Обычный ответ.", False))

    async def test_session_stops_and_does_not_speak_marker(self):
        class LLM:
            async def complete(self, *_):
                return "До свидания. [[END_CONVERSATION]]"

        class TTS:
            sample_rate = 48000

            async def stream(self, _):
                yield b"\0\0"

        class WebSocket:
            def __init__(self):
                self.messages = []

            async def send_json(self, message):
                self.messages.append(message)

            async def send_bytes(self, _):
                pass

        session = CallSession.__new__(CallSession)
        session.ws = WebSocket()
        session.cfg = SimpleNamespace(dialog=SimpleNamespace(max_reply_chars=400, max_history_turns=10, fallback_phrase=""))
        session.svc = SimpleNamespace(llm=LLM(), tts=TTS())
        session.system_prompt = ""
        session.history = []
        session.response_pause_ms = 0
        session._queue = asyncio.Queue()
        session.dialog_ended = False
        session._closed = False
        session._play_end = 0.0
        session._greeting_play_end = 0.0

        await session._reply()

        spoken = [m["text"] for m in session.ws.messages if m.get("type") == "transcript"]
        self.assertEqual(spoken, ["До свидания."])
        self.assertEqual(session.ws.messages[-1], {"type": "dialog_ended"})
        self.assertTrue(session.dialog_ended)

    async def test_audio_is_ignored_after_session_end(self):
        session = CallSession.__new__(CallSession)
        session.dialog_ended = True
        session.vad = SimpleNamespace(feed=Mock(side_effect=AssertionError("audio should not reach VAD")))
        await session.on_audio(b"audio")
        session.vad.feed.assert_not_called()


if __name__ == "__main__":
    unittest.main()
