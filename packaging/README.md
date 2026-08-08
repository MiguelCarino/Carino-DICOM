# Packaging Carino PACS

How to run Carino PACS as a background service — the little box in the corner of
the imaging department that receives studies and forwards them, and comes back
on its own after a power cut.

Carino PACS is AGPL-3.0-or-later. It contains no telemetry of any kind: nothing
in this directory, and nothing it installs, phones home, checks for updates, or
reports usage. If you deploy it, the only machine that learns anything about
your patients is yours. Because the dashboard is served over the network, the
AGPL's source requirement applies to the people who use it — keep the `LICENSE`
file and a pointer to the source with any modified deployment.

## What is in this directory

| Path | Purpose |
| --- | --- |
| `systemd/` | Run it as a Linux system service, from source. This document's main subject. |
| `podman/` | Run it as a rootless container under systemd, via Quadlet. |
| `engine_entry.py` | PyInstaller entry point for the frozen `pacs-engine` binary. |
| `pacs-engine.spec` | PyInstaller spec the Electron desktop app builds against. |

The desktop tray app and the OS installers are a different deployment shape: a
clinician's workstation, started by a person who is sitting at it. Everything
below is for the other case — a machine with no one logged in.

---

## Linux (systemd)

### Install

```
git clone https://github.com/MiguelCarino/Carino-PACS.git
cd Carino-PACS
sudo packaging/systemd/install.sh
```

The script creates the `carino-pacs` system user, provisions
`/var/lib/carino-pacs`, copies the code to `/opt/carino-pacs`, builds a
virtualenv there, scaffolds `config.json`, and installs the unit.

**It does not start the service.** Starting a PACS opens listeners that accept
patient data from any modality that can reach them, so that stays a decision you
make after reading the config. The script prints the exact next steps.

Re-running the script upgrades the code in place and never touches an existing
`config.json`.

### Where things live

| Path | Contents | Owner |
| --- | --- | --- |
| `/opt/carino-pacs` | code + virtualenv | `root`, read-only to the service |
| `/var/lib/carino-pacs` | `config.json`, `received/`, `outgoing/`, `sent/`, `pending/`, `logs/`, `index.db` | `carino-pacs`, mode 0750 |
| `/etc/systemd/system/carino-pacs.service` | the unit | `root` |

`config.json` lives **with the data, not in `/etc`**. That is not an oversight.
Carino PACS resolves every relative path in the config (`"./received"`,
`"./logs"`, `"./index.db"`) against the directory the config file itself sits
in. A config in `/etc` would scatter patient studies through `/etc`, and `/etc`
has to stay read-only for the sandboxing to mean anything.

For the same reason, **do not symlink `/etc/carino-pacs/config.json` to it**.
The path resolution uses the path as given, not the resolved target, so pointing
the service at a symlink would send the data directories wherever the symlink
lives.

### Turn the services on

Everything ships disabled. Edit the config and set `"enabled": true` under the
sections this box should run:

```
sudoedit /var/lib/carino-pacs/config.json
```

| Section | Service | Default port |
| --- | --- | --- |
| `scp` | Storage SCP (C-STORE / C-ECHO) | 11112 |
| `print` | Print SCP (virtual film printer) | 11113 |
| `mwl` | Modality Worklist SCP (C-FIND) | 11114 |
| `qr` | Query/Retrieve SCP (C-FIND / C-MOVE / C-GET) | 11115 |
| `ris` | HL7 MLLP order listener | 2575 |
| `scu` | Folder watcher / auto-forward | — outbound only |
| `web` | Dashboard and DICOMweb (`/dicom-web`) | 8042 |

Also set `"setup_completed"` to any non-empty string, or the dashboard opens its
first-run service chooser instead of the normal view.

Then check it without starting anything:

```
sudo -u carino-pacs /opt/carino-pacs/venv/bin/python \
     /opt/carino-pacs/packaging/systemd/preflight.py /var/lib/carino-pacs/config.json
```

And start it:

```
sudo systemctl enable --now carino-pacs.service
systemctl status carino-pacs.service
```

### Reaching the dashboard, safely

The default is `web.host = 127.0.0.1` with an empty `web.auth_token`, and on a
headless box the right way to use that default is a tunnel from your laptop:

```
ssh -N -L 8042:127.0.0.1:8042 you@pacs-box
```

