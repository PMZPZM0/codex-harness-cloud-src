// scripts/accept.mjs —— 当前版本验收（10-25 起只保留本轮功能，历史项已删除）
//
// 用户 10-25：「你这个验收脚本，老是跑很久之前的内容干嘛，能不能删了，重新写」。
// 因此本文件只保留当前要守的链路：
//   ① settings-pages：设置页逐页可打开 + 外观/外观头像 / 布布包 / 用户人格位置
//   ② function-menu：侧栏顶部「新会话 / 搜索任务」+ 两处折叠 + 拖动 + 更多 + 教程
//   ③ plugin-market-gitee：插件市场 Gitee raw / jsDelivr 兜底（403 限流回归）
//   ④ voice-ball-reactions：悬浮球眼睛跟鼠标 + 打字弹迷你键盘（10-26）
//   ⑤ sidebar-adaptive：「功能入口」是侧栏右侧浮层，不占纵向空间；Esc 收起
//   ⑥ file-preview-controls：右栏文件树/预览可拖动分栏 + 预览向上拉满（按钮/Alt+↑↓）
//   ⑦ devtools-categories：开发工具页工具分类 —— 外面只有分类卡 + 一键安装，明细只在二级弹窗（11-01）
//   ⑧ project-menu-flyout：项目 ⋯ / 会话 ⋯ 菜单向侧栏右侧弹出（portal）+ 视口钳制自适应往上（11-08）
//   ⑨ thread-tag-column：会话行标签固定成一列（贴置顶键左边、右对齐）+ 标签最多 3 个字（11-08）
//   ⑩ team-skill-picker：工作伙伴「引用技能」贴 + 图标弹、可多选有反馈、点一下不关（11-08）
//   ⑪ team-composer-input：群聊输入框插 @ 后打字光标不跳 / 输入法组合不重建 / 粘贴只进纯文本（11-08 审查）
//
// 用法：
//   node scripts/accept.mjs                 # 跑全部当前项
//   node scripts/accept.mjs --only <id>     # 只跑某一项
//   node scripts/accept.mjs --list
//   node scripts/accept.mjs --keep          # 跑完不关应用
//   node scripts/accept.mjs --profile main  # 换一个持久 profile
//
// 被测 profile：.e2e-profile/<name>/（跨轮复用，含真实历史；勿入库）

import { existsSync, mkdirSync, writeFileSync, truncateSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { ElectronHarness } from "./e2e/lib/harness.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function enterMain(h) {
  await h.waitFor(
    `(document.body && document.body.innerText.includes("直接进入")) || !!document.querySelector(".app-shell")`,
    { label: "引导页或主界面", timeoutMs: 40000 }
  );
  if (await h.eval(`document.body.innerText.includes("直接进入")`)) {
    await h.clickByText("暂时不登录，直接进入").catch(() => undefined);
  }
  await h.waitFor(`!!document.querySelector(".app-shell")`, { label: "app-shell 挂载", timeoutMs: 30000 });
  await wait(1500);
}

