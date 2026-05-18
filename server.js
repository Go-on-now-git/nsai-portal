const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile, exec } = require('child_process');
const Anthropic = require('@anthropic-ai/sdk');

// ── Config ────────────────────────────────────────────────────────────────────
function loadEnv() {
  const envPaths = [
    path.join(__dirname, '.env.nsai'),
    path.join(process.env.HOME || '/root', 'nsai-portal', '.env.nsai'),
  ];
  for (const p of envPaths) {
    try {
      const raw = fs.readFileSync(p, 'utf8');
      const get = (key) => { const m = raw.match(new RegExp(`^${key}=(.+)$`, 'm')); return m ? m[1].trim() : null; };
      return {
        apiKey: get('ANTHROPIC_API_KEY') || process.env.ANTHROPIC_API_KEY,
        pin: get('PORTAL_PIN') || process.env.PORTAL_PIN || '0000',
        secret: get('PORTAL_SECRET') || process.env.PORTAL_SECRET || 'nsai-secret-change-me',
        telegramId: get('TELEGRAM_ID') || process.env.TELEGRAM_ID || null,
      };
    } catch { continue; }
  }
  return {
    apiKey: process.env.ANTHROPIC_API_KEY,
    pin: process.env.PORTAL_PIN || '0000',
    secret: process.env.PORTAL_SECRET || 'nsai-secret-change-me',
    telegramId: process.env.TELEGRAM_ID || null,
  };
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Login rate limiting: max 5 attempts per IP per 5 minutes
const loginAttempts = new Map();
function checkLoginLimit(ip) {
  const now = Date.now();
  const window = 5 * 60 * 1000;
  const max = 5;
  const entry = loginAttempts.get(ip) || { count: 0, start: now };
  if (now - entry.start > window) { loginAttempts.set(ip, { count: 1, start: now }); return false; }
  if (entry.count >= max) return true;
  entry.count++;
  loginAttempts.set(ip, entry);
  return false;
}

// ── PIN Auth ──────────────────────────────────────────────────────────────────
const SESSION_COOKIE = 'nsai_session';

function signToken(pin, secret) {
  return crypto.createHmac('sha256', secret).update(pin).digest('hex');
}

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  return Object.fromEntries(raw.split(';').map(s => s.trim().split('=').map(decodeURIComponent)));
}

function isAuthed(req) {
  const { pin, secret } = loadEnv();
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  return token === signToken(pin, secret);
}

function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  const redirect = encodeURIComponent(req.originalUrl);
  res.redirect(`/login?next=${redirect}`);
}

// ── Public routes (no auth) ───────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'online', system: 'NSAI', version: '2.0.0', uptime: process.uptime() });
});

