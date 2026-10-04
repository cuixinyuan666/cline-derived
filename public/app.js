"use strict";

const $ = (id) => document.getElementById(id);
const SIDES = ["a", "b"];

// ---------------------------------------------------------------- 致命错误

function fatal(html) {
  const el = $("fatal");
  if (!el) return;
  el.innerHTML = html;
  el.style.display = "block";
}

// 注意：不要在这里调用 startApp()。
// 下面还有 const layout / let dirty 等声明，提前调用会踩暂时性死区
// （ReferenceError: Cannot access 'layout' before initialization），
// 脚本一崩所有按钮都会失效。dispatch 放在文件末尾。

let dirty = false;
let SESSIONS = [];
let modes = { a: "blank", b: "blank" };
let firstSide = "A";
let cfg0Model = "";
let hopCount = 0;
let LAST_CFG = null;
let OPTS = { toolItems: [], approvalActions: [], toolPresets: {}, allToolNames: [] };
let FOLDERS = [];

function renderFolders() {
  const sel = $("folderPick");
  if (!sel) return;
  sel.innerHTML = "";
  const ph = document.createElement("option");
  ph.value = ""; ph.textContent = "— 选择一个项目文件夹 —";
  sel.appendChild(ph);
  for (const f of FOLDERS) {
    const o = document.createElement("option");
    o.value = f.path;
    o.textContent = `${f.label}  —  ${f.path}${f.added ? "  ★" : ""}  (${f.count} 个会话)`;
    sel.appendChild(o);
  }
  const hint = $("folderHint");
  if (hint) hint.textContent = `共 ${FOLDERS.length} 个文件夹（含历史会话里出现过的真实目录）。★ = 你手动添加的，会被记住。`;
}

async function loadWorkspaces() {
  try {
    const d = await (await fetch("/api/workspaces")).json();
    FOLDERS = d.folders || [];
    renderFolders();
  } catch { /* ignore */ }
}

// 只有这两个是 SDK 里真能按角色控制的；Rules/Workflows/Hooks 由 Cline 按工作目录自动发现，
// 没有按会话开关，所以界面上只做只读展示，不放假开关。
const CAP_ITEMS = [
  { id: "useMcp", label: "Manage MCP servers", hint: "关掉后用 SDK 的 createDisabledMcpToolPolicies 真的禁用该角色的 MCP 工具" },
  { id: "useSkills", label: "Skills", hint: "关掉后 toolPolicies.skills.enabled=false" },
];

const TOOL_KEYS = [
  ["enableReadFiles", "Read files"], ["enableSearch", "Search codebase"],
  ["enableBash", "Run commands"], ["enableWebFetch", "Fetch web content"],
  ["enableApplyPatch", "Apply patch"], ["enableEditor", "Editor"],
  ["enableSkills", "Skills"], ["enableAskQuestion", "Ask question"],
  ["enableSubmitAndExit", "Submit and exit"],
  ["enableSpawnAgent", "Spawn sub-agent"], ["enableAgentTeams", "Agent teams"],
];

/** 为某个 side 构建 Auto-approve 面板 */
function buildSideApproval(side) {
  const box = $(`${side}_aaActions`);
  if (!box) return;
  box.innerHTML = "";
  for (const a of OPTS.approvalActions) {
    const wrap = document.createElement("div");
    wrap.className = "switch";
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.id = `${side}_aa_${a.id}`;
    const sp = document.createElement("span");
    sp.textContent = a.label; sp.title = a.hint || "";
    wrap.appendChild(cb); wrap.appendChild(sp);
    box.appendChild(wrap);
  }
}

/** 为某个 side 构建工具能力面板 */
function buildSideTools(side) {
  const box = $(`${side}_toolToggles`);
  if (!box) return;
  box.innerHTML = "";
  for (const [k, label] of TOOL_KEYS) {
    const wrap = document.createElement("div");
    wrap.className = "switch";
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.id = `${side}_${k}`;
    const sp = document.createElement("span");
    sp.textContent = label;
    wrap.appendChild(cb); wrap.appendChild(sp);
    box.appendChild(wrap);
  }
  const sel = $(`${side}_toolPreset`);
  if (sel) {
    sel.addEventListener("change", () => {
      const p = OPTS.toolPresets && OPTS.toolPresets[sel.value];
      if (p) {
        for (const [k] of TOOL_KEYS) { const el = $(`${side}_${k}`); if (el) el.checked = Boolean(p[k]); }
      }
      markDirty();
    });
  }
}

/** 为某个 side 构建扩展能力面板 */
function buildSideCaps(side) {
  const box = $(`${side}_caps`);
  if (!box) return;
  box.innerHTML = "";
  for (const c of CAP_ITEMS) {
    const wrap = document.createElement("div");
    wrap.className = "switch";
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.id = `${side}_cap_${c.id}`;
    const sp = document.createElement("span");
    sp.textContent = c.label; sp.title = c.hint || "";
    wrap.appendChild(cb); wrap.appendChild(sp);
    box.appendChild(wrap);
  }
}
// ---------------------------------------------------------------- 表单读写辅助


const LAYOUT_KEY = "relay-layout";
const MIN_W = 300;

function loadLayout() {
  let d = {};
  try { d = JSON.parse(localStorage.getItem(LAYOUT_KEY) || "{}"); } catch { /* ignore */ }
  return {
    w: Number(d.w) || 480,
    left: d.left !== false,
    right: d.right !== false,
  };
}
function saveLayout() {
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch { /* ignore */ }
}
const layout = loadLayout();

function applyLayout() {
  const sh = $("shell");
  sh.style.setProperty("--lw", layout.w + "px");
  sh.classList.toggle("no-left", !layout.left);
  sh.classList.toggle("no-right", !layout.right);
  for (const b of $("paneSeg").children) {
    if (b.dataset.pane === "reset") continue;
    const on = b.dataset.pane === "left" ? layout.left : layout.right;
    b.setAttribute("aria-pressed", String(on));
  }
  saveLayout();
}

