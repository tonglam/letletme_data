# Deployment Guide

## Modern Flow (Docker + GitHub Actions)
The production stack now runs inside Docker containers orchestrated by `docker compose` and refreshed automatically from GitHub Actions:

1. `.github/workflows/ci.yml` runs linting, tests, and builds on every push/PR.
2. `.github/workflows/deploy.yml` builds a Bun image on merges to `main`, pushes it to GHCR, and SSHes into the VPS to pull the image, restart the compose stack, and execute database migrations from within the API container.
3. The VPS only needs Docker, the compose file, and a `.env.deploy` containing secrets—no manual Bun builds or systemd restarts.

Production logs are structured JSON on container stdout. Docker retains at most five 20 MB
files per service; use `docker compose logs` rather than workspace log files. The legacy
systemd units and `/var/log/letletme` files are not part of the Docker deployment.

## Host Bootstrap Checklist
1. **Install Docker + compose** following https://docs.docker.com/engine/install/ubuntu/ then add the `deploy` user to the `docker` group and re-login.
2. **Clone the repo** into `/home/workspace/letletme_data` (or another directory referenced by `VPS_WORKDIR`).
3. **Create `.env.deploy`** by copying `.env.deploy.example` and populate `DATABASE_URL`, `REDIS_*`, `SUPABASE_*`, `ENABLE_AUTH=true`, and `DATA_API_KEY_HASHES`. Keep this file on the server only. In the current production topology, the app and Redis are on the same VPS, and the containers connect to Redis via `43.163.91.9:6379`.
4. **First deploy**: run `bash scripts/deploy.sh deploy` to build the image, start services via compose, and run database migrations (`db:migrate` + numbered SQL migrations).
5. **Bootstrap the internal service key** (one-time): generate a high-entropy plaintext key, store that plaintext only as the trusted Web server's `TOURNAMENT_API_KEY`, and put its lowercase SHA-256 hex digest in Data's `DATA_API_KEY_HASHES`. To rotate without downtime, add the new digest, deploy both services, switch the Web secret, verify mutations, then remove the old digest. Data never stores or prints the plaintext key.
6. **Proxy + hardening**: terminate TLS in Nginx/Caddy, forward to `127.0.0.1:3000`, restrict Redis access to trusted sources on the VPS/network, and enable ufw.

> ℹ️ **Testing note**: GitHub Actions runs lint, typecheck, unit tests, build,
> both migration paths, migration idempotency/status checks, and integration
> tests against isolated PostgreSQL and Redis services.

## GitHub Actions configuration

The workflow uses GitHub's built-in `GITHUB_TOKEN` for GHCR. Configure these
repository variables and secret for the SSH deployment:

| Type | Name | Description |
| --- | --- | --- |
| Variable | `VPS_HOST` | Public IP or hostname of the VPS |
| Variable | `VPS_USER` | SSH user with Docker permissions, normally `deploy` |
| Variable | `VPS_WORKDIR` | Absolute path containing `docker-compose.yml` |
| Secret | `VPS_SSH_KEY` | Private key that grants access to `VPS_USER` |

The workflow exports `APP_IMAGE=$IMAGE_REF` before running `docker compose pull/up`, ensuring the compose stack always references the freshly pushed GHCR tag.

## Helpful Commands
- `scripts/deploy.sh deploy` – build locally and run the compose stack with migrations.
- `scripts/deploy.sh status` – `docker compose ps` summary.
- `scripts/deploy.sh logs api` – follow logs for a specific service.
- `docker compose logs --since 1h api worker` – inspect bounded production stdout logs.
- `docker compose run --rm -T api bun run db:migrate` – one-off migration run if needed.

## Tournament creation operations

Tournament creation and setup emit three correlated, bounded JSON events:
`tournament_creation_proxy` from Web, `tournament_creation` from the Data API, and
`tournament_setup_attempt` from the worker. All three include `tournamentId` when a shell was
created. The reports deliberately exclude league URLs, raw upstream URLs, manager/team names, and
creator/admin identity.

### Current state and milestone timing

This query is read-only. Replace the psql variable value with the tournament being investigated:

