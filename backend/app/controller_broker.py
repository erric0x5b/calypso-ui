import asyncio
import json
import logging
import os
import socket
import time
from dataclasses import dataclass
from typing import Any, Callable, Optional

log = logging.getLogger("calypso.controller_broker")

REQUIRED_CONTROLLER_KEYS = {
    "seq",
    "ts_ms",
    "controller_online",
    "active_link",
    "raw",
    "mapped",
    "health",
}


@dataclass
class ControllerBrokerStats:
    listener_ok: bool = False
    listener_bind: str = "?"
    listener_port: int = 0
    listener_error: str = ""

    rx_total: int = 0
    rx_valid: int = 0
    rx_invalid: int = 0
    rx_last_ts_ms: int = 0
    rx_last_from: str = ""
    rx_last_len: int = 0
    rx_last_error: str = ""
    rx_last_seq: Optional[int] = None
    rx_last_active_link: str = ""


def _as_bool(v: Any) -> bool:
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return int(v) != 0
    if isinstance(v, str):
        return v.strip().lower() in {"1", "true", "yes", "on", "online", "ok"}
    return bool(v)


def _as_int(v: Any, default: int = 0) -> int:
    try:
        return int(v)
    except Exception:
        return default


def _dict_or_empty(v: Any) -> dict:
    return dict(v) if isinstance(v, dict) else {}


def _list_or_empty(v: Any) -> list:
    return list(v) if isinstance(v, list) else []


def empty_controller_state() -> dict:
    return {
        "online": False,
        "last_update_ms": 0,
        "last_seen_monotonic_ms": 0,
        "seq": None,
        "ts_ms": None,
        "controller_online": False,
        "active_link": "no_link",
        "usb_available": False,
        "bt_available": False,
        "source_quality": None,
        "profile": None,
        "mode": None,
        "raw": {},
        "buttons": {},
        "switches": {},
        "mapped": {},
        "events": [],
        "health": {
            "link_stale": True,
            "vjoy_ok": False,
            "safe_output": True,
        },
    }


def normalize_controller_payload(payload: Any, now_ms: int, monotonic_ms: int) -> tuple[dict | None, str | None]:
    if not isinstance(payload, dict):
        return None, "payload is not a JSON object"

    missing = sorted(k for k in REQUIRED_CONTROLLER_KEYS if k not in payload)
    if missing:
        return None, f"missing required fields: {', '.join(missing)}"

    raw = _dict_or_empty(payload.get("raw"))
    mapped = _dict_or_empty(payload.get("mapped"))
    health = _dict_or_empty(payload.get("health"))
    if not raw:
        return None, "raw must be an object"
    if not isinstance(payload.get("mapped"), dict):
        return None, "mapped must be an object"
    if not health:
        return None, "health must be an object"

    active_link = str(payload.get("active_link") or "no_link").strip().lower() or "no_link"
    controller_online = _as_bool(payload.get("controller_online"))

    state = empty_controller_state()
    state.update({
        "online": controller_online and not _as_bool(health.get("link_stale", False)),
        "last_update_ms": now_ms,
        "last_seen_monotonic_ms": monotonic_ms,
        "seq": _as_int(payload.get("seq")),
        "ts_ms": _as_int(payload.get("ts_ms")),
        "controller_online": controller_online,
        "active_link": active_link,
        "usb_available": _as_bool(payload.get("usb_available", active_link == "usb")),
        "bt_available": _as_bool(payload.get("bt_available", active_link == "bt")),
        "source_quality": payload.get("source_quality"),
        "profile": payload.get("profile"),
        "mode": payload.get("mode"),
        "raw": raw,
        "buttons": _dict_or_empty(payload.get("buttons")),
        "switches": _dict_or_empty(payload.get("switches")),
        "mapped": mapped,
        "events": _list_or_empty(payload.get("events")),
        "health": {
            **health,
            "link_stale": _as_bool(health.get("link_stale", False)),
            "vjoy_ok": _as_bool(health.get("vjoy_ok", False)),
            "safe_output": _as_bool(health.get("safe_output", False)),
        },
    })
    return state, None


class ControllerBrokerProtocol(asyncio.DatagramProtocol):
    def __init__(
        self,
        stats: ControllerBrokerStats,
        on_payload: Optional[Callable[[dict, tuple], None]] = None,
    ):
        self.stats = stats
        self.on_payload = on_payload

    def connection_made(self, transport):
        sock = transport.get_extra_info("socket")
        if sock:
            try:
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1_048_576)
            except Exception:
                pass

    def datagram_received(self, data: bytes, addr):
        s = self.stats
        s.rx_total += 1
        s.rx_last_ts_ms = int(time.time() * 1000)
        s.rx_last_from = f"{addr[0]}:{addr[1]}"
        s.rx_last_len = len(data)

        try:
            payload = json.loads(data.decode("utf-8"))
        except Exception as exc:
            s.rx_invalid += 1
            s.rx_last_error = f"json: {exc}"
            return

        now_ms = int(time.time() * 1000)
        monotonic_ms = int(time.monotonic() * 1000)
        normalized, err = normalize_controller_payload(payload, now_ms, monotonic_ms)
        if err:
            s.rx_invalid += 1
            s.rx_last_error = err
            return

        s.rx_valid += 1
        s.rx_last_error = ""
        s.rx_last_seq = normalized.get("seq")
        s.rx_last_active_link = normalized.get("active_link") or ""

        if (s.rx_valid % 50) == 1:
            log.info(
                "controller UDP RX valid=%d from=%s seq=%s link=%s",
                s.rx_valid,
                s.rx_last_from,
                s.rx_last_seq,
                s.rx_last_active_link,
            )

        if self.on_payload:
            self.on_payload(normalized, addr)


async def start_controller_broker_listener(
    stats: ControllerBrokerStats,
    on_payload: Optional[Callable[[dict, tuple], None]] = None,
):
    port = int(os.getenv("CALYPSO_CONTROLLER_UDP_PORT", "5010"))
    bind_host = os.getenv("CALYPSO_CONTROLLER_UDP_BIND", os.getenv("CALYPSO_UDP_BIND", "0.0.0.0"))

    loop = asyncio.get_running_loop()
    try:
        transport, _protocol = await loop.create_datagram_endpoint(
            lambda: ControllerBrokerProtocol(stats, on_payload=on_payload),
            local_addr=(bind_host, port),
        )
        stats.listener_ok = True
        stats.listener_bind = bind_host
        stats.listener_port = port
        log.info("controller broker UDP listener started on %s:%d", bind_host, port)
        return transport
    except Exception as e:
        stats.listener_ok = False
        stats.listener_error = repr(e)
        stats.listener_bind = bind_host
        stats.listener_port = port
        log.exception("controller broker UDP listener FAILED on %s:%d", bind_host, port)
        return None


def mark_controller_stale(controller: dict, now_ms: int) -> bool:
    if not controller:
        return False
    if controller.get("online") is False and controller.get("health", {}).get("link_stale") is True:
        return False

    health = controller.setdefault("health", {})
    health["link_stale"] = True
    health["safe_output"] = True
    controller["online"] = False
    controller["controller_online"] = False
    controller["active_link"] = "no_link"
    controller["last_stale_ms"] = now_ms
    return True
