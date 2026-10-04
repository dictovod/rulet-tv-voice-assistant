"""Проверка сервера без браузера: отправляет WAV (16 кГц, mono, 16 бит) и сохраняет ответ бота.

Пример:
    python test_client.py question.wav                 # режим auto → reply.wav
    python test_client.py question.wav --mode listen   # только распознавание
"""
from __future__ import annotations

import argparse
import asyncio
import json
import wave

import websockets


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("wav")
    ap.add_argument("--url", default="ws://127.0.0.1:8765/ws")
    ap.add_argument("--mode", default="auto", choices=["auto", "listen"])
    ap.add_argument("--out", default="reply.wav")
    ap.add_argument("--wait", type=float, default=25, help="сколько секунд ждать ответ")
    args = ap.parse_args()

    with wave.open(args.wav, "rb") as w:
        if (w.getframerate(), w.getnchannels(), w.getsampwidth()) != (16000, 1, 2):
            raise SystemExit("Нужен WAV: 16000 Гц, mono, 16 бит (ffmpeg -i in.mp3 -ar 16000 -ac 1 out.wav)")
        pcm = w.readframes(w.getnframes())
    pcm += b"\x00" * 16000 * 2 * 2            # 2 секунды тишины — чтобы VAD закончил реплику

    audio, rate = bytearray(), 48000
    # Origin нужен: сервер пускает только chrome-extension://
    async with websockets.connect(args.url, origin="chrome-extension://local-test", max_size=None) as ws:
        await ws.send(json.dumps({"type": "start", "mode": args.mode, "resumed": True}))  # resumed — без приветствия
        for i in range(0, len(pcm), 3200):      # кадры по 100 мс
            await ws.send(pcm[i : i + 3200])
            await asyncio.sleep(0.01)
        try:
            async with asyncio.timeout(args.wait):
                async for msg in ws:
                    if isinstance(msg, bytes):
                        audio.extend(msg)
                        continue
                    data = json.loads(msg)
                    print(data)
                    if data["type"] == "tts_start":
                        rate = data["sample_rate"]
                    if data["type"] == "tts_end":
                        break
        except TimeoutError:
            pass

    if audio:
        with wave.open(args.out, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(rate)
            w.writeframes(bytes(audio))
        print(f"Ответ сохранён: {args.out} ({len(audio) / rate / 2:.1f} с)")
    else:
        print("Аудио-ответа нет (режим listen или таймаут)")


if __name__ == "__main__":
    asyncio.run(main())
