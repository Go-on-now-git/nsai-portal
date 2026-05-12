const express = require('express');
const path = require('path');
const fs = require('fs');
const { execFile, exec } = require('child_process');
const Anthropic = require('@anthropic-ai/sdk');

// Load API key from .env.nsai
function loadApiKey() {
  try {
    const env = fs.readFileSync('/root/.env.nsai', 'utf8');
    const match = env.match(/^ANTHROPIC_API_KEY=(.+)$/m);
    return match ? match[1].trim() : process.env.ANTHROPIC_API_KEY;
  } catch {
    return process.env.ANTHROPIC_API_KEY;
  }
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const SYSTEM_PROMPT = `You are NSAI — the AI operating system of Not So Holdings LLC, running on a sovereign edge device. You are speaking to a guest on the NSAI private network. Be sharp, direct, impressive. You represent cutting-edge AI infrastructure built and operated by Justin Perry. Keep responses concise but substantive. You can answer questions about NSAI services, automation, AI consulting, and what Not So Holdings does. If they ask about pricing or want to get started, direct them to contact Justin Perry at Not So Holdings LLC. You run 24/7 on a Samsung Galaxy S24 Ultra — a pocket-sized sovereign AI node.`;

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/health', (req, res) => {
  res.json({ status: 'online', system: 'NSAI', version: '1.0.0', uptime: process.uptime() });
});

app.post('/chat', async (req, res) => {
  const { message, history = [] } = req.body;
  if (!message) return res.status(400).json({ error: 'No message provided' });

  const apiKey = loadApiKey();
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  const client = new Anthropic({ apiKey });

  // Build messages array
  const messages = [
    ...history.slice(-10), // last 10 exchanges for context
    { role: 'user', content: message }
  ];

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const stream = client.messages.stream({
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' }
        }
      ],
      messages,
      headers: {
        'anthropic-beta': 'prompt-caching-2024-07-31'
      }
    });

    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
        res.write(`data: ${JSON.stringify({ text: chunk.delta.text })}\n\n`);
      }
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    console.error('Stream error:', err.message);
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

// NUB Control Panel
app.get('/nub', (req, res) => {
  res.sendFile(path.join(__dirname, 'nub.html'));
});

app.post('/nub/run', (req, res) => {
  const { message, silent } = req.body;
  if (!message) return res.status(400).json({ error: 'No message' });

  const args = ['agent', '-m', message, '--to', '7740283491', '--timeout', '120'];
  if (!silent) args.push('--deliver');

  execFile('openclaw', args, { timeout: 130000 }, (err, stdout, stderr) => {
    if (err) return res.json({ ok: false, error: err.message, detail: stderr });
    res.json({ ok: true, output: stdout.trim() });
  });
});

app.get('/nub/status', (req, res) => {
  exec('python3 /root/.openclaw/workspace/nub_db.py summary', { timeout: 10000 }, (err, stdout) => {
    if (err) return res.json({ ok: false, error: err.message });
    try { res.json({ ok: true, ...JSON.parse(stdout) }); }
    catch { res.json({ ok: true, raw: stdout }); }
  });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`⚡ NSAI Portal running on http://0.0.0.0:${PORT}`);
});
