"""Простой энергетический VAD: режет непрерывный поток PCM16 (16 кГц, mono) на реплики собеседника.

Без внешних зависимостей (только numpy): порог адаптируется к фоновому шуму.
"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass

import numpy as np

from config import VadCfg


@dataclass
class VadEvent:
    kind: str            # "start" — собеседник заговорил; "end" — реплика закончена
    audio: bytes = b""   # для "end": PCM всей реплики


class UtteranceVAD:
    def __init__(self, cfg: VadCfg, sample_rate: int = 16000):
        f = cfg.frame_ms
        self.frame_bytes = int(sample_rate * f / 1000) * 2
        self.start_frames = max(1, cfg.start_ms // f)
        self.silence_frames = max(1, cfg.silence_ms // f)
        self.max_frames = cfg.max_utterance_s * 1000 // f
        self.min_frames = cfg.min_utterance_ms // f
        self.abs_threshold = cfg.energy_threshold
        self.noise_ratio = cfg.noise_ratio

        self._buf = bytearray()
        self._preroll: deque[bytes] = deque(maxlen=cfg.preroll_ms // f + self.start_frames)
        self._noise = 0.003
        self._in_speech = False
        self._speech_run = 0
        self._silence_run = 0
        self._frames: list[bytes] = []

    def feed(self, pcm: bytes) -> list[VadEvent]:
        """Принимает кусок PCM произвольной длины, возвращает наступившие события."""
        events: list[VadEvent] = []
        self._buf.extend(pcm)
        while len(self._buf) >= self.frame_bytes:
            frame = bytes(self._buf[: self.frame_bytes])
            del self._buf[: self.frame_bytes]
            events.extend(self._process_frame(frame))
        return events

    def _is_speech(self, frame: bytes) -> bool:
        x = np.frombuffer(frame, dtype=np.int16).astype(np.float32) / 32768.0
        rms = float(np.sqrt(np.mean(x * x)))
        speech = rms > max(self.abs_threshold, self._noise * self.noise_ratio)
        if not speech and not self._in_speech:
            self._noise = min(0.05, 0.97 * self._noise + 0.03 * rms)   # плавно следим за шумом
        return speech

    def _process_frame(self, frame: bytes) -> list[VadEvent]:
        speech = self._is_speech(frame)

        if not self._in_speech:
            self._preroll.append(frame)
            self._speech_run = self._speech_run + 1 if speech else 0
            if self._speech_run >= self.start_frames:
                self._in_speech = True
                self._silence_run = 0
                self._speech_run = 0
                self._frames = list(self._preroll)
                self._preroll.clear()
                return [VadEvent("start")]
            return []

        self._frames.append(frame)
        self._silence_run = 0 if speech else self._silence_run + 1
        if self._silence_run >= self.silence_frames or len(self._frames) >= self.max_frames:
            speech_frames = len(self._frames) - self._silence_run
            frames = self._frames
            self._in_speech = False
            self._frames = []
            self._silence_run = 0
            if speech_frames < self.min_frames:
                return []
            return [VadEvent("end", b"".join(frames))]
        return []
