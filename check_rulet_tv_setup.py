#!/usr/bin/env python3
"""Read-only local checks for the Rulet.tv Voice Assistant package."""

import argparse
import json
import platform
import subprocess
import sys
import urllib.error
import urllib.request
import zipfile
from pathlib import Path


APP_NAME = "rulet-tv-voice-assistant"
ARCHIVE_URL = "https://cloud.mail.ru/public/EDqE/f9g2K9mfP"
PROJECT_FILES = (
    "README.md",
    "extension/background.js",
    "extension/bridge.js",
    "extension/icons/icon16.png",
    "extension/icons/icon48.png",
    "extension/icons/icon128.png",
    "extension/inject.js",
    "extension/logger.js",
    "extension/manifest.json",
    "extension/popup.html",
    "extension/popup.js",
    "extension/shared.js",
    "server/.env.example",
    "server/config.py",
    "server/config.yaml",
    "server/main.py",
    "server/requirements.txt",
    "server/session.py",
    "server/system_prompt.txt",
    "server/test_client.py",
    "server/vad.py",
    "server/yandex_gpt.py",
    "server/yandex_stt.py",
    "server/yandex_tts.py",
)
ZIP_FILES = PROJECT_FILES
MODULES = {
    "fastapi": "fastapi",
    "uvicorn": "uvicorn",
    "websockets": "websockets",
    "httpx": "httpx",
    "pydantic": "pydantic",
    "PyYAML": "yaml",
    "python-dotenv": "dotenv",
    "numpy": "numpy",
}
COUNTS = {"ok": 0, "attention": 0, "info": 0}


def say(kind, text):
    tags = {"ok": "ГОТОВО", "attention": "НУЖНО СДЕЛАТЬ", "info": "СПРАВКА"}
    COUNTS[kind] += 1
    print("[{}] {}".format(tags[kind], text))


def is_project(path):
    return (path / "server" / "requirements.txt").is_file() and (
        path / "extension" / "manifest.json"
    ).is_file()


def child_directories(path):
    try:
        return [p for p in path.iterdir() if p.is_dir() and not p.is_symlink()]
    except OSError:
        return []


def search_directories(path):
    paths = [path]
    paths.extend(child_directories(path))
    for child in list(paths[1:]):
        paths.extend(child_directories(child))
    unique = []
    seen = set()
    for item in paths:
        try:
            key = str(item.resolve()).casefold()
        except OSError:
            key = str(item).casefold()
        if key not in seen:
            seen.add(key)
            unique.append(item)
    return unique


def scan_locations(argument):
    if argument:
        given = Path(argument).expanduser()
        if not given.exists():
            return [], [], given
        if given.is_file():
            if given.suffix.lower() == ".zip":
                return [], [given], None
            return [], [], given
        locations = search_directories(given)
    else:
        roots = [Path.cwd(), Path(__file__).resolve().parent]
        locations = []
        for root in roots:
            locations.extend(search_directories(root))

    projects = []
    seen_projects = set()
    for folder in locations:
        if not is_project(folder):
            continue
        key = str(folder.resolve()).casefold()
        if key not in seen_projects:
            seen_projects.add(key)
            projects.append(folder)
    archives = []
    for folder in locations:
        try:
            archives.extend(
                p for p in folder.iterdir()
                if p.is_file()
                and p.suffix.lower() == ".zip"
                and (APP_NAME in p.name.casefold() or "f9g2k9mfp" in p.name.casefold())
            )
        except OSError:
            continue
    unique_archives = []
    seen = set()
    for archive in archives:
        key = str(archive.resolve()).casefold()
        if key not in seen:
            seen.add(key)
            unique_archives.append(archive)
    return projects, unique_archives, None


