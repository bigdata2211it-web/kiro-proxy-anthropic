// kiro-proxy-anthropic: Anthropic Messages API compatible proxy for Kiro (CodeWhisperer)
// Endpoint: POST /v1/messages
// Auth: x-api-key header OR Authorization: Bearer (any value, we don't check)
// Token source: Kiro CLI local SQLite (cross-platform path detection)

const http = require("http");
const https = require("https");
const crypto = require("crypto");
const path = require("path");
const os = require("os");
const Database = require("better-sqlite3");

const PORT = parseInt(process.env.KIRO_PROXY_PORT || "11437");
const HOST = "q.us-east-1.amazonaws.com";
const DB_PATH = process.env.KIRO_DB_PATH || (() => {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "kiro-cli", "data.sqlite3");
  }
  if (process.platform === "darwin") {
    const xdg = process.env.XDG_DATA_HOME || path.join(home, ".local", "share");
    return path.join(xdg, "kiro-cli", "data.sqlite3");
  }
  const xdg = process.env.XDG_DATA_HOME || path.join(home, ".local", "share");
  return path.join(xdg, "kiro-cli", "data.sqlite3");
})();

// Cross-platform OS identifier for Kiro envState
function kiroOsName() {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "mac";
  return "linux";
}

// Cross-platform temp dir for 400-dump artifacts
const DUMP_DIR = process.env.KIRO_DUMP_DIR || os.tmpdir();

// ─────────────────────────────────────────────────────────────
// Token from Kiro sqlite
// ─────────────────────────────────────────────────────────────
function getToken() {
  const db = new Database(DB_PATH, { readonly: true });
  const row = db.prepare("SELECT value FROM auth_kv WHERE key='kirocli:social:token'").get();
  db.close();
  if (!row) throw new Error("No token in Kiro DB. Run: kiro-cli login");
  return JSON.parse(row.value);
}

// ─────────────────────────────────────────────────────────────
// Incremental AWS Event Stream parser
// ─────────────────────────────────────────────────────────────
class EventStreamParser {
  constructor() { this.buf = Buffer.alloc(0); }
  feed(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    const events = [];
    while (this.buf.length >= 12) {
      const totalLen = this.buf.readUInt32BE(0);
      if (this.buf.length < totalLen) break;
      const headersLen = this.buf.readUInt32BE(4);
      const headerEnd = 12 + headersLen;
      const payloadEnd = totalLen - 4;
      let hp = 12;
      const headers = {};
      while (hp < headerEnd) {
        const nl = this.buf[hp++];
        const name = this.buf.slice(hp, hp + nl).toString(); hp += nl;
        const vt = this.buf[hp++];
        if (vt === 7) {
          const vl = this.buf.readUInt16BE(hp); hp += 2;
          headers[name] = this.buf.slice(hp, hp + vl).toString(); hp += vl;
        } else break;
      }
      events.push({ type: headers[":event-type"], payload: this.buf.slice(headerEnd, payloadEnd).toString() });
      this.buf = this.buf.slice(totalLen);
    }
    return events;
  }
}

// ─────────────────────────────────────────────────────────────
// Model normalization
// ─────────────────────────────────────────────────────────────
const VALID_MODELS = new Set([
  "auto","claude-opus-4.7","claude-opus-4.6","claude-sonnet-4.6","claude-opus-4.5",
  "claude-sonnet-4.5","claude-sonnet-4","claude-haiku-4.5","claude-haiku-4",
  "deepseek-3.2","minimax-m2.5","minimax-m2.1","qwen3-coder-next","glm-5"
]);