app.get('/login', (req, res) => {
  const next = req.query.next || '/';
  const errCode = req.query.err;
  const err = errCode === '1';
  const rateLimited = errCode === '2';
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NSAI Portal — Access</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#080A0F;color:#F0F2F8;font-family:-apple-system,BlinkMacSystemFont,'Inter',sans-serif;
    display:flex;align-items:center;justify-content:center;min-height:100vh;}
  .card{background:#0E1018;border:1px solid rgba(0,120,255,0.2);border-radius:20px;
    padding:48px 40px;width:100%;max-width:380px;text-align:center;}
  .logo{font-size:1.4rem;font-weight:900;background:linear-gradient(135deg,#0055CC,#0078FF,#00AAFF);
    -webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:6px;}
  .sub{font-size:0.78rem;color:#4A4F62;margin-bottom:36px;}
  label{display:block;font-size:0.72rem;font-weight:600;color:#9299B0;letter-spacing:.08em;
    text-transform:uppercase;text-align:left;margin-bottom:8px;}
  input{width:100%;background:rgba(0,120,255,0.05);border:1px solid rgba(0,120,255,0.18);
    border-radius:10px;padding:14px 16px;color:#F0F2F8;font-size:1.1rem;text-align:center;
    letter-spacing:.3em;font-family:monospace;outline:none;transition:border-color .2s;}
  input:focus{border-color:#0078FF;}
  button{width:100%;margin-top:20px;background:linear-gradient(135deg,#0055CC,#0078FF,#00AAFF);
    color:#fff;font-weight:700;font-size:0.95rem;padding:14px;border:none;border-radius:10px;
    cursor:pointer;transition:opacity .2s;}
  button:hover{opacity:.88;}
  .err{color:#f87171;font-size:0.8rem;margin-top:16px;}
  .hint{color:#4A4F62;font-size:0.72rem;margin-top:20px;}
</style>
</head>
<body>
<div class="card">
  <div class="logo">NSAI ⚡</div>
  <div class="sub">Private Network Access</div>
  <form method="POST" action="/login?next=${encodeURIComponent(next)}">
    <label>Access PIN</label>
    <input type="password" name="pin" inputmode="numeric" pattern="[0-9]*"
      placeholder="••••" autofocus autocomplete="off" maxlength="12">
    <button type="submit">Enter →</button>
    ${err ? '<div class="err">Incorrect PIN. Try again.</div>' : ''}
    ${rateLimited ? '<div class="err">Too many attempts. Wait 5 minutes.</div>' : ''}
  </form>
  <div class="hint">Authorized personnel only.</div>
</div>
</body>
</html>`);
});

app.post('/login', (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  if (checkLoginLimit(ip)) {
    return res.redirect(`/login?err=2`);
  }

  const { pin: inputPin } = req.body;
  const { pin, secret } = loadEnv();
  const next = req.query.next || '/';

  let valid = false;
  try {
    valid = inputPin && crypto.timingSafeEqual(
      Buffer.from(inputPin.trim(), 'utf8'),
      Buffer.from(pin, 'utf8')
    );
  } catch { valid = false; }

  if (valid) {
    const token = signToken(pin, secret);
    // 30-day session
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Max-Age=${60*60*24*30}; SameSite=Strict`);
    res.redirect(decodeURIComponent(next));
  } else {
    res.redirect(`/login?next=${encodeURIComponent(next)}&err=1`);
  }
});

app.get('/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; Max-Age=0`);
  res.redirect('/login');
});

// ── Block sensitive files ─────────────────────────────────────────────────────
const BLOCKED_PATTERNS = ['.env', 'server.js', 'package.json', 'package-lock.json', '.gitignore'];
app.use((req, res, next) => {
  const p = req.path.replace(/\?.*$/, '');
  if (BLOCKED_PATTERNS.some(b => p.endsWith(b)) || p.includes('node_modules')) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
});

// ── Protected static files ────────────────────────────────────────────────────
app.use(requireAuth, express.static(path.join(__dirname), { index: 'index.html' }));

// ── Protected routes ──────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are NUB (Not So Artificial Intelligence Ultrabot) — the AI operating system of Not So Holdings LLC (nsai.tech), running on a sovereign edge device. You are sharp, direct, and operate 24/7 as an intelligent business assistant. You handle automation, scheduling, research, follow-ups, and workflow optimization. Keep responses concise but substantive. For questions about pricing or getting started, direct to nsai.tech or nub@nsai.tech.`;

app.get('/', requireAuth, (req, res) => {
  res.redirect('/nub');
});

// Guest demo chat — share this URL on your WiFi for prospects
app.get('/demo', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});;

app.post('/chat', requireAuth, async (req, res) => {
  const { message, history = [] } = req.body;
  if (!message) return res.status(400).json({ error: 'No message provided' });

  const { apiKey } = loadEnv();
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  const client = new Anthropic({ apiKey });
  const messages = [...history.slice(-10), { role: 'user', content: message }];

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const stream = client.messages.stream({
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages,
      headers: { 'anthropic-beta': 'prompt-caching-2024-07-31' }
    });

    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
        res.write(`data: ${JSON.stringify({ text: chunk.delta.text })}\n\n`);
      }
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

app.get('/nub', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'nub.html'));
});

app.get('/setup', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'setup.html'));
});

app.post('/nub/run', requireAuth, async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'No message' });
  const { apiKey } = loadEnv();
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });
  try {
    const client = new Anthropic({ apiKey });
    const result = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: message }]
    });
    res.json({ ok: true, output: result.content[0]?.text || '' });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.get('/nub/status', requireAuth, (req, res) => {
  res.json({ ok: true, status: 'online', uptime: process.uptime(), version: '2.0.0' });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`⚡ NSAI Portal running on http://0.0.0.0:${PORT}`);
  console.log(`🔒 PIN gate active — set PORTAL_PIN in /root/.env.nsai to change`);
});
