# NSAI Portal + NUB Control Panel
### by NSAI — Not So Artificial Intelligence

The web front door for NSAI: portal homepage, live demo, AI chat, and the NUB Control Panel — service status and one-command startup for the whole self-hosted stack.

## What's inside

- **Portal** (`index.html`) — homepage, blog, offers
- **Demo** (`/demo`) — live walkthrough
- **Chat** (`/chat`) — AI chat
- **NUB Control Panel** (`/nub`) — service status and command runner
- **Setup** (`/setup`) — first-boot walkthrough (see `SETUP.md`)

## Run it

```bash
npm install
node server.js
```

Runs at `http://localhost:8080`. Access is PIN-gated — set `PORTAL_PIN` and `PORTAL_SECRET` in the environment; see `SETUP.md` for first boot.

---
*Not So Holdings LLC · #StayAbove · nsai.tech*
