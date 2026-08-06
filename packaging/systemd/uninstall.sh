#!/usr/bin/env bash
#
# Remove the Carino PACS systemd service.
#
#   sudo packaging/systemd/uninstall.sh                 # remove the software
#   sudo packaging/systemd/uninstall.sh --purge-data    # and the patient data
#
# Without --purge-data this leaves /var/lib/carino-pacs and the carino-pacs
# account completely alone. That is not caution for its own sake: that directory
# holds received studies, print captures, HL7 orders and the log files that
# evidence what was received and forwarded. Deleting it can be a records
# violation, and an uninstall script is the wrong place to make that call. The
# account stays too, so the files keep a resolvable owner instead of turning into
# an orphaned uid that a future user could inherit.
#
set -euo pipefail

APP_USER=carino-pacs
APP_DIR=/opt/carino-pacs
DATA_DIR=/var/lib/carino-pacs
UNIT=carino-pacs.service

PURGE=no
[ "${1:-}" = "--purge-data" ] && PURGE=yes
[ -n "${1:-}" ] && [ "$PURGE" = no ] && { echo "unknown option: $1" >&2; exit 2; }

say() { printf '\n== %s\n' "$*"; }
[ "$(id -u)" -eq 0 ] || { echo "run this with sudo" >&2; exit 1; }

say "Stopping the service"
# Stop before removing anything, so the SIGINT shutdown path gets to close the
# listeners and flush in-flight work rather than being cut off mid-store.
systemctl disable --now "$UNIT" 2>/dev/null || true
systemctl reset-failed "$UNIT" 2>/dev/null || true

say "Removing unit and helper files"
rm -f "/etc/systemd/system/$UNIT"
rm -f /usr/lib/tmpfiles.d/carino-pacs.conf
rm -f /usr/lib/sysusers.d/carino-pacs.conf
# Drop-ins an admin added with `systemctl edit carino-pacs`.
rm -rf "/etc/systemd/system/$UNIT.d"
systemctl daemon-reload

say "Removing program files"
rm -rf "$APP_DIR"

if [ "$PURGE" = yes ]; then
    say "Purging data"
    echo "This deletes $DATA_DIR, including every received study, print capture,"
    echo "HL7 order and log file under it. There is no undo and no backup."
    du -sh "$DATA_DIR" 2>/dev/null || true
    printf 'Type the word DELETE to confirm: '
    read -r answer
    if [ "$answer" = "DELETE" ]; then
        rm -rf "$DATA_DIR"
        userdel "$APP_USER" 2>/dev/null || true
        groupdel "$APP_USER" 2>/dev/null || true
        echo "Removed $DATA_DIR and the $APP_USER account."
    else
        echo "Not confirmed — $DATA_DIR and the $APP_USER account were left in place."
    fi
else
    cat <<EOF

Service removed. Left in place on purpose:
  $DATA_DIR   patient data, logs, and config.json
  $APP_USER user account, so those files keep a valid owner

Archive the data somewhere first, then remove both with:
  sudo $0 --purge-data
EOF
fi
