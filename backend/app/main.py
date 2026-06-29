import asyncio
import base64
import binascii
import csv
import io
import logging as py_logging
import json
import math
import os
import re
import shutil
import socket
import threading
import time
import zipfile
from collections import deque
from datetime import datetime
from typing import Optional, Set
from urllib.parse import urlparse

from fastapi import Body, FastAPI, HTTPException, Request, WebSocket
from fastapi.responses import JSONResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

try:
    from pymavlink import mavutil
except ModuleNotFoundError:
    mavutil = None

from backend.app import lights_cfg, logging as app_logging, parser
from backend.app.sonar_ping360 import (
    load_cfg as ping360_load_cfg,
    save_cfg as ping360_save_cfg,
    ping360_task,
)
from backend.app.controller_broker import (
    ControllerBrokerStats,
    mark_controller_stale,
    start_controller_broker_listener,
)
from backend.app.udp_rx import UdpRxStats, start_udp_listener

# state moved to backend.app.state
from backend.app.state import (
    state,
    latest,
    init_state,
    update_state,
    next_cmd_id,
    register_cmd,
    get_cmd_ack_status,
    expire_pending_cmds,
    set_session_paths,
    make_sid,
    append_telemetry_csv,
    append_event_jsonl,
    append_alarm_csv,
)

# ----------------------------
# Config (env)
# ----------------------------
HTTP_PORT = int(os.getenv("CALYPSO_HTTP_PORT", "8080"))  # (non usato da uvicorn in container)
UDP_RX_PORT = int(os.getenv("CALYPSO_UDP_RX_PORT", "14590"))
UDP_TX_PORT = int(os.getenv("CALYPSO_UDP_TX_PORT", "14591"))
UDP_TX_HOST = os.getenv("CALYPSO_UDP_TX_HOST", "192.168.2.3").strip()
UDP_TX_SLAVE_HOST = os.getenv("CALYPSO_UDP_TX_SLAVE_HOST", "192.168.2.4").strip()
LIGHTS_UDP_TX_HOSTS_RAW = os.getenv("CALYPSO_LIGHTS_UDP_TX_HOSTS", "").strip()
DIAG_DEVICES_RAW = os.getenv("CALYPSO_DIAG_DEVICES", "").strip()
CONTROLLER_UDP_PORT = int(os.getenv("CALYPSO_CONTROLLER_UDP_PORT", "5010"))
CONTROLLER_OFFLINE_MS = int(os.getenv("CALYPSO_CONTROLLER_OFFLINE_MS", "1000"))
LIGHTS_STATUS_OFFLINE_MS = int(os.getenv("CALYPSO_LIGHTS_STATUS_OFFLINE_MS", "3000"))
PODS_HEARTBEAT_ENABLED = os.getenv("CALYPSO_PODS_HEARTBEAT_ENABLED", "1").strip().lower() in ("1", "true", "yes", "on")
PODS_HEARTBEAT_HZ = max(0.1, float(os.getenv("CALYPSO_PODS_HEARTBEAT_HZ", "1")))
LIGHT_FAULT_BITS = [
    {"bit": 0, "value": 0x00000001, "name": "OPENLED"},
    {"bit": 1, "value": 0x00000002, "name": "OVERTEMP"},
    {"bit": 2, "value": 0x00000004, "name": "OVERCURR"},
    {"bit": 3, "value": 0x00000008, "name": "UNDERVOLT"},
    {"bit": 4, "value": 0x00000010, "name": "INA_ALERT"},
]

LOG_DIR = os.getenv("CALYPSO_LOG_DIR", "/data/deepex_logs")
OFFLINE_MS = int(os.getenv("CALYPSO_OFFLINE_MS", "3000"))
AUTOLOG_ENABLED_DEFAULT = os.getenv("CALYPSO_AUTOLOG_ENABLED", "1").strip().lower() in ("1", "true", "yes", "on")
AUTOLOG_DEPTH_M = float(os.getenv("CALYPSO_AUTOLOG_DEPTH_M", "0.5"))
AUTOLOG_HYST_M = float(os.getenv("CALYPSO_AUTOLOG_HYST_M", "0.3"))
FFMPEG_BIN = os.getenv("CALYPSO_FFMPEG_BIN", "ffmpeg")
RTSP_PROXY_TRANSPORT = os.getenv("CALYPSO_RTSP_TRANSPORT", "udp").strip().lower() or "udp"
RTSP_PROXY_FPS = max(1, int(os.getenv("CALYPSO_RTSP_MJPEG_FPS", "24")))
RTSP_PROXY_QSCALE = max(2, int(os.getenv("CALYPSO_RTSP_MJPEG_QSCALE", "7")))

MAVLINK_HOST = os.getenv("MAVLINK_HOST", "127.0.0.1")
MAVLINK_PORT = int(os.getenv("MAVLINK_PORT", "8080"))
MAVLINK_CONN = f"udp:0.0.0.0:{MAVLINK_PORT}"

MAVLINK_WS_URL = os.getenv("MAVLINK_WS_URL", "ws://host.docker.internal:6040/v1/ws/mavlink").strip()
MAVLINK_WS_FALLBACK_URLS = [
    url.strip()
    for url in os.getenv(
        "MAVLINK_WS_FALLBACK_URLS",
        "ws://192.168.2.2:6040/v1/ws/mavlink,ws://blueos:6040/v1/ws/mavlink",
    ).split(",")
    if url.strip()
]
MAVLINK_ENABLED = os.getenv("MAVLINK_ENABLED", "1").strip().lower() in ("1", "true", "yes", "on")

MAVLINK_PYMAVLINK_AVAILABLE = (mavutil is not None)
MAVLINK_WS_ENABLED = MAVLINK_ENABLED and bool(MAVLINK_WS_URL)
MAVLINK_UDP_ENABLED = MAVLINK_ENABLED and (not MAVLINK_WS_ENABLED) and MAVLINK_PYMAVLINK_AVAILABLE
MAV_MODE_FLAG_SAFETY_ARMED = int(
    getattr(getattr(mavutil, "mavlink", object()), "MAV_MODE_FLAG_SAFETY_ARMED", 0x80)
) if mavutil is not None else 0x80

# Ensure log dir exists early
os.makedirs(LOG_DIR, exist_ok=True)

# ----------------------------
# Paths UI
# ----------------------------
BASE_DIR = os.path.dirname(__file__)          # /app/backend/app
UI_DIR = os.path.join(BASE_DIR, "static")     # /app/backend/app/static (contains index.html, app.css, js/...)

# ----------------------------
# App
# ----------------------------
py_logging.basicConfig(level=py_logging.INFO)

app = FastAPI(title="calypso-ui backend")
udp_stats = UdpRxStats()
controller_udp_stats = ControllerBrokerStats()

# Serve UI under /ui (safe with /api routes)
app.mount("/ui", StaticFiles(directory=UI_DIR, html=True), name="ui")

# Root redirect (BlueOS opens "webpage": "/ui")
@app.get("/", include_in_schema=False)
def root():
    return RedirectResponse(url="/ui")

# ----------------------------
# BlueOS service registration
# ----------------------------
@app.get("/register_service", include_in_schema=False)
def register_service():
    return {
        "name": "Calypso UI",
        "description": "DeepEx ROV UI",
        "icon": "mdi-submarine",
        "company": "DeepEx",
        "version": "0.4.14",
        "new_page": True,
        "avoid_iframes": True,
        "works_in_relative_paths": True,
        "webpage": "/ui",
        "api": "/docs",
    }


def is_rtsp_url(url: str) -> bool:
    try:
        return urlparse(url).scheme.lower() in {"rtsp", "rtsps"}
    except Exception:
        return False


async def drain_ffmpeg_stderr(stream: asyncio.StreamReader):
    while True:
        line = await stream.readline()
        if not line:
            return
        msg = line.decode("utf-8", "replace").strip()
        if msg:
            py_logging.info("[video/ffmpeg] %s", msg)


def encode_mjpeg_part(frame: bytes) -> bytes:
    header = (
        b"--frame\r\n"
        b"Content-Type: image/jpeg\r\n"
        + f"Content-Length: {len(frame)}\r\n\r\n".encode("ascii")
    )
    return header + frame + b"\r\n"


async def rtsp_to_mjpeg_stream(url: str, request: Request):
    ffmpeg_path = shutil.which(FFMPEG_BIN) if os.path.sep not in FFMPEG_BIN else FFMPEG_BIN
    if not ffmpeg_path or not os.path.exists(ffmpeg_path):
        raise HTTPException(status_code=503, detail="ffmpeg not available")

    rtsp_opts = []
    if RTSP_PROXY_TRANSPORT == "tcp":
        rtsp_opts = ["-rtsp_flags", "prefer_tcp"]

    cmd = [
        ffmpeg_path,
        "-hide_banner",
        "-loglevel",
        "warning",
        "-rtsp_transport",
        RTSP_PROXY_TRANSPORT,
        *rtsp_opts,
        "-max_delay",
        "0",
        "-reorder_queue_size",
        "0",
        "-probesize",
        "32",
        "-analyzeduration",
        "0",
        "-fflags",
        "nobuffer+discardcorrupt",
        "-flags",
        "low_delay",
        "-flags2",
        "fast",
        "-avioflags",
        "direct",
        "-i",
        url,
        "-an",
        "-sn",
        "-dn",
        "-vf",
        f"fps={RTSP_PROXY_FPS}",
        "-q:v",
        str(RTSP_PROXY_QSCALE),
        "-threads",
        "1",
        "-flush_packets",
        "1",
        "-f",
        "image2pipe",
        "-vcodec",
        "mjpeg",
        "pipe:1",
    ]

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=503, detail="ffmpeg not available") from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"cannot start ffmpeg: {exc}") from exc

    stderr_task = asyncio.create_task(drain_ffmpeg_stderr(proc.stderr))

    async def gen():
        buffer = bytearray()
        try:
            while True:
                if await request.is_disconnected():
                    break

                try:
                    chunk = await asyncio.wait_for(proc.stdout.read(65536), timeout=1.0)
                except asyncio.TimeoutError:
                    if proc.returncode is not None:
                        break
                    continue

                if not chunk:
                    if proc.returncode is not None:
                        break
                    continue

                buffer.extend(chunk)

                while True:
                    start = buffer.find(b"\xff\xd8")
                    if start < 0:
                        if len(buffer) > 2:
                            del buffer[:-2]
                        break
                    if start > 0:
                        del buffer[:start]

                    end = buffer.find(b"\xff\xd9", 2)
                    if end < 0:
                        if len(buffer) > 4_000_000:
                            del buffer[:-2_000_000]
                        break

                    frame = bytes(buffer[:end + 2])
                    del buffer[:end + 2]
                    yield encode_mjpeg_part(frame)
        finally:
            if proc.returncode is None:
                proc.kill()
            await proc.wait()
            await stderr_task

    return StreamingResponse(
        gen(),
        media_type="multipart/x-mixed-replace; boundary=frame",
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )

@app.get("/docs.json", include_in_schema=False)
def docs_json():
    return JSONResponse(app.openapi())

# ----------------------------
# State init + logging
# ----------------------------
init_state(LOG_DIR)
app_logging.init_logging(LOG_DIR, state)
state.setdefault("autolog", {
    "enabled": AUTOLOG_ENABLED_DEFAULT,
    "armed": True,
    "depth_m": AUTOLOG_DEPTH_M,
    "hyst_m": AUTOLOG_HYST_M,
    "last_depth_m": None,
    "starts": 0,
    "last_start_sid": None,
    "last_start_depth_m": None,
})
state.setdefault("sfc_heartbeat", {
    "enabled": PODS_HEARTBEAT_ENABLED,
    "hz": PODS_HEARTBEAT_HZ,
    "seq": 0,
    "tx_total": 0,
    "tx_ok": 0,
    "tx_err": 0,
    "last_ts_ms": None,
    "last_error": None,
    "pods": {
        "BAT1": {"last_ts_ms": None, "last_line": None, "last_targets": [], "last_error": None},
        "BAT2": {"last_ts_ms": None, "last_line": None, "last_targets": [], "last_error": None},
    },
})

# ----------------------------
# WebSocket clients
# ----------------------------
ws_clients: Set[WebSocket] = set()

async def ws_broadcast(obj: dict):
    dead = []
    for ws in list(ws_clients):
        try:
            await ws.send_json(obj)
        except Exception:
            dead.append(ws)
    for ws in dead:
        ws_clients.discard(ws)

