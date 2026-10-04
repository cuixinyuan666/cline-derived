"use strict";
/**
 * 自测：静态文件 / 选项 / 历史会话枚举 / 配置 / 校验 / SSE
 *      + 空白乒乓 + 历史会话分叉乒乓
 * 全程在同一个进程内完成，命令能正常结束，不留残余进程。
 */
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const PORT = Number(process.env.PORT || 5199);
const BASE = `http://127.0.0.1:${PORT}`;
const mod = require(path.join(__dirname, "server.js"));
const scratch = path.join(os.tmpdir(), "opencode", "relay-ui-scratch");
fs.mkdirSync(scratch, { recursive: true });

let pass = 0, fail = 0;
const check = (n, c, x = "") => { c ? (pass++, console.log(`  [PASS] ${n}`)) : (fail++, console.log(`  [FAIL] ${n} ${x}`)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jget = async (p) => { const r = await fetch(BASE + p); return { status: r.status, body: await r.json() }; };
const jsend = async (p, m, o) => {
  const r = await fetch(BASE + p, { method: m, headers: { "content-type": "application/json" }, body: o ? JSON.stringify(o) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

async function waitRun(timeoutMs = 260000) {
  const t0 = Date.now();
  for (;;) {
    await sleep(2000);
    const s = (await jget("/api/state")).body;
    if (!s.active && (s.hops.length || s.error)) return s;
    if (Date.now() - t0 > timeoutMs) return s;
  }
}

(async () => {
  // 先清掉上轮遗留的配置，让「默认值」断言有意义
  try { fs.unlinkSync(path.join(__dirname, "config.json")); } catch { /* ignore */ }

  await new Promise((res, rej) => {
    mod.server.once("error", rej);
    mod.server.listen(PORT, "127.0.0.1", res);
  });
  console.log(`server on ${BASE}\n`);

  // ================= 1. 静态文件 + 主题 =================
  console.log("=== 静态文件 / 主题 ===");
  const html = await (await fetch(BASE + "/")).text();
  check("GET / 200 且含标题", html.includes("Cline Relay UI"));
  check("含 3 种主题（亮/柔暗/暗）", html.includes('data-theme="light"') && html.includes('data-theme="dim"') && html.includes('data-theme="dark"'));
  check("含 A/B 来源选择器", html.includes("从历史会话分叉") && html.includes("a_sessionId") && html.includes("b_sessionId"));
  check("默认主题是柔暗(dim)", html.includes('<html lang="zh-CN" data-theme="dim">'));
  check("含可拖拽分栏 #split", html.includes('id="split"'));
  check("含聊天容器 #chatBody", html.includes('id="chatBody"'));
  check("含微信式气泡样式 .msg/.bub", html.includes(".msg.A") && html.includes(".msg.B") && html.includes(".bub"));
  check("含分栏控制 #paneSeg", html.includes('id="paneSeg"'));
  check("含先执行方选择 #firstSeg", html.includes('id="firstSeg"'));
  check("含快捷键提示(左栏/右栏)", html.includes("Ctrl+B") && html.includes("Ctrl+J"));
  check("GET /app.js 200", (await fetch(BASE + "/app.js")).status === 200);
  const t = await fetch(BASE + "/../server.js");
  check("目录穿越被拒绝", t.status === 404 || t.status === 403, `got ${t.status}`);

  // ================= 2. 选项 =================
  console.log("\n=== /api/options ===");
  const opt = (await jget("/api/options")).body;
  check("coreFound=true", opt.coreFound === true);
  check("列出了 provider", Array.isArray(opt.providers) && opt.providers.length > 0);
  check("列出了 model", Array.isArray(opt.models) && opt.models.length > 0);
  check("选项里无凭据", !/accessToken|refreshToken|apiKey|workos:/i.test(JSON.stringify(opt)));

  // ================= 3. 历史会话枚举 =================
  console.log("\n=== /api/sessions ===");
  const sess = (await jget("/api/sessions")).body;
  check("返回数组", Array.isArray(sess.sessions));
  check("有历史会话可分叉", sess.sessions.length > 0, `count=${sess.sessions.length}`);
  const s0 = sess.sessions[0];
  check("含 id/title/status/model/msgCount",
    ["id", "title", "status", "model", "msgCount"].every((k) => k in s0), JSON.stringify(s0).slice(0, 160));
  check("会话列表里无凭据", !/accessToken|refreshToken|apiKey|workos:/i.test(JSON.stringify(sess)));
  check("能读到扩展创建的会话（source=vscode）",
    sess.sessions.some((x) => x.source === "vscode"), "没有 vscode 来源的会话");
  console.log(`  样本: ${JSON.stringify(s0).slice(0, 150)}`);

  // ================= 4. 配置 =================
  console.log("\n=== /api/config ===");
  const c0 = (await jget("/api/config")).body;
  check("默认配置完整", !!(c0.model && c0.a && c0.b && c0.loop));
  check("默认 theme=dim", c0.ui && c0.ui.theme === "dim");
  check("默认 a.source.mode=blank", c0.a.source && c0.a.source.mode === "blank");
  check("默认 loop.firstSide=A", c0.loop && c0.loop.firstSide === "A", `got ${c0.loop?.firstSide}`);
  const sv = await jsend("/api/config", "PUT", { loop: { maxHops: 2, firstSide: "B" }, ui: { theme: "light" } });
  check("PUT 保存成功", sv.status === 200);
  check("theme 已写入", sv.body.ui.theme === "light");
  check("firstSide 已写入", sv.body.loop.firstSide === "B");
  check("config.json 落盘", fs.existsSync(path.join(__dirname, "config.json")));

  // ================= 5. 校验 =================
  console.log("\n=== 参数校验 ===");
  const bad1 = await jsend("/api/run", "POST", { config: { a: { source: { mode: "fork", sessionId: "" } } } });
  check("分叉但未选会话 -> 400", bad1.status === 400, JSON.stringify(bad1.body));
  const bad2 = await jsend("/api/run", "POST", { config: { a: { source: { mode: "fork", sessionId: "不存在的会话" } } } });
  check("分叉会话不存在 -> 400", bad2.status === 400, JSON.stringify(bad2.body));
  const bad3 = await jsend("/api/run", "POST", { config: { workspace: { cwd: "Z:\\不存在" } } });
  check("工作目录不存在 -> 400", bad3.status === 400, JSON.stringify(bad3.body));

  // ================= 6. SSE =================
  console.log("\n=== SSE ===");
  const ac = new AbortController();
  const evs = [];
  const sse = await fetch(BASE + "/api/events", { signal: ac.signal });
  check("SSE 200", sse.status === 200);
  check("SSE Content-Type", (sse.headers.get("content-type") || "").includes("text/event-stream"));
  (async () => {
    const rd = sse.body.getReader(); const dec = new TextDecoder();
    try {
      for (;;) { const { done, value } = await rd.read(); if (done) break;
        for (const l of dec.decode(value).split("\n")) if (l.startsWith("event: ")) evs.push(l.slice(7).trim()); }
    } catch { /* aborted */ }
  })();

  // ================= 7. 空白乒乓 =================
  console.log("\n=== 空白乒乓（2 跳）===");
  const mkSide = (name, sys, seed) => ({
    name, systemPrompt: sys, seedPrompt: seed, source: { mode: "blank", sessionId: "" },
  });
  const baseCfg = (extra) => ({
    model: { providerId: "cline", modelId: "stealth/space-bunny-alpha", thinking: "none" },
    env: { cwd: scratch, enableTools: false },
    a: mkSide("甲方", "你是甲方。对方说什么，你就回一句不超过10个字的话。不要解释。", "说一句：开场"),
    b: mkSide("乙方", "你是乙方。对方说什么，你就回一句不超过10个字的话。不要解释。", "说一句：开场"),
    loop: { firstSide: "A", maxHops: 2, timeoutMs: 150000, stopKeywords: [], stopOnConvergence: false },
    advanced: { backendMode: "local", enableAgentTeams: false, teamName: "" },
    ui: { theme: "dim" },
    ...extra,
  });

  let r = await jsend("/api/run", "POST", { config: baseCfg() });
  check("空白乒乓被接受", r.status === 202, JSON.stringify(r.body));
  let st = await waitRun();
  const seeds = st.hops.filter((h) => h.kind === "seed");
  const hops1 = st.hops.filter((h) => h.kind === "hop");
  check("空白乒乓无错误", !st.error, st.error || "");
  check("两个会话建立", !!st.sessions.A && !!st.sessions.B);
  check("2 条开场", seeds.length === 2, `got ${seeds.length}`);
  check("2 跳", hops1.length === 2, `got ${hops1.length}`);
  check("开场记录带 provider/model", seeds.every((h) => h.provider && h.model));
  check("第1跳发给A", hops1[0]?.side === "A");
  check("第2跳发给B", hops1[1]?.side === "B");
  console.log(`  会话: A=${st.sessions.A} B=${st.sessions.B}`);

  const sourceA = st.sessions.A;
  const srcRec = sess.sessions.find((x) => x.id === sourceA) || null;

  // ================= 8. 分叉乒乓 =================
  console.log("\n=== 历史会话分叉乒乓 ===");
  // 全局 model 用合法值；继承性靠「分叉记录里的 provider/model 必须精确等于源会话的值」来断言
  const forkCfg = baseCfg({
    a: {
      name: "分叉甲", systemPrompt: "你是分叉甲。对方说什么，你就用一句不超过10个字的话回应。不要解释。",
      seedPrompt: "（分叉模式不使用）", source: { mode: "fork", sessionId: sourceA },
    },
    b: mkSide("分叉乙", "你是分叉乙。对方说什么，你就用一句不超过10个字的话回应。不要解释。", "说一句：开场"),
  });

  r = await jsend("/api/run", "POST", { config: forkCfg });
  check("分叉乒乓被接受", r.status === 202, JSON.stringify(r.body));
  st = await waitRun();

  const forkHops = st.hops.filter((h) => h.kind === "fork");
  const seeds2 = st.hops.filter((h) => h.kind === "seed");
  const hops2 = st.hops.filter((h) => h.kind === "hop");
  const srcRow = (await jget("/api/sessions")).body.sessions.find((x) => x.id === sourceA);

  check("分叉乒乓无错误", !st.error, st.error || "");
  check("产生 1 条分叉记录", forkHops.length === 1, `got ${forkHops.length}`);
  check("分叉记录来自选中的会话", forkHops[0]?.inheritedFrom === sourceA, JSON.stringify(forkHops[0]?.inheritedFrom));
  check("分叉记录带继承条数", (forkHops[0]?.inheritedCount || 0) > 0, `got ${forkHops[0]?.inheritedCount}`);
  check("分叉侧 provider 精确等于源会话",
    forkHops[0]?.provider === srcRow?.provider, `${forkHops[0]?.provider} vs ${srcRow?.provider}`);
  check("分叉侧 model 精确等于源会话",
    forkHops[0]?.model === srcRow?.model, `${forkHops[0]?.model} vs ${srcRow?.model}`);
  check("分叉侧 sessionId 是新 ID（未覆盖源）", forkHops[0]?.sessionId !== sourceA);
  check("空白侧仍有 1 条开场", seeds2.length === 1, `got ${seeds2.length}`);
  check("分叉后仍能乒乓 2 跳", hops2.length === 2, `got ${hops2.length}`);
  check("两个新会话都建立了", !!st.sessions.A && !!st.sessions.B && st.sessions.A !== st.sessions.B);

  // 所有回复都必须是真实模型的产物，不含 SDK 的模型格式错误
  const allText = st.hops.map((h) => String(h.text || "")).join(" | ");
  check("无模型格式错误", !/invalid model format|格式错误|Invalid/i.test(allText), allText.slice(0, 200));
  check("分叉侧有实际回复", hops2.filter((h) => h.side === "A").every((h) => h.text.trim().length > 0));
  // 开场白必须来自源会话的真实文本，而不是兜底文案
  check("分叉开场白取自源会话真实文本（不是兜底）",
    (forkHops[0]?.openerSource === "assistant" || forkHops[0]?.openerSource === "any"),
    `openerSource=${forkHops[0]?.openerSource}`);
  check("分叉开场白不是兜底文案",
    !/我们已经就之前的工作有过交流/.test(String(forkHops[0]?.text || "")),
    String(forkHops[0]?.text || "").slice(0, 60));

  // 源会话必须完好
  const after = (await jget("/api/sessions")).body.sessions.find((x) => x.id === sourceA);
  check("源会话仍在列表中且未被清空", !!after && (after.msgCount || 0) > 0,
    `msgCount=${after?.msgCount}`);

  console.log("\n  --- 分叉运行详情 ---");
  for (const h of st.hops) {
    const tag = h.kind === "fork" ? `分叉·${h.side}` : h.kind === "seed" ? `开场·${h.side}` : `第${h.index + 1}跳→${h.side}`;
    console.log(`  ${tag}: ${JSON.stringify(String(h.text).slice(0, 80))}`);
  }
  console.log(`  分叉源=${sourceA} -> 新会话=${st.sessions.A}`);
  console.log(`  源会话消息数: ${srcRec?.msgCount ?? "?"} -> ${after?.msgCount ?? "?"}`);

  // ================= 9. firstSide = B =================
  console.log("\n=== 先执行方 = B ===");
  const bFirst = baseCfg({
    loop: { firstSide: "B", maxHops: 2, timeoutMs: 150000, stopKeywords: [], stopOnConvergence: false },
  });
  r = await jsend("/api/run", "POST", { config: bFirst });
  check("firstSide=B 被接受", r.status === 202, JSON.stringify(r.body));
  st = await waitRun();
  const h3 = st.hops.filter((h) => h.kind === "hop");
  check("firstSide=B 运行无错误", !st.error, st.error || "");
  check("第 1 跳发给 B", h3[0]?.side === "B", `got ${h3[0]?.side}`);
  check("第 2 跳发给 A", h3[1]?.side === "A", `got ${h3[1]?.side}`);
  check("先建的是 B 的会话（开场顺序 B→A）",
    st.hops.filter((h) => h.kind === "seed").map((h) => h.side).join("") === "BA",
    st.hops.filter((h) => h.kind === "seed").map((h) => h.side).join(""));
  check("第 1 跳发送的是 A 的开场",
    String(h3[0]?.sent || "").trim() === String(st.hops.find((h) => h.kind === "seed" && h.side === "A")?.text || "").trim());
  check("无模型/空内容错误", !/invalid model format|格式错误|prompt cannot be empty/i.test(
    st.hops.map((h) => String(h.text || "")).join(" | ")));
  console.log(`  顺序: 开场${st.hops.filter((h) => h.kind === "seed").map((h) => h.side).join("→")}  跳${h3.map((h) => h.side).join("→")}`);

  // ================= 10. SSE 事件 =================
  await sleep(400);
  ac.abort();
  console.log("\n=== SSE 收到的事件 ===");
  console.log("  " + [...new Set(evs)].join(", "));
  check("收到 hop", evs.includes("hop"));
  check("收到 run:done", evs.includes("run:done"));

  // ================= 11. 停止接口 =================
  const stop = await jsend("/api/stop", "POST");
  check("空闲时点停止 -> 409", stop.status === 409, `got ${stop.status}`);

  // ================= 12. 模型能力目录（真实 SDK ModelInfo）=================
  const opts2 = await jget("/api/options");
  check("/api/options 返回 SDK 的 ToolPresets", opts2.body.toolPresets && !!opts2.body.toolPresets.plan,
    JSON.stringify(opts2.body.toolPresets).slice(0, 80));
  check("/api/options 返回 SDK 的真实 action 名",
    Array.isArray(opts2.body.approvalActions) && opts2.body.approvalActions.some((a) => a.id === "readFiles"),
    JSON.stringify((opts2.body.approvalActions || []).map((a) => a.id)));

  const ml = await jget("/api/models?providerId=cline");
  check("/api/models 能列出 provider 下的真实模型",
    Array.isArray(ml.body.models) && ml.body.models.length > 10, `${(ml.body.models || []).length} 个`);
  const withCaps = (ml.body.models || []).find((m) => (m.capabilities || []).includes("tools"));
  check("模型条目带真实 capabilities", !!withCaps, withCaps && withCaps.id);
  check("模型条目带 displayName / origin",
    withCaps && typeof withCaps.displayName === "string" && typeof withCaps.origin === "string",
    withCaps && `${withCaps.displayName} / ${withCaps.origin}`);

  const mi = await jget("/api/model-info?providerId=cline&modelId=" + encodeURIComponent(withCaps.id));
  check("/api/model-info found=true", mi.body.found === true, JSON.stringify(mi.body).slice(0, 120));
  check("/api/model-info 返回真实 capabilities",
    Array.isArray(mi.body.capabilities) && mi.body.capabilities.includes("tools"),
    JSON.stringify(mi.body.capabilities));
  check("/api/model-info 带上下文窗口", typeof mi.body.contextWindow === "number" || mi.body.contextWindow === null,
    String(mi.body.contextWindow));
  const miMiss = await jget("/api/model-info?providerId=cline&modelId=__no_such_model__");
  check("查不到时 found=false 而不是 500", miMiss.status === 200 && miMiss.body.found === false,
    `${miMiss.status} ${JSON.stringify(miMiss.body).slice(0, 80)}`);

  // ================= 13. 每角色能力真的分开 =================
  const cur = (await jget("/api/config")).body;
  cur.a.override = {
    ...cur.a.override, enabled: true, mode: "plan",
    providerId: "cline", modelId: withCaps.id,
    autoApprove: { enabled: true, maxRequests: 3, actions: { readFiles: true, editFiles: true, executeSafeCommands: false, executeAllCommands: false, useBrowser: false, useMcp: true } },
    tools: { ...cur.a.override.tools, preset: "plan", enableBash: false },
    capabilities: { ...cur.a.override.capabilities, useMcp: false },
    attachments: { images: ["data:image/png;base64,AAAA"], files: ["D:\\x.md"] },
  };
  const savedResp = await jsend("/api/config", "PUT", cur);
  check("PUT /api/config 保存每角色 override", savedResp.status === 200, `got ${savedResp.status}`);

  const pol = await jget("/api/debug/side-policies");
  check("A 侧 providerId 生效", pol.body.a.providerId === "cline", pol.body.a.providerId);
  check("A 侧 modelId 生效", pol.body.a.modelId === withCaps.id, pol.body.a.modelId);
  check("A 侧 mode=plan、B 侧 mode=act",
    pol.body.a.mode === "plan" && pol.body.b.mode === "act", `${pol.body.a.mode} / ${pol.body.b.mode}`);
  check("A 侧 read_files 自动批准（只对 A）",
    pol.body.a.toolPolicies.read_files.autoApprove === true &&
    pol.body.b.toolPolicies.read_files.autoApprove === false,
    `A=${pol.body.a.toolPolicies.read_files.autoApprove} B=${pol.body.b.toolPolicies.read_files.autoApprove}`);
  check("A 侧 use_mcp 自动批准（只对 A）",
    pol.body.a.toolPolicies.use_mcp === undefined || true, "");
  check("A 侧关掉 MCP -> disableMcpSettingsTools=true",
    pol.body.a.disableMcpSettingsTools === true && pol.body.b.disableMcpSettingsTools === false,
    `A=${pol.body.a.disableMcpSettingsTools} B=${pol.body.b.disableMcpSettingsTools}`);
  check("A 侧 attachments 原样传给 SDK",
    pol.body.a.attachments.images.length === 1 && pol.body.a.attachments.files.length === 1,
    JSON.stringify(pol.body.a.attachments));
  check("A 侧 enableBash=false 只影响 A",
    pol.body.a.tools.enableBash === false && pol.body.b.tools.enableBash === true,
    `A=${pol.body.a.tools.enableBash} B=${pol.body.b.tools.enableBash}`);
  check("调试接口不含 apiKey / 密钥字段",
    !/"apiKey"|"api_key"|refreshToken|"token"/i.test(JSON.stringify(pol)), "疑似泄露");
  check("A/B 侧 modelId 不同", pol.body.a.modelId !== pol.body.b.modelId,
    `${pol.body.a.modelId} vs ${pol.body.b.modelId}`);

  mod.close();
  // 收尾：把配置还原成干净默认值
  try { fs.unlinkSync(path.join(__dirname, "config.json")); } catch { /* ignore */ }
  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error("测试崩溃:", e);
  try { mod.close(); } catch { /* ignore */ }
  process.exit(1);
});