then open `http://127.0.0.1:8042/`. No token needed, nothing exposed.

If the dashboard genuinely has to listen on the network, **it needs a token, and
the service refuses to start without one**:

```
python3 -c "import secrets; print(secrets.token_urlsafe(32))"
```

Put that in `web.auth_token` and set `web.host` to the interface address. This is
enforced by `preflight.py` as `ExecStartPre=`, which fails the start with exit 78
and an explanation in the journal.

The reason it is a refusal rather than a warning: an empty `web.auth_token` does
not mean "log in with an empty token", it means the API asks for nothing at all.
`GET /api/status` — which is normally credentialled — then answers anyone, and
it returns the last received patient's name and ID, the last HL7 order's
accession, every storage path, and every destination's host, port and AE title.
On a routable address with no token, that is a PHI leak to anything that can
reach the port, and the rest of the API can change the configuration besides.

Note that the unit deliberately passes no `--host` or `--port` to `serve`. Those
flags override the config without validation, which would walk straight around
the check above. Bind address and port belong in `config.json` so one file is
the complete answer to what this machine exposes.

### Firewall and ports

Every port is above 1024, so the service needs **no privileged-port capability**
— `CapabilityBoundingSet=` is empty in the unit. This was confirmed, not
assumed: with an empty bounding set, binding 19112 and 19113 succeeded and
binding 104 failed with `EACCES`.

If you need the well-known DICOM port 104, redirect it on the host rather than
giving the service a capability or running it as root:

```
sudo firewall-cmd --permanent --add-forward-port=port=104:proto=tcp:toport=11112
sudo firewall-cmd --reload
```

Open only what you enabled, and prefer scoping to the subnet the modalities are
on. DICOM has no authentication worth the name — `scp.allowed_aets` empty means
*accept any calling AE title* — so the network boundary is doing real work here.
Fill in `allowed_aets` as well; it is defence in depth, not a substitute.

### Logs

Two streams, on purpose, with no overlap:

```
journalctl -u carino-pacs -f          # lifecycle: start/stop, bind failures, tracebacks, HTTP access
ls /var/lib/carino-pacs/logs/         # the record: what was received, from whom, what was forwarded
```

The application writes its own dated files and never echoes them to stdout, so
nothing is stored twice. Keep both: the journal tells you whether the process is
healthy, the dated files are the operational and audit trail. Only the journal
rotates by systemd's rules; the dated files are yours to retain or archive
according to your own policy, and nothing deletes them automatically.

You will see Flask's "This is a development server" warning at every start. That
is expected — `pacs serve` runs the Werkzeug server, and `create_app()` takes a
live server object so it cannot be hosted under `gunicorn pacs.web:app`. Keep
the dashboard on loopback or behind a reverse proxy accordingly.

### Stopping, restarting, and why there is no `KillSignal=`

The unit stops the service with plain **SIGTERM**, systemd's default, and sets
no `KillSignal=` at all. Earlier versions of this unit set `KillSignal=SIGINT`,
and if you are carrying a local copy of one, drop that line.

The reason it was there is gone. `pacs serve` used to install no SIGTERM
handler, so the kernel's default disposition killed it where it stood:
`PacsServer.shutdown()` never ran, the DICOM listeners were never closed, and
in-flight work was never flushed. `pacs.__main__._install_sigterm()` now turns
SIGTERM into the same `KeyboardInterrupt` that Ctrl+C raises, which unwinds
through `app.run()` into `cmd_serve`'s `finally: server.shutdown()`.

Re-measured against a running engine with the receiver enabled — six runs per
signal, timed from the kill to process exit, reading the data directory's own
log:

| signal sent | stop time | exit status | last line in the app log |
| --- | --- | --- | --- |
| `SIGTERM` | 0.51 – 0.78 s | 0 | `scp Receiver stopped` |
| `SIGINT` | 0.49 – 0.71 s | 0 | `scp Receiver stopped` |

They are now the same stop. The default is preferred precisely because it is the
default: `systemctl stop`, `docker stop`, a supervisor's kill and a container
runtime's shutdown then all take one path, rather than systemd being the only
caller on a second one. If you are ever measuring this yourself, note that a
background job launched from a non-interactive shell script inherits SIGINT as
`SIG_IGN`, and CPython leaves an already-ignored SIGINT alone — a harness
without `set -m` will report that SIGINT does nothing, which is a fact about the
harness and not about this program.