@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    ws_clients.add(ws)
    try:
        if latest.get("last_line"):
            await ws.send_json({"type": "last", "raw": latest["last_line"]})
        while True:
            # Keep connection alive; consume client messages if any
            try:
                await ws.receive_text()
            except Exception:
                await asyncio.sleep(30)
    finally:
        ws_clients.discard(ws)

# ----------------------------
# Utils
# ----------------------------
def now_ms() -> int:
    return int(asyncio.get_running_loop().time() * 1000) & 0xFFFFFFFF

def to_float_or_none(v) -> Optional[float]:
    try:
        x = float(v)
    except Exception:
        return None
    if not math.isfinite(x):
        return None
    return x

def update_depth_from_alt(alt_m):
    """Normalize MAVLink altitude to depth (down positive)."""
    nav = state.setdefault("nav", {})
    alt_f = to_float_or_none(alt_m)
    if alt_f is None:
        return
    nav["alt_m"] = alt_f
    nav["depth_m"] = max(0.0, -alt_f)

def update_depth_from_dict(msg: dict):
    nav = state.setdefault("nav", {})
    for key in ("depth_m", "depth", "Depth", "DEPTH"):
        if key in msg:
            d = to_float_or_none(msg.get(key))
            if d is not None:
                nav["depth_m"] = d
            break


def nav_target_dict() -> dict:
    nav = state.setdefault("nav", {})
    target = nav.get("target")
    if not isinstance(target, dict):
        target = {}
        nav["target"] = target
    target.setdefault("heading_deg", None)
    target.setdefault("depth_m", None)
    target.setdefault("pitch_deg", None)
    target.setdefault("roll_deg", None)
    return target


def normalize_heading_deg(heading_deg) -> Optional[float]:
    hdg = to_float_or_none(heading_deg)
    if hdg is None:
        return None
    hdg = math.fmod(hdg, 360.0)
    if hdg < 0:
        hdg += 360.0
    return hdg


def quaternion_to_euler_deg(q) -> tuple[Optional[float], Optional[float], Optional[float]]:
    if q is None:
        return (None, None, None)
    try:
        values = list(q)
    except Exception:
        return (None, None, None)
    if len(values) != 4:
        return (None, None, None)
    try:
        w, x, y, z = (float(v) for v in values)
    except Exception:
        return (None, None, None)

    sinr_cosp = 2.0 * (w * x + y * z)
    cosr_cosp = 1.0 - 2.0 * (x * x + y * y)
    roll_deg = math.degrees(math.atan2(sinr_cosp, cosr_cosp))

    sinp = 2.0 * (w * y - z * x)
    if abs(sinp) >= 1.0:
        pitch_deg = math.degrees(math.copysign(math.pi / 2.0, sinp))
    else:
        pitch_deg = math.degrees(math.asin(sinp))

    siny_cosp = 2.0 * (w * z + x * y)
    cosy_cosp = 1.0 - 2.0 * (y * y + z * z)
    yaw_deg = normalize_heading_deg(math.degrees(math.atan2(siny_cosp, cosy_cosp)))
    return (roll_deg, pitch_deg, yaw_deg)


def update_nav_target_attitude(q=None, yaw_rad=None) -> None:
    target = nav_target_dict()
    roll_deg = pitch_deg = yaw_deg = None
    if q is not None:
        roll_deg, pitch_deg, yaw_deg = quaternion_to_euler_deg(q)
    elif yaw_rad is not None:
        yaw_f = to_float_or_none(yaw_rad)
        if yaw_f is not None:
            yaw_deg = normalize_heading_deg(math.degrees(yaw_f))

    if roll_deg is not None:
        target["roll_deg"] = roll_deg
    if pitch_deg is not None:
        target["pitch_deg"] = pitch_deg
    if yaw_deg is not None:
        target["heading_deg"] = yaw_deg


def update_nav_target_depth_from_local_ned(z_down_m) -> None:
    depth_m = to_float_or_none(z_down_m)
    if depth_m is None:
        return
    target = nav_target_dict()
    target["depth_m"] = depth_m if depth_m >= 0.0 else None


def normalize_bool01(v) -> Optional[int]:
    if isinstance(v, bool):
        return 1 if v else 0
    if isinstance(v, (int, float)):
        return 1 if int(v) != 0 else 0
    if isinstance(v, str):
        tok = v.strip().lower()
        if tok in ("1", "true", "on", "armed", "enable", "enabled"):
            return 1
        if tok in ("0", "false", "off", "disarmed", "disable", "disabled"):
            return 0
    if isinstance(v, (list, tuple, set)):
        txt = " ".join(str(x) for x in v).upper()
        if "SAFETY_ARMED" in txt:
            return 1
    return None


def parse_safety_armed_from_base_mode(base_mode) -> Optional[int]:
    if base_mode is None:
        return None

    if isinstance(base_mode, dict):
        bits = base_mode.get("bits") or base_mode.get("flags")
        armed_bits = normalize_bool01(bits)
        if armed_bits is not None:
            return armed_bits
        raw = base_mode.get("value", base_mode.get("raw"))
        if raw is None:
            return None
        base_mode = raw

    if isinstance(base_mode, str):
        tok = base_mode.strip()
        if not tok:
            return None
        if "SAFETY_ARMED" in tok.upper():
            return 1
        try:
            base_mode = int(tok, 0)
        except Exception:
            return None

    try:
        bm = int(base_mode)
    except Exception:
        return None
    return 1 if (bm & MAV_MODE_FLAG_SAFETY_ARMED) else 0


def parse_armed_from_system_status(system_status) -> Optional[int]:
    # MAVLink system_status reports the autopilot state (for example ACTIVE or
    # STANDBY), not motor arming. Arming must come from base_mode's
    # MAV_MODE_FLAG_SAFETY_ARMED bit or an explicit safety_armed field.
    return None


def update_mav_heartbeat_armed(base_mode=None, safety_armed=None, system_status=None, source: str = "HEARTBEAT") -> None:
    armed = parse_armed_from_system_status(system_status)
    if armed is None:
        armed = normalize_bool01(safety_armed)
    if armed is None:
        armed = parse_safety_armed_from_base_mode(base_mode)
    if armed is None:
        return

    bm: Optional[int] = None
    try:
        if isinstance(base_mode, dict):
            bm_raw = base_mode.get("value", base_mode.get("raw"))
            if bm_raw is not None:
                bm = int(bm_raw)
        elif base_mode is not None and not isinstance(base_mode, (list, tuple, set)):
            bm = int(base_mode)
    except Exception:
        bm = None

    sys_status: Optional[int] = None
    try:
        if isinstance(system_status, dict):
            ss_raw = system_status.get("value", system_status.get("raw"))
            if ss_raw is not None:
                sys_status = int(ss_raw)
        elif system_status is not None and not isinstance(system_status, (list, tuple, set)):
            sys_status = int(system_status)
    except Exception:
        sys_status = None

    mav = state.setdefault("mav", {"last_ms": 0, "msgs": 0, "drops": 0})
    prev = mav.get("safety_armed")
    mav["safety_armed"] = int(armed)
    mav["base_mode"] = bm
    mav["system_status"] = sys_status
    mav["last_heartbeat_ms"] = int(datetime.utcnow().timestamp() * 1000) & 0xFFFFFFFF
    mav["last_heartbeat_source"] = source

    if prev is not None and int(prev) == int(armed):
        return

    nav = state.get("nav") or {}
    txt = f"HEARTBEAT MAV_STATE_ARMED={int(armed)}"
    if sys_status is not None:
        txt += f" system_status={sys_status}"
    if bm is not None:
        txt += f" base_mode={bm}"
    txt += f" src={source}"
    append_event_jsonl({
        "ts_ms": int(state.get("last_update_ms") or 0),
        "mission_time": nav.get("mission_time_s"),
        "depth": nav.get("depth_m"),
        "heading": nav.get("heading_deg"),
        "lat": nav.get("lat_deg"),
        "lon": nav.get("lon_deg"),
        "alt_m": nav.get("alt_m"),
        "src": "MAV",
        "type": "MAV_ARM",
        "armed": int(armed),
        "base_mode": bm,
        "system_status": sys_status,
        "text": txt,
    })

def build_nmea_line(fields: list[str]) -> str:
    return parser.build_nmea_line(fields)

def parse_nmea_line(line: str):
    return parser.parse_nmea_line(line)


_tx_seq_by_msg: dict[str, int] = {}


def next_tx_seq(msg: str) -> int:
    key = str(msg or "").upper() or "GEN"
    seq = (_tx_seq_by_msg.get(key, 0) + 1) & 0xFFFFFFFF
    _tx_seq_by_msg[key] = seq
    return seq

# Lights config delegation
load_lights_cfg = lights_cfg.load_lights_cfg
save_lights_cfg = lights_cfg.save_lights_cfg
normalize_lights_cfg = lights_cfg.normalize_lights_cfg
light_channel_pod = lights_cfg.channel_pod
LIGHT_PODS = ("BAT1", "BAT2")


def parse_udp_hosts(raw: str) -> list[str]:
    hosts: list[str] = []
    for item in raw.replace(";", ",").split(","):
        host = item.strip()
        if host and host not in hosts:
            hosts.append(host)
    return hosts


def lights_udp_tx_hosts() -> list[str]:
    if LIGHTS_UDP_TX_HOSTS_RAW:
        hosts = parse_udp_hosts(LIGHTS_UDP_TX_HOSTS_RAW)
    else:
        hosts = parse_udp_hosts(",".join([UDP_TX_HOST, UDP_TX_SLAVE_HOST]))
    return hosts or [UDP_TX_HOST]


def send_udp_line(line: str, targets: list[tuple[str, int]]) -> list[str]:
    sent: list[str] = []
    errors: list[str] = []
    data = line.encode("ascii")
    for host, port in targets:
        try:
            udp_tx_sock.sendto(data, (host, port))
            sent.append(f"{host}:{port}")
        except Exception as e:
            errors.append(f"{host}:{port} {e}")
    if errors:
        raise RuntimeError("; ".join(errors))
    return sent


def light_pod_host(pod: str) -> str:
    if pod == "BAT1":
        return UDP_TX_HOST
    if pod == "BAT2":
        return UDP_TX_SLAVE_HOST
    return ""


def pod_command_destinations(dst: str) -> list[tuple[str, str, int]]:
    pods = ("BAT1", "BAT2") if dst == "ALL" else (dst,)
    targets: list[tuple[str, str, int]] = []
    for pod in pods:
        for host in parse_udp_hosts(light_pod_host(pod)):
            targets.append((pod, host, UDP_TX_PORT))
    return targets


def lights_ids_for_pod(cfg: dict, pod: str) -> list[int]:
    pod_cfg = (cfg.get("pods") or {}).get(pod) or {}
    ids = pod_cfg.get("lamp_ids", [])
    if not isinstance(ids, list):
        return []
    return sorted(set(int(x) for x in ids if isinstance(x, int) and x >= 1))


def light_channels_for_id(cfg: dict, light_id: int, pod: str = "") -> list[str]:
    channels = cfg.get("channels") or {}
    out: list[str] = []
    for ch_key, ch_cfg in channels.items():
        if not isinstance(ch_cfg, dict):
            continue
        ch_pod = str(ch_cfg.get("pod") or light_channel_pod(str(ch_key)))
        if pod and ch_pod != pod:
            continue
        ids = ch_cfg.get("lamp_ids", [])
        if isinstance(ids, list) and light_id in ids:
            out.append(str(ch_key))
    return sorted(out, key=lambda x: int(x) if x.isdigit() else 99)


def build_lights_ids_line(pod: str, ids: list[int], cmd_id: int, ts: int) -> str:
    fields = [
        "SFC", pod, "CMD", "2",
        str(cmd_id), str(ts),
        "CmdId", str(cmd_id),
        "Type", "LGT_IDS",
        "Ids", ";".join(str(x) for x in ids),
    ]
    return build_nmea_line(fields)


def build_pod_heartbeat_line(pod: str, seq: int, ts: int) -> str:
    hb = state.setdefault("sfc_heartbeat", {})
    fields = [
        "SFC", pod, "HB", "2",
        str(seq), str(ts),
        "Up", "1",
        "NodeState", "1",
        "RxErr", str(int(state.get("counters", {}).get("parse_err", 0))),
        "TxErr", str(int(hb.get("tx_err", 0))),
    ]
    return build_nmea_line(fields)