/**
 * 切换某一栏，语义对齐 VS Code 的 Ctrl+B / Ctrl+J：
 *   两栏都在      -> 隐藏这一栏（另一栏最大化）
 *   只剩另一栏    -> 隐藏的这一栏回来（两栏都在）
 *   只剩这一栏    -> 把另一栏也恢复（两栏都在）
 * 任何情况下都不会两栏全空。
 */
function togglePane(which) {
  const other = which === "left" ? "right" : "left";
  if (layout[which] && !layout[other]) {
    layout[which] = true;
    layout[other] = true;
  } else if (!layout[which] && layout[other]) {
    layout[which] = true;
  } else {
    layout[which] = !layout[which];
    if (!layout.left && !layout.right) layout[other] = true;
  }
  applyLayout();
}

function resetWidth() {
  layout.w = 480;
  applyLayout();
}

function initSplit() {
  const split = $("split");
  let dragging = false;
  split.addEventListener("mousedown", (e) => {
    dragging = true;
    split.classList.add("drag");
    document.body.classList.add("resizing");
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const w = Math.max(MIN_W, Math.min(window.innerWidth - MIN_W, e.clientX));
    layout.w = Math.round(w);
    applyLayout();
  });
  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    split.classList.remove("drag");
    document.body.classList.remove("resizing");
    saveLayout();
  });
  // 双击分隔线 = 复位宽度（替代原来的「还原」按钮）
  split.addEventListener("dblclick", () => resetWidth());
  // 触屏/触控笔
  split.addEventListener("touchstart", () => { dragging = true; }, { passive: true });
  split.addEventListener("touchmove", (e) => {
    if (!dragging) return;
    layout.w = Math.round(Math.max(MIN_W, Math.min(window.innerWidth - MIN_W, e.touches[0].clientX)));
    applyLayout();
  }, { passive: true });
  split.addEventListener("touchend", () => { dragging = false; saveLayout(); });
}

// ---------------------------------------------------------------- 主题

function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  for (const b of $("themeSeg").children) b.setAttribute("aria-pressed", String(b.dataset.theme === t));
  try { localStorage.setItem("relay-theme", t); } catch { /* ignore */ }
}

// ---------------------------------------------------------------- 配置

// 全局面板已移入角色，元素可能不存在：统一用安全取值器
const V = (id, d = "") => { const el = $(id); return el ? el.value : d; };
const C = (id) => { const el = $(id); return el ? el.checked : false; };
const setV = (id, v) => { const el = $(id); if (el) el.value = v == null ? "" : v; };
const setC = (id, v) => { const el = $(id); if (el) el.checked = !!v; };
const showIf = (id, on) => { const el = $(id); if (el) el.style.display = on ? "block" : "none"; };
const lines = (s) => String(s || "").split(/[\r\n]+/).map((x) => x.trim()).filter(Boolean);

