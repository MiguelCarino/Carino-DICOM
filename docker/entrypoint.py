"""Container entry point for Carino PACS.

Three jobs, in this order:

  1. Make SIGTERM behave like Ctrl+C, so `docker stop` shuts the DICOM
     listeners down instead of being SIGKILLed after the grace period.
  2. Prepare /data/config.json on first boot so `docker compose up` works with
     no config file, and make sure the dashboard is never reachable from the
     network without an auth token.
  3. Hand over to the normal CLI (`python -m pacs ...`) in this same process.

Nothing here phones home. Carino PACS has no telemetry, no update check and no
crash reporting, and this file must not become the place someone adds one.

Environment (all optional):

  PACS_CONFIG            config path                     default /data/config.json
  PACS_AUTH_TOKEN        dashboard/API token             default: generated on first boot
  PACS_AUTH_TOKEN_FILE   file to read the token from     (Docker/Podman secret; preferred)
  PACS_WEB_HOST          dashboard bind address          default 0.0.0.0 on first boot
  PACS_WEB_PORT          dashboard port                  default from the config (8042)
  PACS_SERVICES          first-boot listener enrolment   default "scp"; "" leaves all off
"""

from __future__ import annotations

import json
import os
import secrets
import signal
import sys

sys.path.insert(0, "/app")

from pacs.config import auth_token_of, is_loopback_host, validate, web_host_of  # noqa: E402
from pacs.__main__ import build_parser, main  # noqa: E402

DEFAULT_CONFIG = "/data/config.json"

# Env name -> config section. "print" is the JSON section name for the virtual
# film printer; qr and dicomweb are accepted so a config that has those sections
# can be switched on the same way once their listeners land.
SERVICE_SECTIONS = {
    "scp": "scp",
    "storage": "scp",
    "scu": "scu",
    "forward": "scu",
    "print": "print",
    "mwl": "mwl",
    "worklist": "mwl",
    "qr": "qr",
    "ris": "ris",
    "hl7": "ris",
    "dicomweb": "dicomweb",
}


def banner(lines: list[str], stream=sys.stdout) -> None:
    """A block nobody scrolling `docker logs` can miss."""
    width = max(len(x) for x in lines) + 4
    rule = "=" * width
    print("", file=stream)
    print(rule, file=stream)
    for line in lines:
        print(f"  {line}", file=stream)
    print(rule, file=stream)
    print("", file=stream)


def die(lines: list[str]):
    banner(lines, stream=sys.stderr)
    raise SystemExit(1)


def subcommands() -> set:
    """The pacs subcommands, asked of the real parser so a new one (`qr`, say)
    needs no change here. Falls back to the known list if argparse internals
    move under us."""
    import argparse

    try:
        for action in build_parser()._actions:
            if isinstance(action, argparse._SubParsersAction):
                return set(action.choices)
    except Exception:
        pass
    return {"serve", "receive", "send", "print", "ris", "mwl", "qr", "echo", "init"}


def read_token_from_env() -> str:
    """PACS_AUTH_TOKEN_FILE wins over PACS_AUTH_TOKEN.

    The _FILE form exists because an env var is visible in `docker inspect`,
    in `docker compose config` and to every process in the container, while a
    secret mounted at a path is not. Both are supported; the file is the one to
    reach for on anything shared.
    """
    path = os.environ.get("PACS_AUTH_TOKEN_FILE", "").strip()
    if path:
        try:
            with open(path, "r", encoding="utf-8") as fh:
                token = fh.read().strip()
        except OSError as exc:
            die([
                "PACS_AUTH_TOKEN_FILE is set but could not be read.",
                f"  path:  {path}",
                f"  error: {exc}",
                "Check the secret is mounted and readable by this container's user.",
            ])
        if not token:
            die([
                "PACS_AUTH_TOKEN_FILE points at an empty file.",
                f"  path: {path}",
                "An empty token would leave the dashboard API open to the network.",
            ])
        return token
    return os.environ.get("PACS_AUTH_TOKEN", "").strip()


