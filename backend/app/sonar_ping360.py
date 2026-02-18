import asyncio, json, os, socket, struct, time
from dataclasses import dataclass
from typing import Optional, Dict, Any, Tuple

BASE_DIR = os.path.dirname(__file__)
CFG_PATH = os.path.join(BASE_DIR, "config_ping360.json")

# ---- Ping Protocol framing (BR...checksum) ----
# Doc: header + payload_length + msg_id + src/dst + payload + checksum (sum)   [oai_citation:3‡docs.bluerobotics.com](https://docs.bluerobotics.com/ping-protocol)
# Qui implementiamo un frame minimale usato dal viewer: parse robusto + build per comandi.

def load_cfg() -> Dict[str, Any]:
    if os.path.isfile(CFG_PATH):
        with open(CFG_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}

def save_cfg(cfg: Dict[str, Any]) -> None:
    with open(CFG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)

def _cksum(data: bytes) -> int:
    # checksum = somma bytes (mod 256) (approccio tipico Ping Protocol)
    return sum(data) & 0xFF

def build_ping_frame(msg_id: int, src: int, dst: int, payload: bytes) -> bytes:
    # Frame base: "BR" + len(u16) + msg_id(u16) + src(u8) + dst(u8) + payload + checksum(u8)
    # NOTA: il ping protocol usa campi definiti; questo frame è compatibile col pattern BR + ... + checksum  [oai_citation:4‡docs.bluerobotics.com](https://docs.bluerobotics.com/ping-protocol)
    header = b"BR"
    plen = len(payload)
    body = struct.pack("<H", plen) + struct.pack("<H", msg_id) + struct.pack("<B", src) + struct.pack("<B", dst) + payload
    cs = _cksum(header + body)
    return header + body + struct.pack("<B", cs)

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
        if len(buf) - i < 2 + 2 + 2 + 1 + 1 + 1:
            break
        plen = struct.unpack_from("<H", buf, i+2)[0]
        msg_id = struct.unpack_from("<H", buf, i+4)[0]
        src = buf[i+6]
        dst = buf[i+7]
        frame_len = 2 + 2 + 2 + 1 + 1 + plen + 1
        if len(buf) - i < frame_len:
            break
        frame = bytes(buf[i:i+frame_len])
        cs = frame[-1]
        if _cksum(frame[:-1]) != cs:
            # checksum errato: scarta sync e riprova
            i += 1
            continue
        payload = frame[2+2+2+1+1:-1]
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
    if len(payload) < 2 + 2*6 + 2*2 + 2 + 2:  # stima minima
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
    runtime.update({"enabled": bool(cfg.get("enabled", True)), "host": host, "port": port, "connected": False})

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

    # opzionale: bind locale se vuoi ricevere su una porta specifica
    # sock.bind(("0.0.0.0", 0))

    buf = bytearray()

    runtime["connected"] = True
    runtime["last_rx_ms"] = 0
    state.setdefault("counters", {}).setdefault("ping360_rx", 0)

    while not stop_evt.is_set():
        try:
            data = await asyncio.get_running_loop().sock_recv(sock, 65536)
            if not data:
                await asyncio.sleep(0.01)
                continue
            buf.extend(data)
            frames = parse_frames(buf)
            for (msg_id, src, dst, payload) in frames:
                state["counters"]["ping360_rx"] += 1
                runtime["last_rx_ms"] = int(time.time() * 1000) & 0xFFFFFFFF

                # 2301 auto_device_data  [oai_citation:6‡docs.bluerobotics.com](https://docs.bluerobotics.com/ping-protocol/pingmessage-ping360/)
                if msg_id == 2301:
                    dd = decode_ping360_auto_device_data(payload)
                    runtime["last"] = dd
                    # manda un “delta” leggero (senza tutto lo state)
                    await ws_broadcast({
                        "type": "sonar",
                        "kind": "ping360_auto_device_data",
                        "ts_ms": runtime["last_rx_ms"],
                        "payload": dd
                    })
        except (BlockingIOError, InterruptedError):
            await asyncio.sleep(0.01)
        except Exception as e:
            runtime["last_err"] = str(e)
            await asyncio.sleep(0.1)

    runtime["connected"] = False