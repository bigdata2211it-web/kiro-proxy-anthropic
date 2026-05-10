# kiro-proxy-anthropic

**Anthropic Messages API compatible** local proxy for **Kiro CLI** (Amazon CodeWhisperer / Amazon Q).

Drop-in replacement for the Anthropic API — any client that normally talks to `api.anthropic.com` can talk to this proxy instead and get **free access** to Claude Opus 4.7, Sonnet 4.6, Haiku 4.5 and more, via your Kiro login.

> Works with **Claude Code**, **Claude Desktop** (via `ANTHROPIC_BASE_URL`), Cursor, and any SDK/tool built on `@anthropic-ai/sdk` or the raw Messages API.

## Why this exists

- Kiro CLI ships with free access to Claude flagship models (Opus 4.7 with 1M context and more).
- Kiro's wire protocol is proprietary (`AmazonCodeWhispererStreamingService.GenerateAssistantResponse`), not compatible with standard clients.
- This proxy speaks **native Anthropic Messages API** on the outside, so you can plug it into Claude Code or Claude Desktop without forking them.

There's also a sibling OpenAI-compatible version: [kiro-proxy](https://github.com/bigdata2211it-web/kiro-proxy).

## Features

- ✅ `POST /v1/messages` — full Anthropic Messages API (streaming + non-streaming)
- ✅ Proper Anthropic SSE events: `message_start`, `content_block_start/delta/stop`, `message_delta`, `message_stop`
- ✅ **Tool use** in Anthropic native format (`tool_use`, `tool_result` blocks, `input_json_delta` streaming)
- ✅ System prompts (string or array of content blocks)
- ✅ Multi-turn history with Anthropic `content` arrays
- ✅ Model aliases — `claude-opus-4-5-20250514` maps to Kiro's `claude-opus-4.5`, etc.
- ✅ Bearer auth read directly from Kiro's local SQLite — no re-login

## Models

| Anthropic alias / Kiro ID | Context | Rate |
|---|---|---|
| `claude-opus-4.7` | 1M | 2.2x |
| `claude-opus-4.6` | 1M | 2.2x |
| `claude-sonnet-4.6` | 1M | 1.3x |
| `claude-opus-4.5` | 200K | 2.2x |
| `claude-sonnet-4.5` | 200K | 1.3x |
| `claude-sonnet-4` | 200K | 1.3x |
| `claude-haiku-4.5` | 200K | 0.4x |
| `auto` | 1M | 1.0x |

Plus non-Anthropic models exposed as-is: `deepseek-3.2`, `qwen3-coder-next`, `glm-5`, `minimax-m2.5`.

Also accepts Anthropic-style dated IDs (`claude-sonnet-4-5-20250514`, `claude-opus-4-20250514`) — normalized automatically.

## Requirements

- Node.js 18+
- Kiro CLI logged in (`kiro-cli login`). Get it from [kiro.dev](https://kiro.dev).

## Install

```bash
git clone https://github.com/bigdata2211it-web/kiro-proxy-anthropic.git
cd kiro-proxy-anthropic
npm install
node index.js
```

Listens on `http://127.0.0.1:11437` (override with `KIRO_PROXY_PORT`).

## Use with Claude Code

Claude Code reads `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY`:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:11437
export ANTHROPIC_API_KEY=dummy
claude "refactor this function"
```

Or add to `~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:11437",
    "ANTHROPIC_API_KEY": "dummy"
  }
}
```

## Use with Anthropic SDK

```python
from anthropic import Anthropic
client = Anthropic(base_url="http://127.0.0.1:11437", api_key="dummy")
msg = client.messages.create(
    model="claude-sonnet-4.6",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hi"}]
)
print(msg.content[0].text)
```

```typescript
import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic({ baseURL: "http://127.0.0.1:11437", apiKey: "dummy" });
```

## Use with curl

```bash
# Non-streaming
curl http://127.0.0.1:11437/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-opus-4.7",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello"}]
  }'

# Streaming
curl -N http://127.0.0.1:11437/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4.6",
    "max_tokens": 1024,
    "stream": true,
    "messages": [{"role": "user", "content": "Count to 5"}]
  }'

# With tools
curl http://127.0.0.1:11437/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4.6",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "list files in /tmp"}],
    "tools": [{
      "name": "list_files",
      "description": "List files in a directory",
      "input_schema": {
        "type": "object",
        "required": ["path"],
        "properties": {"path": {"type": "string"}}
      }
    }]
  }'
```

## systemd autostart

`~/.config/systemd/user/kiro-proxy-anthropic.service`:

```ini
[Unit]
Description=Kiro → Anthropic API Proxy
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/node /path/to/kiro-proxy-anthropic/index.js
Restart=on-failure
RestartSec=5
Environment=KIRO_PROXY_PORT=11437

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now kiro-proxy-anthropic
```

## Token refresh

Kiro tokens expire ~1h; any `kiro-cli` call refreshes them:

```cron
*/45 * * * * /path/to/kiro-cli chat --no-interactive "ping" >/dev/null 2>&1
```

## How it works

```
Claude Code / Anthropic SDK
    ↓ POST /v1/messages  { messages, tools, stream }
kiro-proxy-anthropic
    ↓ reads Kiro access_token from sqlite
    ↓ Anthropic format → Kiro conversationState
    ↓ POST https://q.us-east-1.amazonaws.com/  (Bearer auth)
Amazon CodeWhisperer
    ↓ binary AWS Event Stream
kiro-proxy-anthropic
    ↓ parses events into Anthropic SSE (content_block_delta, …)
Claude Code / SDK
```

Full Kiro wire protocol documentation: [PROTOCOL.md](./PROTOCOL.md) (same as the OpenAI-compatible sibling).

## Ports

- `11436` — [kiro-proxy](https://github.com/bigdata2211it-web/kiro-proxy) (OpenAI `/v1/chat/completions`)
- `11437` — **kiro-proxy-anthropic** (Anthropic `/v1/messages`)

Run both simultaneously if you need both APIs.

## Limits

- **Vision / images**: not implemented yet
- **Extended thinking** (Opus 4.7 adaptive thinking): not exposed as `thinking` blocks
- **Rate limits**: whatever Kiro's credit pool allows
- **Prompt caching blocks** (`cache_control`): accepted but not propagated (Kiro has its own server-side caching)

## License

MIT
