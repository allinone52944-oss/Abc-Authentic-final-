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

# Install engine dependencies for ALL engines (bdris-apply, bdris-certificate, death-verify, nid-replica)
for ENGINE in bdris-apply bdris-certificate death-verify nid-replica; do
  cd "$APP_DIR/engines/$ENGINE"
  if [ -f package.json ]; then
    if [ ! -d node_modules ] || [ package.json -nt node_modules/.last-install ]; then
      echo "$(date): Installing $ENGINE dependencies..." >>"$LOG"
      npm install --production >>"$LOG" 2>&1 || echo "$(date): $ENGINE npm install failed" >>"$LOG"
      touch node_modules/.last-install 2>/dev/null || true
    fi
  fi
done
cd "$APP_DIR"

# Run database migrations (only if .env exists)
# NOTE (2026-10-15): must run backend/migrate.js directly — there is no
# package.json at repo root, so `npm run migrate` from here silently fails
# and schema changes would never reach the Oracle DB.
if [ -f .env ]; then
  echo "$(date): Running migrations..." >>"$LOG"
  if node backend/migrate.js >>"$LOG" 2>&1; then
    echo "$(date): Migrations OK" >>"$LOG"
  else
    # DO NOT restart on migration failure — new code on old schema is worse
    # than old code still running. The failure is in deploy.log; next deploy retries.
    echo "$(date): ERROR: Migration failed — NOT restarting service" >>"$LOG"
    exit 1
  fi
fi

# Restart service if it exists.
# NOTE (2026-10-15): the deploy user needs passwordless sudo for this one
# command — run ONCE on the server as root:
#   echo "ocarun ALL=(ALL) NOPASSWD: /bin/systemctl restart abc-authentic.service, /bin/systemctl is-active abc-authentic.service" | sudo tee /etc/sudoers.d/abc-authentic-deploy && sudo chmod 440 /etc/sudoers.d/abc-authentic-deploy
# (replace "ocarun" with the user that runs deploy.sh)
# IMPORTANT: sudoers matches arguments literally — invoke EXACTLY as above
# (/bin/systemctl, full .service name, no --quiet flag).
if sudo -n /bin/systemctl is-active abc-authentic.service >/dev/null 2>&1; then
  echo "$(date): Restarting service..." >>"$LOG"
  if sudo -n /bin/systemctl restart abc-authentic.service >>"$LOG" 2>&1; then
    echo "$(date): Service restarted" >>"$LOG"
  else
    echo "$(date): ERROR: service restart failed (check sudoers rule above)" >>"$LOG"
    exit 1
  fi
else
  echo "$(date): Service not active, skipping restart" >>"$LOG"
fi

echo "$(date): Deploy complete: $REMOTE" >>"$LOG"
