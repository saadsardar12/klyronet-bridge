# Klyronet Baileys Bridge

## Deploy on Railway

1. Push this folder to GitHub
2. Go to railway.app → New Project → Deploy from GitHub
3. Add environment variables:
   - WEBHOOK_URL = https://klyronet.com/api/wa/baileys-webhook.php
   - AUTH_TOKEN = klyronet-secret-2024
4. Deploy — Railway gives you a URL like https://klyronet-bridge.railway.app
5. Copy that URL into klyronet.com/config/database.php as BAILEYS_BRIDGE_URL

## API Endpoints
- GET  /              → health check
- POST /connect       → start a new instance
- GET  /qr/:instance  → get QR code
- GET  /status/:instance → get status
- POST /send          → send message
- POST /disconnect    → disconnect instance
- GET  /instances     → list all instances