```sql
\set tournament_id 123

SELECT
  id,
  setup_status,
  setup_phase,
  setup_completed_units,
  setup_total_units,
  setup_progress_updated_at,
  setup_warning_count,
  roster_mode,
  roster_sync_status,
  created_at,
  setup_started_at,
  standings_ready_at,
  setup_finished_at,
  round(extract(epoch FROM (standings_ready_at - created_at)) * 1000) AS creation_to_standings_ms,
  round(extract(epoch FROM (setup_finished_at - standings_ready_at)) * 1000) AS enrichment_ms,
  round(extract(epoch FROM (setup_finished_at - created_at)) * 1000) AS creation_to_ready_ms
FROM public.tournament_infos
WHERE id = :'tournament_id'::integer;
```

### Trace one tournament

Use `--no-log-prefix` so each line remains valid Pino JSON. Data API and worker events can be
correlated with one command:

```bash
docker compose logs --no-color --no-log-prefix --since 24h api worker \
  | jq -Rc --argjson tournamentId 123 '
      fromjson?
      | select(.tournamentId == $tournamentId)
      | select(.event == "tournament_creation" or .event == "tournament_setup_attempt")
    '
```

Run the equivalent command against the Web service for the server-visible POST duration:

```bash
docker compose logs --no-color --no-log-prefix --since 24h web \
  | jq -Rc --argjson tournamentId 123 '
      fromjson?
      | select(.event == "tournament_creation_proxy" and .tournamentId == $tournamentId)
    '
```

### Aggregate setup reliability

The following example reports sample count, outcome rates, milestone p50/p95, upstream call and
retry totals, 429 attempts, and the canonical-data reuse ratio:

```bash
docker compose logs --no-color --no-log-prefix --since 30d worker \
  | jq -Rsc '
      def percentile($p):
        sort | if length == 0 then null else .[((length - 1) * $p | floor)] end;
      split("\n")
      | map(fromjson? | select(.event == "tournament_setup_attempt")) as $rows
      | ($rows | length) as $sampleCount
      | {
          sampleCount: $sampleCount,
          outcomeRates: (
            $rows
            | group_by(.outcome)
            | map({
                outcome: .[0].outcome,
                count: length,
                rate: (if $sampleCount == 0 then 0 else length / $sampleCount end)
              })
          ),
          creationToStandingsMs: {
            p50: ([$rows[] | .creationToStandingsMs | select(. != null)] | percentile(0.50)),
            p95: ([$rows[] | .creationToStandingsMs | select(. != null)] | percentile(0.95))
          },
          creationToReadyMs: {
            p50: ([$rows[] | .creationToReadyMs | select(. != null)] | percentile(0.50)),
            p95: ([$rows[] | .creationToReadyMs | select(. != null)] | percentile(0.95))
          },
          upstream: {
            logicalCalls: ([$rows[] | .fpl.logicalRequests // 0] | add // 0),
            attempts: ([$rows[] | .fpl.attempts // 0] | add // 0),
            retries: ([$rows[] | .fpl.retries // 0] | add // 0),
            rateLimitedAttempts: ([$rows[] | .fpl.attemptsByOutcome["429"] // 0] | add // 0)
          },
          reuseRatio: (
            ([$rows[] |
              (.work.entrySnapshots.reusedEntries // 0)
              + (.work.coreResults.reusedPairs // 0)
              + (.work.enrichment.reusedPickPairs // 0)
              + (.work.enrichment.reusedTransferEntries // 0)
            ] | add // 0) as $reused
            | ([$rows[] |
              (.work.entrySnapshots.totalEntries // 0)
              + (.work.coreResults.totalPairs // 0)
              + (.work.enrichment.totalPickPairs // 0)
              + (.work.enrichment.totalTransferEntries // 0)
            ] | add // 0) as $eligible
            | if $eligible == 0 then null else $reused / $eligible end
          )
        }
    '
```

Only show p50 after at least 20 comparable samples. Treat p95 as provisional until at least 100
comparable samples exist. Segment materially different participant/event windows before comparing
them. These measurements are operational evidence only; this release does not expose an ETA to
users.