def inspect_archive(path):
    try:
        with zipfile.ZipFile(path) as archive:
            names = {name.replace("\\", "/").lstrip("./") for name in archive.namelist()}
            prefix = APP_NAME + "/"
            missing = [
                needed
                for needed in ZIP_FILES
                if prefix + needed not in names
            ]
            damaged = archive.testzip()
        return missing, damaged, None
    except (OSError, zipfile.BadZipFile, RuntimeError) as error:
        return list(ZIP_FILES), None, str(error)


def parse_env(path):
    values = {}
    try:
        lines = path.read_text(encoding="utf-8-sig").splitlines()
    except (OSError, UnicodeError):
        return values
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].strip()
        key, separator, value = line.partition("=")
        if separator:
            values[key.strip()] = value.strip().strip("\"'").strip()
    return values


def is_filled(value):
    text = (value or "").strip().lower()
    placeholders = {
        "",
        "...",
        "вставьте_секретный_api-ключ",
        "вставьте_id_каталога",
        "your_api_key",
        "your_folder_id",
        "ваш_ключ",
        "ваш_id_каталога",
    }
    return text not in placeholders and not (text.startswith("<") and text.endswith(">"))


def check_project(root):
    print("\nПапка проекта: {}".format(root))
    missing = [relative for relative in PROJECT_FILES if not (root / relative).is_file()]
    if missing:
        say("attention", "В распакованном проекте не найдены файлы: {}".format(", ".join(missing)))
    else:
        say("ok", "Файлы расширения и сервера на месте.")

    manifest_path = root / "extension" / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        matches = [match for item in manifest.get("content_scripts", []) for match in item.get("matches", [])]
        if any("rulet.tv" in match for match in matches):
            say("ok", "В манифесте расширения указан сайт rulet.tv.")
        else:
            say("attention", "Проверьте манифест расширения: в нём не найден сайт rulet.tv.")
    except (OSError, ValueError, AttributeError):
        say("attention", "Не удалось прочитать extension/manifest.json.")

    env_path = root / "server" / ".env"
    template = root / "server" / ".env.example"
    if not env_path.is_file():
        if template.is_file():
            say("attention", "Нет server/.env. Скопируйте .env.example в .env и заполните YC_API_KEY и YC_FOLDER_ID по инструкции.")
        else:
            say("attention", "Нет server/.env и шаблона .env.example.")
    else:
        values = parse_env(env_path)
        for name in ("YC_API_KEY", "YC_FOLDER_ID"):
            if is_filled(values.get(name, "")):
                say("ok", "{} заполнен (само значение скрыто).".format(name))
            else:
                say("attention", "{} пуст или содержит пример: заполните его в server/.env.".format(name))
        say("info", "Проверена только заполненность .env. Подлинность ключа и права в облаке без API-запроса проверить нельзя.")

    server = root / "server"
    venv_python = server / ".venv" / ("Scripts/python.exe" if platform.system() == "Windows" else "bin/python")
    if not venv_python.is_file():
        say("attention", "Не найдена виртуальная среда server/.venv. Создайте её и установите зависимости по инструкции README.")
    else:
        code = (
            "import importlib.util,json,sys;"
            "mods=" + repr(list(MODULES.values())) + ";"
            "print(json.dumps({'version':list(sys.version_info[:3]),"
            "'missing':[m for m in mods if importlib.util.find_spec(m) is None]}))"
        )
        try:
            result = subprocess.run(
                [str(venv_python), "-c", code], capture_output=True, text=True, timeout=20
            )
            details = json.loads(result.stdout) if result.returncode == 0 else {}
            version = tuple(details.get("version", [0, 0, 0]))
            if version >= (3, 11):
                say("ok", "Виртуальная среда использует Python {}.{}.{} (нужен 3.11+).".format(*version))
            else:
                say("attention", "В server/.venv нужен Python 3.11 или новее.")
            missing_modules = details.get("missing", [])
            if missing_modules:
                packages = [name for name, module in MODULES.items() if module in missing_modules]
                say("attention", "В .venv не хватает пакетов: {}. Установите их командой из инструкции.".format(", ".join(packages)))
            else:
                say("ok", "Все Python-пакеты сервера установлены в server/.venv.")
        except (OSError, subprocess.TimeoutExpired, ValueError, TypeError):
            say("attention", "Не удалось проверить Python и пакеты внутри server/.venv.")