The restart policy is `Restart=always`, `RestartSec=15`, with the start rate
limiter disabled (`StartLimitIntervalSec=0` in `[Unit]`). A store-and-forward
gateway that is down is not obviously down — modalities get connection refused
and staff blame the network — so it must never give up and park itself in
`failed` where only someone looking would notice.

The trade-off is honest: a genuinely broken `config.json` retries every 15
seconds forever, logging one preflight line per attempt. That is the behaviour
an appliance should have — fix the config and it recovers by itself, with no
`systemctl start`. `RestartPreventExitStatus=` is deliberately not used to break
that loop, because it was measured to have no effect on `ExecStartPre=`
failures, which is exactly where a config error surfaces.

### Sandboxing

The unit is heavily sandboxed and every directive carries a comment explaining
why it is there. `systemd-analyze security` rates it **1.5 (OK)**. Two findings
worth repeating here because they are counter-intuitive:

- **`RestrictAddressFamilies=` must include `AF_NETLINK`.** The obvious set is
  `AF_INET AF_INET6 AF_UNIX`. That set breaks the dashboard's "which IP am I on"
  panel: it comes from `psutil.net_if_addrs()`, which calls `getifaddrs(3)`,
  which opens a netlink socket, and fails with `EAFNOSUPPORT`. The application
  catches the error and carries on, so the only symptom is a headless box
  quietly refusing to tell you the address to point the modalities at.
- **Do not add `SystemCallFilter=~@privileged @resources`.** It is the natural
  next step and `systemd-analyze security` asks for it. It kills the process
  with SIGSYS (`code=dumped, status=31/SYS`) before it finishes importing
  pydicom, pynetdicom, flask, pillow and psutil.

`MemoryDenyWriteExecute=yes` is safe here and was checked rather than assumed —
CPython has no JIT, and the whole dependency stack imports, renders pillow's
built-in font and writes sqlite databases with it enabled. Remove it if you ever
add a dependency that generates machine code at runtime; the failure is hard,
not slow.

Two further hardening options are left off by default and can be added with
`sudo systemctl edit carino-pacs`:

```
[Service]
# Restrict traffic to loopback and the modality subnet. Set this to the networks
# your modalities and your forwarding destinations are actually on, or outbound
# C-STORE will stop working.
IPAddressDeny=any
IPAddressAllow=localhost 10.0.5.0/24
```

```
[Service]
# Extra isolation from other users on the box. Verified against this dependency
# stack in a user-scope test only, not in system scope on a production host —
# try it on a machine you can afford to have fail to start.
PrivateUsers=yes
```

### SELinux

`install.sh` runs `restorecon` if it is available. On Fedora/RHEL the service
runs as `unconfined_service_t`, which works. If you move the data directory off
`/var/lib`, relabel it or SELinux will deny the writes while the permissions
look correct:

```
sudo semanage fcontext -a -t var_lib_t "/srv/pacs(/.*)?"
sudo restorecon -Rv /srv/pacs
```

### Upgrade

```
cd Carino-PACS && git pull
sudo packaging/systemd/install.sh
sudo systemctl restart carino-pacs
```

The config and the data are untouched. Back up `/var/lib/carino-pacs` first if
the release notes mention a config or index change.

### Uninstall

```
sudo /opt/carino-pacs/packaging/systemd/uninstall.sh
```

Stops and disables the service, removes the unit, the drop-ins, the helper files
and `/opt/carino-pacs`. It leaves `/var/lib/carino-pacs` and the `carino-pacs`
account alone — that directory holds studies, print captures, HL7 orders and the
logs that evidence what was received and forwarded, and deleting it can be a
records violation. The account stays so the files keep a resolvable owner rather
than becoming an orphaned uid a future user could inherit.

Archive the data, then:

```
sudo /opt/carino-pacs/packaging/systemd/uninstall.sh --purge-data
```

which shows you the directory size and requires you to type `DELETE`.

### Creating the user by hand

If you are packaging for a distribution or cannot run the script, the account
and directories are declared in `systemd/carino-pacs.sysusers.conf` and
`systemd/carino-pacs.tmpfiles.conf`. Install them to `/usr/lib/sysusers.d/` and
`/usr/lib/tmpfiles.d/` and apply:

```
sudo systemd-sysusers /usr/lib/sysusers.d/carino-pacs.conf
sudo systemd-tmpfiles --create /usr/lib/tmpfiles.d/carino-pacs.conf
```

