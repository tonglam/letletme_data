# Deployment Modernization Plan

This document captures the actionable plan for moving the LetLetMe data service on VPS `43.163.91.9` toward a low-maintenance, best-practice deployment.

## 1. Current State Recap
- `letletme-data` + `letletme-data-worker` systemd units run Bun-compiled artifacts from `/home/workspace/letletme_data` with `.env.production` secrets on disk.
- Git worktree on the host is dirty; deployments rely on manual `bun run build` + systemctl restarts or `scripts/deploy.sh` (which still references a non-existent `/opt/letletme`).
- Nginx terminates HTTP only (no TLS) and proxies to `127.0.0.1:3000`, while Redis listens publicly on `0.0.0.0:6379`; `ufw` is disabled.
- No log rotation for `/var/log/letletme*`, OS packages are ~90 updates behind, and multiple other apps (letletme-api, notice, telegram-bot, Java services) share the VPS.

## 2. Goals
1. Minimize manual host management by adopting containerized deployments driven by CI/CD.
2. Harden the VPS (patches, firewall, TLS, secrets handling, log rotation).
3. Ensure DB migrations and app rollouts are reproducible and observable.

## 3. Target Architecture
- Docker/Compose stack managed as the `deploy` user in `/home/workspace/letletme_data`:
  - `api` service: Bun-built image exposing port 3000 internally.
  - `worker` service: same image with worker command.
  - `redis` service (optional if using managed Redis).
- Nginx (or Caddy) reverse proxy terminates HTTPS and forwards to the `api` container.
- GitHub Actions pipeline builds/tests, publishes a tagged container image (GHCR), and triggers a remote `docker compose pull && docker compose up -d` + `bun run db:migrate` on the VPS via SSH.
- Secrets injected through GitHub Actions + Compose `.env` rather than tracked files.

## 4. Phase-by-Phase Plan

### Phase A – Host Hardening & Housekeeping
1. Apply pending OS updates and reboot during a maintenance window.
2. Enable `ufw` (allow SSH 22/tcp, HTTP 80, HTTPS 443) and restrict Redis to `127.0.0.1` with authentication.
3. Fix Nginx proxy headers and enable TLS (Let’s Encrypt) or replace with Caddy for auto certificates.
4. Add logrotate configs for `/var/log/letletme/*.log` and `/var/log/letletme-api/*.log`.
5. Document coexistence requirements with other apps (notice, telegram-bot) or plan their migration.

### Phase B – Containerization
1. Install Docker + docker-compose-plugin on the VPS; add `deploy` to the `docker` group. ✅ (installed 2026-01-18, see `/etc/apt/sources.list.d/docker.list`).
2. Create a `docker-compose.yml` + `.env.deploy` describing api, worker, redis services and shared volumes (logs, bun cache if needed). ✅ (`docker-compose.yml`, `.env.deploy.example`, `.dockerignore`, `scripts/deploy.sh`).
3. Build/test a Bun-based multi-stage Dockerfile (e.g., `bun build` in builder stage, copy `dist/` + `node_modules` into runner image). ✅ (`Dockerfile`).
4. Update systemd units to run `docker compose up -d` (or decommission them after Compose is stable). ✅ (legacy `letletme-data*` units disabled; compose stack now owns the port).
5. Validate health endpoints through Nginx post-migration. ✅ (`curl http://127.0.0.1:3000/health`).

### Phase C – CI/CD Workflow
1. Add `.github/workflows/ci.yml` to lint, type-check, and run **unit** tests only on pushes/PRs (integration tests stay manual due to external dependencies). ✅
2. Add `.github/workflows/deploy.yml` triggered on `main` success: ✅
   - Build + push Docker image to GHCR.
   - SSH into VPS via Actions deploy key to run `docker compose pull`, `docker compose up -d --remove-orphans`, and `docker compose exec api bun run db:migrate`.
   - Run smoke check (`curl http://127.0.0.1:3000/health`).
3. Store secrets (DATABASE_URL, REDIS_*, SUPABASE_*, VPS SSH key, GHCR token) in GitHub Actions secrets; remove `.env.production` from the repo.
4. Add status badges + deploy instructions to `DEPLOYMENT.md` referencing the automated pipeline.

### Phase D – Operations & Documentation
1. Update `DEPLOYMENT.md` to include the new CI/CD + Compose flow as the primary path and keep the old manual steps in an appendix.
2. Replace `scripts/deploy.sh` with a helper that wraps `docker compose` commands or remove it if redundant.
3. Establish monitoring/alerting (basic uptime + log shipping) once containers are in place.
4. Schedule periodic security updates or enable unattended-upgrades.

## 5. Master Checklist

### Host Hardening
- [ ] Run `sudo apt update && sudo apt upgrade -y` and reboot.
- [ ] Configure `ufw` (allow 22, 80, 443; deny others) and ensure Redis binds to localhost with a password.
- [ ] Issue TLS certs (Let’s Encrypt/Caddy) and fix `proxy_set_header` directives.
- [ ] Add `/etc/logrotate.d/letletme` and `/etc/logrotate.d/letletme-api` entries.

### Container & Compose
- [x] Install Docker + compose plugin; add `deploy` to docker group.
- [x] Author `Dockerfile` + `docker-compose.yml` for api, worker, redis.
- [x] Smoke-test the stack locally/in staging using production-like env vars (live stack now runs under compose on the VPS).
- [x] Migrate systemd services to Compose (disabled `letletme-data` + worker units).

### CI/CD
- [x] Create `.github/workflows/ci.yml` (lint/unit-test/build; integration suites stay manual).
- [x] Create `.github/workflows/deploy.yml` (build image, push, SSH deploy, run migrations, health check).
- [ ] Store required secrets/SSH keys in GitHub; remove `.env.production` from repo and ignore it.
- [ ] Document rollback strategy (e.g., compose rollback to previous tag).

### Documentation & Ops
- [x] Update `DEPLOYMENT.md` + README with the new flow and clarify manual fallback steps.
- [x] Replace or remove `scripts/deploy.sh` to avoid drift.
- [ ] Define log/metric monitoring and add alerts for API/worker failures.
- [ ] Schedule monthly patch windows + verify backups/DB snapshots.

## 6. Rollout Notes
- Perform Phase A and B during low-traffic windows; expect brief downtime when swapping to Docker.
- Keep existing systemd units as a fallback until Compose is proven, then disable them to prevent duplicate processes.
- Coordinate with owners of the other services on the VPS before firewall changes or Docker installation to avoid disruptions.
