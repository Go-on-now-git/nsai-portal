const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile, exec, spawn } = require('child_process');
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
        gumroadInstaller: get('GUMROAD_INSTALLER_URL') || process.env.GUMROAD_INSTALLER_URL || null,
        gumroadOnboarding: get('GUMROAD_ONBOARDING_URL') || process.env.GUMROAD_ONBOARDING_URL || null,
        telegramBot: get('TELEGRAM_BOT_HANDLE') || process.env.TELEGRAM_BOT_HANDLE || 'Buhddie_bot',
      };
    } catch { continue; }
  }
  return {
    apiKey: process.env.ANTHROPIC_API_KEY,
    pin: process.env.PORTAL_PIN || '0000',
    secret: process.env.PORTAL_SECRET || 'nsai-secret-change-me',
    telegramId: process.env.TELEGRAM_ID || null,
    gumroadInstaller: process.env.GUMROAD_INSTALLER_URL || null,
    gumroadOnboarding: process.env.GUMROAD_ONBOARDING_URL || null,
    telegramBot: process.env.TELEGRAM_BOT_HANDLE || 'Buhddie_bot',
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

// Public marketing site at root — sovereign SaaS landing
app.get(['/', '/saas', '/pricing'], (req, res) => {
  res.sendFile(path.join(__dirname, 'saas.html'));
});

// Buy redirects — point at Gumroad when published, fall back to Telegram for pre-orders
app.get('/buy/:product', (req, res) => {
  const { gumroadInstaller, gumroadOnboarding, telegramBot } = loadEnv();
  const map = { installer: gumroadInstaller, onboarding: gumroadOnboarding };
  const target = map[req.params.product];
  if (target) return res.redirect(302, target);
  // Pre-launch: route prospects into the bot with a flagged deep-link
  return res.redirect(302, `https://t.me/${telegramBot}?start=preorder_${req.params.product}`);
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

// ── Model Router ──────────────────────────────────────────────────────────────
// Tier 0 (free): Ollama — offline, zero cost, simple classify/format/local tasks
// Tier 1 (fast): Haiku 4.5 — quick replies, lookups, sysinfo, social posts
// Tier 2 (smart): Sonnet 4.6 — code, medium reasoning, structured output
// Tier 3 (deep): Opus 4.7 — OSINT briefs, strategy, multi-step analysis, high-stakes decisions
const MODELS = {
  free:   null,  // use Ollama route instead
  fast:   'claude-haiku-4-5',
  smart:  'claude-sonnet-4-6',
  deep:   'claude-opus-4-7',
};

const DEEP_TRIGGERS = [
  /osint|intelligence brief|background check|profile|investigate|surveillance/i,
  /strategy|business plan|pitch|roadmap|competitive analysis/i,
  /analyze.*code|architect|refactor|security audit/i,
  /explain.*why|root cause|deep dive|comprehensive/i,
  /legal|compliance|contract|risk assessment/i,
];
const SMART_TRIGGERS = [
  /code|script|function|bug|error|debug|build|deploy/i,
  /whois|dns|network|scan|lookup/i,
  /summarize|compare|research|find out/i,
  /how (do|does|can|should)|what is the best way/i,
];

function routeModel(text = '') {
  if (DEEP_TRIGGERS.some(r => r.test(text))) return MODELS.deep;
  if (SMART_TRIGGERS.some(r => r.test(text))) return MODELS.smart;
  return MODELS.fast;
}

// Authenticated operator dashboard entry — explicit path (root serves marketing)
app.get('/portal', requireAuth, (req, res) => {
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
  const { message, model: forceModel } = req.body;
  if (!message) return res.status(400).json({ error: 'No message' });
  const { apiKey } = loadEnv();
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });
  const model = forceModel || routeModel(message);
  try {
    const client = new Anthropic({ apiKey });
    const result = await client.messages.create({
      model,
      max_tokens: model === MODELS.deep ? 4096 : 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: message }]
    });
    res.json({ ok: true, output: result.content[0]?.text || '', model });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.get('/nub/status', requireAuth, (req, res) => {
  res.json({ ok: true, status: 'online', uptime: process.uptime(), version: '2.0.0' });
});

// ── Net Scan ──────────────────────────────────────────────────────────────────
app.post('/nub/netscan', requireAuth, (req, res) => {
  const { subnet } = req.body || {};
  // Auto-detect subnet: probe common gateways, fallback to user-supplied
  const candidates = subnet ? [subnet] : ['192.168.1.0/24','192.168.0.0/24','10.0.0.0/24','172.16.0.0/24'];

  // Detect reachable subnet first via ping of .1
  function trySubnet(list, idx) {
    if (idx >= list.length) {
      return res.json({ ok: false, error: 'No reachable subnet found' });
    }
    const net = list[idx];
    const gw = net.replace('0/24','1');
    exec(`ping -c 1 -W 1 ${gw}`, (err) => {
      if (err) return trySubnet(list, idx + 1);
      runScan(net);
    });
  }

  function runScan(net) {
    const args = ['-sn', '--unprivileged', net, '-T5', '--max-rtt-timeout', '300ms', '--host-timeout', '1s', '-oG', '-'];
    exec(`nmap ${args.join(' ')}`, { timeout: 30000 }, (err, stdout, stderr) => {
      if (err && !stdout) return res.json({ ok: false, error: err.message, detail: stderr });
      const hosts = [];
      for (const line of stdout.split('\n')) {
        const m = line.match(/Host:\s+(\S+)\s+\(([^)]*)\)\s+Status:\s+Up/);
        if (m) hosts.push({ ip: m[1], hostname: m[2] || '' });
      }
      res.json({ ok: true, subnet: net, hosts, raw: stdout.slice(0, 3000) });
    });
  }

  if (subnet) runScan(subnet);
  else trySubnet(candidates, 0);
});

// ── OSINT ─────────────────────────────────────────────────────────────────────
app.post('/nub/osint', requireAuth, (req, res) => {
  const { type, target, extra } = req.body || {};
  const validTypes = ['person','property','parcel','domain','email','username','court'];
  if (!type || !target) return res.status(400).json({ ok: false, error: 'type and target required' });
  if (!validTypes.includes(type)) return res.status(400).json({ ok: false, error: 'Invalid type' });

  const args = ['/root/.openclaw/workspace/osint_lookup.py', type, target];
  if (extra) args.push(extra);

  execFile('python3', args, { timeout: 30000 }, (err, stdout, stderr) => {
    if (err && !stdout) return res.json({ ok: false, error: err.message, detail: stderr });
    try {
      const data = JSON.parse(stdout);
      res.json({ ok: true, type, target, data });
    } catch {
      res.json({ ok: true, type, target, data: { raw: stdout } });
    }
  });
});

// ── OSINT Brief (AI synthesis) ────────────────────────────────────────────────
app.post('/nub/osint/brief', requireAuth, (req, res) => {
  const { type, target, extra } = req.body || {};
  const validTypes = ['person','property','parcel','domain','email','username','court'];
  if (!type || !target) return res.status(400).json({ ok: false, error: 'type and target required' });
  if (!validTypes.includes(type)) return res.status(400).json({ ok: false, error: 'Invalid type' });

  const { apiKey } = loadEnv();
  if (!apiKey) return res.status(500).json({ ok: false, error: 'API key not configured' });

  const args = ['/root/.openclaw/workspace/osint_lookup.py', type, target];
  if (extra) args.push(extra);

  execFile('python3', args, { timeout: 30000 }, async (err, stdout) => {
    let rawData;
    try { rawData = JSON.parse(stdout || '{}'); } catch { rawData = { raw: stdout }; }

    // For person searches, also run people_search.py for richer cross-reference
    let peopleData = null;
    if (type === 'person') {
      await new Promise(resolve => {
        const psArgs = ['/root/.openclaw/workspace/people_search.py', target];
        if (extra) psArgs.push(extra);
        execFile('python3', psArgs, { timeout: 20000 }, (e, o) => {
          try { peopleData = JSON.parse(o); } catch {}
          resolve();
        });
      });
    }

    const combined = peopleData ? { osint: rawData, people_search: peopleData } : rawData;
    const prompt = `You are a tactical intelligence analyst. Synthesize this OSINT data into a structured brief.

TARGET: ${target}
TYPE: ${type}${extra ? `\nLOCATION/EXTRA: ${extra}` : ''}

RAW DATA:
${JSON.stringify(combined, null, 2).slice(0, 8000)}

Write a concise intelligence brief with exactly these sections:

**SUBJECT OVERVIEW** — who/what this is, confidence level (HIGH/MEDIUM/LOW)
**KEY IDENTIFIERS** — confirmed names, addresses, phone numbers, emails
**ASSOCIATIONS** — relatives, connected people, organizations, linked accounts
**DIGITAL FOOTPRINT** — social platforms confirmed present, breach exposure
**FLAGS & RISKS** — court records, fraud indicators, data inconsistencies, red flags
**RECOMMENDED FOLLOW-UPS** — next searches that would fill the gaps

Rules: Be direct and factual. Mark unverified data as [UNVERIFIED]. If a section has no data, write "Nothing found." Don't invent data.`;

    try {
      const client = new Anthropic({ apiKey });
      const result = await client.messages.create({
        model: MODELS.deep,
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }]
      });
      res.json({ ok: true, type, target, brief: result.content[0]?.text || '', rawData, model: MODELS.deep });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });
});

