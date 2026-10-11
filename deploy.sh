#!/bin/bash
# Auto-deploy for All In One (Abc Authentic)
# Pulls from GitHub, installs deps, migrates DB, restarts service
set -e

APP_DIR="/opt/all-in-one-abc-authentic"
LOG="$APP_DIR/deploy.log"

cd "$APP_DIR"

# Pull latest
git fetch origin 2>>"$LOG"
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" = "$REMOTE" ]; then
  exit 0
fi

echo "$(date): New commit $REMOTE, deploying..." >>"$LOG"
git reset --hard origin/main >>"$LOG" 2>&1

# Install backend dependencies
cd "$APP_DIR/backend"
if [ ! -d node_modules ] || [ package.json -nt node_modules/.last-install ]; then
  echo "$(date): Installing npm dependencies..." >>"$LOG"
  npm install --production >>"$LOG" 2>&1
  touch node_modules/.last-install
fi

# Install BDRIS certificate engine dependencies (as-is, deterministic: npm ci)
cd "$APP_DIR/engines/bdris-certificate"
if [ -f package.json ]; then
  if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.last-ci ]; then
    echo "$(date): Installing BDRIS engine dependencies (npm ci)..." >>"$LOG"
    npm ci --omit=dev >>"$LOG" 2>&1 || echo "$(date): engine npm ci failed" >>"$LOG"
    touch node_modules/.last-ci 2>/dev/null || true
  fi
fi
cd "$APP_DIR"

# Run database migrations (only if .env exists)
if [ -f .env ]; then
  echo "$(date): Running migrations..." >>"$LOG"
  npm run migrate >>"$LOG" 2>&1 || echo "$(date): Migration failed or no DB" >>"$LOG"
fi

# Restart service if it exists
if systemctl is-active --quiet abc-authentic 2>/dev/null; then
  echo "$(date): Restarting service..." >>"$LOG"
  systemctl restart abc-authentic >>"$LOG" 2>&1
fi

echo "$(date): Deploy complete: $REMOTE" >>"$LOG"
