"use strict";
/**
 * Cline Relay UI — 后端
 *
 * 这个进程同时做两件事：
 *   1. 持有两个 Cline 会话，跑 A<->B 乒乓循环
 *   2. 提供本地网页（配置 + 实时日志）
 *
 * 必须同进程的原因：@cline/core 的会话上下文存在进程内存里，
 * 进程退出后无法在新进程里 send() 到同一个 sessionId。
 */

const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const CONFIG_PATH = path.join(ROOT, "config.json");
const PORT = Number(process.env.PORT || 5177);

// ---------------------------------------------------------------- 默认配置

// 权威工具名来自 SDK：ALL_DEFAULT_TOOL_NAMES / DefaultToolNames
const TOOL_ITEMS = [
  { id: "read_files", label: "Read files", hint: "读取文件" },
  { id: "search_codebase", label: "Search codebase", hint: "搜索代码" },
  { id: "run_commands", label: "Execute commands", hint: "执行命令" },
  { id: "fetch_web_content", label: "Fetch web content", hint: "抓取网页内容" },
  { id: "apply_patch", label: "Apply patch", hint: "以补丁方式改文件" },
  { id: "editor", label: "Editor", hint: "编辑器工具" },
  { id: "skills", label: "Skills", hint: "调用已安装 Skills" },
  { id: "ask_question", label: "Ask question", hint: "向用户提问" },
  { id: "submit_and_exit", label: "Submit and exit", hint: "完成并退出" },
];

// 对齐扩展持久化的 autoApprovalSettings.actions（v4）
const APPROVAL_ACTIONS = [
  { id: "readFiles", label: "Read files", hint: "读文件 / 读文件外部" },
  { id: "editFiles", label: "Edit files", hint: "改文件 / 改文件外部" },
  { id: "executeSafeCommands", label: "Execute safe commands", hint: "自动批准安全命令" },
  { id: "executeAllCommands", label: "Execute all commands", hint: "自动批准所有命令" },
  { id: "useBrowser", label: "Fetch web content", hint: "抓取网页" },
  { id: "useMcp", label: "Use MCP servers", hint: "调用 MCP 服务器" },
];

/** 每个角色可单独覆盖的全部能力（"跟随全局"= enabled:false） */
function makeSideOverride() {
  return {
    enabled: false,          // 总开关：是否脱离全局
    mode: "act",             // AgentMode: act | plan | yolo | zen
    providerId: "", modelId: "", thinking: "",
    cwd: "",                 // 该角色自己的工作目录
    autoApprove: {           // 对齐 autoApprovalSettings.actions
      enabled: false, maxRequests: 0,
      actions: {
        readFiles: false, readFilesExternally: false,
        editFiles: false, editFilesExternally: false,
        executeSafeCommands: false, executeAllCommands: false,
        useBrowser: false, useMcp: false,
      },
      webSearch: false,
    },
    tools: {                 // 对齐 ToolPresets
      preset: "act", enableReadFiles: true, enableSearch: true, enableBash: true,
      enableWebFetch: true, enableApplyPatch: false, enableEditor: true,
      enableSkills: true, enableAskQuestion: true, enableSubmitAndExit: false,
      enableSpawnAgent: false, enableAgentTeams: false,
    },
    capabilities: {          // 真正能按角色控制的两个（MCP / Skills）
      useMcp: true, useSkills: true,
      // Rules / Workflows / Hooks 由 Cline 按工作目录自动发现，SDK 没有按会话开关，
      // 所以这里不假装能开关，只在界面上只读展示真实路径。
    },
    context: {               // Add Context
      initialMessagesFromSession: "",   // 从某个历史会话预载上下文
    },
    attachments: {           // Add Files & Images
      images: [], files: [],
    },
    compaction: { enabled: true, strategy: "" },   // 留空 = 跟随全局
    checkpoint: { enabled: null },                 // null = 跟随全局
    worktree: { enabled: null },
    backendMode: "",                             // 留空 = 跟随全局
  };
}
const SIDE_OVERRIDE = makeSideOverride();

const DEFAULT_CONFIG = {
  ui: { theme: "dim" },
  a: {
    name: "A",
    systemPrompt: "你是角色 A。请直接给出结论，不要客套。",
    seedPrompt: "请做一次简短的开场陈述，说明你能做什么。",
    source: { mode: "blank", sessionId: "" },
    override: { ...SIDE_OVERRIDE },
  },
  b: {
    name: "B",
    systemPrompt: "你是角色 B。请直接给出结论，不要客套。",
    seedPrompt: "请做一次简短的开场陈述，说明你能做什么。",
    source: { mode: "blank", sessionId: "" },
    override: { ...SIDE_OVERRIDE },
  },

  model: {
    providerId: "cline",
    modelId: "",
    thinking: "medium",
    planActSeparate: false,
    plan: { providerId: "", modelId: "" },
    act: { providerId: "", modelId: "" },
    ocaMode: "internal",
    adaptiveThinking: false,
    promptCache: false,
  },

  autoApprove: {
    enabled: false,
    maxRequests: 20,
    notifications: false,
    webSearch: false,
    actions: {
      readFiles: false,
      readFilesExternally: false,
      editFiles: false,
      editFilesExternally: false,
      executeSafeCommands: false,
      executeAllCommands: false,
      useBrowser: false,
      useMcp: false,
    },
  },

  tools: {
    preset: "act",
    enableReadFiles: true,
    enableSearch: true,
    enableBash: true,
    enableWebFetch: true,
    enableApplyPatch: false,
    enableEditor: true,
    enableSkills: true,
    enableAskQuestion: true,
    enableSubmitAndExit: false,
    enableSpawnAgent: false,
    enableAgentTeams: false,
  },

  workspace: { folders: [], cwd: "" },

  checkpoint: { enabled: false },
  worktree: { enabled: false },

  loop: {
    firstSide: "A",
    maxHops: 6,
    timeoutMs: 180000,
    stopKeywords: ["TERMINATE"],
    stopOnConvergence: true,
  },
  advanced: {
    backendMode: "local",
    compactionEnabled: true,
    compaction: "agentic",
  },
};

function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

function mergeDeep(base, patch) {
  const out = clone(base);
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object" && !Array.isArray(out[k])) {
      out[k] = mergeDeep(out[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

function loadConfig() {
  let cfg;
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8").replace(/^\uFEFF/, "");
    cfg = mergeDeep(DEFAULT_CONFIG, JSON.parse(raw));
    // 兜底：配置里没写 model 时，用 providers.json 里该 provider 当前选的模型（真实值，不猜）
    if (cfg.model && !String(cfg.model.modelId || "").trim()) {
      const fb = providerDefaultModel(cfg.model.providerId);
      if (fb) cfg.model.modelId = fb;
    }
    return cfg;
  } catch {
    cfg = clone(DEFAULT_CONFIG);
    if (cfg.model && !String(cfg.model.modelId || "").trim()) {
      const fb = providerDefaultModel(cfg.model.providerId);
      if (fb) cfg.model.modelId = fb;
    }
    return cfg;
  }
}

function saveConfig(cfg) {
  const merged = mergeDeep(DEFAULT_CONFIG, cfg);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), "utf8");
  return merged;
}

