import argparse
import os
import sys
import threading
import time
import webbrowser
from pathlib import Path

import uvicorn


APP_NAME = "Calypso UI"


def _base_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parents[2]


def _user_data_dir() -> Path:
    local_app_data = os.getenv("LOCALAPPDATA")
    if local_app_data:
        return Path(local_app_data) / APP_NAME

    app_data = os.getenv("APPDATA")
    if app_data:
        return Path(app_data) / APP_NAME

    return Path.home() / f".{APP_NAME.lower().replace(' ', '-')}"


def configure_standalone_environment() -> None:
    data_dir = Path(os.getenv("CALYPSO_DATA_DIR", str(_user_data_dir())))
    log_dir = Path(os.getenv("CALYPSO_LOG_DIR", str(data_dir / "logs")))
    cfg_dir = data_dir / "config"

    log_dir.mkdir(parents=True, exist_ok=True)
    cfg_dir.mkdir(parents=True, exist_ok=True)

    os.environ.setdefault("CALYPSO_LOG_DIR", str(log_dir))
    os.environ.setdefault("CALYPSO_LIGHTS_CFG", str(cfg_dir / "lights_config.json"))

    ffmpeg_path = _base_dir() / "ffmpeg" / "ffmpeg.exe"
    if ffmpeg_path.exists():
        os.environ.setdefault("CALYPSO_FFMPEG_BIN", str(ffmpeg_path))


def _open_browser_later(url: str) -> None:
    time.sleep(1.0)
    webbrowser.open(url)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run Calypso UI as a standalone desktop service.")
    parser.add_argument("--host", default=os.getenv("CALYPSO_STANDALONE_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.getenv("CALYPSO_HTTP_PORT", "8080")))
    parser.add_argument("--no-browser", action="store_true", help="Do not open the browser automatically.")
    return parser.parse_args()


def main() -> None:
    configure_standalone_environment()
    args = parse_args()
    url = f"http://{args.host}:{args.port}/ui"

    if not args.no_browser:
        threading.Thread(target=_open_browser_later, args=(url,), daemon=True).start()

    uvicorn.run("backend.app.main:app", host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