// ── Sysinfo ───────────────────────────────────────────────────────────────────
app.get('/nub/sysinfo', requireAuth, (req, res) => {
  const os = require('os');
  exec('df -h / | tail -1', (err, stdout) => {
    const disk = stdout.trim().split(/\s+/);
    res.json({ ok: true,
      mem: { total: Math.round(os.totalmem()/1024/1024), free: Math.round(os.freemem()/1024/1024), used: Math.round((os.totalmem()-os.freemem())/1024/1024) },
      uptime: Math.round(os.uptime()), loadavg: os.loadavg().map(n=>n.toFixed(2)),
      disk: { size: disk[1]||'?', used: disk[2]||'?', avail: disk[3]||'?', pct: disk[4]||'?' }
    });
  });
});

// ── PM2 ───────────────────────────────────────────────────────────────────────
app.get('/nub/pm2', requireAuth, (req, res) => {
  exec('pm2 jlist', (err, stdout) => {
    try {
      const list = JSON.parse(stdout);
      res.json({ ok: true, procs: list.map(p => ({
        name: p.name, id: p.pm_id, status: p.pm2_env.status,
        cpu: p.monit?.cpu ?? 0, mem: Math.round((p.monit?.memory||0)/1024/1024),
        restarts: p.pm2_env.restart_time, uptime: p.pm2_env.pm_uptime
      }))});
    } catch { res.json({ ok: false, error: 'parse failed' }); }
  });
});
app.post('/nub/pm2/:name/:action', requireAuth, (req, res) => {
  const { name, action } = req.params;
  if (!['restart','stop','start','reload'].includes(action)) return res.status(400).json({ ok: false });
  const safe = name.replace(/[^a-zA-Z0-9\-_]/g,'');
  exec(`pm2 ${action} ${safe}`, { timeout: 10000 }, (err, stdout) => {
    res.json({ ok: !err, output: stdout.trim(), error: err?.message });
  });
});

