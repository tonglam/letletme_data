# Deployment Guide

## Modern Flow (Docker + GitHub Actions)
The production stack now runs inside Docker containers orchestrated by `docker compose` and refreshed automatically from GitHub Actions:

1. `.github/workflows/ci.yml` runs linting, tests, and builds on every push/PR.
2. `.github/workflows/deploy.yml` builds a Bun image on merges to `main`, pushes it to GHCR, and SSHes into the VPS to pull the image, restart the compose stack, and execute database migrations from within the API container.
3. The VPS only needs Docker, the compose file, and a `.env.deploy` containing secrets—no manual Bun builds or systemd restarts.

## Host Bootstrap Checklist
1. **Install Docker + compose** following https://docs.docker.com/engine/install/ubuntu/ then add the `deploy` user to the `docker` group and re-login.
2. **Clone the repo** into `/home/workspace/letletme_data` (or another directory referenced by `VPS_WORKDIR`).
3. **Create `.env.deploy`** by copying `.env.deploy.example` and populate `DATABASE_URL`, `REDIS_*`, `SUPABASE_*`, etc. Keep this file on the server only.
4. **First deploy**: run `bash scripts/deploy.sh deploy` to build the image, start services via compose, and run `bun run db:migrate`.
5. **Proxy + hardening**: terminate TLS in Nginx/Caddy, forward to `127.0.0.1:3000`, lock Redis to the container/local network, and enable ufw.

> ℹ️ **Testing note**: GitHub Actions executes only the unit test suite (no external services required). Run the integration tests locally (`bun test tests/integration`) as part of pre-release validation whenever the external dependencies are available.

## GitHub Actions Secrets
Add the following repository secrets so the deploy workflow can push images and SSH into the VPS:

| Secret | Description |
| --- | --- |
| `GHCR_TOKEN` | Personal access token with `read:packages` + `write:packages` (used for pushing/pulling the container). |
| `VPS_HOST` | Public IP / hostname for the VPS (e.g., `43.163.91.9`). |
| `VPS_USER` | SSH user with Docker permissions (e.g., `deploy`). |
| `VPS_SSH_KEY` | Private key that grants access to `VPS_USER`. |
| `VPS_WORKDIR` | Absolute path containing `docker-compose.yml` on the server. |

The workflow exports `APP_IMAGE=$IMAGE_REF` before running `docker compose pull/up`, ensuring the compose stack always references the freshly pushed GHCR tag.

## Helpful Commands
- `scripts/deploy.sh deploy` – build locally and run the compose stack with migrations.
- `scripts/deploy.sh status` – `docker compose ps` summary.
- `scripts/deploy.sh logs api` – follow logs for a specific service.
- `docker compose run --rm -T api bun run db:migrate` – one-off migration run if needed.

## Legacy Manual Deployment (Break Glass)
The original bare-metal guide is retained below for emergencies when Docker/CI/CD are unavailable.

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
curl http://localhost:3000/health       # Health check
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
