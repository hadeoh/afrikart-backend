#!/usr/bin/env bash
set -euo pipefail

echo "=== Afrikart Backend — one-command start ==="

# 1. Copy .env if it doesn't exist
if [ ! -f .env ]; then
  echo "[setup] Copying .env.example → .env"
  cp .env.example .env
  echo "[setup] Edit .env to set AFRIKART_BASE_URL and credentials for your sandbox"
fi

# 2. Install dependencies
echo "[setup] Installing npm dependencies..."
npm install --silent

# 3. Start MongoDB via Docker if no local instance is reachable
if ! nc -z localhost 27017 2>/dev/null; then
  if command -v docker &>/dev/null; then
    echo "[mongo] Starting MongoDB via Docker..."
    docker run -d --rm --name afrikart-mongo \
      -p 27017:27017 \
      mongo:7 &>/dev/null || true
    sleep 2
  else
    echo "[mongo] WARNING: No MongoDB on 27017 and Docker not found."
    echo "         Set MONGO_URI in .env to an Atlas or remote instance."
  fi
else
  echo "[mongo] MongoDB already reachable on 27017"
fi

# 4. Build and start
echo "[app] Building..."
npm run build

echo "[app] Starting on port ${PORT:-3000}..."
echo ""
echo "  Webhook endpoint: POST http://localhost:${PORT:-3000}/webhooks/fincra"
echo "  Set in sandbox:   WEBHOOK_TARGET_URL=http://localhost:${PORT:-3000}/webhooks/fincra"
echo ""
npm start
