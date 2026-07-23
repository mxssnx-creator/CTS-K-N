#!/bin/bash

echo "════════════════════════════════════════════════════════════════"
echo "                   BUN PERMISSION FIX SCRIPT"
echo "════════════════════════════════════════════════════════════════"
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
   echo "ERROR: This script must be run as root"
   echo "Run with: sudo bash fix-bun-permissions.sh"
   exit 1
fi

echo "[1/5] Finding Bun installation path..."
BUN_PATH=$(which bun 2>/dev/null)
if [ -z "$BUN_PATH" ]; then
    echo "ERROR: Bun not found in PATH"
    exit 1
fi
echo "✓ Found: $BUN_PATH"
echo ""

echo "[2/5] Checking current permissions..."
ls -l "$BUN_PATH"
echo ""

echo "[3/5] Fixing permissions..."
chmod +x "$BUN_PATH"
chmod 755 "$BUN_PATH"
echo "✓ Updated execute permissions"
echo ""

echo "[4/5] Fixing directory permissions..."
BUN_DIR=$(dirname "$BUN_PATH")
chmod 755 "$BUN_DIR"
echo "✓ Updated directory permissions: $BUN_DIR"
echo ""

echo "[5/5] Verifying Bun works..."
if bun --version > /dev/null 2>&1; then
    echo "✓ Bun is now executable"
    bun --version
else
    echo "ERROR: Bun still not executable"
    echo "Try reinstalling: npm install -g bun@latest"
    exit 1
fi

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "✓ BUN PERMISSION FIX COMPLETE"
echo "════════════════════════════════════════════════════════════════"
echo ""
echo "Next steps:"
echo "  1. Install dependencies: pnpm install"
echo "  2. Build: pnpm build"
echo "  3. Start: pnpm start"
echo ""