const CHECKS = [
  {
    id: "settings-current",
    name: "设置页（只测当前关键页：用户中心 / 人格市场 / 外观 —— 不再逐页点选项）",
    run: async (h) => {
      await h.eval(`(function(){ document.querySelector(".sidebar-settings")?.click(); return 1; })()`);
      await h.waitFor(`!!document.querySelector(".settings-modal")`, { label: "设置面板", timeoutMs: 8000 });
      await wait(900);
      const nav = async (label) => h.eval(`(function(){ const b=[...document.querySelectorAll(".settings-nav button")].find(function(x){ return (x.textContent||"").trim()===${JSON.stringify(label)}; }); if(!b) return 0; b.click(); return 1; })()`);
      const cur = async () => h.eval(`(function(){ const m=document.querySelector(".settings-modal"); return m ? (m.querySelector(".settings-nav button.active")?.textContent||"").trim() : ""; })()`);

      await nav("用户中心");
      await wait(1000);
      const uc = await h.eval(`(function(){
        const m=document.querySelector(".settings-modal"); if(!m) return null;
        const cols=(sel)=>{ const el=m.querySelector(sel); return el?getComputedStyle(el).gridTemplateColumns.split(" ").length:0; };
        return { avatars:[...m.querySelectorAll(".uc-presets button")].map((b)=>b.title),
          codex:[...m.querySelectorAll(".codex-id-preset")].map((b)=>b.title),
          userCols:cols(".uc-presets"), codexCols:cols(".codex-id-preset-grid"),
          userPersonaHere:!!m.querySelector(".user-persona-grid") };
      })()`).catch(() => null);
      h.check("① 用户中心：常规头像 5 列、Codex 形象 6 个铺满整行、用户人格已移出",
        Boolean(uc && uc.avatars.length >= 8 && uc.codex.length >= 6 && uc.userCols === 5 && uc.codexCols === 6
          && !uc.userPersonaHere),
        JSON.stringify(uc));

      await nav("人格市场");
      await wait(1500);
      const soul = await h.eval(`(function(){ const m=document.querySelector(".settings-modal"); if(!m) return null;
        return { page:(m.querySelector(".settings-nav button.active")?.textContent||"").trim(),
          market:!!m.querySelector(".soul-market"), persona:!!m.querySelector(".user-persona-grid") }; })()`).catch(() => null);
      h.check("② 人格市场：用户人格与 Codex 人格同页", Boolean(soul && soul.market && soul.persona), JSON.stringify(soul));

      await nav("外观");
      await wait(1000);
      const look = await h.eval(`(function(){ const m=document.querySelector(".settings-modal"); if(!m) return null;
        const card=[...m.querySelectorAll(".appearance-base-card .settings-pill-row")].find((x)=>(x.textContent||"").includes("思考板块"));
        const fn=m.querySelector(".appearance-function-card");
        return { page:(m.querySelector(".settings-nav button.active")?.textContent||"").trim(),
          has:!!card, above:!!(card&&fn&&card.getBoundingClientRect().top < fn.getBoundingClientRect().top) }; })()`).catch(() => null);
      h.check("③ 外观：思考板块在功能入口上方", Boolean(look && look.has && look.above), JSON.stringify(look));

      await nav("中转站");
      await wait(1200);
      const relay = await h.eval(`(function(){
        const m=document.querySelector(".settings-modal"); if(!m) return null;
        const page=m.querySelector(".relay-center"); if(!page) return null;
        const banner=page.querySelector(".relay-sub-banner");
        const add=page.querySelector(".relay-add-card");
        const addStyle=add?getComputedStyle(add):null;
        const strong=banner?banner.querySelector(".relay-sub-banner-main > strong"):null;
        const state=banner?(banner.dataset.state||""):"";
        return { page:(m.querySelector(".settings-nav button.active")?.textContent||"").trim(),
          hasInfo:!!page.querySelector(".page-info"),
          hasFoot:!!page.querySelector(".relay-center-foot"),
          state,
          guestParas: state==="guest" && banner ? banner.querySelectorAll(".relay-sub-banner-main > p").length : 0,
          strongBig: strong ? parseFloat(getComputedStyle(strong).fontSize) : 0,
          addSmall: add ? add.querySelectorAll("small").length : 0,
          addDir: addStyle ? addStyle.flexDirection : "",
          addHeight: add ? Math.round(add.getBoundingClientRect().height) : 0 };
      })()`).catch(() => null);
      h.check("④ 中转站：无问号/无页脚赘述，未登录只留大字，添加卡横向单行",
        Boolean(relay && relay.page === "中转站" && !relay.hasInfo && !relay.hasFoot && relay.guestParas === 0
          && (relay.state !== "guest" || relay.strongBig >= 15)
          && relay.addSmall === 0 && relay.addDir === "row" && relay.addHeight >= 60),
        JSON.stringify(relay));

      await nav("OpenAI 订阅");
      await wait(1000);
      const oa = await h.eval(`(function(){
        const m=document.querySelector(".settings-modal"); if(!m) return null;
        const page=m.querySelector(".relay-center"); if(!page) return null;
        const grid=page.querySelector(".openai-account-grid");
        const cards=[...page.querySelectorAll(".relay-add-card")];
        const rects=cards.map(function(c){ const r=c.getBoundingClientRect(); return { top:Math.round(r.top), w:Math.round(r.width), h:Math.round(r.height), small:c.querySelectorAll("small").length }; });
        return { page:(m.querySelector(".settings-nav button.active")?.textContent||"").trim(),
          hasInfo:!!page.querySelector(".page-info"),
          hasCopy:!!page.querySelector(".settings-copy"),
          gridW: grid ? Math.round(grid.getBoundingClientRect().width) : 0,
          twoPerRow: rects.length === 2 && rects[0].top === rects[1].top,
          rects };
      })()`).catch(() => null);
      h.check("⑤ OpenAI 订阅：无问号/无说明，添加卡两列矩形卡不拉满整行",
        Boolean(oa && oa.page === "OpenAI 订阅" && !oa.hasInfo && !oa.hasCopy && oa.twoPerRow
          && oa.rects.every(function(r){ return r.small === 0 && r.h <= 80 && r.w < oa.gridW - 20; })),
        JSON.stringify(oa));
            await nav("控制台");
      await wait(900);
      const ctrl = await h.eval(`(function(){
        const m=document.querySelector(".settings-modal"); if(!m) return null;
        const perm=m.querySelector(".card-permission .row-pills");
        const toneRow=[...m.querySelectorAll(".card-reply .settings-toggle-row")].find((x)=>(x.textContent||"").includes("语气自适应"));
        const toneSw=toneRow?toneRow.querySelector('[role="switch"]'):null;
        return { page:(m.querySelector(".settings-nav button.active")?.textContent||"").trim(),
          groups:m.querySelectorAll(".settings-exp-group-head").length,
          permPills:perm?perm.querySelectorAll("button").length:0,
          toneInReply:!!toneRow, toneOn:toneSw?toneSw.getAttribute("aria-checked"):null };
      })()`).catch(() => null);
      await nav("外观");
      await wait(800);
      const appGroups = await h.eval(`document.querySelectorAll(".settings-modal .settings-exp-group-head").length`).catch(() => -1);
      h.check("⑥ 控制台：分组小字已删、权限收成一张卡（三档胶囊）；外观页同样无分组小字",
        Boolean(ctrl && ctrl.page === "控制台" && ctrl.groups === 0 && ctrl.permPills >= 3
          && appGroups === 0),
        JSON.stringify({ ctrl, appGroups }));

      /* 10-27 用户令：「个性化里面的用户称呼可以删了，还有语气自适应也删了，
         跟用户中心和控制台的ahd重复了」⇒ 个性化页不再有这两块，语气开关改到控制台。 */
      await nav("个性化");
      await wait(1500);
      const per = await h.eval(`(function(){
        const m=document.querySelector(".settings-modal"); if(!m) return null;
        const page=m.querySelector(".personalization-page"); if(!page) return null;
        return { page:(m.querySelector(".settings-nav button.active")?.textContent||"").trim(),
          hasNickInput:!!page.querySelector('input[aria-label="称呼"]'),
          hasNickText:(page.textContent||"").includes("称呼"),
          hasTone:(page.textContent||"").includes("语气自适应"),
          hasStyle:!!page.querySelector(".personalization-style-tabs"),
          styleTabs:[...page.querySelectorAll(".personalization-style-tabs button")].map((b)=>String(b.textContent||"").trim()),
          hasInstructions:!!page.querySelector(".personalization-instructions"),
          hasFrontend:!!page.querySelector(".card-frontend-design"),
          frontendTabs:[...page.querySelectorAll(".card-frontend-design .frontend-style-chip")].map((b)=>String(b.textContent||"").trim()),
          hasFrontendNotes:!!page.querySelector(".personalization-frontend-notes"),
          hasFrontendSave:!!page.querySelector(".personalization-savebar .primary-setting"),
          hasNormCards:!!page.querySelector('[data-norm-card="software-dev"]') && !!page.querySelector('[data-norm-card="app-architecture"]'),
          normChips:[...page.querySelectorAll(".card-norm .frontend-style-chip")].length,
          normToggles:[...page.querySelectorAll(".personalization-page .norm-toggle")].length,
          hasFrontendPrompt:!!page.querySelector(".frontend-style-prompt"),
          hasFrontendLibrary:!!page.querySelector(".frontend-style-library button"),
          hasFrontendRefs:!!page.querySelector(".frontend-style-refs-more"),
          hasFrontendSpec:!!page.querySelector(".frontend-style-spec"),
          pageW:Math.round(page.getBoundingClientRect().width),
          groupW:Math.round((page.querySelector(".personalization-group")?.getBoundingClientRect().width)||0) };
      })()`).catch(() => null);
      h.check("⑧ 个性化：无称呼输入、无语气自适应；回复风格与自定义指令仍在",
        Boolean(per && per.page === "个性化" && !per.hasNickInput && !per.hasNickText && !per.hasTone
          && per.hasStyle && per.styleTabs.includes("敢于反驳") && per.hasInstructions && per.groupW >= per.pageW - 12),
        JSON.stringify(per));
      h.check("⑧b 个性化：内置风格库 9 套（含苹果 / 科技）+ 设计规范 + 参考文档/素材 + 提示词预览 + 组件库入口 + 保存",
        Boolean(per && per.hasFrontend && per.frontendTabs.length === 9
          && per.frontendTabs.some((x) => x.includes("苹果")) && per.frontendTabs.some((x) => x.includes("科技"))
          && per.hasFrontendNotes && per.hasFrontendSave && per.hasFrontendPrompt && per.hasFrontendLibrary
          && per.hasFrontendRefs && per.hasFrontendSpec),
        JSON.stringify(per));
      h.check("⑧c 个性化：软件开发（后端）/ 应用架构（后端/全栈）两张规范卡 + 三个启用开关 + 统一保存",
        Boolean(per && per.hasNormCards && per.normChips >= 12 && per.normToggles >= 3 && per.hasFrontendSave),
        JSON.stringify(per));
      h.check("⑨ 控制台回复风格卡：语气自适应开关在位（挪来这儿，不是删功能）",
        Boolean(ctrl && ctrl.toneInReply && ctrl.toneOn !== null),
        JSON.stringify({ toneInReply: ctrl && ctrl.toneInReply, toneOn: ctrl && ctrl.toneOn }));

      await nav("模型");
      await wait(900);
      const modelBar = await h.eval(`(function(){
        const m=document.querySelector(".settings-modal"); if(!m) return null;
        const page=m.querySelector(".model-settings-page"); if(!page) return null;
        const toolbar=page.querySelector(".provider-page-toolbar");
        const compact=toolbar?toolbar.querySelector(".model-compact-control"):null;
        const actions=toolbar?toolbar.querySelector(".provider-page-actions"):null;
        if(!toolbar||!compact||!actions) return null;
        const cr=compact.getBoundingClientRect(), ar=actions.getBoundingClientRect();
        return { head:!!page.querySelector(".provider-list-head"),
          dock:!!page.querySelector(".model-page-dock"),
          compactText:(compact.textContent||"").trim(),
          sameRow:Math.abs((cr.top+cr.bottom)/2-(ar.top+ar.bottom)/2) <= 10,
          left:cr.left < ar.left,
          labels:[...actions.querySelectorAll("button")].map((b)=>(b.textContent||"").trim()),
          classes:[...actions.querySelectorAll("button")].map((b)=>b.className) };
      })()`).catch(() => null);
      h.check("⑦ 模型页：小字与底部条已删；压缩靠左、三个按钮靠右同一行",
        Boolean(modelBar && !modelBar.head && !modelBar.dock && modelBar.compactText.includes("自动压缩")
          && modelBar.sameRow && modelBar.left
          && modelBar.labels.some((x)=>x.includes("自动配置"))
          && modelBar.labels.some((x)=>x.includes("自定义供应商"))
          && modelBar.labels.some((x)=>x.includes("保存重启"))
          && modelBar.classes.length === 3 && modelBar.classes[0].includes("primary-setting")
          && modelBar.classes[1].includes("secondary-setting") && !modelBar.classes[1].includes("primary-setting")
          && modelBar.classes[2].includes("danger-setting")),
        JSON.stringify(modelBar));

      await nav("MCP");
      await wait(1000);
      await h.eval(`(function(){ document.querySelector(".settings-modal .mcp-category-select")?.click(); return 1; })()`);
      await wait(300);
      const mcpFilter = await h.eval(`(function(){
        const m=document.querySelector(".settings-modal"); if(!m) return null;
        const sel=m.querySelector(".mcp-category-select");
        const list=document.querySelector(".app-select-list");
        const labels=[...m.querySelectorAll("button")].map((b)=>(b.textContent||"").trim());
        const lab=m.querySelector(".mcp-category-filter > span");
        return { page:(m.querySelector(".settings-nav button.active")?.textContent||"").trim(),
          hasSelect:!!sel, options:list?list.querySelectorAll(".app-select-option").length:0,
          tabs:m.querySelectorAll(".mcp-market-toolbar .skill-tabs").length,
          hasInfo:!!m.querySelector(".page-info"),
          labelWrap:lab?getComputedStyle(lab).whiteSpace:"",
          jumps:labels.filter((x)=>x.includes("广场")) };
      })()`).catch(() => null);
      h.check("⑧ MCP：分类改成筛选下拉，市场跳转按钮已删",
        Boolean(mcpFilter && mcpFilter.page === "MCP" && mcpFilter.hasSelect && mcpFilter.options >= 5
          && mcpFilter.tabs === 0 && mcpFilter.labelWrap === "nowrap" && mcpFilter.jumps.length === 0),
        JSON.stringify(mcpFilter));
      /* 10-27 用户（MCP 页截图）：「右上角问号删了」⇒ 页头整块撤掉，页面上不再有这枚 ?。 */
      h.check("⑩ MCP：右上角问号已删",
        Boolean(mcpFilter && !mcpFilter.hasInfo),
        JSON.stringify({ hasInfo: mcpFilter && mcpFilter.hasInfo }));

      /* 10-27 用户（语音页截图）：「把必须放到基础模型里面…首个卡片内容布局调一下…上面一块空白删除，
         右上角帮助❓号…放到基础模型卡片右上角」⇒ 页头整块删掉（不留空行）、
         必需标签与帮助 ? 都进基础模型卡的卡头、副标题与路径下沉正文区。 */
      await nav("语音通话");
      await wait(1200);
      const voice = await h.eval(`(function(){
        const m=document.querySelector(".settings-modal"); if(!m) return null;
        const page=m.querySelector(".voice-settings"); if(!page) return null;
        const card=page.querySelector(".voice-devtools-card");
        const head=card?card.querySelector(".voice-devtools-card-head"):null;
        const body=card?card.querySelector(".voice-devtools-body"):null;
        const pi=head?head.querySelector(".page-info"):null;
        const tag=head?head.querySelector(".voice-group-tag.is-required"):null;
        const pr=page.getBoundingClientRect(), cr=card?card.getBoundingClientRect():null;
        return { page:(m.querySelector(".settings-nav button.active")?.textContent||"").trim(),
          hasHeaderCopy:!!page.querySelector(".settings-copy"),
          tagInHead:!!tag, helpInHead:!!pi,
          subInBody:!!(body&&body.querySelector(":scope > .voice-devtools-sub")),
          pathInBody:!!(body&&body.querySelector(":scope > .voice-devtools-path")),
          gapToTop: cr ? Math.round(cr.top - pr.top) : 999,
          headRows: head?getComputedStyle(head).flexDirection:"" };
      })()`).catch(() => null);
      h.check("⑪ 语音页：页头空行已删，必需标签与帮助 ? 在基础模型卡卡头，路径下沉正文",
        Boolean(voice && voice.page === "语音通话" && !voice.hasHeaderCopy && voice.tagInHead
          && voice.helpInHead && voice.subInBody && voice.pathInBody
          && voice.gapToTop >= 0 && voice.gapToTop < 40 && voice.headRows === "row"),
        JSON.stringify(voice));
      /* 10-27 用户（子智能体页截图）：「不要内置子智能体…这个卡片删除；返智能体团队按键，
         跟新建子智能体放一排，靠左」⇒ 横幅卡没了、返回键并进页头操作行且靠左、
         壳层不再单独占一行。⛔ 内置评审"删了又回来"的根治在启动链（不再种入），
         这里只量界面；回归验证见提交说明。 */
      await nav("专家/专家团");
      await wait(1000);
      await h.eval(`(function(){ const b=[...document.querySelectorAll(".settings-modal .hub-card")].find((x)=>(x.textContent||"").includes("子智能体")); if (b) b.click(); return 1; })()`);
      await wait(1200);
      const agentsPg = await h.eval(`(function(){
        const m=document.querySelector(".settings-modal"); if(!m) return null;
        const page=m.querySelector(".subagent-center"); if(!page) return null;
        const back=page.querySelector(".subagent-back");
        const neu=[...page.querySelectorAll(".subagent-head-actions button")].find((b)=>(b.textContent||"").includes("新建子智能体"));
        const r=(el)=>el?el.getBoundingClientRect():null;
        const br=r(back), nr=r(neu);
        return { hasBanner:!!page.querySelector(".subagent-banner"),
          shellBackRow:!!m.querySelector(".settings-back-row:not(.subagent-back)"),
          hasBack:!!back,
          sameRow: br&&nr ? Math.abs((br.top+br.bottom)/2-(nr.top+nr.bottom)/2) <= 8 : false,
          backLeft: br&&nr ? br.left < nr.left - 40 : false };
      })()`).catch(() => null);
      h.check("⑬ 子智能体页：横幅卡已删；返回键与「新建」同一排且靠左（壳层不再单独占一行）",
        Boolean(agentsPg && !agentsPg.hasBanner && agentsPg.hasBack && !agentsPg.shellBackRow
          && agentsPg.sameRow && agentsPg.backLeft),
        JSON.stringify(agentsPg));

      await nav("技能");
      await wait(1000);
      const skillsBar = await h.eval(`(function(){
        const m=document.querySelector(".settings-modal"); if(!m) return null;
        const page=m.querySelector(".skill-center"); if(!page) return null;
        const row=page.querySelector(".skill-filter-row");
        const line=page.querySelector(".skill-actions-line");
        const search=page.querySelector(".skill-filter-row .search-field");
        const cat=page.querySelector(".skill-category-select");
        if(!row||!line||!search) return null;
        const btns=[...line.querySelectorAll("button")];
        const r=line.getBoundingClientRect(), rr=row.getBoundingClientRect(), s=search.getBoundingClientRect();
        const cr=cat?cat.getBoundingClientRect():null;
        return { page:(m.querySelector(".settings-nav button.active")?.textContent||"").trim(),
          buttons:btns.map((b)=>(b.textContent||"").trim()),
          heights:btns.map((b)=>Math.round(b.getBoundingClientRect().height)),
          categoryText:cat?(cat.textContent||"").trim():"",
          categoryRow:cr?Math.abs((cr.top+cr.bottom)/2-(s.top+s.bottom)/2) <= 10:false,
          sameRow:Math.abs((r.top+r.bottom)/2-(s.top+s.bottom)/2) <= 10,
          inRow:line.closest(".skill-filter-row") === row,
          rightGap:Math.round(rr.right-r.right),
          pageInfo:!!page.querySelector(".page-info"),
          tabs:page.querySelectorAll(".skill-tabs").length,
          count:!!page.querySelector(".skill-filter-count"),
          oldRow:!!page.querySelector(".skill-market-toolbar") };
      })()`).catch(() => null);
      h.check("⑩ 技能页：按键与搜索同一排，分类小字与右上角问号已删",
        Boolean(skillsBar && skillsBar.page === "技能" && !skillsBar.oldRow && !skillsBar.pageInfo
          && skillsBar.categoryText.includes("全部分类") && skillsBar.categoryRow
          && skillsBar.tabs === 0 && !skillsBar.count && skillsBar.buttons.length === 3
          && skillsBar.buttons.some((x)=>x.includes("我的技能"))
          && skillsBar.buttons.some((x)=>x.includes("导入技能"))
          && skillsBar.heights.every((h)=>h <= 30) && skillsBar.sameRow && skillsBar.inRow
          && skillsBar.rightGap <= 40
          && !skillsBar.buttons.some((x)=>x.includes("SkillHub 市场"))),
        JSON.stringify(skillsBar));
      await nav("命令");
      await wait(900);
      const commandBar = await h.eval(`(function(){
        const m=document.querySelector(".settings-modal"); if(!m) return null;
        const page=m.querySelector(".command-center"); if(!page) return null;
        const bar=page.querySelector(".command-toolbar");
        const line=page.querySelector(".command-actions-line");
        const search=page.querySelector(".command-search");
        const sel=page.querySelector(".command-filter-select");
        if(!bar||!line||!search||!sel) return null;
        const btns=[...line.querySelectorAll("button")];
        const r=line.getBoundingClientRect(), br=bar.getBoundingClientRect(), s=search.getBoundingClientRect(), sr=sel.getBoundingClientRect();
        return { page:(m.querySelector(".settings-nav button.active")?.textContent||"").trim(),
          buttons:btns.map((b)=>(b.textContent||"").trim()),
          heights:btns.map((b)=>Math.round(b.getBoundingClientRect().height)),
          selectText:(sel.textContent||"").trim(),
          sameRow:Math.abs((r.top+r.bottom)/2-(s.top+s.bottom)/2) <= 10,
          selectRow:Math.abs((sr.top+sr.bottom)/2-(s.top+s.bottom)/2) <= 10,
          inRow:line.closest(".command-toolbar") === bar,
          rightGap:Math.round(br.right-r.right),
          stats:!!page.querySelector(".command-stats"),
          tabs:page.querySelectorAll(".command-tabs").length,
          groupSmall:page.querySelectorAll(".command-group > header small").length,
          emptyNote:(page.textContent||"").includes("还没有自定义命令"),
          pageInfo:!!page.querySelector(".page-info"),
          headingActions:!!page.querySelector(".settings-heading-actions") };
      })()`).catch(() => null);
      h.check("⑪ 命令页：分类收成下拉，新建/刷新与搜索同一排",
        Boolean(commandBar && commandBar.page === "命令" && !commandBar.pageInfo && !commandBar.headingActions
          && commandBar.selectText.includes("全部") && commandBar.selectRow && !commandBar.stats
          && commandBar.tabs === 0 && commandBar.groupSmall === 0 && !commandBar.emptyNote
          && commandBar.buttons.length === 2 && commandBar.buttons.some((x)=>x.includes("新建命令"))
          && commandBar.heights.every((h)=>h <= 30) && commandBar.sameRow && commandBar.inRow
          && commandBar.rightGap <= 30),
        JSON.stringify(commandBar));
      await nav("插件");
      await wait(1200);
      const pluginMarket = await h.eval(`(function(){
        const m=document.querySelector(".settings-modal"); if(!m) return null;
        const page=m.querySelector(".plugin-center"); if(!page) return null;
        const block=page.querySelector(".plugin-market-block");
        const sel=block?block.querySelector(".market-category-select"):null;
        const search=block?block.querySelector(".search-field"):null;
        if(!block||!sel||!search) return null;
        const sr=sel.getBoundingClientRect(), ir=search.getBoundingClientRect();
        return { page:(m.querySelector(".settings-nav button.active")?.textContent||"").trim(),
          selectText:(sel.textContent||"").trim(),
          sameRow:Math.abs((sr.top+sr.bottom)/2-(ir.top+ir.bottom)/2) <= 10,
          tabs:block.querySelectorAll(".skill-tabs").length,
          jumps:[...page.querySelectorAll("button")].map((b)=>(b.textContent||"").trim()).filter((x)=>x.includes("在线市场")) };
      })()`).catch(() => null);
      h.check("⑫ 插件市场：分类下拉与搜索同一行，在线市场跳转已删",
        Boolean(pluginMarket && pluginMarket.page === "插件" && pluginMarket.selectText.includes("全部分类")
          && pluginMarket.sameRow && pluginMarket.tabs === 0 && pluginMarket.jumps.length === 0),
        JSON.stringify(pluginMarket));
      await nav("组件库");
      await wait(600);
      await h.waitFor(`!!document.querySelector(".comp-lib-cat-select")`, { label: "组件库筛选下拉", timeoutMs: 5000 }).catch(() => undefined);
      await wait(300);
      const compLib = await h.eval(`(function(){
        const m=document.querySelector(".settings-modal"); if(!m) return null;
        const page=m.querySelector(".comp-lib"); if(!page) return null;
        const search=page.querySelector(".ui-skin-search");
        const sel=page.querySelector(".comp-lib-cat-select");
        const grid=page.querySelector(".comp-lib-grid");
        if(!search||!sel) return null;
        const sr=sel.getBoundingClientRect(), ir=search.getBoundingClientRect();
        return { page:(m.querySelector(".settings-nav button.active")?.textContent||"").trim(),
          selectText:(sel.textContent||"").trim(),
          sameRow:Math.abs((sr.top+sr.bottom)/2-(ir.top+ir.bottom)/2) <= 10,
          searchWidth:Math.round(ir.width),
          gridHeight:grid?Math.round(grid.getBoundingClientRect().height):0,
          cats:page.querySelectorAll(".ui-skin-cat").length };
      })()`).catch(() => null);
      h.check("⑬ 组件库：分类收成搜索行右侧下拉，搜索框不再拉满",
        Boolean(compLib && compLib.page === "组件库" && compLib.selectText.length > 0
          && compLib.sameRow && compLib.searchWidth <= 400 && compLib.gridHeight >= 500 && compLib.cats === 0),
        JSON.stringify(compLib));
      await nav("SSH 服务器");
      await wait(900);
      const sshBar = await h.eval(`(function(){
        const m=document.querySelector(".settings-modal"); if(!m) return null;
        const page=m.querySelector(".ssh-page"); if(!page) return null;
        const search=page.querySelector(".search-field");
        const sel=page.querySelector(".ssh-status-select");
        const line=page.querySelector(".ssh-actions-line");
        if(!search||!sel||!line) return null;
        const btns=[...line.querySelectorAll("button")];
        const sr=sel.getBoundingClientRect(), ir=search.getBoundingClientRect(), br=line.getBoundingClientRect();
        return { page:(m.querySelector(".settings-nav button.active")?.textContent||"").trim(),
          selectText:(sel.textContent||"").trim(),
          buttons:btns.map((b)=>(b.textContent||"").trim()),
          heights:btns.map((b)=>Math.round(b.getBoundingClientRect().height)),
          sameRow:Math.abs((sr.top+sr.bottom)/2-(ir.top+ir.bottom)/2) <= 10 && Math.abs((br.top+br.bottom)/2-(ir.top+ir.bottom)/2) <= 10,
          pageInfo:!!page.querySelector(".page-info"),
          headingActions:!!page.querySelector(".settings-heading-actions") };
      })()`).catch(() => null);
      h.check("⑭ SSH 页：搜索 + 状态下拉 + 导入/导出/新建连接同一行，问号已删",
        Boolean(sshBar && sshBar.page === "SSH 服务器" && !sshBar.pageInfo && !sshBar.headingActions
          && sshBar.selectText.includes("全部") && sshBar.sameRow
          && ["导入", "导出", "新建连接"].every((label)=>sshBar.buttons.some((x)=>x.includes(label)))
          && sshBar.heights.every((h)=>h <= 30)),
        JSON.stringify(sshBar));
      await nav("专家/专家团");
      await wait(800);
      await h.eval(`(function(){ const b=[...document.querySelectorAll(".settings-modal .hub-card")].find((x)=>(x.querySelector("strong")?.textContent||"").trim()==="专家中心"); b?.click(); return b?1:0; })()`);
      await h.waitFor(`!!document.querySelector(".expert-center-head")`, { label: "专家中心页头", timeoutMs: 5000 }).catch(() => undefined);
      await wait(400);
      const expertHead = await h.eval(`(function(){
        const m=document.querySelector(".settings-modal"); if(!m) return null;
        const page=m.querySelector(".expert-center-page"); if(!page) return null;
        const head=page.querySelector(".expert-center-head");
        const back=head?head.querySelector(".settings-back-row"):null;
        const market=head?head.querySelector(".settings-heading-actions button"):null;
        if(!head||!back||!market) return null;
        const br=back.getBoundingClientRect(), mr=market.getBoundingClientRect();
        return { page:(m.querySelector(".settings-nav button.active")?.textContent||"").trim(),
          sameRow:Math.abs((br.top+br.bottom)/2-(mr.top+mr.bottom)/2) <= 10,
          backLeft:br.left < mr.left,
          backs:page.querySelectorAll(".settings-back-row").length,
          pageInfo:!!page.querySelector(".page-info") };
      })()`).catch(() => null);
      h.check("⑮ 专家中心：返回与专家市场同一排（返回靠左），问号已删",
        Boolean(expertHead && expertHead.sameRow && expertHead.backLeft && expertHead.backs === 1 && !expertHead.pageInfo),
        JSON.stringify(expertHead));
      await nav("专家/专家团");
      await wait(800);
      await h.eval(`(function(){ const b=[...document.querySelectorAll(".settings-modal .hub-card")].find((x)=>(x.querySelector("strong")?.textContent||"").trim()==="专家团"); b?.click(); return b?1:0; })()`);
      await h.waitFor(`!!document.querySelector(".expert-team-center")`, { label: "专家团页", timeoutMs: 5000 }).catch(() => undefined);
      await wait(400);
      const teamsHead = await h.eval(`(function(){
        const m=document.querySelector(".settings-modal"); if(!m) return null;
        const page=m.querySelector(".expert-team-center"); if(!page) return null;
        const back=page.querySelector(".teams-back");
        const actions=page.querySelector(".settings-heading-actions");
        if(!back||!actions) return null;
        const br=back.getBoundingClientRect(), ar=actions.getBoundingClientRect();
        return { page:(m.querySelector(".settings-nav button.active")?.textContent||"").trim(),
          sameRow:Math.abs((br.top+br.bottom)/2-(ar.top+ar.bottom)/2) <= 10,
          backLeft:br.left < ar.left,
          banner:!!page.querySelector(".subagent-banner"),
          backs:page.querySelectorAll(".settings-back-row").length };
      })()`).catch(() => null);
      h.check("⑯ 专家团：返回键并进操作行靠左，Codex 说明卡已删",
        Boolean(teamsHead && teamsHead.sameRow && teamsHead.backLeft && !teamsHead.banner && teamsHead.backs === 1),
        JSON.stringify(teamsHead));
      await h.pressKey("Escape");
      await wait(300);
      await h.pressKey("Escape");
      await wait(300);
await h.pressKey("Escape");
      await wait(300);
      /* ⑰ 10-27 用户（新建子智能体截图）：「这个新建子智能体更新一下，都是旧的，工具也是」
         ⇒ 推理强度只剩四档、开关是共享胶囊、工具说明给 agent_invoke + subagent_save。 */
      if (!(await h.eval(`!!document.querySelector(".settings-modal")`))) {
        await h.eval(`document.querySelector(".sidebar-settings")?.click()`);
        await h.waitFor(`!!document.querySelector(".settings-modal")`, { label: "设置面板", timeoutMs: 8000 });
        await wait(600);
      }
      await nav("专家/专家团");
      await wait(800);
      await h.eval(`(function(){ const b=[...document.querySelectorAll(".settings-modal .hub-card")].find((x)=>(x.querySelector("strong")?.textContent||"").trim()==="子智能体"); b?.click(); return b?1:0; })()`);
      await h.waitFor(`!!document.querySelector(".subagent-center .subagent-head-actions")`, { label: "子智能体页", timeoutMs: 12000 }).catch(() => undefined);
      await wait(300);
      await h.eval(`(function(){ const b=[...document.querySelectorAll(".subagent-head-actions button")].find((x)=>(x.textContent||"").includes("新建子智能体")); b?.click(); return b?1:0; })()`);
      await h.waitFor(`!!document.querySelector(".subagent-editor-modal")`, { label: "新建子智能体弹窗", timeoutMs: 8000 }).catch(() => undefined);
      await wait(400);
      const subModalBase = await h.eval(`(function(){
        const m=document.querySelector(".subagent-editor-modal"); if(!m) return null;
        const text=(m.textContent||"");
        return { toggles:m.querySelectorAll(".toggle-switch").length,
          checkboxes:m.querySelectorAll('input[type="checkbox"]').length,
          toolBox:!!m.querySelector(".subagent-tool-box"),
          hasInvoke:text.includes("agent_invoke"), hasSave:text.includes("subagent_save"),
          oldCopy:text.includes("dynamicTools")||text.includes("agent_invoke · subagent") };
      })()`).catch(() => null);
      await h.eval(`(function(){ document.querySelector(".subagent-editor-modal .app-select-trigger")?.click(); return 1; })()`);
      await wait(400);
      const effortOpts = await h.eval(`(function(){ return [...document.querySelectorAll(".app-select-list .app-select-option-label")].map((x)=>(x.textContent||"").trim()); })()`).catch(() => []);
      h.check("⑰ 新建子智能体：推理强度四档、共享胶囊开关、agent_invoke + subagent_save",
        Boolean(subModalBase && subModalBase.toggles >= 4 && subModalBase.checkboxes === 0
          && subModalBase.toolBox && subModalBase.hasInvoke && subModalBase.hasSave && !subModalBase.oldCopy
          && effortOpts.join("/") === "低/中/高/极高"),
        JSON.stringify({ ...subModalBase, effortOpts }));
      await h.eval(`(function(){ const b=[...document.querySelectorAll(".subagent-editor-modal footer button")].find((x)=>(x.textContent||"").includes("取消")); b?.click(); return b?1:0; })()`);
      await wait(300);

    },
  },
  {
    id: "cloud-account",
    name: "☁️ 云账号：桌面仓云账号板块已替换云管理 + 云助手专属项仍在（10-28）",
    run: async (h) => {
      await h.eval(`(function(){ if(!document.querySelector(".settings-modal")) document.querySelector(".sidebar-settings")?.click(); return 1; })()`);
      await h.waitFor(`!!document.querySelector(".settings-modal")`, { label: "设置面板", timeoutMs: 8000 });
      await wait(700);
      /* 本地静态预览不走 headless 的 index 注入 ⇒ 闸变量要自己给（生产由 headless 写进页面）。
         ⛔ 先存原值、跑完还原：后续验收项不继承本项制造的全局态。 */
      const prevGate = await h.eval(`(function(){ const v = window.__CHC_ACCOUNT_GATE__; window.__CHC_ACCOUNT_GATE__ = true; return typeof v === "undefined" ? "" : String(v); })()`);
      const navClick = async (label) => h.eval(`(function(){ const b=[...document.querySelectorAll(".settings-nav button")].find(function(x){ return (x.textContent||"").trim()===${JSON.stringify(label)}; }); if(!b) return 0; b.click(); return 1; })()`);
      await navClick("云账号");
      await wait(1500);
      const page = await h.eval(`(function(){
        const m=document.querySelector(".settings-modal"); if(!m) return null;
        return { active:(m.querySelector(".settings-nav button.active")?.textContent||"").trim(),
          hasSection:!!m.querySelector(".cloud-acct-section"),
          hasLogin:!!m.querySelector('[data-testid="cloud-login-simple"]'),
          hasReady:!!m.querySelector('[data-testid="cloud-ready"]'),
          unsupported:!!m.querySelector('[data-testid="cloud-account-unsupported"]'),
          extras:!!m.querySelector('[data-testid="cloud-assistant-extras"]') };
      })()`).catch(() => null);
      h.check("① 云账号页：账号板块已挂载（登录卡 / 就绪清单 / 旧壳说明 三选一）+ 云助手专属区在",
        Boolean(page && page.active === "云账号" && page.hasSection && page.extras
          && (page.hasLogin || page.hasReady || page.unsupported)), JSON.stringify(page));

      const opened = await h.eval(`(function(){ const b=[...document.querySelectorAll('[data-testid="cloud-assistant-extras"] button')].find(function(x){ return (x.textContent||"").includes("打开设备与云服务设置"); }); if(!b) return 0; b.click(); return 1; })()`);
      await h.waitFor(`!!document.querySelector(".cloud-manage-card")`, { label: "云助手专属面板", timeoutMs: 5000 }).catch(() => undefined);
      const dlg = await h.eval(`(function(){ const c=document.querySelector(".cloud-manage-card"); if(!c) return null;
        const t=c.innerText||"";
        return { hasBenefit:t.includes("限时福利"), hasDevice:t.includes("设备 / 座位"),
          hasPoints:t.includes("我的积分"), hasSync:t.includes("会话同步") }; })()`).catch(() => null);
      h.check("② 云助手专属面板：保留设备/座位与限时福利，积分与会话同步已移出（不出现两份）",
        Boolean(opened && dlg && dlg.hasBenefit && dlg.hasDevice && !dlg.hasPoints && !dlg.hasSync), JSON.stringify(dlg));
      await h.eval(`(function(){ document.querySelector(".cloud-manage-x")?.click(); return 1; })()`);
      await wait(400);
      const closed = await h.eval(`!document.querySelector(".cloud-manage-card")`).catch(() => false);
      h.check("③ 面板可关闭（不留遮罩挡住设置页）", closed === true, String(closed));
      /* 还原闸变量（见本项开头）：原本没有就删掉，原本有就写回原值。 */
      await h.eval(`(function(){ const prev = ${JSON.stringify(prevGate)}; if (prev === "") { try { delete window.__CHC_ACCOUNT_GATE__; } catch (e) { /* 忽略 */ } } else { window.__CHC_ACCOUNT_GATE__ = prev === "true"; } return 1; })()`);
    },
  },
  {
    id: "engine-data",
    name: "⚙️ 引擎在位：设置页资源（技能/钩子/插件）读取不再报 spawn ENOENT（10-28 事故）",
    run: async (h) => {
      await h.eval(`(function(){ if(!document.querySelector(".settings-modal")) document.querySelector(".sidebar-settings")?.click(); return 1; })()`);
      await h.waitFor(`!!document.querySelector(".settings-modal")`, { label: "设置面板", timeoutMs: 8000 });
      /* 资源是一次性批量拉的（开设置时已触发）：给足时间再读错误条。 */
      await wait(2500);
      const banner = await h.eval(`(function(){ const el=document.querySelector(".settings-modal .resource-error"); return el ? (el.innerText||"") : ""; })()`).catch(() => "");
      h.check("① 设置页资源读取无引擎缺失报错（spawn / ENOENT / 引擎文件缺失均不允许）",
        !/spawn|ENOENT|引擎文件缺失/.test(banner), String(banner).slice(0, 300));
      /* 技能页真有数据：引擎返回空列表也算"读不到"，能抓到"引擎在但列表空"的另一半故障。 */
      await h.eval(`(function(){ const b=[...document.querySelectorAll(".settings-nav button")].find(function(x){ return (x.textContent||"").trim()==="技能"; }); b?.click(); return 1; })()`);
      await wait(1200);
      const skills = await h.eval(`(function(){ const m=document.querySelector(".settings-modal"); if(!m) return null;
        return { center: !!m.querySelector(".skill-center"), cards: m.querySelectorAll('[class*="skill-card"]').length }; })()`).catch(() => null);
      h.check("② 技能列表有内容（不是空壳）", Boolean(skills && skills.center && skills.cards > 0), JSON.stringify(skills));
    },
  },
  {
    id: "hooks-toolbar",
    name: "🪝 钩子页：搜索 + 状态/来源筛选 + 刷新（10-28）",
    run: async (h) => {
      await h.eval(`(function(){ if(!document.querySelector(".settings-modal")) document.querySelector(".sidebar-settings")?.click(); return 1; })()`);
      await h.waitFor(`!!document.querySelector(".settings-modal")`, { label: "设置面板", timeoutMs: 8000 });
      await h.eval(`(function(){ const b=[...document.querySelectorAll(".settings-nav button")].find(function(x){ return (x.textContent||"").trim()==="钩子"; }); b?.click(); return 1; })()`);
      await wait(1200);
      const ui = await h.eval(`(function(){
        const m=document.querySelector(".settings-modal"); if(!m) return null;
        const row=m.querySelector(".hook-filter-row");
        return { active:(m.querySelector(".settings-nav button.active")?.textContent||"").trim(),
          row:!!row,
          search:!!(row && row.querySelector(".search-field input")),
          selects:row ? row.querySelectorAll(".app-select-trigger").length : 0,
          refresh:!!(row && row.querySelector('button[title="刷新钩子"]')),
          total:Number((m.querySelector(".hook-stat strong")?.textContent||"0").replace(/\\D/g,""))||0,
          layout:row ? Math.round(row.getBoundingClientRect().height) : 0 };
      })()`).catch(() => null);
      h.check("① 工具栏齐：搜索 + 状态筛选 + 来源筛选 + 刷新（同一行）",
        Boolean(ui && ui.active === "钩子" && ui.row && ui.search && ui.selects === 2 && ui.refresh), JSON.stringify(ui));

      /* 真输入（受控输入必须走原生 setter + input 事件，否则 React 不收）。 */
      const typed = await h.eval(`(function(){
        const input=document.querySelector(".hook-filter-row .search-field input"); if(!input) return null;
        const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;
        setter.call(input,"zzz-no-such-hook"); input.dispatchEvent(new Event("input",{bubbles:true}));
        return input.value;
      })()`).catch(() => null);
      await wait(700);
      const filtered = await h.eval(`(function(){
        const m=document.querySelector(".settings-modal"); if(!m) return null;
        const text=m.innerText||"";
        return { empty: /没有匹配的钩子|还没有注册钩子/.test(text),
          clear: !!m.querySelector(".hook-clear-filters"),
          count: (m.querySelector(".hook-filter-count")?.textContent||"").trim() };
      })()`).catch(() => null);
      h.check("② 输入无匹配关键词：给出空态（有数据时带「清除筛选」），不崩",
        Boolean(typed === "zzz-no-such-hook" && filtered && filtered.empty && (!filtered.count || /匹配\s*0/.test(filtered.count))),
        JSON.stringify({ typed, filtered }));
      await h.eval(`(function(){ const b=document.querySelector(".hook-clear-filters"); if(b){b.click();return 1;}
        const input=document.querySelector(".hook-filter-row .search-field input");
        if(input){ const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set; setter.call(input,""); input.dispatchEvent(new Event("input",{bubbles:true})); }
        return 0; })()`);
      await wait(500);
      const restored = await h.eval(`(function(){ const input=document.querySelector(".hook-filter-row .search-field input"); return input ? input.value : null; })()`).catch(() => null);
      h.check("③ 清除筛选后关键词归零", restored === "", String(restored));
    },
  },
  {
    id: "function-menu",
    name: "🧩 功能入口：新建/搜索下面或侧栏底部 + 拖动排序 + 更多 + 首次教程（10-24）",
    run: async (h) => {
      /* 用户 10-24：功能入口菜单要放在「新会话 / 搜索任务」下面（老版位置），也可选侧栏底部；
         支持首次悬停教程、编辑菜单拖动排序、拖进「更多」。两种位置共用同一套配置。 */
      await h.waitFor(`!!document.querySelector(".app-shell")`, { label: "界面就绪", timeoutMs: 40000 });
      await h.eval(`(function(){ document.querySelector(".office-overlay-close")?.click(); document.querySelector(".function-menu-editor .fm-editor-close")?.click(); return 1; })()`).catch(() => undefined);
      await wait(400);
      await h.waitFor(`!!document.querySelector(".function-menu-sidebar")`, { label: "功能入口就绪", timeoutMs: 15000 }).catch(() => undefined);
      // 先统一重置：位置回顶部、排序/更多恢复默认（上一轮失败可能留下 overflow）
      await h.eval(`document.querySelector(".function-menu-sidebar .function-menu-more")?.click()`).catch(() => undefined);
      await wait(250);
      await h.eval(`[...document.querySelectorAll(".function-menu-popover-item")].find((b) => b.innerText.includes("编辑菜单"))?.click()`).catch(() => undefined);
      await h.waitFor(`!!document.querySelector(".function-menu-editor")`, { timeoutMs: 4000 }).catch(() => undefined);
      await h.eval(`document.querySelectorAll(".fm-location-card")[0]?.click()`).catch(() => undefined);
      await wait(200);
      await h.eval(`[...document.querySelectorAll(".fm-editor-foot button")].find((b) => b.innerText.includes("恢复默认"))?.click()`).catch(() => undefined);
      await wait(250);
      await h.eval(`[...document.querySelectorAll(".fm-editor-foot button")].find((b) => b.innerText.includes("完成"))?.click()`).catch(() => undefined);
      await wait(500);
      // 折叠态跨重启保留：上一轮收起了就先展开，后面要量真实高度/拖动
      if (await h.eval(`document.querySelector(".sidebar-options-top .sidebar-options-body")?.classList.contains("is-collapsed")`).catch(() => false)) {
        await h.eval(`document.querySelector(".sidebar-options-top .sidebar-options-toggle")?.click()`).catch(() => undefined);
        await wait(350);
      }
      // 折叠动画在后台窗口可能被节流：测试里等 React 提交后把 CSS 过渡直接推到终点再量高度。
      const settleAnimations = async () => {
        await h.eval(`(function(){ void document.body.offsetHeight; document.getAnimations().forEach((a) => { try { a.finish(); } catch {} }); return 1; })()`).catch(() => undefined);
        await wait(80);
      };
      // 10-24 用户对照截图：顶部改成整行「新会话」+ 下一行「搜索任务」（不再并排胶囊）
      const quickLayout = await h.eval(`(function(){
        const box=document.querySelector(".sidebar-quick");
        const btns=[...box.querySelectorAll(".sidebar-quick-btn")];
        const a=btns[0]?.getBoundingClientRect(), b=btns[1]?.getBoundingClientRect();
        return { n:btns.length, labels:btns.map((x)=>x.innerText.trim()),
          stacked:!!(a&&b&&b.top>=a.bottom-1), sameWidth:!!(a&&b&&Math.abs(a.width-b.width)<1),
          sameLeft:!!(a&&b&&Math.abs(a.left-b.left)<1), width:a?.width||0,
          searchAlign:btns[1]?getComputedStyle(btns[1]).justifyContent:"" };
      })()`).catch(() => null);
      h.check("⓪ 顶部为整行「新会话」+ 下一行左对齐「搜索任务」（上下堆叠、同宽同左，不再并排胶囊）",
        Boolean(quickLayout && quickLayout.n >= 2 && quickLayout.labels[0] === "新会话" && quickLayout.labels[1] === "搜索任务"
          && quickLayout.stacked && quickLayout.sameWidth && quickLayout.sameLeft && quickLayout.width > 120
          && quickLayout.searchAlign === "flex-start"),
        JSON.stringify(quickLayout));
      const base = await h.eval(`(function(){
        const group = document.querySelector(".sidebar-options-top");
        const quick = document.querySelector(".sidebar-quick")?.getBoundingClientRect();
        const rect = group?.getBoundingClientRect();
        const searchText = document.querySelector(".sidebar-quick-search span")?.getBoundingClientRect().left;
        const headerText = group?.querySelector(".sidebar-options-toggle > span")?.getBoundingClientRect().left;
        return { sidebar: !!document.querySelector(".function-menu-sidebar"), top: !!group,
          underQuick: Boolean(quick && rect && rect.top >= quick.bottom - 1 && rect.top <= quick.bottom + 28),
          gap: quick && rect ? Math.round(rect.top - quick.bottom) : 999,
          toggle: !!group?.querySelector(".sidebar-options-toggle"),
          body: !!group?.querySelector(".sidebar-options-body"),
          icon: !!group?.querySelector(".sidebar-options-toggle svg"),
          textAligned: searchText != null && headerText != null && Math.abs(searchText - headerText) <= 1,
          labels: [...document.querySelectorAll(".function-menu-sidebar .sidebar-cap-row")].map((b) => b.innerText.trim()),
          more: !!document.querySelector(".function-menu-sidebar .function-menu-more") };
      })()`).catch(() => null);
      h.check("① 功能入口在「新会话 / 搜索任务」下面（7 项 + 更多），整个入口组可见",
        Boolean(base && base.sidebar && base.top && base.underQuick && base.labels.length === 8 && base.more
          && ["自动化", "前端开发", "拓展", "团队", "个性化&记忆", "登录管理", "新手教程"].every((label) => base.labels.includes(label))),
        JSON.stringify(base));
      h.check("①b 顶部入口紧贴搜索任务（间距 ≤10px），有图标且文字与「搜索任务」左对齐",
        Boolean(base && base.gap >= 0 && base.gap <= 10 && base.toggle && base.body && base.icon && base.textAligned), JSON.stringify(base));

      // 首次悬停教程：清掉已看标记再 hover
      await h.eval(`localStorage.removeItem("function-menu-tour-seen-v1-top")`).catch(() => undefined);
      await h.hover(".sidebar-options-top");
      await wait(200);
      await h.hover(".sidebar-options-top .sidebar-options-toggle");
      // CDP 鼠标可能本来就在侧栏里 ⇒ mouseenter 不触发；补一次合成 mouseover（React 由它合成 onMouseEnter）
      await wait(200);
      await h.eval(`(function(){ const el=document.querySelector(".sidebar-options-top .sidebar-options-toggle"); el?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); return 1; })()`).catch(() => undefined);
      await h.waitFor(`!!document.querySelector(".function-menu-tour")`, { timeoutMs: 3000 }).catch(() => undefined);
      const tour = await h.eval(`document.querySelector(".function-menu-tour")?.innerText || ""`).catch(() => "");
      h.check("② 首次悬停弹出教程（说明编辑菜单 / 拖进更多 / 设置里切换位置）",
        tour.includes("让功能入口更顺手") && tour.includes("编辑菜单") && tour.includes("拖进") && tour.includes("设置 → 外观"),
        JSON.stringify({ tour: tour.slice(0, 80) }));
      await h.eval(`[...document.querySelectorAll(".function-menu-tour-actions button")].find((b) => b.innerText.includes("知道了"))?.click()`).catch(() => undefined);
      await wait(200);

      // 更多 → 编辑菜单
      await h.eval(`document.querySelector(".function-menu-sidebar .function-menu-more")?.click()`).catch(() => undefined);
      await wait(250);
      await h.eval(`[...document.querySelectorAll(".function-menu-popover-item")].find((b) => b.innerText.includes("编辑菜单"))?.click()`).catch(() => undefined);
      await h.waitFor(`!!document.querySelector(".function-menu-editor")`, { label: "编辑菜单弹窗", timeoutMs: 4000 }).catch(() => undefined);
      const editor = await h.eval(`(function(){
        return { open: !!document.querySelector(".function-menu-editor"),
          cols: [...document.querySelectorAll(".fm-edit-col")].map((c) => c.querySelectorAll(".fm-edit-row").length),
          locations: [...document.querySelectorAll(".fm-location-card")].map((b) => b.innerText.trim().split("\\n")[0]) };
      })()`).catch(() => null);
      h.check("③ 更多 → 编辑菜单：弹窗有显示 / 更多两列 + 顶部/底部两个展示位置",
        Boolean(editor && editor.open && editor.cols[0] >= 1 && editor.locations.length === 2 && editor.locations.includes("侧栏顶部") && editor.locations.includes("侧栏底部")),
        JSON.stringify(editor));

      // 拖动第一项到「更多」列
      const firstLabel = await h.eval(`document.querySelector(".fm-edit-row")?.innerText.trim() || ""`).catch(() => "");
      await h.eval(`(function(){
        const row = document.querySelector(".fm-edit-row"); if (!row) return 0;
        const dt = new DataTransfer(); window.__fmDt = dt;
        row.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
        return 1;
      })()`).catch(() => 0);
      await wait(150);
      await h.eval(`(function(){
        const list = document.querySelectorAll(".fm-edit-col")[1]?.querySelector(".fm-edit-list"); if (!list) return 0;
        list.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: window.__fmDt }));
        list.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: window.__fmDt }));
        return 1;
      })()`).catch(() => 0);
      await wait(250);
      const dragged = await h.eval(`(function(){
        const overflow = [...document.querySelectorAll(".fm-edit-col")[1].querySelectorAll(".fm-edit-label")].map((e) => e.innerText.trim());
        return { first: ${JSON.stringify(firstLabel)}, overflow,
          badge: document.querySelector(".function-menu-sidebar .function-menu-more-badge")?.innerText.trim() || "" };
      })()`).catch(() => null);
      h.check("④ 拖动入口到「更多」：进入更多列并在侧栏「更多」上出现角标",
        Boolean(dragged && dragged.overflow.includes(dragged.first.trim()) && Number(dragged.badge) >= 1),
        JSON.stringify(dragged));

      // 移回（用行尾按钮，与拖动落点同源）
      await h.eval(`(function(){ const row = document.querySelectorAll(".fm-edit-col")[1]?.querySelector(".fm-edit-row"); const btns = row ? row.querySelectorAll("button") : []; btns[2]?.click(); return 1; })()`).catch(() => 0);
      await wait(250);
      const movedBack = await h.eval(`(function(){
        return { overflowCount: document.querySelectorAll(".fm-edit-col")[1]?.querySelectorAll(".fm-edit-row").length || 0,
          badge: document.querySelector(".function-menu-sidebar .function-menu-more-badge")?.innerText.trim() || "" };
      })()`).catch(() => null);
      h.check("⑤ 从「更多」移回菜单：更多列清空、角标消失", Boolean(movedBack && movedBack.overflowCount === 0 && !movedBack.badge), JSON.stringify(movedBack));

      // 切到侧栏底部：入口组消失于顶部、改在账户行之前
      await h.eval(`document.querySelectorAll(".fm-location-card")[1]?.click()`).catch(() => undefined);
      await wait(400);
      await h.eval(`[...document.querySelectorAll(".fm-editor-foot button")].find((b) => b.innerText.includes("完成"))?.click()`).catch(() => undefined);
      await wait(400);
      const bottom = await h.eval(`(function(){
        const group = document.querySelector(".sidebar-options:not(.sidebar-options-top)");
        const rect = group?.getBoundingClientRect();
        const account = document.querySelector(".account-row")?.getBoundingClientRect();
        return { top: !!document.querySelector(".sidebar-options-top"), bottom: !!group,
          aboveAccount: Boolean(rect && account && rect.bottom <= account.top + 1),
          count: group ? group.querySelectorAll(".sidebar-cap-row").length : 0 };
      })()`).catch(() => null);
      h.check("⑥ 切到侧栏底部：入口组移到用户名上方、顶部组消失（共用顺序/更多配置）",
        Boolean(bottom && !bottom.top && bottom.bottom && bottom.aboveAccount && bottom.count === 8),
        JSON.stringify(bottom));
      // ⑦ 底部组折叠/展开：grid 高度过渡到 0，再点恢复（两处位置都支持）
      await h.eval(`document.querySelector(".sidebar-options:not(.sidebar-options-top) .sidebar-options-toggle")?.click()`).catch(() => undefined);
      await wait(150);
      await settleAnimations();
      const bottomCollapsed = await h.eval(`(function(){
        const g=document.querySelector(".sidebar-options:not(.sidebar-options-top)");
        const body=g?.querySelector(".sidebar-options-body");
        const nav=g?.querySelector(".sidebar-nav-bottom");
        return { cls:body?.classList.contains("is-collapsed")||false,
          bodyH:body?Math.round(body.getBoundingClientRect().height):-1,
          navH:nav?Math.round(nav.getBoundingClientRect().height):-1,
          aria:nav?.getAttribute("aria-hidden")||"",
          rows:body?getComputedStyle(body).gridTemplateRows:"",
          display:body?getComputedStyle(body).display:"",
          navOverflow:nav?getComputedStyle(nav).overflowY:"" };
      })()`).catch(() => null);
      h.check("⑦ 底部组可折叠：点击后高度收至 0 且 aria-hidden",
        Boolean(bottomCollapsed && bottomCollapsed.cls && bottomCollapsed.bodyH <= 4 && bottomCollapsed.navH <= 4 && bottomCollapsed.aria === "true"),
        JSON.stringify(bottomCollapsed));
      await h.eval(`document.querySelector(".sidebar-options:not(.sidebar-options-top) .sidebar-options-toggle")?.click()`).catch(() => undefined);
      await wait(150);
      await settleAnimations();
      const bottomExpanded = await h.eval(`(function(){
        const g=document.querySelector(".sidebar-options:not(.sidebar-options-top)");
        const body=g?.querySelector(".sidebar-options-body");
        const nav=g?.querySelector(".sidebar-nav-bottom");
        return { cls:body?.classList.contains("is-collapsed")||false,
          bodyH:body?Math.round(body.getBoundingClientRect().height):-1,
          navH:nav?Math.round(nav.getBoundingClientRect().height):-1,
          aria:nav?.getAttribute("aria-hidden")||"" };
      })()`).catch(() => null);
      h.check("⑦b 底部组再点展开：高度恢复、aria-hidden 复位（无缝动画）",
        Boolean(bottomExpanded && !bottomExpanded.cls && bottomExpanded.bodyH > 80 && bottomExpanded.navH > 80 && bottomExpanded.aria === "false"),
        JSON.stringify(bottomExpanded));

      // ⑧ 切回顶部并恢复默认排序
      await h.eval(`document.querySelector(".sidebar-options:not(.sidebar-options-top) .function-menu-more")?.click()`).catch(() => undefined);
      await wait(250);
      await h.eval(`[...document.querySelectorAll(".function-menu-popover-item")].find((b) => b.innerText.includes("编辑菜单"))?.click()`).catch(() => undefined);
      await h.waitFor(`!!document.querySelector(".function-menu-editor")`, { timeoutMs: 4000 }).catch(() => undefined);
      await h.eval(`document.querySelectorAll(".fm-location-card")[0]?.click()`).catch(() => undefined);
      await wait(250);
      await h.eval(`[...document.querySelectorAll(".fm-editor-foot button")].find((b) => b.innerText.includes("恢复默认"))?.click()`).catch(() => undefined);
      await wait(250);
      await h.eval(`[...document.querySelectorAll(".fm-editor-foot button")].find((b) => b.innerText.includes("完成"))?.click()`).catch(() => undefined);
      await wait(400);
      const restored = await h.eval(`(function(){
        const group = document.querySelector(".sidebar-options-top");
        const quick = document.querySelector(".sidebar-quick")?.getBoundingClientRect();
        const rect = group?.getBoundingClientRect();
        return { top: !!group, bottom: !!document.querySelector(".sidebar-options:not(.sidebar-options-top)"),
          underQuick: Boolean(quick && rect && rect.top >= quick.bottom - 1 && rect.top <= quick.bottom + 28),
          count: group ? group.querySelectorAll(".sidebar-cap-row").length : 0,
          badge: !!group?.querySelector(".function-menu-more-badge") };
      })()`).catch(() => null);
      h.check("⑧ 顶部位置恢复 + 默认排序（不留上一步的位置配置）",
        Boolean(restored && restored.top && !restored.bottom && restored.underQuick && restored.count === 8 && !restored.badge),
        JSON.stringify(restored));

      // ⑨ 顶部组折叠/展开（与底部同款 grid 高度动画）
      await h.eval(`document.querySelector(".sidebar-options-top .sidebar-options-toggle")?.click()`).catch(() => undefined);
      await wait(150);
      await settleAnimations();
      const topCollapsed = await h.eval(`(function(){
        const g=document.querySelector(".sidebar-options-top");
        const body=g?.querySelector(".sidebar-options-body");
        const nav=g?.querySelector(".sidebar-nav-bottom");
        return { cls:body?.classList.contains("is-collapsed")||false,
          bodyH:body?Math.round(body.getBoundingClientRect().height):-1,
          navH:nav?Math.round(nav.getBoundingClientRect().height):-1,
          aria:nav?.getAttribute("aria-hidden")||"" };
      })()`).catch(() => null);
      h.check("⑨ 顶部组可折叠：点击后高度收至 0，搜索任务下方不再占位",
        Boolean(topCollapsed && topCollapsed.cls && topCollapsed.bodyH <= 4 && topCollapsed.navH <= 4 && topCollapsed.aria === "true"),
        JSON.stringify(topCollapsed));
      await h.eval(`document.querySelector(".sidebar-options-top .sidebar-options-toggle")?.click()`).catch(() => undefined);
      await wait(150);
      await settleAnimations();
      const topExpanded = await h.eval(`(function(){
        const g=document.querySelector(".sidebar-options-top");
        const body=g?.querySelector(".sidebar-options-body");
        const nav=g?.querySelector(".sidebar-nav-bottom");
        return { cls:body?.classList.contains("is-collapsed")||false,
          bodyH:body?Math.round(body.getBoundingClientRect().height):-1,
          navH:nav?Math.round(nav.getBoundingClientRect().height):-1,
          aria:nav?.getAttribute("aria-hidden")||"" };
      })()`).catch(() => null);
      h.check("⑨b 顶部组再点展开：高度恢复（与底部同款无缝过渡）",
        Boolean(topExpanded && !topExpanded.cls && topExpanded.bodyH > 80 && topExpanded.navH > 80 && topExpanded.aria === "false"),
        JSON.stringify(topExpanded));
      await h.screenshot("function-menu");

      // ⑩ 侧栏里直接拖动排序：不用打开编辑弹窗，落手即写回配置
      const dragBefore = await h.eval(`(function(){
        const rows=[...document.querySelectorAll(".sidebar-options-top .sidebar-cap-row:not(.function-menu-more)")];
        let stored=null; try { stored=JSON.parse(localStorage.getItem("function-menu-v1") || "null"); } catch {}
        return { labels: rows.map((b)=>b.querySelector("span")?.innerText.trim()), order: stored?.order || [] };
      })()`).catch(() => null);
      await h.eval(`(function(){
        const rows=[...document.querySelectorAll(".sidebar-options-top .sidebar-cap-row:not(.function-menu-more)")];
        if (rows.length < 2) return 0;
        const dt=new DataTransfer(); window.__fmDt=dt;
        rows[1].dispatchEvent(new DragEvent("dragstart", { bubbles:true, cancelable:true, dataTransfer:dt }));
        return 1;
      })()`).catch(() => 0);
      await wait(200);
      await h.eval(`(function(){
        const rows=[...document.querySelectorAll(".sidebar-options-top .sidebar-cap-row:not(.function-menu-more)")];
        if (rows.length < 2) return 0;
        rows[0].dispatchEvent(new DragEvent("dragover", { bubbles:true, cancelable:true, dataTransfer:window.__fmDt }));
        rows[0].dispatchEvent(new DragEvent("drop", { bubbles:true, cancelable:true, dataTransfer:window.__fmDt }));
        return 1;
      })()`).catch(() => 0);
      await wait(350);
      const dragAfter = await h.eval(`(function(){
        const top=document.querySelector(".sidebar-options-top");
        const labels=[...top.querySelectorAll(".sidebar-cap-row:not(.function-menu-more)")].map((b)=>b.querySelector("span")?.innerText.trim());
        let stored=null; try { stored=JSON.parse(localStorage.getItem("function-menu-v1") || "null"); } catch {}
        return { labels, order: stored?.order || [], location: stored?.location || "",
          bottom: !!document.querySelector(".sidebar-options:not(.sidebar-options-top)") };
      })()`).catch(() => null);
      h.check("⑩ 侧栏直接拖动即生效：首两项立即换位、配置同步（无需点完成）",
        Boolean(dragBefore && dragAfter && dragBefore.labels[0] === dragAfter.labels[1] && dragBefore.labels[1] === dragAfter.labels[0]
          && dragAfter.order[0] === dragBefore.order[1] && dragAfter.location === "top" && !dragAfter.bottom),
        JSON.stringify({ before: dragBefore, after: dragAfter }));
      // ⑩b 改动落到主进程 app-settings.json（重启/强杀后的回灌源）
      const persisted = await h.eval(`window.codex.readAppSettings().then((s) => ({ fm: s.functionMenu, collapsed: s.sidebarOptionsCollapsed })).catch((e) => ({ error: String(e) }))`).catch(() => null);
      h.check("⑩b 位置/顺序/折叠态已写入主进程 app-settings（重启后回灌）",
        Boolean(persisted && persisted.fm && persisted.fm.location === "top" && persisted.fm.order && persisted.fm.order[0] === dragBefore?.order[1]
          && persisted.collapsed === false),
        JSON.stringify(persisted));

      // ⑪ 收尾恢复默认排序（不留测试配置）
      await h.eval(`document.querySelector(".sidebar-options-top .function-menu-more")?.click()`).catch(() => undefined);
      await wait(250);
      await h.eval(`[...document.querySelectorAll(".function-menu-popover-item")].find((b) => b.innerText.includes("编辑菜单"))?.click()`).catch(() => undefined);
      await h.waitFor(`!!document.querySelector(".function-menu-editor")`, { timeoutMs: 4000 }).catch(() => undefined);
      await h.eval(`[...document.querySelectorAll(".fm-editor-foot button")].find((b) => b.innerText.includes("恢复默认"))?.click()`).catch(() => undefined);
      await wait(250);
      await h.eval(`[...document.querySelectorAll(".fm-editor-foot button")].find((b) => b.innerText.includes("完成"))?.click()`).catch(() => undefined);
      await wait(400);
      const final = await h.eval(`(function(){
        const group = document.querySelector(".sidebar-options-top");
        return { top: !!group, count: group ? group.querySelectorAll(".sidebar-cap-row").length : 0,
          badge: !!group?.querySelector(".function-menu-more-badge"),
          collapsed: !!group?.querySelector(".sidebar-options-body.is-collapsed") };
      })()`).catch(() => null);
      h.check("⑪ 收尾恢复默认排序、顶部展开（不留测试配置）",
        Boolean(final && final.top && final.count === 8 && !final.badge && !final.collapsed),
        JSON.stringify(final));

      // ⑫ 强杀重启：用户改动后的位置/顺序/折叠态必须原样回来（即使 localStorage 最后写入丢了）
      const persistBefore = await h.eval(`(function(){
        const rows=[...document.querySelectorAll(".sidebar-options-top .sidebar-cap-row:not(.function-menu-more)")];
        let stored=null; try { stored=JSON.parse(localStorage.getItem("function-menu-v1") || "null"); } catch {}
        return { labels: rows.map((b)=>b.querySelector("span")?.innerText.trim()), order: stored?.order || [] };
      })()`).catch(() => null);
      await h.eval(`(function(){
        const rows=[...document.querySelectorAll(".sidebar-options-top .sidebar-cap-row:not(.function-menu-more)")];
        if (rows.length < 2) return 0;
        const dt=new DataTransfer(); window.__fmDt=dt;
        rows[1].dispatchEvent(new DragEvent("dragstart", { bubbles:true, cancelable:true, dataTransfer:dt }));
        return 1;
      })()`).catch(() => 0);
      await wait(200);
      await h.eval(`(function(){
        const rows=[...document.querySelectorAll(".sidebar-options-top .sidebar-cap-row:not(.function-menu-more)")];
        if (rows.length < 2) return 0;
        rows[0].dispatchEvent(new DragEvent("dragover", { bubbles:true, cancelable:true, dataTransfer:window.__fmDt }));
        rows[0].dispatchEvent(new DragEvent("drop", { bubbles:true, cancelable:true, dataTransfer:window.__fmDt }));
        return 1;
      })()`).catch(() => 0);
      await wait(500);
      await h.eval(`document.querySelector(".sidebar-options-top .sidebar-options-toggle")?.click()`).catch(() => undefined);
      await wait(150);
      await settleAnimations();
      const beforeRestart = await h.eval(`(function(){
        const group=document.querySelector(".sidebar-options-top");
        const body=group?.querySelector(".sidebar-options-body");
        const rows=[...group.querySelectorAll(".sidebar-cap-row:not(.function-menu-more)")];
        let stored=null; try { stored=JSON.parse(localStorage.getItem("function-menu-v1") || "null"); } catch {}
        return { labels: rows.map((b)=>b.querySelector("span")?.textContent.trim()), order: stored?.order || [],
          location: stored?.location || "", collapsed: body?.classList.contains("is-collapsed") || false };
      })()`).catch(() => null);
      const persistedBeforeRestart = await h.eval(`window.codex.readAppSettings().then((s)=>({ fm:s.functionMenu, collapsed:s.sidebarOptionsCollapsed })).catch((e)=>({ error:String(e) }))`).catch(() => null);
      h.check("⑫a 重启前：位置/顺序/折叠态已在主进程落盘",
        Boolean(beforeRestart && persistedBeforeRestart?.fm && persistedBeforeRestart.fm.location === "top"
          && persistedBeforeRestart.fm.order?.[0] === beforeRestart.order?.[0]
          && persistedBeforeRestart.collapsed === true && beforeRestart.collapsed), JSON.stringify({ beforeRestart, persistedBeforeRestart }));

      // 模拟强杀时 localStorage 丢/旧：故意写一份错误值，重启后必须以 app-settings 为准回灌
      await h.eval(`(function(){
        try {
          localStorage.setItem("function-menu-v1", JSON.stringify({ location: "bottom", order: ["newbie","login","identity","team","extensions","frontend","schedule"], overflow: [] }));
          localStorage.setItem("sidebar-options-collapsed", "false");
        } catch {}
        return 1;
      })()`).catch(() => undefined);

      await h.restart();
      await h.waitFor(`!!document.querySelector(".app-shell")`, { label: "重启后界面就绪", timeoutMs: 40000 });
      await wait(1800);
      const afterRestart = await h.eval(`(function(){
        const group=document.querySelector(".sidebar-options-top");
        const body=group?.querySelector(".sidebar-options-body");
        const rows=group ? [...group.querySelectorAll(".sidebar-cap-row:not(.function-menu-more)")] : [];
        let stored=null; try { stored=JSON.parse(localStorage.getItem("function-menu-v1") || "null"); } catch {}
        return { top: !!group, bottom: !!document.querySelector(".sidebar-options:not(.sidebar-options-top)"),
          labels: rows.map((b)=>b.querySelector("span")?.textContent.trim()),
          order: stored?.order || [], location: stored?.location || "",
          collapsed: body?.classList.contains("is-collapsed") || false,
          bodyH: body ? Math.round(body.getBoundingClientRect().height) : -1 };
      })()`).catch(() => null);
      h.check("⑫ 强杀重启后仍是用户改动后的状态（顶部 + 自定义顺序 + 折叠）",
        Boolean(afterRestart && afterRestart.top && !afterRestart.bottom && afterRestart.location === "top"
          && afterRestart.order?.[0] === beforeRestart?.order?.[0]
          && afterRestart.labels?.[0] === beforeRestart?.labels?.[0] && afterRestart.collapsed && afterRestart.bodyH <= 4),
        JSON.stringify({ beforeRestart, afterRestart }));

      // ⑫b 收尾：展开并恢复默认排序
      await h.eval(`document.querySelector(".sidebar-options-top .sidebar-options-toggle")?.click()`).catch(() => undefined);
      await wait(150);
      await settleAnimations();
      await h.eval(`document.querySelector(".sidebar-options-top .function-menu-more")?.click()`).catch(() => undefined);
      await wait(250);
      await h.eval(`[...document.querySelectorAll(".function-menu-popover-item")].find((b) => b.innerText.includes("编辑菜单"))?.click()`).catch(() => undefined);
      await h.waitFor(`!!document.querySelector(".function-menu-editor")`, { timeoutMs: 4000 }).catch(() => undefined);
      await h.eval(`[...document.querySelectorAll(".fm-editor-foot button")].find((b) => b.innerText.includes("恢复默认"))?.click()`).catch(() => undefined);
      await wait(250);
      await h.eval(`[...document.querySelectorAll(".fm-editor-foot button")].find((b) => b.innerText.includes("完成"))?.click()`).catch(() => undefined);
      await wait(400);
      const afterCleanup = await h.eval(`(function(){
        const group=document.querySelector(".sidebar-options-top");
        return { top: !!group, count: group ? group.querySelectorAll(".sidebar-cap-row").length : 0,
          collapsed: !!group?.querySelector(".sidebar-options-body.is-collapsed"),
          first: group?.querySelector(".sidebar-cap-row span")?.innerText.trim() || "" };
      })()`).catch(() => null);
      h.check("⑫b 重启持久性测试收尾：解除折叠并恢复默认顺序",
        Boolean(afterCleanup && afterCleanup.top && afterCleanup.count === 8 && !afterCleanup.collapsed && afterCleanup.first === "自动化"),
        JSON.stringify(afterCleanup));
    },
  },
  {
    id: "plugin-market-gitee",
    name: "⑲ 插件市场换源（Gitee 官方镜像 / 48 个 Codex 兼容插件 / 分类与文案）",
    run: async (h) => {
      // 为什么断言这一条：10-01 用户发现 SkillHub 插件源几乎全为 DeepSeek Harness（DSH）生态
      // 装不上，令换国内兼容源。新源 = Gitee 上的 Claude Code 官方插件市场镜像（48 个，
      // 100% .claude-plugin 兼容）。安装链路已在换源时用真实下载探针验证（10/10 文件成功）。
      // ① 市场清单真拉到：走真实 IPC（Gitee API），条目 ≥40 且全部带 pluginPath（=兼容）
      const list = await h.eval(`window.codex.listMarketPlugins({ page: 1, pageSize: 30 }).then((r) => ({
        total: r.total, first: r.items[0] ? { name: r.items[0].name, path: r.items[0].pluginPath, src: r.items[0].source } : null,
      })).catch((e) => ({ error: String(e) }))`);
      h.check("① 市场清单真拉到（Gitee 源 ≥40 个插件）",
        (list?.total ?? 0) >= 40 && list?.first?.path, JSON.stringify(list).slice(0, 140));
      // ② 条目指向 Gitee 镜像源（不再是 SkillHub / DSH）
      h.check("② 条目标注 Gitee 官方镜像且带兼容插件路径",
        list?.first?.src === "Gitee 官方镜像" && String(list?.first?.path ?? "").startsWith("plugins/"), JSON.stringify(list?.first));
      // ③ UI：打开插件设置页，市场标题换源文案 + 无 DSH 报错文案残留
      await h.eval(`(function(){ document.querySelector('.sidebar-settings')?.click(); return 1; })()`);
      await wait(1400);
      const nav = await h.eval(`(function(){ const items=[...document.querySelectorAll('.settings-nav button')];
        const i=items.findIndex((b)=>(b.textContent||'').trim()==='插件'); if(i>=0) items[i].click(); return i; })()`);
      await wait(1600);
      const ui = await h.eval(`(function(){
        const t=document.querySelector('.settings-modal')?.innerText||'';
        return { hasSource: t.includes('Gitee 官方镜像') || t.includes('Codex 官方'), noSkillhub: !t.includes('skillhub.cn/plugins'),
          cards: document.querySelectorAll('.plugin-market-card, .settings-modal [class*=market] [class*=card]').length }; })()`);
      h.check("③ 插件页市场源文案在位（Gitee / Codex 官方均可）+ 无 skillhub 残留",
        nav >= 0 && ui?.hasSource && ui?.noSkillhub, JSON.stringify(ui).slice(0, 120));
    },
  },
  {
    id: "voice-ball-reactions",
    name: "🫧 悬浮球互动：眼睛跟鼠标 + 打字弹迷你键盘（10-26）",
    run: async (h) => {
      await h.waitFor(`!!document.querySelector(".voice-ball")`, { label: "悬浮球", timeoutMs: 12000 });
      /* 首帧/设置读取有先后：监听可能比球晚一拍，允许多推几次指针（真实产品里鼠标本来就会持续移动）。 */
      let gaze = { x: 0, y: 0 };
      for (let i = 0; i < 8 && gaze.x === 0 && gaze.y === 0; i++) {
        await h.eval(`(function(){
          const r=document.querySelector(".voice-ball").getBoundingClientRect();
          window.dispatchEvent(new PointerEvent("pointermove",{clientX:r.left+r.width*0.15,clientY:r.top+r.height*0.15,bubbles:true}));
          return 1;
        })()`);
        await wait(300);
        gaze = await h.eval(`(function(){ const b=document.querySelector(".voice-ball");
          return { x:parseFloat(b.style.getPropertyValue("--bot-gaze-x"))||0, y:parseFloat(b.style.getPropertyValue("--bot-gaze-y"))||0 }; })()`);
      }
      h.check("① 指针在左上时眼球往左上偏（真读 CSS 变量，不是只看类名）",
        gaze.x < -1 && gaze.y < -1, JSON.stringify(gaze));

      await h.eval(`(function(){
        const r=document.querySelector(".voice-ball").getBoundingClientRect();
        window.dispatchEvent(new PointerEvent("pointermove",{clientX:r.left+r.width*0.85,clientY:r.top+r.height*0.85,bubbles:true}));
        return 1;
      })()`);
      await wait(40);
      const pupil = await h.eval(`parseFloat(document.querySelector(".voice-ball").style.getPropertyValue("--bot-eye-scale"))||1`);
      h.check("② 鼠标快速划过 → 瞳孔按速度放大(>1.03)", pupil > 1.03, JSON.stringify({ pupil }));
      let pupilBack = pupil;
      for (let i = 0; i < 8 && pupilBack > 1.01; i++) {
        await wait(350);
        pupilBack = await h.eval(`parseFloat(document.querySelector(".voice-ball").style.getPropertyValue("--bot-eye-scale"))||1`);
      }
      h.check("③ 停手后瞳孔回落到 1x", pupilBack <= 1.01, JSON.stringify({ pupilBack }));

      const typed = await h.eval(`(function(){
        const ed=document.querySelector(".composer-editor"); if(!ed) return 0;
        ed.focus();
        ed.dispatchEvent(new KeyboardEvent("keydown",{key:"a",bubbles:true}));
        return 1;
      })()`);
      await wait(220);
      const keyboard = await h.eval(`({
        kb: !!document.querySelector(".voice-ball-keyboard"),
        rows: document.querySelectorAll(".voice-keyboard-row").length,
        keys: document.querySelectorAll(".voice-keyboard-key").length,
        hint: !!document.querySelector(".voice-hint-bubble"),
      })`);
      h.check("④ 输入框敲字 → 球上方弹出 3 排迷你键盘，提示气泡让位",
        typed === 1 && keyboard.kb && keyboard.rows === 3 && keyboard.keys === 16 && !keyboard.hint,
        JSON.stringify(keyboard));

      await wait(2200);
      const closed = await h.eval(`!document.querySelector(".voice-ball-keyboard")`);
      h.check("⑤ 停手 1.1 秒后键盘自动收起（含后台节流余量）", closed, JSON.stringify({ closed }));
    },
  },
  {
    id: "voice-ball-task",
    name: "🎯 悬浮球任务姿态 + 安静陪伴（10-29）",
    run: async (h) => {
      await h.waitFor(`!!document.querySelector(".voice-ball")`, { label: "悬浮球", timeoutMs: 12000 });
      const base = await h.eval(`(function(){ const b=document.querySelector(".voice-ball");
        return { task:b.getAttribute("data-task"), quiet:b.getAttribute("data-quiet") }; })()`).catch(() => null);
      h.check("① 球挂任务姿态（data-task 存在，初始 idle）+ 安静标志位",
        Boolean(base && base.task !== null && base.quiet !== null), JSON.stringify(base));

      /* 右键菜单里有「安静陪伴」，点了立刻生效（data-quiet + 落盘）。 */
      await h.eval(`(function(){ const b=document.querySelector(".voice-ball");
        b.dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true})); return 1; })()`);
      await h.waitFor(`!!document.querySelector(".voice-ball-menu")`, { label: "球菜单", timeoutMs: 5000 }).catch(() => undefined);
      const menu = await h.eval(`(function(){ const m=document.querySelector(".voice-ball-menu"); if(!m) return null;
        const btn=[...m.querySelectorAll("button")].find(x=>(x.textContent||"").includes("安静陪伴"));
        if(!btn) return { has:false };
        btn.click(); return { has:true, clicked:true }; })()`).catch(() => null);
      await wait(600);
      const after = await h.eval(`(async function(){ const b=document.querySelector(".voice-ball");
        const s=await window.codex.voiceSettingsGet(); return { quietAttr:b.getAttribute("data-quiet"), saved:s?.settings?.ball?.quiet === true }; })()`).catch(() => null);
      h.check("② 菜单「安静陪伴」一键生效（data-quiet=1 + voice-settings 落盘 true）",
        Boolean(menu && menu.has && menu.clicked && after && after.quietAttr === "1" && after.saved), JSON.stringify({ menu, after }));

      /* 恢复：再从设置页关掉，验证同一字段双向同步。 */
      await h.eval(`(function(){ document.querySelector(".sidebar-settings")?.click(); return 1; })()`);
      await h.waitFor(`!!document.querySelector(".settings-modal")`, { label: "设置面板", timeoutMs: 8000 });
      await h.eval(`(function(){ const b=[...document.querySelectorAll(".settings-nav button")].find(x=>(x.textContent||"").trim()==="语音通话"); b?.click(); return 1; })()`);
      await wait(1200);
      const toggled = await h.eval(`(function(){
        const label=[...document.querySelectorAll(".voice-card label")].find(x=>(x.textContent||"").includes("安静陪伴"));
        if(!label) return null; const input=label.querySelector("input");
        if(!input || !input.checked) return { found:!!label, checked:input?input.checked:null };
        input.click(); return { found:true, clicked:true }; })()`).catch(() => null);
      await wait(900);
      const restored = await h.eval(`(async function(){ const s=await window.codex.voiceSettingsGet();
        const b=document.querySelector(".voice-ball"); return { saved:s?.settings?.ball?.quiet === true, attr:b?b.getAttribute("data-quiet"):null }; })()`).catch(() => null);
      h.check("③ 设置页同一开关可关（quiet 回 false，球回 data-quiet=0）",
        Boolean(toggled && toggled.clicked && restored && restored.saved === false && restored.attr === "0"),
        JSON.stringify({ toggled, restored }));
    },
  },
  {
    id: "dev-port",
    name: "🌐 本机测试端口：命令输出出现 localhost:端口 ⇒ 自动展开右栏浏览器（10-29）",
    run: async (h) => {
      await h.waitFor(`!!document.querySelector(".voice-ball")`, { label: "悬浮球挂载", timeoutMs: 30000 });
      await h.eval(`(function(){
        window.dispatchEvent(new CustomEvent("dev-port:open", { detail: { url: "http://127.0.0.1:4173/preview" } }));
        return 1; })()`);
      await wait(1500);
      const probe = await h.eval(`(function(){
        const wv=document.querySelector(".browser-pane-webview");
        const dock=document.querySelector(".context-panel");
        return { src: wv ? String(wv.src || "") : "", width: dock ? Math.round(dock.getBoundingClientRect().width) : 0 };
      })()`).catch(() => null);
      h.check("① 端口事件 ⇒ 右栏浏览器自动打开该地址",
        Boolean(probe && probe.src.includes("127.0.0.1:4173")), JSON.stringify(probe));
      h.check("② 右栏自动加宽到 ≥360", Boolean(probe && probe.width >= 360), String(probe && probe.width));
      const tabsBefore = await h.eval(`document.querySelectorAll(".browser-pane-tabs .browser-pane-tab").length`).catch(() => 0);
      await h.eval(`(function(){ window.dispatchEvent(new CustomEvent("dev-port:open", { detail: { url: "http://127.0.0.1:4173/preview" } })); return 1; })()`);
      await wait(800);
      const tabsAfter = await h.eval(`document.querySelectorAll(".browser-pane-tabs .browser-pane-tab").length`).catch(() => 0);
      h.check("③ 同一 URL 去重（不重复开标签）", tabsAfter === tabsBefore && tabsBefore > 0, `${tabsBefore}→${tabsAfter}`);
    },
  },
  {
    id: "sidebar-adaptive",
    name: "🧱 侧栏「功能入口」改为右侧浮层，不占纵向空间（10-26）",
    run: async (h) => {
      /* 10-26 用户：「向右边展示会不会更好，这样不占用上下空间」。
         侧栏只留一行「功能入口」，入口组 portal 到 body 停在侧栏右缘：
         ① 默认不弹；② 点开后不改变会话列表高度；③ 始终落在视口内；④ Esc 收起。 */
      await h.eval(`window.codex.saveAppSettings({functionMenu:{location:"bottom"}})`).catch(() => undefined);
      await wait(500);
      await h.reload({ waitMs: 2200 });
      await wait(1800);
      await h.waitFor(`!!document.querySelector(".app-shell")`, { label: "界面就绪", timeoutMs: 30000 });
      await wait(800);
      await h.pressKey("Escape").catch(() => undefined);
      await wait(250);

      const geo = () => h.eval(`(function(){
        const r=(sel)=>{const e=document.querySelector(sel); if(!e)return null; const b=e.getBoundingClientRect(); return {left:b.left,right:b.right,top:b.top,bottom:b.bottom,w:b.width,h:b.height};};
        return {win:{w:innerWidth,h:innerHeight}, sidebar:r(".sidebar"), list:r(".thread-list"), toggle:r(".sidebar-options-toggle"), account:r(".account-row"),
          flyout:r(".sidebar-options-flyout"), rows:document.querySelectorAll(".sidebar-options-flyout .sidebar-cap-row").length,
          top:!!document.querySelector(".sidebar-options-top")};
      })()`);

      const closed = await geo();
      h.check("① 默认收起：功能入口只占侧栏一行，列表拿到全部剩余高度",
        Boolean(closed && !closed.top && !closed.flyout && closed.list && closed.list.h > 320),
        JSON.stringify({ flyout: closed?.flyout, listH: closed?.list?.h }));

      await h.eval(`document.querySelector(".sidebar-options-toggle")?.click()`);
      await wait(350);
      const opened = await geo();
      const flyout = opened?.flyout;
      h.check("② 点开后浮层在侧栏右侧，且不与列表抢占纵向空间",
        Boolean(flyout && opened.sidebar && flyout.left >= opened.sidebar.right - 1
          && Math.abs((opened.list?.h ?? 0) - (closed.list?.h ?? 0)) <= 1
          && flyout.w >= 200 && opened.rows >= 5),
        JSON.stringify({ left: flyout?.left, sidebarRight: opened?.sidebar?.right, listH: opened?.list?.h, closedListH: closed?.list?.h, rows: opened?.rows }));
      h.check("③ 浮层完整落在视口内",
        Boolean(flyout && flyout.top >= 0 && flyout.bottom <= (opened?.win?.h ?? 0) + 1),
        JSON.stringify({ top: flyout?.top, bottom: flyout?.bottom, winH: opened?.win?.h }));

      await h.pressKey("Escape");
      await wait(250);
      const afterEsc = await geo();
      h.check("④ Esc 收起浮层，侧栏恢复一行", !afterEsc?.flyout, JSON.stringify({ flyout: afterEsc?.flyout }));

      await h._send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 620, deviceScaleFactor: 1, mobile: false });
      await wait(600);
      await h.eval(`document.querySelector(".sidebar-options-toggle")?.click()`);
      await wait(350);
      const short = await geo();
      h.check("⑤ 620 高：列表仍 >200px，浮层不被裁出视口",
        Boolean(short?.flyout && (short.list?.h ?? 0) > 200 && short.flyout.top >= 0
          && short.flyout.bottom <= (short.win?.h ?? 0) + 1 && short.account && short.account.bottom <= (short.win?.h ?? 0) + 1),
        JSON.stringify({ listH: short?.list?.h, flyout: short?.flyout, winH: short?.win?.h, accountBottom: short?.account?.bottom }));
      await h.pressKey("Escape").catch(() => undefined);
      await h._send("Emulation.clearDeviceMetricsOverride");
      await wait(300);

      /* 10-26 用户实测「功能都点不动」：曾用 onClickCapture 先关浮层 ⇒ 按钮在 click 前被卸载。
         这里真点一次具体入口 + 一次「更多 → 编辑菜单」，确保动作真的触发。 */
      await h.eval(`document.querySelector(".sidebar-options-toggle")?.click()`);
      await wait(300);
      const rowClicked = await h.eval(`(function(){
        const b=document.querySelector(".sidebar-options-flyout .sidebar-cap-row:not(.function-menu-more)");
        if(!b) return 0; b.click(); return 1;
      })()`);
      await wait(500);
      const afterRow = await h.eval(`({ flyout: !!document.querySelector(".sidebar-options-flyout"), settings: !!document.querySelector(".settings-modal") })`);
      h.check("⑥ 点具体入口：浮层收起，且目标页真的打开（不是只关浮层）",
        rowClicked === 1 && !afterRow.flyout && afterRow.settings, JSON.stringify(afterRow));
      await h.pressKey("Escape").catch(() => undefined);
      await wait(350);

      await h.eval(`document.querySelector(".sidebar-options-toggle")?.click()`);
      await wait(300);
      await h.eval(`document.querySelector(".sidebar-options-flyout .function-menu-more")?.click()`);
      await wait(300);
      const moreOpened = await h.eval(`!!document.querySelector(".function-menu-popover")`);
      const moreClicked = await h.eval(`(function(){
        const b=[...document.querySelectorAll(".function-menu-popover-item")].find((x)=>x.textContent.includes("编辑菜单"));
        if(!b) return 0; b.click(); return 1;
      })()`);
      await wait(500);
      const afterMore = await h.eval(`({ flyout: !!document.querySelector(".sidebar-options-flyout"), editor: !!document.querySelector(".function-menu-editor") })`);
      h.check("⑦ 「更多 → 编辑菜单」可点：弹层不被浮层卸载，编辑弹窗打开",
        moreOpened && moreClicked === 1 && !afterMore.flyout && afterMore.editor, JSON.stringify({ moreOpened, moreClicked, ...afterMore }));
      await h.eval(`document.querySelector(".fm-editor-foot button:last-child")?.click()`).catch(() => undefined);
      await wait(250);
    },
  },
  {
    id: "file-preview-controls",
    name: "🗂 右栏文件预览：拖动分栏 + 向上拉满（按钮 / Alt+↑↓）",
    run: async (h) => {
      /* 10-26 用户：「右边加一下，上下可以…展示，下面也可以往上展示的功能和对应按键」。 */
      await h.eval(`localStorage.setItem("right-panel-open","true")`).catch(() => undefined);
      await h.reload({ waitMs: 2200 });
      await wait(1600);
      await h.waitFor(`!!document.querySelector(".app-shell")`, { label: "界面就绪", timeoutMs: 30000 });
      await wait(700);
      await h.eval(`(function(){const b=[...document.querySelectorAll(".panel-tab")].find((x)=>(x.textContent||"").includes("文件")); if(b)b.click(); return !!b})()`);
      await h.waitFor(`document.querySelectorAll(".tree-entry").length > 0`, { label: "文件树", timeoutMs: 15000 });
      await wait(500);

      const pick = await h.eval(`(function(){
        const rows=[...document.querySelectorAll(".tree-entry")].filter((x)=>!x.querySelector(".tree-chevron"));
        const b=rows.find((x)=>(x.getAttribute("data-tree-path")||"").endsWith("package.json"))||rows.find((x)=>(x.getAttribute("data-tree-path")||"").match(/\\.[a-z0-9]{1,5}$/i));
        if(!b) return 0; b.click(); return 1;
      })()`);
      await h.waitFor(`(document.querySelector(".workspace-file-preview-path")?.textContent||"").trim().length > 0`, { label: "文件预览路径", timeoutMs: 8000 }).catch(() => undefined);
      await wait(600);

      const geo = () => h.eval(`(function(){
        const t=document.querySelector(".workspace-files-tree")?.getBoundingClientRect();
        const p=document.querySelector(".workspace-file-preview")?.getBoundingClientRect();
        return { treeH:t?Math.round(t.height):0, previewH:p?Math.round(p.height):0,
          splitter:!!document.querySelector(".workspace-files-splitter"),
          expanded:!!document.querySelector(".workspace-files.is-preview-expanded"),
          path:(document.querySelector(".workspace-file-preview-path")?.textContent||"").trim(),
          body:!!document.querySelector(".workspace-file-preview-body") };
      })()`);

      const base = await geo();
      h.check("① 文件树与预览上下分栏，分栏条在位且预览已加载文件",
        pick === 1 && Boolean(base.splitter) && base.treeH > 120 && base.previewH > 120 && base.body && base.path,
        JSON.stringify(base));

      await h.eval(`document.querySelector(".workspace-file-preview-expand")?.click()`);
      await wait(400);
      const expanded = await geo();
      h.check("② 点「展开」：文件树完全收起（无残条）、预览向上拉满",
        expanded.expanded && expanded.treeH < 2 && expanded.previewH > base.previewH + 100,
        JSON.stringify(expanded));

      await h.eval(`document.querySelector(".workspace-file-preview-expand")?.click()`);
      await wait(400);
      const restored = await geo();
      h.check("③ 点「恢复」：分栏回到原来的高度",
        !restored.expanded && Math.abs(restored.treeH - base.treeH) <= 4 && Math.abs(restored.previewH - base.previewH) <= 4,
        JSON.stringify(restored));

      await h.eval(`window.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowUp",altKey:true,bubbles:true}))`);
      await wait(350);
      const altUp = await geo();
      await h.eval(`window.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",altKey:true,bubbles:true}))`);
      await wait(350);
      const altDown = await geo();
      h.check("④ Alt+↑ 拉满 / Alt+↓ 恢复（按键与按钮同效）",
        altUp.expanded && !altDown.expanded, JSON.stringify({ altUp, altDown }));
    },
  },
  {
    id: "skill-packs",
    name: "📦 开发工具 · 精选技能包：3 行带许可/配套说明，面板只在二级弹窗（10-30）",
    run: async (h) => {
      /* 只验 UI 与清单贯通（真下载 37MB 不适合放进秒级验收）：卡片、许可徽标、配套工具行，
         以及「面板只在二级弹窗里」这条两级 IA 纪律。 */
      await h.eval(`(function(){ document.querySelector(".sidebar-settings")?.click(); return 1; })()`);
      await h.waitFor(`!!document.querySelector(".settings-modal")`, { label: "设置面板", timeoutMs: 8000 });
      await wait(600);
      await h.eval(`(function(){ const b=[...document.querySelectorAll(".settings-nav button")].find(function(x){ return (x.textContent||"").trim()==="开发工具"; }); if(!b) return 0; b.click(); return 1; })()`);
      await wait(900);
      const cardHit = await h.eval(`(function(){
        const c=document.querySelector('.devtools-card[data-card="skill-packs"]');
        if(!c) return null;
        return { text:(c.textContent||"").trim(), stat:(c.querySelector(".devtools-card-stat")?.textContent||"").trim() };
      })()`).catch(() => null);
      h.check("① 一级卡片在位且带状态（未安装 / 已装 n / 读取中）",
        Boolean(cardHit && cardHit.text.includes("精选技能包") && cardHit.stat.length > 0), JSON.stringify(cardHit));
      const firstLevelPanel = await h.eval(`!!document.querySelector(".devtools-cards .skill-pack-row")`).catch(() => true);
      h.check("② 面板没有内嵌在一级页（两级 IA）", firstLevelPanel === false, String(firstLevelPanel));
      await h.eval(`document.querySelector('.devtools-card[data-card="skill-packs"]').click()`);
      await h.waitFor(`document.querySelectorAll(".settings-dialog .skill-pack-row").length === 3`, { label: "三个技能包卡", timeoutMs: 20000 });
      const packs = await h.eval(`[...document.querySelectorAll(".settings-dialog .skill-pack-row")].map(function(c){
        return { id:c.dataset.pack||"", name:(c.querySelector(".skill-pack-line1 strong")?.textContent||"").trim(),
          badge:((c.querySelector(".skill-pack-line3")?.textContent||"").match(/MIT|CC BY[^·]*/)||[""])[0].trim(),
          companion:(c.querySelector(".skill-pack-line3")?.textContent||"").trim(),
          button:(c.querySelector("button.primary-setting,button.secondary-setting")?.textContent||"").trim() };
      })`).catch(() => null);
      h.check("③ 三张卡各有：名称 / 许可徽标 / 配套工具行 / 动作按钮",
        Array.isArray(packs) && packs.length === 3 && packs.every((p) => p.name && p.badge && p.companion.startsWith("配套") && p.button),
        JSON.stringify(packs));
      h.check("④ 清单来自主进程且三条 id 各不相同",
        Array.isArray(packs) && new Set(packs.map((p) => p.id)).size === 3, JSON.stringify(packs && packs.map((p) => p.id)));
      await h.eval(`document.querySelector(".settings-dialog-close")?.click()`);
      await wait(300);
    },
  },
    {
    id: "devtools-categories",
    name: "🧰 开发工具 · 工具分类：外面只有分类卡，明细进二级弹窗（11-01）",
    run: async (h) => {
      /* 11-01 用户令：「把工具分类，外面只展示分类名字，二级弹窗预览内容，预览里手动下载，
         外面卡片一键安装」。这里只验**界面层级**与接线（真下载几 GB 不进秒级验收；
         安装/取消/进度的结构由守卫 04/11y 钉）。 */
      await h.eval(`(function(){ document.querySelector(".sidebar-settings")?.click(); return 1; })()`);
      await h.waitFor(`!!document.querySelector(".settings-modal")`, { label: "设置面板", timeoutMs: 8000 });
      await wait(600);
      await h.eval(`(function(){ const b=[...document.querySelectorAll(".settings-nav button")].find(function(x){ return (x.textContent||"").trim()==="开发工具"; }); if(!b) return 0; b.click(); return 1; })()`);
      await h.waitFor(`!!document.querySelector('.devtools-card[data-card="tools-devchain"]')`, { label: "工具分类卡", timeoutMs: 15000 });
      await wait(400);
      const level1 = await h.eval(`(function(){
        const grid=document.querySelectorAll(".devtools-cards")[0];
        if(!grid) return null;
        const cards=[...grid.querySelectorAll(".devtools-card")];
        return {
          keys: cards.map(function(c){ return c.dataset.card||""; }),
          opens: cards.filter(function(c){ return !!c.querySelector(".devtools-card-open"); }).length,
          stats: cards.map(function(c){ return (c.querySelector(".devtools-card-stat")?.textContent||"").trim(); }),
          rows: document.querySelectorAll(".devtools-cards .devtools-tool-row").length,
        };
      })()`).catch(() => null);
      const toolKeys = ["tools-base","tools-auto","tools-devchain","tools-media","tools-ai","tools-system","tools-ondemand","tools-health"];
      h.check("① 一级页 = 8 张工具分类卡（7 类 + 自检），每张都有打开按钮",
        Boolean(level1) && toolKeys.every((k) => level1.keys.includes(k)) && level1.opens === level1.keys.length,
        JSON.stringify(level1 && { keys: level1.keys, opens: level1.opens }));
      h.check("② 一级页不出现工具明细行（明细只在二级弹窗 —— 两级 IA）",
        Boolean(level1) && level1.rows === 0, JSON.stringify(level1 && { rows: level1.rows }));
      h.check("③ 每张分类卡都显示当前就绪数（不是空壳）",
        Boolean(level1) && level1.stats.length >= toolKeys.length && level1.stats.every((s) => s.length > 0),
        JSON.stringify(level1 && level1.stats));

      await h.eval(`document.querySelector('.devtools-card[data-card="tools-devchain"]').querySelector(".devtools-card-open").click()`);
      await h.waitFor(`!!document.querySelector(".settings-dialog .devtools-tool-row")`, { label: "分类弹窗工具行", timeoutMs: 10000 });
      await wait(300);
      const dialog = await h.eval(`(function(){
        const d=document.querySelector(".settings-dialog");
        if(!d) return null;
        const rows=[...d.querySelectorAll(".devtools-tool-row")];
        return {
          title:(d.querySelector(".settings-dialog-heading strong")?.textContent||"").trim(),
          ids:rows.map(function(r){ return r.dataset.runtime||""; }),
          actions:rows.map(function(r){ return (r.querySelector(".runtime-actions")?.textContent||"").trim(); }),
          progressCss:!!(document.querySelector("style")||true),
        };
      })()`).catch(() => null);
      const devchain = ["pwsh","git","conda","mingw"];
      h.check("④ 点分类卡打开二级弹窗，标题 = 分类名",
        Boolean(dialog) && dialog.title === "开发工具链", JSON.stringify(dialog && dialog.title));
      h.check("⑤ 弹窗只列该分类的工具（开发工具链 4 项；没有别的分类混进来）",
        Boolean(dialog) && dialog.ids.length > 0 && dialog.ids.every((id) => devchain.includes(id)),
        JSON.stringify(dialog && dialog.ids));
      h.check("⑥ 每行都有手动动作（下载 / 修复 / 已安装 / 内置 / 卸载）",
        Boolean(dialog) && dialog.actions.length === dialog.ids.length && dialog.actions.every((a) => a.length > 0),
        JSON.stringify(dialog && dialog.actions));
      await h.eval(`document.querySelector(".settings-dialog-close")?.click()`);
      await wait(300);

      const cardHasAction = await h.eval(`(function(){
        const cards=[...document.querySelectorAll(".devtools-cards")[0].querySelectorAll(".devtools-card")];
        const stats=cards.map(function(c){ return (c.querySelector(".devtools-card-stat")?.textContent||"").trim(); });
        const allReady=stats.length>0 && stats.every(function(s){
          const m=/已就绪 (\\d+) \\/ (\\d+) 项/.exec(s);
          return !m || m[1]===m[2];
        });
        return {
          installs: cards.filter(function(c){ return !!c.querySelector(".devtools-card-install"); }).length,
          allReady: allReady,
          stats: stats,
        };
      })()`).catch(() => null);
      h.check("⑦ 有可下载项的分类卡底部出现「一键安装」（全都就绪时不出现按钮）",
        Boolean(cardHasAction) && (cardHasAction.installs > 0 || cardHasAction.allReady),
        JSON.stringify(cardHasAction));

      /* ⛔ 11-01 用户实测「一键卸载也没有」：分类卡上也要有「一键卸载」，且点了先出确认弹窗（不许直删）。 */
      const uninstallBtns = await h.eval(`document.querySelectorAll(".devtools-cards .devtools-card-uninstall").length`).catch(() => 0);
      h.check("⑦b 分类卡也有一键卸载", uninstallBtns > 0, String(uninstallBtns));
      if (uninstallBtns > 0) {
        await h.eval(`document.querySelector(".devtools-cards .devtools-card-uninstall").click()`);
        await h.waitFor(`!!document.querySelector(".settings-dialog .runtime-uninstall")`, { label: "一键卸载确认弹窗", timeoutMs: 8000 });
        const confirm = await h.eval(`(function(){
          const d=document.querySelector(".settings-dialog");
          return { title:(d.querySelector(".settings-dialog-heading strong")?.textContent||"").trim(),
            body:(d.querySelector(".settings-dialog-body")?.textContent||"").trim(),
            confirm:(d.querySelector(".runtime-uninstall")?.textContent||"").trim() };
        })()`).catch(() => null);
        h.check("⑦c 点一键卸载先出确认弹窗（列出将删的工具，确认前不执行）",
          Boolean(confirm) && confirm.title.includes("一键卸载") && confirm.body.includes("不可恢复") && confirm.confirm.includes("确认卸载"),
          JSON.stringify(confirm && { title: confirm.title, confirm: confirm.confirm }));
        /* 只关掉确认弹窗，**不执行**卸载（验收不删用户环境里的工具）。 */
        await h.eval(`(function(){
          const d=document.querySelector(".settings-dialog");
          const cancelBtn=[...d.querySelectorAll("button")].find(function(b){ return (b.textContent||"").trim()==="取消"; });
          cancelBtn&&cancelBtn.click(); return 1;
        })()`);
        await wait(250);
      }

      await h.eval(`document.querySelector('.devtools-card[data-card="tools-health"]').querySelector(".devtools-card-open").click()`);
      await h.waitFor(`!!document.querySelector(".settings-dialog .runtime-check")`, { label: "工具自检弹窗", timeoutMs: 8000 });
      const health = await h.eval(`(function(){
        const d=document.querySelector(".settings-dialog");
        return { title:(d.querySelector(".settings-dialog-heading strong")?.textContent||"").trim(),
          check:(d.querySelector(".runtime-check")?.textContent||"").trim(),
          manifest:!!d.querySelector(".devtools-manifest") };
      })()`).catch(() => null);
      h.check("⑧ 工具自检与清单独立成卡：弹窗里有「检查工具」与可复制的清单",
        Boolean(health) && health.title === "工具自检与清单" && health.check.includes("检查工具") && health.manifest,
        JSON.stringify(health));
      await h.eval(`document.querySelector(".settings-dialog-close")?.click()`);
      await wait(300);
    },
  },
{
    id: "skill-update-panel",
    name: "🔄 控制台 · 技能自动更新：能进入面板、能装能卸、有反馈（10-30）",
    run: async (h) => {
      /* 只验入口与面板结构（检查更新要打市场接口，不放进秒级验收；更新链路由 12j 守卫钉）。 */
      await h.eval(`(function(){ document.querySelector(".sidebar-settings")?.click(); return 1; })()`);
      await h.waitFor(`!!document.querySelector(".settings-modal")`, { label: "设置面板", timeoutMs: 8000 });
      await wait(600);
      const navTo = async (label) => h.eval(`(function(){ const b=[...document.querySelectorAll(".settings-nav button")].find(function(x){ return (x.textContent||"").trim()===${JSON.stringify(label)}; }); if(!b) return 0; b.click(); return 1; })()`);
      await navTo("控制台");
      // 开关行要等 autoUpdate:status（内部最多 2.5s 扫描）回来才渲染
      await h.waitFor(`[...document.querySelectorAll(".card-auto-update button")].some(function(b){ return (b.textContent||"").trim()==="技能更新…"; })`, { label: "技能更新入口", timeoutMs: 20000 });
      await wait(300);
      const entry = await h.eval(`(function(){
        const card=document.querySelector(".card-auto-update");
        if(!card) return null;
        const btn=[...card.querySelectorAll("button")].find(function(b){ return (b.textContent||"").trim()==="技能更新…"; });
        const page=[...card.querySelectorAll("button")].find(function(b){ return (b.textContent||"").trim()==="技能页"; });
        const sw=card.querySelector(".settings-toggle-row");
        return { hasUpdate:!!btn, hasPage:!!page, hasSwitch:(sw?.textContent||"").includes("技能自动更新") };
      })()`).catch(() => null);
      h.check("① 技能行有「技能更新…」「技能页」两个出口 + 原来的开关还在",
        Boolean(entry && entry.hasUpdate && entry.hasPage && entry.hasSwitch), JSON.stringify(entry));
      await h.eval(`(function(){ const b=[...document.querySelectorAll(".card-auto-update button")].find(function(x){ return (x.textContent||"").trim()==="技能更新…"; }); b&&b.click(); return !!b; })()`);
      await h.waitFor(`!!document.querySelector(".settings-dialog .skill-update-panel")`, { label: "技能更新面板", timeoutMs: 8000 });
      await wait(400);
      const panel = await h.eval(`(function(){
        const p=document.querySelector(".settings-dialog .skill-update-panel");
        if(!p) return null;
        const texts=[...p.querySelectorAll("button")].map(function(b){ return (b.textContent||"").trim(); });
        return { texts, log:!!p.querySelector(".skill-update-log"), list:!!p.querySelector(".skill-update-list"), switches:p.querySelectorAll(".settings-toggle-row").length };
      })()`).catch(() => null);
      h.check("② 面板有：检查更新 / 更新全部 / 去技能市场安装",
        Boolean(panel && panel.texts.some((t) => t.includes("检查更新")) && panel.texts.some((t) => t.includes("更新全部")) && panel.texts.some((t) => t.includes("去技能市场安装"))),
        JSON.stringify(panel && panel.texts));
      h.check("③ 面板带安装反馈日志 + 技能行列表，且没有第二个开关",
        Boolean(panel && panel.log && panel.list && panel.switches === 0), JSON.stringify({ log: panel?.log, list: panel?.list, switches: panel?.switches }));
      await h.eval(`document.querySelector(".settings-dialog-close")?.click()`);
      await wait(500);
      await h.eval(`(function(){ const b=[...document.querySelectorAll(".card-auto-update button")].find(function(x){ return (x.textContent||"").trim()==="技能页"; }); b&&b.click(); return !!b; })()`);
      await wait(1200);
      const page = await h.eval(`(document.querySelector(".settings-modal .settings-nav button.active")?.textContent||"").trim()`).catch(() => "");
      h.check("④ 点「技能页」直接进入技能设置页（安装与批量管理在那里）", page === "技能", String(page));
    },
  },
  {
    id: "voice-clone-refresh",
    name: "🎙 语音克隆：模型装好后，下方「我的音色」立即解锁（11-02）",
    run: async (h) => {
      /* 用户实测：模型卡已显示「已就绪」，下面「我的音色」还挂着「还没安装音色克隆模型」、
         radio 全禁用（zipReady 只在挂载时读一次，安装完成事件只刷新了播报引擎）。
         这里走真实链路：页面加载 → 落模型文件 → 点卡片安装（主进程见已就绪直接回 ok）→
         断言下方卡片解锁。模型文件用稀疏文件只满足体积门槛，不下载 156MB。
         ⛔ 只动测试 profile 自己的 voice-models；若已有真模型，不删除，只验「挂载即就绪」。 */
      const modelDir = join(h.userDataDir, "voice-models", "sherpa-onnx-zipvoice-distill-int8-zh-en-emilia");
      const preexisting = existsSync(modelDir);
      if (!preexisting) rmSync(modelDir, { recursive: true, force: true });
      if (!(await h.exists(".settings-modal"))) {
        await h.eval(`document.querySelector(".sidebar-settings")?.click()`);
        await h.waitFor(`!!document.querySelector(".settings-modal")`, { label: "设置面板", timeoutMs: 10000 });
        await wait(500);
      }
      await h.eval(`(function(){ const b=[...document.querySelectorAll(".settings-nav button")].find(function(x){ return (x.textContent||"").trim()==="语音通话"; }); b&&b.click(); return !!b; })()`);
      await h.waitFor(`!!document.querySelector(".voice-settings")`, { label: "语音设置页", timeoutMs: 15000 });
      await wait(1000);
      const readUi = () => h.eval(`(function(){
        const card=[...document.querySelectorAll(".voice-card")].find(function(c){ return (c.innerText||"").includes("我的音色"); });
        const hint=card?(card.querySelector(".voice-card-hint")?.innerText||"").trim():"";
        const radios=[...document.querySelectorAll('input[name="voice-profile"]')];
        const dev=[...document.querySelectorAll(".voice-devtools-card")].find(function(c){ return (c.innerText||"").includes("音色克隆模型"); });
        return { hint:hint, radios:radios.length, disabled:radios.filter(function(r){ return r.disabled; }).length,
          badge:dev?(dev.querySelector(".voice-devtools-badge")?.innerText||"").trim():"" };
      })()`);
      const before = await readUi();
      if (preexisting) {
        h.check("已有模型：进入页面即解锁（提示不含「还没安装」+ radio 可用）",
          Boolean(before && !before.hint.includes("还没安装") && before.disabled === 0), JSON.stringify(before));
        return;
      }
      h.check("① 前置：未装克隆模型时，下方音色卡提示安装且 radio 全禁用",
        Boolean(before && before.hint.includes("还没安装") && before.radios > 0 && before.disabled === before.radios),
        JSON.stringify(before));
      mkdirSync(modelDir, { recursive: true });
      const sparse = (name, bytes) => { const file = join(modelDir, name); writeFileSync(file, ""); truncateSync(file, bytes); };
      sparse("encoder.int8.onnx", 1_000_000);
      sparse("decoder.int8.onnx", 20_000_000);
      writeFileSync(join(modelDir, "tokens.txt"), "x".repeat(300));
      sparse("lexicon.txt", 200_000);
      sparse("vocos_24khz.onnx", 51_400_000);
      try {
        const clicked = await h.eval(`(function(){
          const dev=[...document.querySelectorAll(".voice-devtools-card")].find(function(c){ return (c.innerText||"").includes("音色克隆模型"); });
          const b=dev?[...dev.querySelectorAll("button")].find(function(x){ return (x.innerText||"").includes("下载音色克隆模型"); }):null;
          if(!b) return false; b.click(); return true;
        })()`);
        h.check("② 前置：模型卡仍显示「下载音色克隆模型」按钮（页面状态还是旧的）", clicked === true);
        let after = null;
        for (let i = 0; i < 40; i++) {
          await wait(300);
          after = await readUi();
          if (after && !after.hint.includes("还没安装") && after.disabled === 0) break;
        }
        h.check("③ 安装完成后下方「我的音色」立即解锁（radio 不再禁用、提示消失）",
          Boolean(after && !after.hint.includes("还没安装") && after.disabled === 0), JSON.stringify(after));
      } finally {
        rmSync(modelDir, { recursive: true, force: true });
      }
    },
  },
  {
    id: "wallpaper-mac-motion",
    name: "🌌 壁纸 mac 适配：系统「减少动态效果」下星空/光幕仍动（11-02）",
    run: async (h) => {
      /* 用户反馈「3D 星空没有适配 mac」：全站默认 data-motion=force（无视系统开关），
         但壁纸的 canvas 星空与鼠标视差曾直接读媒体查询 ⇒ mac 开「减少动态效果」时只有壁纸冻住。
         这里用 CDP 模拟系统开关，断言壁纸仍逐帧 + 光幕动画没被静音。 */
      await h.eval(`localStorage.setItem("theme", "obsidian")`);
      await h.eval(`localStorage.setItem("wallpaper", JSON.stringify({ mode: "depth", image: "preset:snow" }))`);
      await h.reload({ waitMs: 2400 });
      await h.waitFor(`!!document.querySelector(".wallpaper-depth")`, { label: "3D 星空画布", timeoutMs: 15000 });
      await wait(700);
      try {
        await h._send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
        await wait(600);
        const meta = await h.eval(`({ motion: document.documentElement.dataset.motion || "", media: matchMedia("(prefers-reduced-motion: reduce)").matches })`);
        h.check("① 系统「减少动态效果」已模拟生效，应用策略仍是 force", meta.motion === "force" && meta.media === true, JSON.stringify(meta));
        const sig = () => h.eval(`(function(){
          const c=document.querySelector(".wallpaper-depth"); if(!c) return "no-canvas";
          const d=c.getContext("2d").getImageData(0,0,c.width,c.height).data;
          let sum=0; for(let i=0;i<d.length;i+=4999) sum=(sum*31+d[i])>>>0;
          return sum;
        })()`);
        const a = await sig();
        await wait(700);
        const b = await sig();
        h.check("② 3D 星空仍在逐帧（两帧像素不一致）", a !== b, `${a} / ${b}`);
        await h.eval(`localStorage.setItem("wallpaper", JSON.stringify({ mode: "aurora", image: "preset:snow" }))`);
        await h.eval(`window.dispatchEvent(new CustomEvent("wallpaper-change"))`);
        await h.waitFor(`!!document.querySelector(".wallpaper-motion")`, { label: "极光光幕", timeoutMs: 8000 });
        await wait(400);
        const anim = await h.eval(`(function(){ const b=document.querySelector(".wallpaper-motion i b"); return b ? getComputedStyle(b).animationName : ""; })()`);
        h.check("③ 极光光幕动画没有被系统开关静音", Boolean(anim) && anim !== "none", String(anim));
      } finally {
        await h._send("Emulation.setEmulatedMedia", { features: [] }).catch(() => undefined);
        await h.eval(`localStorage.setItem("wallpaper", JSON.stringify({ mode: "off", image: "" }))`).catch(() => undefined);
        await h.eval(`localStorage.setItem("theme", "light")`).catch(() => undefined);
        await h.eval(`window.dispatchEvent(new CustomEvent("wallpaper-change"))`).catch(() => undefined);
      }
    },
  },
  {
    id: "office-inspector",
    name: "🏢 办公室：悬停显示器弹放大屏（真实内容卡，11-02）",
    run: async (h) => {
      /* 用内置假团队打开办公室（officeProbe，只读诊断钩子），悬停第一块显示器：
         放大卡应出现并显示该成员；移开自动收起。
         ⛔ 先清掉残留的 officeProbe / 已开的办公室：多个 .office-overlay 同时在场时
            `window.__officeSim` 与首个 `.office-pixel-canvas` 可能来自不同一间（坐标对不上 → target null）。 */
      await h.eval(`localStorage.removeItem("officeProbe")`);
      await h.eval(`(() => { document.querySelectorAll(".office-overlay-close").forEach((b) => b.click()); return true; })()`);
      await wait(500);
      await h.eval(`localStorage.setItem("officeProbe", "1")`);
      await h.reload({ waitMs: 2300 });
      await h.waitFor(`[...document.querySelectorAll(".office-overlay")].some((el) => (el.querySelector(".office-overlay-name")?.textContent || "").includes("诊断用团队"))`, { label: "诊断用办公室浮层", timeoutMs: 20000 });
      await h.waitFor(`!!window.__officeSim && window.__officeSim.agents.length > 0 && !!window.__officeSeats`, { label: "办公室调试句柄与成员", timeoutMs: 12000 });
      await wait(900);
      const target = await h.eval(`(function(){
        const seats=window.__officeSeats, sim=window.__officeSim;
        const overlay=[...document.querySelectorAll(".office-overlay")].find((el) => (el.querySelector(".office-overlay-name")?.textContent || "").includes("诊断用团队"));
        const canvas=overlay && overlay.querySelector(".office-pixel-canvas");
        if(!seats||!sim||!canvas) return null;
        const agent=sim.agents[0]; if(!agent) return null;
        const seat=seats[agent.seatIndex], sc=seat&&seat.screen; if(!sc) return null;
        const r=canvas.getBoundingClientRect();
        return { name: agent.name,
          cx: Math.round(r.left+(seat.x+sc.x+sc.w/2)/960*r.width),
          cy: Math.round(r.top+(seat.y+sc.y+sc.h/2)/640*r.height) };
      })()`);
      h.check("① 找到可悬停的成员显示器", Boolean(target && target.cx), JSON.stringify(target));
      await h.eval(`(function(){
        const canvas=document.querySelector(".office-pixel-canvas");
        canvas && canvas.dispatchEvent(new MouseEvent("mousemove", { clientX: ${Number(target?.cx ?? 0)}, clientY: ${Number(target?.cy ?? 0)}, bubbles: true }));
        return true;
      })()`);
      await wait(450);
      const card = await h.eval(`(function(){
        const el=document.querySelector(".office-inspector");
        if(!el) return null;
        return { title: el.querySelector("strong")?.textContent?.trim() || "",
          mode: el.querySelector(".office-inspector-mode")?.textContent?.trim() || "",
          body: (el.querySelector(".office-inspector-body")?.innerText || "").slice(0, 60) };
      })()`);
      h.check("② 悬停弹出放大屏，标题是当前成员", Boolean(card && card.title && target && card.title === target.name), JSON.stringify(card));
      await h.eval(`(function(){ const canvas=document.querySelector(".office-pixel-canvas"); canvas && canvas.dispatchEvent(new MouseEvent("mouseleave", { bubbles: false })); return true; })()`);
      await wait(900);
      h.check("③ 移开自动收起（600ms 宽限后消失）", await h.eval(`!document.querySelector(".office-inspector")`));
      await h.eval(`document.querySelector(".office-overlay-close")?.click()`);
      await wait(400);
      await h.eval(`localStorage.removeItem("officeProbe")`).catch(() => undefined);
    },
  },
  {
    id: "frontend-design-setting",
    name: "个性化前端设计风格：预设 + 自定义内容真写入 AGENTS.md（保存 / 回读 / 复位）",
    run: async (h) => {
      const marker = "ACCEPTANCE-FRONTEND-DESIGN-6B5CFF";
      await h.eval(`(function(){ document.querySelector(".sidebar-settings")?.click(); return 1; })()`);
      await h.waitFor(`!!document.querySelector(".settings-modal")`, { label: "设置面板", timeoutMs: 8000 });
      await wait(900);
      const nav = (label) => h.eval(`(function(){ const b=[...document.querySelectorAll(".settings-nav button")].find(function(x){ return (x.textContent||"").trim()===${JSON.stringify(label)}; }); if(!b) return 0; b.click(); return 1; })()`);
      await nav("个性化");
      await wait(900);
      /* 联动内置组件库：风格卡里的入口必须真的切到「组件库」页，而不是一个装饰链接。 */
      const libClicked = await h.eval(`(function(){ const b=document.querySelector(".frontend-style-library button"); if(!b) return 0; b.click(); return 1; })()`);
      await wait(700);
      const libPage = await h.eval(`(document.querySelector(".settings-nav button.active")?.textContent||"").trim()`);
      h.check("⓪ 风格卡「打开组件库」真的切到组件库页", Boolean(libClicked) && libPage === "组件库", `${libClicked}/${libPage}`);
      await nav("个性化");
      await wait(700);
      const pick = (label) => h.eval(`(function(){ const b=[...document.querySelectorAll(".card-frontend-design .frontend-style-chip")].find(function(x){ return (x.textContent||"").trim().includes(${JSON.stringify(label)}); }); if(!b) return 0; b.click(); return 1; })()`);
      const stored = () => h.eval(`window.codex.readPersonalization()`);
      const initial = await stored().catch(() => null);
      const ensureToggle = (selector, want) => h.eval(`(function(){ const b=document.querySelector(${JSON.stringify(selector)}); if(!b) return 0; const on=b.getAttribute("aria-checked")==="true"; if(on!==${want}) b.click(); return 1; })()`);
      await ensureToggle(".card-frontend-design .norm-toggle", true);
      await wait(200);
      const waitStored = async (predicate, ms = 20000) => {
        const deadline = Date.now() + ms;
        let last = null;
        while (Date.now() < deadline) {
          last = await stored().catch(() => null);
          if (last && predicate(last)) return last;
          await wait(300);
        }
        return last;
      };

      h.check("① 打开前端设计开关并选中「温暖」+ 填写自定义内容后，保存按钮从禁用变可用",
        await pick("温暖") === 1
          && await h.setInput(".personalization-frontend-notes", `主色用蓝紫色 ${marker}`).then(() => true)
          && await wait(250).then(() => h.eval(`document.querySelector(".personalization-savebar .primary-setting")?.disabled === false`))
          && await h.eval(`document.querySelector(".card-frontend-design .norm-toggle")?.getAttribute("aria-checked") === "true"`),
        "开关/预设/输入/保存态");
      await wait(250);
      const refs = await h.eval(`(function(){
        const perStyle=[...document.querySelectorAll(".frontend-style-refs a")].map((a)=>({ text:(a.textContent||"").trim(), href:a.getAttribute("href")||"" }));
        const materials=[...document.querySelectorAll(".frontend-style-materials a")].map((a)=>({ text:(a.textContent||"").trim(), href:a.getAttribute("href")||"" }));
        const systems=[...document.querySelectorAll(".frontend-style-reference-grid a")].map((a)=>a.getAttribute("href")||"");
        const spec=document.querySelector(".frontend-style-spec pre")?.textContent||"";
        const prompt=document.querySelector(".frontend-style-prompt pre")?.textContent||"";
        return { perStyle, materials, systems, spec, prompt };
      })()`);
      h.check("①b 温暖风带 NutUI / Vant 参考地址；国内设计系统清单 ≥10 条且都是 https",
        Boolean(refs.perStyle.length >= 2
          && refs.perStyle.every((r) => r.href.startsWith("https://"))
          && refs.perStyle.some((r) => /NutUI|Vant/.test(r.text))
          && refs.systems.length >= 10 && refs.systems.every((href) => href.startsWith("https://"))),
        JSON.stringify({ perStyle: refs.perStyle, systems: refs.systems.length }));
      h.check("①c 温暖风有完整设计规范 + 参考素材地址",
        refs.spec.includes("设计规范（温暖）") && refs.spec.includes("动效")
          && refs.materials.length >= 2 && refs.materials.every((m) => m.href.startsWith("https://")),
        JSON.stringify({ spec: refs.spec.slice(0, 40), materials: refs.materials }));
      h.check("①d 将注入的提示词带设计规范 + 参考文档/素材地址",
        refs.prompt.includes("Design specification") && refs.prompt.includes("Reference materials")
          && refs.prompt.includes("nutui.jd.com"), refs.prompt.slice(0, 160));
      await h.screenshot("个性化-前端设计风格");

      await h.click(".personalization-savebar .primary-setting");
      const saved = await waitStored((v) => v.frontendDesignStyle === "warm" && String(v.frontendDesignNotes || "").includes(marker));
      h.check("② 档案真的落盘（warm + 自定义内容）",
        Boolean(saved && saved.frontendDesignStyle === "warm" && String(saved.frontendDesignNotes || "").includes(marker)),
        JSON.stringify(saved));

      const verify = await h.eval(`window.codex.verifyPersonalization()`).catch(() => null);
      const agentsText = verify?.agentsPath && existsSync(verify.agentsPath) ? readFileSync(verify.agentsPath, "utf8") : "";
      h.check("③ AGENTS.md 真包含设计方向与自定义内容（不是只写 personalization.json）",
        Boolean(verify?.inSync) && agentsText.includes("Visual direction — warm") && agentsText.includes(marker),
        JSON.stringify({ inSync: verify?.inSync, path: verify?.agentsPath, hit: agentsText.includes(marker) }));

      /* 复位：恢复到本轮开始前的值（测试 profile 也可能带着用户之前配的风格）。 */
      await h.eval(`window.codex.savePersonalization({ frontendDesignStyle: ${JSON.stringify(initial?.frontendDesignStyle || "auto")}, frontendDesignNotes: ${JSON.stringify(initial?.frontendDesignNotes || "")}, frontendDesignEnabled: ${initial?.frontendDesignEnabled === true} })`);
      const reset = await waitStored((v) => v.frontendDesignStyle === (initial?.frontendDesignStyle || "auto")
        && String(v.frontendDesignNotes || "") === String(initial?.frontendDesignNotes || "")
        && v.frontendDesignEnabled === (initial?.frontendDesignEnabled === true));
      const verify2 = await h.eval(`window.codex.verifyPersonalization()`).catch(() => null);
      const agents2 = verify2?.agentsPath && existsSync(verify2.agentsPath) ? readFileSync(verify2.agentsPath, "utf8") : "";
      h.check("④ 复位后档案与 AGENTS.md 都不再带测试内容",
        Boolean(reset && String(reset.frontendDesignNotes || "") === String(initial?.frontendDesignNotes || ""))
          && !agents2.includes(marker),
        JSON.stringify({ reset, stillInAgents: agents2.includes(marker) }));
    },
  },
  {
    id: "engineering-norms-setting",
    name: "个性化后端开发 / 应用架构规范：启用开关、写入 AGENTS.md、关闭即停止注入、复位",
    run: async (h) => {
      const devMarker = "ACCEPTANCE-BACKEND-NORM-71C2";
      const archMarker = "ACCEPTANCE-ARCH-NORM-93F4";
      await h.eval(`(function(){ document.querySelector(".sidebar-settings")?.click(); return 1; })()`);
      await h.waitFor(`!!document.querySelector(".settings-modal")`, { label: "设置面板", timeoutMs: 8000 });
      await wait(900);
      const nav = (label) => h.eval(`(function(){ const b=[...document.querySelectorAll(".settings-nav button")].find(function(x){ return (x.textContent||"").trim()===${JSON.stringify(label)}; }); if(!b) return 0; b.click(); return 1; })()`);
      await nav("个性化");
      await wait(900);
      const pickNorm = (card, label) => h.eval(`(function(){ const root=document.querySelector('[data-norm-card="${card}"]'); if(!root) return 0; const b=[...root.querySelectorAll(".frontend-style-chip")].find(function(x){ return (x.textContent||"").trim().includes(${JSON.stringify(label)}); }); if(!b) return 0; b.click(); return 1; })()`);
      const ensureToggle = (card, want) => h.eval(`(function(){ const root=document.querySelector('[data-norm-card="${card}"]'); const b=root&&root.querySelector(".norm-toggle"); if(!b) return 0; const on=b.getAttribute("aria-checked")==="true"; if(on!==${want}) b.click(); return 1; })()`);
      const stored = () => h.eval(`window.codex.readPersonalization()`);
      const initial = await stored().catch(() => null);
      const waitStored = async (predicate, ms = 20000) => {
        const deadline = Date.now() + ms;
        let last = null;
        while (Date.now() < deadline) {
          last = await stored().catch(() => null);
          if (last && predicate(last)) return last;
          await wait(300);
        }
        return last;
      };
      const agentsText = async () => {
        const verify = await h.eval(`window.codex.verifyPersonalization()`).catch(() => null);
        return verify?.agentsPath && existsSync(verify.agentsPath) ? readFileSync(verify.agentsPath, "utf8") : "";
      };
      const save = () => h.click(".personalization-savebar .primary-setting");

      h.check("① 两张后端规范卡各 6 档、各有启用开关",
        await h.eval(`(function(){ const dev=document.querySelector('[data-norm-card="software-dev"]'); const arch=document.querySelector('[data-norm-card="app-architecture"]'); return Boolean(dev&&arch&&dev.querySelectorAll(".frontend-style-chip").length===6&&arch.querySelectorAll(".frontend-style-chip").length===6&&dev.querySelector(".norm-toggle")&&arch.querySelector(".norm-toggle")); })()`));

      await ensureToggle("software-dev", false);
      await ensureToggle("app-architecture", false);
      await wait(200);
      h.check("①b 默认关闭：两张卡都显示已关闭，且不写入 AGENTS.md",
        await h.eval(`(function(){ const dev=document.querySelector('[data-norm-card="software-dev"]'); const arch=document.querySelector('[data-norm-card="app-architecture"]'); return Boolean(dev&&arch&&dev.classList.contains("is-off")&&arch.classList.contains("is-off")&&dev.querySelector(".personalization-norm-off")&&arch.querySelector(".personalization-norm-off")); })()`));
      await h.screenshot("个性化-后端规范");

      await ensureToggle("software-dev", true);
      await ensureToggle("app-architecture", true);
      await wait(200);
      await pickNorm("software-dev", "务实稳健");
      await pickNorm("app-architecture", "分层单体");
      await h.setInput('[data-norm-card="software-dev"] textarea', `后端规范 ${devMarker}`);
      await h.setInput('[data-norm-card="app-architecture"] textarea', `架构规范 ${archMarker}`);
      await save();
      const saved = await waitStored((v) => v.softwareDevStyle === "pragmatic" && String(v.softwareDevNotes || "").includes(devMarker)
        && v.softwareDevEnabled === true && v.appArchitectureEnabled === true);
      const agents1 = await agentsText();
      h.check("② 打开两个开关后保存：两套规范都进入 AGENTS.md",
        Boolean(saved && saved.softwareDevEnabled === true && saved.appArchitectureEnabled === true)
          && agents1.includes("Software development norms") && agents1.includes(devMarker)
          && agents1.includes("Application architecture norms") && agents1.includes(archMarker),
        JSON.stringify({ saved, dev: agents1.includes(devMarker), arch: agents1.includes(archMarker) }));

      await ensureToggle("app-architecture", false);
      await wait(250);
      h.check("③ 关闭架构规范后显示「已关闭」提示，配置仍保留",
        await h.eval(`(function(){ const root=document.querySelector('[data-norm-card="app-architecture"]'); return Boolean(root&&root.classList.contains("is-off")&&root.querySelector(".personalization-norm-off")&&root.querySelector("textarea")?.value.includes(${JSON.stringify(archMarker)})); })()`));
      await save();
      const archOff = await waitStored((v) => v.appArchitectureEnabled === false);
      const agents2 = await agentsText();
      h.check("④ 关闭架构规范并保存：只停止注入，后端规范不受影响",
        Boolean(archOff && archOff.appArchitectureEnabled === false && String(archOff.appArchitectureNotes || "").includes(archMarker))
          && agents2.includes("Software development norms") && agents2.includes(devMarker)
          && !agents2.includes("Application architecture norms") && !agents2.includes(archMarker),
        JSON.stringify({ archOff, dev: agents2.includes(devMarker), arch: agents2.includes(archMarker) }));

      await ensureToggle("app-architecture", true);
      await wait(250);
      await save();
      const reopened = await waitStored((v) => v.appArchitectureEnabled === true);
      const agents3 = await agentsText();
      h.check("⑤ 重新打开架构规范并保存：两套规范都进入 AGENTS.md",
        Boolean(reopened && reopened.appArchitectureEnabled === true)
          && agents3.includes("Software development norms") && agents3.includes(devMarker)
          && agents3.includes("Application architecture norms") && agents3.includes(archMarker),
        JSON.stringify({ reopened, dev: agents3.includes(devMarker), arch: agents3.includes(archMarker) }));

      await ensureToggle("software-dev", false);
      await wait(250);
      await save();
      const devOff = await waitStored((v) => v.softwareDevEnabled === false);
      const agents4 = await agentsText();
      h.check("⑥ 关闭后端规范并保存：只停止注入，配置仍在，架构规范不受影响",
        Boolean(devOff && devOff.softwareDevEnabled === false && String(devOff.softwareDevNotes || "").includes(devMarker))
          && !agents4.includes("Software development norms") && !agents4.includes(devMarker)
          && agents4.includes("Application architecture norms") && agents4.includes(archMarker),
        JSON.stringify({ devOff, dev: agents4.includes(devMarker), arch: agents4.includes(archMarker) }));

      /* 复位到本轮开始前的值（包括三个开关），避免污染持久 profile。 */
      await h.eval(`window.codex.savePersonalization({
        frontendDesignStyle: ${JSON.stringify(initial?.frontendDesignStyle || "auto")},
        frontendDesignNotes: ${JSON.stringify(initial?.frontendDesignNotes || "")},
        frontendDesignEnabled: ${initial?.frontendDesignEnabled === true},
        softwareDevStyle: ${JSON.stringify(initial?.softwareDevStyle || "auto")},
        softwareDevNotes: ${JSON.stringify(initial?.softwareDevNotes || "")},
        softwareDevEnabled: ${initial?.softwareDevEnabled === true},
        appArchitectureStyle: ${JSON.stringify(initial?.appArchitectureStyle || "auto")},
        appArchitectureNotes: ${JSON.stringify(initial?.appArchitectureNotes || "")},
        appArchitectureEnabled: ${initial?.appArchitectureEnabled === true}
      })`);
      const reset = await waitStored((v) => v.softwareDevEnabled === (initial?.softwareDevEnabled === true)
        && v.appArchitectureEnabled === (initial?.appArchitectureEnabled === true));
      const agents5 = await agentsText();
      h.check("⑦ 复位后档案与 AGENTS.md 都不再带测试内容",
        Boolean(reset) && !agents5.includes(devMarker) && !agents5.includes(archMarker),
        JSON.stringify({ reset, dev: agents5.includes(devMarker), arch: agents5.includes(archMarker) }));
    },
  },
  {
    id: "queue-timer",
    name: "排队消息定时总开关（默认关 / 开启后落盘 / 关闭即清）",
    run: async (h) => {
      /* 11-02 用户令：定时默认关闭，关闭时排队卡不显示定时入口。
         这里验偏好本身（排队卡的隐藏/撤销由守卫 12as 静态钉住）；
         ⛔ 必须先清键再 reload：持久 profile 可能保留上一轮开启过的状态。 */
      await h.eval(`localStorage.removeItem("queue-timer-enabled-v1"); localStorage.removeItem("queue-timers-v1"); true`);
      await h.reload({ waitMs: 2000 });
      await h.waitFor(`!!document.querySelector(".app-shell")`, { label: "reload 后主界面", timeoutMs: 30000 });
      await h.eval(`document.querySelector(".sidebar-settings")?.click()`);
      await h.waitFor(`!!document.querySelector(".settings-modal")`, { label: "设置弹窗", timeoutMs: 10000 });
      await h.eval(`(function(){ const b=[...document.querySelectorAll(".settings-nav button")].find((x)=>(x.textContent||"").trim()==="控制台"); if(b){b.click(); return true;} return false; })()`);
      await h.waitFor(`!!document.querySelector('[aria-label="排队消息定时发送"]')`, { label: "定时总开关", timeoutMs: 10000 });
      const initial = await h.eval(`document.querySelector('[aria-label="排队消息定时发送"]').getAttribute("aria-checked")`);
      h.check("① 没存过偏好时定时开关默认关闭", initial === "false", String(initial));
      await h.click('[aria-label="排队消息定时发送"]');
      await wait(250);
      const on = await h.eval(`({ checked: document.querySelector('[aria-label="排队消息定时发送"]').getAttribute("aria-checked"), pref: localStorage.getItem("queue-timer-enabled-v1") })`);
      h.check("② 开启后立即落盘（排队卡据此显示定时入口）", on.checked === "true" && on.pref === "true", JSON.stringify(on));
      await h.click('[aria-label="排队消息定时发送"]');
      await wait(250);
      const off = await h.eval(`({ checked: document.querySelector('[aria-label="排队消息定时发送"]').getAttribute("aria-checked"), pref: localStorage.getItem("queue-timer-enabled-v1"), timers: localStorage.getItem("queue-timers-v1") })`);
      h.check("③ 关闭后偏好为 false 且本地定时被清空", off.checked === "false" && off.pref === "false" && !off.timers, JSON.stringify(off));
      await h.eval(`document.querySelector(".settings-modal header .relay-modal-close")?.click(); true`);
      await wait(300);
    },
  },
  {
    id: "project-menu-flyout",
    name: "项目 ⋯ / 会话 ⋯ 菜单向侧栏右侧弹出（portal）+ 视口钳制自适应往上，不再被裁（11-08）",
    run: async (h) => {
      /* 11-08 用户实测（截图）：项目菜单嵌在侧栏滚动容器里，「删除项目」被裁掉；
         旧 is-up 翻转参照 window 底边而不是滚动容器底边 ⇒ 靠近侧栏底时永远不翻。
         修法 = portal 到 body + fixed + 视口钳制。这里真点**最后一个项目行**的 ⋯（用户截图同场景）。 */
      await h.eval(`(function(){ const b=[...document.querySelectorAll(".view-tab")].find((x)=>(x.textContent||"").includes("项目")); if(b){b.click(); return true;} return false; })()`);
      await h.waitFor(`!!document.querySelector(".project-item-menu-btn")`, { label: "项目视图 ⋯ 按钮", timeoutMs: 10000 });
      /* 全部折叠：保证最后一个项目行就是列表最底行（展开态的 body 会把头行顶离底部）。 */
      /* ⛔ harness 的 eval 把表达式包成 `return (expr)` —— 多语句必须自己包 IIFE，否则整条是语法错误、静默不执行。 */
      await h.eval(`(function(){ document.querySelector('.view-toolbar-btn[title="折叠全部项目"]')?.click(); return true; })()`);
      await wait(300);
      const geo = () => h.eval(`(function(){
        const r=(e)=>{ if(!e) return null; const b=e.getBoundingClientRect(); return {left:b.left,right:b.right,top:b.top,bottom:b.bottom,w:b.width,h:b.height}; };
        const menu=document.querySelector(".project-menu");
        const btns=[...document.querySelectorAll(".project-item-menu-btn")];
        const btn=btns[btns.length-1];
        return { win:{w:innerWidth,h:innerHeight}, sidebar:r(document.querySelector(".sidebar")), menu:r(menu), btn:r(btn),
          btnCount:btns.length, onBody: !!menu && menu.parentElement===document.body,
          items: menu ? menu.querySelectorAll("button").length : 0 };
      })()`);
      const openLast = async () => {
        await h.eval(`(function(){ const list=document.querySelector(".thread-list"); if(list) list.scrollTop=list.scrollHeight; return 1; })()`);
        await wait(300);
        await h.eval(`(function(){ const btns=[...document.querySelectorAll(".project-item-menu-btn")]; const b=btns[btns.length-1]; if(b){b.click(); return true;} return false; })()`);
        await h.waitFor(`!!document.querySelector(".project-menu")`, { label: "项目菜单浮层", timeoutMs: 5000 });
        /* motion-menu-in 入场动画 140ms（scale 0.98→1）：量几何前等它落定，否则量到的是动画中间帧。 */
        await wait(450);
      };

      await openLast();
      const g1 = await geo();
      h.check("① 前提：有项目 ⋯ 按钮，菜单 portal 到 body（⛔ 不再嵌在侧栏滚动容器里）",
        Boolean(g1 && g1.btnCount > 0 && g1.menu && g1.onBody),
        JSON.stringify({ btnCount: g1?.btnCount, onBody: g1?.onBody }));
      h.check("② 菜单在侧栏右边弹出（左缘 ≥ 侧栏右缘 - 2px）",
        Boolean(g1?.menu && g1.sidebar && g1.menu.left >= g1.sidebar.right - 2),
        JSON.stringify({ left: g1?.menu?.left, sidebarRight: g1?.sidebar?.right }));
      h.check("③ 四项齐全（编辑名称 / 标签 / 打开文件 / 删除），删除项不再被裁",
        g1?.items === 4, String(g1?.items));
      h.check("④ 完整落在视口内（靠底的项目行也不越界）",
        Boolean(g1?.menu && g1.menu.top >= 7 && g1.menu.bottom <= g1.win.h - 7 && g1.menu.right <= g1.win.w - 7),
        JSON.stringify({ menu: g1?.menu, win: g1?.win }));
      await h.pressKey("Escape");
      await wait(250);
      h.check("⑤ Esc 关闭", !(await geo())?.menu, "");

      /* 矮窗口：最后一个项目行贴近视口底 ⇒ 钳制必须把菜单整体上移（「自适应往上」）。 */
      await h._send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 500, deviceScaleFactor: 1, mobile: false });
      await wait(600);
      await openLast();
      const g2 = await geo();
      h.check("⑥ 500 高窗口：菜单被钳制上移（top < 按钮 top）且整体在视口内",
        Boolean(g2?.menu && g2.btn && g2.menu.top < g2.btn.top && g2.menu.top >= 7 && g2.menu.bottom <= g2.win.h - 7),
        JSON.stringify({ menuTop: g2?.menu?.top, btnTop: g2?.btn?.top, bottom: g2?.menu?.bottom, winH: g2?.win?.h }));
      await h.pressKey("Escape");
      await wait(200);
      await h._send("Emulation.clearDeviceMetricsOverride");
      await wait(400);

      /* 点外部关闭（portal 后 DOM 层级 mouseleave 失效，靠 pointerdown 捕获判外部）。
         ⛔ 多语句一律包 IIFE：harness 的 eval 是 `return (${expr})`，`a(); true` 会整条语法错误、静默不执行。 */
      await openLast();
      await h.eval(`(function(){ document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); return true; })()`);
      await wait(250);
      h.check("⑦ 点菜单外部即关", !(await geo())?.menu, "");
      /* 滚动列表即关（菜单不跟着滚走留在原地）。 */
      await openLast();
      await h.eval(`(function(){ const list=document.querySelector(".thread-list"); if(list) list.dispatchEvent(new Event("scroll")); return true; })()`);
      await wait(250);
      h.check("⑧ 滚动会话列表即关", !(await geo())?.menu, "");

      /* ── 会话行 ⋯ 菜单同款（11-08 用户令：「会话的那个选项也是一样的」）──
         切到「任务」平铺视图（项目视图折叠时没有会话行），滚到最底再点最后一行的 ⋯：
         这正是用户截图里「菜单被侧栏裁掉」的场景。 */
      const threadGeo = () => h.eval(`(function(){
        const r=(e)=>{ if(!e) return null; const b=e.getBoundingClientRect(); return {left:b.left,right:b.right,top:b.top,bottom:b.bottom,w:b.width,h:b.height}; };
        const menu=document.querySelector(".thread-row-menu");
        const btns=[...document.querySelectorAll(".thread-more-button")];
        const btn=btns[btns.length-1];
        const labels=menu ? [...menu.querySelectorAll("button")].map((b)=>(b.textContent||"").trim()) : [];
        return { win:{w:innerWidth,h:innerHeight}, sidebar:r(document.querySelector(".sidebar")), menu:r(menu), btn:r(btn),
          btnCount:btns.length, onBody: !!menu && menu.parentElement===document.body, labels };
      })()`);
      const openLastThread = async () => {
        await h.eval(`(function(){ const list=document.querySelector(".thread-list"); if(list) list.scrollTop=list.scrollHeight; return 1; })()`);
        await wait(300);
        await h.eval(`(function(){ const btns=[...document.querySelectorAll(".thread-more-button")]; const b=btns[btns.length-1]; if(b){b.click(); return true;} return false; })()`);
        await h.waitFor(`!!document.querySelector(".thread-row-menu")`, { label: "会话行菜单浮层", timeoutMs: 5000 });
        await wait(450); // 入场动画 140ms，量几何前等落定
      };
      await h.eval(`(function(){ const b=[...document.querySelectorAll(".view-tab")].find((x)=>(x.textContent||"").includes("任务")); if(b){b.click(); return true;} return false; })()`);
      await h.waitFor(`!!document.querySelector(".thread-more-button")`, { label: "任务视图会话行 ⋯", timeoutMs: 10000 });

      await openLastThread();
      const t1 = await threadGeo();
      h.check("⑨ 会话 ⋯ 菜单也 portal 到 body（⛔ 不再嵌在侧栏滚动容器里）",
        Boolean(t1 && t1.btnCount > 0 && t1.menu && t1.onBody),
        JSON.stringify({ btnCount: t1?.btnCount, onBody: t1?.onBody }));
      h.check("⑩ 会话菜单在侧栏右边弹出（左缘 ≥ 侧栏右缘 - 2px）",
        Boolean(t1?.menu && t1?.sidebar && t1.menu.left >= t1.sidebar.right - 2),
        JSON.stringify({ left: t1?.menu?.left, sidebarRight: t1?.sidebar?.right }));
      h.check("⑪ 关键项齐全（导出会话 / 改名字 / 删除），靠底的会话行也不越界",
        Boolean(t1?.labels?.some((l) => l.startsWith("导出会话")) && t1?.labels?.some((l) => l.startsWith("完整备份"))
          && t1?.labels?.includes("改名字") && t1?.labels?.includes("删除")
          && t1.menu.top >= 7 && t1.menu.bottom <= t1.win.h - 7 && t1.menu.right <= t1.win.w - 7),
        JSON.stringify({ labels: t1?.labels, menu: t1?.menu, win: t1?.win }));
      await h.pressKey("Escape");
      await wait(250);
      h.check("⑫ 会话菜单 Esc 关闭", !(await threadGeo())?.menu, "");

      /* 矮窗口：最后一行贴近视口底 ⇒ 会话菜单同样必须整体上移（用户原话「不会自适应往上吗」）。 */
      await h._send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 500, deviceScaleFactor: 1, mobile: false });
      await wait(600);
      await openLastThread();
      const t2 = await threadGeo();
      h.check("⑬ 500 高窗口：会话菜单被钳制上移（top < 按钮 top）且整体在视口内",
        Boolean(t2?.menu && t2.btn && t2.menu.top < t2.btn.top && t2.menu.top >= 7 && t2.menu.bottom <= t2.win.h - 7),
        JSON.stringify({ menuTop: t2?.menu?.top, btnTop: t2?.btn?.top, bottom: t2?.menu?.bottom, winH: t2?.win?.h }));
      await h.pressKey("Escape");
      await wait(200);
      await h._send("Emulation.clearDeviceMetricsOverride");
      await wait(400);
    },
  },
  {
    id: "thread-tag-column",
    name: "会话行标签固定成一列、右对齐、贴置顶键左边 + 标签最多 3 个字（11-08 用户定稿）",
    run: async (h) => {
      /* 11-08 用户（截图红框）：「标签整体再往右边来一点，在置顶图标左边……都固定在这样一列」
         定稿：「三个字，右对齐」+「编辑和新增标签限制输入内容」。 */
      await h.eval(`(function(){ const b=[...document.querySelectorAll(".view-tab")].find((x)=>(x.textContent||"").includes("任务")); if(b){b.click(); return true;} return false; })()`);
      await h.waitFor(`!!document.querySelector(".thread-row-tags")`, { label: "带标签的会话行", timeoutMs: 10000 });
      await wait(400);
      const geo = () => h.eval(`(function(){
        const rect=(e)=>{ if(!e) return null; const r=e.getBoundingClientRect(); return {l:+r.left.toFixed(1),r:+r.right.toFixed(1),w:+r.width.toFixed(1)}; };
        const out=[];
        for (const row of document.querySelectorAll(".thread-row")) {
          const tags=row.querySelector(".thread-row-tags");
          if(!tags) continue;
          const pin=rect(row.querySelector(".thread-pin-button"));
          if(!pin || pin.l <= 0) continue; // 成员行在簇里隐藏操作键，不参与
          out.push({ tags:rect(tags), text:(tags.textContent||"").trim(), pin, more:rect(row.querySelector(".thread-more-button")) });
        }
        return out;
      })()`);
      const rows1 = (await geo()) ?? [];
      h.check("① 前提：任务视图里有多行带标签的会话（可对比列对齐）", rows1.length >= 2, String(rows1.length));
      const rights = rows1.map((r) => r.tags.r);
      h.check("② 各行标签右缘在同一条竖线上（±1px = 用户定稿「三个字，右对齐」）",
        rights.length >= 2 && Math.max(...rights) - Math.min(...rights) <= 1, JSON.stringify(rights));
      h.check("③ 标签整体在置顶键左边（⛔ 不压住操作键）",
        rows1.length >= 2 && rows1.every((r) => r.tags.r <= r.pin.l - 4),
        JSON.stringify(rows1.map((r) => ({ tagRight: r.tags.r, pinLeft: r.pin.l, gap: +(r.pin.l - r.tags.r).toFixed(1) }))));
      h.check("④ 标签列紧贴操作键区（有归档键的行间隙 ≤8px = 「再往右边来一点」）",
        rows1.some((r) => r.pin.l - r.tags.r <= 8),
        JSON.stringify(rows1.map((r) => +(r.pin.l - r.tags.r).toFixed(1))));

      /* 标签最多 3 个字：行菜单 → 添加/编辑标签 → 输入 4 个字必须被截成 3（只验输入，不落盘）。 */
      await h.eval(`(function(){ const list=document.querySelector(".thread-list"); if(list) list.scrollTop=0; return 1; })()`);
      await wait(200);
      await h.eval(`(function(){ const b=document.querySelector(".thread-more-button"); if(b){b.click(); return true;} return false; })()`);
      await h.waitFor(`!!document.querySelector(".thread-row-menu")`, { label: "会话行菜单", timeoutMs: 5000 });
      await wait(350);
      await h.eval(`(function(){ const b=[...document.querySelectorAll(".thread-row-menu button")].find((x)=>/标签/.test(x.textContent||"")); if(b){b.click(); return true;} return false; })()`);
      await h.waitFor(`!!document.querySelector(".entity-tag-input")`, { label: "标签编辑弹窗", timeoutMs: 5000 });
      await wait(200);
      const maxLen = await h.eval(`document.querySelector(".entity-tag-input").maxLength`);
      await h.typeInto(".entity-tag-input", "测试三字");
      await wait(250);
      const typed = await h.eval(`document.querySelector(".entity-tag-input").value`);
      h.check("⑤ 标签输入最多 3 个字（maxLength=3，输入 4 个字被截成 3）",
        maxLen === 3 && [...String(typed ?? "")].length === 3, JSON.stringify({ maxLen, typed }));
      await h.pressKey("Escape");
      await wait(250);
      h.check("⑥ Esc 关闭标签弹窗（不落盘）", !(await h.eval(`!!document.querySelector(".entity-tag-input")`)), "");
    },
  },
  {
    id: "team-skill-picker",
    name: "工作伙伴 · 引用技能：贴着 + 图标弹、可多选有反馈、点一下不关窗（11-08 用户实测）",
    run: async (h) => {
      /* 11-08 用户（截图）：「选中一个技能弹窗就关了、没有反馈」+「技能弹窗搞这么远干什么」。
         根因：技能面板漏登记进「点外部才关」的豁免名单 ⇒ 点行的 mousedown 被当外部点击、
         click 前就被卸载。这里在**工作伙伴独立窗口**里真点：开面板 → 选 → 再选 → 取消 → Esc。 */
      /* ⛔ 侧栏两个按钮共用 sidebar-quick-boss 类（指挥中枢 / 工作伙伴）⇒ 按 title 精确点「工作伙伴」。 */
      await h.eval(`(function(){ const b=document.querySelector('[title^="工作伙伴"]'); if(b){b.click(); return true;} return window.codex.popoutTeam().then(()=>true); })()`);
      /* 独立窗口刚起来时 App 还在初始化 ⇒ 整段用**页内轮询**（evalInTarget 单次往返内 await），
         避免「点得太早 ⇒ 菜单没开 ⇒ 后面全空」的假红。 */
      const flow = await h.evalInTarget("teamPopout=1", `(async function(){
        const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
        const until=async(fn,ms=8000)=>{ const t0=Date.now(); while(Date.now()-t0<ms){ const v=fn(); if(v) return v; await sleep(120);} return null; };
        const group=await until(()=>document.querySelector(".team-mode__group"));
        if(group) group.click();
        const plus=await until(()=>document.querySelector(".team-composer .plus-spin-button"));
        if(!plus) return "no-plus";
        plus.click();
        const menuItem=await until(()=>[...document.querySelectorAll(".team-composer__pop button")].find(x=>/引用技能/.test(x.textContent||"")));
        if(!menuItem) return "no-menu-item";
        menuItem.click();
        const pop=await until(()=>document.querySelector(".team-composer__skill-pop"));
        return pop ? "ok" : "no-pop";
      })()`);
      h.check("⓪ 前置：工作伙伴窗口已起、+ 菜单 →「引用技能」面板打开", flow === "ok", String(flow));
      await wait(300);
      const geo = () => h.evalInTarget("teamPopout=1", `(function(){
        const r=(e)=>{ if(!e) return null; const b=e.getBoundingClientRect(); return {l:+b.left.toFixed(1),r:+b.right.toFixed(1),t:+b.top.toFixed(1),b:+b.bottom.toFixed(1),w:+b.width.toFixed(1)}; };
        const pop=document.querySelector(".team-composer__skill-pop");
        const btn=document.querySelector(".team-composer .plus-spin-button");
        return { pop:r(pop), btn:r(btn), win:{w:innerWidth,h:innerHeight},
          count:(pop?.querySelector(".team-skill-dialog__count")?.textContent||"").trim(),
          on: pop ? pop.querySelectorAll(".team-skill-dialog__item.is-on").length : -1 };
      })()`);
      const g0 = await geo();
      h.check("① 技能面板贴着 + 图标弹（⛔ 不是屏幕居中的远弹窗）",
        Boolean(g0?.pop && g0?.btn && (g0.pop.b <= g0.btn.t + 2 || g0.pop.t >= g0.btn.b - 2) && Math.abs((g0.pop.l + g0.pop.w / 2) - g0.win.w / 2) > 80),
        JSON.stringify({ pop: g0?.pop, btn: g0?.btn, win: g0?.win }));
      /* 先把上次运行可能留下的选中清掉，保证起点确定。 */
      await h.evalInTarget("teamPopout=1", `(function(){ for (const b of document.querySelectorAll(".team-skill-dialog__item.is-on")) b.click(); return true; })()`);
      await wait(250);
      await h.evalInTarget("teamPopout=1", `(function(){ const b=document.querySelectorAll(".team-skill-dialog__item")[0]; if(b){b.click(); return true;} return false; })()`);
      await wait(250);
      const g1 = await geo();
      h.check("② 点第一个技能：面板**不关**、该行出现选中反馈（is-on + 已选 1）",
        Boolean(g1?.pop) && g1.on === 1 && g1.count.includes("1"), JSON.stringify({ open: Boolean(g1?.pop), on: g1?.on, count: g1?.count }));
      await h.evalInTarget("teamPopout=1", `(function(){ const b=document.querySelectorAll(".team-skill-dialog__item")[1]; if(b){b.click(); return true;} return false; })()`);
      await wait(250);
      const g2 = await geo();
      h.check("③ 再点第二个：可多选（已选 2）", Boolean(g2?.pop) && g2.on === 2 && g2.count.includes("2"), JSON.stringify({ on: g2?.on, count: g2?.count }));
      await h.evalInTarget("teamPopout=1", `(function(){ const b=document.querySelectorAll(".team-skill-dialog__item")[0]; if(b){b.click(); return true;} return false; })()`);
      await wait(250);
      const g3 = await geo();
      h.check("④ 再点第一个 = 取消选中（已选 1，多选开关正常）", Boolean(g3?.pop) && g3.on === 1, JSON.stringify({ on: g3?.on, count: g3?.count }));
      /* 复原：把剩下的选中也取消，别把测试选择留在用户群里。 */
      await h.evalInTarget("teamPopout=1", `(function(){ for (const b of document.querySelectorAll(".team-skill-dialog__item.is-on")) b.click(); return true; })()`);
      await wait(200);
      await h.evalInTarget("teamPopout=1", `(function(){ document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true; })()`);
      await wait(300);
      const g4 = await geo();
      h.check("⑤ Esc 关闭技能面板（选择已复原为 0）", !g4?.pop && g4?.on === -1, JSON.stringify({ open: Boolean(g4?.pop) }));
    },
  },
  {
    id: "team-composer-input",
    name: "群聊输入框：插 @ 后打字光标不跳到末尾 / 输入法组合期不重建 DOM / 粘贴只进纯文本（11-08 审查）",
    run: async (h) => {
      /* 11-08 审查确认的三处真缺陷（用户实测「打字光标乱跳 / 中文被打断」）：
         ① 正文里有 chip 时**每次按键**都重建 DOM 并把光标扔到末尾；
         ② 输入法组合期同样被重建 ⇒ 候选词丢失；
         ③ 普通文字粘贴不拦截 ⇒ 浏览器把剪贴板 HTML 直接塞进 contenteditable。
         判据全部取**真实行为**：chip 节点身份（重建 = 换节点）+ 光标位置 + 插入的文本形态。 */
      await h.eval(`(function(){ const b=document.querySelector('[title^="工作伙伴"]'); if(b){b.click(); return true;} return window.codex.popoutTeam().then(()=>true); })()`);
      const flow = await h.evalInTarget("teamPopout=1", `(async function(){
        const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
        const until=async(fn,ms=10000)=>{ const t0=Date.now(); while(Date.now()-t0<ms){ const v=fn(); if(v) return v; await sleep(120);} return null; };
        const group=await until(()=>document.querySelector(".team-mode__group"));
        if(!group) return {err:"no-group"};
        group.click();
        const ed=await until(()=>document.querySelector('.team-composer__input[contenteditable="true"]'));
        if(!ed) return {err:"no-editor"};
        const atBtn=await until(()=>document.querySelector(".team-group__member-at"));
        if(!atBtn) return {err:"no-member"};
        const sel=document.getSelection();
        const caretPos=()=>{ const r=sel.getRangeAt(0).cloneRange(); r.selectNodeContents(ed); r.setEnd(sel.getRangeAt(0).endContainer, sel.getRangeAt(0).endOffset); return r.toString().length; };
        ed.focus();
        const all=document.createRange(); all.selectNodeContents(ed); sel.removeAllRanges(); sel.addRange(all);
        document.execCommand("delete");
        await sleep(80);
        atBtn.click();                       /* 真实路径：成员行 @ → 插 chip（头像 + @名字） */
        await sleep(250);
        const chip1=ed.querySelector("[data-mention]");
        if(!chip1) return {err:"no-chip", text:ed.textContent};
        document.execCommand("insertText", false, "abc");
        await sleep(150);
        /* 退两格再插 X：正确光标停在 X 之后（⛔ 旧实现重绘后扔到末尾） */
        sel.modify("move","backward","character");
        sel.modify("move","backward","character");
        document.execCommand("insertText", false, "X");
        await sleep(150);
        const typedText=ed.textContent||"";
        const caretAfterType=caretPos();
        const chip2=ed.querySelector("[data-mention]");
        /* 输入法组合：compositionstart 期间打字，DOM 不许被重建 */
        ed.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        document.execCommand("insertText", false, "中");
        await sleep(150);
        const chip3=ed.querySelector("[data-mention]");
        const imeText=ed.textContent||"";
        ed.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "中" }));
        await sleep(120);
        /* 粘贴：剪贴板里同时有 HTML 和纯文本 ⇒ 只许进纯文本 */
        const dt=new DataTransfer();
        dt.setData("text/html","<b>粗体HTML</b>");
        dt.setData("text/plain","纯文本粘贴");
        ed.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
        await sleep(250);
        const pastedText=ed.textContent||"";
        const pastedHtml=ed.innerHTML||"";
        /* 收尾：清空输入框，别把测试文本留在用户群里 */
        const all2=document.createRange(); all2.selectNodeContents(ed); sel.removeAllRanges(); sel.addRange(all2);
        document.execCommand("delete");
        await sleep(80);
        return {
          chip1: Boolean(chip1), chip2Same: chip2 === chip1, chip3Same: chip3 === chip1,
          typedText, typedLen: typedText.length, caretAfterType,
          imeText, pastedText, hasBoldTag: /<b>|粗体HTML/i.test(pastedHtml),
          cleared: !(ed.textContent||"").trim(),
        };
      })()`);
      h.check("⓪ 前置：群聊窗口已开、输入框与成员 @ 键都在、chip 已插入",
        Boolean(flow && !flow.err), JSON.stringify(flow?.err ?? "ok"));
      if (!flow || flow.err) return;
      h.check("① 插 @ 后继续打字：chip 节点**没被重建**（旧实现每次按键重绘）",
        flow.chip2Same === true, JSON.stringify({ same: flow.chip2Same }));
      /* 编辑器末尾有一个零宽字符（renderEditor 补的，editorValue 会剥掉）——
         判据取「光标前一个字是刚输入的 X，且光标后仍有正文」= 光标留在插入点，⛔ 没被扔到末尾。 */
      h.check("② 光标停在 X 之后（⛔ 不是被扔到末尾）",
        flow.typedText.slice(0, flow.caretAfterType).endsWith("X")
        && flow.typedText.slice(flow.caretAfterType).replace(/[\s\u200b]/g, "").length > 0,
        JSON.stringify({ text: flow.typedText, caret: flow.caretAfterType, len: flow.typedLen }));
      h.check("③ 输入法组合期不重建 DOM（候选词不丢）",
        flow.chip3Same === true && flow.imeText.includes("中"),
        JSON.stringify({ same: flow.chip3Same, text: flow.imeText }));
      h.check("④ 粘贴只进纯文本（HTML 标签不进编辑器）",
        flow.pastedText.includes("纯文本粘贴") && !flow.hasBoldTag,
        JSON.stringify({ text: flow.pastedText, html: flow.hasBoldTag }));
      h.check("⑤ 收尾：输入框已清空（不把测试文本留在用户群里）", flow.cleared === true, String(flow.cleared));
    },
  },
  {
    id: "media-desk",
    name: "自媒体工作台：侧栏入口开独立窗（尺寸跟随主窗口）+ 原版界面真渲染（11-11 改入口）",
    run: async (h) => {
      let mainSize = await h.eval(`(function(){ return { w: window.outerWidth, h: window.outerHeight }; })()`);
      /* 主窗可能还没 show（outerWidth=0）；等一会儿，仍拿不到就按主窗口默认尺寸兜底 */
      for (let i = 0; i < 20 && !mainSize.w; i += 1) {
        await wait(250);
        mainSize = await h.eval(`(function(){ return { w: window.outerWidth, h: window.outerHeight }; })()`);
      }
      const opened = await h.eval(`window.codex.mediaDeskPopout()`).catch(() => null);
      h.check("⓪ 侧栏入口的调用成功返回", Boolean(opened && opened.ok), JSON.stringify(opened));

      const listPop = async () => (await (await fetch(`http://127.0.0.1:${h.port}/json`)).json())
        .filter((t) => t.type === "page" && String(t.url || "").includes("mediaDesk=1"));
      let popTargets = [];
      for (let i = 0; i < 80 && !popTargets.length; i += 1) {
        popTargets = await listPop();
        if (!popTargets.length) await wait(200);
      }
      h.check("① 独立窗口已打开（?mediaDesk=1，单例）", popTargets.length === 1, String(popTargets.length));
      if (popTargets.length !== 1) return;

      /* 尺寸：与主窗口当前尺寸一致（允许少量窗框差） */
      const popSize = JSON.parse(await h.evalInTarget("mediaDesk=1", `(function(){ return JSON.stringify({ w: window.outerWidth, h: window.outerHeight }); })()`).catch(() => "null"));
      const sizeOk = Boolean(popSize) && (mainSize.w > 0
        ? Math.abs(popSize.w - mainSize.w) <= 8 && Math.abs(popSize.h - mainSize.h) <= 8
        : popSize.w >= 1200 && popSize.h >= 760);
      h.check("② 独立窗尺寸跟随主窗口（主窗未 show 时按 1280×800 兜底）", sizeOk,
        JSON.stringify({ mainSize, popSize }));

      /* 幂等：再点一次只聚焦 */
      await h.eval(`window.codex.mediaDeskPopout()`).catch(() => null);
      await wait(400);
      h.check("③ 再点一次只聚焦、不新开窗口（单例）", (await listPop()).length === 1);

      /* 页面挂载 + 令牌地址 */
      const readPop = async (expr) => {
        try {
          const raw = await h.evalInTarget("mediaDesk=1", expr, { timeoutMs: 3000 });
          return raw == null ? null : JSON.parse(raw);
        } catch {
          return null;
        }
      };
      let frame = null;
      for (let i = 0; i < 60 && !frame; i += 1) {
        const snap = await readPop(`(function(){ const f=document.querySelector(".media-desk-frame"); return JSON.stringify({ error:(document.querySelector(".media-desk-error")?.textContent||"").slice(0,200), src:f?f.getAttribute("src")||"":"" }); })()`);
        if (snap?.error) { h.check("④ 工作台页面挂载成功（⛔ 不是启动失败提示）", false, JSON.stringify(snap)); return; }
        if (snap?.src) frame = { src: snap.src };
        if (!frame) await wait(300);
      }
      h.check("④ 工作台页面挂载成功（⛔ 不是启动失败提示）", Boolean(frame), JSON.stringify(frame));
      if (!frame) return;
      const endpointOk = /^http:\/\/127\.0\.0\.1:\d+\/t\/[0-9a-f]{36}\/$/.test(frame.src);
      h.check("⑤ iframe 指向带随机令牌的本机地址", endpointOk, JSON.stringify(frame));
      if (!endpointOk) return;

      /* 页面 + 生产包真能取到 */
      const pageOk = await fetch(frame.src).then((r) => r.text()).then((t) => t.includes("md-fatal")).catch(() => false);
      const bundle = await fetch(new URL("react.bundle.js", frame.src)).then(async (r) => ({ status: r.status, size: (await r.text()).length })).catch(() => ({ status: 0, size: 0 }));
      h.check("⑥ 页面与本机 React 包都取得到（且是生产包）", pageOk && bundle.status === 200 && bundle.size > 100000, JSON.stringify(bundle));

      /* 原版界面真渲染（跨源 iframe 是独立 target，需单独连） */
      const frameEval = async (expression) => {
        const targets = await (await fetch(`http://127.0.0.1:${h.port}/json`)).json();
        const target = targets.find((t) => t.type === "iframe" && String(t.url || "").startsWith(frame.src.replace(/\/$/, "")));
        if (!target) return null;
        const ws = new WebSocket(target.webSocketDebuggerUrl);
        const pending = new Map();
        let seq = 0;
        await new Promise((resolve, reject) => { ws.on("open", resolve); ws.on("error", () => reject(new Error("iframe CDP 连接失败"))); });
        ws.on("message", (data) => { const m = JSON.parse(data.toString()); const slot = pending.get(m.id); if (slot) { pending.delete(m.id); slot(m); } });
        const send = (method, params = {}) => new Promise((resolve, reject) => {
          const id = ++seq;
          const timer = setTimeout(() => { pending.delete(id); reject(new Error(`iframe CDP ${method} 超时`)); }, 8000);
          pending.set(id, (m) => { clearTimeout(timer); if (m.error) reject(new Error(m.error.message)); else resolve(m.result); });
          ws.send(JSON.stringify({ id, method, params }));
        });
        try {
          const r = await send("Runtime.evaluate", { expression, returnByValue: true });
          return r?.result?.value;
        } finally {
          ws.close();
        }
      };
      let view = null;
      for (let i = 0; i < 40 && !view; i += 1) {
        try {
          /* ⛔ 别用 innerText 判界面：上游把 <style> 画在 #root 里，innerText 会带 CSS 源文本 */
          view = JSON.parse(await frameEval(`(function(){ const root=document.getElementById("root"); const navs=[...document.querySelectorAll(".md-nav button")]; return JSON.stringify({ ready:document.readyState, kids:root?root.children.length:0, navs:navs.length, nav:(document.querySelector(".md-nav button.is-on")?.textContent||"").trim() }); })()`) ?? "null");
        } catch { /* 帧还没建好 */ }
        if (!view || !view.kids || view.navs < 5) { view = null; await wait(300); }
      }
      h.check("⑦ 原版工作台已在独立窗内渲染（#root 有内容 + 五个导航键）", Boolean(view && view.kids > 0 && view.navs >= 5), JSON.stringify(view));
      if (view) h.check("⑧ 渲染的是上游界面（当前导航是 灵感/内容/排期/复盘/风格 之一）", /^(灵感|内容|排期|复盘|风格)$/.test(view.nav), JSON.stringify(view.nav));

      /* 声明 / 跳转按键 / 主题变量 / 弹窗可见性（11-11 用户实测项） */
      const note = JSON.parse(await h.evalInTarget("mediaDesk=1", `(function(){ return JSON.stringify({ text:(document.querySelector(".media-desk-note")?.textContent||"").replace(/\\s+/g," ").trim(), hasLink:!!document.querySelector(".media-desk-link"), canOpen:typeof window.codex?.openExternal === "function" }); })()`).catch(() => "null") ?? "null");
      h.check("⑨ 开源声明与跳转按键在位（MIT / 数据本机 / 不自动发布）",
        Boolean(note && /dsh-media-desk/.test(note.text) && /MIT/.test(note.text) && /不会自动发布/.test(note.text) && note.hasLink && note.canOpen),
        JSON.stringify(note));
      const theme = JSON.parse(await frameEval(`(function(){ const b=getComputedStyle(document.body); return JSON.stringify({ bg:b.backgroundColor, color:b.color, mask:getComputedStyle(document.documentElement).getPropertyValue("--dsw-alias-bg-mask-1").trim() }); })()`) ?? "null");
      h.check("⑩ 宿主主题变量生效（页面不透明 / 文字有颜色 / 遮罩有真值）",
        Boolean(theme && theme.bg !== "rgba(0, 0, 0, 0)" && theme.color !== "rgba(0, 0, 0, 0)" && theme.mask),
        JSON.stringify(theme));
      let dlg = null;
      for (let i = 0; i < 12 && !dlg; i += 1) {
        await frameEval(`(function(){ const b=[...document.querySelectorAll(".md-topbar button")].find(function(x){ return (x.getAttribute("aria-label")||"")==="设置"; }); if(b && !document.querySelector(".md-dialog-mask")) b.click(); return 1; })()`);
        await wait(300);
        const raw = await frameEval(`(function(){ const m=document.querySelector(".md-dialog-mask"); if(!m) return JSON.stringify(null); const s=getComputedStyle(m); const panel=m.querySelector(".md-dialog") || [...m.querySelectorAll("*")].find(function(e){ const b=getComputedStyle(e).backgroundColor; return b && b!=="rgba(0, 0, 0, 0)" && e.getBoundingClientRect().width>100; }); return JSON.stringify({ mask:s.backgroundColor, pe:s.pointerEvents, panel:panel?getComputedStyle(panel).backgroundColor:null }); })()`);
        dlg = raw ? JSON.parse(raw) : null;
        if (!dlg) await wait(300);
      }
      h.check("⑪ 工作台弹窗：遮罩可见 + 面板不透明（⛔ 透明遮罩 = 整页点不动）",
        Boolean(dlg && dlg.mask !== "rgba(0, 0, 0, 0)" && dlg.pe !== "none" && dlg.panel && dlg.panel !== "rgba(0, 0, 0, 0)"),
        JSON.stringify(dlg));

      /* 风格页网格自适应（11-11 用户「排版做好自适应，这么大空白呢」） */
      await frameEval(`(function(){ const b=[...document.querySelectorAll(".md-nav button")].find(function(x){ return (x.textContent||"").trim()==="风格"; }); b&&b.click(); return 1; })()`);
      await wait(700);
      const grid = JSON.parse(await frameEval(`(function(){ const g=[...document.querySelectorAll(".md-style-grid")].find(function(x){ return x.children.length>=2; }); if(!g) return JSON.stringify(null); const r=g.getBoundingClientRect(); const kids=[...g.children].map(function(c){ return c.getBoundingClientRect().width; }); return JSON.stringify({ w:Math.round(r.width), kids:kids.map(Math.round), cols:getComputedStyle(g).gridTemplateColumns }); })()`) ?? "null");
      h.check("⑬ 风格页网格自适应（2 张卡的分类铺满整行、不留空列）",
        Boolean(grid && grid.kids.length === 2 && grid.kids.every((w) => w >= grid.w / 2 - 12)),
        JSON.stringify(grid));
      await frameEval(`(function(){ const b=[...document.querySelectorAll(".md-nav button")].find(function(x){ return (x.textContent||"").trim()==="灵感"; }); b&&b.click(); return 1; })()`);

      /* 设置页入口已撤（11-11 用户令） */
      await h.eval(`(function(){ document.querySelector(".sidebar-settings")?.click(); return 1; })()`);
      await h.waitFor(`!!document.querySelector(".settings-modal")`, { label: "设置面板", timeoutMs: 8000 });
      await wait(500);
      const navHit = await h.eval(`[...document.querySelectorAll(".settings-nav button")].some(function(b){ return (b.textContent||"").trim()==="自媒体工作台"; })`);
      h.check("⑫ 设置里不再有「自媒体工作台」入口", navHit === false, String(navHit));
      await h.pressKey("Escape").catch(() => undefined);
    },
  },
  {
    id: "rpa-recipes",
    name: "RPA 配方：同名 upsert + 运行结果回写 + 设置页可见（11-13 审查补齐）",
    run: async (h) => {
      const probeName = "__e2e_rpa__";
      try {
        const first = await h.eval(`window.codex.saveRpaRecipe({ name: ${JSON.stringify(probeName)}, desc: "e2e", kind: "browser", steps: ["打开 A", "点击 B"] })`);
        await h.eval(`window.codex.saveRpaRecipe({ name: ${JSON.stringify(probeName)}, kind: "browser", steps: ["打开 A", "点击 C"] })`);
        const list = await h.eval(`window.codex.listRpaRecipes()`);
        const same = (Array.isArray(list) ? list : []).filter((r) => r.name === probeName);
        h.check("① 同名保存是 upsert（只有一条，步骤已更新）",
          same.length === 1 && same[0]?.id === first?.id && Array.isArray(same[0]?.steps) && same[0].steps.includes("点击 C"),
          JSON.stringify(same));
        const recipeId = same[0]?.id ?? "";
        if (!recipeId) return;
        await h.eval(`window.codex.recordRpaRun({ id: ${JSON.stringify(recipeId)}, ok: false, error: "e2e" })`);
        const after = await h.eval(`window.codex.listRpaRecipes()`);
        const row = (Array.isArray(after) ? after : []).find((r) => r.id === recipeId);
        h.check("② 运行结果回写：runCount=1 / lastStatus=failed",
          row?.runCount === 1 && row?.lastStatus === "failed" && row?.lastError === "e2e", JSON.stringify(row));
        await h.eval(`(function(){ document.querySelector(".sidebar-settings")?.click(); return 1; })()`);
        await h.waitFor(`!!document.querySelector(".settings-modal")`, { label: "设置面板", timeoutMs: 8000 });
        await h.eval(`(function(){ const b=[...document.querySelectorAll(".settings-nav button")].find(function(x){ return (x.textContent||"").trim()==="自动化"; }); b&&b.click(); return 1; })()`);
        await h.waitFor(`[...document.querySelectorAll(".hub-card strong")].some(function(x){ return (x.textContent||"").trim()==="RPA 自动化"; })`, { label: "RPA 入口卡", timeoutMs: 8000 });
        await h.eval(`(function(){ const b=[...document.querySelectorAll(".hub-card")].find(function(x){ return (x.querySelector("strong")?.textContent||"").trim()==="RPA 自动化"; }); b&&b.click(); return 1; })()`);
        await h.waitFor(`!!document.querySelector(".auto-cards") || !!document.querySelector(".auto-empty")`, { label: "RPA 页", timeoutMs: 8000 });
        await wait(400);
        const pageText = await h.eval(`(document.querySelector(".settings-modal")?.innerText || "")`);
        h.check("③ 设置页 RPA 列表显示配方", String(pageText).includes(probeName), String(pageText).slice(0, 200));
      } finally {
        const leftovers = await h.eval(`window.codex.listRpaRecipes()`).catch(() => []);
        for (const recipe of (Array.isArray(leftovers) ? leftovers : [])) {
          if (recipe?.name === probeName) await h.eval(`window.codex.deleteRpaRecipe(${JSON.stringify(recipe.id)})`).catch(() => undefined);
        }
        await h.pressKey("Escape").catch(() => undefined);
      }
    },
  },
];