function readSideActions(side) {
  const out = {};
  for (const a of OPTS.approvalActions) {
    const el = $(`${side}_aa_${a.id}`);
    out[a.id] = el ? el.checked : false;
  }
  out.readFilesExternally = Boolean(out.readFiles);
  out.editFilesExternally = Boolean(out.editFiles);
  return out;
}
function writeSideActions(side, actions) {
  const a = actions || {};
  for (const item of OPTS.approvalActions) {
    const el = $(`${side}_aa_${item.id}`);
    if (el) el.checked = Boolean(a[item.id]);
  }
}
function readSideTools(side) {
  const out = { preset: V(`${side}_toolPreset`, "act") };
  for (const [k] of TOOL_KEYS) { const el = $(`${side}_${k}`); out[k] = el ? el.checked : false; }
  return out;
}
function writeSideTools(side, v) {
  setV(`${side}_toolPreset`, (v && v.preset) || "act");
  for (const [k] of TOOL_KEYS) { const el = $(`${side}_${k}`); if (el) el.checked = Boolean(v && v[k]); }
}
function readSideCaps(side) {
  const out = {};
  for (const c of CAP_ITEMS) { const el = $(`${side}_cap_${c.id}`); out[c.id] = el ? el.checked : true; }
  return out;
}
function writeSideCaps(side, v) {
  for (const c of CAP_ITEMS) {
    const el = $(`${side}_cap_${c.id}`);
    if (el) el.checked = v && c.id in v ? Boolean(v[c.id]) : true;
  }
}
/** 该角色工作目录里真实生效的 rules / skills / workflows / hooks（来自 SDK 的解析函数） */
async function loadCapabilityScan(side) {
  const box = $(`${side}_capScan`);
  if (!box) return;
  box.textContent = "正在读取 Cline 实际使用的路径…";
  let d = {};
  try {
    d = await (await fetch(`/api/capability-scan?side=${side}`)).json();
  } catch {
    box.textContent = "读取失败（后端不可达）";
    return;
  }
  const list = (title, arr, empty) =>
    `<div style="margin-top:6px"><b>${title}</b>（${arr.length}）` +
    (arr.length
      ? `<ul style="margin:3px 0 0 16px">${arr.map((x) => `<li><code>${esc(x)}</code></li>`).join("")}</ul>`
      : `<div class="hint">${empty}</div>`) +
    `</div>`;
  box.innerHTML =
    `<div class="hint">下面这些路径由 Cline 按<b>该角色的工作目录</b>自动发现，` +
    `SDK 没有按会话的开关，所以只读展示，不假装能单独关掉。</div>` +
    list("MCP 服务器（cline_mcp_settings.json）", d.mcpServers || [], "没有配置任何 MCP 服务器") +
    list("Rules", d.rules || [], "没找到 .clinerules / AGENTS.md 等规则文件") +
    list("Skills", d.skills || [], "没找到 skills 目录") +
    list("Workflows", d.workflows || [], "没找到 workflows 目录") +
    list("Hooks 目录", d.hooks || [], "没找到 hooks 目录") +
    (d.hookFiles && d.hookFiles.length
      ? list("已生效的 Hook 文件", d.hookFiles.map((h) => `${h.fileName}  ${h.path}`), "")
      : `<div style="margin-top:6px"><b>已生效的 Hook 文件</b><div class="hint">当前工作目录没有 Hook 配置文件</div></div>`);
}
function readSideOverride(side) {
  return {
    enabled: C(`${side}_full`),
    mode: V(`${side}_mode`, "act"),
    providerId: V(`${side}_providerId`).trim(),
    modelId: V(`${side}_modelId`).trim(),
    thinking: V(`${side}_thinking`, ""),
    cwd: V(`${side}_cwd`).trim(),
    adaptiveThinking: C(`${side}_adaptiveThinking`),
    promptCache: C(`${side}_promptCache`),
    planActSeparate: C(`${side}_planActSeparate`),
    plan: { providerId: V(`${side}_planProviderId`).trim(), modelId: V(`${side}_planModelId`).trim() },
    act: { providerId: V(`${side}_actProviderId`).trim(), modelId: V(`${side}_actModelId`).trim() },
    ocaMode: V(`${side}_ocaMode`, ""),
    autoApprove: {
      enabled: C(`${side}_aaEnabled`),
      maxRequests: Number(V(`${side}_aaMaxRequests`, 0)) || 0,
      notifications: C(`${side}_aaEnabled`),
      webSearch: C(`${side}_aaWebSearch`),
      actions: readSideActions(side),
    },
    tools: readSideTools(side),
    capabilities: readSideCaps(side),
    context: { initialMessagesFromSession: V(`${side}_ctxFrom`, "") },
    attachments: { images: lines(V(`${side}_images`)), files: lines(V(`${side}_files`)) },
    compaction: { enabled: C(`${side}_cmpEnabled`), strategy: V(`${side}_cmpStrategy`, "") },
    checkpoint: { enabled: C(`${side}_ckEnabled`) },
    worktree: { enabled: C(`${side}_wtEnabled`) },
    backendMode: V(`${side}_backendMode`, ""),
  };
}
function writeSideOverride(side, ov) {
  const v = ov || {};
  setC(`${side}_full`, v.enabled);
  setV(`${side}_mode`, v.mode || "act");
  setV(`${side}_providerId`, v.providerId || V(`${side}_providerId`));
  setV(`${side}_modelId`, v.modelId || V(`${side}_modelId`));
  setV(`${side}_thinking`, v.thinking || "");
  setV(`${side}_cwd`, v.cwd || "");
  setC(`${side}_adaptiveThinking`, v.adaptiveThinking);
  setC(`${side}_promptCache`, v.promptCache);
  setC(`${side}_planActSeparate`, v.planActSeparate);
  setV(`${side}_planProviderId`, (v.plan && v.plan.providerId) || "");
  setV(`${side}_planModelId`, (v.plan && v.plan.modelId) || "");
  setV(`${side}_actProviderId`, (v.act && v.act.providerId) || "");
  setV(`${side}_actModelId`, (v.act && v.act.modelId) || "");
  setV(`${side}_ocaMode`, v.ocaMode || "");
  const aa = v.autoApprove || {};
  setC(`${side}_aaEnabled`, aa.enabled);
  setV(`${side}_aaMaxRequests`, aa.maxRequests ?? 0);
  setC(`${side}_aaWebSearch`, aa.webSearch);
  writeSideActions(side, aa.actions || {});
  writeSideTools(side, v.tools || {});
  writeSideCaps(side, v.capabilities || {});
  setV(`${side}_ctxFrom`, (v.context && v.context.initialMessagesFromSession) || "");
  setV(`${side}_images`, lines((v.attachments && v.attachments.images) || []).join("\n"));
  setV(`${side}_files`, lines((v.attachments && v.attachments.files) || []).join("\n"));
  setC(`${side}_cmpEnabled`, v.compaction ? v.compaction.enabled !== false : false);
  setV(`${side}_cmpStrategy`, (v.compaction && v.compaction.strategy) || "");
  setC(`${side}_ckEnabled`, Boolean(v.checkpoint && v.checkpoint.enabled));
  setC(`${side}_wtEnabled`, Boolean(v.worktree && v.worktree.enabled));
  setV(`${side}_backendMode`, v.backendMode || "");
}
function readForm() {
  const last = LAST_CFG || {};
  const out = {
    ui: { theme: document.documentElement.getAttribute("data-theme") || "dim" },
    workspace: {
      cwd: V("cwd"),
      folders: FOLDERS.filter((f) => f.added).map((f) => ({ path: f.path, label: f.label })),
    },
    loop: {
      firstSide,
      maxHops: Number(V("maxHops", 1)) || 1,
      timeoutMs: (Number(V("timeoutSec", 180)) || 180) * 1000,
      stopKeywords: V("stopKeywords").split(",").map((s) => s.trim()).filter(Boolean),
      stopOnConvergence: C("stopOnConvergence"),
    },
    // 全局模型保留为「默认模型」；模型/凭据也可在每个角色里单独覆盖
    model: {
      providerId: V("providerId").trim(),
      modelId: V("modelId").trim(),
      thinking: V("thinking", "medium"),
      adaptiveThinking: C("adaptiveThinking"),
      promptCache: C("promptCache"),
      planActSeparate: C("planActSeparate"),
      plan: { providerId: V("planProviderId").trim(), modelId: V("planModelId").trim() },
      act: { providerId: V("actProviderId").trim(), modelId: V("actModelId").trim() },
      ocaMode: V("ocaMode", ""),
    },
    // 以下面板已移入每个角色：原样回写，保留后端已存的值
    advanced: last.advanced || {},
    autoApprove: last.autoApprove || {},
    tools: last.tools || {},
    checkpoint: last.checkpoint || {},
    worktree: last.worktree || {},
  };
  for (const s of SIDES) {
    out[s] = {
      name: V(`${s}_name`).trim() || s.toUpperCase(),
      systemPrompt: V(`${s}_systemPrompt`),
      seedPrompt: V(`${s}_seedPrompt`),
      source: { mode: modes[s], sessionId: V(`${s}_sessionId`) },
      override: readSideOverride(s),
    };
  }
  return out;
}

