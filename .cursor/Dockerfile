# Cloud Agent base image for letletme_data.
# Provides the stable system toolchain: Bun 1.3.14, PostgreSQL 15, and Redis.
# Repository dependencies and per-boot services are handled by install.sh/start.sh.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Etc/UTC

# Base tooling + Redis, then add the PGDG repo and install PostgreSQL 15 to match
# the production major (docker-compose pins DATABASE_BACKUP_PG_MAJOR=15).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg git unzip sudo locales tzdata \
        build-essential redis-server \
    && install -d /usr/share/postgresql-common/pgdg \
    && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
        -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
    && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt noble-pgdg main" \
        > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends postgresql-15 postgresql-client-15 \
    && rm -rf /var/lib/apt/lists/*

# Non-root user with passwordless sudo (ubuntu exists by default on 24.04 images,
# but guard for base variants that omit it) and access to the postgres group.
RUN if ! id ubuntu >/dev/null 2>&1; then useradd -m -s /bin/bash ubuntu; fi \
    && echo 'ubuntu ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/90-ubuntu \
    && chmod 0440 /etc/sudoers.d/90-ubuntu \
    && usermod -aG postgres ubuntu

USER ubuntu
WORKDIR /home/ubuntu

# Bun pinned to the version in package.json (packageManager: bun@1.3.14).
ENV BUN_INSTALL=/home/ubuntu/.bun
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.14"
ENV PATH=/home/ubuntu/.bun/bin:$PATH