// Map Anthropic-style names (claude-opus-4-20250514, claude-3-5-sonnet, claude-sonnet-4-5) to Kiro IDs
function normalizeModel(m) {
  if (!m) return "auto";
  if (VALID_MODELS.has(m)) return m;
  const s = m.toLowerCase();
  // Anthropic patterns first
  if (/claude-opus-4[-.]?7/i.test(s)) return "claude-opus-4.7";
  if (/claude-opus-4[-.]?6/i.test(s)) return "claude-opus-4.6";
  if (/claude-opus-4[-.]?5/i.test(s)) return "claude-opus-4.5";
  if (/claude-opus/i.test(s)) return "claude-opus-4.7";
  if (/claude-sonnet-4[-.]?6/i.test(s)) return "claude-sonnet-4.6";
  if (/claude-sonnet-4[-.]?5/i.test(s)) return "claude-sonnet-4.5";
  if (/claude-sonnet-4/i.test(s)) return "claude-sonnet-4";
  if (/sonnet/i.test(s)) return "claude-sonnet-4.6";
  if (/claude-haiku/i.test(s) || /haiku/i.test(s)) return "claude-haiku-4.5";
  if (/deepseek/i.test(s)) return "deepseek-3.2";
  if (/qwen/i.test(s)) return "qwen3-coder-next";
  if (/glm/i.test(s)) return "glm-5";
  if (/minimax/i.test(s)) return "minimax-m2.5";
  return "auto";
}

// ─────────────────────────────────────────────────────────────
// Anthropic content helpers
// ─────────────────────────────────────────────────────────────
function flattenAnthropicContent(content) {
  // Anthropic content: either string or array of content blocks
  if (typeof content === "string") return { text: content, toolUses: [], toolResults: [] };
  if (!Array.isArray(content)) return { text: "", toolUses: [], toolResults: [] };

  let text = "";
  const toolUses = [];
  const toolResults = [];

  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text") {
      text += (block.text || "") + "\n";
    } else if (block.type === "tool_use") {
      toolUses.push({ id: block.id, name: block.name, input: block.input || {} });
    } else if (block.type === "tool_result") {
      // content may be string or array of blocks
      let resultContent;
      if (typeof block.content === "string") resultContent = block.content;
      else if (Array.isArray(block.content)) {
        resultContent = block.content.map(c => c.type === "text" ? c.text : JSON.stringify(c)).join("\n");
      } else {
        resultContent = JSON.stringify(block.content);
      }
      toolResults.push({ tool_use_id: block.tool_use_id, content: resultContent, is_error: !!block.is_error });
    }
  }
  return { text: text.trim(), toolUses, toolResults };
}

function tryParseJson(s) { try { return JSON.parse(s); } catch { return { result: s }; } }

// CodeWhisperer требует, чтобы toolUseId начинался с "tooluse_"
function normalizeToolUseId(id) {
  if (!id) return `tooluse_${crypto.randomBytes(10).toString("hex")}`;
  if (id.startsWith("tooluse_")) return id;
  const stripped = id.replace(/^(toolu_|call_|tool_)/, "");
  return `tooluse_${stripped}`;
}

function lastAssistantToolIds(history) {
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (h.assistantResponseMessage?.toolUses?.length) {
      return new Set(h.assistantResponseMessage.toolUses.map(t => t.toolUseId));
    }
    if (h.assistantResponseMessage) break;
  }
  return new Set();
}

function filterOrphanToolResults(results, validIds) {
  return results.filter(r => validIds.has(r.toolUseId));
}

