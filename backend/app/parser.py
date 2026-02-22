"""NMEA-like parsing utilities extracted from main.py"""
from typing import Tuple, List

def nmea_xor_checksum(payload: str) -> str:
    c = 0
    for ch in payload:
        c ^= ord(ch)
    return f"{c:02X}"

def build_nmea_line(fields: List[str]) -> str:
    payload = ",".join(fields)
    cs = nmea_xor_checksum(payload)
    return f"${payload}*{cs}\r\n"

def kv_payload_to_dict(rest: List[str]) -> dict:
    out = {}
    n = len(rest)
    for i in range(0, n - 1, 2):
        k = rest[i].strip()
        v = rest[i + 1].strip()
        if not k:
            continue
        try:
            if v.lower().startswith("0x"):
                out[k] = int(v, 16)
            else:
                out[k] = int(v)
        except Exception:
            out[k] = v
    return out

def parse_nmea_line(line: str):
    line = line.strip()
    if not line.startswith("$") or "*" not in line:
        return None, "format"
    payload, cs = line[1:].split("*", 1)
    cs = cs[:2].upper()
    exp = nmea_xor_checksum(payload)
    if cs != exp:
        return None, "checksum"
    parts = payload.split(",")
    if len(parts) < 6:
        return None, "fields"
    src, dst, msg, ver, seq, ts_ms, *rest = parts
    return {
        "src": src,
        "dst": dst,
        "msg": msg,
        "ver": ver,
        "seq": int(seq),
        "ts_ms": int(ts_ms),
        "raw": line,
        "rest": rest,
    }, None
