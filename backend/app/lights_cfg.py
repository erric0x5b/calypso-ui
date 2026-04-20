import os
import json

LIGHTS_CFG_PATH = os.getenv("CALYPSO_LIGHTS_CFG", "/data/deepex_logs/lights_config.json")
DEFAULT_LIGHTS_CFG = {
    "version": 1,
    "channels": {
        "1": {"name": "CH1", "pod": "BAT1", "lamp_ids": []},
        "2": {"name": "CH2", "pod": "BAT1", "lamp_ids": []},
        "3": {"name": "CH3", "pod": "BAT2", "lamp_ids": []},
        "4": {"name": "CH4", "pod": "BAT2", "lamp_ids": []},
    },
    "pods": {
        "BAT1": {"name": "BAT1", "lamp_ids": [1, 2, 3]},
        "BAT2": {"name": "BAT2", "lamp_ids": [4, 5]},
    }
}

def normalize_lamp_ids(value) -> list[int]:
    if not isinstance(value, list):
        return []
    ids = [int(x) for x in value if isinstance(x, int) or (isinstance(x, str) and x.isdigit())]
    return sorted(set([x for x in ids if x >= 1]))

def channel_pod(ch: str) -> str:
    return "BAT1" if str(ch) in ("1", "2") else "BAT2"

def save_lights_cfg(cfg: dict):
    os.makedirs(os.path.dirname(LIGHTS_CFG_PATH), exist_ok=True)
    with open(LIGHTS_CFG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)

def normalize_lights_cfg(cfg: dict) -> dict:
    if not isinstance(cfg, dict):
        cfg = {}

    out = {
        "version": int(cfg.get("version", 1)),
        "channels": {},
        "pods": {},
    }

    channels = cfg.get("channels")
    if not isinstance(channels, dict):
        channels = {}

    default_channels = DEFAULT_LIGHTS_CFG["channels"]
    for k in ("1", "2", "3", "4"):
        ch = channels.get(k)
        if not isinstance(ch, dict):
            ch = default_channels[k]
        out["channels"][k] = {
            "name": str(ch.get("name", f"CH{k}")),
            "pod": channel_pod(k),
            "lamp_ids": normalize_lamp_ids(ch.get("lamp_ids", [])),
        }

    pods = cfg.get("pods")
    if not isinstance(pods, dict):
        pods = {}

    default_pods = DEFAULT_LIGHTS_CFG["pods"]
    for pod in ("BAT1", "BAT2"):
        pod_cfg = pods.get(pod)
        if not isinstance(pod_cfg, dict):
            pod_cfg = default_pods[pod]
        out["pods"][pod] = {
            "name": str(pod_cfg.get("name", pod)),
            "lamp_ids": normalize_lamp_ids(pod_cfg.get("lamp_ids", [])),
        }

    return out

def load_lights_cfg() -> dict:
    try:
        with open(LIGHTS_CFG_PATH, "r", encoding="utf-8") as f:
            cfg = json.load(f)
    except Exception:
        cfg = normalize_lights_cfg(DEFAULT_LIGHTS_CFG)
        save_lights_cfg(cfg)
        return cfg

    normalized = normalize_lights_cfg(cfg)
    if normalized != cfg:
        save_lights_cfg(normalized)
    return normalized
