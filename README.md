# LitertProxy

This is a lightweight Node.js gateway that proxies HTTP requests to the `litert-lm` CLI. Deploy this on a VM where `litert-lm` is installed and access it from other services (e.g., Copilot integrations).

Usage

1. Install `litert-lm` on the host or inside the container (see the LiteRT docs).
2. Configure environment variables:

- `LITERT_BIN` (default `litert-lm`)
- `LITERT_MODEL` (optional default model name)
- `AUTH_TOKEN` (optional bearer token for simple auth)
 - `AUTH_TOKEN` (optional bearer token for simple auth)
 - `AUTH_REQUIRED` (optional: set to `false` or `0` to disable auth checks and allow anonymous access)
- `LISTEN_ADDR` (default `0.0.0.0`)
- `LISTEN_PORT` (default `8080`)
- `MAX_CONCURRENCY` (default `4`)
- `REQUEST_TIMEOUT_MS` (default `120000` milliseconds)

Quick run (host has `litert-lm` installed):

```bash
npm ci
AUTH_TOKEN=secret LITERT_MODEL=gemma-4-E2B-it.litertlm node index.js
```

Run in background (manual Node.js)

```bash
# start foreground
npm ci
AUTH_TOKEN=secret LITERT_MODEL=gemma-4-E2B-it.litertlm node index.js

# or start in background with nohup
nohup AUTH_TOKEN=secret LITERT_MODEL=gemma-4-E2B-it.litertlm npm start >/dev/null 2>&1 &

# or use pm2 for process management
npm install -g pm2
pm2 start index.js --name litertproxy --update-env
```

API

- POST /v1/generate
  - body: { "prompt": "...", "model": "name(optional)", "max_tokens": 256, "temperature": 0.7 }
  - response: { "output": "...", "stderr": "...", "exitCode": 0, "timedOut": false }

- GET /healthz

OpenAI-compatible endpoints

- POST /v1/chat/completions
  - body: { "model": "...", "messages": [{"role":"system|user|assistant","content":"..."}], "max_tokens": 256 }
  - response (partial): { "id": "cg-...", "object": "chat.completion", "created": 123, "model": "...", "choices": [{ "index":0, "message": {"role":"assistant","content":"..."} }], "usage": {...} }

- POST /v1/completions
  - body: { "model": "...", "prompt": "...", "max_tokens": 256 }
  - response (partial): { "id": "cmpl-...", "object": "text_completion", "created": 123, "model": "...", "choices": [{ "text": "..." }] }

Example: Chat completion via curl

```bash
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -d '{"model":"gemma-4-E2B-it.litertlm","messages":[{"role":"system","content":"You are helpful."},{"role":"user","content":"Say hello"}] }'
```

Streaming examples

OpenAI-style streaming (chat completions): add `"stream": true` to the body. The endpoint will emit SSE events containing JSON chunks with token deltas and end with `data: [DONE]`.

```bash
curl -N -X POST http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -d '{"model":"gemma-4-E2B-it.litertlm","stream": true,"messages":[{"role":"user","content":"Hello"}] }'
```

Ollama-style streaming (`/api/generate`): request with `stream: true` and read SSE JSON lines.

```bash
curl -N -X POST http://localhost:8080/api/generate \
  -H "Content-Type: application/json" \
  -d '{"model":"gemma-4-E2B-it.litertlm","stream": true,"prompt":"Say hi" }'
```

Models endpoint

GET `/api/models` returns a JSON list of models the gateway exposes. By default the gateway reads `LITERT_MODEL` (single) or `LITERT_MODELS` (comma-separated list) from the environment.

Example:

```bash
curl http://localhost:8080/api/models
```

Response:

```json
{ "models": [ { "id": "gemma-4-E2B-it.litertlm", "name": "gemma-4-E2B-it.litertlm", "description": "Proxy to LiteRT model gemma-4-E2B-it.litertlm", "default": true } ] }
```

**Copilot integration (quickstart)**

1) Run LitertProxy on your VM or local machine.

```bash
# install deps
npm ci
# start (reads .env)
AUTH_TOKEN=replace_me_with_a_strong_secret LITERT_MODEL=gemma-4-E2B-it.litertlm npm start
```