// ---------------------------------------------------------------- 定位 SDK

function locateCore() {
  const candidates = [
    process.env.CORE_ENTRY,
    path.join(
      process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
      "npm", "node_modules", "cline", "node_modules", "@cline", "core", "dist", "index.js",
    ),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

const CORE_ENTRY = locateCore();

// SDK 里读到的权威元数据（ToolPresets / 工具名），供 /api/options 使用
let SDK_META = { toolPresets: null, allToolNames: null };

let corePromise = null;
function loadCore() {
  if (!corePromise) {
    if (!CORE_ENTRY) throw new Error("找不到 @cline/core，请设置环境变量 CORE_ENTRY");
    corePromise = import("file:///" + CORE_ENTRY.replace(/\\/g, "/")).then((core) => {
      SDK_META = {
        toolPresets: core.ToolPresets || null,
        allToolNames: core.ALL_DEFAULT_TOOL_NAMES || null,
      };
      return core;
    });
  }
  return corePromise;
}

// ---------------------------------------------------------------- 选项枚举
// 注意：这里只提取 provider 名称和模型名，绝不读取 / 返回任何凭据字段。

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

async function listOptions() {
  await loadCore().catch(() => null);   // 先加载，保证 ToolPresets / 工具名来自 SDK 权威值
  const settingsDir = path.join(os.homedir(), ".cline", "data", "settings");
  const providers = [];
  const models = new Set();

  const pj = readJsonSafe(path.join(settingsDir, "providers.json"));
  if (pj && pj.providers && typeof pj.providers === "object") {
    for (const [id, entry] of Object.entries(pj.providers)) {
      const s = entry && entry.settings ? entry.settings : {};
      providers.push({
        id,
        model: typeof s.model === "string" ? s.model : "",
        hasAuth: Boolean(s.auth || s.apiKey),
        source: typeof entry?.tokenSource === "string" ? entry.tokenSource : "",
      });
      if (typeof s.model === "string" && s.model) models.add(s.model);
    }
  }

  const mj = readJsonSafe(path.join(settingsDir, "models.json"));
  if (mj) {
    const walk = (o, depth) => {
      if (!o || depth > 3) return;
      if (Array.isArray(o)) return o.forEach((x) => walk(x, depth + 1));
      if (typeof o !== "object") return;
      for (const [k, v] of Object.entries(o)) {
        if ((k === "id" || k === "model" || k === "modelId") && typeof v === "string") models.add(v);
        else if (v && typeof v === "object") walk(v, depth + 1);
      }
    };
    walk(mj, 0);
  }

  return {
    coreEntry: CORE_ENTRY,
    coreFound: Boolean(CORE_ENTRY),
    providers,
    models: [...models].sort(),
    toolItems: TOOL_ITEMS,
    approvalActions: APPROVAL_ACTIONS,
    toolPresets: SDK_META.toolPresets || null,
    allToolNames: SDK_META.allToolNames || TOOL_ITEMS.map((t) => t.id),
    cwdExists: (p) => {
      try {
        return Boolean(p) && fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    },
  };
}

/**
 * 模型目录：优先用 SDK 的 getLiveModelsCatalog()（源自 https://models.dev/api.json，
 * 结构是 Record<providerId, Record<modelId, ModelInfo>>，是异步的）。
 * SDK 内部自带缓存，这里再缓存一层，避免每次开面板都打网络。
 * 兜底：getProviderConfig().knownModels -> 本地 models.json -> 空。
 */
let CATALOG_CACHE = { at: 0, data: null };
const CATALOG_TTL = 10 * 60 * 1000;

async function modelsCatalog() {
  const now = Date.now();
  if (CATALOG_CACHE.data && now - CATALOG_CACHE.at < CATALOG_TTL) return CATALOG_CACHE.data;
  try {
    const core = await loadCore();
    const cat = await core.getLiveModelsCatalog();
    if (cat && typeof cat === "object") {
      CATALOG_CACHE = { at: now, data: cat };
      return cat;
    }
  } catch (e) {
    Logger?.warn?.("[modelsCatalog]", e);
  }
  return CATALOG_CACHE.data || {};
}

/** 汇总某 provider 下所有已知模型（目录 + 内置 knownModels + 本地 models.json）。 */
async function modelsForProvider(providerId) {
  const out = new Map();

  const put = (id, info, origin) => {
    if (!id || out.has(id)) return;
    out.set(id, {
      id,
      origin,
      displayName: (info && (info.displayName || info.name)) || id,
      capabilities: Array.isArray(info?.capabilities) ? info.capabilities : [],
      contextWindow: info?.contextWindow ?? info?.maxInputTokens ?? null,
      maxTokens: info?.maxTokens ?? null,
      description: info?.description || "",
    });
  };

  // 1) models.dev 大目录
  const cat = await modelsCatalog();
  const forProvider = cat[providerId];
  if (forProvider && typeof forProvider === "object") {
    for (const [id, info] of Object.entries(forProvider)) put(id, info, "catalog");
  }

  // 2) SDK 内置 knownModels
  try {
    const core = await loadCore();
    const d = core.getProviderConfig ? core.getProviderConfig(providerId) : null;
    if (d && d.knownModels) {
      for (const [id, info] of Object.entries(d.knownModels)) put(id, info, "builtin");
    }
  } catch { /* ignore */ }

  // 3) 本地 models.json（用户自定义 provider 记在这里）
  const local = readJsonSafe(path.join(os.homedir(), ".cline", "data", "settings", "models.json"));
  const entry = local && local.providers ? local.providers[providerId] : null;
  if (entry && Array.isArray(entry.models)) {
    for (const m of entry.models) {
      if (m && typeof m === "object") put(String(m.id || m.model || ""), m, "local");
    }
  }

  return [...out.values()];
}

const Logger = { warn: (...a) => console.warn("[relay]", ...a) };
function listWorkspaces() {
  const cfg = loadConfig();
  const saved = Array.isArray(cfg.workspace?.folders) ? cfg.workspace.folders : [];
  const byPath = new Map();
  for (const f of saved) {
    const p = String(f.path || "").trim();
    if (!p) continue;
    byPath.set(p.toLowerCase(), { path: p, label: f.label || path.basename(p), added: true, count: 0 });
  }
  let dirs = [];
  try {
    dirs = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch { /* ignore */ }
  for (const d of dirs) {
    const meta = readJsonSafe(path.join(SESSIONS_DIR, d.name, `${d.name}.json`));
    const cwd = meta && (meta.cwd || meta.workspace_root || meta.workspaceRoot);
    if (!cwd) continue;
    const key = String(cwd).toLowerCase();
    const hit = byPath.get(key);
    if (hit) hit.count++;
    else byPath.set(key, { path: cwd, label: path.basename(cwd), added: false, count: 1 });
  }
  const list = [...byPath.values()].filter((x) => {
    try { return fs.statSync(x.path).isDirectory(); } catch { return false; }
  });
  list.sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
  return list;
}

/** 读 Cline 真实的全局设置与 autoApprovalSettings（只读展示，不代为改写）。 */
function readClineGlobals() {
  const out = { autoApprovalSettings: null, planAct: null, ocaMode: null, globalSettings: null };
  const gs = readJsonSafe(path.join(os.homedir(), ".cline", "data", "globalState.json"));
  if (gs) {
    out.autoApprovalSettings = gs.autoApprovalSettings ?? null;
    out.planAct = {
      separate: gs.planActSeparateModelsSetting ?? null,
      plan: { providerId: gs.planModeApiProvider ?? "", modelId: gs.planModeClineModelId ?? "" },
      act: { providerId: gs.actModeApiProvider ?? "", modelId: gs.actModeClineModelId ?? "" },
    };
    out.ocaMode = gs.ocaMode ?? null;
  }
  out.globalSettings = readJsonSafe(path.join(os.homedir(), ".cline", "data", "settings", "global-settings.json"));
  return out;
}

// ---------------------------------------------------------------- 历史会话

const SESSIONS_DIR = path.join(os.homedir(), ".cline", "data", "sessions");

function findSession(sessionId) {
  try {
    const meta = readJsonSafe(path.join(SESSIONS_DIR, sessionId, `${sessionId}.json`));
    if (!meta) return null;
    // 磁盘上是 snake_case，统一补上 camelCase 别名给上层用
    const alias = {
      sessionId: meta.session_id ?? meta.sessionId,
      startedAt: meta.started_at ?? meta.startedAt,
      workspaceRoot: meta.workspace_root ?? meta.workspaceRoot,
      modelId: meta.modelId ?? meta.model,
    };
    return { ...meta, ...alias };
  } catch {
    return null;
  }
}

/** 列出所有历史会话（含扩展创建的），只读元数据，不读消息正文。
 *  注意：磁盘上的元数据是 snake_case（started_at / session_id / workspace_root ...），
 *  与 SESSION_SELECT_COLUMNS 的 camelCase 别名不同，两种都要兼容。 */
function listSessions() {
  const out = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return out;
  }

  const pick = (o, ...keys) => {
    for (const k of keys) {
      const v = o[k];
      if (v !== undefined && v !== null && v !== "") return v;
    }
    return undefined;
  };

  for (const d of dirs) {
    const id = d.name;
    const meta = readJsonSafe(path.join(SESSIONS_DIR, id, `${id}.json`));
    if (!meta) continue;

    // 消息数用字符串计数，避免把几 MB 的 JSON 解析一遍
    let msgCount = null;
    let bytes = 0;
    try {
      const mp = path.join(SESSIONS_DIR, id, `${id}.messages.json`);
      bytes = fs.statSync(mp).size;
      const raw = fs.readFileSync(mp, "utf8");
      msgCount = raw.split('"role":').length - 1;
    } catch {
      /* ignore */
    }

    const title = String(pick(meta, "title", "prompt") || "").replace(/\s+/g, " ").trim();
    out.push({
      id: String(pick(meta, "sessionId", "session_id") || id),
      title: title.slice(0, 120),
      status: pick(meta, "status") || "",
      startedAt: String(pick(meta, "startedAt", "started_at") || ""),
      endedAt: String(pick(meta, "endedAt", "ended_at") || ""),
      cwd: String(pick(meta, "cwd", "workspaceRoot", "workspace_root") || ""),
      provider: pick(meta, "provider") || "",
      model: pick(meta, "model", "modelId") || "",
      interactive: pick(meta, "interactive"),
      enableTools: pick(meta, "enableTools", "enable_tools"),
      enableSpawn: pick(meta, "enableSpawn", "enable_spawn"),
      enableTeams: pick(meta, "enableTeams", "enable_teams"),
      teamName: pick(meta, "teamName", "team_name") || "",
      parentSessionId: pick(meta, "parentSessionId", "parent_session_id") || null,
      isSubagent: pick(meta, "isSubagent", "is_subagent"),
      source: pick(meta, "source") || "",
      msgCount,
      bytes,
    });
  }

  out.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  return out;
}

/**
 * 从一条消息里抽出纯文本。
 * 注意 content 有三种形态：
 *   "字符串"
 *   { type:"text", text:"..." }
 *   [ { type:"text", text:"..." }, ... ]   ← 实际最常见的是这种
 * 另外 user 消息的文本被包在 <user_input mode="act">...</user_input> 里，要剥掉。
 */
function messageText(m) {
  if (!m) return "";
  const c = m.content;
  let t = "";
  if (typeof c === "string") t = c;
  else if (Array.isArray(c)) {
    t = c.map((b) => (typeof b === "string" ? b : b && typeof b.text === "string" ? b.text : "")).join("\n");
  } else if (c && typeof c.text === "string") t = c.text;

  t = t.trim();
  const wrap = t.match(/^<user_input\b[^>]*>([\s\S]*?)<\/user_input>$/i);
  if (wrap) t = wrap[1].trim();
  return t;
}

function readMessagesFile(sessionId) {
  try {
    const p = path.join(SESSIONS_DIR, sessionId, `${sessionId}.messages.json`);
    const j = readJsonSafe(p);
    if (Array.isArray(j)) return j;
    if (j && Array.isArray(j.messages)) return j.messages;
  } catch {
    /* ignore */
  }
  return [];
}

/** 取一个会话的最后一条 assistant 文本，作为分叉后的「开场白」。取不到就返回空串。 */
function lastAssistantText(sessionId) {
  const msgs = readMessagesFile(sessionId);
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i] && msgs[i].role === "assistant") {
      const t = messageText(msgs[i]);
      if (t) return t;
    }
  }
  return "";
}