function fillForm(cfg) {
  LAST_CFG = cfg || {};
  setV("cwd", cfg.workspace?.cwd || "");
  setV("maxHops", cfg.loop.maxHops);
  setV("timeoutSec", Math.round((cfg.loop.maxHops ? (cfg.loop.timeoutMs || 180000) : 180000) / 1000));
  setV("stopKeywords", (cfg.loop.stopKeywords || []).join(", "));
  setC("stopOnConvergence", !!cfg.loop.stopOnConvergence);
  setV("backendMode", (cfg.advanced && cfg.advanced.backendMode) || "");
  setV("compaction", (cfg.advanced && cfg.advanced.compaction) || "agentic");
  setC("compactionEnabled", !cfg.advanced || cfg.advanced.compactionEnabled !== false);

  const m = cfg.model || {};
  if (m.modelId) setV("modelId", m.modelId);
  setV("thinking", m.thinking || "medium");
  setC("adaptiveThinking", !!m.adaptiveThinking);
  setC("promptCache", !!m.promptCache);
  setC("planActSeparate", !!m.planActSeparate);
  if (m.plan && m.plan.providerId) setV("planProviderId", m.plan.providerId);
  if (m.plan && m.plan.modelId) setV("planModelId", m.plan.modelId);
  if (m.act && m.act.providerId) setV("actProviderId", m.act.providerId);
  if (m.act && m.act.modelId) setV("actModelId", m.act.modelId);
  setV("ocaMode", m.ocaMode || "");

  firstSide = (cfg.loop.firstSide || "A").toUpperCase() === "B" ? "B" : "A";
  for (const s of SIDES) {
    const c = cfg[s] || {};
    setV(`${s}_name`, c.name || s.toUpperCase());
    setV(`${s}_systemPrompt`, c.systemPrompt || "");
    setV(`${s}_seedPrompt`, c.seedPrompt || "");
    modes[s] = (c.source && c.source.mode) || "blank";
    setV(`${s}_sessionId`, (c.source && c.source.sessionId) || "");
    writeSideOverride(s, c.override || {});
  }
  applyTheme((cfg.ui && cfg.ui.theme) || "dim");
  syncAll();
  markClean();
}

function markDirty() {
  if (dirty) return;
  dirty = true;
  $("bSaved").textContent = "未保存";
  $("bSaved").className = "badge warn";
}
function markClean() {
  dirty = false;
  $("bSaved").textContent = "已保存";
  $("bSaved").className = "badge ok";
}

// ---------------------------------------------------------------- 同步

function syncToggles() {
  for (const s of SIDES) {
    showIf(`${s}_fullBox`, C(`${s}_full`));
    showIf(`${s}_planActBox`, C(`${s}_planActSeparate`));
  }
  showIf("planActBox", C("planActSeparate"));
  showIf("ckWarn", C("ckEnabled"));
  showIf("wtWarn", C("wtEnabled"));
}

function syncSides() {
  let anyFork = false;
  for (const s of SIDES) {
    for (const b of $(`${s}_modeSeg`).children) b.setAttribute("aria-pressed", String(b.dataset.mode === modes[s]));
    const fork = modes[s] === "fork";
    $(`${s}_forkBox`).style.display = fork ? "block" : "none";
    $(`${s}_seedBox`).style.display = fork ? "none" : "block";
    $(`${s}_seedPrompt`).disabled = fork;
    showIf(`${s}_fullBox`, C(`${s}_full`));
    if (fork) anyFork = true;
    updateForkHint(s);
  }
  // 先执行方按钮高亮 + 顶栏标记
  for (const b of $("firstSeg").children) {
    b.setAttribute("aria-pressed", String(b.dataset.first === firstSide));
  }
  const firstName = (V(`${firstSide.toLowerCase()}_name`) || firstSide).trim();
  $("bFirst").textContent = `${firstName} 先`;
  const noteEl = $("forkNote");
  if (noteEl) {
    noteEl.innerHTML = anyFork
      ? "已选择分叉：<b>该 side 沿用历史会话自己的 provider / model</b>；thinking 无法继承。"
      : "凭据自动从 <code>providers.json</code> 读取，界面上不显示任何密钥。";
  }
}

function updateForkHint(side) {
  const id = $(`${side}_sessionId`).value;
  const el = $(`${side}_forkHint`);
  if (!el) return;
  const rec = SESSIONS.find((x) => x.id === id);
  if (!rec) { el.textContent = "未选择会话。"; el.className = "hint warn"; return; }
  const ovOn = C(`${side}_full`);
  const ovProvider = V(`${side}_providerId`);
  const ovModel = V(`${side}_modelId`);
  const ovMode = V(`${side}_mode`, "act");
  el.textContent =
    `将继承 ${rec.msgCount ?? "?"} 条消息 · provider=${rec.provider || "?"} · model=${rec.model || "?"}` +
    (rec.cwd ? ` · 原目录 ${rec.cwd}` : "") +
    (ovOn
      ? `　→ 你勾选了「单独指定模型」，实际使用 ${ovProvider} / ${ovModel || "（空）"}（mode=${ovMode}）`
      : "　→ 模型沿用全局设置");
  el.className = "hint ok";
}

function syncAll() { syncToggles(); syncSides(); }

