// system-instructions.js
// Loads extra system instructions from files and prepends/appends/replaces
// them in the outgoing system prompt. Lets you enforce your own AGENTS.md /
// CLAUDE.md / rules across any OpenAI-compatible client that talks to this proxy.
//
// Config lookup order (first match wins):
//   1. $KIRO_PROXY_INSTRUCTIONS_CONFIG (absolute path)
//   2. $XDG_CONFIG_HOME/kiro-proxy/system-instructions.json
//   3. ~/.config/kiro-proxy/system-instructions.json
//   4. ./system-instructions.json  (next to the proxy)
//
// Config format:
// {
//   "enabled": true,
//   "mode": "prepend",                // prepend | append | replace | off
//   "cache_ttl_seconds": 300,
//   "files": [
//     { "path": "/abs/or/relative/path.md", "required": true }
//   ],
//   "wrapper": {                       // optional; defaults below
//     "open": "",
//     "close": "",
//     "file_separator": "\n\n",
//     "file_header_template": ""
//   }
// }
//
// Client can override mode per-request via header:
//   X-Proxy-Instructions: off | prepend | append | replace | only (alias for replace)

const fs = require("fs");
const path = require("path");
const os = require("os");

const DEFAULT_WRAPPER = {
  open: "",
  close: "",
  file_separator: "\n\n",
  file_header_template: ""
};

const VALID_MODES = new Set(["prepend", "append", "replace", "off"]);

function configCandidates() {
  const explicit = process.env.KIRO_PROXY_INSTRUCTIONS_CONFIG;
  if (explicit) return [explicit];
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  const xdg = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  return [
    path.join(xdg, "kiro-proxy-anthropic", "system-instructions.json"),
    path.join(xdg, "kiro-proxy", "system-instructions.json"),
    path.join(home, ".config", "kiro-proxy-anthropic", "system-instructions.json"),
    path.join(home, ".config", "kiro-proxy", "system-instructions.json"),
    path.join(process.cwd(), "system-instructions.json")
  ];
}

function findConfigPath() {
  for (const c of configCandidates()) {
    try {
      if (c && fs.existsSync(c)) return c;
    } catch {}
  }
  return null;
}

function normalizeMode(m) {
  if (!m) return "prepend";
  const s = String(m).toLowerCase().trim();
  if (s === "only") return "replace";
  if (VALID_MODES.has(s)) return s;
  return "prepend";
}

let cache = {
  configPath: null,
  loadedAt: 0,
  mtime: 0,
  cfg: null,
  files: [],          // [{path, content}]
  skipped: [],        // [{path, required, reason}]
  rendered: "",
  warned: new Set()
};

function warnOnce(key, msg) {
  if (cache.warned.has(key)) return;
  cache.warned.add(key);
  console.warn(`[system-instructions] ${msg}`);
}

function readConfig(configPath) {
  const raw = fs.readFileSync(configPath, "utf8");
  const cfg = JSON.parse(raw);
  if (typeof cfg.enabled !== "boolean") cfg.enabled = true;
  if (typeof cfg.strict !== "boolean") cfg.strict = false;
  cfg.mode = normalizeMode(cfg.mode);
  cfg.cache_ttl_seconds = Number.isFinite(cfg.cache_ttl_seconds) ? cfg.cache_ttl_seconds : 300;
  cfg.files = Array.isArray(cfg.files) ? cfg.files : [];
  cfg.wrapper = Object.assign({}, DEFAULT_WRAPPER, cfg.wrapper || {});
  return cfg;
}

function resolveFilePath(p, configPath) {
  if (!p) return p;
  if (path.isAbsolute(p)) return p;
  return path.resolve(path.dirname(configPath), p);
}

function loadFiles(cfg, configPath) {
  const out = [];
  const skipped = [];
  for (const entry of cfg.files) {
    if (!entry || !entry.path) continue;
    const abs = resolveFilePath(entry.path, configPath);
    try {
      const content = fs.readFileSync(abs, "utf8");
      out.push({ path: abs, content });
    } catch (e) {
      skipped.push({ path: abs, required: !!entry.required, reason: e.code || e.message });
      if (entry.required && cfg.strict) {
        throw new Error(`required instructions file missing (strict mode): ${abs} (${e.message})`);
      }
      if (entry.required) {
        console.warn(`[system-instructions] required file missing, skipped: ${abs}`);
      } else {
        warnOnce(`missing:${abs}`, `skipped missing file ${abs}`);
      }
    }
  }
  return { files: out, skipped };
}

