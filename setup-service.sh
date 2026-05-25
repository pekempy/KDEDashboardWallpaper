#!/bin/bash

# GLaDOS Dashboard Service Auto-setup Script
# Installs a systemd user service so the dashboard runs in the background 24/7.

echo "=========================================="
echo "    GLaDOS Dashboard Service Setup        "
echo "=========================================="

# 1. Get Node.js path
NODE_PATH=$(which node)
if [ -z "$NODE_PATH" ]; then
    echo "❌ Error: Node.js was not found in your PATH."
    exit 1
fi
echo "✓ Found Node.js: $NODE_PATH"

# 2. Get current working directory
CWD=$(pwd)
echo "✓ Working Directory: $CWD"

# 3. Create user systemd directory if it doesn't exist
mkdir -p "$HOME/.config/systemd/user"

# Clean up old aether service if active
if systemctl --user is-active --quiet aether-dashboard.service; then
    echo "Stopping and disabling old aether-dashboard.service..."
    systemctl --user stop aether-dashboard.service
    systemctl --user disable aether-dashboard.service
    rm -f "$HOME/.config/systemd/user/aether-dashboard.service"
fi

# 4. Generate service file content
SERVICE_FILE="$HOME/.config/systemd/user/glados-dashboard.service"

echo "Creating service file at: $SERVICE_FILE"
cat <<EOF > "$SERVICE_FILE"
[Unit]
Description=GLaDOS Desktop Dashboard (24/7)
After=network.target

[Service]
Type=simple
WorkingDirectory=$CWD
ExecStart=$NODE_PATH server.js
Restart=on-failure
RestartSec=5
Environment=PATH=$PATH

[Install]
WantedBy=default.target
EOF

# 6. Reload systemd, enable and start service
echo "Reloading systemd user daemon..."
systemctl --user daemon-reload

echo "Enabling glados-dashboard.service to run on login..."
systemctl --user enable glados-dashboard.service

echo "Starting glados-dashboard.service..."
systemctl --user restart glados-dashboard.service

echo "=========================================="
echo "🎉 Setup complete! Dashboard is running."
echo "👉 Web URL: http://localhost:4848"
echo "👉 Check Status: systemctl --user status glados-dashboard.service"
echo "👉 View Logs: journalctl --user -u glados-dashboard.service -f"
echo "=========================================="
