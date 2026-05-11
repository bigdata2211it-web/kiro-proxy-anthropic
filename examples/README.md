# Examples

Small, self-contained examples of system instruction packs you can load
into the proxy.

Each folder contains plain markdown files plus a `system-instructions.json`
pointing at them.

## How to use

Pick one and copy it as your active config. For example, `persona`:

```bash
# Option A — put it in the default location
mkdir -p ~/.config/kiro-proxy-anthropic
cp examples/persona/system-instructions.json ~/.config/kiro-proxy-anthropic/system-instructions.json
# Then edit the "path" entries inside to point at absolute locations of your files,
# or keep them relative to the config file.
```

```bash
# Option B — point the proxy at this example directly
KIRO_PROXY_INSTRUCTIONS_CONFIG=$(pwd)/examples/persona/system-instructions.json \
  node index.js
```

Check what the proxy loaded:

```bash
curl -s http://127.0.0.1:11437/debug/instructions | jq .
```

## What's in each example

- `minimal/` — a tiny "be helpful, be concise" assistant pack.
- `coding/` — rules for code writing and review.
- `persona/` — a custom engineer persona with a direct tone.

## Making your own

The format is boring on purpose: a JSON file with a list of text files to load.

```json
{
  "enabled": true,
  "mode": "prepend",
  "files": [
    { "path": "/absolute/path/to/your/AGENTS.md", "required": true },
    { "path": "./some-other-rules.md", "required": false }
  ]
}
```

Modes:

- `prepend` — your content goes before whatever system prompt the client sent (default).
- `append` — your content goes after.
- `replace` — ignore the client's system prompt entirely, use only yours.
- `off` — passthrough, do nothing.

Per-request override is available via the `X-Proxy-Instructions` HTTP header
with the same values (`off` / `prepend` / `append` / `replace` / `only`).