/** 兜底：assistant 没有可用文本时，退回最后一条任何角色的非空消息。 */
function lastAnyText(sessionId) {
  const msgs = readMessagesFile(sessionId);
  for (let i = msgs.length - 1; i >= 0; i--) {
    const t = messageText(msgs[i]);
    if (t) return t;
  }
  return "";
}

/** 分叉后拿不到任何可复用的文本时，用一句话兜底，保证 prompt 非空。 */
function forkFallbackPrompt(label) {
  return `我是${label}。我们已经就之前的工作有过交流，现在请用一句话总结你当前的进展或结论。`;
}

// ---------------------------------------------------------------- SSE

const clients = new Set();

function sseWrite(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    clients.delete(res);
  }
}

function broadcast(event, data) {
  for (const res of clients) sseWrite(res, event, data);
}

// ---------------------------------------------------------------- 运行状态

const run = {
  active: false,
  stopping: false,
  cline: null,
  sessions: { A: null, B: null },
  hops: [],
  startedAt: null,
  error: null,
};

function nowIso() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------- 乒乓循环

/** 工作目录：来自「项目文件夹」选择，落到 SDK 的 cwd / workspaceRoot。 */
function resolveCwd(cfg) {
  const w = cfg.workspace || {};
  const p = String(w.cwd || "").trim();
  return p || ROOT;
}

