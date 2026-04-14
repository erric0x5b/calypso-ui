import asyncio, json, os, socket, struct, time
from dataclasses import dataclass
from typing import Optional, Dict, Any, Tuple

BASE_DIR = os.path.dirname(__file__)
CFG_PATH = os.path.join(BASE_DIR, "config", "sonar_ping360.json")
LEGACY_CFG_PATH = os.path.join(BASE_DIR, "config_ping360.json")

DEFAULT_CFG: Dict[str, Any] = {
    "enabled": True,
    "host": "blueos",
    "fallback_ip": "192.168.2.2",
    "port": 9092,
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

# ---- Ping Protocol framing (BR...checksum) ----
# Doc: header + payload_length + msg_id + src/dst + payload + checksum (sum)   [oai_citation:3‡docs.bluerobotics.com](https://docs.bluerobotics.com/ping-protocol)
# Qui implementiamo un frame minimale usato dal viewer: parse robusto + build per comandi.

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
    cfg = {**DEFAULT_CFG, **(raw or {})}
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

def build_ping_frame(msg_id: int, src: int, dst: int, payload: bytes) -> bytes:
    # Ping Protocol frame: "BR" + len(u16) + msg_id(u16) + src(u8) + dst(u8) + payload + checksum(u16)
    header = b"BR"
    plen = len(payload)
    body = struct.pack("<H", plen) + struct.pack("<H", msg_id) + struct.pack("<B", src) + struct.pack("<B", dst) + payload
    cs = _cksum(header + body)
    return header + body + struct.pack("<H", cs)

def build_auto_transmit_payload(cfg: Dict[str, Any]) -> bytes:
    cfg = normalize_cfg(cfg)
    return struct.pack(
        "<BBHHHHHHBB",
        1,  # Ping360 operating mode
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
    return build_ping_frame(2602, 0, cfg["device_id"], build_auto_transmit_payload(cfg))

def build_motor_off_frame(cfg: Dict[str, Any]) -> bytes:
    cfg = normalize_cfg(cfg)
    return build_ping_frame(2903, 0, cfg["device_id"], b"")

def parse_frames(buf: bytearray):
    """
    Estrae frame da un buffer; ritorna lista di tuple (msg_id, src, dst, payload_bytes).
    """
    out = []
    i = 0
    while True:
        if len(buf) - i < 2:
            break
        # cerca "BR"
        if buf[i] != 0x42 or buf[i+1] != 0x52:  # 'B''R'
            i += 1
            continue
        if len(buf) - i < 2 + 2 + 2 + 1 + 1 + 2:
            break
        plen = struct.unpack_from("<H", buf, i+2)[0]
        msg_id = struct.unpack_from("<H", buf, i+4)[0]
        src = buf[i+6]
        dst = buf[i+7]
        frame_len = 2 + 2 + 2 + 1 + 1 + plen + 2
        if len(buf) - i < frame_len:
            break
        frame = bytes(buf[i:i+frame_len])
        cs = struct.unpack_from("<H", frame, frame_len - 2)[0]
        if _cksum(frame[:-2]) != cs:
            # checksum errato: scarta sync e riprova
            i += 1
            continue
        payload = frame[2+2+2+1+1:-2]
        out.append((msg_id, src, dst, payload))
        i += frame_len

    # drop consumed bytes
    if i > 0:
        del buf[:i]
    return out

# ---- Ping360 payload decode ----
# 2301 auto_device_data fields per doc  [oai_citation:5‡docs.bluerobotics.com](https://docs.bluerobotics.com/ping-protocol/pingmessage-ping360/)
def decode_ping360_auto_device_data(payload: bytes) -> Dict[str, Any]:
    # Layout dal doc (tipi): u8,u8,u16,u16,u16,u16,u16,u16,u16,u8,u8,u16,u8[]
    # In pratica: fino a data_length incluso e poi data[]
    # NB: qui assumiamo little-endian.
    if len(payload) < 22:
        return {"ok": False, "err": "short payload"}

    off = 0
    mode = payload[off]; off += 1
    gain = payload[off]; off += 1
    angle = struct.unpack_from("<H", payload, off)[0]; off += 2
    tx_dur = struct.unpack_from("<H", payload, off)[0]; off += 2
    sample_period = struct.unpack_from("<H", payload, off)[0]; off += 2
    freq = struct.unpack_from("<H", payload, off)[0]; off += 2

    start_angle = struct.unpack_from("<H", payload, off)[0]; off += 2
    stop_angle  = struct.unpack_from("<H", payload, off)[0]; off += 2
    num_steps = payload[off]; off += 1
    delay_ms  = payload[off]; off += 1

    num_samples = struct.unpack_from("<H", payload, off)[0]; off += 2
    data_len = struct.unpack_from("<H", payload, off)[0]; off += 2

    available = max(0, len(payload) - off)
    if data_len > available:
        data_len = available
    data = payload[off:off+data_len]
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
        "data": list(data)  # per UI (poi ottimizziamo)
    }

@dataclass
class Ping360Runtime:
    running: bool = False
    last_rx_ts: float = 0.0
    last_err: Optional[str] = None

async def ping360_task(state: Dict[str, Any], ws_broadcast, stop_evt: asyncio.Event):
    """
    - riceve datagrammi UDP dal BlueOS (o direttamente dal sonar se esposto)
    - decodifica Ping Protocol
    - aggiorna state["sonar"]["ping360"]
    - manda WS {type:"sonar", kind:"ping360", ...}
    """
    cfg = load_cfg()
    host = (cfg.get("host") or "blueos").strip()
    fallback_ip = (cfg.get("fallback_ip") or "192.168.2.2").strip()
    port = int(cfg.get("port") or 9092)

    runtime = state.setdefault("sonar", {}).setdefault("ping360", {})
    runtime.update({
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
    })

    if not cfg.get("enabled", True):
        return

    # resolve host (fallback ip)
    addr = None
    try:
        addr = (socket.gethostbyname(host), port)
    except Exception:
        addr = (fallback_ip, port)

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setblocking(False)
    loop = asyncio.get_running_loop()

    buf = bytearray()

    try:
        sock.connect(addr)
        runtime["connected"] = True
        runtime["remote_ip"] = addr[0]
        runtime["last_rx_ms"] = 0
        runtime["last_tx_ms"] = 0
        state.setdefault("counters", {}).setdefault("ping360_rx", 0)

        await loop.sock_sendall(sock, build_auto_transmit_frame(cfg))
        runtime["tx_total"] = int(runtime.get("tx_total", 0)) + 1
        runtime["last_tx_ms"] = int(time.time() * 1000) & 0xFFFFFFFF
        runtime["scanning"] = True

        while not stop_evt.is_set():
            try:
                try:
                    data = await asyncio.wait_for(loop.sock_recv(sock, 65536), timeout=1.0)
                except asyncio.TimeoutError:
                    continue
                if not data:
                    await asyncio.sleep(0.01)
                    continue
                buf.extend(data)
                frames = parse_frames(buf)
                for (msg_id, src, dst, payload) in frames:
                    state["counters"]["ping360_rx"] += 1
                    runtime["last_rx_ms"] = int(time.time() * 1000) & 0xFFFFFFFF

                    if msg_id == 2301:
                        dd = decode_ping360_auto_device_data(payload)
                        if not dd.get("ok"):
                            runtime["last_err"] = dd.get("err") or "decode failed"
                            continue
                        runtime["last"] = dd
                        runtime["rx_total"] = int(runtime.get("rx_total", 0)) + 1
                        await ws_broadcast({
                            "type": "sonar",
                            "kind": "ping360",
                            "ts_ms": runtime["last_rx_ms"],
                            "angle_grad": dd.get("angle_grad", 0),
                            "angle_deg": float(dd.get("angle_grad", 0)) * 0.9,
                            "range_m": round(estimate_range_m(dd.get("sample_period_25ns"), dd.get("num_samples")), 1),
                            "samples": dd.get("data", []),
                            "payload": dd,
                        })
            except (BlockingIOError, InterruptedError):
                await asyncio.sleep(0.01)
            except (ConnectionResetError, OSError) as e:
                runtime["last_err"] = str(e)
                await asyncio.sleep(0.5)
            except Exception as e:
                runtime["last_err"] = str(e)
                await asyncio.sleep(0.1)
    except Exception as e:
        runtime["last_err"] = str(e)
    finally:
        try:
            sock.send(build_motor_off_frame(cfg))
        except Exception:
            pass
        sock.close()

    runtime["connected"] = False
    runtime["scanning"] = False
