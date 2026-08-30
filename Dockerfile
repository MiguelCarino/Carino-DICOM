# Carino DICOM — server image
#
#   docker compose up -d          # see docker-compose.yml, which is the documentation
#   docker build -t carino-dicom .
#
# Two stages: the first resolves the Python dependencies into a virtualenv, the
# second copies only that virtualenv and the application. pip, its cache and its
# build machinery never reach the shipped image.
#
# There is no telemetry in this image. Carino DICOM does not phone home, check
# for updates or report crashes anywhere, and the build makes no network call
# beyond the package index.

# Pinned by major version on purpose: 3.12 keeps patch updates flowing on a
# rebuild, while a floating `python:slim` would move the interpreter under a
# medical device without anyone deciding to. Pin the digest too if your
# deployment needs bit-identical rebuilds.
ARG PYTHON_VERSION=3.12


# ---------------------------------------------------------------------------
# Stage 1 — dependencies
# ---------------------------------------------------------------------------
FROM python:${PYTHON_VERSION}-slim AS builder

WORKDIR /build
COPY requirements.txt ./

# --only-binary=:all: is a guard, not an optimisation. Every dependency here
# publishes manylinux wheels, so a source distribution showing up means a
# platform or a version has changed; failing loudly is better than silently
# needing a compiler in a stage that does not have one.
RUN python -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
 && /opt/venv/bin/pip install --no-cache-dir --only-binary=:all: -r requirements.txt


# ---------------------------------------------------------------------------
# Stage 2 — runtime
# ---------------------------------------------------------------------------
FROM python:${PYTHON_VERSION}-slim AS runtime

# Align these with the owner of your data directory on the host:
#   docker compose build --build-arg PUID=$(id -u) --build-arg PGID=$(id -g)
# A volume-mounted directory owned by someone else is the most common first-run
# failure; see the uid/gid section of docker-compose.yml.
ARG PUID=1000
ARG PGID=1000
# Bump alongside pacs/__init__.py when cutting a release.
ARG VERSION=1.1.0

LABEL org.opencontainers.image.title="Carino DICOM" \
      org.opencontainers.image.description="Self-hosted DICOM gateway and continuity appliance" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      org.opencontainers.image.source="https://github.com/MiguelCarino/Carino-DICOM"

ENV PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PACS_CONFIG=/data/config.json \
    # The app expands ~ for its default paths. With an unknown uid, HOME would
    # be unset and expanduser() would hand back a literal "~" directory inside
    # the image; pinning it at the volume makes that harmless whoever we run as.
    HOME=/data

# No apt-get in this stage: nothing here needs a system library. Pillow is used
# only for PNG/JPEG import and its built-in bitmap font, so there is no
# fontconfig, no image codecs and no compiler to keep patched.
RUN groupadd --gid ${PGID} pacs \
 && useradd --uid ${PUID} --gid ${PGID} --home-dir /data --no-create-home --shell /usr/sbin/nologin pacs \
 && install -d -o ${PUID} -g ${PGID} -m 0750 /data

COPY --from=builder /opt/venv /opt/venv

WORKDIR /app
COPY pacs/ /app/pacs/
COPY docker/ /app/docker/
# `pacs init` looks for config.example.json one level above the package, and
# AGPL-3.0-or-later means the licence travels with the distributed program.
COPY config.example.json LICENSE /app/
# The manual, served at /manual/. A container is the deployment most likely to
# be on a segment with no route out, and the manual is where the token rule and
# the two hold causes are explained. pacs.web.MANUAL_DIR finds it here.
COPY docs/manual/ /app/manual/

# Numeric on purpose so it still resolves when compose overrides `user:` and
# /etc/passwd has no matching entry.
USER ${PUID}:${PGID}

# Patient studies, logs, the index and config.json all live here. Declared so
# that a plain `docker run` with no -v still puts them on a volume rather than
# writing DICOM into the container's writable layer.
VOLUME ["/data"]

# Documentation only — what actually opens a port is the enabled flag in the
# config plus a host-side publish. Publish deliberately: see docker-compose.yml.
EXPOSE 8042/tcp
EXPOSE 11112/tcp
EXPOSE 11113/tcp
EXPOSE 11114/tcp
EXPOSE 11115/tcp
EXPOSE 2575/tcp

# Asks the dashboard for a real answer and, when the Storage SCP is enabled,
# checks that its port is actually listening — `pacs serve` keeps the dashboard
# up when a listener fails to bind, so "the process is running" would hide a
# dead DICOM port. start-period covers the index rescan on a large archive.
#
# Note for Podman: `podman build` defaults to the OCI image format, which has
# nowhere to put a healthcheck and drops this with a warning. Build with
# `podman build --format docker` to keep it; docker-compose.yml also declares
# the same check at the service level, which works either way.
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD ["python", "/app/docker/healthcheck.py"]

ENTRYPOINT ["python", "/app/docker/entrypoint.py"]
CMD ["serve"]
