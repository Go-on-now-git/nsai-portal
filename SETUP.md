# NSAI Portal + NUB Setup

## First Boot

1. **Install dependencies**
   ```bash
   cd /root/nsai-portal
   npm install
   ```

2. **Link nub command globally**
   ```bash
   sudo ln -sf /root/nsai-portal/scripts/nub /usr/local/bin/nub
   ```

3. **Start all services**
   ```bash
   nub
   ```

This starts: ollama, openclaw, event-handler, nsai-portal, n8n, watchdog, jarvis-monitor, privacy-shield.

The `nub` command is idempotent—safe to run repeatedly. It only starts stopped services.

## Services
- **OpenClaw** (port 18789): Primary AI gateway
- **NSAI Portal** (port 3000): Web UI
- **n8n** (port 5678): Workflow automation
- **Event Handler** (port 3000): Telegram/GitHub webhook
