import asyncio
import json
import os
import socket
import struct
import time
from dataclasses import dataclass
from typing import Any, Dict, Optional, Tuple

BASE_DIR = os.path.dirname(__file__)
CFG_PATH = os.path.join(BASE_DIR, "config", "sonar_ping360.json")
LEGACY_CFG_PATH = os.path.join(BASE_DIR, "config_ping360.json")

DEFAULT_CFG: Dict[str, Any] = {
    "enabled": True,
    "host": "192.168.2.11",
    "fallback_ip": "192.168.2.11",
    "port": 12345,
    "device_id": 1,
    "gain_setting": 1,
    "transmit_duration_us": 500,
    "sample_period_25ns": 4000,
    "frequency_khz": 750,
    "num_samples": 800,
    "range_m": 60.0,
    "start_angle_grad": 0,
    "stop_angle_grad": 399,
    "num_steps": 1,
    "delay_ms": 0,
}

SPEED_OF_SOUND_M_S = 1500.0
COMMON_ACK = 1
COMMON_NACK = 2
COMMON_DEVICE_INFORMATION = 4
COMMON_PROTOCOL_VERSION = 5
COMMON_GENERAL_REQUEST = 6
PING360_DEVICE_DATA = 2300
PING360_AUTO_DEVICE_DATA = 2301
PING360_TRANSDUCER = 2601
PING360_AUTO_TRANSMIT = 2602
PING360_MOTOR_OFF = 2903


def load_cfg() -> Dict[str, Any]:
    path = CFG_PATH if os.path.isfile(CFG_PATH) else LEGACY_CFG_PATH
    if os.path.isfile(path):
        with open(path, "r", encoding="utf-8") as f:
            return normalize_cfg(json.load(f))
    return dict(DEFAULT_CFG)


def save_cfg(cfg: Dict[str, Any]) -> None:
    cfg = normalize_cfg(cfg)
    os.makedirs(os.path.dirname(CFG_PATH), exist_ok=True)
    with open(CFG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)


def _int_range(value: Any, default: int, min_v: int, max_v: int) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        n = default
    return max(min_v, min(max_v, n))


def _float_range(value: Any, default: float, min_v: float, max_v: float) -> float:
    try:
        n = float(value)
    except (TypeError, ValueError):
        n = default
    return max(min_v, min(max_v, n))


def estimate_range_m(sample_period_25ns: Any, num_samples: Any) -> float:
    sp = _int_range(sample_period_25ns, DEFAULT_CFG["sample_period_25ns"], 80, 40000)
    ns = _int_range(num_samples, DEFAULT_CFG["num_samples"], 200, 1200)
    return (SPEED_OF_SOUND_M_S * (sp * 25e-9) * ns) / 2.0


def sample_period_for_range_m(range_m: Any, num_samples: Any) -> int:
    rng = _float_range(range_m, DEFAULT_CFG["range_m"], 1.0, 100.0)
    ns = _int_range(num_samples, DEFAULT_CFG["num_samples"], 200, 1200)
    period = round((rng * 2.0) / (SPEED_OF_SOUND_M_S * ns * 25e-9))
    return _int_range(period, DEFAULT_CFG["sample_period_25ns"], 80, 40000)