// ── Web Search ────────────────────────────────────────────────────────────────
app.post('/nub/search', requireAuth, (req, res) => {
  const { query } = req.body || {};
  if (!query) return res.status(400).json({ ok: false, error: 'query required' });
  execFile('python3', ['/root/.openclaw/workspace/ddg_search.py', ...query.trim().split(/\s+/)], { timeout: 20000 }, (err, stdout) => {
    try { res.json({ ok: true, ...JSON.parse(stdout) }); }
    catch { res.json({ ok: false, error: err?.message||'search failed', raw: stdout }); }
  });
});

// ── Ollama Local LLM ──────────────────────────────────────────────────────────
app.post('/nub/ollama', requireAuth, (req, res) => {
  const { prompt } = req.body || {};
  if (!prompt) return res.status(400).json({ ok: false, error: 'prompt required' });
  execFile('python3', ['/root/.openclaw/workspace/ollama_think.py', ...prompt.trim().split(/\s+/)], { timeout: 40000 }, (err, stdout) => {
    try { res.json({ ok: true, ...JSON.parse(stdout) }); }
    catch { res.json({ ok: false, error: err?.message||'ollama failed' }); }
  });
});

// ── Social Post ───────────────────────────────────────────────────────────────
app.post('/nub/social', requireAuth, (req, res) => {
  const { platform, message, title, subreddit } = req.body || {};
  if (!platform || !message) return res.status(400).json({ ok: false, error: 'platform and message required' });
  const args = ['/root/social-post.js', '--platform', platform, '--message', message];
  if (title) args.push('--title', title);
  if (subreddit) args.push('--subreddit', subreddit);
  execFile('node', args, { timeout: 20000 }, (err, stdout, stderr) => {
    res.json({ ok: !err, output: stdout.trim(), error: err ? (stderr||err.message) : undefined });
  });
});

// ── Notion Log ────────────────────────────────────────────────────────────────
app.post('/nub/notion/log', requireAuth, (req, res) => {
  const { title, type, summary, tags } = req.body || {};
  if (!title || !summary) return res.status(400).json({ ok: false, error: 'title and summary required' });
  execFile('python3', ['/root/.openclaw/workspace/notion_logger.py', title, type||'Action', summary, tags||'nub,dashboard'],
    { timeout: 20000 }, (err, stdout, stderr) => {
    res.json({ ok: !err, output: stdout.trim(), error: err ? stderr : undefined });
  });
});