def record_pod_heartbeat_tx(pod: str, ts: int, line: str, targets: list[str] | None = None, error: str | None = None) -> None:
    hb = state.setdefault("sfc_heartbeat", {})
    hb["enabled"] = PODS_HEARTBEAT_ENABLED
    hb["hz"] = PODS_HEARTBEAT_HZ
    hb["last_ts_ms"] = int(ts)
    hb["seq"] = int(hb.get("seq", 0))
    hb["tx_total"] = int(hb.get("tx_total", 0)) + 1
    pods = hb.setdefault("pods", {})
    pod_state = pods.setdefault(str(pod), {"last_ts_ms": None, "last_line": None, "last_targets": [], "last_error": None})
    pod_state["last_ts_ms"] = int(ts)
    pod_state["last_line"] = line.strip()
    pod_state["last_targets"] = list(targets or [])
    pod_state["last_error"] = None if error is None else str(error)
    if error is None:
        hb["tx_ok"] = int(hb.get("tx_ok", 0)) + 1
    else:
        hb["tx_err"] = int(hb.get("tx_err", 0)) + 1
    hb["last_error"] = "; ".join(
        f"{pod_name}: {pod_info.get('last_error')}"
        for pod_name, pod_info in pods.items()
        if pod_info.get("last_error")
    ) or None


def shutdown_state() -> dict:
    return state.setdefault("system", {}).setdefault("shutdown", {
        "in_progress": False,
        "requested_ts_ms": 0,
        "requested_by": None,
        "cmd_id": None,
        "dst": "BAT1",
        "host": None,
        "last_error": None,
    })


def shutdown_in_progress() -> bool:
    return bool(shutdown_state().get("in_progress"))


def reject_if_shutdown_in_progress(allowed_cmd: str | None = None):
    shdn = shutdown_state()
    if not shdn.get("in_progress"):
        return None
    if str(allowed_cmd or "").strip().upper() == "SHDN":
        return None
    return JSONResponse({
        "ok": False,
        "err": "shutdown in progress",
        "shutdown": shdn,
    }, status_code=409)


async def pods_heartbeat_task():
    period_s = 1.0 / PODS_HEARTBEAT_HZ
    while True:
        if shutdown_in_progress():
            await asyncio.sleep(period_s)
            continue
        ts = now_ms()
        seq = next_tx_seq("HB")
        hb = state.setdefault("sfc_heartbeat", {})
        hb["seq"] = seq

        for pod in LIGHT_PODS:
            host = light_pod_host(pod)
            if not host:
                record_pod_heartbeat_tx(pod, ts, "", [], "host not configured")
                continue

            line = build_pod_heartbeat_line(pod, seq, ts)
            try:
                sent_targets = send_udp_line(line, [(host, UDP_TX_PORT)])
                record_pod_heartbeat_tx(pod, ts, line, sent_targets, None)
            except Exception as e:
                record_pod_heartbeat_tx(pod, ts, line, [], str(e))
        await asyncio.sleep(period_s)


def send_lights_ids_messages(cfg: Optional[dict] = None) -> dict:
    cfg = cfg or load_lights_cfg()
    cmd_id = next_cmd_id()
    ts = int(state["last_update_ms"] or 0)
    sent_messages: list[dict] = []
    skipped: list[dict] = []

    for pod in LIGHT_PODS:
        host = light_pod_host(pod)
        ids = lights_ids_for_pod(cfg, pod)
        if not host:
            skipped.append({"pod": pod, "reason": "host not configured", "ids": ids})
            continue

        line = build_lights_ids_line(pod, ids, cmd_id, ts)
        targets = [(host, UDP_TX_PORT)]
        sent_targets = send_udp_line(line, targets)
        sent_messages.append({
            "pod": pod,
            "ids": ids,
            "line": line.strip(),
            "udp_targets": sent_targets,
        })

    return {
        "cmd_id": cmd_id,
        "messages": sent_messages,
        "skipped": skipped,
    }


def light_fault_active(value) -> bool:
    if value is None:
        return False
    try:
        return int(value) != 0
    except Exception:
        return str(value).strip().upper() not in ("", "0", "OK", "NONE", "NO", "FALSE")


def light_fault_mask(value) -> int:
    if value is None:
        return 0
    try:
        if isinstance(value, str):
            return int(value.strip(), 0)
        return int(value)
    except Exception:
        return 0


def light_fault_names(value) -> list[str]:
    mask = light_fault_mask(value)
    return [str(f["name"]) for f in LIGHT_FAULT_BITS if mask & int(f["value"])]


def light_fault_text(value) -> str:
    mask = light_fault_mask(value)
    if mask == 0:
        return "0"
    names = light_fault_names(mask)
    suffix = f" {'/'.join(names)}" if names else " UNKNOWN"
    return f"0x{mask:08X}{suffix}"


def parse_diag_devices(raw: str) -> list[dict]:
    devices: list[dict] = []
    for item in raw.split(";"):
        parts = [p.strip() for p in item.split("|")]
        if not parts or not parts[0]:
            continue
        node = parts[0]
        role = parts[1] if len(parts) > 1 and parts[1] else node
        ip = parts[2] if len(parts) > 2 else ""
        url = parts[3] if len(parts) > 3 else ""
        devices.append({"node": node, "role": role, "ip": ip, "url": url})
    return devices


def diag_device_configs() -> list[dict]:
    if DIAG_DEVICES_RAW:
        devices = parse_diag_devices(DIAG_DEVICES_RAW)
        if devices:
            return devices
    return [
        {"node": "BAT1", "role": "MASTER", "ip": "192.168.2.3", "url": "http://192.168.2.3"},
        {"node": "BAT2", "role": "SLAVE", "ip": "192.168.2.4", "url": "http://192.168.2.4"},
    ]


def build_diagnostics_state() -> dict:
    now_ms = int(time.monotonic() * 1000)
    nodes = state.get("nodes", {}) or {}
    devices: list[dict] = []
    configured = set()

    def age_from_monotonic(value) -> int | None:
        if value is None:
            return None
        try:
            return max(0, now_ms - int(value))
        except Exception:
            return None

    def device_row(node_name: str, role: str = "", fallback_ip: str = "", fallback_url: str = "") -> dict:
        node = nodes.get(node_name, {}) or {}
        rx_ip = str(node.get("ip") or "")
        ip = str(fallback_ip or rx_ip or "")
        url = str(fallback_url or (f"http://{ip}" if ip else ""))
        last_rx_age = age_from_monotonic(node.get("last_rx_monotonic_ms"))
        last_hb_age = age_from_monotonic(node.get("last_seen_monotonic_ms"))
        network_ok = last_rx_age is not None and last_rx_age <= OFFLINE_MS
        online = bool(node.get("online")) if node.get("online") is not None else network_ok
        status_kind = "ok" if network_ok and online else "bad"
        return {
            "node": node_name,
            "kind": "Power pod",
            "role": role or node_name,
            "online": online,
            "network_ok": network_ok,
            "status_kind": status_kind,
            "status_text": "ONLINE" if status_kind == "ok" else "OFFLINE",
            "ip": ip,
            "rx_ip": rx_ip,
            "url": url,
            "udp_port": node.get("udp_port"),
            "last_rx_ms": node.get("last_rx_ms"),
            "last_hb_ms": node.get("last_hb_ms"),
            "last_rx_age_ms": last_rx_age,
            "last_hb_age_ms": last_hb_age,
        }

    def light_child_row(pod: str, light_id: int, st: dict | None) -> dict:
        channels = light_channels_for_id(lights_current_cfg, light_id, pod)
        role = f"{pod} {'/'.join(f'CH{x}' for x in channels)}".strip()
        if not st:
            return {
                "node": f"LGT{light_id}",
                "kind": "Faro",
                "role": role,
                "online": False,
                "network_ok": False,
                "status_kind": "warn",
                "status_text": "MISSING",
                "detail": "Nessuno status ricevuto.",
            }

        age = age_from_monotonic(st.get("last_seen_monotonic_ms"))
        fault = st.get("Fault")
        has_fault = light_fault_active(fault)
        is_stale = age is None or age > LIGHTS_STATUS_OFFLINE_MS
        kind = "bad" if has_fault else ("warn" if is_stale else "ok")
        text = "FAULT" if has_fault else ("STALE" if is_stale else "OK")
        return {
            "node": f"LGT{light_id}",
            "kind": "Faro",
            "role": role,
            "online": not is_stale,
            "network_ok": not is_stale and not has_fault,
            "status_kind": kind,
            "status_text": text,
            "last_rx_age_ms": age,
            "detail": (
                f"mode={st.get('Mode', '-')} state={st.get('State', '-')} "
                f"dim={st.get('Dim', '-')} out={st.get('Out', '-')} "
                f"fault={light_fault_text(fault)} uptime={st.get('Uptime', '-')}"
            ),
            "faults": light_fault_names(fault),
        }

    for cfg in diag_device_configs():
        node_name = str(cfg.get("node") or "").strip()
        if not node_name:
            continue
        configured.add(node_name)
        devices.append(device_row(
            node_name,
            str(cfg.get("role") or node_name),
            str(cfg.get("ip") or ""),
            str(cfg.get("url") or ""),
        ))

    for node_name in sorted(str(k) for k in nodes.keys()):
        if node_name in configured:
            continue
        if node_name.startswith("LGT"):
            continue
        devices.append(device_row(node_name))

    blueos_ip = os.getenv("BLUEOS_IP", "192.168.2.2").strip() or "192.168.2.2"
    mav = state.get("mav", {}) or {}
    mav_age = age_from_monotonic(mav.get("last_seen_monotonic_ms"))
    mav_enabled = bool(MAVLINK_ENABLED)
    mav_ok = mav_enabled and mav_age is not None and mav_age <= 3000
    mav_ws_url = str(mav.get("ws_url") or MAVLINK_WS_URL or "")
    mav_error = str(mav.get("last_error") or "")
    mav_detail = (
        f"msgs={mav.get('msgs', 0)} source={mav.get('last_heartbeat_source', '-')} "
        f"ws={mav_ws_url or '-'} connected={mav.get('connected', False)}"
    )
    if mav_error:
        mav_detail += f" error={mav_error}"
    devices.append({
        "node": "BLUEOS",
        "kind": "BlueOS / MAVLink",
        "role": "MAVLINK",
        "online": mav_ok,
        "network_ok": mav_ok,
        "status_kind": "ok" if mav_ok else ("warn" if mav_enabled else "muted"),
        "status_text": "MAVLINK OK" if mav_ok else ("WAIT MAVLINK" if mav_enabled else "DISABLED"),
        "ip": blueos_ip,
        "url": f"http://{blueos_ip}",
        "last_rx_age_ms": mav_age,
        "detail": mav_detail,
    })

    ctrl = state.get("controller", {}) or {}
    ctrl_age = age_from_monotonic(ctrl.get("last_seen_monotonic_ms"))
    broker_ok = bool(controller_udp_stats.listener_ok)
    devices.append({
        "node": "CTRL_BROKER",
        "kind": "Controller broker",
        "role": "UDP RX",
        "online": broker_ok,
        "network_ok": broker_ok,
        "status_kind": "ok" if broker_ok else "bad",
        "status_text": "LISTEN" if broker_ok else "OFF",
        "ip": controller_udp_stats.listener_bind,
        "udp_port": controller_udp_stats.listener_port,
        "last_rx_age_ms": ctrl_age,
        "detail": f"valid={controller_udp_stats.rx_valid} invalid={controller_udp_stats.rx_invalid}",
    })

    joy_ok = bool(ctrl.get("online"))
    joy_stale = bool((ctrl.get("health") or {}).get("link_stale"))
    devices.append({
        "node": "JOYSTICK",
        "kind": "Controller link",
        "role": str(ctrl.get("active_link") or "no_link").upper(),
        "online": joy_ok,
        "network_ok": joy_ok,
        "status_kind": "ok" if joy_ok else ("warn" if ctrl_age is not None else "bad"),
        "status_text": "ONLINE" if joy_ok else ("STALE" if joy_stale else "NO LINK"),
        "last_rx_age_ms": ctrl_age,
        "detail": f"quality={ctrl.get('source_quality', '-')} vjoy={(ctrl.get('health') or {}).get('vjoy_ok', '-')}",
    })

    sonar = state.get("sonar", {}).get("ping360", {}) or {}
    sonar_ip = str(sonar.get("remote_ip") or sonar.get("fallback_ip") or "")
    sonar_age = age_from_monotonic(sonar.get("last_rx_monotonic_ms"))
    sonar_enabled = bool(sonar.get("enabled"))
    sonar_link = sonar_enabled and bool(sonar.get("connected")) and bool(sonar.get("scanning"))
    sonar_ok = sonar_link and sonar_age is not None and sonar_age <= 3000
    devices.append({
        "node": "PING360",
        "kind": "Sonar",
        "role": "UDP",
        "online": sonar_ok,
        "network_ok": sonar_ok,
        "status_kind": "ok" if sonar_ok else ("warn" if sonar_enabled else "muted"),
        "status_text": "DATA OK" if sonar_ok else ("WAIT DATA" if sonar_link else ("WAIT" if sonar_enabled else "DISABLED")),
        "ip": sonar_ip,
        "udp_port": sonar.get("port"),
        "last_rx_age_ms": sonar_age,
        "detail": f"rx={sonar.get('rx_total', 0)} err={sonar.get('last_err') or '-'}",
    })

    lights_current_cfg = load_lights_cfg()
    light_status_by_id = state.get("lights", {}).get("ids", {}) or {}
    for pod, ip in (("BAT1", "192.168.2.3"), ("BAT2", "192.168.2.4")):
        pod_ids = lights_ids_for_pod(lights_current_cfg, pod)
        missing: list[int] = []
        stale: list[int] = []
        faults: list[int] = []
        ages: list[int] = []
        light_children: list[dict] = []

        for light_id in pod_ids:
            st = light_status_by_id.get(str(light_id))
            light_children.append(light_child_row(pod, light_id, st))
            if not st:
                missing.append(light_id)
                continue
            age = age_from_monotonic(st.get("last_seen_monotonic_ms"))
            if age is None:
                missing.append(light_id)
                continue
            ages.append(age)
            if age > LIGHTS_STATUS_OFFLINE_MS:
                stale.append(light_id)
            fault = st.get("Fault")
            if light_fault_active(fault):
                faults.append(light_id)

        if not pod_ids:
            light_kind = "muted"
            light_text = "NO IDS"
            light_online = False
            light_ok = False
        elif faults:
            light_kind = "bad"
            light_text = "FAULT"
            light_online = True
            light_ok = False
        elif missing:
            light_kind = "warn"
            light_text = "WAIT STATUS"
            light_online = False
            light_ok = False
        elif stale:
            light_kind = "warn"
            light_text = "STALE"
            light_online = False
            light_ok = False
        else:
            light_kind = "ok"
            light_text = "STATUS OK"
            light_online = True
            light_ok = True

        detail_parts = [f"IDs={';'.join(str(x) for x in pod_ids) or '-'}"]
        pod_channels = [ch for ch in ("1", "2", "3", "4") if light_channel_pod(ch) == pod]
        detail_parts.append(f"canali={'/'.join(f'CH{x}' for x in pod_channels)}")
        if missing:
            detail_parts.append(f"missing={';'.join(str(x) for x in missing)}")
        if stale:
            detail_parts.append(f"stale={';'.join(str(x) for x in stale)}")
        devices.append({
            "node": f"LGT_{pod}",
            "kind": "Fari",
            "role": pod,
            "online": light_online,
            "network_ok": light_ok,
            "status_kind": light_kind,
            "status_text": light_text,
            "ip": ip,
            "url": f"http://{ip}",
            "last_rx_age_ms": max(ages) if ages else None,
            "detail": "; ".join(detail_parts),
            "children": light_children,
        })

    return {
        "offline_ms": OFFLINE_MS,
        "devices": devices,
    }

