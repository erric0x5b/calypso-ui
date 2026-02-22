import os
import json

LIGHTS_CFG_PATH = os.getenv("CALYPSO_LIGHTS_CFG", "/data/deepex_logs/lights_config.json")
DEFAULT_LIGHTS_CFG = {
    "version": 1,
    "channels": {
        "1": {"name": "CH1", "lamp_ids": []},
        "2": {"name": "CH2", "lamp_ids": []},
        "3": {"name": "CH3", "lamp_ids": []},
        "4": {"name": "CH4", "lamp_ids": []},
    }
}

def save_lights_cfg(cfg: dict):
    os.makedirs(os.path.dirname(LIGHTS_CFG_PATH), exist_ok=True)
    with open(LIGHTS_CFG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)

def load_lights_cfg() -> dict:
    try:
        with open(LIGHTS_CFG_PATH, "r", encoding="utf-8") as f:
            cfg = json.load(f)
    except Exception:
        save_lights_cfg(DEFAULT_LIGHTS_CFG)
        return DEFAULT_LIGHTS_CFG

    # normalize/merge
    if "channels" not in cfg or not isinstance(cfg["channels"], dict):
        cfg["channels"] = {}

    for k in ("1","2","3","4"):
        ch = cfg["channels"].get(k)
        if not isinstance(ch, dict):
            ch = {"name": f"CH{k}", "lamp_ids": []}
            cfg["channels"][k] = ch
        ch.setdefault("name", f"CH{k}")
        ch.setdefault("lamp_ids", [])
        lamp_ids = ch.get("lamp_ids", [])
        if not isinstance(lamp_ids, list):
            lamp_ids = []
        lamp_ids = [int(x) for x in lamp_ids if isinstance(x, int) or (isinstance(x, str) and x.isdigit())]
        lamp_ids = sorted(set([x for x in lamp_ids if x >= 1]))
        ch["lamp_ids"] = lamp_ids

    cfg["version"] = int(cfg.get("version", 1))
    return cfg
