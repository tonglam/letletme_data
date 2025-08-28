# Manual Deployment Guide - Linux Server

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
# Reload systemd and start service
sudo systemctl daemon-reload
sudo systemctl enable letletme-data
sudo systemctl start letletme-data

# Check service status
sudo systemctl status letletme-data

# View logs
sudo journalctl -u letletme-data -f
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