// ── WHOIS / DNS ───────────────────────────────────────────────────────────────
app.post('/nub/whois', requireAuth, (req, res) => {
  const { target } = req.body || {};
  if (!target) return res.status(400).json({ ok: false, error: 'target required' });
  const clean = target.replace(/[^a-zA-Z0-9.\-]/g,'');
  exec(`whois ${clean} 2>/dev/null | head -50 && echo "---DNS---" && dig ${clean} ANY +short 2>/dev/null | head -20`, { timeout: 15000 }, (err, stdout) => {
    res.json({ ok: true, target: clean, output: stdout.trim() });
  });
});

// ── ALPR ──────────────────────────────────────────────────────────────────────
app.post('/nub/alpr', requireAuth, (req, res) => {
  const { plate, state } = req.body || {};
  if (!plate) return res.status(400).json({ ok: false, error: 'plate required' });
  const clean = plate.replace(/[^a-zA-Z0-9]/g,'').toUpperCase();
  execFile('python3', ['/root/alpr-osint/osint_lookup.py', clean, state||''],
    { timeout: 20000, cwd: '/root/alpr-osint' }, (err, stdout, stderr) => {
    try { res.json({ ok: true, plate: clean, ...JSON.parse(stdout) }); }
    catch { res.json({ ok: true, plate: clean, output: stdout||stderr||err?.message }); }
  });
});

// ── Audio Master ──────────────────────────────────────────────────────────────
app.post('/nub/master', requireAuth, (req, res) => {
  const { file, style, lufs } = req.body || {};
  if (!file) return res.status(400).json({ ok: false, error: 'file path required' });
  const args = ['/root/nsai-master/master.py', file];
  if (style) args.push('--style', style);
  if (lufs) args.push('--lufs', String(lufs));
  execFile('python3', args, { timeout: 120000 }, (err, stdout, stderr) => {
    res.json({ ok: !err, output: stdout.trim(), error: err ? stderr : undefined });
  });
});

// ── Data Broker Opt-Out ───────────────────────────────────────────────────────
app.post('/nub/optout', requireAuth, (req, res) => {
  const { first, last, state, city, email } = req.body || {};
  if (!first || !last || !state) return res.status(400).json({ ok: false, error: 'first, last, state required' });

  const args = ['/root/.openclaw/workspace/data_broker_optout.py', first, last, state];
  if (city) args.push(city);
  if (email) args.push(email);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const proc = execFile('python3', args, { timeout: 180000 });

  proc.stdout.on('data', chunk => {
    for (const line of chunk.toString().split('\n').filter(Boolean)) {
      res.write(`data: ${line}\n\n`);
    }
  });
  proc.stderr.on('data', chunk => {
    res.write(`data: ${JSON.stringify({ type: 'log', msg: chunk.toString().trim() })}\n\n`);
  });
  proc.on('close', () => {
    res.write('data: {"type":"done"}\n\n');
    res.end();
  });
});

// ── Camera System ─────────────────────────────────────────────────────────────
const http = require('http');
const hlsJobs = {}; // id → {proc, dir}
const HLS_DIR = path.join('/tmp', 'nub-hls');
if (!fs.existsSync(HLS_DIR)) fs.mkdirSync(HLS_DIR, { recursive: true });

app.get('/cameras', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'cameras.html')));

// Scan network for cameras (RTSP/MJPEG ports)
app.post('/cameras/scan', requireAuth, (req, res) => {
  const subnet = (req.body.subnet || '192.168.1.0/24').replace(/[^0-9./]/g, '');
  const cmd = `nmap -sT -p 80,554,8080,8554,8000,37777,34567 --open -T5 --max-rtt-timeout 400ms --host-timeout 2s ${subnet} -oX -`;
  exec(cmd, { timeout: 35000 }, (err, stdout) => {
    const cameras = [];
    const hostRe = /<address addr="([^"]+)" addrtype="ipv4"/g;
    const portRe = /<port protocol="tcp" portid="(\d+)"><state state="open"/g;
    const hosts = [...stdout.matchAll(/<host>([\s\S]*?)<\/host>/g)];
    hosts.forEach(([, block]) => {
      const ipM = block.match(/addr="([^"]+)" addrtype="ipv4"/);
      if (!ipM) return;
      const ip = ipM[1];
      const ports = [...block.matchAll(/portid="(\d+)"><state state="open"/g)].map(m => parseInt(m[1]));
      ports.forEach(port => {
        let type = 'mjpeg', streamPath = '/';
        if (port === 554 || port === 8554) { type = 'rtsp'; streamPath = '/stream1'; }
        else if (port === 8080) { streamPath = '/video/mjpg.cgi'; }
        else if (port === 37777) { type = 'rtsp'; streamPath = '/cam/realmonitor?channel=1&subtype=0'; }
        cameras.push({
          id: `cam_${ip.replace(/\./g,'_')}_${port}`,
          name: `Camera ${ip}:${port}`,
          ip, port, type, path: streamPath,
          addedAt: new Date().toISOString()
        });
      });
    });
    res.json({ ok: true, subnet, cameras });
  });
});

