require('dotenv').config();
const express = require('express');
const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const tools = require('./tools');

const app = express();
app.use(express.json({ limit: '1mb' }));

// Ensure a persistent secret is present on first run
function ensureSecretSync() {
  const envPath = path.join(process.cwd(), '.env');
  // if already in environment, nothing to do
  if (process.env.AUTH_TOKEN && process.env.AUTH_TOKEN !== '') return { created: false };

  let envText = '';
  if (fs.existsSync(envPath)) {
    try { envText = fs.readFileSync(envPath, 'utf8'); } catch (e) { envText = ''; }
    // if AUTH_TOKEN exists in file, load it
    const m = envText.match(/^AUTH_TOKEN=(.*)$/m);
    if (m && m[1]) {
      process.env.AUTH_TOKEN = m[1].trim();
      return { created: false };
    }
  }

  const secret = crypto.randomBytes(24).toString('hex');
  // Append or create .env with secure mode
  if (envText && envText.trim() !== '') {
    envText = envText.replace(/\r?\n$/, '') + `\nAUTH_TOKEN=${secret}\n`;
  } else {
    envText = `AUTH_TOKEN=${secret}\nLITERT_MODEL=${process.env.LITERT_MODEL || ''}\n`;
  }
  try {
    fs.writeFileSync(envPath, envText, { mode: 0o600 });
  } catch (e) {
    // best-effort write; ignore errors
  }
  process.env.AUTH_TOKEN = secret;
  return { created: true, secret };
}

function getPublicIp(callback) {
  const url = 'https://api.ipify.org?format=json';
  const req = https.get(url, { timeout: 2000 }, (res) => {
    let body = '';
    res.on('data', (d) => body += d.toString());
    res.on('end', () => {
      try { const j = JSON.parse(body); if (j.ip) return callback(j.ip); } catch (e) {}
      callback(getLocalIp());
    });
  });
  req.on('error', () => callback(getLocalIp()));
  req.on('timeout', () => { req.destroy(); callback(getLocalIp()); });
}

function getLocalIp() {
  const ifs = os.networkInterfaces();
  for (const k of Object.keys(ifs)) {
    for (const iface of ifs[k]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

const secretResult = ensureSecretSync();

const LITERT_BIN = process.env.LITERT_BIN || 'litert-lm';
const DEFAULT_MODEL = process.env.LITERT_MODEL || '';
const LITERT_ARGS = process.env.LITERT_ARGS || '';
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
const LISTEN_ADDR = process.env.LISTEN_ADDR || '0.0.0.0';
const LISTEN_PORT = process.env.LISTEN_PORT || 8080;
const MAX_CONCURRENCY = parseInt(process.env.MAX_CONCURRENCY || '4', 10);
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS || '120000', 10);

let current = 0;
const queue = [];

function enqueue(fn) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    drain();
  });
}

function drain() {
  while (current < MAX_CONCURRENCY && queue.length) {
    const item = queue.shift();
    current++;
    Promise.resolve()
      .then(() => item.fn())
      .then((v) => { current--; item.resolve(v); drain(); })
      .catch((e) => { current--; item.reject(e); drain(); });
  }
}

function buildArgs(model, prompt, opts) {
  const args = ['run'];
  if (model) args.push(model);
  if (LITERT_ARGS) {
    // simple split on spaces, support quotes
    args.push(...splitArgs(LITERT_ARGS));
  }
  args.push('--prompt', prompt);
  if (opts && opts.max_tokens) args.push('--max-tokens', String(opts.max_tokens));
  if (opts && opts.temperature !== undefined) args.push('--temperature', String(opts.temperature));
  return args;
}

