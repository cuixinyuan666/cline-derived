"use strict";
/**
 * 浏览器端验证：用真实 Chromium 打开页面，检查
 *   - 有没有 JS 报错（之前 TDZ 那个 bug 就是这里抓到的）
 *   - 每个按钮点了有没有反应
 *   - 每个角色 A/B 的模型、凭据、Auto-approve、工具、扩展能力、上下文、附件、隔离、高级
 *     是否真的各自独立，并且真的传进了后端的 toolPolicies
 * 全程在同一个进程内起服务、测完关掉，不留残余进程。
 */
const path = require("node:path");
const fs = require("node:fs");
const { chromium } = require("C:/Users/Administrator/AppData/Roaming/npm/node_modules/playwright");

const PORT = Number(process.env.PORT || 5211);
const BASE = `http://127.0.0.1:${PORT}/`;
const SHOT_DIR = path.join(__dirname, "screenshots");
const mod = require(path.join(__dirname, "server.js"));

let pass = 0, fail = 0;
const check = (n, c, x = "") => { c ? (pass++, console.log(`  [PASS] ${n}`)) : (fail++, console.log(`  [FAIL] ${n} ${x}`)); };

(async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  try { fs.unlinkSync(path.join(__dirname, "config.json")); } catch { /* ignore */ }

  await new Promise((res, rej) => {
    mod.server.once("error", rej);
    mod.server.listen(PORT, "127.0.0.1", res);
  });
  console.log(`server on ${BASE}\n`);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const errors = [];
  const warns = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
    if (m.type() === "warning") warns.push(m.text());
  });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("requestfailed", (r) => errors.push("requestfailed: " + r.url() + " " + (r.failure()?.errorText || "")));

  console.log("=== 1. 打开页面 ===");
  // 注意：不能用 waitUntil:"networkidle" —— SSE(/api/events) 是长连接，
  // 网络永远不会 idle，会一直等到超时。改为等具体元素就绪。
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector("#chatBody", { timeout: 15000 });
  await page.waitForTimeout(2500); // 等 /api/config、/api/options、/api/sessions 落地

  check("无 JS 报错", errors.length === 0, errors.join(" | ").slice(0, 300));
  check("无失败请求", warns.filter((w) => /Failed to load|404|500/.test(w)).length === 0, warns.join(" | ").slice(0, 300));
  check("SDK 徽章显示就绪", (await page.textContent("#bSdk")) === "SDK 就绪", await page.textContent("#bSdk"));
  check("致命提示条未显示", !(await page.isVisible("#fatal")));

  console.log("\n=== 2. 配置已从后端载入 ===");
  const provCount = await page.locator("#providerId option").count();
  check("Provider 下拉有选项", provCount > 1, `${provCount} 项`);
  check("Model 自动填了值", (await page.inputValue("#modelId")).length > 0, await page.inputValue("#modelId"));
  check("主题默认 dim", (await page.getAttribute("html", "data-theme")) === "dim", await page.getAttribute("html", "data-theme"));
  check("已保存徽章为绿色", (await page.getAttribute("#bSaved", "class")) === "badge ok", await page.getAttribute("#bSaved", "class"));
  const sessCount = await page.locator("#a_sessionId option").count();
  check("历史会话下拉已填充", sessCount > 1, `${sessCount} 项`);

  console.log("\n=== 3. 主题按钮 ===");
  await page.click('#themeSeg button[data-theme="light"]');
  check("切到 light", (await page.getAttribute("html", "data-theme")) === "light");
  const bgLight = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.click('#themeSeg button[data-theme="dark"]');
  check("切到 dark", (await page.getAttribute("html", "data-theme")) === "dark");
  const bgDark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.click('#themeSeg button[data-theme="dim"]');
  check("切回 dim", (await page.getAttribute("html", "data-theme")) === "dim");
  check("亮色主题实际改变背景色", bgLight !== bgDark, `${bgLight} vs ${bgDark}`);

  console.log("\n=== 4. 先执行方按钮 ===");
  await page.click('#firstSeg button[data-first="B"]');
  check("切到 B 先：按钮高亮", (await page.getAttribute('#firstSeg button[data-first="B"]', "aria-pressed")) === "true");
  check("切到 B 先：顶栏标记更新", (await page.textContent("#bFirst")).includes("B"), await page.textContent("#bFirst"));
  await page.click('#firstSeg button[data-first="A"]');
  check("切回 A 先", (await page.getAttribute('#firstSeg button[data-first="A"]', "aria-pressed")) === "true");

  console.log("\n=== 5. 来源切换按钮 ===");
  await page.click('#a_modeSeg button[data-mode="fork"]');
  await page.waitForTimeout(200);
  check("A 切到分叉：显示会话下拉", await page.isVisible("#a_forkBox"));
  check("A 切到分叉：隐藏开场 prompt", !(await page.isVisible("#a_seedBox")));
  check("A 切到分叉：提示沿用 provider/model", (await page.textContent("#forkNote")).includes("provider"), await page.textContent("#forkNote"));
  await page.click('#a_modeSeg button[data-mode="blank"]');
  await page.waitForTimeout(200);
  check("A 切回空白：显示开场 prompt", await page.isVisible("#a_seedBox"));
  check("A 切回空白：隐藏会话下拉", !(await page.isVisible("#a_forkBox")));

  console.log("\n=== 6. 分栏拖拽 ===");
  const w0 = await page.evaluate(() => document.getElementById("left").getBoundingClientRect().width);
  const sp = await page.locator("#split").boundingBox();
  await page.mouse.move(sp.x + sp.width / 2, sp.y + sp.height / 2);
  await page.mouse.down();
  await page.mouse.move(sp.x + sp.width / 2 + 140, sp.y + sp.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  const w1 = await page.evaluate(() => document.getElementById("left").getBoundingClientRect().width);
  check("拖拽改变了左栏宽度", Math.abs(w1 - w0) > 40, `${Math.round(w0)} -> ${Math.round(w1)}`);

  console.log("\n=== 7. 分栏按钮 / 快捷键 ===");
  const leftBtnText = (await page.textContent('#paneSeg button[data-pane="left"]')) || "";
  const rightBtnText = (await page.textContent("#paneSeg button[data-pane=\"right\"]")) || "";
  check("左栏按钮文案为 |<-", leftBtnText.includes("|<-"), leftBtnText);
  check("右栏按钮文案为 ->|", rightBtnText.includes("->|"), rightBtnText);
  await page.click('#paneSeg button[data-pane="left"]');
  await page.waitForTimeout(200);
  const gHideL = await page.evaluate(() => document.getElementById("left").getBoundingClientRect().width);
  check("点 |<- -> 隐藏左栏", gHideL <= 1, `${gHideL}`);
  const gFullR = await page.evaluate(() => document.getElementById("right").getBoundingClientRect().width);
  check("点 |<- -> 右栏可见且铺满", gFullR > 800, `${Math.round(gFullR)}`);
  await page.click('#paneSeg button[data-pane="left"]');
  await page.waitForTimeout(200);
  const gBackL = await page.evaluate(() => document.getElementById("left").getBoundingClientRect().width);
  check("再点 |<- -> 两栏都回来", gBackL > 200, `${Math.round(gBackL)}`);
  await page.click('#paneSeg button[data-pane="right"]');
  await page.waitForTimeout(200);
  const gHideR = await page.evaluate(() => document.getElementById("right").getBoundingClientRect().width);
  check("点 ->| -> 隐藏右栏", gHideR <= 1, `${gHideR}`);
  const gFullL = await page.evaluate(() => document.getElementById("left").getBoundingClientRect().width);
  check("点 ->| -> 左栏可见且铺满", gFullL > 800, `${Math.round(gFullL)}`);
  await page.click('#paneSeg button[data-pane="right"]');
  await page.waitForTimeout(200);
  const gBackR = await page.evaluate(() => document.getElementById("right").getBoundingClientRect().width);
  check("再点 ->| -> 两栏都回来", gBackR > 200, `${Math.round(gBackR)}`);
  await page.keyboard.press("Control+b");
  await page.waitForTimeout(200);
  const gKeyL = await page.evaluate(() => document.getElementById("left").getBoundingClientRect().width);
  check("Ctrl+B 切换左栏", gKeyL <= 1 || gKeyL > 200, `${Math.round(gKeyL)}`);
  await page.keyboard.press("Control+b");
  await page.waitForTimeout(200);
  const gNotBothHidden1 = await page.evaluate(() =>
    document.getElementById("left").getBoundingClientRect().width > 1 ||
    document.getElementById("right").getBoundingClientRect().width > 1);
  check("Ctrl+B 后不是两栏全空", gNotBothHidden1);
  await page.keyboard.press("Control+j");
  await page.waitForTimeout(200);
  const gNotBothHidden2 = await page.evaluate(() =>
    document.getElementById("left").getBoundingClientRect().width > 1 ||
    document.getElementById("right").getBoundingClientRect().width > 1);
  check("Ctrl+J 后不是两栏全空（防呆生效）", gNotBothHidden2);
  await page.keyboard.press("Control+j");
  await page.waitForTimeout(200);
  const gBothBack = await page.evaluate(() =>
    document.getElementById("left").getBoundingClientRect().width > 1 &&
    document.getElementById("right").getBoundingClientRect().width > 1);
  check("Ctrl+J 后两栏都在", gBothBack);
  for (let i = 0; i < 6; i++) { await page.keyboard.press("Control+b"); await page.waitForTimeout(80); }
  const gStillOk = await page.evaluate(() =>
    document.getElementById("left").getBoundingClientRect().width > 1 ||
    document.getElementById("right").getBoundingClientRect().width > 1);
  check("反复按快捷键不会两栏全空", gStillOk);

  console.log("\n=== 7b. 开始/停止 在左栏右上角且吸顶 ===");
  const btnBox = await page.locator("#btnRun").boundingBox();
  const leftBox = await page.locator("#left").boundingBox();
  check("开始乒乓在左栏内",
    btnBox.x >= leftBox.x - 2 && btnBox.x < leftBox.x + leftBox.width, JSON.stringify(btnBox));
  const yBefore = btnBox.y;
  await page.evaluate(() => { document.getElementById("left").scrollTop = 400; });
  await page.waitForTimeout(250);
  const btnBox2 = await page.locator("#btnRun").boundingBox();
  check("左栏滚动后按钮仍可见", btnBox2.y >= 0 && btnBox2.y < 300, JSON.stringify(btnBox2));
  check("左栏滚动后按钮位置基本不变（吸顶）", Math.abs(btnBox2.y - yBefore) < 60, `${Math.round(yBefore)} -> ${Math.round(btnBox2.y)}`);
  const stopBox = await page.locator("#btnStop").boundingBox();
  check("停止按钮也在吸顶条里", stopBox.y >= 0 && stopBox.y < 300, JSON.stringify(stopBox));
  await page.evaluate(() => { document.getElementById("left").scrollTop = 0; });

  console.log("\n=== 8. 表单可编辑 + 保存 ===");
  await page.fill("#a_systemPrompt", "你是甲号。简短回应。");
  await page.fill("#b_systemPrompt", "你是乙号。简短回应。");
  await page.click("#btnSave");
  await page.waitForTimeout(700);
  const saved = await (await fetch(BASE + "api/config")).json();
  check("保存后系统提示词已落盘", saved.a.systemPrompt.includes("甲号"), saved.a.systemPrompt);
  check("保存后 firstSide 落盘", saved.loop.firstSide === "A", saved.loop.firstSide);

  console.log("\n=== 9. 空开场 prompt 的前端拦截 ===");
  await page.fill("#a_seedPrompt", "");
  await page.click("#btnRun");
  await page.waitForTimeout(500);
  const noticeTxt = (await page.textContent("#notice")) || "";
  check("空开场 prompt 被前端拦下", noticeTxt.includes("prompt cannot be empty"), noticeTxt);
  check("没有误启动运行", (await page.textContent("#bState")) === "空闲", await page.textContent("#bState"));

  console.log("\n=== 10. 端到端：真跑一次乒乓，验证气泡渲染 ===");
  await page.fill("#a_systemPrompt", "你是甲。对方说什么，你就用一句不超过10个字的话回应。不要解释。");
  await page.fill("#b_systemPrompt", "你是乙。对方说什么，你就用一句不超过10个字的话回应。不要解释。");
  await page.fill("#a_seedPrompt", "说一句：甲到此。");
  await page.fill("#b_seedPrompt", "说一句：乙到此。");
  await page.fill("#maxHops", "2");
  await page.uncheck("#stopOnConvergence");

  await page.click("#btnRun");
  console.log("  已点击「开始乒乓」，等待模型返回（最多 240 秒）...");
  try {
    await page.waitForFunction(
      () => document.querySelectorAll("#chatBody .msg").length >= 4,
      null,
      { timeout: 240000 }
    );
  } catch (e) {
    const dump = await page.evaluate(() => ({
      bubbles: document.querySelectorAll("#chatBody .msg").length,
      bState: document.getElementById("bState") && document.getElementById("bState").textContent,
      notice: document.getElementById("notice") && document.getElementById("notice").textContent,
      chat: ((document.getElementById("chatBody") || {}).innerText || "").slice(0, 700),
    }));
    console.log("  [页面现场]", JSON.stringify(dump, null, 1));
    const st = await (await fetch(BASE + "api/state")).json().catch(() => ({}));
    console.log("  [后端 state]", JSON.stringify(st).slice(0, 1200));
    console.log("  [页面报错]", JSON.stringify(errors, null, 1).slice(0, 1200));
  }
  await page.waitForFunction(
    () => document.getElementById("bState").textContent === "空闲",
    null,
    { timeout: 240000 }
  ).catch(() => {});
  await page.waitForTimeout(600);

  const bubbles = await page.locator("#chatBody .msg").count();
  check("聊天区渲染出消息气泡", bubbles >= 4, `${bubbles} 个气泡`);

  const leftSide = await page.locator("#chatBody .msg.A").count();
  const rightSide = await page.locator("#chatBody .msg.B").count();
  check("A 的消息在左侧", leftSide >= 2, `A=${leftSide}`);
  check("B 的消息在右侧", rightSide >= 2, `B=${rightSide}`);

  const avA = await page.locator("#chatBody .msg.A .av").first().textContent();
  check("A 侧有头像块", (avA || "").trim().length > 0, avA);

  // 「第 N 跳」分隔线已按要求移除，这里反向断言它确实不存在
  const relays = await page.locator("#chatBody .relay").count();
  check("没有「第 N 跳」分隔线", relays === 0, relays + " 条");
  const stampText = await page.evaluate(() =>
    [...document.querySelectorAll("#chatBody .stamp")].map((e) => e.textContent).join(" | "));
  check("气泡 meta 最多两项（时间 · 模型）", stampText.split("·").length <= 2 * bubbles + 1, stampText.slice(0, 120));
  check("气泡 meta 不含会话 ID", !/session|17910\d{6}/i.test(stampText), stampText.slice(0, 120));
  check("气泡 meta 不含 token/耗时/继承/iters", !/token|耗时|继承|iter/i.test(stampText), stampText.slice(0, 120));
  check("没有「分叉自 xxx」标签",
    (await page.evaluate(() => document.getElementById("chatBody").innerText)).includes("分叉自") === false);
  const sysCount = await page.locator("#chatBody .sysline").count();
  check("有系统事件胶囊", sysCount >= 1, `${sysCount} 个`);
  check("顶栏跳数已更新", /[1-9]/.test(await page.textContent("#bHops")), await page.textContent("#bHops"));
  check("顶栏显示先执行方", (await page.textContent("#bFirst")).includes("A"), await page.textContent("#bFirst"));
  const realSession = await page.evaluate(() => (document.getElementById("a_session") || {}).textContent || "");
  check("显示了真实会话 ID", /\d{10,}_[a-z0-9]+/i.test(realSession), realSession.trim().slice(0, 60));
  const texts = await page.evaluate(() =>
    [...document.querySelectorAll("#chatBody .msg .bub")].map((e) => e.textContent.trim()).filter(Boolean));
  check("气泡都有实际文本", texts.length >= 4 && texts.every((t) => t.length > 0), `${texts.length} 条`);
  console.log("  --- 聊天内容 ---");
  for (const t of texts) console.log("   " + t.slice(0, 40));
  await page.screenshot({ path: path.join(SHOT_DIR, "chat.png") });
  check("对话截图已生成", fs.existsSync(path.join(SHOT_DIR, "chat.png")));

  console.log("\n=== 11. 截图 ===");
  await page.screenshot({ path: path.join(SHOT_DIR, "full.png"), fullPage: true });
  check("截图已生成", fs.existsSync(path.join(SHOT_DIR, "full.png")));

  console.log("\n=== 12. 每角色能力面板（模型/凭据/auto-approve/工具/扩展/上下文/附件/隔离/高级）===");

  // 12.1 每个角色都有完整的能力面板（原来只在全局有一套）
  for (const s of ["a", "b"]) {
    const S = s.toUpperCase();
    for (const [what, id] of [
      ["单独设置开关", `${s}_full`],
      ["Mode", `${s}_mode`],
      ["Provider", `${s}_providerId`],
      ["Model", `${s}_modelId`],
      ["Auto-approve 面板", `${s}_aaActions`],
      ["Auto-approve 开关", `${s}_aaEnabled`],
      ["Max Requests", `${s}_aaMaxRequests`],
      ["工具预设", `${s}_toolPreset`],
      ["工具开关区", `${s}_toolToggles`],
      ["扩展能力区", `${s}_caps`],
      ["Add Context 会话下拉", `${s}_ctxFrom`],
      ["Add Files", `${s}_files`],
      ["Add Images", `${s}_images`],
      ["Checkpoints", `${s}_ckEnabled`],
      ["Worktrees", `${s}_wtEnabled`],
      ["压缩策略", `${s}_cmpStrategy`],
      ["backendMode", `${s}_backendMode`],
    ]) {
      check(`${S} 有${what}`, await page.locator("#" + id).count() > 0, id);
    }
  }

  // 全局的 Auto-approve / 工具能力 / 执行隔离 / 高级 面板应该已经不在了
  for (const gone of ["aaActions", "toolToggles", "aaGlobals"]) {
    check(`全局面板 #${gone} 已移除`, (await page.locator("#" + gone).count()) === 0);
  }

  // 12.2 能力面板默认折叠，勾选后展开
  check("A 的能力面板默认隐藏", !(await page.isVisible("#a_fullBox")));
  await page.check("#a_full");
  await page.waitForTimeout(200);
  check("勾选后 A 的能力面板展开", await page.isVisible("#a_fullBox"));
  check("B 的能力面板仍隐藏（互不影响）", !(await page.isVisible("#b_fullBox")));
  check("B 的单独设置开关默认未勾选", !(await page.isChecked("#b_full")));

  // 12.3 Auto-approve：字段必须来自 /api/options 的 approvalActions（SDK 真值）
  for (const s of ["a", "b"]) {
    const aaIds = await page.evaluate((side) =>
      [...document.querySelectorAll(`#${side}_aaActions input[type=checkbox]`)].map((i) => i.id.replace(`${side}_aa_`, "")),
      s);
    const S = s.toUpperCase();
    check(`${S} Auto-approve 面板有 6 项（SDK approvalActions 真值）`, aaIds.length === 6, aaIds.join(","));
    check(`${S} Auto-approve 用的是 Cline 真实 action 名`,
      ["readFiles", "editFiles", "executeSafeCommands", "executeAllCommands", "useBrowser", "useMcp"]
        .every((x) => aaIds.includes(x)), aaIds.join(","));
  }
  await page.check("#a_aa_readFiles");
  await page.check("#a_aa_editFiles");
  await page.check("#a_aa_useMcp");
  check("A 的 Auto-approve 可勾选", await page.isChecked("#a_aa_readFiles"));
  check("B 的 Auto-approve 未被连带勾上", !(await page.isChecked("#b_aa_readFiles")));
  await page.fill("#a_aaMaxRequests", "7");
  check("A 的 Max Requests 可填", (await page.inputValue("#a_aaMaxRequests")) === "7");

  // 12.4 工具能力：11 个 ToolPresets 开关
  for (const s of ["a", "b"]) {
    const toolKeys = await page.evaluate((side) =>
      [...document.querySelectorAll(`#${side}_toolToggles input[type=checkbox]`)].map((i) => i.id),
      s);
    const S = s.toUpperCase();
    check(`${S} 工具面板 11 个开关`, toolKeys.length === 11, toolKeys.join(","));
    check(`${S} 含 enableSpawnAgent / enableAgentTeams`,
      toolKeys.includes(`${s}_enableSpawnAgent`) && toolKeys.includes(`${s}_enableAgentTeams`));
  }
  await page.selectOption("#a_toolPreset", "plan");
  await page.waitForTimeout(250);
  check("A 选 plan 预设后 editor 变为关闭（对齐 ToolPresets.plan）",
    !(await page.isChecked("#a_enableEditor")));
  check("B 的工具开关未被预设改动", await page.isChecked("#b_enableEditor"));
  await page.selectOption("#a_toolPreset", "act");
  await page.waitForTimeout(250);

  // 12.5 扩展能力：只保留 SDK 真能按角色控制的两个，其余只读展示真实路径
  const capIds = await page.evaluate(() =>
    [...document.querySelectorAll("#a_caps input[type=checkbox]")].map((i) => i.id.replace("a_cap_", "")));
  check("扩展能力只有 SDK 真支持的两个开关", capIds.length === 2, capIds.join(","));
  check("这两个是 useMcp / useSkills", capIds.includes("useMcp") && capIds.includes("useSkills"), capIds.join(","));
  check("不再提供假的 Hooks/Workflows/Rules 开关",
    !capIds.some((x) => ["useHooks", "useWorkflows", "useRules"].includes(x)), capIds.join(","));
  await page.uncheck("#a_cap_useMcp");
  check("A 可以单独关掉 Manage MCP servers", !(await page.isChecked("#a_cap_useMcp")));
  check("B 的 Manage MCP 仍开启", await page.isChecked("#b_cap_useMcp"));
  await page.check("#a_cap_useMcp");

  // 12.5b 只读展示的必须是真实路径（来自 SDK 的解析函数，不是编的）
  await page.waitForTimeout(2000);
  const scanText = (await page.textContent("#a_capScan")) || "";
  check("只读区列出了 Rules 真实路径", scanText.includes("Rules") && /AGENTS\.md|\.clinerules/.test(scanText),
    scanText.slice(0, 120));
  check("只读区列出了 Skills 真实路径", scanText.includes("Skills") && /skills/i.test(scanText));
  check("只读区列出了 Workflows 真实路径", scanText.includes("Workflows") && /workflows/i.test(scanText));
  check("只读区列出了 Hooks 真实路径", scanText.includes("Hooks") && /hooks/i.test(scanText));
  check("只读区说明了没有按会话开关", scanText.includes("没有按会话的开关"), scanText.slice(0, 120));
  const scan = await (await fetch(BASE + "api/capability-scan?side=a")).json();
  check("能力扫描接口返回该角色 cwd", typeof scan.cwd === "string" && scan.cwd.length > 0, scan.cwd);
  check("能力扫描接口返回 rules 数组", Array.isArray(scan.rules) && scan.rules.length > 0, String((scan.rules || []).length));
  check("能力扫描接口返回 skills/workflows/hooks 数组",
    Array.isArray(scan.skills) && Array.isArray(scan.workflows) && Array.isArray(scan.hooks),
    `skills=${(scan.skills || []).length} workflows=${(scan.workflows || []).length} hooks=${(scan.hooks || []).length}`);
  const scanB = await (await fetch(BASE + "api/capability-scan?side=b")).json();
  check("A/B 的能力扫描独立", scan.side === "A" && scanB.side === "B", `${scan.side} / ${scanB.side}`);
  const ctxOpts = await page.locator("#a_ctxFrom option").count();
  check("Add Context 下拉已用真实会话填充", ctxOpts > 1, `${ctxOpts} 项`);
  const firstCtx = await page.evaluate(() => {
    const o = document.querySelectorAll("#a_ctxFrom option")[1];
    return o ? o.value : "";
  });
  if (firstCtx) {
    await page.selectOption("#a_ctxFrom", firstCtx);
    await page.waitForTimeout(200);
    check("Add Context 可选择历史会话", (await page.inputValue("#a_ctxFrom")) === firstCtx);
    await page.selectOption("#a_ctxFrom", "");
  }
  await page.fill("#a_images", "data:image/png;base64,AAAA\nD:\\pics\\shot.png");
  await page.fill("#a_files", "D:\\proj\\notes.md");
  check("Add Files & Images 可填多行",
    (await page.inputValue("#a_images")).includes("shot.png") &&
    (await page.inputValue("#a_files")).includes("notes.md"));

  // 12.7 每角色独立模型与凭据
  await page.selectOption("#a_providerId", "openai");
  await page.fill("#a_modelId", "flm-auto");
  await page.selectOption("#a_mode", "plan");
  await page.waitForTimeout(300);
  check("A 的模型独立生效", (await page.inputValue("#a_modelId")) === "flm-auto");
  check("B 的模型未被改动", (await page.inputValue("#b_modelId")) !== "flm-auto");
  check("A 的 Mode 独立生效", (await page.inputValue("#a_mode")) === "plan");
  check("B 的 Mode 仍是 act", (await page.inputValue("#b_mode")) === "act");

  // 12.8 模型能力提示（真实 ModelInfo，来自 SDK 的 models.dev 目录）
  // 注意：provider 必须用本机 /api/options 里真实存在的 id，不能凭空写 anthropic
  const realProviders = await page.evaluate(() =>
    [...document.querySelectorAll("#providerId option")].map((o) => o.value));
  check("provider 下拉里有真实 provider", realProviders.includes("cline"), realProviders.join(","));
  const clineModels = await (await fetch(BASE + "api/models?providerId=cline")).json();
  const capModel = ((clineModels.models || []).find((m) => (m.capabilities || []).includes("tools")) || {}).id;
  check("cline 在模型目录里有带 tools 能力的模型", !!capModel, capModel);
  await page.selectOption("#a_providerId", "cline");
  await page.fill("#a_modelId", capModel);
  await page.dispatchEvent("#a_modelId", "change");
  await page.waitForTimeout(8000);
  const capText = (await page.textContent("#a_modelInfo")) || "";
  check("角色面板能查到模型能力", capText.includes("模型能力") && !capText.includes("查询中"), capText.slice(0, 90));
  check("能力来自真实 ModelInfo（tools/reasoning）",
    capText.includes("tools") || capText.includes("reasoning"), capText.slice(0, 90));
  check("不再出现「本机没有该模型的 ModelInfo」", !capText.includes("本机没有"), capText.slice(0, 90));
  const mi = await (await fetch(BASE + "api/model-info?providerId=cline&modelId=" + encodeURIComponent(capModel))).json();
  check("接口返回 found=true", mi.found === true, JSON.stringify(mi).slice(0, 120));
  check("接口返回真实 capabilities 数组", Array.isArray(mi.capabilities) && mi.capabilities.includes("tools"),
    JSON.stringify(mi.capabilities));
  const ml = await (await fetch(BASE + "api/models?providerId=cline")).json();
  check("模型下拉能拉到该 provider 的真实模型列表", Array.isArray(ml.models) && ml.models.length > 10,
    `${(ml.models || []).length} 个`);

  // 12.9 Plan/Act 双模型 + OCA（角色内）
  await page.check("#a_planActSeparate");
  await page.waitForTimeout(200);
  check("角色内 Plan/Act 面板显示", await page.isVisible("#a_planActBox"));
  await page.fill("#a_planModelId", "flm-auto");
  await page.fill("#a_actModelId", "stealth/space-bunny-alpha");
  check("角色内 Plan/Act 模型可分别填写",
    (await page.inputValue("#a_planModelId")) === "flm-auto" &&
    (await page.inputValue("#a_actModelId")) === "stealth/space-bunny-alpha");
  await page.selectOption("#a_ocaMode", "external");
  check("角色内 OCA Mode 可选 internal/external", (await page.inputValue("#a_ocaMode")) === "external");
  await page.uncheck("#a_planActSeparate");
  await page.waitForTimeout(150);

  // 12.10 执行隔离默认关闭 + 互不影响
  check("A 的 Checkpoints 默认关闭", !(await page.isChecked("#a_ckEnabled")));
  check("A 的 Worktrees 默认关闭", !(await page.isChecked("#a_wtEnabled")));
  await page.check("#a_ckEnabled");
  await page.waitForTimeout(150);
  check("B 的 Checkpoints 未被连带勾上", !(await page.isChecked("#b_ckEnabled")));
  await page.uncheck("#a_ckEnabled");
  await page.waitForTimeout(150);

  // 12.11 项目文件夹（来自历史会话 cwd 汇总）
  const folders = await page.evaluate(async () => (await (await fetch("/api/workspaces")).json()).folders);
  check("工作区文件夹接口有数据", folders.length > 0, String(folders.length));
  check("文件夹带真实 cwd 与会话计数",
    folders.every((f) => f.path && typeof f.count === "number"), JSON.stringify(folders[0] || {}));
  const opt1 = await page.locator("#folderPick option").count();
  check("文件夹下拉已渲染", opt1 > 1, `${opt1} 项`);
  check("有「浏览…」按钮（原生目录选择器入口）", (await page.locator("#btnBrowse").count()) > 0);
  check("有手动路径输入框", (await page.locator("#folderPath").count()) > 0);
  if (folders.length) {
    await page.selectOption("#folderPick", folders[0].path);
    await page.waitForTimeout(200);
    check("选择文件夹会写进工作目录", (await page.inputValue("#cwd")) === folders[0].path,
      await page.inputValue("#cwd"));
    await page.fill("#cwd", "");
  }

  // 12.12 会话筛选器（必须先切到分叉模式，筛选器才可见）
  await page.click('#a_modeSeg button[data-mode="fork"]');
  await page.click('#b_modeSeg button[data-mode="fork"]');
  await page.waitForTimeout(300);
  for (const s of ["a", "b"]) {
    const st = await page.locator(`#${s}_fStatus option`).count();
    const sr = await page.locator(`#${s}_fSource option`).count();
    check(`${s.toUpperCase()} Status 筛选器已填充`, st > 1, `${st} 项`);
    check(`${s.toUpperCase()} Source 筛选器已填充`, sr > 1, `${sr} 项`);
    const firstLabel = (await page.textContent(`#${s}_fStatus option`)) || "";
    check(`${s.toUpperCase()} 筛选器首项是 All`, firstLabel.includes("All"), firstLabel);
  }
  const beforeN = await page.evaluate(() => document.querySelectorAll("#a_sessionId option").length - 1);
  await page.selectOption("#a_fSource", "vscode");
  await page.waitForTimeout(300);
  const afterN = await page.evaluate(() => document.querySelectorAll("#a_sessionId option").length - 1);
  check("按 Source=vscode 筛选后数量变化", afterN > 0 && afterN < beforeN, `${beforeN} -> ${afterN}`);
  await page.selectOption("#a_fSource", "");
  await page.waitForTimeout(200);
  await page.selectOption("#a_fSort", "asc");
  await page.waitForTimeout(300);
  const ascFirst = await page.evaluate(() => document.querySelectorAll("#a_sessionId option")[1]?.textContent || "");
  await page.selectOption("#a_fSort", "desc");
  await page.waitForTimeout(300);
  const descFirst = await page.evaluate(() => document.querySelectorAll("#a_sessionId option")[1]?.textContent || "");
  const dateOf = (s) => (String(s).match(/\d{2}\/\d{2}\s+\d{2}:\d{2}/) || ["?"])[0];
  check("升序第一项是最早的会话", dateOf(ascFirst) !== "?" && dateOf(ascFirst) <= dateOf(descFirst),
    `asc=${dateOf(ascFirst)} desc=${dateOf(descFirst)}`);
  check("降序第一项不早于升序第一项", dateOf(descFirst) >= dateOf(ascFirst),
    `asc=${dateOf(ascFirst)} desc=${dateOf(descFirst)}`);

  // 12.13 分叉 + 角色覆盖：提示要说明实际使用的模型
  const firstOpt = await page.evaluate(() => {
    const o = document.querySelectorAll("#a_sessionId option")[1];
    return o ? o.value : "";
  });
  check("分叉下拉有可选会话", !!firstOpt);
  if (firstOpt) { await page.selectOption("#a_sessionId", firstOpt); await page.waitForTimeout(300); }
  await page.check("#a_full");
  await page.waitForTimeout(200);
  await page.fill("#a_modelId", "override-model-x");
  await page.waitForTimeout(300);
  const ovHint = await page.textContent("#a_forkHint");
  check("分叉提示会说明实际使用的覆盖模型",
    (ovHint || "").includes("override-model-x"), (ovHint || "").slice(0, 100));

  // 12.14 保存并回读：每角色字段真的落盘
  await page.click('#a_modeSeg button[data-mode="blank"]');
  await page.waitForTimeout(200);
  await page.check("#a_full");
  await page.fill("#a_images", "data:image/png;base64,AAAA\nD:\\pics\\shot.png");
  await page.fill("#a_files", "D:\\proj\\notes.md");
  await page.fill("#a_aaMaxRequests", "9");
  await page.selectOption("#a_ocaMode", "external");
  await page.click("#btnSave");
  await page.waitForTimeout(800);
  const saved2 = await (await fetch(BASE + "api/config")).json();
  const oa = saved2.a.override || {};
  check("保存：a.override.enabled", oa.enabled === true);
  check("保存：a.override.providerId", oa.providerId === "cline", oa.providerId);
  check("保存：a.override.modelId", oa.modelId === "override-model-x", oa.modelId);
  check("保存：a.override.mode", oa.mode === "plan", oa.mode);
  check("保存：a.override.autoApprove.actions.readFiles", oa.autoApprove && oa.autoApprove.actions.readFiles === true);
  check("保存：a.override.autoApprove.actions.useMcp", oa.autoApprove && oa.autoApprove.actions.useMcp === true);
  check("保存：a.override.autoApprove.maxRequests=9", oa.autoApprove && oa.autoApprove.maxRequests === 9);
  check("保存：readFilesExternally 跟随 readFiles",
    oa.autoApprove.actions.readFilesExternally === oa.autoApprove.actions.readFiles,
    JSON.stringify(oa.autoApprove.actions));
  check("保存：a.override.tools.preset", oa.tools && oa.tools.preset === "act", oa.tools && oa.tools.preset);
  check("保存：a.override.capabilities.useMcp", oa.capabilities && oa.capabilities.useMcp === true);
  check("保存：a.override.attachments.images 有 2 条",
    oa.attachments && oa.attachments.images.length === 2, JSON.stringify(oa.attachments));
  check("保存：a.override.attachments.files 有 1 条",
    oa.attachments && oa.attachments.files.length === 1, JSON.stringify(oa.attachments));
  check("保存：a.override.compaction.strategy", oa.compaction && typeof oa.compaction.strategy === "string");
  check("保存：a.override.ocaMode=external", oa.ocaMode === "external", oa.ocaMode);
  check("B 没被污染：b.override.enabled=false", (saved2.b.override || {}).enabled === false);
  check("B 没被污染：b.override.modelId 不是 override-model-x",
    (saved2.b.override || {}).modelId !== "override-model-x");

  // 12.15 后端真的按角色分别算 toolPolicies（不猜，看真实结果）
  const policies = await (await fetch(BASE + "api/debug/side-policies")).json();
  check("A 侧 toolPolicies：read_files 自动批准",
    policies.a && policies.a.toolPolicies.read_files && policies.a.toolPolicies.read_files.autoApprove === true,
    JSON.stringify(policies.a && policies.a.toolPolicies.read_files));
  check("B 侧 toolPolicies：read_files 不自动批准",
    policies.b && policies.b.toolPolicies.read_files && policies.b.toolPolicies.read_files.autoApprove === false,
    JSON.stringify(policies.b && policies.b.toolPolicies.read_files));
  check("A/B 侧 modelId 不同", policies.a && policies.b && policies.a.modelId !== policies.b.modelId,
    `${policies.a && policies.a.modelId} vs ${policies.b && policies.b.modelId}`);
  check("A 侧 mode=plan、B 侧 mode=act",
    policies.a && policies.b && policies.a.mode === "plan" && policies.b.mode === "act",
    `${policies.a && policies.a.mode} / ${policies.b && policies.b.mode}`);
  check("调试接口不泄露任何密钥",
    !/sk-|apiKey|refreshToken|"token"/i.test(JSON.stringify(policies)), "疑似泄露");

  console.log("\n=== 控制台错误汇总 ===");
  if (errors.length === 0) console.log("  （无）");
  else errors.forEach((e) => console.log("  " + e));
  if (warns.length) console.log(`  警告 ${warns.length} 条（不影响功能）`);

  await browser.close();
  mod.close();
  try { fs.unlinkSync(path.join(__dirname, "config.json")); } catch { /* ignore */ }

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("崩溃:", e);
  try { mod.close(); } catch { /* ignore */ }
  process.exit(1);
});