// ---------------------------------------------------------------- 选项 / 会话

async function loadOptions() {
  let opt;
  try { opt = await (await fetch("/api/options")).json(); }
  catch { $("bSdk").textContent = "后端不可达"; $("bSdk").className = "badge err"; return; }

  OPTS = { toolItems: opt.toolItems || [], approvalActions: opt.approvalActions || [], toolPresets: opt.toolPresets || {}, allToolNames: opt.allToolNames || [] };

  const b = $("bSdk");
  if (opt.coreFound) { b.textContent = "SDK 就绪"; b.className = "badge ok"; b.title = opt.coreEntry; }
  else { b.textContent = "未找到 @cline/core"; b.className = "badge err"; b.title = "请设置环境变量 CORE_ENTRY 后重启"; }

  const sel = $("providerId");
  const cur = sel.value || cfg0Model;
  sel.innerHTML = "";
  for (const p of opt.providers || []) {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = `${p.id}${p.model ? "  — " + p.model : ""}${p.hasAuth ? "" : "  (无凭据)"}`;
    sel.appendChild(o);
  }
  if (cur && (opt.providers || []).some((p) => p.id === cur)) sel.value = cur;

  const dl = $("modelList");
  dl.innerHTML = "";
  for (const m of opt.models || []) { const o = document.createElement("option"); o.value = m; dl.appendChild(o); }

  // 把 provider 选项灌到所有 provider 下拉
  for (const id of ["providerId", "planProviderId", "actProviderId",
                    "a_providerId", "b_providerId",
                    "a_planProviderId", "a_actProviderId", "b_planProviderId", "b_actProviderId"]) {
    const s = $(id);
    if (!s) continue;
    const keep = s.value;
    s.innerHTML = "";
    for (const p of opt.providers || []) {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = p.id + (p.model ? "  — " + p.model : "") + (p.hasAuth ? "" : "  (无凭据)");
      s.appendChild(o);
    }
    if (keep) s.value = keep;
  }
  const globalModel = V("modelId").trim();
  if (!globalModel) {
    const p = (opt.providers || []).find((x) => x.id === V("providerId"));
    if (p && p.model) setV("modelId", p.model);
  }
  const gm = V("modelId");
  for (const s of SIDES) {
    if (!V(`${s}_modelId`).trim()) setV(`${s}_modelId`, gm);
  }
  if (!V("planModelId").trim()) setV("planModelId", gm);
  if (!V("actModelId").trim()) setV("actModelId", gm);

  // 每个角色的能力面板（Auto-approve / 工具 / 扩展能力），必须在回填配置之前建好
  for (const s of SIDES) {
    if (!$(`${s}_aaActions`) || !$(`${s}_aaActions`).children.length) buildSideApproval(s);
    if (!$(`${s}_toolToggles`) || !$(`${s}_toolToggles`).children.length) buildSideTools(s);
    if (!$(`${s}_caps`) || !$(`${s}_caps`).children.length) buildSideCaps(s);
    if (!V(`${s}_modelId`).trim()) setV(`${s}_modelId`, gm);
    loadCapabilityScan(s);   // 真实 rules / skills / workflows / hooks 路径
  }
  updateModelInfo();
}

/** 模型能力提示：来自 SDK 的 ModelInfoSchema.capabilities（models.dev 目录） */
const MODEL_TARGETS = [
  { pid: "providerId", mid: "modelId", info: "modelInfo", dl: "modelList" },
  { pid: "a_providerId", mid: "a_modelId", info: "a_modelInfo", dl: "modelList_a" },
  { pid: "b_providerId", mid: "b_modelId", info: "b_modelInfo", dl: "modelList_b" },
];

async function updateModelInfo() {
  for (const t of MODEL_TARGETS) await refreshModelInfo(t);
}

async function refreshModelInfo(t) {
  const el = $(t.info);
  if (!el) return;
  const pidEl = $(t.pid), midEl = $(t.mid);
  const pid = pidEl ? pidEl.value : "";
  const mid = midEl ? midEl.value.trim() : "";
  if (!mid) { el.textContent = "模型能力：未选择模型（留空则跟随全局）"; el.className = "hint"; return; }

  el.textContent = "模型能力：查询中…";
  el.className = "hint";

  // 先把该 provider 下已知模型灌进 datalist（真实 ModelInfo 列表）
  try {
    const r = await fetch("/api/models?providerId=" + encodeURIComponent(pid));
    const d = await r.json().catch(() => ({}));
    const dl = $(t.dl);
    if (dl && Array.isArray(d.models)) {
      dl.innerHTML = "";
      for (const m of d.models) {
        const o = document.createElement("option");
        o.value = m.id;
        o.label = m.displayName || m.id;
        dl.appendChild(o);
      }
    }
  } catch { /* 忽略：下拉只是辅助 */ }

  const d = await fetch("/api/model-info?providerId=" + encodeURIComponent(pid) + "&modelId=" + encodeURIComponent(mid))
    .then((x) => x.json()).catch(() => ({}));
  if (!d.found) {
    el.textContent = "模型能力：本机没有 " + pid + "/" + mid + " 的 ModelInfo（将使用 provider 默认行为）";
    el.className = "hint warn";
    return;
  }
  const caps = d.capabilities || [];
  const extra = d.contextWindow ? " · 上下文 " + d.contextWindow : "";
  el.textContent = (caps.length ? "模型能力：" + caps.join(" / ") : "模型能力：未声明") + extra;
  el.className = caps.includes("tools") ? "hint ok" : "hint warn";
}
function fmtWhen(iso) {
  if (!iso) return "";
  try { return new Date(iso).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }); }
  catch { return ""; }
}