def require_writable(directory: str) -> None:
    """A data volume owned by someone else is the most common first-run
    failure, and the raw EACCES traceback it produces sends people looking in
    the wrong place. Check it first and say what to do about it.

    It has to be the directory, not just the files: the app writes config.json
    through a .tmp-and-rename, and the folder watcher keeps its state file
    beside the config, so read-write on an existing config.json is not enough.
    """
    try:
        os.makedirs(directory or "/", exist_ok=True)
    except OSError as exc:
        die([f"Cannot create the data directory {directory}: {exc}"])
    if os.access(directory, os.W_OK | os.X_OK):
        return
    try:
        st = os.stat(directory)
        owner = f"uid {st.st_uid}, gid {st.st_gid}, mode {oct(st.st_mode & 0o777)}"
    except OSError:
        owner = "unknown"
    # When the uid/gid already match, ownership is not the problem and saying
    # "chown" sends the operator to run a no-op. On SELinux hosts the usual
    # cause is a bind mount without :z, which fails while looking correct.
    same_owner = False
    try:
        same_owner = (st.st_uid == os.getuid() and st.st_gid == os.getgid())
    except NameError:
        pass

    hints = []
    if same_owner:
        hints += [
            "Ownership already matches, so this is not a chown problem. On an",
            "SELinux host (Fedora, RHEL, CentOS, Rocky) a bind mount needs to be",
            "relabelled before the container may write to it. In compose:",
            "",
            "    volumes:",
            "      - ./data:/data:z",
            "",
            "or add `:z` to the -v flag if you are running docker/podman directly.",
            "Check with `getenforce`; `Enforcing` means this is almost certainly it.",
            "",
        ]
    else:
        hints += [
            f"    sudo chown -R {os.getuid()}:{os.getgid()} ./data",
            "",
        ]

    die([
        f"The data directory {directory} is not writable by this container.",
        "",
        f"  running as: uid {os.getuid()}, gid {os.getgid()}",
        f"  directory:  {owner}",
        "",
        "Carino PACS stores config.json, received studies, logs and its index",
        "there, so it cannot start read-only. On the host:",
        "",
        *hints,
        "Or set PACS_UID / PACS_GID in .env to your own account and rebuild:",
        "",
        "    echo \"PACS_UID=$(id -u)\" >> .env",
        "    echo \"PACS_GID=$(id -g)\" >> .env",
        "    docker compose up -d --build",
        "",
        "Rootless Podman maps container uids to a different range on the host;",
        "add `--userns=keep-id` (or `userns_mode: keep-id` in compose) so the",
        "container's uid and the host's are the same number.",
    ])


def first_boot_scaffold(cfg_path: str) -> None:
    """Run the app's own `pacs init`, so the container scaffolds exactly what a
    desktop install does — config.example.json plus received/ outgoing/ sent/
    logs/ — instead of a second, drifting copy of that logic here."""
    require_writable(os.path.dirname(cfg_path))
    try:
        rc = main(["--config", cfg_path, "init"])
    except OSError as exc:
        die([f"`pacs init` could not write into {os.path.dirname(cfg_path)}: {exc}",
             "The whole data directory must be writable by this container's uid,",
             "not just the files already in it."])
    if rc != 0:
        die([f"`pacs init` failed with exit code {rc}.", f"  config: {cfg_path}"])


def enrol_services(data: dict, spec: str) -> list[str]:
    """First-boot only: turn on the listeners named in PACS_SERVICES.

    After the first boot the config is the single source of truth — the
    dashboard's setup chooser writes those same flags, and re-applying an env
    var on every restart would silently undo what the operator clicked.
    """
    names = [x.strip().lower() for x in spec.replace(";", ",").split(",") if x.strip()]
    enabled: list[str] = []
    for name in names:
        section = SERVICE_SECTIONS.get(name)
        if section is None:
            die([f"PACS_SERVICES contains an unknown service: {name!r}",
                 "Known values: " + ", ".join(sorted(set(SERVICE_SECTIONS)))])
        if not isinstance(data.get(section), dict):
            continue        # this build has no such section yet; ignore quietly
        data[section]["enabled"] = True
        enabled.append(section)
    if enabled:
        # Without a completion stamp the dashboard opens its setup chooser on
        # every visit, which is noise when the enrolment came from compose.
        data["setup_completed"] = "container-first-boot"
    return enabled