# Ping360 runtime
ping360_stop: Optional[asyncio.Event] = None
ping360_task_handle: Optional[asyncio.Task] = None

def start_ping360_runtime():
    global ping360_stop, ping360_task_handle
    ping360_stop = asyncio.Event()
    ping360_task_handle = asyncio.create_task(ping360_task(state, ws_broadcast, ping360_stop))

async def stop_ping360_runtime():
    global ping360_stop, ping360_task_handle
    if ping360_stop is not None:
        ping360_stop.set()
    if ping360_task_handle is not None and not ping360_task_handle.done():
        try:
            await asyncio.wait_for(ping360_task_handle, timeout=2.0)
        except asyncio.TimeoutError:
            ping360_task_handle.cancel()
        except Exception:
            pass
    ping360_stop = None
    ping360_task_handle = None

async def restart_ping360_runtime():
    await stop_ping360_runtime()
    start_ping360_runtime()

# UDP TX socket (created at import time is fine)
udp_tx_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

# ----------------------------
# UDP RX Server
# ----------------------------
def handle_udp_datagram(data: bytes, addr):
    try:
        state["counters"]["udp_rx"] += 1
        line = data.decode("ascii", errors="ignore")
    except Exception:
        return

    parsed, err = parse_nmea_line(line)
    if err:
        state["counters"]["parse_err"] += 1
        if err == "checksum":
            state["counters"]["cksum_err"] += 1
        return

    latest["last_line"] = parsed["raw"]
    append_telemetry_csv(parsed)
    update_state(parsed)
    src = parsed.get("src")
    if src:
        node = state["nodes"].setdefault(src, {})
        node["last_rx_monotonic_ms"] = int(time.monotonic() * 1000)
        if addr:
            node["ip"] = addr[0]
            node["udp_port"] = addr[1]
        clear_node_offline_alarm(src, parsed.get("ts_ms"))

    asyncio.create_task(ws_broadcast({
        "type": "udp",
        "src": parsed["src"],
        "msg": parsed["msg"],
        "ts_ms": parsed["ts_ms"],
        "raw": parsed["raw"],
    }))


def clear_node_offline_alarm(node: str, ts_ms=None) -> None:
    if node not in state.get("pods", {}):
        return

    target_text = f"NODE_OFFLINE:{node}"
    active = state.get("alarms_active", [])
    remaining = [
        alarm for alarm in active
        if not (
            str(alarm.get("src")) == "SFC"
            and str(alarm.get("id")) == "9001"
            and str(alarm.get("text")) == target_text
        )
    ]
    if len(remaining) == len(active):
        return

    state["alarms_active"] = remaining
    alarm = {
        "ts_ms": ts_ms if ts_ms is not None else state.get("last_update_ms"),
        "src": "SFC",
        "id": 9001,
        "sev": 3,
        "active": 0,
        "latched": 0,
        "text": target_text,
    }
    state["alarms_history"].append(alarm)
    append_alarm_csv(alarm)
    asyncio.create_task(ws_broadcast({"type": "alarm", "alarm": alarm}))


def handle_controller_payload(controller_state: dict, addr):
    state["controller"] = controller_state
    state["counters"]["controller_udp_rx"] = int(state["counters"].get("controller_udp_rx", 0)) + 1

    asyncio.create_task(ws_broadcast({
        "type": "controller",
        "controller": controller_state,
        "udp": {
            "listener_ok": controller_udp_stats.listener_ok,
            "port": controller_udp_stats.listener_port,
            "rx_total": controller_udp_stats.rx_total,
            "rx_valid": controller_udp_stats.rx_valid,
            "rx_invalid": controller_udp_stats.rx_invalid,
            "last_from": controller_udp_stats.rx_last_from,
            "last_error": controller_udp_stats.rx_last_error,
        },
    }))


async def offline_watchdog():
    while True:
        await asyncio.sleep(1.0)
        now_ms = int(time.monotonic() * 1000)
        for node, info in state["nodes"].items():
            last_rx = info.get("last_rx_monotonic_ms")
            if last_rx is None:
                continue
            dt = now_ms - int(last_rx)
            if dt > OFFLINE_MS and info.get("online"):
                info["online"] = False
                if node in state.get("pods", {}):
                    state["pods"][node]["online"] = False
                alarm = {
                    "ts_ms": state["last_update_ms"],
                    "src": "SFC",
                    "id": 9001,
                    "sev": 3,
                    "active": 1,
                    "latched": 0,
                    "text": f"NODE_OFFLINE:{node}",
                }
                state["alarms_history"].append(alarm)
                state["alarms_active"].append(alarm)
                append_alarm_csv(alarm)
                await ws_broadcast({"type": "alarm", "alarm": alarm})

async def autolog_watchdog():
    rearm_m = AUTOLOG_DEPTH_M + AUTOLOG_HYST_M
    while True:
        await asyncio.sleep(1.0)

        al = state.setdefault("autolog", {})
        enabled = bool(al.get("enabled", AUTOLOG_ENABLED_DEFAULT))
        al["enabled"] = enabled
        al["depth_m"] = AUTOLOG_DEPTH_M
        al["hyst_m"] = AUTOLOG_HYST_M

        if not enabled:
            continue

        nav = state.get("nav") or {}
        depth = to_float_or_none(nav.get("depth_m"))
        if depth is None:
            continue

        al["last_depth_m"] = depth

        if depth >= rearm_m:
            al["armed"] = True

        if state.get("logging", {}).get("enabled"):
            continue

        if al.get("armed", True) and depth < AUTOLOG_DEPTH_M:
            sid = make_sid()
            set_session_paths(sid)
            state["logging"] = {"enabled": True, "sid": sid}

            al["armed"] = False
            al["starts"] = int(al.get("starts", 0)) + 1
            al["last_start_sid"] = sid
            al["last_start_depth_m"] = depth

            append_event_jsonl({
                "ts_ms": int(state.get("last_update_ms") or 0),
                "mission_time": nav.get("mission_time_s"),
                "depth": depth,
                "heading": nav.get("heading_deg"),
                "lat": nav.get("lat_deg"),
                "lon": nav.get("lon_deg"),
                "alt_m": nav.get("alt_m"),
                "src": "SFC",
                "type": "AUTOLOG",
                "text": f"Auto-start logging depth<{AUTOLOG_DEPTH_M:.2f}m",
            })


async def controller_broker_watchdog():
    while True:
        await asyncio.sleep(0.25)
        controller = state.get("controller") or {}
        last_seen = int(controller.get("last_seen_monotonic_ms") or 0)
        if last_seen <= 0:
            continue

        now_monotonic_ms = int(time.monotonic() * 1000)
        if now_monotonic_ms - last_seen <= CONTROLLER_OFFLINE_MS:
            continue

        now_wall_ms = int(time.time() * 1000)
        if mark_controller_stale(controller, now_wall_ms):
            state["controller"] = controller
            await ws_broadcast({
                "type": "controller",
                "controller": controller,
                "udp": {
                    "listener_ok": controller_udp_stats.listener_ok,
                    "port": controller_udp_stats.listener_port,
                    "rx_total": controller_udp_stats.rx_total,
                    "rx_valid": controller_udp_stats.rx_valid,
                    "rx_invalid": controller_udp_stats.rx_invalid,
                    "last_from": controller_udp_stats.rx_last_from,
                    "last_error": "controller UDP timeout",
                },
            })

# ----------------------------
# Startup (single)
# ----------------------------
@app.on_event("startup")
async def startup():
    loop = asyncio.get_running_loop()

    # UDP listener
    await start_udp_listener(udp_stats, on_datagram=handle_udp_datagram)
    await start_controller_broker_listener(controller_udp_stats, on_payload=handle_controller_payload)

    # background tasks
    asyncio.create_task(offline_watchdog())
    asyncio.create_task(autolog_watchdog())
    asyncio.create_task(controller_broker_watchdog())
    if PODS_HEARTBEAT_ENABLED:
        asyncio.create_task(pods_heartbeat_task())

    # Ping360 task
    start_ping360_runtime()
    
    MAVLINK_UDP_ENABLED = False

    print("[mavlink] ENABLED:", MAVLINK_ENABLED,
      "WS_URL:", MAVLINK_WS_URL,
      "WS_FALLBACK_URLS:", MAVLINK_WS_FALLBACK_URLS,
      "WS_ENABLED:", MAVLINK_WS_ENABLED,
      "UDP_ENABLED:", MAVLINK_UDP_ENABLED,
      "CONN:", MAVLINK_CONN)
    
    # MAVLink optional
    if MAVLINK_WS_ENABLED:
        asyncio.create_task(mavlink_ws_loop())
    elif MAVLINK_UDP_ENABLED:
        asyncio.create_task(mavlink_reader())
    else:
        print("[mavlink] disabled or no available transport")

    # TODO(spec TODO-IMPL-MAVLINK-BRIDGE): publish selected telemetry/alarm subset to BlueOS/Cockpit once dataset is finalized.