function renderBlock(files, wrapper) {
  if (!files.length) return "";
  const parts = [];
  for (const f of files) {
    let header = "";
    if (wrapper.file_header_template) {
      header = wrapper.file_header_template.replace("{path}", f.path) + "\n";
    }
    parts.push(header + f.content.trimEnd());
  }
  const body = parts.join(wrapper.file_separator);
  const open = wrapper.open ? wrapper.open + "\n" : "";
  const close = wrapper.close ? "\n" + wrapper.close : "";
  return (open + body + close).trim();
}

function load(force = false) {
  const configPath = findConfigPath();
  if (!configPath) {
    if (cache.configPath !== null) {
      cache = { configPath: null, loadedAt: 0, mtime: 0, cfg: null, files: [], skipped: [], rendered: "", warned: cache.warned };
    }
    return null;
  }

  let stat;
  try { stat = fs.statSync(configPath); } catch { return cache.cfg ? cache : null; }

  const now = Date.now();
  const ttlMs = (cache.cfg?.cache_ttl_seconds ?? 300) * 1000;
  const stale = force
    || cache.configPath !== configPath
    || stat.mtimeMs !== cache.mtime
    || (now - cache.loadedAt) > ttlMs;

  if (!stale && cache.cfg) return cache;

  try {
    const cfg = readConfig(configPath);
    const loaded = cfg.enabled ? loadFiles(cfg, configPath) : { files: [], skipped: [] };
    const files = loaded.files;
    const skipped = loaded.skipped;
    const rendered = cfg.enabled ? renderBlock(files, cfg.wrapper) : "";
    const total = cfg.files.length;
    cache = {
      configPath,
      loadedAt: now,
      mtime: stat.mtimeMs,
      cfg,
      files,
      skipped,
      rendered,
      warned: cache.warned
    };
    const skipNote = skipped.length ? ` (skipped ${skipped.length}: ${skipped.map(s => path.basename(s.path)).join(", ")})` : "";
    console.log(`[system-instructions] loaded ${files.length}/${total} file(s) from ${configPath} (mode=${cfg.mode}, strict=${cfg.strict}, enabled=${cfg.enabled})${skipNote}`);
    return cache;
  } catch (e) {
    console.error(`[system-instructions] failed to load ${configPath}: ${e.message}`);
    cache.loadedAt = now;
    return cache.cfg ? cache : null;
  }
}

// headerOverride comes from HTTP header (e.g. "off" / "replace").
// Returns the resulting system prompt string.
function apply(clientSystem, headerOverride) {
  const state = load();
  const clientText = clientSystem || "";

  if (!state || !state.cfg || !state.cfg.enabled) return clientText;

  let mode = state.cfg.mode;
  if (headerOverride) {
    const n = normalizeMode(headerOverride);
    if (n) mode = n;
  }

  if (mode === "off") return clientText;
  if (!state.rendered) return clientText;
  if (mode === "replace") return state.rendered;
  if (mode === "append") return clientText ? `${clientText}\n\n${state.rendered}` : state.rendered;
  // prepend (default)
  return clientText ? `${state.rendered}\n\n${clientText}` : state.rendered;
}

function status() {
  const state = load();
  if (!state || !state.cfg) {
    return { enabled: false, configPath: null, mode: null, strict: false, files: [], skipped: [], renderedBytes: 0 };
  }
  return {
    enabled: state.cfg.enabled,
    configPath: state.configPath,
    mode: state.cfg.mode,
    strict: state.cfg.strict,
    cacheTtlSeconds: state.cfg.cache_ttl_seconds,
    files: state.files.map(f => ({ path: f.path, bytes: Buffer.byteLength(f.content, "utf8") })),
    skipped: (state.skipped || []).map(s => ({ path: s.path, required: s.required, reason: s.reason })),
    renderedBytes: Buffer.byteLength(state.rendered, "utf8")
  };
}

function reload() { return load(true); }

module.exports = { apply, status, reload };
