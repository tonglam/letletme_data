#!/bin/bash
# Deployment helper script for LetLetMe FPL Data Service
# Run with: bash scripts/deploy.sh

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
APP_USER="letletme"
APP_DIR="/opt/letletme"
SERVICE_NAME="letletme-data"

# Helper functions
log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

check_root() {
    if [[ $EUID -eq 0 ]]; then
        log_error "This script should not be run as root"
        exit 1
    fi
}

check_sudo() {
    if ! sudo -n true 2>/dev/null; then
        log_error "This script requires sudo access"
        exit 1
    fi
}

# Main deployment function
deploy_app() {
    log_info "Starting deployment of LetLetMe FPL Data Service..."
    
    # Check if we're in the app directory
    if [[ ! -f "package.json" ]]; then
        log_error "package.json not found. Please run from the application root directory."
        exit 1
    fi
    
    # Install dependencies and build
    log_info "Installing dependencies..."
    bun install --frozen-lockfile
    
    log_info "Building application..."
    bun run build
    
    # Run database migrations
    log_info "Running database migrations..."
    if ! bun run db:migrate; then
        log_warn "Database migrations failed. Please check your DATABASE_URL"
    fi
    
    # Check if service exists and restart it
    if sudo systemctl is-active --quiet "$SERVICE_NAME"; then
        log_info "Restarting $SERVICE_NAME service..."
        sudo systemctl restart "$SERVICE_NAME"
        
        # Wait a moment and check status
        sleep 3
        if sudo systemctl is-active --quiet "$SERVICE_NAME"; then
            log_info "Service restarted successfully"
        else
            log_error "Service failed to start. Check logs with: sudo journalctl -u $SERVICE_NAME -f"
            exit 1
        fi
    else
        log_warn "Service $SERVICE_NAME not found. Please set up the service first using the deployment guide."
    fi
    
    # Test the API
    log_info "Testing API health..."
    if curl -sf "http://localhost:3000/health" > /dev/null; then
        log_info "✅ API health check passed"
    else
        log_warn "❌ API health check failed. The service might still be starting up."
    fi
    
    log_info "🚀 Deployment completed successfully!"
}

# Update function for regular updates
update_app() {
    log_info "Updating LetLetMe FPL Data Service..."
    
    # Pull latest changes (if git repo)
    if [[ -d ".git" ]]; then
        log_info "Pulling latest changes from git..."
        git pull origin main
    else
        log_warn "Not a git repository. Please manually update your code."
    fi
    
    deploy_app
}

# Check service status
check_status() {
    log_info "Checking service status..."
    
    if sudo systemctl is-active --quiet "$SERVICE_NAME"; then
        log_info "✅ Service is running"
        sudo systemctl status "$SERVICE_NAME" --no-pager
    else
        log_error "❌ Service is not running"
        sudo systemctl status "$SERVICE_NAME" --no-pager
        exit 1
    fi
    
    # Check API
    if curl -sf "http://localhost:3000/health" > /dev/null; then
        log_info "✅ API is responding"
    else
        log_warn "❌ API is not responding"
    fi
}

# View logs
view_logs() {
    log_info "Viewing service logs (Press Ctrl+C to exit)..."
    sudo journalctl -u "$SERVICE_NAME" -f
}

# Initial setup function (for first time deployment)
initial_setup() {
    log_info "Setting up LetLetMe FPL Data Service for first time..."
    
    # Check if .env exists
    if [[ ! -f ".env" ]]; then
        if [[ -f "env.example" ]]; then
            log_info "Creating .env from env.example..."
            cp env.example .env
            log_warn "Please edit .env file with your production settings before running the service"
        else
            log_error ".env file not found and no env.example to copy from"
            exit 1
        fi
    fi
    
    # Build and prepare app
    bun install --frozen-lockfile
    bun run build
    
    log_info "Initial setup completed. Please:"
    log_info "1. Edit .env with your production settings"
    log_info "2. Follow the DEPLOYMENT.md guide to set up system services"
    log_info "3. Run: bash scripts/deploy.sh"
}

# Show usage
show_usage() {
    echo "Usage: $0 [COMMAND]"
    echo ""
    echo "Commands:"
    echo "  deploy     Deploy/update the application (default)"
    echo "  update     Pull latest changes and deploy"
    echo "  status     Check service status"
    echo "  logs       View service logs"
    echo "  setup      Initial setup (first time only)"
    echo "  help       Show this help message"
    echo ""
    echo "Examples:"
    echo "  bash scripts/deploy.sh           # Deploy application"
    echo "  bash scripts/deploy.sh update    # Pull and deploy"
    echo "  bash scripts/deploy.sh status    # Check status"
    echo "  bash scripts/deploy.sh logs      # View logs"
}

# Main script logic
main() {
    check_root
    check_sudo
    
    case "${1:-deploy}" in
        "deploy")
            deploy_app
            ;;
        "update")
            update_app
            ;;
        "status")
            check_status
            ;;
        "logs")
            view_logs
            ;;
        "setup")
            initial_setup
            ;;
        "help"|"-h"|"--help")
            show_usage
            ;;
        *)
            log_error "Unknown command: $1"
            show_usage
            exit 1
            ;;
    esac
}

# Run main function
main "$@"