def check_local_server():
    try:
        with urllib.request.urlopen("http://127.0.0.1:8765/health", timeout=2) as response:
            payload = json.loads(response.read().decode("utf-8"))
            if response.status == 200 and payload.get("status") == "ok":
                say("ok", "Локальный сервер отвечает на http://127.0.0.1:8765/health.")
                return
            say("attention", "Локальный сервер ответил, но проверка /health не прошла.")
    except (OSError, urllib.error.URLError, ValueError, TimeoutError):
        say("info", "Сервер сейчас не запущен или не отвечает. Запустите его из папки server командой python main.py.")


def main():
    parser = argparse.ArgumentParser(
        description="Проверяет ZIP и локальную настройку Rulet.tv Voice Assistant; ничего не устанавливает и не отправляет."
    )
    parser.add_argument("path", nargs="?", help="путь к ZIP-архиву или распакованной папке проекта")
    args = parser.parse_args()

    print("ПРОВЕРКА Rulet.tv Voice Assistant")
    print("Скрипт только читает файлы и проверяет localhost; секреты не печатает и в интернет не отправляет.\n")
    if sys.version_info < (3, 11):
        say("attention", "Скрипт запущен Python {}.{}; для сервера установите Python 3.11 или новее.".format(*sys.version_info[:2]))

    projects, archives, invalid_argument = scan_locations(args.path)
    if invalid_argument is not None:
        say("attention", "Указанный путь не найден или не является ZIP-архивом/папкой: {}".format(invalid_argument))

    valid_archives = []
    for archive in archives:
        missing, damaged, error = inspect_archive(archive)
        if error:
            if APP_NAME in archive.name.casefold():
                say("attention", "Не удалось открыть архив {}: {}".format(archive.name, error))
            continue
        if missing:
            if APP_NAME in archive.name.casefold():
                say("attention", "В архиве {} не хватает файлов проекта: {}".format(archive.name, ", ".join(missing)))
            continue
        valid_archives.append(archive)
        if damaged:
            say("attention", "ZIP повреждён внутри файла: {}".format(archive.name))
        else:
            say("ok", "ZIP найден и читается; в нём есть файлы плагина и сервера: {}".format(archive.name))

    if not valid_archives and not projects:
        if archives:
            say("attention", "Среди найденных ZIP не распознан полный архив проекта. Укажите нужный ZIP или скачайте его: {}".format(ARCHIVE_URL))
        else:
            say("attention", "Не найден ZIP с проектом или распакованная папка. Скачайте архив: {}".format(ARCHIVE_URL))

    if projects:
        root = next((p for p in projects if p.name.casefold() == APP_NAME), projects[0])
        check_project(root)
        if len(projects) > 1:
            say("info", "Найдены и другие папки с похожим сервером; проверена папка нужного проекта: {}".format(root))
    elif valid_archives:
        say("attention", "Архив есть, но распакованная папка проекта не найдена. Распакуйте ZIP и запустите проверку ещё раз.")

    check_local_server()
    say("info", "Скрипт не может определить, установлено ли расширение в браузере, и не проверяет действительность API-ключа или роли в Yandex Cloud.")
    print("\nИТОГ: готово — {}; требуется внимание — {}; справка — {}.".format(
        COUNTS["ok"], COUNTS["attention"], COUNTS["info"]
    ))
    if COUNTS["attention"]:
        print("Исправьте пункты «НУЖНО СДЕЛАТЬ» по инструкции выше и запустите проверку повторно.")
        return 1
    print("Локальные проверки пройдены. Осталось проверить вручную доступ к Яндекс Cloud и включение расширения в браузере.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