def normalize_cfg(raw: Dict[str, Any]) -> Dict[str, Any]:
    raw = raw or {}
    has_range = "range_m" in raw
    cfg = {**DEFAULT_CFG, **raw}
    cfg["enabled"] = str(cfg.get("enabled", True)).strip().lower() not in ("0", "false", "no", "off")
    cfg["host"] = str(cfg.get("host") or DEFAULT_CFG["host"]).strip() or DEFAULT_CFG["host"]
    cfg["fallback_ip"] = str(cfg.get("fallback_ip") or DEFAULT_CFG["fallback_ip"]).strip() or DEFAULT_CFG["fallback_ip"]
    cfg["port"] = _int_range(cfg.get("port"), DEFAULT_CFG["port"], 1, 65535)
    cfg["device_id"] = _int_range(cfg.get("device_id"), DEFAULT_CFG["device_id"], 1, 254)
    cfg["gain_setting"] = _int_range(cfg.get("gain_setting"), DEFAULT_CFG["gain_setting"], 0, 2)
    cfg["transmit_duration_us"] = _int_range(cfg.get("transmit_duration_us"), DEFAULT_CFG["transmit_duration_us"], 1, 1000)
    cfg["frequency_khz"] = _int_range(cfg.get("frequency_khz"), DEFAULT_CFG["frequency_khz"], 500, 1000)
    cfg["num_samples"] = _int_range(cfg.get("num_samples"), DEFAULT_CFG["num_samples"], 200, 1200)
    if has_range:
        cfg["range_m"] = _float_range(cfg.get("range_m"), DEFAULT_CFG["range_m"], 1.0, 100.0)
        cfg["sample_period_25ns"] = sample_period_for_range_m(cfg["range_m"], cfg["num_samples"])
    else:
        cfg["sample_period_25ns"] = _int_range(cfg.get("sample_period_25ns"), DEFAULT_CFG["sample_period_25ns"], 80, 40000)
        cfg["range_m"] = round(estimate_range_m(cfg["sample_period_25ns"], cfg["num_samples"]), 1)
    cfg["start_angle_grad"] = _int_range(cfg.get("start_angle_grad"), DEFAULT_CFG["start_angle_grad"], 0, 399)
    cfg["stop_angle_grad"] = _int_range(cfg.get("stop_angle_grad"), DEFAULT_CFG["stop_angle_grad"], 0, 399)
    cfg["num_steps"] = _int_range(cfg.get("num_steps"), DEFAULT_CFG["num_steps"], 1, 10)
    cfg["delay_ms"] = _int_range(cfg.get("delay_ms"), DEFAULT_CFG["delay_ms"], 0, 100)
    return cfg


def _cksum(data: bytes) -> int:
    return sum(data) & 0xFFFF


def build_ping_frame(msg_id: int, src: int = 0, dst: int = 0, payload: bytes = b"") -> bytes:
    header = b"BR"
    body = (
        struct.pack("<H", len(payload))
        + struct.pack("<H", msg_id)
        + struct.pack("<B", src)
        + struct.pack("<B", dst)
        + payload
    )
    return header + body + struct.pack("<H", _cksum(header + body))


def build_general_request_frame(requested_id: int) -> bytes:
    return build_ping_frame(COMMON_GENERAL_REQUEST, payload=struct.pack("<H", int(requested_id) & 0xFFFF))


def build_auto_transmit_payload(cfg: Dict[str, Any]) -> bytes:
    cfg = normalize_cfg(cfg)
    return struct.pack(
        "<BBHHHHHHBB",
        1,
        cfg["gain_setting"],
        cfg["transmit_duration_us"],
        cfg["sample_period_25ns"],
        cfg["frequency_khz"],
        cfg["num_samples"],
        cfg["start_angle_grad"],
        cfg["stop_angle_grad"],
        cfg["num_steps"],
        cfg["delay_ms"],
    )


def build_auto_transmit_frame(cfg: Dict[str, Any]) -> bytes:
    cfg = normalize_cfg(cfg)
    return build_ping_frame(PING360_AUTO_TRANSMIT, payload=build_auto_transmit_payload(cfg))


def build_transducer_payload(cfg: Dict[str, Any], angle_grad: int, transmit: int = 1) -> bytes:
    cfg = normalize_cfg(cfg)
    return struct.pack(
        "<BBHHHHHBB",
        0,
        cfg["gain_setting"],
        _int_range(angle_grad, cfg["start_angle_grad"], 0, 399),
        cfg["transmit_duration_us"],
        cfg["sample_period_25ns"],
        cfg["frequency_khz"],
        cfg["num_samples"],
        1 if transmit else 0,
        0,
    )


def build_transducer_frame(cfg: Dict[str, Any], angle_grad: int, transmit: int = 1) -> bytes:
    return build_ping_frame(PING360_TRANSDUCER, payload=build_transducer_payload(cfg, angle_grad, transmit))


def build_motor_off_frame(cfg: Dict[str, Any]) -> bytes:
    normalize_cfg(cfg)
    return build_ping_frame(PING360_MOTOR_OFF)


def parse_frames(buf: bytearray):
    out = []
    i = 0
    while True:
        if len(buf) - i < 2:
            break
        if buf[i] != 0x42 or buf[i + 1] != 0x52:
            i += 1
            continue
        if len(buf) - i < 10:
            break
        plen = struct.unpack_from("<H", buf, i + 2)[0]
        msg_id = struct.unpack_from("<H", buf, i + 4)[0]
        src = buf[i + 6]
        dst = buf[i + 7]
        frame_len = 2 + 2 + 2 + 1 + 1 + plen + 2
        if len(buf) - i < frame_len:
            break
        frame = bytes(buf[i : i + frame_len])
        cksum = struct.unpack_from("<H", frame, frame_len - 2)[0]
        if _cksum(frame[:-2]) != cksum:
            i += 1
            continue
        payload = frame[8:-2]
        out.append((msg_id, src, dst, payload))
        i += frame_len
    if i > 0:
        del buf[:i]
    return out


