# Kiro → CodeWhisperer Wire Protocol

Reverse-engineered notes on how the Kiro CLI talks to `q.us-east-1.amazonaws.com` (the "Amazon Q / CodeWhisperer Streaming" endpoint). This is what `kiro-proxy` speaks.

## Endpoint

```
POST https://q.us-east-1.amazonaws.com/
Content-Type: application/x-amz-json-1.0
X-Amz-Target: AmazonCodeWhispererStreamingService.GenerateAssistantResponse
Authorization: Bearer <access_token>
```

Bearer token: read from the Kiro local SQLite DB (`~/.local/share/kiro-cli/data.sqlite3` on Linux), table `auth_kv`, key `kirocli:social:token`, field `access_token`. SigV4 is **not** required — the endpoint also accepts bearer tokens.

## List models

```
POST https://q.us-east-1.amazonaws.com/
X-Amz-Target: AmazonCodeWhispererService.ListAvailableModels
Body: {"origin": "KIRO_CLI", "profileArn": "arn:aws:codewhisperer:us-east-1:<account>:profile/<id>"}
```

Response:

```json
{
  "defaultModel": {"modelId": "auto"},
  "models": [
    {
      "modelId": "claude-opus-4.7",
      "rateMultiplier": 2.2,
      "tokenLimits": {"maxInputTokens": 1000000, "maxOutputTokens": 64000},
      "supportedInputTypes": ["TEXT", "IMAGE"]
    },
    ...
  ]
}
```

## Chat request

```json
{
  "conversationState": {
    "conversationId": "uuid-v4",
    "history": [
      {"userInputMessage": {...}},
      {"assistantResponseMessage": {...}},
      ...
    ],
    "currentMessage": {"userInputMessage": {...}},
    "chatTriggerType": "MANUAL",
    "agentTaskType": "vibe"
  },
  "profileArn": "arn:aws:codewhisperer:us-east-1:<account>:profile/<id>"
}
```

### userInputMessage

```json
{
  "content": "user text (may be empty when only toolResults are sent)",
  "userInputMessageContext": {
    "envState": {
      "operatingSystem": "linux",
      "currentWorkingDirectory": "/path"
    },
    "tools": [...],         // first turn (tool definitions)
    "toolResults": [...]    // when replying to a tool_use from the assistant
  },
  "origin": "KIRO_CLI",
  "modelId": "auto"
}
```

### tools

```json
{
  "toolSpecification": {
    "name": "tool_name",
    "description": "...",
    "inputSchema": {
      "json": {
        "type": "object",
        "required": ["param"],
        "properties": {...}
      }
    }
  }
}
```

### toolResults

```json
{
  "toolUseId": "tooluse_xxxxx",
  "content": [{"json": {...}}],
  "status": "success"
}
```

### assistantResponseMessage (in history)

Plain text:
```json
{"content": "text response"}
```

With tool use:
```json
{
  "messageId": "uuid",
  "content": "",
  "toolUses": [
    {
      "toolUseId": "tooluse_xxxxx",
      "name": "tool_name",
      "input": {...}
    }
  ]
}
```

## Response (AWS Event Stream — binary)

Each frame:
```
[4B total_len][4B headers_len][4B prelude_crc][headers][payload][4B message_crc]
```

Header format:
```
[1B name_len][name][1B type][...value]

  type=7  → string, [2B val_len][value]
```

### Event types

- **`initial-response`** → `{"conversationId": ""}`
- **`assistantResponseEvent`** → `{"content": "text chunk", "modelId": "auto"}` (emitted multiple times for streaming text)
- **`toolUseEvent`** (streaming in parts):
  - start:  `{"name": "tool_name", "toolUseId": "tooluse_xxx"}`
  - chunks: `{"input": "partial JSON string", "name": "...", "toolUseId": "..."}`
  - end:    `{"name": "...", "stop": true, "toolUseId": "..."}`
- **`contextUsageEvent`** → `{"contextUsagePercentage": 8.2}`
- **`meteringEvent`** → `{"unit": "credit", "usage": 0.228}`

### Reassembling a tool call

Tool call arguments are streamed as string chunks that, concatenated, form valid JSON:

```python
chunks_by_id = {}
for event in events:
    if event.type == "toolUseEvent":
        d = json.loads(event.payload)
        tc = chunks_by_id.setdefault(d['toolUseId'], {'name': d['name'], 'input_parts': []})
        if 'input' in d:
            tc['input_parts'].append(d['input'])

for id, tc in chunks_by_id.items():
    arguments = ''.join(tc['input_parts'])  # valid JSON
```

## Known models (May 2026)

| Model ID | Input | Output | Rate |
|---|---|---|---|
| `auto` | 1M | 64K | 1.0x |
| `claude-opus-4.7` | 1M | 64K | 2.2x |
| `claude-opus-4.6` | 1M | 64K | 2.2x |
| `claude-sonnet-4.6` | 1M | 64K | 1.3x |
| `claude-opus-4.5` | 200K | 64K | 2.2x |
| `claude-sonnet-4.5` | 200K | 64K | 1.3x |
| `claude-sonnet-4` | 200K | 64K | 1.3x |
| `claude-haiku-4.5` | 200K | 64K | 0.4x |
| `deepseek-3.2` | 164K | 64K | 0.25x |
| `minimax-m2.5` | 196K | 64K | 0.25x |
| `minimax-m2.1` | 196K | 64K | 0.15x |
| `qwen3-coder-next` | 256K | 64K | 0.05x |
| `glm-5` | 200K | 64K | 0.5x |

Rate is the credit multiplier on the Kiro subscription.

## Auth flow

1. `kiro-cli login` → OAuth device flow (Google/GitHub via `prod.us-east-1.auth.desktop.kiro.dev`) → `access_token` + `refresh_token`
2. Tokens are persisted in the local SQLite DB (`auth_kv` table, key `kirocli:social:token`)
3. `access_token` is used as `Authorization: Bearer` for all CodeWhisperer calls
4. On expiry, `kiro-cli` silently refreshes via the auth endpoint