def prepare_config(cfg_path: str) -> None:
    fresh = not os.path.exists(cfg_path)
    if fresh:
        first_boot_scaffold(cfg_path)

    with open(cfg_path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    before = json.dumps(data, sort_keys=True)
    web = data.setdefault("web", {})

    # A container binds inside its own network namespace, so leaving the
    # shipped default of 127.0.0.1 would make the dashboard unreachable even
    # from the host. Only force it on first boot (or when the operator sets the
    # env var), so a later edit in the dashboard sticks.
    env_host = os.environ.get("PACS_WEB_HOST", "").strip()
    if env_host:
        web["host"] = env_host
    elif fresh:
        web["host"] = "0.0.0.0"
    env_port = os.environ.get("PACS_WEB_PORT", "").strip()
    if env_port:
        try:
            web["port"] = int(env_port)
        except ValueError:
            die([f"PACS_WEB_PORT is not a number: {env_port!r}"])

    if fresh:
        enabled = enrol_services(data, os.environ.get("PACS_SERVICES", "scp"))
        if enabled:
            print(f"First boot: enabled {', '.join(enabled)} (PACS_SERVICES)")
        else:
            print("First boot: no listeners enabled — pick them in the dashboard.")

    # ---- the security gate ------------------------------------------------
    # config.validate() refuses a config that binds the dashboard to a
    # network-reachable address with an empty token, because the API exposes
    # patient identifiers and full control with no login of its own. A
    # container binds 0.0.0.0 by definition, so that gate applies to every
    # container by default and the operator has to get past it somehow.
    #
    # Two ways to get past it: generate a token, or refuse to start until the
    # operator sets one. Both are equally safe against the actual threat —
    # neither ever runs an unauthenticated PACS on a network. The tiebreaker is
    # what each does to the operator who is blocked at 2am:
    #
    #   * Refusing turns every first `docker compose up` into a failure, and the
    #     shortest path back to a running container is a short, memorable, typed
    #     token. Weak tokens are the predictable end state.
    #   * Generating gives a 256-bit token nobody chose, costs the operator
    #     nothing, and keeps the secret out of `docker inspect` entirely — it
    #     lives only in the config file on the operator's own volume.
    #
    # So: generate. What we never do is generate quietly — the token is printed
    # in a banner on the boot that creates it, and we still hard-fail below if
    # validate() is unhappy for any other reason.
    #
    # We only generate when the config is actually network-reachable. If someone
    # deliberately keeps web.host on loopback (dashboard reachable only via
    # `docker exec`), the app's own rule says a token is optional, and this
    # should not overrule it.
    env_token = read_token_from_env()
    generated = False
    if env_token:
        web["auth_token"] = env_token
    elif not auth_token_of(web) and not is_loopback_host(web_host_of(web)):
        web["auth_token"] = secrets.token_urlsafe(32)
        generated = True

    try:
        validate(data)
    except ValueError as exc:
        hint = f"Edit {cfg_path} and start the container again."
        if "auth_token" in str(exc):
            hint = (f"Edit {cfg_path}, or set PACS_AUTH_TOKEN_FILE "
                    "(preferred) / PACS_AUTH_TOKEN.")
        die(["Carino PACS refused to start — the configuration is not safe to serve.",
             "", str(exc), "", hint])

    if json.dumps(data, sort_keys=True) != before:
        tmp = cfg_path + ".tmp"
        try:
            # 0600, matching Config.save(): this file carries web.auth_token in
            # plaintext, and /data is a volume the host can hand to anybody.
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            try:
                os.fchmod(fd, 0o600)
            except OSError:
                pass
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(data, fh, indent=2)
            os.replace(tmp, cfg_path)
        except OSError as exc:
            die([f"Could not write {cfg_path}: {exc}",
                 "The directory holding config.json must be writable by this",
                 "container's uid — the app writes config.json and its watcher",
                 "state there. See the uid/gid notes in docker-compose.yml."])

    if generated:
        banner([
            "A dashboard access token was generated for this container.",
            "",
            f"    {web['auth_token']}",
            "",
            "Send it as `Authorization: Bearer <token>` or `X-Carino-Token:",
            "<token>` — those are the two headers the server accepts — or paste",
            "it into the dashboard when it asks. It is stored in:",
            f"    {cfg_path}",
            "so you can read it again at any time — it is not shown again here.",
            "",
            "To manage the token yourself instead, set PACS_AUTH_TOKEN_FILE to a",
            "mounted secret (preferred) or PACS_AUTH_TOKEN (visible in",
            "`docker inspect`), and restart.",
        ])


def install_sigterm_handler() -> None:
    """`docker stop` sends SIGTERM, and the app must unwind rather than die.

    pacs.__main__.main() now installs exactly this handler itself, so this is no
    longer what makes `docker stop` clean — it is kept because it costs nothing
    and it covers the window before main() is reached (prepare_config can spend
    real time on a cold volume). Identical disposition, installed twice.

    An init process is still worth running for zombie reaping (the dashboard's
    "Reveal" action forks xdg-open); docker-compose.yml sets `init: true`.
    """
    def _term(signum, frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, _term)


def main_entry(argv: list[str]) -> int:
    cfg_path = os.environ.get("PACS_CONFIG", "").strip() or DEFAULT_CONFIG

    if not argv:
        argv = ["serve"]

    # Escape hatch: anything that is not a pacs subcommand (`bash`, `python`,
    # `sh -c ...`) is exec'd as-is, so `docker compose run --rm pacs bash` works
    # for a look around without touching the config.
    if argv[0] not in subcommands() and not argv[0].startswith("-"):
        os.execvp(argv[0], argv)

    prepare_config(cfg_path)
    install_sigterm_handler()
    return main(["--config", cfg_path] + argv)


if __name__ == "__main__":
    raise SystemExit(main_entry(sys.argv[1:]))