Without sysusers.d, the equivalent is:

```
sudo useradd --system --home-dir /var/lib/carino-pacs --no-create-home \
     --shell /usr/sbin/nologin --comment "Carino PACS DICOM gateway" carino-pacs
sudo install -d -o carino-pacs -g carino-pacs -m 0750 /var/lib/carino-pacs
for d in received outgoing sent pending logs; do
  sudo install -d -o carino-pacs -g carino-pacs -m 0700 "/var/lib/carino-pacs/$d"
done
```

`--no-create-home` is correct: the tmpfiles step creates the directory with the
mode the service expects. The home directory is set to the data directory so
that Python's `expanduser("~")` resolves somewhere real; the unit passes
`--config` explicitly so it is never actually used for path resolution, but a
system user with a nonexistent home produces confusing failures.

### Troubleshooting

| Symptom | Cause |
| --- | --- |
| `status=78` in the journal | Config problem. The preflight line above it says exactly what. |
| Unit is `active` but a DICOM port is dead | Auto-start is best-effort by design: a listener that cannot bind logs `WARNING: … did not start` to the journal and the dashboard still comes up, because the dashboard is how you fix it. Check `journalctl -u carino-pacs \| grep WARNING`. |
| Dashboard "Save" returns 400 | The directory holding `config.json` is not writable by `carino-pacs`. It needs write access to the directory, not just the file — `Config.save()` writes a fresh `config.json.tmp.<pid>.<random>` beside it and renames it into place, and the watcher keeps `.carinopacs_state.json` there. |
| The "Reveal" button does nothing | It shells out to `xdg-open`. There is no desktop on a server; the error is caught and ignored. Not a fault. |
| Restart loop every 15 s | A config error. Read the preflight message, fix `config.json`; it will pick itself up without further action. |

---

---

## Linux (Podman, rootless)

Podman is the default container engine on Fedora, RHEL, CentOS and Rocky — the
usual choice for an appliance box — and it is a different deployment shape from
the two above rather than a variation on either. The image is the same one
`docker-compose.yml` builds; what changes is who owns the process and how the
uids line up.

### Why not just `podman compose`

You can, and `docker-compose.yml` is written to work under it — the `:z` volume
label and the service-level healthcheck are both there for Podman's sake. But
`podman compose` is a shim that shells out to `podman-compose` or to Docker's own
`docker-compose`, and neither ships with Podman. On a stock Fedora install the
command fails with *"looking up compose provider failed"* before it reads a line
of the file. Installing one is fine if you already think in compose; if you are
standing up an appliance, Quadlet is fewer moving parts and a better fit.

### Quadlet

Quadlet is Podman's native systemd integration: you write a `.container` file,
systemd generates a real unit from it, and the container is managed like any
other service. It replaces both `docker compose up -d` and the deprecated
`podman generate systemd`.

```bash
mkdir -p ~/CarinoPACS
podman build --format docker -t carino-pacs:local .
install -Dm644 packaging/podman/carino-pacs.container \
        ~/.config/containers/systemd/carino-pacs.container
systemctl --user daemon-reload
systemctl --user start carino-pacs
journalctl --user -u carino-pacs -f      # the access token prints on first boot
```

Then open <http://127.0.0.1:8042/> and paste the token when the dashboard asks.

`packaging/podman/carino-pacs.container` is written to be read, the same way
`docker-compose.yml` is. It carries the same conservative defaults — loopback
only, all capabilities dropped, read-only root filesystem, the Storage SCP as
the one enrolled listener.

### Three things that are genuinely different from Docker

**The uid mapping is simpler, not harder.** Rootless Podman maps container uids
into a subordinate range on the host, so a data directory owned by your account
looks unwritable from inside no matter how the ownership reads — the classic
first-run failure, and the reason `docker-compose.yml` carries a commented
`userns_mode: keep-id`. The unit uses `keep-id:uid=1000,gid=1000`, which maps
*your* account onto the image's baked `pacs` account whatever uid you happen to
be. The data directory stays yours on the host and the image needs no `PUID` /
`PGID` build arguments at all.