@app.on_event("shutdown")
async def shutdown():
    await stop_ping360_runtime()

# ----------------------------
# API
# ----------------------------
@app.get("/api/state")
def api_state():
    expire_pending_cmds()
    return {
        **state,
        "udp": {
            "listener_ok": udp_stats.listener_ok,
            "bind": udp_stats.listener_bind,
            "port": udp_stats.listener_port,
            "error": udp_stats.listener_error,
            "rx_total": udp_stats.rx_total,
            "last_ts_ms": udp_stats.rx_last_ts_ms,
            "last_from": udp_stats.rx_last_from,
            "last_len": udp_stats.rx_last_len,
            "last_msg": udp_stats.rx_last_msg,
            "last_src": udp_stats.rx_last_src,
            "last_dst": udp_stats.rx_last_dst,
            "last_ck_ok": udp_stats.rx_last_ck_ok,
            "last_prefix": udp_stats.rx_last_prefix,
        },
        "controller_udp": {
            "listener_ok": controller_udp_stats.listener_ok,
            "bind": controller_udp_stats.listener_bind,
            "port": controller_udp_stats.listener_port,
            "error": controller_udp_stats.listener_error,
            "rx_total": controller_udp_stats.rx_total,
            "rx_valid": controller_udp_stats.rx_valid,
            "rx_invalid": controller_udp_stats.rx_invalid,
            "last_ts_ms": controller_udp_stats.rx_last_ts_ms,
            "last_from": controller_udp_stats.rx_last_from,
            "last_len": controller_udp_stats.rx_last_len,
            "last_error": controller_udp_stats.rx_last_error,
            "last_seq": controller_udp_stats.rx_last_seq,
            "last_active_link": controller_udp_stats.rx_last_active_link,
        },
        "diagnostics": build_diagnostics_state(),
    }

@app.get("/api/health")
def api_health():
    expire_pending_cmds()
    pods_summary = {}
    for pod_name in ("BAT1", "BAT2"):
        pod = state.get("pods", {}).get(pod_name, {}) or {}
        node = state.get("nodes", {}).get(pod_name, {}) or {}
        pods_summary[pod_name] = {
            "online": pod.get("online", node.get("online")),
            "last_hb_ms": node.get("last_hb_ms"),
            "last_rx_ms": node.get("last_rx_ms"),
            "bus_conn": pod.get("bus_conn", pod.get("BusConn")),
            "vbatt_mv": pod.get("Vbatt_mv"),
            "ibatt_ma": pod.get("Ibatt_ma"),
            "vbus_mv": pod.get("Vbus_mv", pod.get("V48_mv")),
            "par_state": pod.get("ParState"),
            "vmot_reason": pod.get("VmotReason"),
            "ina_fault": pod.get("InaFault"),
        }
    return {
        "ok": True,
        "udp_rx_port": UDP_RX_PORT,
        "controller_udp_port": CONTROLLER_UDP_PORT,
        "offline_ms": OFFLINE_MS,
        "controller_offline_ms": CONTROLLER_OFFLINE_MS,
        "counters": state["counters"],
        "last_update_ms": state["last_update_ms"],
        "nodes": {k: {"online": v.get("online"), "last_hb_ms": v.get("last_hb_ms")} for k, v in state["nodes"].items()},
        "pods": pods_summary,
        "udp": {
            "listener_ok": udp_stats.listener_ok,
            "bind": udp_stats.listener_bind,
            "port": udp_stats.listener_port,
            "error": udp_stats.listener_error,
            "rx_total": udp_stats.rx_total,
            "last_ts_ms": udp_stats.rx_last_ts_ms,
            "last_from": udp_stats.rx_last_from,
            "last_len": udp_stats.rx_last_len,
            "last_msg": udp_stats.rx_last_msg,
            "last_src": udp_stats.rx_last_src,
            "last_dst": udp_stats.rx_last_dst,
            "last_ck_ok": udp_stats.rx_last_ck_ok,
            "last_prefix": udp_stats.rx_last_prefix,
        },
        "controller": state.get("controller"),
        "strobo": state.get("strobo"),
        "sfc_heartbeat": state.get("sfc_heartbeat"),
        "controller_udp": {
            "listener_ok": controller_udp_stats.listener_ok,
            "bind": controller_udp_stats.listener_bind,
            "port": controller_udp_stats.listener_port,
            "error": controller_udp_stats.listener_error,
            "rx_total": controller_udp_stats.rx_total,
            "rx_valid": controller_udp_stats.rx_valid,
            "rx_invalid": controller_udp_stats.rx_invalid,
            "last_from": controller_udp_stats.rx_last_from,
            "last_error": controller_udp_stats.rx_last_error,
        },
        "autolog": state.get("autolog"),
    }

@app.post("/api/cmd/lights_channel")
async def cmd_lights_channel(body: dict = Body(...)):
    blocked = reject_if_shutdown_in_progress()
    if blocked is not None:
        return blocked
    ch = int(body.get("ch", 1))
    mode = str(body.get("mode", "ON")).upper()
    dim = int(body.get("dim", 0))
    dst = str(body.get("dst", "ALL")).strip().upper()

    if ch not in (1, 2, 3, 4):
        return {"ok": False, "err": "bad ch"}
    if mode not in ("ON", "OFF", "TEST"):
        return {"ok": False, "err": "bad mode"}
    if dst != "ALL" and not dst.startswith("LGT"):
        return {"ok": False, "err": "bad dst"}
    dim = max(0, min(1000, dim))

    cfg = load_lights_cfg()
    lamp_ids = cfg["channels"][str(ch)].get("lamp_ids", [])
    lamp_ids_str = "|".join(str(x) for x in lamp_ids)

    cmd_id = next_cmd_id()
    ts = int(state["last_update_ms"] or 0)

    fields = [
        "SFC", dst, "CMD", "2",
        str(cmd_id), str(ts),
        "CmdId", str(cmd_id),
        "Type", "LGT",
        "Ch", str(ch),
        "Mode", mode,
        "Dim", str(dim),
        "LampIds", lamp_ids_str,
    ]
    line = build_nmea_line(fields)
    targets = [(host, UDP_TX_PORT) for host in lights_udp_tx_hosts()]
    try:
        sent_targets = send_udp_line(line, targets)
    except Exception as e:
        return JSONResponse({"ok": False, "err": f"udp send failed: {e}"}, status_code=500)

    # Firmware light bridge forwards this command to RS485 without generating ACK.
    return {"ok": True, "cmd_id": cmd_id, "lamp_ids": lamp_ids, "await_ack": False, "udp_targets": sent_targets}


@app.post("/api/cmd/lights_ids")
async def cmd_lights_ids(body: Optional[dict] = Body(None)):
    blocked = reject_if_shutdown_in_progress()
    if blocked is not None:
        return blocked
    cfg = load_lights_cfg()
    if body and isinstance(body, dict) and isinstance(body.get("pods"), dict):
        cfg = normalize_lights_cfg({"version": cfg.get("version", 1), "channels": cfg.get("channels", {}), "pods": body["pods"]})

    try:
        result = send_lights_ids_messages(cfg)
    except Exception as e:
        return JSONResponse({"ok": False, "err": f"udp send failed: {e}"}, status_code=500)

    return {"ok": True, **result}


@app.post("/api/cmd/vmot_master")
@app.post("/api/cmd/vmot")
async def cmd_vmot_master(body: dict = Body(...)):
    blocked = reject_if_shutdown_in_progress()
    if blocked is not None:
        return blocked
    raw_on = body.get("on", body.get("enable", body.get("val")))
    if raw_on is None:
        return JSONResponse({"ok": False, "err": "on missing"}, status_code=400)
    norm_on = normalize_bool01(raw_on)
    if norm_on is None:
        return JSONResponse({"ok": False, "err": "bad on"}, status_code=400)
    on = int(norm_on)
    dst = str(body.get("dst", "ALL")).strip().upper()
    if dst not in ("BAT1", "BAT2", "ALL"):
        return JSONResponse({"ok": False, "err": "bad dst"}, status_code=400)

    cmd_id = next_cmd_id()
    ts = int(state["last_update_ms"] or 0)

    targets = pod_command_destinations(dst)
    if not targets:
        return JSONResponse({"ok": False, "err": f"no UDP target for {dst}"}, status_code=500)

    sent_targets = []
    try:
        for pod, host, port in targets:
            fields = [
                "SFC", pod, "CMD", "2",
                str(cmd_id), str(ts),
                "CmdId", str(cmd_id),
                "Type", "VMOT",
                "On", str(on),
            ]
            line = build_nmea_line(fields)
            sent_targets.extend(send_udp_line(line, [(host, port)]))
    except Exception as e:
        return JSONResponse({"ok": False, "err": f"udp send failed: {e}"}, status_code=500)

    register_cmd(
        cmd_id=cmd_id,
        cmd_type="VMOT",
        dst=dst,
        ts_ms=ts,
        payload={"on": on},
    )
    return {"ok": True, "cmd_id": cmd_id, "on": on, "dst": dst, "udp_targets": sent_targets}


@app.post("/api/cmd/strobo")
async def cmd_strobo(body: dict = Body(...)):
    blocked = reject_if_shutdown_in_progress()
    if blocked is not None:
        return blocked
    raw_on = body.get("on", body.get("enable", body.get("val")))
    if raw_on is None:
        return JSONResponse({"ok": False, "err": "on missing"}, status_code=400)
    norm_on = normalize_bool01(raw_on)
    if norm_on is None:
        return JSONResponse({"ok": False, "err": "bad on"}, status_code=400)

    on = int(norm_on)
    dst = "BAT1"
    host = light_pod_host(dst)
    if not host:
        return JSONResponse({"ok": False, "err": "master pod host not configured"}, status_code=500)

    cmd_id = next_cmd_id()
    ts = int(state["last_update_ms"] or 0)
    fields = [
        "SFC", dst, "CMD", "2",
        str(cmd_id), str(ts),
        "CmdId", str(cmd_id),
        "Type", "STROBO",
        "On", str(on),
    ]
    line = build_nmea_line(fields)
    try:
        sent_targets = send_udp_line(line, [(host, UDP_TX_PORT)])
    except Exception as e:
        return JSONResponse({"ok": False, "err": f"udp send failed: {e}"}, status_code=500)

    register_cmd(
        cmd_id=cmd_id,
        cmd_type="STROBO",
        dst=dst,
        ts_ms=ts,
        payload={"on": on},
    )
    return {"ok": True, "cmd_id": cmd_id, "on": on, "dst": dst, "udp_targets": sent_targets}


@app.post("/api/cmd/shutdown")
async def cmd_shutdown(body: Optional[dict] = Body(None)):
    blocked = reject_if_shutdown_in_progress(allowed_cmd="SHDN")
    if blocked is not None:
        return blocked

    shdn = shutdown_state()
    if shdn.get("in_progress"):
        return {"ok": True, "cmd_id": shdn.get("cmd_id"), "shutdown": shdn}

    dst = "BAT1"
    host = light_pod_host(dst)
    if not host:
        return JSONResponse({"ok": False, "err": "master pod host not configured"}, status_code=500)

    requested_by = str((body or {}).get("requested_by") or "ui").strip()[:40] or "ui"
    ts = int(state["last_update_ms"] or now_ms())
    cmd_id = next_cmd_id()
    fields = [
        "SFC", dst, "CMD", "2",
        str(cmd_id), str(ts),
        "CmdId", str(cmd_id),
        "Type", "SHDN",
    ]
    line = build_nmea_line(fields)

    shdn.update({
        "in_progress": True,
        "requested_ts_ms": ts,
        "requested_by": requested_by,
        "cmd_id": cmd_id,
        "dst": dst,
        "host": host,
        "last_error": None,
    })

    if state.get("logging", {}).get("enabled"):
        append_event_jsonl({
            "ts_ms": ts,
            "mission_time": (state.get("nav") or {}).get("mission_time_s"),
            "depth": (state.get("nav") or {}).get("depth_m"),
            "heading": (state.get("nav") or {}).get("heading_deg"),
            "lat": (state.get("nav") or {}).get("lat_deg"),
            "lon": (state.get("nav") or {}).get("lon_deg"),
            "alt_m": (state.get("nav") or {}).get("alt_m"),
            "src": "SFC",
            "type": "SHDN",
            "text": f"Vehicle shutdown requested by {requested_by}",
        })

    try:
        await stop_ping360_runtime()
    except Exception as e:
        shdn["last_error"] = f"ping360 stop failed: {e}"

    try:
        sent_targets = send_udp_line(line, [(host, UDP_TX_PORT)])
    except Exception as e:
        shdn["in_progress"] = False
        shdn["last_error"] = f"udp send failed: {e}"
        return JSONResponse({"ok": False, "err": shdn["last_error"], "shutdown": shdn}, status_code=500)

    register_cmd(
        cmd_id=cmd_id,
        cmd_type="SHDN",
        dst=dst,
        ts_ms=ts,
        payload={"requested_by": requested_by},
    )
    await ws_broadcast({"type": "shutdown", "shutdown": dict(shdn)})
    return {"ok": True, "cmd_id": cmd_id, "dst": dst, "udp_targets": sent_targets, "shutdown": shdn}