// ─────────────────────────────────────────────────────────────
// Anthropic → Kiro conversion
// ─────────────────────────────────────────────────────────────
function anthropicToKiro(body) {
  const { messages, tools: anthropicTools, system } = body;
  const model = normalizeModel(body.model);

  // System prompt: Anthropic allows string or array of {type:"text", text:"..."}
  let systemPrompt = "";
  if (typeof system === "string") systemPrompt = system;
  else if (Array.isArray(system)) {
    systemPrompt = system.map(s => s.type === "text" ? s.text : "").join("\n");
  }

  // Kiro tools format
  const kiroTools = (anthropicTools || []).map(t => ({
    toolSpecification: {
      name: t.name,
      description: t.description || "",
      inputSchema: { json: t.input_schema || { type: "object", properties: {} } }
    }
  }));

  const history = [];
  let pendingUserMessage = null;
  let pendingAssistantMessage = null;
  let pendingToolResults = [];

  for (const msg of messages) {
    const { text, toolUses, toolResults } = flattenAnthropicContent(msg.content);

    if (msg.role === "user") {
      // Flush pending assistant + tool results as a pair
      if (pendingAssistantMessage) {
        history.push({ assistantResponseMessage: pendingAssistantMessage });
        pendingAssistantMessage = null;
      }
      if (pendingToolResults.length) {
        const validIds = lastAssistantToolIds(history);
        const kept = filterOrphanToolResults(pendingToolResults, validIds);
        if (kept.length) {
          history.push({ userInputMessage: { content: "", userInputMessageContext: { toolResults: kept }, origin: "KIRO_CLI", modelId: model } });
        }
        pendingToolResults = [];
      }
      // Flush any pending user message
      if (pendingUserMessage) { history.push({ userInputMessage: pendingUserMessage }); pendingUserMessage = null; }

      if (toolResults.length) {
        for (const tr of toolResults) {
          pendingToolResults.push({
            toolUseId: normalizeToolUseId(tr.tool_use_id),
            content: [{ json: tryParseJson(tr.content) }],
            status: tr.is_error ? "error" : "success"
          });
        }
      }

      if (text) {
        pendingUserMessage = { content: text, userInputMessageContext: {}, origin: "KIRO_CLI", modelId: model };
      } else if (toolResults.length && !pendingUserMessage) {
        pendingUserMessage = { content: "", userInputMessageContext: {}, origin: "KIRO_CLI", modelId: model };
      }
    } else if (msg.role === "assistant") {
      // Flush pending assistant + tool results as a pair, then pending user
      if (pendingAssistantMessage) {
        history.push({ assistantResponseMessage: pendingAssistantMessage });
        pendingAssistantMessage = null;
      }
      if (pendingToolResults.length) {
        const validIds = lastAssistantToolIds(history);
        const kept = filterOrphanToolResults(pendingToolResults, validIds);
        if (kept.length) {
          history.push({ userInputMessage: { content: pendingUserMessage ? pendingUserMessage.content : "", userInputMessageContext: { toolResults: kept }, origin: "KIRO_CLI", modelId: model } });
        } else if (pendingUserMessage && pendingUserMessage.content) {
          history.push({ userInputMessage: { ...pendingUserMessage } });
        }
        pendingToolResults = [];
        pendingUserMessage = null;
      } else if (pendingUserMessage) {
        history.push({ userInputMessage: pendingUserMessage });
        pendingUserMessage = null;
      }
      const assistantMsg = { messageId: crypto.randomUUID(), content: text };
      if (toolUses.length) {
        assistantMsg.toolUses = toolUses.map(tu => ({
          toolUseId: normalizeToolUseId(tu.id),
          name: tu.name,
          input: tu.input
        }));
      }
      // Не пушим пустого ассистента
      if (!assistantMsg.content && !assistantMsg.toolUses) {
        assistantMsg.content = ".";
      }
      pendingAssistantMessage = assistantMsg;
    }
  }

  // Flush leftover assistant
  if (pendingAssistantMessage) {
    history.push({ assistantResponseMessage: pendingAssistantMessage });
    pendingAssistantMessage = null;
  }

  // Build currentMessage from last user message
  const userContext = { envState: { operatingSystem: kiroOsName(), currentWorkingDirectory: process.cwd() } };
  if (kiroTools.length) userContext.tools = kiroTools;
  if (pendingToolResults.length) {
    const validIds = lastAssistantToolIds(history);
    const kept = filterOrphanToolResults(pendingToolResults, validIds);
    if (kept.length) userContext.toolResults = kept;
    else pendingToolResults = []; // сброс сирот
  }

  let currentMessage;
  if (pendingUserMessage) {
    let content = pendingUserMessage.content;
    if (systemPrompt && history.length === 0) {
      content = systemPrompt + "\n\n" + content;
    }
    if (!content) content = userContext.toolResults ? "continue" : "."; // Kiro требует непустой content
    currentMessage = {
      userInputMessage: {
        content,
        userInputMessageContext: userContext,
        origin: "KIRO_CLI",
        modelId: model
      }
    };
  } else if (pendingToolResults.length) {
    currentMessage = {
      userInputMessage: {
        content: "continue",
        userInputMessageContext: userContext,
        origin: "KIRO_CLI",
        modelId: model
      }
    };
  } else {
    currentMessage = {
      userInputMessage: {
        content: systemPrompt || ".",
        userInputMessageContext: userContext,
        origin: "KIRO_CLI",
        modelId: model
      }
    };
  }

  return {
    conversationState: {
      conversationId: crypto.randomUUID(),
      history,
      currentMessage,
      chatTriggerType: "MANUAL",
      agentTaskType: "vibe"
    }
  };
}