async function loadSessions() {
  let data;
  try { data = await (await fetch("/api/sessions")).json(); } catch { return; }
  SESSIONS = data.sessions || [];
  // 筛选器的可选项来自真实数据
  const statuses = [...new Set(SESSIONS.map((r) => r.status).filter(Boolean))].sort();
  const sources = [...new Set(SESSIONS.map((r) => r.source).filter(Boolean))].sort();
  for (const s of SIDES) {
    const fs = $(`${s}_fStatus`);
    const fsrc = $(`${s}_fSource`);
    if (fs && !fs.dataset.filled) {
      fs.innerHTML = `<option value="">Status: All</option>` +
        statuses.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join("");
      fs.dataset.filled = "1";
    }
    if (fsrc && !fsrc.dataset.filled) {
      fsrc.innerHTML = `<option value="">Source: All sources</option>` +
        sources.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join("");
      fsrc.dataset.filled = "1";
    }
  }
  for (const s of SIDES) fillSessionSelect(s);
}

/** 按 Status / Source / 时间排序填充某个角色的历史会话下拉 */
function fillSessionSelect(side) {
  const sel = $(`${side}_sessionId`);
  if (!sel) return;
  const cur = sel.value;
  const st = V(`${side}_fStatus`);
  const src = V(`${side}_fSource`);
  const dir = V(`${side}_fSort`) === "asc" ? 1 : -1;

  let rows = SESSIONS.filter((r) => (!st || r.status === st) && (!src || r.source === src));
  rows = rows.slice().sort((a, b) => dir * String(a.startedAt || "").localeCompare(String(b.startedAt || "")));

  sel.innerHTML = "";
  const ph = document.createElement("option");
  ph.value = ""; ph.textContent = "— 选择一个历史会话 —";
  sel.appendChild(ph);
  for (const r of rows) {
    const o = document.createElement("option");
    o.value = r.id;
    const t = r.title ? r.title.slice(0, 40) : "(无标题)";
    o.textContent = `${fmtWhen(r.startedAt)} · ${r.status || "?"} · ${t} · ${r.msgCount ?? "?"}条 · ${r.model || "?"}`;
    sel.appendChild(o);
  }
  if (cur && rows.some((x) => x.id === cur)) sel.value = cur;
  updateForkHint(side);
  const cnt = $(`${side}_forkCount`);
  if (cnt) cnt.textContent = `共 ${rows.length} / ${SESSIONS.length} 个会话`;

  // Add Context：预载上下文的会话下拉（独立于分叉）
  const ctx = $(`${side}_ctxFrom`);
  if (ctx) {
    const keep = ctx.value || ((LAST_CFG[side]?.override?.context?.initialMessagesFromSession) || "");
    ctx.innerHTML = "";
    const none = document.createElement("option");
    none.value = ""; none.textContent = "— 不预载（留空）—";
    ctx.appendChild(none);
    for (const r of SESSIONS.slice(0, 200)) {
      const o = document.createElement("option");
      o.value = r.id;
      o.textContent = `${fmtWhen(r.startedAt)} · ${(r.title || "(无标题)").slice(0, 28)} · ${r.msgCount ?? "?"}条`;
      ctx.appendChild(o);
    }
    if (keep && SESSIONS.some((x) => x.id === keep)) ctx.value = keep;
  }
}

// ---------------------------------------------------------------- 渲染聊天 聊天渲染

const body = $("chatBody");

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function clearChat() {
  hopCount = 0;
  $("bHops").textContent = "0 跳";
  body.innerHTML = '<div id="chatEmpty">还没有对话。左边配好之后点「开始乒乓」。</div>';
}
function chatEmptyGone() { const e = $("chatEmpty"); if (e) e.remove(); }
function scrollDown() { body.scrollTop = body.scrollHeight; }

function sysline(text, cls) {
  chatEmptyGone();
  const d = document.createElement("div");
  d.className = "sysline" + (cls ? " " + cls : "");
  d.innerHTML = `<span>${esc(text)}</span>`;
  body.appendChild(d);
  scrollDown();
}

function relayLine() { /* 已按要求移除「第 N 跳」分隔线 */ }

function hhmm(iso) {
  try { return new Date(iso).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }); }
  catch { return ""; }
}

function addMessage(d) {
  chatEmptyGone();

  // meta 只保留 时间 · 模型
  const stamp = [];
  const t = hhmm(d.ts);
  if (t) stamp.push(t);
  if (d.model) stamp.push(d.model);

  const row = document.createElement("div");
  row.className = `msg ${d.side}`;

  let bubCls = "bub";
  if (d.kind === "guard") bubCls += " guard";
  else if (d.kind === "fork") bubCls += " sys";

  row.innerHTML = `
    <div class="av">${esc((d.label || d.side).slice(0, 1))}</div>
    <div class="col">
      <div class="who"><span>${esc(d.label)}</span>
        ${d.kind === "guard" ? `<span class="badge warn">空内容</span>` : ""}
      </div>
      <div class="${bubCls}">${esc(d.text || "（空）")}</div>
      <div class="stamp">${esc(stamp.filter(Boolean).join("  ·  "))}</div>
    </div>`;
  body.appendChild(row);

  if (d.side === "A") $("a_session").textContent = d.sessionId || $("a_session").textContent;
  if (d.side === "B") $("b_session").textContent = d.sessionId || $("b_session").textContent;

  if (d.kind === "hop") {
    hopCount++;
    $("bHops").textContent = `${hopCount} 跳`;
  }
  scrollDown();
}

function addHop(d) {
  // 不再渲染「第 N 跳 → X」分隔线，靠左右交替体现接力顺序
  addMessage(d);
}

function setState(active, stopping) {
  $("btnRun").disabled = active;
  $("btnStop").disabled = !active;
  const b = $("bState");
  if (active) { b.textContent = stopping ? "停止中…" : "运行中"; b.className = "badge warn"; }
  else { b.textContent = "空闲"; b.className = "badge"; }
}
function notice(text, cls) { $("notice").innerHTML = text ? `<span class="${cls || ""}">${esc(text)}</span>` : ""; }