**`systemctl start` waits for the DICOM port.** The unit sets `Notify=healthy`,
so systemd holds it in *activating* until the healthcheck passes — which asks
the dashboard for `/api/status` and checks that the Storage SCP is really
listening. `systemctl --user start carino-pacs` returns after about thirty
seconds, and when it returns the gateway is genuinely accepting associations.
Anything ordered `After=` it waits for that too. Compose has no equivalent:
`docker compose up -d` returns when the process has begun to exist.

**Rootless cannot publish below port 1024.** Classic DICOM port 104 is a host-side
publish either way — the container's own ports stay above 1024 so it needs no
privileges — but rootless Podman refuses the *host* side too until the threshold
is lowered for the whole machine:

```bash
sudo sysctl -w net.ipv4.ip_unprivileged_port_start=104
```

That is a machine-wide change to satisfy one listener. Weigh it against telling
the modality which port to use, which is usually a field in its configuration.

### Surviving a logout

A rootless user service stops when your last session ends, which on a box nobody
logs into means it never starts at all:

```bash
loginctl enable-linger $USER
systemctl --user enable carino-pacs
```

For a machine-wide service instead, put the same file in `/etc/containers/systemd/`
and drop `--user`. Read the `UserNS=` comment in the unit first: the uid mapping
is a rootless mechanism and does nothing in system scope, where the data
directory has to be owned by uid 1000 on the host.

### Verified

Against Podman 5.8.4 on Fedora, rootless, with the unit exactly as it ships:
the dashboard, the API, the bundled editor and its WebAssembly decoders all
answer; `systemctl start` blocks for 31s and returns healthy; a real C-ECHO from
`pynetdicom` is accepted on 11112; `systemctl stop` is graceful in under a
second; and `~/CarinoPACS` comes out owned by the invoking user.

## macOS (launchd)

There is no launchd plist in this repository yet. The shape it needs, and the
one thing that is not obvious:

Run it as a `LaunchDaemon` (`/Library/LaunchDaemons/systems.carino.pacs.plist`,
owned `root:wheel`, mode 0644) rather than a LaunchAgent, so it runs without
anyone logged in. Set `UserName` to a dedicated service account, `RunAtLoad` and
`KeepAlive` to true, `WorkingDirectory` to the install path, and
`ProgramArguments` to the interpreter, `-m`, `pacs`, `--config`, the config path,
and `serve`. Load with `sudo launchctl bootstrap system <plist>`.

**launchd has no equivalent of `KillSignal=`** — it sends SIGTERM and that is
all it sends. That used to mean macOS needed a wrapper script to convert the
signal, because `pacs serve` did not handle SIGTERM. It no longer does: the
handler is inside the program (see the table above), so point
`ProgramArguments` straight at the interpreter and drop any signal-converting
wrapper you were carrying. The same applies to any other supervisor without a
configurable stop signal.

The data directory should be somewhere like `/Library/Application Support/CarinoPACS`,
owned by the service account, with the same rule as on Linux: `config.json` goes
inside it, because the relative paths resolve against it.

## Windows (service)

There is no Windows service wrapper in this repository. Python cannot answer the
Service Control Manager without `pywin32`, so `sc.exe create` pointed straight
at `python.exe` produces a service that Windows reports as failing to start.

The practical options, in order of preference:

1. **NSSM.** Install `python.exe` with the arguments `-m pacs --config
   C:\ProgramData\CarinoPACS\config.json serve`, set the startup directory to
   the install path, and run it as a dedicated low-privilege account rather than
   LocalSystem. NSSM's default console stop method sends Ctrl+C, which Python
   raises as `KeyboardInterrupt` — the same unwind the SIGTERM handler produces
   on Unix — so the shutdown path runs. Confirm `AppStopMethodConsole` is
   enabled rather than letting it go straight to terminating the process:
   Windows has no SIGTERM to fall back on, so this is the one platform where
   the stop method genuinely still has to be chosen by hand.
2. **Task Scheduler**, triggered "At startup", "Run whether user is logged on or
   not". Simpler, but you lose automatic restart-on-crash and stop semantics.
3. **`pywin32` service wrapper**, if you want a real service that handles
   `SERVICE_CONTROL_STOP` properly. That is a code change, not packaging, and
   nothing here implements it.

Put the data directory under `C:\ProgramData\CarinoPACS`, not in a user profile,
and restrict its ACL to the service account. The same rules apply: `config.json`
lives inside the data directory, and a dashboard on anything other than
`127.0.0.1` needs `web.auth_token` set or the app will refuse it.