## Non-live synchronization operations

Data, entry, league, and launch-monitor workers emit one bounded `data_sync_attempt` event for each
top-level BullMQ or cron attempt. Live workers deliberately do not use this report. The event
contains a run ID, target GW when relevant, required/reused/succeeded/failed counts, queue wait and
duration, plus bounded FPL endpoint/outcome counters. It excludes raw URLs, payloads, entry names,
league URLs, and administrator identity.

Trace one run or one target event:

```bash
docker compose logs --no-color --no-log-prefix --since 24h worker \
  | jq -Rc --arg runId "entry-picks-2627-7" --argjson eventId 7 '
      fromjson?
      | select(.event == "data_sync_attempt")
      | select(.runId == $runId or .targetEventId == $eventId)
    '
```

Inspect checkpoint reuse without exposing participant details:

```sql
SELECT
  count(*) AS total_entries,
  count(*) FILTER (WHERE entry_snapshot_synced_through_event_id >= 7) AS snapshot_current,
  count(*) FILTER (WHERE entry_transfers_synced_through_event_id >= 7) AS transfers_current
FROM public.entry_infos;
```

Aggregate outcome, upstream pressure, and reuse for a comparable observation window:

```bash
docker compose logs --no-color --no-log-prefix --since 7d worker \
  | jq -Rsc '
      split("\n")
      | map(fromjson? | select(.event == "data_sync_attempt")) as $rows
      | {
          sampleCount: ($rows | length),
          outcomes: ($rows | group_by(.outcome) | map({outcome: .[0].outcome, count: length})),
          logicalRequests: ([$rows[] | .fpl.logicalRequests // 0] | add // 0),
          retries: ([$rows[] | .fpl.retries // 0] | add // 0),
          rateLimitedAttempts: ([$rows[] | .fpl.attemptsByOutcome["429"] // 0] | add // 0),
          requiredUnits: ([$rows[] | .requiredUnits // 0] | add // 0),
          reusedUnits: ([$rows[] | .reusedUnits // 0] | add // 0)
        }
    '
```

Do not infer success from a worker completion line alone: a `partial` outcome or non-zero failed
unit count remains actionable. Existing final-failure Telegram alerts remain the alerting path.

## Post-deploy season readiness

`/health` proves API liveness. `/ready` additionally requires PostgreSQL,
Redis, and a valid FPL-derived `Season:active`; a fresh Redis deployment can be
healthy while readiness remains `503` until events sync completes.

For a new season, run the staged write and independent PostgreSQL/Redis audit in
[docs/fpl-season-readiness.md](docs/fpl-season-readiness.md). Do not set
`Season:active` manually, infer an endpoint's availability from local data, or
treat a successful container rollout as proof that current-season data is
complete.

## Legacy Manual Deployment (Break Glass)
The original bare-metal guide is retained below for emergencies when Docker/CI/CD are unavailable.
Do not enable its systemd services alongside Docker; doing so creates duplicate processes and
separate unbounded log destinations.

### Manual Deployment Guide - Linux Server

This guide covers deploying the FPL data service directly on a Linux server without Docker.

## Prerequisites

- Ubuntu/Debian Linux server (18.04+ or equivalent)
- Root or sudo access
- Domain name (optional, but recommended)

## Step 1: Install Dependencies

### Install Bun Runtime
```bash
# Install Bun
curl -fsSL https://bun.sh/install | bash

# Reload shell or add to PATH
source ~/.bashrc
# or
export PATH="$HOME/.bun/bin:$PATH"

# Verify installation
bun --version
```

### Configure Supabase (No PostgreSQL Installation Needed)

Since you're using Supabase (managed PostgreSQL service), you don't need to install PostgreSQL locally. Instead, ensure your Supabase project is properly configured:

```bash
# No local PostgreSQL installation needed
# Your database is managed by Supabase
```

### Install Redis
```bash
# Install Redis
sudo apt install redis-server -y

# Configure Redis (optional: set password)
sudo nano /etc/redis/redis.conf
# Uncomment and set: requirepass your_redis_password

# Start and enable Redis
sudo systemctl start redis-server
sudo systemctl enable redis-server

# Test Redis
redis-cli ping
```