// ---------------------------------------------------------------- SSE

function connect() {
  const es = new EventSource("/api/events");

  es.addEventListener("hello", (e) => setState(!!JSON.parse(e.data).active, false));

  es.addEventListener("run:start", (e) => {
    const d = JSON.parse(e.data);
    clearChat();
    setState(true, false);
    notice("");
    $("a_session").textContent = "创建中…";
    $("b_session").textContent = "创建中…";
    if (d.sides) {
      for (const [k, v] of Object.entries(d.sides)) {
        if (v.fork) sysline(`${k} 从历史会话分叉（沿用 ${v.providerId} / ${v.modelId}）`);
      }
    }
  });

  es.addEventListener("session:start", (e) => {
    const d = JSON.parse(e.data);
    sysline(d.fork ? `正在从历史会话分叉出 ${d.label}…` : `正在新建 ${d.label}…`);
  });

  // hop:start 只用于更新「先执行方」标记，不再往聊天区插入提示
  es.addEventListener("hop:start", (e) => {
    const d = JSON.parse(e.data);
    if (d.first) $("bFirst").textContent = `${d.label} 先`;
  });

  es.addEventListener("worktree", (e) => {
    const d = JSON.parse(e.data);
    sysline(`已创建 worktree：${d.name}（${d.base}）`);
  });
  es.addEventListener("hop", (e) => addHop(JSON.parse(e.data)));

  es.addEventListener("run:stop", (e) => {
    const d = JSON.parse(e.data);
    sysline(`已停止：${d.reason}（共 ${d.hops} 跳）`, "ok");
  });
  es.addEventListener("run:done", (e) => {
    sysline(`完成，共 ${JSON.parse(e.data).hops} 跳。`, "ok");
    setState(false, false);
  });
  es.addEventListener("run:error", (e) => {
    const m = JSON.parse(e.data).message;
    sysline("出错：" + m, "err");
    notice(m, "msg-err");
    setState(false, false);
  });

  es.onerror = () => { $("bState").textContent = "连接断开"; $("bState").className = "badge err"; };
}

// ---------------------------------------------------------------- 绑定