@app.get("/api/cmd/ack")
def api_cmd_ack(cmd_id: int):
    if cmd_id < 0:
        return JSONResponse({"ok": False, "err": "bad cmd_id"}, status_code=400)
    status = get_cmd_ack_status(cmd_id)
    return {"ok": True, "cmd_id": cmd_id, **status}

@app.get("/api/config/lights")
def api_get_lights_cfg():
    return load_lights_cfg()

@app.post("/api/config/lights")
def api_set_lights_cfg(cfg: dict = Body(...)):
    if "channels" not in cfg or not isinstance(cfg["channels"], dict):
        return JSONResponse({"ok": False, "err": "channels missing"}, status_code=400)

    out = {"version": int(cfg.get("version", 1)), "channels": {}, "pods": {}}
    for k in ("1", "2", "3", "4"):
        ch = cfg["channels"].get(k, {})
        if not isinstance(ch, dict):
            return JSONResponse({"ok": False, "err": f"channels.{k} invalid"}, status_code=400)

        name = str(ch.get("name", f"CH{k}"))
        lamp_ids = ch.get("lamp_ids", [])
        if not isinstance(lamp_ids, list):
            return JSONResponse({"ok": False, "err": f"channels.{k}.lamp_ids invalid"}, status_code=400)

        cleaned = [x for x in lamp_ids if isinstance(x, int) and x >= 1]
        out["channels"][k] = {"name": name, "pod": light_channel_pod(k), "lamp_ids": sorted(set(cleaned))}

    pods = cfg.get("pods", {})
    if not isinstance(pods, dict):
        return JSONResponse({"ok": False, "err": "pods invalid"}, status_code=400)

    default_cfg = load_lights_cfg()
    for pod in LIGHT_PODS:
        pod_cfg = pods.get(pod, (default_cfg.get("pods") or {}).get(pod, {}))
        if not isinstance(pod_cfg, dict):
            return JSONResponse({"ok": False, "err": f"pods.{pod} invalid"}, status_code=400)

        name = str(pod_cfg.get("name", pod))
        lamp_ids = pod_cfg.get("lamp_ids", [])
        if not isinstance(lamp_ids, list):
            return JSONResponse({"ok": False, "err": f"pods.{pod}.lamp_ids invalid"}, status_code=400)

        cleaned = [x for x in lamp_ids if isinstance(x, int) and x >= 1]
        out["pods"][pod] = {"name": name, "lamp_ids": sorted(set(cleaned))}

    save_lights_cfg(out)
    sync = None
    try:
        sync = send_lights_ids_messages(out)
    except Exception as e:
        return {"ok": True, "lights_ids": None, "lights_ids_err": f"sync failed: {e}"}
    return {"ok": True, "lights_ids": sync}

@app.get("/api/config/autolog")
def api_get_autolog_cfg():
    al = state.setdefault("autolog", {})
    enabled = bool(al.get("enabled", AUTOLOG_ENABLED_DEFAULT))
    al["enabled"] = enabled
    al.setdefault("armed", True)
    al["depth_m"] = AUTOLOG_DEPTH_M
    al["hyst_m"] = AUTOLOG_HYST_M
    return {
        "enabled": enabled,
        "depth_m": AUTOLOG_DEPTH_M,
        "hyst_m": AUTOLOG_HYST_M,
    }

@app.post("/api/config/autolog")
def api_set_autolog_cfg(cfg: dict = Body(...)):
    norm = normalize_bool01(cfg.get("enabled"))
    if norm is None:
        return JSONResponse({"ok": False, "err": "enabled missing or invalid"}, status_code=400)

    enabled = bool(norm)
    al = state.setdefault("autolog", {})
    al["enabled"] = enabled
    al["armed"] = True if enabled else bool(al.get("armed", True))
    al["depth_m"] = AUTOLOG_DEPTH_M
    al["hyst_m"] = AUTOLOG_HYST_M
    return {
        "ok": True,
        "enabled": enabled,
        "depth_m": AUTOLOG_DEPTH_M,
        "hyst_m": AUTOLOG_HYST_M,
    }

SID_RE = re.compile(r"^\d{8}_\d{6}$")
SESSION_RE = re.compile(r"^(telemetry|alarms|events)_(\d{8}_\d{6})\.(csv|jsonl)$")
SNAPSHOT_RE = re.compile(r"^snapshot_(\d{8}_\d{6})_(\d{3})\.png$")

def list_sessions(log_dir: str):
    sessions = {}
    try:
        for name in os.listdir(log_dir):
            m = SESSION_RE.match(name)
            media_sid = None
            media_dir = os.path.join(log_dir, name)
            if os.path.isdir(media_dir) and name.startswith("media_"):
                candidate = name[6:]
                if SID_RE.fullmatch(candidate):
                    media_sid = candidate
            if not m and not media_sid:
                continue
            if media_sid:
                sessions.setdefault(media_sid, {})
                sessions[media_sid]["media_dir"] = media_dir
            else:
                kind, sid, _ext = m.group(1), m.group(2), m.group(3)
                sessions.setdefault(sid, {})
                sessions[sid][kind] = os.path.join(log_dir, name)
    except FileNotFoundError:
        return {}
    return dict(sorted(sessions.items(), key=lambda kv: kv[0], reverse=True))

def parse_sid_list(payload: dict):
    raw = payload.get("sids")
    if not isinstance(raw, list):
        return None, "sids must be an array"

    out = []
    seen = set()
    for it in raw:
        sid = str(it or "").strip()
        if not SID_RE.fullmatch(sid):
            return None, "bad sid"
        if sid not in seen:
            seen.add(sid)
            out.append(sid)

    if not out:
        return None, "empty sids"
    return out, None

def sid_to_dt(sid: str) -> Optional[datetime]:
    try:
        return datetime.strptime(sid, "%Y%m%d_%H%M%S")
    except Exception:
        return None

def sid_start_utc(sid: str) -> Optional[str]:
    dt = sid_to_dt(sid)
    if not dt:
        return None
    return dt.isoformat() + "Z"

def resolve_sid(requested_sid: str | None, sessions: dict, cur_sid: str | None) -> str | None:
    sid = (requested_sid or "").strip()
    if sid:
        if not SID_RE.fullmatch(sid):
            return None
        return sid
    if cur_sid and SID_RE.fullmatch(str(cur_sid)):
        return str(cur_sid)
    if sessions:
        return next(iter(sessions.keys()))
    return None

def mission_meta_path(sid: str) -> str:
    return os.path.join(LOG_DIR, f"manifest_{sid}.json")

def session_media_dir(sid: str) -> str:
    return os.path.join(LOG_DIR, f"media_{sid}")

def list_session_media(sid: str) -> list[dict]:
    root = session_media_dir(sid)
    out = []
    if not os.path.isdir(root):
        return out
    for name in sorted(os.listdir(root)):
        if not SNAPSHOT_RE.fullmatch(name):
            continue
        p = os.path.join(root, name)
        if not os.path.isfile(p):
            continue
        out.append({
            "name": name,
            "path": p,
            "size": os.path.getsize(p),
        })
    return out

def sanitize_mission_meta(raw: dict, sid: str) -> dict:
    raw = raw if isinstance(raw, dict) else {}

    def clean(key: str, max_len: int) -> str:
        return str(raw.get(key, "")).strip()[:max_len]

    out = {
        "title": clean("title", 120),
        "place": clean("place", 120),
        "objective": clean("objective", 240),
        "operator": clean("operator", 120),
        "date": clean("date", 16),
    }

    if out["date"] and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", out["date"]):
        out["date"] = ""

    if not out["date"]:
        dt = sid_to_dt(sid)
        if dt:
            out["date"] = dt.strftime("%Y-%m-%d")
    return out

def load_mission_meta(sid: str) -> dict:
    p = mission_meta_path(sid)
    if not os.path.isfile(p):
        return sanitize_mission_meta({}, sid)
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict) and isinstance(data.get("mission"), dict):
            data = data["mission"]
        return sanitize_mission_meta(data, sid)
    except Exception:
        return sanitize_mission_meta({}, sid)

def save_mission_meta(sid: str, mission: dict) -> dict:
    safe = sanitize_mission_meta(mission, sid)
    p = mission_meta_path(sid)
    tmp = p + ".tmp"
    payload = {"sid": sid, "start_utc": sid_start_utc(sid), "mission": safe}
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)
    os.replace(tmp, p)
    return safe

def build_session_zip(buf: io.BytesIO, sessions: dict, sids: list[str], multi: bool):
    created_utc = datetime.utcnow().isoformat() + "Z"
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as z:
        if multi:
            manifest = {"created_utc": created_utc, "sessions": []}
            for sid in sids:
                files = sessions[sid]
                start_utc = sid_start_utc(sid)
                files_manifest = {}
                for kind in ("telemetry", "alarms", "events"):
                    p = files.get(kind)
                    if p and os.path.isfile(p):
                        name = os.path.basename(p)
                        z.write(p, arcname=f"{sid}/{name}")
                        files_manifest[kind] = name
                media_manifest = []
                for media in list_session_media(sid):
                    z.write(media["path"], arcname=f"{sid}/media/{media['name']}")
                    media_manifest.append({"file": f"media/{media['name']}", "size": media["size"]})
                one_manifest = {
                    "sid": sid,
                    "created_utc": created_utc,
                    "start_utc": start_utc,
                    "files": files_manifest,
                    "media": media_manifest,
                    "mission": load_mission_meta(sid),
                }
                z.writestr(f"{sid}/manifest_{sid}.json", json.dumps(one_manifest, indent=2))
                manifest["sessions"].append(one_manifest)
            z.writestr("manifest_multi.json", json.dumps(manifest, indent=2))
        else:
            sid = sids[0]
            files = sessions[sid]
            start_utc = sid_start_utc(sid)
            files_manifest = {}
            for kind in ("telemetry", "alarms", "events"):
                p = files.get(kind)
                if p and os.path.isfile(p):
                    name = os.path.basename(p)
                    z.write(p, arcname=name)
                    files_manifest[kind] = name
            media_manifest = []
            for media in list_session_media(sid):
                z.write(media["path"], arcname=f"media/{media['name']}")
                media_manifest.append({"file": f"media/{media['name']}", "size": media["size"]})
            manifest = {
                "sid": sid,
                "created_utc": created_utc,
                "start_utc": start_utc,
                "files": files_manifest,
                "media": media_manifest,
                "mission": load_mission_meta(sid),
            }
            z.writestr(f"manifest_{sid}.json", json.dumps(manifest, indent=2))

@app.get("/api/log/sessions")
def api_log_sessions():
    sessions = list_sessions(LOG_DIR)
    out = []
    for sid, files in sessions.items():
        out.append({
            "sid": sid,
            "telemetry": os.path.basename(files.get("telemetry", "")) if "telemetry" in files else None,
            "alarms": os.path.basename(files.get("alarms", "")) if "alarms" in files else None,
            "events": os.path.basename(files.get("events", "")) if "events" in files else None,
            "media_count": len(list_session_media(sid)),
        })
    return {"sessions": out}