function splitArgs(s) {
  const out = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') { inQuote = !inQuote; continue; }
    if (c === ' ' && !inQuote) { if (cur) { out.push(cur); cur = ''; } continue; }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

app.post('/v1/generate', async (req, res) => {
  if (AUTH_TOKEN) {
    const h = req.header('authorization') || '';
    if (h !== `Bearer ${AUTH_TOKEN}`) return res.status(401).json({ error: 'unauthorized' });
  }
  const body = req.body || {};
  const prompt = body.prompt || body.input || '';
  if (!prompt) return res.status(400).json({ error: 'prompt required' });

  const model = body.model || DEFAULT_MODEL;
  const opts = { max_tokens: body.max_tokens, temperature: body.temperature };

  try {
    const out = await enqueue(() => invokeLitert(model, prompt, opts));
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// OpenAI-compatible Chat Completions endpoint (basic compatibility)
app.post('/v1/chat/completions', async (req, res) => {
  if (AUTH_TOKEN) {
    const h = req.header('authorization') || '';
    if (h !== `Bearer ${AUTH_TOKEN}`) return res.status(401).json({ error: 'unauthorized' });
  }
  const body = req.body || {};
  const messages = body.messages;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array required' });
  }

  const model = body.model || DEFAULT_MODEL;
  // convert messages to a single prompt string
  const prompt = messagesToPrompt(messages);

  try {
    // Streaming support: if client requests `stream: true` return token deltas
    if (body.stream) {
      // SSE streaming
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      // Enqueue streaming invocation to respect concurrency
      await enqueue(() => new Promise((resolveStream) => {
        const modelForStream = body.model || DEFAULT_MODEL;
        const promptForStream = messagesToPrompt(body.messages || []);
        const child = invokeLitertStream(modelForStream, promptForStream, { max_tokens: body.max_tokens, temperature: body.temperature }, (chunk) => {
          // send chunk as OpenAI delta
          const payload = { choices: [{ delta: { content: chunk }, index: 0 }], object: 'chat.completion.chunk' };
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        }, (err) => {
          res.write(`data: ${JSON.stringify({ error: String(err) })}\n\n`);
        }, (code) => {
          // done
          res.write('data: [DONE]\n\n');
          try { res.end(); } catch (e) {}
          resolveStream();
        });

        req.on('close', () => {
          try { child.kill('SIGKILL'); } catch (e) {}
        });
      }));
      return;
    }

    if (body.functions && Array.isArray(body.functions) && body.functions.length > 0) {
      const result = await enqueue(() => handleFunctionCalling(body, model));
      const now = Math.floor(Date.now() / 1000);
      const id = 'cg-' + crypto.randomBytes(8).toString('hex');
      const text = result.final || '';
      const choice = {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: 'stop'
      };
      res.json({ id, object: 'chat.completion', created: now, model: model || null, choices: [choice], usage: { prompt_tokens: null, completion_tokens: null, total_tokens: null } });
    } else {
      const out = await enqueue(() => invokeLitert(model, prompt, { max_tokens: body.max_tokens, temperature: body.temperature }));
      const now = Math.floor(Date.now() / 1000);
      const id = 'cg-' + crypto.randomBytes(8).toString('hex');
      const text = out.output || '';
      const choice = {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: out.timedOut ? 'length' : 'stop'
      };
      res.json({ id, object: 'chat.completion', created: now, model: model || null, choices: [choice], usage: { prompt_tokens: null, completion_tokens: null, total_tokens: null } });
    }
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// OpenAI-compatible Completions endpoint (basic compatibility)
app.post('/v1/completions', async (req, res) => {
  if (AUTH_TOKEN) {
    const h = req.header('authorization') || '';
    if (h !== `Bearer ${AUTH_TOKEN}`) return res.status(401).json({ error: 'unauthorized' });
  }
  const body = req.body || {};
  const prompt = body.prompt || '';
  if (!prompt) return res.status(400).json({ error: 'prompt required' });

  const model = body.model || DEFAULT_MODEL;
  try {
    const out = await enqueue(() => invokeLitert(model, prompt, { max_tokens: body.max_tokens, temperature: body.temperature }));
    const now = Math.floor(Date.now() / 1000);
    const id = 'cmpl-' + crypto.randomBytes(8).toString('hex');
    const text = out.output || '';
    const choice = { text, index: 0, logprobs: null, finish_reason: out.timedOut ? 'length' : 'stop' };
    res.json({ id, object: 'text_completion', created: now, model: model || null, choices: [choice], usage: { prompt_tokens: null, completion_tokens: null, total_tokens: null } });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

function messagesToPrompt(messages) {
  // Simple conversion: join messages in order with role labels.
  // system messages are placed first, then user/assistant turns.
  return messages.map(m => {
    const role = (m.role || 'user');
    const content = (m.content || m.message || '');
    return `${role.toUpperCase()}: ${content}`;
  }).join('\n\n');
}

async function handleFunctionCalling(body, model) {
  // body: incoming request body containing messages, functions array
  const functions = body.functions || [];
  const messages = body.messages || [];

  // Build a system instruction describing available functions
  let functionsDesc = '';
  if (functions.length) {
    functionsDesc = 'Available functions:\n' + functions.map(f => `- ${f.name}: ${f.description || ''} (schema: ${JSON.stringify(f.parameters || {})})`).join('\n');
  }

  // 1) Ask the model to respond with a JSON tool call if it wants to use a tool.
  // We'll instruct it to output exactly a JSON object like: {"tool_call": {"name":"...","arguments":{...}}}
  const systemPrefix = `When you want to call a function, output EXACTLY a JSON object on its own line with the shape: {"tool_call": {"name": string, "arguments": object}}. Otherwise, respond normally.`;

  const promptParts = [systemPrefix, functionsDesc, messagesToPrompt(messages)];
  const prompt = promptParts.filter(Boolean).join('\n\n');

  // 2) Run model once
  const first = await invokeLitert(model, prompt, { max_tokens: body.max_tokens, temperature: body.temperature });
  const text = first.output || '';

  // Try to extract a JSON tool_call from the output
  const toolCall = extractToolCall(text);
  if (!toolCall) {
    // no tool call, return final assistant text
    return { final: text, toolUsed: null };
  }

  // 3) Execute tool if available in registry
  const toolName = toolCall.name;
  const toolArgs = toolCall.arguments || {};
  let toolResponse = '';
  if (tools[toolName]) {
    try {
      toolResponse = await Promise.resolve(tools[toolName](toolArgs));
    } catch (e) {
      toolResponse = `Tool error: ${String(e)}`;
    }
  } else {
    toolResponse = `Tool not found: ${toolName}`;
  }

  // 4) Send tool response back to model and ask for final answer
  const followupPrompt = `${prompt}\n\n[tool_response]\nname: ${toolName}\nresponse: ${toolResponse}`;
  const second = await invokeLitert(model, followupPrompt, { max_tokens: body.max_tokens, temperature: body.temperature });
  return { final: second.output || '', toolUsed: { name: toolName, arguments: toolArgs, response: toolResponse } };
}

function extractToolCall(text) {
  // Find first JSON object in text that contains tool_call or name+arguments
  const jsonRe = /\{[\s\S]*?\}/m;
  const m = text.match(jsonRe);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[0]);
    if (obj.tool_call) return obj.tool_call;
    if (obj.name && obj.arguments) return { name: obj.name, arguments: obj.arguments };
    return null;
  } catch (e) {
    return null;
  }
}

function invokeLitert(model, prompt, opts) {
  return new Promise((resolve, reject) => {
    const args = buildArgs(model, prompt, opts);
    const child = spawn(LITERT_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let finished = false;

    const timeout = setTimeout(() => {
      if (!finished) {
        finished = true;
        try { child.kill('SIGKILL'); } catch (e) {}
        resolve({ output: stdout, stderr: 'timeout', exitCode: -1, timedOut: true });
      }
    }, REQUEST_TIMEOUT_MS);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('error', (err) => {
      if (finished) return;
      finished = true; clearTimeout(timeout);
      reject(err);
    });

    child.on('close', (code) => {
      if (finished) return;
      finished = true; clearTimeout(timeout);
      resolve({ output: stdout, stderr, exitCode: code || 0, timedOut: false });
    });
  });
}

function invokeLitertStream(model, prompt, opts, onChunk, onError, onClose) {
  const args = buildArgs(model, prompt, opts);
  const child = spawn(LITERT_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  child.stdout.on('data', (d) => {
    try { onChunk(d.toString()); } catch (e) {}
  });
  child.stderr.on('data', (d) => {
    try { onError && onError(d.toString()); } catch (e) {}
  });
  child.on('error', (err) => {
    try { onError && onError(err); } catch (e) {}
  });
  child.on('close', (code) => {
    try { onClose && onClose(code); } catch (e) {}
  });
  return child;
}

app.get('/healthz', (req, res) => res.json({ ok: true, pid: process.pid, host: os.hostname() }));

app.listen(LISTEN_PORT, LISTEN_ADDR, () => {
  console.log(`litert gateway listening on ${LISTEN_ADDR}:${LISTEN_PORT} -> bin=${LITERT_BIN}`);
  const modelDisplay = process.env.LITERT_MODEL || DEFAULT_MODEL || '(none)';
  getPublicIp((ip) => {
    console.log('=== LitertProxy info ===');
    console.log(`IP: ${ip}`);
    if (secretResult && secretResult.created) {
      console.log('AUTH_TOKEN: (generated) ' + process.env.AUTH_TOKEN);
    } else {
      console.log('AUTH_TOKEN: (existing) ' + (process.env.AUTH_TOKEN || '(none)'));
    }
    console.log(`MODEL: ${modelDisplay}`);
    console.log('========================');
  });
});

// Ollama-style endpoint: /api/generate
// Accepts: { model, prompt, stream }
app.post('/api/generate', async (req, res) => {
  const body = req.body || {};
  const model = body.model || DEFAULT_MODEL;
  const prompt = body.prompt || body.input || '';
  if (!prompt) return res.status(400).json({ error: 'prompt required' });

  if (body.stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    await enqueue(() => new Promise((resolveStream) => {
      const child = invokeLitertStream(model, prompt, { max_tokens: body.max_tokens, temperature: body.temperature }, (chunk) => {
        // send JSON line per chunk
        const obj = { id: null, object: 'token', text: chunk };
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
      }, (err) => {
        res.write(`data: ${JSON.stringify({ error: String(err) })}\n\n`);
      }, (code) => {
        res.write('data: [DONE]\n\n');
        try { res.end(); } catch (e) {}
        resolveStream();
      });

      req.on('close', () => { try { child.kill('SIGKILL'); } catch (e) {} });
    }));
    return;
  }

  try {
    const out = await enqueue(() => invokeLitert(model, prompt, { max_tokens: body.max_tokens, temperature: body.temperature }));
    res.json({ model, output: out.output, stderr: out.stderr, exitCode: out.exitCode });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});
