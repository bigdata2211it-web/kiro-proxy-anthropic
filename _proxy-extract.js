
const crypto = require("crypto");
const os = require("os");
const path = require("path");
const fs = require("fs");
const systemInstructions = require("/home/debian/github/bigdata2211it-web/kiro-proxy-anthropic/system-instructions");

const VALID_MODELS = new Set([
  "auto","claude-opus-4.7","claude-opus-4.6","claude-sonnet-4.6","claude-opus-4.5",
  "claude-sonnet-4.5","claude-sonnet-4","claude-haiku-4.5","claude-haiku-4",
  "deepseek-3.2","minimax-m2.5","minimax-m2.1","qwen3-coder-next","glm-5"
]);

function normalizeModel(m) {
  if (!m) return "auto";
  if (VALID_MODELS.has(m)) return m;
  const s = m.toLowerCase();
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
function normalizeModel(m) {
  if (!m) return "auto";
  if (VALID_MODELS.has(m)) return m;
  const s = m.toLowerCase();
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
function flattenAnthropicContent(content) {
  if (typeof content === "string") return { text: content, toolUses: [], toolResults: [] };
  if (!Array.isArray(content)) return { text: "", toolUses: [], toolResults: [] };
  let text = "";
  const toolUses = [], toolResults = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text") text += (block.text || "") + "\n";
    else if (block.type === "tool_use") toolUses.push({ id: block.id, name: block.name, input: block.input || {} });
    else if (block.type === "tool_result") {
      let rc;
      if (typeof block.content === "string") rc = block.content;
      else if (Array.isArray(block.content)) rc = block.content.map(c => c.type === "text" ? c.text : JSON.stringify(c)).join("\n");
      else rc = JSON.stringify(block.content);
      toolResults.push({ tool_use_id: block.tool_use_id, content: rc, is_error: !!block.is_error });
    }
  }
  return { text: text.trim(), toolUses, toolResults };
}
function tryParseJson(s) { try { return JSON.parse(s); } catch { return { result: s }; } }

function normalizeToolUseId(id) {
  if (!id) return `tooluse_${crypto.randomBytes(10).toString("hex")}`;
  if (id.startsWith("tooluse_")) return id;
  return `tooluse_${id.replace(/^(toolu_|call_|tool_)/, "")}`;
}
function normalizeToolUseId(id) {
  if (!id) return `tooluse_${crypto.randomBytes(10).toString("hex")}`;
  if (id.startsWith("tooluse_")) return id;
  return `tooluse_${id.replace(/^(toolu_|call_|tool_)/, "")}`;
}
function lastAssistantToolIds(history) {
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (h.assistantResponseMessage?.toolUses?.length)
      return new Set(h.assistantResponseMessage.toolUses.map(t => t.toolUseId));
    if (h.assistantResponseMessage) break;
  }
  return new Set();
}
function filterOrphanToolResults(results, validIds) {
  return results.filter(r => validIds.has(r.toolUseId));
}
function kiroOsName() {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "mac";
  return "linux";
}
function anthropicToKiro(body, overrideModel, instructionsHeader) {
  const { messages, tools: anthropicTools, system } = body;
  const model = overrideModel || normalizeModel(body.model);

  let systemPrompt = "";
  if (typeof system === "string") systemPrompt = system;
  else if (Array.isArray(system)) systemPrompt = system.map(s => s.type === "text" ? s.text : "").join("\n");
  // Apply extra system instructions (loaded from files if configured).
  systemPrompt = systemInstructions.apply(systemPrompt, instructionsHeader);

  const kiroTools = (anthropicTools || []).map(t => ({
    toolSpecification: { name: t.name, description: t.description || "", inputSchema: { json: t.input_schema || { type: "object", properties: {} } } }
  }));

  const history = [];
  let pendingUserMessage = null, pendingAssistantMessage = null, pendingToolResults = [];

  for (const msg of messages) {
    const { text, toolUses, toolResults } = flattenAnthropicContent(msg.content);
    if (msg.role === "user") {
      if (pendingAssistantMessage) { history.push({ assistantResponseMessage: pendingAssistantMessage }); pendingAssistantMessage = null; }
      if (pendingToolResults.length) {
        const kept = filterOrphanToolResults(pendingToolResults, lastAssistantToolIds(history));
        if (kept.length) history.push({ userInputMessage: { content: "", userInputMessageContext: { toolResults: kept }, origin: "KIRO_CLI", modelId: model } });
        pendingToolResults = [];
      }
      if (pendingUserMessage) { history.push({ userInputMessage: pendingUserMessage }); pendingUserMessage = null; }
      if (toolResults.length) {
        for (const tr of toolResults)
          pendingToolResults.push({ toolUseId: normalizeToolUseId(tr.tool_use_id), content: [{ json: tryParseJson(tr.content) }], status: tr.is_error ? "error" : "success" });
      }
      if (text) pendingUserMessage = { content: text, userInputMessageContext: {}, origin: "KIRO_CLI", modelId: model };
      else if (toolResults.length && !pendingUserMessage) pendingUserMessage = { content: "", userInputMessageContext: {}, origin: "KIRO_CLI", modelId: model };
    } else if (msg.role === "assistant") {
      if (pendingAssistantMessage) { history.push({ assistantResponseMessage: pendingAssistantMessage }); pendingAssistantMessage = null; }
      if (pendingToolResults.length) {
        const kept = filterOrphanToolResults(pendingToolResults, lastAssistantToolIds(history));
        if (kept.length) history.push({ userInputMessage: { content: pendingUserMessage ? pendingUserMessage.content : "", userInputMessageContext: { toolResults: kept }, origin: "KIRO_CLI", modelId: model } });
        else if (pendingUserMessage && pendingUserMessage.content) history.push({ userInputMessage: { ...pendingUserMessage } });
        pendingToolResults = []; pendingUserMessage = null;
      } else if (pendingUserMessage) { history.push({ userInputMessage: pendingUserMessage }); pendingUserMessage = null; }
      const assistantMsg = { messageId: crypto.randomUUID(), content: text };
      if (toolUses.length) assistantMsg.toolUses = toolUses.map(tu => ({ toolUseId: normalizeToolUseId(tu.id), name: tu.name, input: tu.input }));
      if (!assistantMsg.content && !assistantMsg.toolUses) assistantMsg.content = ".";
      pendingAssistantMessage = assistantMsg;
    }
  }

  if (pendingAssistantMessage) { history.push({ assistantResponseMessage: pendingAssistantMessage }); pendingAssistantMessage = null; }

  const userContext = { envState: { operatingSystem: kiroOsName(), currentWorkingDirectory: process.cwd() } };
  if (kiroTools.length) userContext.tools = kiroTools;
  if (pendingToolResults.length) {
    const kept = filterOrphanToolResults(pendingToolResults, lastAssistantToolIds(history));
    if (kept.length) userContext.toolResults = kept;
  }

  let currentMessage;
  if (pendingUserMessage) {
    let content = pendingUserMessage.content;
    if (systemPrompt && history.length === 0) content = systemPrompt + "\n\n" + content;
    if (!content) content = userContext.toolResults ? "continue" : ".";
    currentMessage = { userInputMessage: { content, userInputMessageContext: userContext, origin: "KIRO_CLI", modelId: model } };
  } else if (pendingToolResults.length) {
    currentMessage = { userInputMessage: { content: "continue", userInputMessageContext: userContext, origin: "KIRO_CLI", modelId: model } };
  } else {
    currentMessage = { userInputMessage: { content: systemPrompt || ".", userInputMessageContext: userContext, origin: "KIRO_CLI", modelId: model } };
  }

  // ── Persona history injection ──
  // (disabled — causes 400 on Kiro API)
  // TODO: inject persona through alternate mechanism

  return { conversationState: { conversationId: crypto.randomUUID(), history, currentMessage, chatTriggerType: "MANUAL", agentTaskType: "vibe" } };
}

module.exports = { anthropicToKiro };