/**
 * 按 Cline CLI 的 `--worktree` 语义创建 detached git worktree。
 * CLI 原话："Auto-create a detached git worktree under ~/.cline/worktrees/
 * and run the task there"，调用 createTaskWorktree({cwd}) 后把 cwd 指向新路径。
 * SDK 未导出 createTaskWorktree，这里用等价的 git 命令实现同一行为。
 */
const { execFileSync } = require("node:child_process");

function gitOut(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function createTaskWorktree(cwd) {
  const root = path.join(os.homedir(), ".cline", "worktrees");
  fs.mkdirSync(root, { recursive: true });
  const name = `relay-${Date.now().toString(36)}`;
  const dest = path.join(root, name);
  try {
    gitOut(["rev-parse", "--is-inside-work-tree"], cwd);
  } catch (e) {
    return { success: false, message: `不是 git 仓库：${cwd}` };
  }
  try {
    gitOut(["worktree", "add", "--detach", dest, "HEAD"], cwd);
  } catch (e) {
    const msg = String((e && (e.stderr || e.message)) || e).trim().split("\n").slice(-2).join(" ");
    return { success: false, message: msg || "git worktree add 失败" };
  }
  return { success: true, path: dest, name };
}

function sharedEnv(cfg) {
  const target = resolveCwd(cfg);
  const t = cfg.tools || {};
  return {
    cwd: target,
    workspaceRoot: target,
    // CoreRuntimeFeatures（对齐 SDK）
    enableTools: true,
    enableSpawnAgent: Boolean(t.enableSpawnAgent),
    enableAgentTeams: Boolean(t.enableAgentTeams),
    disableMcpSettingsTools: false,
    yolo: false,
  };
}

function reasoningFor(cfg) {
  const t = cfg.model.thinking;
  return t && t !== "none" ? String(t) : undefined;
}

/**
 * 解析每个 side 的 provider / model / 凭据。
 * 若该 side 选择「从历史会话分叉」，则沿用那个会话的 provider 和 model；
 * thinking 级别在会话记录里没有保存，无法继承，仍用界面上的值。
 */
/** 从 ~/.cline/data/settings/providers.json 读该 provider 当前配置的模型（真实兜底，不猜） */
function providerDefaultModel(providerId) {
  const f = path.join(os.homedir(), ".cline", "data", "settings", "providers.json");
  const j = readJsonSafe(f);
  const entry = j && j.providers ? j.providers[providerId] : null;
  // providers.json 的真实结构是 { providers: { <id>: { settings: { model, auth } } } }
  const s = entry && entry.settings ? entry.settings : entry;
  return s && typeof s.model === "string" ? s.model : "";
}
function resolveSides(core, cfg) {
  const tokens = new Map();
  const out = {};

  const getToken = (pid) => {
    if (!tokens.has(pid)) {
      const mgr = new core.ProviderSettingsManager();
      const t = core.resolveLocalClineAuthToken(mgr.getProviderSettings(pid));
      if (!t) throw new Error(`无法从 providers.json 解析 provider「${pid}」的凭据`);
      tokens.set(pid, t);
    }
    return tokens.get(pid);
  };

  for (const side of ["A", "B"]) {
    const conf = cfg[side.toLowerCase()] || {};
    const src = conf.source || { mode: "blank" };
    const ov = conf.override || {};
    const forked = src.mode === "fork" && String(src.sessionId || "").trim();
    const rec = forked ? findSession(String(src.sessionId).trim()) : null;
    const useRec = Boolean(forked && rec);

    // ---- AgentMode（对齐 SDK 的 AgentMode = act|plan|yolo|zen）
    const agentMode = ["act", "plan", "yolo", "zen"].includes(String(ov.mode)) ? String(ov.mode) : "act";

    // ---- 模型来源优先级：本角色覆盖 > Plan/Act 分开时按 mode 取 > 历史会话继承 > 全局
    let providerId = "";
    let modelId = "";
    let modelFrom = "";

    if (ov.enabled && (ov.providerId || ov.modelId)) {
      providerId = ov.providerId || cfg.model.providerId;
      modelId = ov.modelId || cfg.model.modelId;
      modelFrom = "override";
    } else if (cfg.model.planActSeparate) {
      const slot = agentMode === "plan" ? cfg.model.plan : cfg.model.act;
      providerId = (slot && slot.providerId) || cfg.model.providerId;
      modelId = (slot && slot.modelId) || cfg.model.modelId;
      modelFrom = "planAct";
    } else if (useRec && (rec.provider || rec.model || rec.modelId)) {
      providerId = rec.provider || cfg.model.providerId;
      modelId = rec.model || rec.modelId || cfg.model.modelId;
      modelFrom = "history";
    } else {
      providerId = cfg.model.providerId;
      modelId = cfg.model.modelId;
      modelFrom = "global";
    }

    if (!providerId) throw new Error(`${side}: 无法确定 provider`);
    if (!modelId) throw new Error(`${side}: 无法确定 model`);

    const thinking =
      ov.enabled && ov.thinking ? String(ov.thinking)
      : cfg.model.thinking === "none" ? undefined : String(cfg.model.thinking);

    out[side] = {
      conf,
      ov,
      fork: useRec,
      sourceId: forked ? String(src.sessionId).trim() : "",
      sourceRecord: rec || null,
      providerId,
      modelId,
      apiKey: getToken(providerId),
      thinking,
      modelFrom,
      agentMode,
      inherited: modelFrom === "history",
    };
  }
  return out;
}

/** 该 side 生效的 autoApprove：覆盖优先，否则用全局。 */
function effectiveAutoApprove(cfg, ov) {
  if (ov && ov.enabled && ov.autoApprove) return ov.autoApprove;
  return cfg.autoApprove || {};
}

/** 该 side 生效的工具开关：覆盖优先，否则用全局。 */
function effectiveTools(cfg, ov) {
  if (ov && ov.enabled && ov.tools) return { ...(cfg.tools || {}), ...ov.tools };
  return cfg.tools || {};
}

/**
 * 该 side 生效的「能力开关」。SDK 里真能按会话控制的只有两个：
 *   useMcp    -> createDisabledMcpToolPolicies + disableMcpSettingsTools
 *   useSkills -> toolPolicies.skills.enabled
 * Rules / Workflows / Hooks 是按工作目录自动发现的，没有按会话开关，因此不做假开关。
 */
function effectiveCapabilities(cfg, ov) {
  if (ov && ov.enabled && ov.capabilities) {
    return {
      useMcp: ov.capabilities.useMcp !== false,
      useSkills: ov.capabilities.useSkills !== false,
    };
  }
  return { useMcp: true, useSkills: true };
}

/**
 * 由 autoApprove 的 action 开关 + 工具开关生成 SDK 的 toolPolicies。
 *
 * 真实结构：Record<tool_name, ToolPolicy>，ToolPolicy = { enabled?, autoApprove? }。
 * 工具名只取 SDK 的 ALL_DEFAULT_TOOL_NAMES（read_files / search_codebase / run_commands /
 * fetch_web_content / apply_patch / editor / skills / ask_question / submit_and_exit）。
 * "*" 是 Cline runtime 自己用的通配键（见 SDK 内部 toolPolicies 默认值），这里保持同样形状。
 */
function buildToolPolicies(aa, caps, tools) {
  const policies = {};
  const on = (k) => Boolean(aa.actions && aa.actions[k]);
  const t = tools || {};

  const read = on("readFiles");
  const edit = on("editFiles");
  const cmd = on("executeAllCommands") || on("executeSafeCommands");
  const web = on("useBrowser");
  const skillsOn = caps.useSkills !== false && t.enableSkills !== false;

  // enabled 跟「工具能力」面板走；autoApprove 跟 Auto-approve 面板走
  policies.read_files = { enabled: t.enableReadFiles !== false, autoApprove: read };
  policies.search_codebase = { enabled: t.enableSearch !== false, autoApprove: read };
  policies.editor = { enabled: t.enableEditor !== false, autoApprove: edit };
  policies.apply_patch = { enabled: t.enableApplyPatch === true, autoApprove: edit };
  policies.run_commands = { enabled: t.enableBash !== false, autoApprove: cmd };
  policies.fetch_web_content = { enabled: t.enableWebFetch !== false, autoApprove: web };
  policies.skills = { enabled: skillsOn, autoApprove: false };
  policies.ask_question = { enabled: t.enableAskQuestion !== false, autoApprove: false };
  policies.submit_and_exit = { enabled: t.enableSubmitAndExit === true, autoApprove: false };

  // 通配：其余工具一律不自动批准（形状与 SDK 内部默认值一致）
  policies["*"] = { autoApprove: false };
  return policies;
}

/**
 * 真的把某个角色的 MCP 工具关掉。
 * 真实入口：createDisabledMcpToolPolicies({ serverName, toolNames })（SDK extensions/mcp/policies）。
 * 工具名必须来自真实服务器，所以这里连一次拿 listTools；连不上就只关「管理 MCP 的工具」。
 */
async function mcpPoliciesForSide(core, caps, cwd) {
  if (caps.useMcp !== false) return { policies: {}, blocked: false, servers: [], note: "" };
  const out = { policies: {}, blocked: true, servers: [], note: "" };
  try {
    const settingsPath = core.resolveDefaultMcpSettingsPath();
    const settings = core.loadMcpSettingsFile(settingsPath);
    const servers = (settings && settings.mcpServers) || {};
    const names = Object.keys(servers);
    out.servers = names;
    if (!names.length) { out.note = "cline_mcp_settings.json 里没有服务器，无需禁用"; return out; }

    const factory = core.createDefaultMcpServerClientFactory({ settingsPath });
    const failed = [];
    for (const serverName of names) {
      try {
        const client = await factory(serverName);
        await client.connect();
        const tools = await client.listTools();
        out.policies = { ...out.policies, ...core.createDisabledMcpToolPolicies({
          serverName,
          toolNames: tools.map((t) => t.name),
        }) };
        await client.disconnect();
      } catch (e) {
        failed.push(`${serverName}(${(e && e.message ? e.message : e).toString().slice(0, 40)})`);
      }
    }
    if (failed.length) {
      out.note = `这些服务器没连上，暂时只关掉了管理入口：${failed.join(", ")}`;
    }
  } catch (e) {
    out.note = `读 MCP 配置失败：${(e && e.message) || e}`;
  }
  return out;
}

/** 该 side 工作目录里真实生效的 rules / skills / workflows / hooks（MCP 与 Skills 之外没有按会话开关） */
function capabilityScan(core, cwd) {
  const safe = (fn) => { try { return typeof core[fn] === "function" ? core[fn](cwd) : []; } catch { return []; } };
  return {
    cwd,
    skills: safe("resolveSkillsConfigSearchPaths"),
    rules: safe("resolveRulesConfigSearchPaths"),
    workflows: safe("resolveWorkflowsConfigSearchPaths"),
    hooks: safe("resolveHooksConfigSearchPaths"),
    hookFiles: (() => {
      try {
        return typeof core.listHookConfigFiles === "function"
          ? core.listHookConfigFiles(cwd).map((h) => ({ fileName: h.fileName, path: h.path }))
          : [];
      } catch { return []; }
    })(),
  };
}

/** 由工具开关生成 CoreRuntimeFeatures（对齐 SDK 字段名）。 */
function buildRuntimeFeatures(t, caps) {
  return {
    enableTools: true,
    enableSpawnAgent: Boolean(t.enableSpawnAgent),
    enableAgentTeams: Boolean(t.enableAgentTeams),
    // Manage MCP Servers 的开关落在 SDK 的 disableMcpSettingsTools
    disableMcpSettingsTools: caps.useMcp === false,
    yolo: false,
  };
}
function normalize(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function converged(a, b) {
  const x = normalize(a);
  const y = normalize(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 12 && long.includes(short);
}

function shouldStop(cfg, hopIndex, text, prevText) {
  if (hopIndex + 1 >= Number(cfg.loop.maxHops || 0)) return "达到最大跳数";
  const kws = Array.isArray(cfg.loop.stopKeywords)
    ? cfg.loop.stopKeywords.map((s) => String(s).trim()).filter(Boolean)
    : [];
  for (const k of kws) {
    if (text.includes(k)) return `命中终止关键词「${k}」`;
  }
  if (cfg.loop.stopOnConvergence && converged(text, prevText)) return "双方输出已收敛（内容重复）";
  return null;
}

async function runRelay(cfg) {
  if (run.active) throw new Error("已有任务在运行");

  const core = await loadCore();
  const sides = resolveSides(core, cfg);

  run.active = true;
  run.stopping = false;
  run.hops = [];
  run.error = null;
  run.sessions = { A: null, B: null };
  run.startedAt = nowIso();

  broadcast("run:start", { startedAt: run.startedAt, config: cfg, sides: describeSides(sides) });

  let cline = null;
  let worktreeInfo = null;
  const runCfg = cfg;
  try {
    if (cfg.worktree && cfg.worktree.enabled) {
      const base = resolveCwd(cfg);
      const wt = createTaskWorktree(base);
      if (!wt.success) throw new Error(`Worktree 创建失败：${wt.message}`);
      worktreeInfo = wt;
      runCfg.workspace = { ...(cfg.workspace || {}), cwd: wt.path };
      broadcast("worktree", { path: wt.path, name: wt.name, base });
    }
    cline = await core.ClineCore.create({
      backendMode: cfg.advanced.backendMode || "local",
      clientName: "cline-relay-ui",
    });
    run.cline = cline;

    const env = sharedEnv(runCfg);

    // 先执行方决定「建会话顺序」和「第一个接力目标」
    const first = String(cfg.loop.firstSide || "A").toUpperCase() === "B" ? "B" : "A";
    const order = first === "A" ? ["A", "B"] : ["B", "A"];

    // --- 建立两个会话（按先执行方排序）
    for (const side of order) {
      const s = sides[side];
      const label = s.conf.name || side;
      const ov = s.ov || {};

      // ---- 该 side 生效的设置（覆盖优先，否则全局）
      const aa = effectiveAutoApprove(runCfg, ov);
      const tools = effectiveTools(runCfg, ov);
      const caps = effectiveCapabilities(runCfg, ov);
      const toolPolicies = buildToolPolicies(aa, caps, tools);
      const features = buildRuntimeFeatures(tools, caps);

      // 该 side 自己的工作目录（Add Context 之外的环境隔离）
      const sideCwd = ov.enabled && ov.cwd ? String(ov.cwd).trim() : "";
      const cwd = sideCwd || env.cwd;
      const wtDir = ov.enabled && ov.worktree && ov.worktree.enabled != null
        ? null : (runCfg.worktree && runCfg.worktree.enabled);

      const sessionConfig = {
        cwd,
        workspaceRoot: cwd,
        ...features,
        providerId: s.providerId,
        modelId: s.modelId,
        apiKey: s.apiKey,
        systemPrompt: String(s.conf.systemPrompt || DEFAULT_CONFIG[side.toLowerCase()].systemPrompt),
        reasoningEffort: s.thinking,
        checkpoint: {
          enabled: ov.enabled && ov.checkpoint && ov.checkpoint.enabled != null
            ? Boolean(ov.checkpoint.enabled)
            : Boolean(runCfg.checkpoint && runCfg.checkpoint.enabled),
        },
        compaction: {
          enabled: ov.enabled && ov.compaction ? ov.compaction.enabled !== false
            : runCfg.advanced.compactionEnabled !== false,
          strategy: (ov.enabled && ov.compaction && ov.compaction.strategy) || runCfg.advanced.compaction || "agentic",
        },
      };

      // ---- Manage MCP：真的把该角色的 MCP 工具禁用掉（SDK createDisabledMcpToolPolicies）
      const mcpOff = await mcpPoliciesForSide(core, caps, cwd);
      Object.assign(toolPolicies, mcpOff.policies);
      if (mcpOff.blocked) {
        broadcast("hop", {
          kind: "note", side, label, ts: nowIso(),
          text: mcpOff.note || `已禁用该角色的 MCP 工具（${mcpOff.servers.join(", ") || "无服务器"}）`,
        });
      }

      // ---- Add Files & Images：SDK 的 userImages / userFiles
      const att = ov.enabled && ov.attachments ? ov.attachments : {};
      const userImages = Array.isArray(att.images) ? att.images.filter(Boolean) : [];
      const userFiles = Array.isArray(att.files) ? att.files.filter(Boolean) : [];

      broadcast("session:start", { side, label, fork: s.fork, sourceId: s.sourceId, cwd });

      let r;
      // Add Context：override.context.initialMessagesFromSession 可为任意会话预载上下文
      const ctxFrom = ov.enabled && ov.context ? String(ov.context.initialMessagesFromSession || "").trim() : "";
      const preloadId = ctxFrom || (s.fork ? s.sourceId : "");

      if (s.fork || ctxFrom) {
        // 分叉 / 预载上下文：把历史消息灌进新会话，不发开场 prompt
        const msgs = await cline.readMessages(preloadId).catch(() => null);
        if (!Array.isArray(msgs) || !msgs.length) {
          throw new Error(`${label}: 无法读取历史会话 ${s.sourceId} 的消息`);
        }
        const forkMeta = core.createForkSessionMetadata({
          forkedFromSessionId: preloadId,
          forkedAt: new Date().toISOString(),
          source: "cline-relay-ui",
        });
        r = await cline.start({
          config: sessionConfig,
          toolPolicies,
          userImages,
          userFiles,
          initialMessages: msgs,
          sessionMetadata: forkMeta,
          prompt: undefined,
          interactive: true,
          mode: s.agentMode,
          source: "cline-relay-ui",
        });
        const openerRaw = lastAssistantText(s.sourceId);
        const opener = openerRaw && openerRaw.trim() ? openerRaw : lastAnyText(s.sourceId);
        const openerFinal = opener && opener.trim() ? opener : forkFallbackPrompt(label);
        run.hops.push({
          kind: "fork", side, label, sessionId: r.sessionId,
          text: openerFinal, inheritedFrom: s.sourceId, inheritedCount: msgs.length,
          openerSource: openerFinal === opener ? (openerRaw ? "assistant" : "any") : "fallback",
          provider: s.providerId, model: s.modelId, modelFrom: s.modelFrom, agentMode: s.agentMode, ts: nowIso(),
        });
        broadcast("hop", {
          kind: "fork", side, label, sessionId: r.sessionId, text: openerFinal,
          inheritedFrom: s.sourceId, inheritedCount: msgs.length,
          openerSource: openerFinal === opener ? (openerRaw ? "assistant" : "any") : "fallback",
          provider: s.providerId, model: s.modelId, modelFrom: s.modelFrom, agentMode: s.agentMode, ts: nowIso(),
        });
      } else {
        r = await cline.start({
          config: sessionConfig,
          toolPolicies,
          userImages,
          userFiles,
          prompt: String(s.conf.seedPrompt || ""),
          interactive: true,
          mode: s.agentMode,
          source: "cline-relay-ui",
        });
        const text = String(r.result?.text ?? "");
        run.hops.push({
          kind: "seed", side, label, sessionId: r.sessionId, text,
          provider: s.providerId, model: s.modelId, modelFrom: s.modelFrom, agentMode: s.agentMode, ts: nowIso(),
          usage: r.result?.usage ?? null, durationMs: r.result?.durationMs ?? null,
        });
        broadcast("hop", {
          kind: "seed", side, label, sessionId: r.sessionId, text,
          provider: s.providerId, model: s.modelId, modelFrom: s.modelFrom, agentMode: s.agentMode, ts: nowIso(),
          usage: r.result?.usage ?? null, durationMs: r.result?.durationMs ?? null,
        });
      }

      run.sessions[side] = r.sessionId;
      if (run.stopping) throw new Error("STOPPED");
    }

    // --- 乒乓：先执行方收到「另一方」的开场文本，然后交替
    const other = first === "A" ? "B" : "A";
    const firstHop = run.hops.find((h) => h.side === other);
    let carry = String(firstHop?.text || "");
    let prev = "";
    let target = first; // 本轮发给谁

    // SDK 在 prompt 为空或全空白时会抛 "prompt cannot be empty"。
    // 与其让用户看一个天书般的错误，不如在这里说清楚是谁的开场白空了。
    if (!carry.trim()) {
      const who = firstHop ? firstHop.label : other;
      throw new Error(
        `发给「${first}」的第一条内容来自「${who}」，但它是空的，SDK 无法接受空 prompt。` +
          `请检查：若「${who}」是「空白新建」，开场 prompt 不能为空；` +
          `若是「从历史会话分叉」，那个会话里可能没有任何可复用的文本。`
      );
    }

    const maxHops = Math.max(1, Number(cfg.loop.maxHops) || 1);
    for (let i = 0; i < maxHops; i++) {
      if (run.stopping) break;
      const side = target;
      const s = sides[side];
      const label = s.conf.name || side;
      const sessionId = run.sessions[side];

      if (!carry.trim()) {
        broadcast("run:stop", { reason: `第 ${i + 1} 跳发给「${label}」的内容为空，已停止`, hops: relayHops() });
        run.hops.push({
          kind: "guard", index: i, side, label, sessionId,
          text: "", ts: nowIso(),
        });
        broadcast("hop", {
          kind: "guard", index: i, side, label, sessionId,
          text: `（上一跳的回复是空的，无法继续发送给 ${label}）`,
        });
        break;
      }

      broadcast("hop:start", { index: i, side, label, sessionId, first: i === 0 });
      const t0 = Date.now();
      const r = await cline.send({
        sessionId,
        prompt: carry,
        mode: s.agentMode,
        timeoutMs: Number(cfg.loop.timeoutMs) || 180000,
      });
      const text = String(r?.text ?? "");
      const entry = {
        kind: "hop", index: i, side, label, sessionId,
        sent: carry, text, ts: nowIso(),
        usage: r?.usage ?? null, finishReason: r?.finishReason ?? null,
        iterations: r?.iterations ?? null, durationMs: Date.now() - t0,
      };
      run.hops.push(entry);
      broadcast("hop", entry);

      prev = carry;
      carry = text;
      target = target === "A" ? "B" : "A";

      const reason = shouldStop(cfg, i, text, prev);
      if (reason) {
        broadcast("run:stop", { reason, hops: relayHops() });
        break;
      }
      if (run.stopping) {
        broadcast("run:stop", { reason: "用户停止", hops: relayHops() });
        break;
      }
    }

    broadcast("run:done", { hops: relayHops(), sessions: run.sessions, worktree: worktreeInfo });
  } catch (e) {
    run.error = e?.message || String(e);
    broadcast("run:error", { message: run.error });
  } finally {
    if (cline) {
      try { await cline.dispose(); } catch { /* ignore */ }
    }
    run.cline = null;
    run.active = false;
    run.stopping = false;
  }
}

/** 只统计真正的接力跳数（不含开场/分叉/中断记录）。 */
function relayHops() {
  return run.hops.filter((h) => h.kind === "hop").length;
}

function describeSides(sides) {
  const o = {};
  for (const [k, v] of Object.entries(sides)) {
    o[k] = { fork: v.fork, sourceId: v.sourceId, providerId: v.providerId, modelId: v.modelId, inherited: v.inherited };
  }
  return o;
}

// ---------------------------------------------------------------- HTTP

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

async function readBody(req, limit = 1024 * 512) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error("请求体过大");
    chunks.push(c);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function validate(cfg) {
  const errs = [];
  for (const side of ["a", "b"]) {
    const conf = cfg[side] || {};
    if (!String(conf.systemPrompt || "").trim()) errs.push(`${side}.systemPrompt 不能为空`);
    const src = conf.source || { mode: "blank" };
    if (src.mode === "fork") {
      const id = String(src.sessionId || "").trim();
      if (!id) {
        errs.push(`${side}.source.sessionId 未选择`);
      } else if (!findSession(id)) {
        errs.push(`${side}: 历史会话 ${id} 不存在`);
      }
    } else if (!String(conf.seedPrompt || "").trim()) {
      errs.push(`${side}.seedPrompt 不能为空（空白新建时需要开场白）`);
    }
  }
  // 只要有任意一侧需要全局 model（没开覆盖、也没走分叉继承）就必须填
  const needsGlobalModel = ["a", "b"].some((s) => {
    const c = cfg[s] || {};
    const forked = (c.source || {}).mode === "fork" && String(c.source.sessionId || "").trim();
    const overriding = c.override && c.override.enabled && (c.override.providerId || c.override.modelId);
    return !forked && !overriding;
  });
  if (needsGlobalModel) {
    if (!cfg.model?.providerId) errs.push("model.providerId 不能为空");
    if (!cfg.model?.modelId) errs.push("model.modelId 不能为空");
    if (cfg.model?.planActSeparate) {
      for (const slot of ["plan", "act"]) {
        if (!cfg.model?.[slot]?.modelId) errs.push(`model.${slot}.modelId 不能为空（已开启 Plan/Act 分离）`);
      }
    }
  }
  const cwd = resolveCwd(cfg);
  if (cwd !== ROOT && !fs.existsSync(cwd)) errs.push(`工作目录不存在：${cwd}`);
  if (cfg.checkpoint?.enabled && cwd === ROOT) {
    errs.push("Checkpoints 需要一个真实的工作目录（当前是 UI 自己的目录）");
  }

  const hops = Number(cfg.loop?.maxHops);
  if (!Number.isFinite(hops) || hops < 1) errs.push("loop.maxHops 必须是 >= 1 的数字");
  return errs;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;

  try {
    // ---- SSE
    if (p === "/api/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      res.write(": connected\n\n");
      clients.add(res);
      sseWrite(res, "hello", { active: run.active, hops: run.hops.length });
      req.on("close", () => clients.delete(res));
      return;
    }

    // ---- 配置
    if (p === "/api/config" && req.method === "GET") return json(res, 200, loadConfig());

    if (p === "/api/config" && req.method === "PUT") {
      const body = await readBody(req);
      return json(res, 200, saveConfig(body));
    }

    // ---- 可选项
  if (p === "/api/options" && req.method === "GET") return json(res, 200, await listOptions());

    // ---- 历史会话列表
    if (p === "/api/sessions" && req.method === "GET") {
      return json(res, 200, { sessions: listSessions() });
    }

    // ---- 项目文件夹（工作目录候选）
    if (p === "/api/workspaces" && req.method === "GET") {
      return json(res, 200, { folders: listWorkspaces(), cwd: loadConfig().workspace?.cwd || "" });
    }

    // ---- Cline 真实全局设置（只读）
    if (p === "/api/cline-globals" && req.method === "GET") {
      return json(res, 200, readClineGlobals());
    }

    // ---- 某 provider 下的全部模型（用于下拉）
    if (p === "/api/models" && req.method === "GET") {
      const providerId = url.searchParams.get("providerId") || "";
      try {
        return json(res, 200, { providerId, models: await modelsForProvider(providerId) });
      } catch (e) {
        return json(res, 200, { providerId, models: [], error: e?.message });
      }
    }

    // ---- 某角色工作目录里真实生效的 rules / skills / workflows / hooks（只读）
    if (p === "/api/capability-scan" && req.method === "GET") {
      const side = (url.searchParams.get("side") || "a").toLowerCase() === "b" ? "B" : "A";
      const cfg = loadConfig();
      const core = await loadCore();
      const ov = (cfg[side.toLowerCase()] || {}).override || {};
      const cwd = (ov.enabled && ov.cwd) || resolveCwd(cfg);
      const scan = capabilityScan(core, cwd);
      let mcpServers = [];
      try {
        const s = core.loadMcpSettingsFile(core.resolveDefaultMcpSettingsPath());
        mcpServers = Object.keys((s && s.mcpServers) || {});
      } catch { /* ignore */ }
      return json(res, 200, {
        side, ...scan, mcpServers,
        toggles: {
          useMcp: "SDK 有真实开关：createDisabledMcpToolPolicies + disableMcpSettingsTools",
          useSkills: "SDK 有真实开关：toolPolicies.skills.enabled",
          rules: "无按会话开关 —— Cline 按工作目录搜索路径自动加载",
          workflows: "无按会话开关 —— Cline 按工作目录搜索路径自动加载",
          hooks: "无按会话开关 —— Cline 按工作目录搜索路径自动加载",
        },
      });
    }
    // ---- 每角色实际生效的配置（不返回任何密钥）：验证 A/B 是否真的分开
    if (p === "/api/debug/side-policies" && req.method === "GET") {
      const cfg = loadConfig();
      const core = await loadCore();
      const sides = resolveSides(core, cfg);   // 注意：结果里含 apiKey，下面只挑安全字段输出
      const pick = (side) => {
        const s = sides[side];
        const ov = s.ov || {};
        const aa = effectiveAutoApprove(cfg, ov);
        const tools = effectiveTools(cfg, ov);
        const caps = effectiveCapabilities(cfg, ov);
        return {
          side,
          label: s.conf.name || side,
          mode: s.agentMode,
          providerId: s.providerId,
          modelId: s.modelId,
          modelFrom: s.modelFrom,
          overrideEnabled: Boolean(ov.enabled),
          cwd: ov.enabled && ov.cwd ? ov.cwd : resolveCwd(cfg),
          toolPolicies: buildToolPolicies(aa, caps, tools),
          runtimeFeatures: buildRuntimeFeatures(tools, caps),
          disableMcpSettingsTools: buildRuntimeFeatures(tools, caps).disableMcpSettingsTools,
          autoApprove: aa,
          tools,
          capabilities: caps,
          attachments: (ov.enabled && ov.attachments) || { images: [], files: [] },
          context: (ov.enabled && ov.context) || {},
        };
      };
      return json(res, 200, { a: pick("A"), b: pick("B") });
    }
    // ---- 单个模型的能力（SDK ModelInfoSchema.capabilities）
    if (p === "/api/model-info" && req.method === "GET") {
      const providerId = url.searchParams.get("providerId") || "";
      const modelId = url.searchParams.get("modelId") || "";
      try {
        const all = await modelsForProvider(providerId);
        const info = all.find((m) => m.id === modelId) || null;
        return json(res, 200, {
          found: Boolean(info),
          providerId,
          modelId,
          origin: info ? info.origin : null,
          capabilities: info ? info.capabilities : [],
          contextWindow: info ? info.contextWindow : null,
          maxTokens: info ? info.maxTokens : null,
          displayName: info ? info.displayName : null,
        });
      } catch (e) {
        return json(res, 200, { found: false, providerId, modelId, capabilities: [], error: e?.message });
      }
    }
    // ---- 运行
    if (p === "/api/run" && req.method === "POST") {
      if (run.active) return json(res, 409, { error: "已有任务在运行" });
      const body = await readBody(req);
      const cfg = mergeDeep(loadConfig(), body.config || {});
      const errs = validate(cfg);
      if (errs.length) return json(res, 400, { error: errs.join("；") });
      saveConfig(cfg);
      runRelay(cfg).catch(() => {}); // 后台跑，错误通过 SSE 报
      return json(res, 202, { started: true });
    }

    if (p === "/api/stop" && req.method === "POST") {
      if (!run.active) return json(res, 409, { error: "没有正在运行的任务" });
      run.stopping = true;
      const ids = Object.values(run.sessions).filter(Boolean);
      if (run.cline) {
        for (const id of ids) {
          try { await run.cline.abort(id, "user requested stop"); } catch { /* ignore */ }
        }
      }
      return json(res, 200, { stopping: true });
    }

    if (p === "/api/state" && req.method === "GET") {
      return json(res, 200, {
        active: run.active,
        stopping: run.stopping,
        sessions: run.sessions,
        hops: run.hops,
        startedAt: run.startedAt,
        error: run.error,
      });
    }

    // ---- 静态文件
    if (req.method === "GET") {
      const rel = p === "/" ? "index.html" : p.replace(/^\/+/, "");
      const file = path.join(PUBLIC_DIR, rel);
      if (!file.startsWith(PUBLIC_DIR)) {
        res.writeHead(403).end("forbidden");
        return;
      }
      try {
        const data = await fsp.readFile(file);
        res.writeHead(200, {
          "content-type": MIME[path.extname(file)] || "application/octet-stream",
          "cache-control": "no-store",
        });
        res.end(data);
        return;
      } catch {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
        return;
      }
    }

    res.writeHead(405).end("method not allowed");
  } catch (e) {
    json(res, 500, { error: e?.message || String(e) });
  }
});

function listen(port) {
  server.once("error", (e) => {
    if (e.code === "EADDRINUSE") {
      // 不静默换端口：否则浏览器可能连到旧实例，症状极难排查
      console.error("");
      console.error(`[错误] 端口 ${port} 已被占用。`);
      console.error("");
      console.error("很可能已经有一个 Cline Relay UI 在运行。请先关掉它（关掉启动它的那个黑窗口），再重新启动。");
      console.error(`如果确认没有，请换一个端口：set PORT=5188 && node server.js`);
      console.error("");
      process.exit(1);
    }
    console.error("[server]", e.message);
    process.exit(1);
  });
  server.listen(port, "127.0.0.1", () => {
    writePidFile();
    console.log(`Cline Relay UI  ->  http://127.0.0.1:${port}`);
    console.log(`  PID  : ${process.pid}`);
    console.log(`  SDK  : ${CORE_ENTRY || "not found (set CORE_ENTRY)"}`);
    console.log(`  Conf : ${CONFIG_PATH}`);
    console.log(`  按 Ctrl+C 停止`);
  });
}

const PID_PATH = path.join(ROOT, "server.pid");

function writePidFile() {
  try {
    fs.writeFileSync(PID_PATH, String(process.pid), "utf8");
  } catch { /* ignore */ }
}

function clearPidFile() {
  try {
    if (fs.existsSync(PID_PATH) && fs.readFileSync(PID_PATH, "utf8").trim() === String(process.pid)) {
      fs.unlinkSync(PID_PATH);
    }
  } catch { /* ignore */ }
}

function close() {
  for (const res of clients) {
    try { res.end(); } catch { /* ignore */ }
  }
  clients.clear();
  clearPidFile();
  server.close();
}

process.on("exit", clearPidFile);
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { clearPidFile(); process.exit(0); });
}

module.exports = { server, listen, close, listOptions, listSessions, loadConfig, saveConfig, PID_PATH };

if (require.main === module) listen(PORT);