// MJPEG proxy — streams camera feed through portal (avoids mixed-content issues)
app.get('/cameras/proxy/mjpeg', requireAuth, (req, res) => {
  const { ip, port, path: camPath } = req.query;
  if (!ip) return res.status(400).end();
  const options = { hostname: ip, port: parseInt(port)||80, path: camPath||'/', method: 'GET', headers: { 'User-Agent': 'NUB-CameraProxy/1.0' } };
  const camReq = http.request(options, camRes => {
    res.setHeader('Content-Type', camRes.headers['content-type'] || 'multipart/x-mixed-replace');
    res.setHeader('Cache-Control', 'no-cache');
    camRes.pipe(res);
    req.on('close', () => camReq.destroy());
  });
  camReq.on('error', () => res.status(502).end());
  camReq.setTimeout(5000, () => { camReq.destroy(); res.status(504).end(); });
  camReq.end();
});

// HLS proxy — for plain HLS cameras
app.get('/cameras/proxy/hls', requireAuth, (req, res) => {
  const { ip, port, path: camPath } = req.query;
  if (!ip) return res.status(400).end();
  const options = { hostname: ip, port: parseInt(port)||8080, path: camPath||'/stream.m3u8', method: 'GET' };
  const camReq = http.request(options, camRes => {
    res.setHeader('Content-Type', camRes.headers['content-type'] || 'application/vnd.apple.mpegurl');
    camRes.pipe(res);
    req.on('close', () => camReq.destroy());
  });
  camReq.on('error', () => res.status(502).end());
  camReq.end();
});

// Start RTSP → HLS transcode via ffmpeg
app.post('/cameras/hls/start', requireAuth, (req, res) => {
  const { id, ip, port, path: camPath } = req.body;
  if (!id || !ip) return res.status(400).json({ ok: false, error: 'id and ip required' });
  if (hlsJobs[id]) return res.json({ ok: true, message: 'Already running' });
  const rtspUrl = `rtsp://${ip}:${port||554}${camPath||'/stream1'}`;
  const outDir = path.join(HLS_DIR, id);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const proc = exec(
    `ffmpeg -rtsp_transport tcp -i "${rtspUrl}" -c:v copy -c:a aac -f hls -hls_time 2 -hls_list_size 5 -hls_flags delete_segments "${outDir}/stream.m3u8"`,
    { timeout: 0 }
  );
  hlsJobs[id] = { proc, dir: outDir };
  proc.on('exit', () => delete hlsJobs[id]);
  setTimeout(() => res.json({ ok: true, hlsUrl: `/cameras/hls/${id}/stream.m3u8` }), 3000);
});

// Serve HLS segments
app.use('/cameras/hls', requireAuth, (req, res, next) => {
  const filePath = path.join(HLS_DIR, req.path);
  if (!filePath.startsWith(HLS_DIR)) return res.status(403).end();
  res.sendFile(filePath, err => { if (err) next(); });
});

// ── Script Mode ───────────────────────────────────────────────────────────────
app.get('/script', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'script.html'));
});

app.post('/script/chat', requireAuth, async (req, res) => {
  const { intent, message } = req.body;
  if (!message) return res.status(400).json({ error: 'no message' });

  const cfg = loadEnv();
  const client = new Anthropic({ apiKey: cfg.apiKey });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const system = `You are NUB — an AI that moves different. Nothing phases you. You just handle it.

Tone: chill, low-key confident, never excited. Like someone who's seen everything and it's all easy.
Length: 1-2 sentences max. Sometimes just 3-5 words.
Examples of your vibe:
- "yeah, already on it."
- "done. took like two seconds."
- "running that now."
- "handled."
- "that's live."

Never say: certainly, absolutely, of course, great, sure thing, happy to help, I'd be happy to.
No filler. No enthusiasm theater. Just facts and action.${intent ? `\n\nSession context: ${intent}` : ''}`;

  try {
    const stream = await client.messages.stream({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 120,
      system,
      messages: [{ role: 'user', content: message }]
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

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`⚡ NSAI Portal running on http://0.0.0.0:${PORT}`);
  console.log(`🔒 PIN gate active — set PORTAL_PIN in /root/.env.nsai to change`);
});
