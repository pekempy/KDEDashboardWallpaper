#!/bin/bash

# GLaDOS Desktop Wallpaper Startup Script

CWD=$(cd "$(dirname "$0")" && pwd)

echo "=========================================="
# 1. Run KWin rule setup to ensure they are configured
python3 "$CWD/manage_kwin_rules.py"

# 2. Wait for the dashboard server to be available
echo "Checking if dashboard server (port 4848) is running..."
for i in {1..15}; do
    if curl -s -I http://localhost:4848 | grep -q "HTTP/1.1"; then
        echo "✓ Dashboard server is ready."
        break
    fi
    echo "Waiting for dashboard server to start (attempt $i/15)..."
    sleep 1
done

# 3. Kill any existing instances of the wallpaper window
echo "Cleaning up existing wallpaper window instances..."
pkill -f "dashboard-wallpaper" || true
pkill -f "dashboard-wallpaper-profile" || true
sleep 1

# 4. Launch a dedicated Chrome window for each monitor defined in config
echo "Launching wallpaper windows for each monitor..."

# Read the config to get display order
ORDER=$(python3 -c "import yaml; print(','.join(map(str, yaml.safe_load(open('$CWD/config.yaml'))['display']['order'])))")
IFS=',' read -r -a MONITOR_ORDER <<< "$ORDER"

i=0
for monitor_id in "${MONITOR_ORDER[@]}"; do
  # Simple positioning logic (assumes left-to-right 1920x1080)
  X_POS=$(( i * 1920 ))
  SCREEN_NUM=$(( i + 1 ))
  
  google-chrome-stable \
    --app="http://localhost:4848/?screen=$SCREEN_NUM" \
    --class="dashboard-wallpaper" \
    --user-data-dir="$HOME/.config/dashboard-wallpaper-profile-screen-$SCREEN_NUM" \
    --window-position="$X_POS,0" \
    --window-size=1920,1080 \
    --no-first-run \
    --no-default-browser-check \
    --enable-gpu-rasterization \
    --enable-zero-copy \
    --ignore-gpu-blocklist \
    --autoplay-policy=no-user-gesture-required \
    --password-store=basic \
    --disable-renderer-backgrounding \
    --disable-background-timer-throttling \
    --disable-backgrounding-occluded-windows \
    --ozone-platform=x11 \
    "$@" > /dev/null 2>&1 &

  echo "Launched screen $SCREEN_NUM (physical $monitor_id) at position $X_POS,0"
  i=$((i+1))
done

echo "Wallpaper windows launched successfully in the background."
echo "=========================================="