### Install Nginx (Reverse Proxy)
```bash
# Install Nginx
sudo apt install nginx -y

# Start and enable Nginx
sudo systemctl start nginx
sudo systemctl enable nginx
```

## Step 2: Set Up Application

### Create Application User
```bash
# Create dedicated user for security
sudo useradd -r -s /bin/bash -d /opt/letletme -m deploy

# Switch to app user for setup
sudo -u deploy bash
mkdir -p /home/workspace/letletme_data
cd /home/workspace/letletme_data
```

### Deploy Application Code
```bash
# Clone or transfer your application code
git clone https://github.com/tonglam/letletme_data.git .
# Or upload files via scp/rsync

# Install dependencies
bun install --frozen-lockfile

# Build application
bun run build
```

### Configure Environment
```bash
# Copy your existing environment configuration
cp .env .env.production

# Edit production environment if needed
nano .env.production

# Validate environment
bun run env:check
```

Your Supabase configuration is already set up in your project environment files.

### Run Database Migrations
```bash
# Run migrations as app user
bun run db:migrate

# Verify database setup
bun run db:check
```

## Step 3: Create System Service

Exit from the app user and create a systemd service:

```bash
# Exit app user
exit

# Create systemd service file
sudo nano /etc/systemd/system/letletme-data.service
```

Add this content:

```ini
[Unit]
Description=LetLetMe FPL Data Service
After=network.target redis-server.service
Wants=redis-server.service

[Service]
Type=simple
User=deploy
Group=deploy
WorkingDirectory=/home/workspace/letletme_data
Environment=NODE_ENV=production
ExecStart=/home/deploy/.bun/bin/bun start
ExecReload=/bin/kill -HUP $MAINPID
Restart=always
RestartSec=10
StandardOutput=append:/var/log/letletme/app.log
StandardError=append:/var/log/letletme/error.log

# Security settings
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/home/workspace/letletme_data/logs /var/log/letletme

[Install]
WantedBy=multi-user.target
```

### Create Worker Service

BullMQ jobs run in a separate worker so API deploys don’t interrupt syncs. Create another unit:

```bash
sudo nano /etc/systemd/system/letletme-data-worker.service
```

```ini
[Unit]
Description=LetLetMe Data Worker
After=network.target redis-server.service
Wants=redis-server.service

[Service]
Type=simple
User=deploy
Group=deploy
WorkingDirectory=/home/workspace/letletme_data
Environment=NODE_ENV=production
Environment=PATH=/home/deploy/.bun/bin:/usr/local/bin:/usr/bin
ExecStart=/home/deploy/.bun/bin/bun worker:start
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

### Set Up Logging
```bash
# Create log directories
sudo mkdir -p /home/workspace/letletme_data/logs
sudo chown deploy:deploy /home/workspace/letletme_data/logs
sudo mkdir -p /var/log/letletme
sudo chown deploy:deploy /var/log/letletme

