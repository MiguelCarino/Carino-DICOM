#!/usr/bin/env bash
#
# Install Carino PACS as a systemd system service.
#
#   sudo packaging/systemd/install.sh
#
# Idempotent: safe to re-run to upgrade the code in place. It does NOT enable or
# start the service, and that is on purpose. Starting a PACS opens network
# listeners that accept patient data from any modality that can reach them, and
# the shipped config binds the dashboard to loopback with no token. You review
# config.json first, then start it yourself. The last thing this script prints is
# how.
#
# Carino PACS is free software under the AGPL-3.0-or-later. It contains no
# telemetry: nothing here, and nothing it installs, reports anything anywhere.
#
set -euo pipefail

APP_USER=carino-pacs
APP_DIR=/opt/carino-pacs
DATA_DIR=/var/lib/carino-pacs
UNIT=carino-pacs.service

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

say()  { printf '\n== %s\n' "$*"; }
note() { printf '   %s\n' "$*"; }
die()  { printf '\nerror: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run this with sudo — it creates a system user and writes to /opt and /etc"
command -v systemctl >/dev/null || die "systemd not found. See packaging/README.md for launchd (macOS) and Windows service options."
[ -f "$REPO/pacs/__main__.py" ] || die "cannot find the pacs package next to this script (expected $REPO/pacs)"

PY=$(command -v python3) || die "python3 not found"
"$PY" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)' \
  || die "python3 is $("$PY" -V 2>&1), this needs 3.9 or newer"

# ---------------------------------------------------------------- service user
say "Service account"
if id "$APP_USER" >/dev/null 2>&1; then
    note "$APP_USER already exists"
else
    if command -v systemd-sysusers >/dev/null; then
        install -m 0644 "$HERE/carino-pacs.sysusers.conf" /usr/lib/sysusers.d/carino-pacs.conf
        systemd-sysusers /usr/lib/sysusers.d/carino-pacs.conf
        note "created $APP_USER via systemd-sysusers"
    else
        # Distros without sysusers.d. Same account, spelled by hand:
        # --system         no login-range uid, no aging
        # --home-dir       the data directory, so expanduser("~") lands somewhere real
        # --no-create-home the tmpfiles step below owns creating it, with the right mode
        # --shell nologin  the account owns patient data and never needs a shell
        useradd --system --home-dir "$DATA_DIR" --no-create-home \
                --shell /usr/sbin/nologin \
                --comment "Carino PACS DICOM gateway" "$APP_USER"
        note "created $APP_USER via useradd"
    fi
fi

# ------------------------------------------------------------------- data dirs
say "Data directory"
if command -v systemd-tmpfiles >/dev/null; then
    install -m 0644 "$HERE/carino-pacs.tmpfiles.conf" /usr/lib/tmpfiles.d/carino-pacs.conf
    systemd-tmpfiles --create /usr/lib/tmpfiles.d/carino-pacs.conf
else
    install -d -o "$APP_USER" -g "$APP_USER" -m 0750 "$DATA_DIR"
    for d in received outgoing sent pending logs; do
        install -d -o "$APP_USER" -g "$APP_USER" -m 0700 "$DATA_DIR/$d"
    done
fi
note "$DATA_DIR ready"

# --------------------------------------------------------------- program files
# Copied file by file rather than `cp -r .` on purpose. A developer checkout has
# a local config.json holding this machine's AE titles and destinations, and
# received/ outgoing/ sent/ holding real studies. None of that belongs in /opt.
say "Program files -> $APP_DIR"
install -d -m 0755 "$APP_DIR"
rm -rf "$APP_DIR/pacs" "$APP_DIR/packaging"
cp -r "$REPO/pacs" "$APP_DIR/pacs"
cp -r "$REPO/packaging" "$APP_DIR/packaging"
find "$APP_DIR" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true
for f in config.example.json requirements.txt LICENSE; do
    if [ -f "$REPO/$f" ]; then
        install -m 0644 "$REPO/$f" "$APP_DIR/$f"
    else
        note "warning: $f not found in the checkout"
    fi
done
# LICENSE is copied because it has to be: AGPL-3.0-or-later travels with the
# software, and the dashboard is a network service, so its users are entitled to
# the source of whatever version you are actually running.
# config.example.json has to sit in the PARENT of the pacs package: `pacs init`
# looks for it at dirname(dirname(pacs/__main__.py)), and silently scaffolds a
# bare default config if it is missing.
chown -R root:root "$APP_DIR"
chmod 0755 "$APP_DIR/packaging/systemd/preflight.py"
note "installed (owned by root, read-only to the service)"

# ---------------------------------------------------------------- python venv
say "Python environment"
if [ ! -x "$APP_DIR/venv/bin/python" ]; then
    "$PY" -m venv "$APP_DIR/venv" || die "could not create a venv — install python3-venv"
fi
"$APP_DIR/venv/bin/python" -m pip install --quiet --upgrade pip
"$APP_DIR/venv/bin/python" -m pip install --quiet -r "$APP_DIR/requirements.txt"
note "$("$APP_DIR/venv/bin/python" -V) with $(grep -c . "$APP_DIR/requirements.txt") pinned dependencies"

# --------------------------------------------------------------------- config
say "Configuration"
if [ -f "$DATA_DIR/config.json" ]; then
    note "$DATA_DIR/config.json exists — left untouched"
else
    # Run init as the service user so every file it creates is owned correctly
    # from the start, rather than being chowned afterwards and hoping.
    if command -v runuser >/dev/null; then
        runuser -u "$APP_USER" -- "$APP_DIR/venv/bin/python" -m pacs \
            --config "$DATA_DIR/config.json" init
    else
        su -s /bin/sh -c \
            "'$APP_DIR/venv/bin/python' -m pacs --config '$DATA_DIR/config.json' init" \
            "$APP_USER"
    fi
fi
chmod 0640 "$DATA_DIR/config.json"

# ----------------------------------------------------------------------- unit
say "Unit"
install -m 0644 "$HERE/$UNIT" "/etc/systemd/system/$UNIT"
systemctl daemon-reload
note "/etc/systemd/system/$UNIT"

if command -v restorecon >/dev/null; then
    restorecon -R "$APP_DIR" "$DATA_DIR" "/etc/systemd/system/$UNIT" >/dev/null 2>&1 || true
    note "SELinux contexts restored"
fi

# --------------------------------------------------------------- what's next
cat <<EOF

Installed, not started.

1. Edit the config and turn on the services this box should run:

     sudoedit $DATA_DIR/config.json

   Set "enabled": true under scp / print / mwl / qr / ris as needed, and set
   "setup_completed" to any non-empty string to skip the dashboard's chooser.

2. Decide how the dashboard is reached. It defaults to 127.0.0.1 with no token,
   which is the safe setting: reach it over an SSH tunnel with

     ssh -N -L 8042:127.0.0.1:8042 $(id -un)@$(hostname -s 2>/dev/null || echo this-host)

   If it must listen on the network instead, set web.host to that address AND
   generate a token, or the service will refuse to start:

     $PY -c "import secrets; print(secrets.token_urlsafe(32))"

3. Check the config without starting anything:

     sudo -u $APP_USER $APP_DIR/venv/bin/python $APP_DIR/packaging/systemd/preflight.py $DATA_DIR/config.json

4. Start it, and have it come back after a reboot:

     sudo systemctl enable --now $UNIT
     systemctl status $UNIT
     journalctl -u $UNIT -f

Uninstall: sudo $APP_DIR/packaging/systemd/uninstall.sh
Patient data in $DATA_DIR is never removed unless you ask for it explicitly.
EOF
