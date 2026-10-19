#!/bin/bash
# ShebaHub v2 - VM Setup Script
# Run: bash setup.sh

set -e

echo "=== ShebaHub v2 Setup ==="

echo "[1/5] Installing Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x -o /tmp/node.sh
sudo -E bash /tmp/node.sh
sudo apt install -y nodejs

echo "[2/5] Installing PostgreSQL..."
sudo apt install -y postgresql postgresql-contrib

echo "[3/5] Installing git and tools..."
sudo apt install -y git curl wget

echo "[4/5] Creating app directory..."
sudo mkdir -p /opt/all-in-one-abc-authentic
sudo chown -R $USER:$USER /opt/all-in-one-abc-authentic

echo "[5/5] Cloning repo..."
cd /opt/all-in-one-abc-authentic
git clone https://github.com/allinone52944-oss/Abc-Authentic-final-.git .

echo ""
echo "=== Setup Complete! ==="
echo "Node: $(node --version)"
echo "Next: Configure database and app"