# Set up log rotation
sudo nano /etc/logrotate.d/letletme-data
```

Add this logrotate configuration:
```
/var/log/letletme/*.log {
    daily
    rotate 30
    compress
    delaycompress
    missingok
    notifempty
    create 644 deploy deploy
    postrotate
        systemctl reload letletme-data
    endscript
}
```

## Step 4: Configure Nginx Reverse Proxy

```bash
# Create Nginx site configuration
sudo nano /etc/nginx/sites-available/letletme-data
```

Add this configuration:
```nginx
server {
    listen 80;
    server_name your-domain.com;  # Replace with your domain

    # Security headers
    add_header X-Frame-Options DENY;
    add_header X-Content-Type-Options nosniff;
    add_header X-XSS-Protection "1; mode=block";
    
    # Rate limiting
    limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;
    
    location / {
        limit_req zone=api burst=20 nodelay;
        
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        
        # Timeouts
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }
    
    # Health check endpoint (no rate limiting)
    location /health {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        access_log off;
    }
}
```

Enable the site:
```bash
# Enable site
sudo ln -s /etc/nginx/sites-available/letletme-data /etc/nginx/sites-enabled/

# Remove default site
sudo rm /etc/nginx/sites-enabled/default

# Test configuration
sudo nginx -t

# Reload Nginx
sudo systemctl reload nginx
```

## Step 5: Start Services

```bash
# Reload systemd and start services
sudo systemctl daemon-reload
sudo systemctl enable letletme-data
sudo systemctl start letletme-data
sudo systemctl enable letletme-data-worker
sudo systemctl start letletme-data-worker

# Check service status
sudo systemctl status letletme-data
sudo systemctl status letletme-data-worker

# View logs
sudo journalctl -u letletme-data -f
sudo journalctl -u letletme-data-worker -f
```

## Step 6: SSL Certificate (Optional but Recommended)

```bash
# Install Certbot
sudo apt install certbot python3-certbot-nginx -y

# Get SSL certificate
sudo certbot --nginx -d your-domain.com

# Test auto-renewal
sudo certbot renew --dry-run
```

## Step 7: Monitoring & Maintenance

### Basic Monitoring Script
```bash
# Create monitoring script
sudo nano /usr/local/bin/letletme-monitor.sh
```

```bash
#!/bin/bash
# Basic health monitoring script

API_URL="http://localhost:3000/health"
LOG_FILE="/var/log/letletme/monitor.log"

if ! curl -sf "$API_URL" > /dev/null; then
    echo "$(date): API health check failed - restarting service" >> "$LOG_FILE"
    systemctl restart letletme-data
else
    echo "$(date): API health check passed" >> "$LOG_FILE"
fi
```

Make it executable and add to cron:
```bash
sudo chmod +x /usr/local/bin/letletme-monitor.sh

# Add to crontab (run every 5 minutes)
echo "*/5 * * * * /usr/local/bin/letletme-monitor.sh" | sudo crontab -
```

### Useful Commands

```bash
# Service management
sudo systemctl status letletme-data    # Check status
sudo systemctl restart letletme-data   # Restart service
sudo systemctl stop letletme-data      # Stop service
sudo systemctl start letletme-data     # Start service

# View logs
sudo journalctl -u letletme-data -f    # Follow logs
sudo tail -f /var/log/letletme/app.log # Application logs

# Database operations
sudo -u deploy bun run db:migrate     # Run migrations
# Note: Use Supabase dashboard for database management instead of db:studio

# Test endpoints
curl http://localhost:3000/health       # Process liveness
curl http://localhost:3000/ready        # PostgreSQL, Redis, and season readiness
curl http://your-domain.com/api/teams   # Test API
```

## Firewall Configuration

```bash
# Configure UFW firewall
sudo ufw enable
sudo ufw allow ssh
sudo ufw allow 'Nginx Full'
sudo ufw status
```

## Deployment Updates

When you need to update the application:

```bash
# Switch to app user
sudo -u deploy bash
cd /opt/letletme

# Pull latest changes
git pull origin main

# Install dependencies
bun install --frozen-lockfile

# Build application
bun run build

# Run migrations if needed
bun run db:migrate

# Exit app user
exit

# Restart service
sudo systemctl restart letletme-data

# Check status
sudo systemctl status letletme-data
```

Your FPL data service should now be running on your Linux server! The API will be accessible at `http://your-domain.com` or `http://your-server-ip`.

## Troubleshooting

### Error: Failed to set up mount namespacing: /opt/letletme/logs: No such file or directory

Cause: The systemd service hardens the filesystem and allows write access only to the paths listed in `ReadWritePaths=`. If `/opt/letletme/logs` does not exist, systemd fails to set up the namespace.

Fix:
```bash
sudo mkdir -p /home/workspace/letletme_data/logs
sudo chown deploy:deploy /home/workspace/letletme_data/logs
sudo systemctl daemon-reload
sudo systemctl restart letletme-data
```

Alternatively, remove `/home/workspace/letletme_data/logs` from `ReadWritePaths=` in the unit file if you don't need it (and rely only on `/var/log/letletme`).