if (flag("list")) {
  for (const c of CHECKS) console.log(`  ${c.id.padEnd(20)} ${c.name}`);
  process.exit(0);
}

const only = value("only", "");
const selected = only ? CHECKS.filter((c) => c.id.includes(only)) : CHECKS;
if (!selected.length) {
  console.error(`没有匹配 --only ${only} 的验收项；可用：${CHECKS.map((c) => c.id).join(", ")}`);
  process.exit(1);
}
console.log(`\x1b[90m验收范围：${only ? `--only ${only}` : "当前全部"}（${selected.length} 项：${selected.map((c) => c.id).join(", ")}）\x1b[0m`);

const missing = [
  ["dist/index.html", "npm run build:vite"],
  ["dist-electron/main.js", "npm run build:electron"],
].filter(([file]) => !existsSync(join(ROOT, file)));
if (missing.length) {
  console.error("\x1b[31m验收前置检查失败：构建产物缺失\x1b[0m");
  for (const [file, cmd] of missing) console.error(`  - 缺 ${file} → 先跑 ${cmd}`);
  process.exit(1);
}

const h = new ElectronHarness({
  root: ROOT,
  artifactsDir: join(ROOT, ".e2e-artifacts"),
  profileName: value("profile", "main"),
});

const t0 = Date.now();
const results = [];
try {
  await h.launch();
  console.log("\x1b[90m(应用已启动，CDP 已连接)\x1b[0m\n");
  await enterMain(h);
  for (const check of selected) {
    const startedAt = Date.now();
    console.log(`\x1b[36m── ${check.name}\x1b[0m`);
    try {
      await check.run(h);
      results.push({ id: check.id, ok: true, ms: Date.now() - startedAt });
    } catch (error) {
      console.log(`  \x1b[31m✗ 验收项异常：${error.message}\x1b[0m`);
      try { await h.screenshot(`失败-${check.id}`); } catch { /* 截图失败不影响结论 */ }
      results.push({ id: check.id, ok: false, ms: Date.now() - startedAt, error: error.message });
    }
  }
} catch (error) {
  console.error(`\x1b[31m启动阶段失败：${error.message}\x1b[0m`);
  results.push({ id: "(启动)", ok: false, ms: Date.now() - t0, error: error.message });
} finally {
  if (flag("keep")) console.log("\n\x1b[33m--keep：应用保持运行\x1b[0m");
  else {
    for (let i = 0; i < 300; i++) {
      const busy = await h.eval(`!!document.querySelector(".timeline-bottom-spacer.compact")`).catch(() => false);
      if (!busy) break;
      if (i === 0) console.log("\x1b[90m(还有回合在流式：等它跑完再关应用…)\x1b[0m");
      await wait(1000);
    }
    await h.close();
  }
}

const summary = h.summary("验收");
console.log("\n\x1b[1m验收项耗时：\x1b[0m");
for (const r of results) {
  console.log(`  ${r.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${r.id.padEnd(20)} \x1b[90m${r.ms}ms\x1b[0m${r.error ? `  ${r.error}` : ""}`);
}
console.log(`\n总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s；截图：.e2e-artifacts/shots；被测 profile：${h.userDataDir}\n`);
process.exit(summary.ok && results.every((r) => r.ok) ? 0 : 1);