def decode_ping360_auto_device_data(payload: bytes) -> Dict[str, Any]:
    if len(payload) < 20:
        return {"ok": False, "err": "short payload"}

    off = 0
    mode = payload[off]
    off += 1
    gain = payload[off]
    off += 1
    angle = struct.unpack_from("<H", payload, off)[0]
    off += 2
    tx_dur = struct.unpack_from("<H", payload, off)[0]
    off += 2
    sample_period = struct.unpack_from("<H", payload, off)[0]
    off += 2
    freq = struct.unpack_from("<H", payload, off)[0]
    off += 2
    start_angle = struct.unpack_from("<H", payload, off)[0]
    off += 2
    stop_angle = struct.unpack_from("<H", payload, off)[0]
    off += 2
    num_steps = payload[off]
    off += 1
    delay_ms = payload[off]
    off += 1
    num_samples = struct.unpack_from("<H", payload, off)[0]
    off += 2
    data_len = struct.unpack_from("<H", payload, off)[0]
    off += 2

    available = max(0, len(payload) - off)
    if data_len > available:
        data_len = available
    data = payload[off : off + data_len]
    return {
        "ok": True,
        "mode": mode,
        "gain_setting": gain,
        "angle_grad": angle,
        "transmit_duration_us": tx_dur,
        "sample_period_25ns": sample_period,
        "frequency_khz": freq,
        "start_angle_grad": start_angle,
        "stop_angle_grad": stop_angle,
        "num_steps": num_steps,
        "delay_ms": delay_ms,
        "num_samples": num_samples,
        "data_length": data_len,
        "data": list(data),
    }


def decode_ping360_device_data(payload: bytes) -> Dict[str, Any]:
    if len(payload) < 14:
        return {"ok": False, "err": "short payload"}

    off = 0
    mode = payload[off]
    off += 1
    gain = payload[off]
    off += 1
    angle = struct.unpack_from("<H", payload, off)[0]
    off += 2
    tx_dur = struct.unpack_from("<H", payload, off)[0]
    off += 2
    sample_period = struct.unpack_from("<H", payload, off)[0]
    off += 2
    freq = struct.unpack_from("<H", payload, off)[0]
    off += 2
    num_samples = struct.unpack_from("<H", payload, off)[0]
    off += 2
    data_len = struct.unpack_from("<H", payload, off)[0]
    off += 2

    available = max(0, len(payload) - off)
    if data_len > available:
        data_len = available
    data = payload[off : off + data_len]
    return {
        "ok": True,
        "mode": mode,
        "gain_setting": gain,
        "angle_grad": angle,
        "transmit_duration_us": tx_dur,
        "sample_period_25ns": sample_period,
        "frequency_khz": freq,
        "num_samples": num_samples,
        "data_length": data_len,
        "data": list(data),
    }


def decode_protocol_version(payload: bytes) -> Dict[str, Any]:
    if len(payload) < 4:
        return {"ok": False, "err": "short payload"}
    return {
        "ok": True,
        "version_major": payload[0],
        "version_minor": payload[1],
        "version_patch": payload[2],
        "reserved": payload[3],
    }


def decode_device_information(payload: bytes) -> Dict[str, Any]:
    if len(payload) < 10:
        return {"ok": False, "err": "short payload"}
    device_type, device_revision, fw_major, fw_minor, fw_patch, reserved = struct.unpack_from("<BBHHHB", payload, 0)
    return {
        "ok": True,
        "device_type": device_type,
        "device_revision": device_revision,
        "firmware_version_major": fw_major,
        "firmware_version_minor": fw_minor,
        "firmware_version_patch": fw_patch,
        "reserved": reserved,
    }


def decode_nack(payload: bytes) -> Dict[str, Any]:
    if len(payload) < 2:
        return {"ok": False, "err": "short payload"}
    nacked_id = struct.unpack_from("<H", payload, 0)[0]
    nack_message = payload[2:].decode("ascii", errors="replace").strip("\x00\r\n ")
    return {
        "ok": True,
        "nacked_id": nacked_id,
        "nack_message": nack_message,
    }


