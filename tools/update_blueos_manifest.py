#!/usr/bin/env python3
import argparse
import json
import subprocess
import uuid
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
IMAGE = "ghcr.io/erric0x5b/calypso-ui"
IDENTIFIER = "it.deepex.calypso-ui"
LOGO = "https://raw.githubusercontent.com/erric0x5b/calypso-ui/master/data/media/Logo_deepex_2026-tondo.svg"


def run_json(args):
    output = subprocess.check_output(args, text=True)
    return json.loads(output)


def manifest_for(image_ref):
    return run_json(["docker", "buildx", "imagetools", "inspect", "--raw", image_ref])


def layer_size(image_ref, digest):
    data = manifest_for(f"{image_ref}@{digest}")
    return sum(layer.get("size", 0) for layer in data.get("layers", []))


def image_entries(version):
    image_ref = f"{IMAGE}:{version}"
    index = manifest_for(image_ref)
    entries = []
    for item in index.get("manifests", []):
        platform = item.get("platform") or {}
        if platform.get("os") != "linux":
            continue
        if platform.get("architecture") == "unknown":
            continue
        digest = item["digest"]
        entries.append({
            "expanded_size": layer_size(image_ref, digest),
            "platform": {
                "architecture": platform.get("architecture"),
                "variant": platform.get("variant"),
                "os": platform.get("os"),
            },
            "digest": digest,
        })
    return entries


def version_entry(version):
    return {
        "identifier": str(uuid.uuid5(uuid.NAMESPACE_DNS, f"{IDENTIFIER}.{version}")),
        "type": "interface",
        "website": "https://github.com/erric0x5b/calypso-ui",
        "images": image_entries(version),
        "authors": [{"name": "DeepEx", "email": "support@deepex.example"}],
        "filter_tags": ["rov", "telemetry", "control", "video"],
        "extra_links": {
            "website": "https://github.com/erric0x5b/calypso-ui",
            "support": "https://github.com/erric0x5b/calypso-ui/issues",
        },
        "tag": version,
        "docs": None,
        "readme": (
            "<h1>Calypso UI</h1>\n"
            "<p>BlueOS extension for the DeepEx Calypso ROV control interface.</p>\n"
            "<p>The extension provides the vehicle dashboard, power SCADA, telemetry widgets, "
            "mission logging, video stream display, sonar controls, diagnostics, and setup tools "
            "used by the Calypso UI backend.</p>"
        ),
        "support": "https://github.com/erric0x5b/calypso-ui/issues",
        "requirements": "core >= 1.1",
        "company": {
            "about": "ROV systems and marine exploration technologies",
            "name": "DeepEx",
            "email": "support@deepex.it",
        },
        "permissions": {
            "ExposedPorts": {
                "80/tcp": {},
                "14590/udp": {},
                "14591/udp": {},
                "5010/udp": {},
            },
            "HostConfig": {
                "ExtraHosts": ["host.docker.internal:host-gateway"],
                "PortBindings": {
                    "80/tcp": [{"HostPort": ""}],
                    "14590/udp": [{"HostPort": "14590"}],
                    "14591/udp": [{"HostPort": "14591"}],
                    "5010/udp": [{"HostPort": "5010"}],
                },
                "Binds": ["/usr/blueos/extensions/it.deepex.calypso-ui:/data"],
            },
        },
    }


def build_manifest(versions):
    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    return [{
        "identifier": IDENTIFIER,
        "name": "Calypso UI",
        "website": "https://github.com/erric0x5b/calypso-ui",
        "docker": IMAGE,
        "description": "DeepEx Calypso ROV control interface for BlueOS.",
        "extension_logo": LOGO,
        "company_logo": LOGO,
        "versions": {version: version_entry(version) for version in versions},
        "repo_info": {
            "downloads": 0,
            "last_updated": now,
            "date_registered": "2026-05-16T00:00:00Z",
        },
    }]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("versions", nargs="+", help="SemVer Docker tags already pushed to GHCR")
    parser.add_argument("--output", default="blueos/manifest.json")
    args = parser.parse_args()

    data = build_manifest(args.versions)
    output = ROOT / args.output
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
