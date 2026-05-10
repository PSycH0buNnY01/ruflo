#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE="$HERE/../../aperture"

echo "[smoke] cargo test"
( cd "$WORKSPACE" && cargo test --workspace --quiet )

echo "[smoke] naming gate"
# NOTICE.md and this script intentionally name the inspiration repo; everything
# else must be vendor-neutral.
GATE_RE='b''l''o''o''mberg|b''p''i''p''e|^b''l''p\b|f''i''n''msg'
if rg -i "$GATE_RE" "$WORKSPACE" "$HERE" \
     --glob '!target/**' --glob '!dist/**' --glob '!*.lock' \
     --glob '!NOTICE.md' --glob '!scripts/smoke.sh' >/dev/null; then
  echo "naming gate failed: vendor token present" >&2
  rg -i "$GATE_RE" "$WORKSPACE" "$HERE" \
     --glob '!target/**' --glob '!dist/**' --glob '!*.lock' \
     --glob '!NOTICE.md' --glob '!scripts/smoke.sh' >&2
  exit 1
fi

echo "[smoke] ok"
