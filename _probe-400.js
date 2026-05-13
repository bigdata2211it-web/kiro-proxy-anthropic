// Test: re-send dumped request to AWS, with/without schema sanitization
const fs = require("fs");
const https = require("https");
const path = require("path");
const Database = require("better-sqlite3");
const os = require("os");

const proxyDir = "/home/debian/github/bigdata2211it-web/kiro-proxy-anthropic";
process.chdir(proxyDir);
const { anthropicToKiro } = require("./_proxy-extract.js");

const home = process.env.HOME || os.homedir();
const xdg = process.env.XDG_DATA_HOME || path.join(home, ".local", "share");
const DB_PATH = path.join(xdg, "kiro-cli", "data.sqlite3");

function getToken() {
  const db = new Database(DB_PATH, { readonly: true });
  const row = db.prepare("SELECT value FROM auth_kv WHERE key='kirocli:social:token'").get();
  db.close();
  return JSON.parse(row.value);
}

function sanitizeSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(sanitizeSchema);
  const out = {};
  for (const k of Object.keys(schema)) {
    if (k === "$schema") continue;          // strip JSON Schema dialect URL
    if (k === "additionalProperties") continue; // CodeWhisperer doesn't accept it on top
    out[k] = sanitizeSchema(schema[k]);
  }
  return out;
}

async function send(body, tag) {
  const token = getToken();
  return new Promise((resolve) => {
    const req = https.request({
      hostname: "q.us-east-1.amazonaws.com", port: 443, path: "/", method: "POST",
      headers: {
        "content-type": "application/x-amz-json-1.0",
        "x-amz-target": "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
        "authorization": `Bearer ${token.access_token}`,
        "content-length": Buffer.byteLength(body)
      }
    }, (r) => {
      let buf = ""; r.on("data", d => buf += d);
      r.on("end", () => { console.log(`[${tag}] status=${r.statusCode} body=${buf.slice(0,300)}`); resolve(); });
    });
    req.on("error", e => { console.log(`[${tag}] transport ${e.message}`); resolve(); });
    req.write(body); req.end();
  });
}

(async () => {
  const dump = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const token = getToken();

  // Variant A: as-is (control)
  const reqA = anthropicToKiro(dump.incoming, dump.model);
  reqA.profileArn = token.profile_arn;
  await send(JSON.stringify(reqA), "AS-IS");

  // Variant B: strip $schema + additionalProperties
  const reqB = anthropicToKiro(dump.incoming, dump.model);
  reqB.profileArn = token.profile_arn;
  for (const t of (reqB.conversationState.currentMessage.userInputMessage.userInputMessageContext.tools || [])) {
    t.toolSpecification.inputSchema.json = sanitizeSchema(t.toolSpecification.inputSchema.json);
  }
  await send(JSON.stringify(reqB), "SANITIZED");

  // Variant C: also force model claude-sonnet-4.5 (known-good)
  const reqC = anthropicToKiro(dump.incoming, "claude-sonnet-4.5");
  reqC.profileArn = token.profile_arn;
  for (const t of (reqC.conversationState.currentMessage.userInputMessage.userInputMessageContext.tools || [])) {
    t.toolSpecification.inputSchema.json = sanitizeSchema(t.toolSpecification.inputSchema.json);
  }
  await send(JSON.stringify(reqC), "SANITIZED+SONNET4.5");

  // Variant D: as-is but force claude-sonnet-4.5
  const reqD = anthropicToKiro(dump.incoming, "claude-sonnet-4.5");
  reqD.profileArn = token.profile_arn;
  await send(JSON.stringify(reqD), "AS-IS+SONNET4.5");

  // Variant E: no tools at all
  const reqE = anthropicToKiro(dump.incoming, "claude-sonnet-4.5");
  reqE.profileArn = token.profile_arn;
  delete reqE.conversationState.currentMessage.userInputMessage.userInputMessageContext.tools;
  await send(JSON.stringify(reqE), "NO-TOOLS+SONNET4.5");
})();