function startApp() {
  initSplit();
  applyLayout();

  $("paneSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    else togglePane(b.dataset.pane);
  });
  $("themeSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    applyTheme(b.dataset.theme);
    markDirty();
  });
  $("firstSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    firstSide = b.dataset.first;
    markDirty();
    syncAll();
  });

  for (const s of SIDES) {
    $(`${s}_modeSeg`).addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      modes[s] = b.dataset.mode;
      markDirty();
      syncAll();
    });
  }

  const WATCH = ["providerId", "modelId", "thinking", "cwd", "teamName",
    "adaptiveThinking", "promptCache", "planActSeparate", "ocaMode",
    "planProviderId", "planModelId", "actProviderId", "actModelId",
    "aaEnabled", "aaMaxRequests", "aaNotifications", "aaWebSearch", "toolPreset",
    "ckEnabled", "wtEnabled", "compaction", "compactionEnabled",
    "enableReadFiles", "enableSearch", "enableBash", "enableWebFetch",
    "enableApplyPatch", "enableEditor", "enableSkills", "enableAskQuestion",
    "enableSubmitAndExit", "enableSpawnAgent", "enableAgentTeams",
    "a_name", "a_systemPrompt", "a_seedPrompt", "a_sessionId",
    "a_mode", "a_providerId", "a_modelId", "a_thinking",
    "a_fStatus", "a_fSource", "a_fSort",
    "b_name", "b_systemPrompt", "b_seedPrompt", "b_sessionId",
    "b_mode", "b_providerId", "b_modelId", "b_thinking",
    "b_fStatus", "b_fSource", "b_fSort",
    "maxHops", "timeoutSec", "stopKeywords", "stopOnConvergence",
    "backendMode"];
  for (const id of WATCH) {
    const el = $(id);
    if (!el) continue;
    el.addEventListener("input", () => { markDirty(); syncAll(); });
    el.addEventListener("change", () => { markDirty(); syncAll(); });
  }

  $("providerId").addEventListener("change", async () => { await loadOptions(); markDirty(); });
  for (const s of SIDES) {
    for (const f of ["fStatus", "fSource", "fSort"]) {
      const el = $(`${s}_${f}`);
      if (el) el.addEventListener("change", () => { fillSessionSelect(s); markDirty(); });
    }
    const full = $(`${s}_full`);
    if (full) full.addEventListener("change", () => { markDirty(); syncAll(); loadCapabilityScan(s); });
    const pa = $(`${s}_planActSeparate`);
    if (pa) pa.addEventListener("change", () => { markDirty(); syncAll(); });
    for (const f of ["modelId", "cwd", "images", "files", "aaMaxRequests"]) {
      const el = $(`${s}_${f}`);
      if (el) el.addEventListener("change", () => { markDirty(); });
    }
    for (const f of ["mode", "thinking"]) {
      const el = $(`${s}_${f}`);
      if (el) el.addEventListener("change", () => { markDirty(); syncAll(); });
    }
    // provider / model 变了就重新查一次该角色的模型能力
    for (const f of ["providerId", "modelId"]) {
      const el = $(`${s}_${f}`);
      if (!el) continue;
      const target = MODEL_TARGETS.find((t) => t.pid === `${s}_providerId`);
      el.addEventListener("change", () => {
        markDirty();
        if (target) refreshModelInfo(target);
      });
    }
  }

  $("modelId").addEventListener("change", () => updateModelInfo());
  $("providerId").addEventListener("change", () => updateModelInfo());

  // 项目文件夹：优先用浏览器原生目录选择器，不支持时回退到手动输入
  function addFolder(p) {
    if (!p) return;
    if (!FOLDERS.some((f) => f.path.toLowerCase() === p.toLowerCase())) {
      FOLDERS.push({ path: p, label: p.split(/[\\/]/).filter(Boolean).pop() || p, added: true, count: 0 });
      FOLDERS.sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
    }
    $("folderPath").value = "";
    renderFolders();
  }

  $("btnBrowse").addEventListener("click", async () => {
    if (typeof window.showDirectoryPicker === "function") {
      try {
        const dir = await window.showDirectoryPicker({ mode: "read" });
        const p = dir.path || dir.name || "";
        if (p) { addFolder(p); $("cwd").value = p; markDirty(); }
        return;
      } catch (e) {
        if (e && e.name === "AbortError") return;
        notice("这个环境不允许直接选文件夹（" + (e && e.message ? e.message : e) + "），请手动粘贴路径。", "msg-err");
        $("folderPath").focus();
        return;
      }
    }
    notice("当前环境不支持原生目录选择器，请把路径粘贴到下面的输入框。", "msg-err");
    $("folderPath").focus();
  });

  $("btnAddFolder").addEventListener("click", () => {
    const p = $("folderPath").value.trim();
    if (!p) { notice("请先填写或选择一个文件夹路径。", "msg-err"); return; }
    addFolder(p);
    $("cwd").value = p;
    markDirty();
  });

  $("folderPick").addEventListener("change", () => {
    const v = $("folderPick").value;
    if (v) { $("cwd").value = v; markDirty(); }
  });
  $("cwd").addEventListener("blur", async () => {
    const v = $("cwd").value.trim();
    const el = $("cwdHint");
    if (!v) { el.textContent = "留空 = 只在本 UI 目录下活动，不碰你的项目代码。"; el.className = "hint"; return; }
    const o = await (await fetch("/api/options")).json();
    const ok = o.cwdExists(v);
    el.textContent = ok ? "目录存在。" : "目录不存在！";
    el.className = ok ? "hint" : "hint warn";
  });

  $("btnSave").addEventListener("click", async () => {
    const r = await fetch("/api/config", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(readForm()),
    });
    if (r.ok) { markClean(); notice("配置已保存。", "msg-ok"); } else notice("保存失败", "msg-err");
  });

  $("btnReload").addEventListener("click", async () => {
    fillForm(await (await fetch("/api/config")).json());
    await loadOptions();
    await loadSessions();
    notice("已从 config.json 重载。", "msg-ok");
  });

  $("btnRun").addEventListener("click", async () => {
    notice("");
    const cfg = readForm();
    const problems = [];
    for (const s of SIDES) {
      const name = cfg[s].name || s.toUpperCase();
      if (!cfg[s].systemPrompt.trim()) problems.push(`「${name}」的系统提示词为空`);
      if (modes[s] === "blank") {
        if (!cfg[s].seedPrompt.trim()) problems.push(`「${name}」的开场 prompt 为空 —— 这是 SDK 报 prompt cannot be empty 的原因`);
      } else if (!cfg[s].source.sessionId) {
        problems.push(`「${name}」选了从历史会话分叉，但还没选具体会话`);
      }
    }
    if (problems.length) { notice("无法开始：" + problems.join("；"), "msg-err"); return; }

    const r = await fetch("/api/run", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ config: cfg }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { notice(d.error || "启动失败", "msg-err"); return; }
    markClean();
  });

  $("btnStop").addEventListener("click", async () => {
    $("btnStop").disabled = true;
    setState(true, true);
    const r = await fetch("/api/stop", { method: "POST" });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      notice(d.error || "停止失败", "msg-err");
      setState(false, false);
    }
  });

  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.key === "b" || e.key === "B") { e.preventDefault(); togglePane("left"); }
    if (e.key === "j" || e.key === "J") { e.preventDefault(); togglePane("right"); }
  });

  window.addEventListener("beforeunload", (e) => {
    if (dirty) { e.preventDefault(); e.returnValue = ""; }
  });

  window.addEventListener("resize", () => {
    if (layout.w > window.innerWidth - MIN_W) {
      layout.w = Math.max(MIN_W, window.innerWidth - MIN_W);
      applyLayout();
    }
  });

  (async function init() {
    let t = null;
    try { t = localStorage.getItem("relay-theme"); } catch { /* ignore */ }
    if (t) applyTheme(t);
    let cfg = null;
    try {
      cfg = await (await fetch("/api/config")).json();
      cfg0Model = cfg.model.providerId;
    } catch {
      fatal('<b>连不上后端服务。</b>请确认启动窗口还在运行（标题是 "Cline Relay UI"），然后刷新本页。');
      return;
    }
    // 先建面板（依赖 /api/options），再回填配置，否则写不进去
    await loadOptions();
    fillForm(cfg);
    await loadWorkspaces();
    await loadSessions();
    connect();
  })().catch((e) => {
    // 异步 IIFE 的异常不会冒泡到 window.onerror，必须显式捕获并显示
    const msg = (e && e.message) || String(e);
    console.error("[init] 启动失败:", e);
    notice("界面初始化失败：" + msg, "msg-err");
    $("bSdk").textContent = "初始化失败";
    $("bSdk").className = "badge err";
    $("bSdk").title = msg;
  });
}

// ---------------------------------------------------------------- 启动分发
// 必须在所有 const/let 声明之后执行，否则会踩暂时性死区。

if (location.protocol === "file:") {
  fatal(
    '<b>不能用浏览器直接打开这个 HTML 文件。</b><br>' +
      "页面需要 HTTP 后端才能读配置、列历史会话、实时接收对话。<br>" +
      "<ol><li>双击项目目录里的 <code>start.cmd</code></li>" +
      "<li>它会自动启动服务并打开 <code>http://127.0.0.1:5177/</code></li>" +
      "<li>不要再双击 <code>index.html</code></li></ol>"
  );
} else {
  startApp();
}
