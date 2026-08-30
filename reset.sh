#!/usr/bin/env bash
# Reset Carino DICOM to a clean slate for testing: delete ALL runtime config/data
# and local build artifacts. Source files are left untouched. Pass -y to skip
# the confirmation prompt.
set -euo pipefail
cd "$(dirname "$0")"

DATA="$HOME/CarinoDICOM"
LEGACY_DATA="$HOME/CarinoPACS"            # an install from before the rename; config.py still uses it
targets=(
  "$DATA"                                 # config.json + received/outgoing/sent/logs + .carinopacs_state.json
  "$LEGACY_DATA"
  ".venv"                                 # Python virtualenv
  "build"                                 # PyInstaller workpath (repo root)
  "desktop/node_modules"
  "desktop/dist"                          # built installers
  "desktop/engine"                        # frozen engine
  "pacs/__pycache__" "packaging/__pycache__"
)

# Stray Electron userData — both generations of the name, in every spelling
# electron-builder derives from desktop/package.json. Under two roots because
# Electron puts it in ~/.config on Linux and ~/Library/Application Support on
# macOS, and this repo is developed on the Mac: a sweep that misses
# location.json leaves the desktop app coming back up on its previously chosen
# data folder with no first-run prompt, which is the exact state these entries
# exist to clear and the one you need cleared to test the ~/CarinoDICOM
# fallback through the desktop path. A root that does not exist costs nothing.
for name in "Carino DICOM" "Carino-DICOM" "carino-dicom-desktop" \
            "Carino PACS" "Carino-PACS" "carino-pacs-desktop"; do
  targets+=("$HOME/.config/$name" "$HOME/Library/Application Support/$name")
done

echo "This will DELETE (source is NOT touched):"
found=0
for t in "${targets[@]}"; do [ -e "$t" ] && { echo "  - $t"; found=1; }; done
[ "$found" = 0 ] && { echo "  (nothing found — already clean)"; }

if [ "${1:-}" != "-y" ] && [ "${1:-}" != "--yes" ]; then
  read -r -p "Proceed? [y/N] " ans
  case "$ans" in y|Y) ;; *) echo "aborted"; exit 1;; esac
fi

for t in "${targets[@]}"; do rm -rf "$t"; done

cat <<'EOF'

Clean slate. Rebuild from zero:

  Headless / CLI:
    ./setup.sh                 # recreate .venv + install deps
    ./run.sh serve             # dashboard at http://127.0.0.1:8042

  Desktop app (dev):
    cd desktop && npm install && npm start

  Standalone installer:
    ./.venv/bin/python -m PyInstaller packaging/pacs-engine.spec --distpath desktop/engine --workpath build/pyi
    cd desktop && npm run dist

Tip: in the dashboard, hard-refresh (Ctrl+Shift+R) to drop cached JS/CSS.
EOF