Run manually or with a process manager (no Docker required):

```bash
# start directly
npm ci
AUTH_TOKEN=replace_me_with_a_strong_secret LITERT_MODEL=gemma-4-E2B-it.litertlm npm start

# or run in background
nohup AUTH_TOKEN=replace_me_with_a_strong_secret npm start >/dev/null 2>&1 &

# or use pm2
pm2 start index.js --name litertproxy --update-env
```

2) Keep the gateway running automatically (options):

- Systemd unit (create `/etc/systemd/system/litertproxy.service`):

```
[Unit]
; LitertProxy service
Description=LitertProxy gateway
After=network.target

[Service]
Type=simple
User=litert
WorkingDirectory=/opt/litertproxy
Environment=AUTH_TOKEN=replace_me_with_a_strong_secret
Environment=LITERT_MODEL=gemma-4-E2B-it.litertlm
ExecStart=/usr/bin/node /opt/litertproxy/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

- Cron-style restart (not recommended for production):

Add to crontab (`crontab -e`) to ensure the process is running every 5 minutes:

```cron
*/5 * * * * pgrep -f "node .*index.js" > /dev/null || (cd /opt/litertproxy && AUTH_TOKEN=replace_me_with_a_strong_secret nohup npm start >/dev/null 2>&1 &)
```

3) Configure Copilot / tools to use LitertProxy

- OpenAI-compatible clients (quick): set environment variables so tools that read OpenAI vars will use your gateway:

```bash
export OPENAI_API_BASE="http://localhost:8080/v1"
export OPENAI_API_KEY="replace_me_with_a_strong_secret"
```

Restart VS Code so the Copilot extension picks up environment changes. Many editors and tools respect `OPENAI_API_BASE` and `OPENAI_API_KEY`.

- Ollama-compatible clients: if a client (or Copilot UI) lets you add an Ollama endpoint, point it to `http://<host>:8080/api/generate` and use the token from `AUTH_TOKEN` as the API key.

4) Using Copilot features (agentic planning, tools)

- LitertProxy supports OpenAI-style `functions` and streaming, which Copilot uses for agent-like flows. To enable tool use, ensure `tools.js` exposes safe tools with names and JSON schemas. Copilot's agentic features will call those functions via the `functions` field.
- For workspace automation (plan mode), require the extension or Copilot to send `functions` and `messages` and read streaming deltas — LitertProxy will proxy those to the model and run tools.

Security notes

- Never commit your `.env` to source control. Use OS-level secrets or a secrets manager in production.
- Prefer `systemd` or a container orchestrator over cron for reliability.
- For production, run LitertProxy behind an authenticated TLS reverse proxy (nginx, Caddy) and restrict access to your network.

If you want, I can add a ready-to-use `/api/models` endpoint and a short VS Code Copilot UI walkthrough showing exactly where to paste the base URL and key.

Function-calling / Tools

This gateway supports a simple function-calling flow compatible with OpenAI's `functions` field. Provide a `functions` array in the `/v1/chat/completions` request and the gateway will:

- Ask the model if it wants to call a function (the model should emit a JSON `tool_call`).
- If a `tool_call` is found, the gateway runs the matching tool from `tools.js`.
- The tool result is sent back to the model and a final assistant response is returned.

Example request (tools):

```json
POST /v1/chat/completions
{
  "model":"gemma-4-E2B-it.litertlm",
  "messages":[{"role":"system","content":"You can call tools."},{"role":"user","content":"What time is it?"}],
  "functions":[{"name":"get_current_time","description":"Returns current time","parameters":{"type":"object","properties":{}}}]
}
```

The gateway ships with `tools.js` containing safe example tools: `get_current_time` and `echo`. Edit `tools.js` to add your own tools; be cautious when adding tools that execute shell commands.


Security & deployment notes

- This gateway uses a simple bearer `AUTH_TOKEN` for access control; put it behind a firewall or reverse proxy (nginx) for production and enable TLS.
- For high performance, run one gateway per GPU/CPU partition and tune `MAX_CONCURRENCY` to avoid CPU contention.
-- Consider running a systemd service or a process manager like `pm2` to manage restarts.