@app.get("/api/log/zip")
def api_log_zip(sid: str):
    if not SID_RE.fullmatch(sid):
        raise HTTPException(status_code=400, detail="bad sid")

    sessions = list_sessions(LOG_DIR)
    if sid not in sessions:
        raise HTTPException(status_code=404, detail="session not found")

    buf = io.BytesIO()
    build_session_zip(buf, sessions, [sid], multi=False)

    buf.seek(0)
    filename = f"deepex_logs_{sid}.zip"
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/api/video/rtsp-proxy")
async def api_video_rtsp_proxy(url: str, request: Request):
    video_url = (url or "").strip()
    if not video_url:
        raise HTTPException(status_code=400, detail="missing url")
    if not is_rtsp_url(video_url):
        raise HTTPException(status_code=400, detail="only rtsp/rtsps urls are supported")
    return await rtsp_to_mjpeg_stream(video_url, request)

@app.post("/api/log/zip_many")
def api_log_zip_many(payload: dict = Body(...)):
    sids, err = parse_sid_list(payload)
    if err:
        return JSONResponse({"ok": False, "err": err}, status_code=400)

    sessions = list_sessions(LOG_DIR)
    missing = [sid for sid in sids if sid not in sessions]
    if missing:
        return JSONResponse({"ok": False, "err": "session not found", "missing": missing}, status_code=404)

    buf = io.BytesIO()
    build_session_zip(buf, sessions, sids, multi=True)
    buf.seek(0)

    now_tag = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    filename = f"deepex_logs_multi_{now_tag}.zip"
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )

@app.post("/api/log/delete")
def api_log_delete(payload: dict = Body(...)):
    sid = str(payload.get("sid", "")).strip()
    if not SID_RE.fullmatch(sid):
        return JSONResponse({"ok": False, "err": "bad sid"}, status_code=400)

    sessions = list_sessions(LOG_DIR)
    if sid not in sessions:
        return JSONResponse({"ok": False, "err": "session not found"}, status_code=404)

    cur = state.get("logging", {"enabled": False, "sid": None})
    if cur.get("enabled") and cur.get("sid") == sid:
        return JSONResponse({"ok": False, "err": "stop logging before deleting current session"}, status_code=409)

    removed = []
    files = sessions[sid]
    for kind in ("telemetry", "alarms", "events"):
        p = files.get(kind)
        if p and os.path.isfile(p):
            try:
                os.remove(p)
                removed.append(os.path.basename(p))
            except Exception:
                pass
    media_dir = session_media_dir(sid)
    if os.path.isdir(media_dir):
        try:
            shutil.rmtree(media_dir)
            removed.append(os.path.basename(media_dir))
        except Exception:
            pass

    if (not cur.get("enabled")) and cur.get("sid") == sid:
        state["logging"] = {"enabled": False, "sid": None}

    return {"ok": True, "sid": sid, "removed": removed}

@app.post("/api/log/delete_many")
def api_log_delete_many(payload: dict = Body(...)):
    sids, err = parse_sid_list(payload)
    if err:
        return JSONResponse({"ok": False, "err": err}, status_code=400)

    cur = state.get("logging", {"enabled": False, "sid": None})
    if cur.get("enabled") and cur.get("sid") in sids:
        return JSONResponse({"ok": False, "err": "stop logging before deleting current session"}, status_code=409)

    sessions = list_sessions(LOG_DIR)
    missing = [sid for sid in sids if sid not in sessions]

    deleted = []
    removed_by_sid = {}
    for sid in sids:
        files = sessions.get(sid)
        if not files:
            continue

        removed = []
        for kind in ("telemetry", "alarms", "events"):
            p = files.get(kind)
            if p and os.path.isfile(p):
                try:
                    os.remove(p)
                    removed.append(os.path.basename(p))
                except Exception:
                    pass
        media_dir = session_media_dir(sid)
        if os.path.isdir(media_dir):
            try:
                shutil.rmtree(media_dir)
                removed.append(os.path.basename(media_dir))
            except Exception:
                pass
        deleted.append(sid)
        removed_by_sid[sid] = removed

        if (not cur.get("enabled")) and cur.get("sid") == sid:
            state["logging"] = {"enabled": False, "sid": None}

    return {"ok": True, "deleted": deleted, "missing": missing, "removed": removed_by_sid}

@app.get("/api/log/manifest")
def api_log_manifest(sid: str | None = None):
    sessions = list_sessions(LOG_DIR)
    cur = state.get("logging", {"enabled": False, "sid": None})
    chosen_sid = resolve_sid(sid, sessions, cur.get("sid"))
    if not chosen_sid:
        return JSONResponse({"ok": False, "err": "sid not available"}, status_code=404)
    if chosen_sid not in sessions:
        return JSONResponse({"ok": False, "err": "session not found"}, status_code=404)

    files = sessions[chosen_sid]
    sid_dt = sid_to_dt(chosen_sid)
    start_utc = sid_start_utc(chosen_sid)
    manifest = {
        "sid": chosen_sid,
        "created_utc": (sid_dt.isoformat() + "Z") if sid_dt else None,
        "start_utc": start_utc,
        "files": {},
        "mission": load_mission_meta(chosen_sid),
    }
    sizes = {}
    for kind in ("telemetry", "alarms", "events"):
        p = files.get(kind)
        if p and os.path.isfile(p):
            name = os.path.basename(p)
            manifest["files"][kind] = name
            try:
                sizes[kind] = os.path.getsize(p)
            except Exception:
                sizes[kind] = None
    media = list_session_media(chosen_sid)
    manifest["media"] = [{"file": f"media/{item['name']}", "size": item["size"]} for item in media]
    sizes["media"] = sum(int(item["size"] or 0) for item in media)

    now = datetime.now()
    elapsed_sec = None
    if sid_dt:
        elapsed_sec = max(0, int((now - sid_dt).total_seconds()))

    return {
        "ok": True,
        "manifest": manifest,
        "sizes": sizes,
        "logging_enabled": bool(cur.get("enabled")),
        "current_sid": cur.get("sid"),
        "is_current": str(cur.get("sid") or "") == chosen_sid,
        "elapsed_sec": elapsed_sec,
    }

@app.post("/api/log/manifest_meta")
def api_log_manifest_meta(payload: dict = Body(...)):
    sessions = list_sessions(LOG_DIR)
    cur = state.get("logging", {"enabled": False, "sid": None})
    req_sid = str(payload.get("sid", "")).strip() or None
    chosen_sid = resolve_sid(req_sid, sessions, cur.get("sid"))
    if not chosen_sid:
        return JSONResponse({"ok": False, "err": "sid not available"}, status_code=404)
    if chosen_sid not in sessions:
        return JSONResponse({"ok": False, "err": "session not found"}, status_code=404)

    mission = payload.get("mission")
    if mission is None:
        # fallback: support flat payload keys
        mission = {k: payload.get(k) for k in ("title", "place", "objective", "operator", "date")}

    try:
        saved = save_mission_meta(chosen_sid, mission)
    except Exception:
        return JSONResponse({"ok": False, "err": "failed to save mission metadata"}, status_code=500)

    return {"ok": True, "sid": chosen_sid, "mission": saved}

@app.post("/api/log/snapshot")
def api_log_snapshot(payload: dict = Body(...)):
    cur = state.get("logging", {"enabled": False, "sid": None})
    if not cur.get("enabled") or not cur.get("sid"):
        return JSONResponse({"ok": False, "err": "logging disabled"}, status_code=400)

    sid = str(cur.get("sid") or "").strip()
    if not SID_RE.fullmatch(sid):
        return JSONResponse({"ok": False, "err": "bad current sid"}, status_code=500)

    data_url = str(payload.get("image") or "")
    prefix = "data:image/png;base64,"
    if not data_url.startswith(prefix):
        return JSONResponse({"ok": False, "err": "expected PNG data URL"}, status_code=400)

    try:
        image = base64.b64decode(data_url[len(prefix):], validate=True)
    except (binascii.Error, ValueError):
        return JSONResponse({"ok": False, "err": "bad image data"}, status_code=400)

    if len(image) < 8 or image[:8] != b"\x89PNG\r\n\x1a\n":
        return JSONResponse({"ok": False, "err": "bad PNG data"}, status_code=400)
    if len(image) > 8 * 1024 * 1024:
        return JSONResponse({"ok": False, "err": "snapshot too large"}, status_code=413)

    media_dir = session_media_dir(sid)
    os.makedirs(media_dir, exist_ok=True)
    tag = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    seq = 1
    while seq <= 999:
        name = f"snapshot_{tag}_{seq:03d}.png"
        path = os.path.join(media_dir, name)
        if not os.path.exists(path):
            break
        seq += 1
    if seq > 999:
        return JSONResponse({"ok": False, "err": "too many snapshots this second"}, status_code=500)

    tmp = path + ".tmp"
    try:
        with open(tmp, "wb") as f:
            f.write(image)
        os.replace(tmp, path)
    except Exception:
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except Exception:
            pass
        return JSONResponse({"ok": False, "err": "failed to write snapshot"}, status_code=500)

    nav = state.get("nav") or {}
    stream = payload.get("stream") if isinstance(payload.get("stream"), dict) else {}
    evt = {
        "ts_ms": int(state.get("last_update_ms") or int(time.time() * 1000)),
        "mission_time": nav.get("mission_time_s"),
        "depth": nav.get("depth_m"),
        "heading": nav.get("heading_deg"),
        "lat": nav.get("lat_deg"),
        "lon": nav.get("lon_deg"),
        "alt_m": nav.get("alt_m"),
        "src": "SFC",
        "type": "SNAPSHOT",
        "text": str(payload.get("text") or "Video snapshot").strip()[:200],
        "media": f"media/{name}",
        "stream": {
            "index": stream.get("index"),
            "kind": str(stream.get("kind") or "")[:32],
            "url": str(stream.get("url") or "")[:500],
        },
    }
    ok = append_event_jsonl(evt)
    if not ok:
        return JSONResponse({"ok": False, "err": "snapshot saved but failed to write event log"}, status_code=500)

    return {"ok": True, "sid": sid, "file": f"media/{name}", "size": len(image)}