// ─────────────────────────────────────────────────────────────
// HTTP Server
// ─────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") { res.writeHead(200); res.end(); return; }

  if (req.url === "/health") { res.writeHead(200); res.end("ok"); return; }

  // Anthropic doesn't have a public /v1/models, but we expose one for tooling
  if (req.url === "/v1/models" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      data: [...VALID_MODELS].map(id => ({
        type: "model",
        id,
        display_name: id,
        created_at: new Date().toISOString()
      })),
      has_more: false
    }));
    return;
  }

  if (req.url.startsWith("/v1/messages") && req.method === "POST") {
    let raw = "";
    req.on("data", c => raw += c);
    req.on("end", () => {
      let parsed;
      try { parsed = JSON.parse(raw); } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Invalid JSON" } }));
        return;
      }

      let tokenData;
      try { tokenData = getToken(); } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: e.message } }));
        return;
      }

      const kiroReq = anthropicToKiro(parsed);
      kiroReq.profileArn = tokenData.profile_arn;
      const body = JSON.stringify(kiroReq);
      const model = normalizeModel(parsed.model);
      const msgId = `msg_${crypto.randomBytes(12).toString("hex")}`;
      const streaming = parsed.stream === true;

      const opts = {
        hostname: HOST, port: 443, path: "/", method: "POST",
        headers: {
          "content-type": "application/x-amz-json-1.0",
          "x-amz-target": "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
          "authorization": `Bearer ${tokenData.access_token}`,
          "content-length": Buffer.byteLength(body)
        }
      };

      const proxyReq = https.request(opts, (proxyRes) => {
        if (proxyRes.statusCode !== 200) {
          let err = "";
          proxyRes.on("data", d => err += d);
          proxyRes.on("end", () => {
            console.error(`[KIRO] ${proxyRes.statusCode}: ${err.slice(0, 300)}`);
            if (proxyRes.statusCode === 400) {
              try {
                const fs = require("fs");
                const dumpPath = path.join(DUMP_DIR, `kiro-proxy-anthropic-400-${Date.now()}.json`);
                fs.writeFileSync(dumpPath, JSON.stringify({ incoming: parsed, outgoing: kiroReq, err }, null, 2));
                console.error(`[KIRO] 400 dump -> ${dumpPath}`);
              } catch (e) { console.error("[KIRO] dump fail:", e.message); }
            }
            res.writeHead(proxyRes.statusCode, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              type: "error",
              error: { type: "api_error", message: err.slice(0, 400) }
            }));
          });
          return;
        }

        if (streaming) {
          // Anthropic SSE format
          // Events: message_start, content_block_start, content_block_delta, content_block_stop, message_delta, message_stop, ping
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive"
          });

          const sendEvent = (event, data) => {
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          };

          // message_start
          sendEvent("message_start", {
            type: "message_start",
            message: {
              id: msgId, type: "message", role: "assistant", model,
              content: [], stop_reason: null, stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 }
            }
          });

          const parser = new EventStreamParser();
          let textBlockIndex = -1;
          let textBlockStarted = false;
          const toolBlocks = new Map(); // toolUseId → { index, started, accumulated }
          let blockCounter = 0;
          let stopReason = "end_turn";

          proxyRes.on("data", (chunk) => {
            const events = parser.feed(chunk);
            for (const e of events) {
              if (e.type === "assistantResponseEvent") {
                try {
                  const d = JSON.parse(e.payload);
                  if (d.content) {
                    if (!textBlockStarted) {
                      textBlockIndex = blockCounter++;
                      sendEvent("content_block_start", {
                        type: "content_block_start",
                        index: textBlockIndex,
                        content_block: { type: "text", text: "" }
                      });
                      textBlockStarted = true;
                    }
                    sendEvent("content_block_delta", {
                      type: "content_block_delta",
                      index: textBlockIndex,
                      delta: { type: "text_delta", text: d.content }
                    });
                  }
                } catch {}
              } else if (e.type === "toolUseEvent") {
                try {
                  const d = JSON.parse(e.payload);
                  if (!toolBlocks.has(d.toolUseId)) {
                    // Close text block if it was open
                    if (textBlockStarted) {
                      sendEvent("content_block_stop", { type: "content_block_stop", index: textBlockIndex });
                      textBlockStarted = false;
                    }
                    // Start new tool_use block
                    const idx = blockCounter++;
                    toolBlocks.set(d.toolUseId, { index: idx });
                    sendEvent("content_block_start", {
                      type: "content_block_start",
                      index: idx,
                      content_block: { type: "tool_use", id: d.toolUseId, name: d.name, input: {} }
                    });
                    stopReason = "tool_use";
                  }
                  if (d.input !== undefined && d.input !== "") {
                    const tb = toolBlocks.get(d.toolUseId);
                    sendEvent("content_block_delta", {
                      type: "content_block_delta",
                      index: tb.index,
                      delta: { type: "input_json_delta", partial_json: d.input }
                    });
                  }
                  if (d.stop) {
                    const tb = toolBlocks.get(d.toolUseId);
                    sendEvent("content_block_stop", { type: "content_block_stop", index: tb.index });
                  }
                } catch {}
              }
            }
          });

          proxyRes.on("end", () => {
            // Close any still-open blocks
            if (textBlockStarted) {
              sendEvent("content_block_stop", { type: "content_block_stop", index: textBlockIndex });
            }
            // message_delta + message_stop
            sendEvent("message_delta", {
              type: "message_delta",
              delta: { stop_reason: stopReason, stop_sequence: null },
              usage: { output_tokens: 0 }
            });
            sendEvent("message_stop", { type: "message_stop" });
            res.end();
          });

          proxyRes.on("error", (e) => {
            console.error("[KIRO] stream err:", e.message);
            try { res.end(); } catch {}
          });
        } else {
          // Non-streaming: buffer everything, return single Anthropic message response
          const chunks = [];
          proxyRes.on("data", d => chunks.push(d));
          proxyRes.on("end", () => {
            const parser = new EventStreamParser();
            const events = parser.feed(Buffer.concat(chunks));
            const textParts = [];
            const toolCallsById = new Map();

            for (const e of events) {
              if (e.type === "assistantResponseEvent") {
                try {
                  const d = JSON.parse(e.payload);
                  if (d.content) textParts.push(d.content);
                } catch {}
              } else if (e.type === "toolUseEvent") {
                try {
                  const d = JSON.parse(e.payload);
                  if (!toolCallsById.has(d.toolUseId)) {
                    toolCallsById.set(d.toolUseId, { id: d.toolUseId, name: d.name, parts: [] });
                  }
                  if (d.input !== undefined) toolCallsById.get(d.toolUseId).parts.push(d.input);
                } catch {}
              }
            }

            const content = [];
            if (textParts.length > 0 && textParts.join("")) {
              content.push({ type: "text", text: textParts.join("") });
            }
            for (const tc of toolCallsById.values()) {
              let input = {};
              try { input = JSON.parse(tc.parts.join("") || "{}"); } catch {}
              content.push({ type: "tool_use", id: tc.id, name: tc.name, input });
            }

            const stopReason = toolCallsById.size > 0 ? "tool_use" : "end_turn";

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              id: msgId,
              type: "message",
              role: "assistant",
              model,
              content,
              stop_reason: stopReason,
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 }
            }));
          });
        }
      });

      proxyReq.on("error", e => {
        console.error("[KIRO] err:", e.message);
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: e.message } }));
      });
      proxyReq.write(body);
      proxyReq.end();
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "Not found" } }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[kiro-proxy-anthropic] listening http://127.0.0.1:${PORT}`);
  console.log(`[kiro-proxy-anthropic] Anthropic Messages API compatible (POST /v1/messages)`);
});