def next_scan_angle(cfg: Dict[str, Any], current_angle: int, direction: int) -> Tuple[int, int]:
    start = _int_range(cfg.get("start_angle_grad"), DEFAULT_CFG["start_angle_grad"], 0, 399)
    stop = _int_range(cfg.get("stop_angle_grad"), DEFAULT_CFG["stop_angle_grad"], 0, 399)
    step = _int_range(cfg.get("num_steps"), DEFAULT_CFG["num_steps"], 1, 10)

    if start == stop:
        return start, 1

    span = (stop - start) % 400
    rel = (int(current_angle) - start) % 400
    rel = max(0, min(span, rel))
    candidate = rel + (step * direction)

    if candidate > span:
        overflow = candidate - span
        candidate = max(0, span - overflow)
        direction = -1
    elif candidate < 0:
        underflow = -candidate
        candidate = min(span, underflow)
        direction = 1

    return (start + candidate) % 400, direction


@dataclass
class Ping360Runtime:
    running: bool = False
    last_rx_ts: float = 0.0
    last_err: Optional[str] = None


async def ping360_task(state: Dict[str, Any], ws_broadcast, stop_evt: asyncio.Event):
    cfg = load_cfg()
    host = (cfg.get("host") or "192.168.2.11").strip()
    fallback_ip = (cfg.get("fallback_ip") or "192.168.2.11").strip()
    port = int(cfg.get("port") or 12345)
    addr: Tuple[str, int]

    runtime = state.setdefault("sonar", {}).setdefault("ping360", {})
    runtime.update(
        {
            "enabled": bool(cfg.get("enabled", True)),
            "host": host,
            "fallback_ip": fallback_ip,
            "port": port,
            "device_id": cfg.get("device_id"),
            "range_m": cfg.get("range_m"),
            "connected": False,
            "scanning": False,
            "last_err": None,
            "rx_total": runtime.get("rx_total", 0),
            "tx_total": runtime.get("tx_total", 0),
        }
    )

    if not cfg.get("enabled", True):
        return

    try:
        addr = (socket.gethostbyname(host), port)
    except Exception:
        addr = (fallback_ip, port)

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setblocking(False)
    sock.bind(("0.0.0.0", 0))

    loop = asyncio.get_running_loop()
    buf = bytearray()
    auto_frame = build_auto_transmit_frame(cfg)
    motor_off_frame = build_motor_off_frame(cfg)
    startup_frames = (
        build_general_request_frame(COMMON_PROTOCOL_VERSION),
        build_general_request_frame(COMMON_DEVICE_INFORMATION),
    )
    last_cmd_monotonic = 0.0
    last_rx_monotonic = 0.0
    startup_sent = False
    manual_angle = _int_range(cfg.get("start_angle_grad"), DEFAULT_CFG["start_angle_grad"], 0, 399)
    manual_direction = 1
    manual_waiting = False
    manual_last_send_monotonic = 0.0

    runtime["remote_ip"] = addr[0]
    runtime["bind_port"] = sock.getsockname()[1]
    runtime["last_rx_ms"] = 0
    runtime["last_tx_ms"] = 0
    runtime["last_msg_id"] = None
    runtime["last_peer"] = ""
    runtime["scan_mode"] = "auto"
    state.setdefault("counters", {}).setdefault("ping360_rx", 0)

    while not stop_evt.is_set():
        try:
            now = time.monotonic()
            if not startup_sent:
                for frame in startup_frames:
                    await loop.sock_sendto(sock, frame, addr)
                    runtime["tx_total"] = int(runtime.get("tx_total", 0)) + 1
                runtime["last_cmd_ms"] = int(time.time() * 1000) & 0xFFFFFFFF
                runtime["last_tx_ms"] = runtime["last_cmd_ms"]
                startup_sent = True
                last_cmd_monotonic = now

            if runtime.get("scan_mode") == "manual":
                manual_timeout_s = 4.5
                if (not manual_waiting) or ((now - manual_last_send_monotonic) >= manual_timeout_s):
                    manual_frame = build_transducer_frame(cfg, manual_angle, 1)
                    await loop.sock_sendto(sock, manual_frame, addr)
                    runtime["tx_total"] = int(runtime.get("tx_total", 0)) + 1
                    runtime["last_cmd_ms"] = int(time.time() * 1000) & 0xFFFFFFFF
                    runtime["last_tx_ms"] = runtime["last_cmd_ms"]
                    runtime["scanning"] = True
                    manual_waiting = True
                    manual_last_send_monotonic = now
            elif now - last_cmd_monotonic >= (1.0 if last_rx_monotonic == 0.0 else 5.0):
                await loop.sock_sendto(sock, auto_frame, addr)
                runtime["tx_total"] = int(runtime.get("tx_total", 0)) + 1
                runtime["last_cmd_ms"] = int(time.time() * 1000) & 0xFFFFFFFF
                runtime["last_tx_ms"] = runtime["last_cmd_ms"]
                runtime["scanning"] = True
                last_cmd_monotonic = now

            data, peer = await asyncio.wait_for(loop.sock_recvfrom(sock, 65536), timeout=1.0)
            if peer[0] != addr[0]:
                continue
            if not data:
                continue

            runtime["connected"] = True
            runtime["last_peer"] = f"{peer[0]}:{peer[1]}"
            last_rx_monotonic = time.monotonic()
            buf.extend(data)

            for msg_id, src, dst, payload in parse_frames(buf):
                state["counters"]["ping360_rx"] += 1
                runtime["last_rx_ms"] = int(time.time() * 1000) & 0xFFFFFFFF
                runtime["last_rx_monotonic_ms"] = int(time.monotonic() * 1000)
                runtime["last_msg_id"] = msg_id
                runtime["last_err"] = None

                if msg_id == COMMON_PROTOCOL_VERSION:
                    pv = decode_protocol_version(payload)
                    if pv.get("ok"):
                        runtime["protocol_version"] = f"{pv['version_major']}.{pv['version_minor']}.{pv['version_patch']}"
                    else:
                        runtime["last_err"] = pv.get("err") or "protocol version decode failed"
                    continue

                if msg_id == COMMON_DEVICE_INFORMATION:
                    info = decode_device_information(payload)
                    if info.get("ok"):
                        runtime["device_information"] = info
                    else:
                        runtime["last_err"] = info.get("err") or "device info decode failed"
                    continue

                if msg_id == COMMON_NACK:
                    nack = decode_nack(payload)
                    if nack.get("ok") and nack.get("nacked_id") == PING360_AUTO_TRANSMIT:
                        runtime["scan_mode"] = "manual"
                        runtime["last_err"] = "auto_transmit unsupported, fallback manual scan"
                        runtime["scanning"] = True
                        manual_waiting = False
                        manual_last_send_monotonic = 0.0
                        continue
                    elif nack.get("ok"):
                        msg = nack.get("nack_message") or "nack"
                        runtime["last_err"] = f"nack {nack.get('nacked_id')}: {msg}"
                    else:
                        runtime["last_err"] = nack.get("err") or "nack decode failed"
                    runtime["scanning"] = False
                    continue

                if msg_id == COMMON_ACK:
                    runtime["last_ack_id"] = struct.unpack_from("<H", payload, 0)[0] if len(payload) >= 2 else None
                    continue

                if msg_id == PING360_AUTO_DEVICE_DATA:
                    dd = decode_ping360_auto_device_data(payload)
                elif msg_id == PING360_DEVICE_DATA:
                    dd = decode_ping360_device_data(payload)
                    manual_waiting = False
                    manual_angle, manual_direction = next_scan_angle(cfg, dd.get("angle_grad", manual_angle), manual_direction)
                else:
                    continue

                if not dd.get("ok"):
                    runtime["last_err"] = dd.get("err") or "decode failed"
                    continue

                runtime["last"] = dd
                runtime["scanning"] = True
                runtime["range_m"] = round(estimate_range_m(dd.get("sample_period_25ns"), dd.get("num_samples")), 1)
                runtime["rx_total"] = int(runtime.get("rx_total", 0)) + 1
                await ws_broadcast(
                    {
                        "type": "sonar",
                        "kind": "ping360",
                        "ts_ms": runtime["last_rx_ms"],
                        "angle_grad": dd.get("angle_grad", 0),
                        "angle_deg": float(dd.get("angle_grad", 0)) * 0.9,
                        "range_m": runtime["range_m"],
                        "samples": dd.get("data", []),
                        "payload": dd,
                    }
                )
        except asyncio.TimeoutError:
            if last_rx_monotonic and (time.monotonic() - last_rx_monotonic) > 5.0:
                runtime["connected"] = False
                runtime["scanning"] = False
        except (BlockingIOError, InterruptedError):
            await asyncio.sleep(0.01)
        except (ConnectionResetError, OSError) as e:
            runtime["last_err"] = str(e)
            runtime["connected"] = False
            await asyncio.sleep(0.5)
        except Exception as e:
            runtime["last_err"] = str(e)
            await asyncio.sleep(0.1)

    try:
        await loop.sock_sendto(sock, motor_off_frame, addr)
    except Exception:
        pass
    sock.close()
    runtime["connected"] = False
    runtime["scanning"] = False