@app.get("/api/log/events_tail")
def api_log_events_tail(sid: str | None = None, limit: int = 20):
    limit = max(1, min(int(limit or 20), 200))
    sessions = list_sessions(LOG_DIR)
    cur = state.get("logging", {"enabled": False, "sid": None})
    chosen_sid = resolve_sid(sid, sessions, cur.get("sid"))
    if not chosen_sid:
        return {"ok": True, "sid": None, "events": []}
    if chosen_sid not in sessions:
        return JSONResponse({"ok": False, "err": "session not found"}, status_code=404)

    events_file = sessions[chosen_sid].get("events")
    if not events_file or not os.path.isfile(events_file):
        return {"ok": True, "sid": chosen_sid, "events": []}

    tail = deque(maxlen=limit)
    with open(events_file, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                tail.append(line)

    out = []
    for line in reversed(tail):
        try:
            out.append(json.loads(line))
        except Exception:
            out.append({"raw": line})

    return {"ok": True, "sid": chosen_sid, "events": out}

@app.get("/api/log/status")
def api_log_status():
    return state.get("logging", {"enabled": False, "sid": None})

@app.post("/api/log/start")
def api_log_start():
    sid = make_sid()
    set_session_paths(sid)
    state["logging"] = {"enabled": True, "sid": sid}
    return {"ok": True, "sid": sid}

@app.post("/api/log/stop")
def api_log_stop():
    cur = state.get("logging", {"enabled": False, "sid": None})
    state["logging"] = {"enabled": False, "sid": cur.get("sid")}
    return {"ok": True, "sid": state["logging"]["sid"]}

@app.post("/api/log/event")
def api_log_event(payload: dict = Body(...)):
    if not state.get("logging", {}).get("enabled"):
        return JSONResponse({"ok": False, "err": "logging disabled"}, status_code=400)

    typ = str(payload.get("type", "NOTE")).upper()
    text = str(payload.get("text", "")).strip()
    if not text:
        return JSONResponse({"ok": False, "err": "text empty"}, status_code=400)

    nav = state.get("nav") or {}
    evt = {
        "ts_ms": int(state.get("last_update_ms") or 0),
        "mission_time": nav.get("mission_time_s"),
        "depth": nav.get("depth_m"),
        "heading": nav.get("heading_deg"),
        "lat": nav.get("lat_deg"),
        "lon": nav.get("lon_deg"),
        "alt_m": nav.get("alt_m"),
        "src": "SFC",
        "type": typ,
        "text": text,
    }
    ok = append_event_jsonl(evt)
    if not ok:
        return JSONResponse({"ok": False, "err": "failed to write event log"}, status_code=500)
    return {"ok": True}

@app.get("/api/sonar/ping360/config")
def get_ping360_cfg():
    return ping360_load_cfg()

@app.post("/api/sonar/ping360/config")
async def set_ping360_cfg(cfg: dict = Body(...)):
    ping360_save_cfg(cfg)
    await restart_ping360_runtime()
    return {"ok": True, "config": ping360_load_cfg()}

@app.post("/api/sonar/ping360/start")
async def start_ping360(cfg: dict = Body(default={})):
    merged = {**ping360_load_cfg(), **(cfg or {}), "enabled": True}
    ping360_save_cfg(merged)
    await restart_ping360_runtime()
    return {"ok": True, "config": ping360_load_cfg()}

@app.post("/api/sonar/ping360/stop")
async def stop_ping360():
    cfg = {**ping360_load_cfg(), "enabled": False}
    ping360_save_cfg(cfg)
    await stop_ping360_runtime()
    state.setdefault("sonar", {}).setdefault("ping360", {}).update({
        "enabled": False,
        "connected": False,
        "scanning": False,
    })
    return {"ok": True, "config": ping360_load_cfg()}

# ----------------------------
# MAVLink readers (unchanged)
# ----------------------------
async def mavlink_reader():
    loop = asyncio.get_running_loop()

    def _run():
        m = mavutil.mavlink_connection(MAVLINK_CONN, autoreconnect=True, source_system=255)
        last_state_push = 0.0
        while True:
            msg = m.recv_match(blocking=True, timeout=1)
            if msg is None:
                continue

            t = now_ms()
            state["mav"]["last_ms"] = t
            state["mav"]["last_seen_monotonic_ms"] = int(time.monotonic() * 1000)
            state["mav"]["msgs"] += 1

            mt = msg.get_type()
            t_boot = getattr(msg, "time_boot_ms", None)
            if t_boot is not None:
                state["nav"]["mission_time_s"] = float(t_boot) / 1000.0

            if mt == "ATTITUDE":
                state["att"]["roll_deg"]  = msg.roll  * 57.295779513
                state["att"]["pitch_deg"] = msg.pitch * 57.295779513
                state["att"]["yaw_deg"]   = msg.yaw   * 57.295779513
            elif mt == "ATTITUDE_TARGET":
                update_nav_target_attitude(q=getattr(msg, "q", None))
            elif mt == "HEARTBEAT":
                update_mav_heartbeat_armed(
                    base_mode=getattr(msg, "base_mode", None),
                    safety_armed=getattr(msg, "MAV_MODE_SAFETY_ARMED", None),
                    system_status=getattr(msg, "system_status", None),
                    source="MAVLINK_UDP",
                )
            elif mt == "VFR_HUD":
                state["nav"]["heading_deg"] = getattr(msg, "heading", None)
                update_depth_from_alt(getattr(msg, "alt", None))
            elif mt == "GLOBAL_POSITION_INT":
                lat = getattr(msg, "lat", None)
                lon = getattr(msg, "lon", None)
                hdg = getattr(msg, "hdg", None)
                rel_alt = getattr(msg, "relative_alt", None)

                if lat is not None:
                    state["nav"]["lat_deg"] = float(lat) / 1e7
                if lon is not None:
                    state["nav"]["lon_deg"] = float(lon) / 1e7
                if hdg is not None and int(hdg) != 65535:
                    state["nav"]["heading_deg"] = float(hdg) / 100.0
                if rel_alt is not None:
                    update_depth_from_alt(float(rel_alt) / 1000.0)
            elif mt == "POSITION_TARGET_LOCAL_NED":
                type_mask = int(getattr(msg, "type_mask", 0) or 0)
                if (type_mask & 0x0004) == 0:
                    update_nav_target_depth_from_local_ned(getattr(msg, "z", None))
                if (type_mask & 0x0400) == 0:
                    update_nav_target_attitude(yaw_rad=getattr(msg, "yaw", None))
            elif mt == "POSITION_TARGET_GLOBAL_INT":
                type_mask = int(getattr(msg, "type_mask", 0) or 0)
                if (type_mask & 0x0400) == 0:
                    update_nav_target_attitude(yaw_rad=getattr(msg, "yaw", None))

            now = time.monotonic()
            if (now - last_state_push) >= 0.10:
                last_state_push = now
                asyncio.run_coroutine_threadsafe(ws_broadcast({
                    "type": "state",
                    "thr": {k: state.get("thr", {}).get(k, {}) for k in ("TH1", "TH2", "TH3", "TH4", "TH5", "TH6")},
                    "att": dict(state.get("att") or {}),
                    "nav": dict(state.get("nav") or {}),
                    "mav": dict(state.get("mav") or {}),
                }), loop)

    await asyncio.to_thread(_run)

async def mavlink_ws_loop():
    import json, asyncio, websockets

    INV = {1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1}  # metti -1 dove serve

    PWM_MIN = 1100
    PWM_TRIM = 1500
    PWM_MAX = 1900

    def pwm_to_pct(pwm: int) -> float:
        if pwm < PWM_MIN:
            pwm = PWM_MIN
        if pwm > PWM_MAX:
            pwm = PWM_MAX
        if pwm >= PWM_TRIM:
            return (pwm - PWM_TRIM) / (PWM_MAX - PWM_TRIM) * 100.0
        return - (PWM_TRIM - pwm) / (PWM_TRIM - PWM_MIN) * 100.0

    RAD2DEG = 57.295779513

    # throttle broadcast thr per non spammare la UI
    last_thr_push = 0.0
    THR_PUSH_MIN_DT = 0.05  # 50ms => max 20Hz
    last_state_push = 0.0
    STATE_PUSH_MIN_DT = 0.10

    urls = []
    for url in [MAVLINK_WS_URL, *MAVLINK_WS_FALLBACK_URLS]:
        if url and url not in urls:
            urls.append(url)
    url_index = 0

    while True:
        ws_url = urls[url_index % len(urls)] if urls else MAVLINK_WS_URL
        try:
            mav_state = state.setdefault("mav", {})
            mav_state["ws_url"] = ws_url
            print(f"[mavlink] connecting to {ws_url}")
            async with websockets.connect(ws_url, ping_interval=20, ping_timeout=20) as ws:
                print(f"[mavlink] connected {ws_url}")
                mav_state = state.setdefault("mav", {})
                mav_state["connected"] = True
                mav_state["ws_url"] = ws_url
                mav_state["last_error"] = None

                async for raw in ws:
                    try:
                        obj = json.loads(raw)
                    except Exception:
                        continue

                    msg = obj.get("message") or obj.get("mavlink") or obj
                    state.setdefault("mav", {})["last_seen_monotonic_ms"] = int(time.monotonic() * 1000)
                    state["mav"]["msgs"] = int(state["mav"].get("msgs", 0)) + 1
                    if isinstance(msg, dict):
                        update_depth_from_dict(msg)
                    mtype = msg.get("type") or msg.get("msg") or msg.get("name")
                    if not mtype:
                        continue

                    t_boot = msg.get("time_boot_ms")
                    if t_boot is not None:
                        state.setdefault("nav", {})
                        state["nav"]["mission_time_s"] = float(t_boot) / 1000.0

                    if mtype == "ATTITUDE":
                        # ATTITUDE e in radianti
                        roll = msg.get("roll")
                        pitch = msg.get("pitch")
                        yaw = msg.get("yaw")
                        state["att"] = {
                            "roll_deg": float(roll) * RAD2DEG if roll is not None else None,
                            "pitch_deg": float(pitch) * RAD2DEG if pitch is not None else None,
                            "yaw_deg": float(yaw) * RAD2DEG if yaw is not None else None,
                        }
                    elif mtype == "ATTITUDE_TARGET":
                        update_nav_target_attitude(q=msg.get("q"))
                    elif mtype == "HEARTBEAT":
                        update_mav_heartbeat_armed(
                            base_mode=msg.get("base_mode", msg.get("baseMode")),
                            safety_armed=msg.get("MAV_MODE_SAFETY_ARMED", msg.get("safety_armed")),
                            system_status=msg.get("system_status", msg.get("systemStatus")),
                            source="MAVLINK_WS",
                        )
                    elif mtype == "VFR_HUD":
                        hdg = msg.get("heading")
                        alt = msg.get("alt")
                        state.setdefault("nav", {})
                        if hdg is not None:
                            state["nav"]["heading_deg"] = float(hdg)
                        if alt is not None:
                            update_depth_from_alt(float(alt))
                    elif mtype == "GLOBAL_POSITION_INT":
                        # hdg in centi-deg (0..35999)
                        hdg = msg.get("hdg")
                        lat = msg.get("lat")
                        lon = msg.get("lon")
                        rel_alt = msg.get("relative_alt")
                        if hdg is not None:
                            state.setdefault("nav", {})
                            state["nav"]["heading_deg"] = float(hdg) / 100.0
                        if lat is not None:
                            state.setdefault("nav", {})
                            state["nav"]["lat_deg"] = float(lat) / 1e7
                        if lon is not None:
                            state.setdefault("nav", {})
                            state["nav"]["lon_deg"] = float(lon) / 1e7
                        if rel_alt is not None:
                            update_depth_from_alt(float(rel_alt) / 1000.0)
                    elif mtype == "POSITION_TARGET_LOCAL_NED":
                        type_mask = int(msg.get("type_mask", msg.get("typeMask")) or 0)
                        if (type_mask & 0x0004) == 0:
                            update_nav_target_depth_from_local_ned(msg.get("z"))
                        if (type_mask & 0x0400) == 0:
                            update_nav_target_attitude(yaw_rad=msg.get("yaw"))
                    elif mtype == "POSITION_TARGET_GLOBAL_INT":
                        type_mask = int(msg.get("type_mask", msg.get("typeMask")) or 0)
                        if (type_mask & 0x0400) == 0:
                            update_nav_target_attitude(yaw_rad=msg.get("yaw"))
                    elif mtype == "GPS_RAW_INT":
                        lat = msg.get("lat")
                        lon = msg.get("lon")
                        alt = msg.get("alt")
                        if lat is not None:
                            state.setdefault("nav", {})
                            state["nav"]["lat_deg"] = float(lat) / 1e7
                        if lon is not None:
                            state.setdefault("nav", {})
                            state["nav"]["lon_deg"] = float(lon) / 1e7
                        if alt is not None:
                            update_depth_from_alt(float(alt) / 1000.0)
                    elif mtype == "SERVO_OUTPUT_RAW":
                        outs = [
                            msg.get("servo1_raw"),
                            msg.get("servo2_raw"),
                            msg.get("servo3_raw"),
                            msg.get("servo4_raw"),
                            msg.get("servo5_raw"),
                            msg.get("servo6_raw"),
                        ]

                        state.setdefault("thr", {})
                        for i, pwm in enumerate(outs, start=1):
                            th_key = f"TH{i}"
                            state["thr"].setdefault(th_key, {})

                            if pwm is None:
                                state["thr"][th_key]["PWM"] = None
                                state["thr"][th_key]["CmdPct"] = None
                                continue

                            pwm_i = int(pwm)
                            pct = pwm_to_pct(pwm_i) * INV[i]
                            state["thr"][th_key]["PWM"] = pwm_i
                            state["thr"][th_key]["CmdPct"] = round(pct, 1)

                        now = asyncio.get_running_loop().time()
                        if (now - last_thr_push) >= THR_PUSH_MIN_DT:
                            last_thr_push = now
                            await ws_broadcast({
                                "type": "thr",
                                "thr": {k: state["thr"].get(k, {}) for k in ("TH1", "TH2", "TH3", "TH4", "TH5", "TH6")},
                            })

                    now = asyncio.get_running_loop().time()
                    if (now - last_state_push) >= STATE_PUSH_MIN_DT:
                        last_state_push = now
                        await ws_broadcast({
                            "type": "state",
                            "thr": {k: state["thr"].get(k, {}) for k in ("TH1", "TH2", "TH3", "TH4", "TH5", "TH6")},
                            "att": dict(state.get("att") or {}),
                            "nav": dict(state.get("nav") or {}),
                            "mav": dict(state.get("mav") or {}),
                        })
        except Exception as e:
            mav_state = state.setdefault("mav", {})
            mav_state["connected"] = False
            mav_state["ws_url"] = ws_url
            mav_state["last_error"] = str(e)
            print(f"[mavlink] error {ws_url}: {e}")
            url_index += 1
            await asyncio.sleep(2.0)
