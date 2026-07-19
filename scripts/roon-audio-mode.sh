#!/usr/bin/env bash
# Point Tom's RoonBridge SXW output at PipeWire (shared) or exclusive ALSA hw.
# Usage:
#   ./scripts/roon-audio-mode.sh shared     # coexist with MadCool DJ / desktop
#   ./scripts/roon-audio-mode.sh exclusive  # bit-perfect exclusive ALSA (default Roon style)
set -euo pipefail

MODE="${1:-shared}"
CFG="$HOME/.RAATServer/Settings/device_9f26085834456ceb380b58e8a5597eb6.json"
UID_KEEP="157b8427-eec7-1a67-e394-1f6613796685"

if [[ ! -f "$CFG" ]]; then
  echo "RAAT device config not found: $CFG" >&2
  exit 1
fi

case "$MODE" in
  shared|pipewire)
    python3 - "$CFG" "$UID_KEEP" <<'PY'
import json, sys
path, uid = sys.argv[1], sys.argv[2]
cfg = {
  "unique_id": uid,
  "output": {
    "type": "alsa",
    "device": "plug:pipewire",
    "name": "Tom - SXW (PipeWire shared)",
    "dsd_mode": "none",
  },
  "volume": {"type": "software"},
  "external_config": {},
}
open(path, "w").write(json.dumps(cfg, indent=2) + "\n")
print(f"wrote shared → {path}")
PY
    ;;
  exclusive|hw)
    python3 - "$CFG" "$UID_KEEP" <<'PY'
import json, sys
path, uid = sys.argv[1], sys.argv[2]
cfg = {
  "unique_id": uid,
  "output": {
    "type": "alsa",
    "device": "hw:CARD=SXWMDL7601INTCL,DEV=0",
    "name": "SXW-MDL7601-INTCLK_A2",
    "dsd_mode": "none",
  },
  "volume": {"type": "alsa", "device": "hw:CARD=SXWMDL7601INTCL,DEV=0"},
  "external_config": {},
}
open(path, "w").write(json.dumps(cfg, indent=2) + "\n")
print(f"wrote exclusive → {path}")
PY
    ;;
  *)
    echo "usage: $0 shared|exclusive" >&2
    exit 2
    ;;
esac

echo "Restart RoonBridge so RAAT reloads the device (stop start.sh / RoonBridge, then):"
echo "  cd /opt/RoonBridge && XDG_RUNTIME_DIR=/run/user/\$(id -u) ./start.sh"
echo "MadCool DJ should stay on DJ_AUDIO_MODE=shared (Pulse Default Sink)."
