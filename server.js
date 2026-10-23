/* =====================================================================
   Q4 新人培养 · 在线协作工作台 —— 后端 server.js
   架构（复刻在线答题考核系统的方式，但更省心）：
     · Express 单服务：托管前端 SPA + 提供 REST 同步 API
     · 服务器是唯一数据源（Single Source of Truth）
     · 身份：账号 + 密码登录；超级管理员创建账号、分配角色、启停账号
             新人由管理员发「邀请链接」→ 本人点开只设一个自己的密码即可进入
             可选：企业微信扫码登录（配置 4 个环境变量即启用）
     · 同步：SSE 实时推送变更 + 客户端按 id/时间戳合并，多端不互相覆盖
     · 持久化：优先本地 data/state.json；若配置了 GitHub，则额外同步到仓库（防免费实例休眠丢数据）
   ===================================================================== */
const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const zlib = require("zlib");

const PORT = process.env.PORT || 3000;
const APP_SECRET = process.env.APP_SECRET || "q4-workbench-2026";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const USERS_FILE = path.join(DATA_DIR, "users.json");
/* 部署后的公网地址（企业微信回调 / 邀请链接用），例：https://q4.example.com */
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/$/, "");

/* ---------- 企业微信扫码登录（可选，配置即启用） ---------- */
const WECOM_CORPID = process.env.WECOM_CORPID || "";
const WECOM_SECRET = process.env.WECOM_SECRET || "";
const WECOM_AGENTID = process.env.WECOM_AGENTID || "";
const WECOM_ON = !!(WECOM_CORPID && WECOM_SECRET);

/* ---------- GitHub 持久化（可选，防休眠丢数据） ---------- */
const GH_TOKEN = process.env.GH_TOKEN || "";
const GH_REPO = process.env.GH_REPO || "";           // 形如 owner/repo
const GH_PATH = process.env.GH_PATH || "data/state.json";
const GH_USERS_PATH = process.env.GH_USERS_PATH || "data/users.json";   // 账号也同步，免费实例重启不丢成员
const GH_BRANCH = process.env.GH_BRANCH || "main";
const GH_ON = !!(GH_TOKEN && GH_REPO);

/* ---------- Supabase 云库（可选，推荐：根除免费实例休眠丢数据） ----------
   只需配 SUPABASE_URL + SUPABASE_SERVICE_KEY，其余自动。
   后端用 PostgREST（fetch），不引入额外依赖，npm ci 更快、不易卡死。
   建表 SQL（在 Supabase → SQL Editor 里执行一次）：
     create table if not exists q4_workbench (
       k text primary key,
       v jsonb not null,
       updated_at timestamptz default now()
     ); */
const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || "";
const SB_TABLE = process.env.SUPABASE_TABLE || "q4_workbench";
const SB_ON = !!(SB_URL && SB_KEY);

/* ---------- 邮件通知（QQ 邮箱 SMTP / Brevo / Resend，配置任一即启用） ----------
   注意：Render 免费实例屏蔽了外发 SMTP 端口 25/465/587，QQ 邮箱直连需付费实例；
        免费实例请用 Brevo 或 Resend 的 HTTP 接口（走 443）。
   QQ 邮箱 SMTP（一个发件账号即可发给任意多位领导，无需每人注册）：
     SMTP_USER  发件 QQ 邮箱，例：916941476@qq.com
     SMTP_PASS  QQ 邮箱「设置 → 账户 → POP3/SMTP 服务」生成的 16 位授权码（不是登录密码）
     SMTP_HOST  默认 smtp.qq.com；SMTP_PORT 默认 465（SSL）
   Brevo（免费 300 封/天；只需验证发件邮箱，收 6 位验证码，无需改 DNS）：
     BREVO_API_KEY  Brevo 控制台 → SMTP & API → API Keys
   企业微信邮件 API（免费；走 HTTPS 不占 SMTP 端口；发件人是企业微信应用邮箱，投递率 100%）：
     复用扫码登录的同一套企业微信自建应用配置：
     WECOM_CORPID      企业微信 → 我的企业 → 企业信息 → 企业ID
     WECOM_SECRET      企业微信 → 应用管理 → 自建应用 → Secret（需将应用加入「可调用应用」列表）
     （发件人由企业微信自动分配，无需配置 MAIL_FROM；收件人填任意邮箱）
   Resend（可选；免发件人验证，但发到任意地址需验证域名 DNS）：
     RESEND_API_KEY
   通用：
     MAIL_FROM       发件人；企业微信通道下自动使用应用邮箱，此项可留空
     ALERT_TO        收件人，多个用逗号分隔；默认 liwf@novastar.tech
     DAILY_REPORT_HOUR  工作日日报时间（北京时间，默认 18）
   优先级：SMTP > 企业微信 > Brevo > Resend；都未配置时降级为「只记录不发送」。 */
const RESEND_KEY = process.env.RESEND_API_KEY || "";
const BREVO_KEY = process.env.BREVO_API_KEY || "";
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const SMTP_HOST = process.env.SMTP_HOST || (SMTP_USER ? "smtp.qq.com" : "");
const SMTP_PORT = +(process.env.SMTP_PORT || 465);
const SMTP_SECURE = String(process.env.SMTP_SECURE || "true") !== "false";
const SMTP_ON = !!(SMTP_HOST && SMTP_USER && SMTP_PASS);

const MAIL_FROM = process.env.MAIL_FROM || (SMTP_USER ? `Q4 工作台 <${SMTP_USER}>` : BREVO_KEY ? "Q4 工作台 <916941476@qq.com>" : "Q4 工作台 <onboarding@resend.dev>");
const MAIL_TO = String(process.env.ALERT_TO || (SMTP_USER ? SMTP_USER : "liwf@novastar.tech")).split(/[,;\s]+/).filter(Boolean);
/* 回复地址：邮件转发给领导后，领导点「回复」即回到这个邮箱（默认取第一个收件人） */
const MAIL_REPLY_TO = process.env.MAIL_REPLY_TO || MAIL_TO[0] || "";
const REPORT_HOUR = +(process.env.DAILY_REPORT_HOUR || 18);
/* 周报发送日：5 = 周五（北京时间）。周五 18:00 与日报合并成一封发出，覆盖本周一至周五。
   周一不再发周报，避免「周五发一次、周一又发一次」的重复。 */
const WEEKLY_WEEKDAY = 5;
/* 是否是周报日（周五） */
const isWeeklyDay = day => bj(day).getUTCDay() === WEEKLY_WEEKDAY;
/* ---------- GitHub Actions 发信中继（推荐：全免费、无需注册任何邮件平台、可精准按人发送） ----------
   Render / Railway 等免费云都封了 25/465/587 端口，服务端自己发不出去。
   方案：服务端只负责「生成邮件 + 触发」，真正的发信交给公开仓库的 GitHub Actions
   （公开仓库 Actions 分钟数不限，runner 可连 QQ 邮箱 SMTP，收件人可任意指定）。
     环境变量：
       GH_DISPATCH_TOKEN  有 Actions 写权限的 GitHub Token（触发 workflow 用）
       GH_DISPATCH_REPO   仓库，默认 FGboss/q4-workbench
       RELAY_TOKEN        中继口令，供定时任务拉取日报内容
   仓库 Secrets（GitHub 里配，不放在本服务）：
       SMTP_USER / SMTP_PASS（QQ 邮箱地址 + 授权码）
   未配置时自动回退到下面各直连通道。 */
/* 触发 workflow 用的 token：优先 GH_DISPATCH_TOKEN；没单独配就复用已有的 GH_TOKEN（少配一个变量） */
const GH_DISPATCH_TOKEN = process.env.GH_DISPATCH_TOKEN || process.env.GH_TOKEN || "";
const GH_DISPATCH_REPO = process.env.GH_DISPATCH_REPO || GH_REPO || "FGboss/q4-workbench";
/* 中继口令：未单独配置 RELAY_TOKEN 时直接复用 GH_DISPATCH_TOKEN，少配一个环境变量 */
const RELAY_TOKEN = process.env.RELAY_TOKEN || GH_DISPATCH_TOKEN || "";
const GHA_ON = !!GH_DISPATCH_TOKEN;
const MAIL_ON = !!(GHA_ON || SMTP_ON || WECOM_ON || BREVO_KEY || RESEND_KEY);
const MAIL_CHANNEL = GHA_ON ? "github-actions" : SMTP_ON ? "smtp" : (WECOM_ON ? "wecom" : (BREVO_KEY ? "brevo" : (RESEND_KEY ? "resend" : "")));
const MAIL_STATE_FILE = path.join(DATA_DIR, "mail_state.json");

/* ---------- 账号体系（超级管理员分配权限） ---------- */
const ROLES = ["admin", "lead", "mentor", "newbie"];
const ROLE_NAME = { admin: "超级管理员", lead: "主管", mentor: "导师", newbie: "新人" };

// 首次部署预置账号（结构与演示数据一致）。
// · admin：固定初始密码 admin123（公开文档，首次登录必须立即改密）
// · 其余：初始密码在首次启动时随机生成、只打印在服务日志里，由超管分发给本人；仓库中不预置任何可用密码
const DEFAULT_USERS = [
  { id: "admin",  username: "admin",  name: "超级管理员", role: "admin",  pass: "admin123", mustReset: true },
  { id: "lead",   username: "lead",   name: "彭灿",       role: "lead",   random: true },
  { id: "mentor", username: "mentor", name: "李雯锋",     role: "mentor", random: true },
  { id: "zhan",   username: "zhan",   name: "詹祥雨",     role: "newbie", random: true },
  { id: "tong",   username: "tong",   name: "童伟桀",     role: "newbie", random: true },
];

const sha = s => crypto.createHash("sha256").update(String(s)).digest("hex");
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const newSalt = () => crypto.randomBytes(8).toString("hex");
const newInvite = () => crypto.randomBytes(12).toString("hex");
const hashPass = (p, salt) => sha("p|" + salt + "|" + p + "|" + APP_SECRET);

/* ---------- 邮件订阅（账号自带，随账号一起持久化） ----------
   导师/主管：整体日报 + 周报 + 个人汇总 + 风险预警 + 登录/问题即时提醒
   新人：个人日报 + 个人周报（范围固定为本人）
   后续新增导师/新人时，账号建好即带默认订阅，管理员在「账号管理」里可随时改。 */
const STAFF_MAIL_TYPES = ["daily", "weekly", "personal", "risk", "login", "issue"];
const NEWBIE_MAIL_TYPES = ["personal", "weekly"];
const defaultMailTypes = role => (role === "newbie" ? NEWBIE_MAIL_TYPES : STAFF_MAIL_TYPES).slice();
let MAIL_SEED_DIRTY = false;
/* 首次升级时把已知的四位成员一次性配置好；只跑一次，之后管理员的手动修改不会被覆盖 */
const MAIL_SEED = [
  { keys: ["李雯锋", "liwf"], role: "mentor", name: "李雯锋", email: "liwf@novastar.tech" },
  { keys: ["彭灿", "pengcan"], role: "lead", name: "彭灿", email: "pengcan@novastar.tech" },
  { keys: ["詹祥雨", "zhan"], role: "newbie", name: "詹祥雨", email: "zhanxy1@novastar.tech" },
  { keys: ["童伟桀", "tong"], role: "newbie", name: "童伟桀", email: "tongwj@novastar.tech" },
];
function pickSeedUser(seed) {
  const us = (USERS.users || []).filter(u => u.role === seed.role && u.active !== false);
  const hit = us.find(u => seed.keys.some(k =>
    String(u.name || "").indexOf(k) >= 0 || String(u.username || "").toLowerCase().indexOf(String(k).toLowerCase()) >= 0));
  /* 只有一个导师/主管（或只有一个新人）时直接视为本人，避免默认账号没改名时配置不生效 */
  return hit || (us.length === 1 ? us[0] : null);
}
function applyMailSeed() {
  const found = {};
  MAIL_SEED.forEach(seed => { const u = pickSeedUser(seed); if (u) found[seed.role + ":" + seed.keys[0]] = u; });
  const mentor = found["mentor:李雯锋"], lead = found["lead:彭灿"];
  MAIL_SEED.forEach(seed => {
    const u = found[seed.role + ":" + seed.keys[0]];
    if (!u) return;
    /* 旧库里默认账号名还是「导师 / 主管」时，顺手改成真实姓名，避免邮件里称呼混乱 */
    if (seed.name && ((seed.role === "mentor" && u.name === "导师") || (seed.role === "lead" && u.name === "主管"))) u.name = seed.name;
    if (!String(u.email || "").trim()) u.email = seed.email;
    if (seed.role === "newbie") {
      u.mailTypes = (u.mailTypes && u.mailTypes.length) ? u.mailTypes : NEWBIE_MAIL_TYPES.slice();
      u.mailScope = [u.id];
      if (!u.mentorId && mentor) u.mentorId = mentor.id;
      if (!u.leadId && lead) u.leadId = lead.id;
    } else {
      u.mailTypes = (u.mailTypes && u.mailTypes.length) ? u.mailTypes : STAFF_MAIL_TYPES.slice();
      u.mailScope = u.mailScope === "all" || (Array.isArray(u.mailScope) && u.mailScope.length) ? u.mailScope : "all";
    }
    if (typeof u.mailAuto !== "boolean") u.mailAuto = true;
  });
  USERS.mailSeedV = 4;
  /* 兜底收件人默认就是导师 + 主管，保证未绑定关系的新人提醒不漏人 */
  const cur = USERS.mailCfg || {};
  if (!Array.isArray(cur.fallbackTo) || !cur.fallbackTo.length) {
    USERS.mailCfg = Object.assign({}, cur, { fallbackTo: MAIL_SEED.filter(s => s.role !== "newbie").map(s => s.email) });
  }
  MAIL_SEED_DIRTY = true;
}

/* ---------- 文件读写 ---------- */
function ensureDir() { try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {} }
function readJson(f, dflt) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return dflt; } }
function writeJson(f, obj) { ensureDir(); fs.writeFileSync(f, JSON.stringify(obj), "utf8"); }

/* ---------- 用户库 ----------
   账号改为「启动时初始化」：优先 GitHub（若配置）→ 本地文件 → 默认账号。
   这样部署到 Render 这类免费实例、重启后管理员加过的成员不会丢。 */
let USERS = null;
function ensureUsers() {
  if (!USERS || !Array.isArray(USERS.users) || !USERS.users.length) USERS = readJson(USERS_FILE, null);
  if (!USERS || !Array.isArray(USERS.users) || !USERS.users.length) {
    const now = Date.now();
    const boot = [];
    const users = DEFAULT_USERS.map(u => {
      const pw = u.pass || crypto.randomBytes(4).toString("hex");
      const salt = newSalt();
      boot.push({ username: u.username, name: u.name, role: u.role, pass: pw, mustReset: !!u.mustReset });
      return { id: u.id, username: u.username, name: u.name, role: u.role, salt,
        pass: hashPass(pw, salt), active: true, activated: true, invite: null,
        mustReset: !!u.mustReset, wecom: "", pwless: false, createdAt: now };
    });
    USERS = { v: 2, users, changed: false, teamPasscode: process.env.TEAM_PASSCODE || "" };
    console.log("[首次部署] 已生成初始账号（除 admin 外均为本次随机密码，请分别发给本人）:");
    boot.forEach(b => console.log("  " + b.name + "（" + (ROLE_NAME[b.role] || b.role) + "）· 用户名 " + b.username
      + " · 密码 " + b.pass + (b.mustReset ? "  ← 请登录后立即改密" : "")));
  }
  if (typeof USERS.changed !== "boolean") USERS.changed = true;
  if (typeof USERS.teamPasscode !== "string") USERS.teamPasscode = "";
  // 老数据补齐字段
  (USERS.users || []).forEach(u => {
    if (typeof u.activated !== "boolean") u.activated = true;
    if (!("invite" in u)) u.invite = null;
    if (!("wecom" in u)) u.wecom = "";
    if (!("pwless" in u)) u.pwless = false;
    if (!("email" in u)) u.email = "";
    /* 邮件订阅：旧账号没有配置时按角色补默认值，已有配置一律保留 */
    if (!Array.isArray(u.mailTypes)) u.mailTypes = defaultMailTypes(u.role);
    if (u.role === "newbie") u.mailTypes = u.mailTypes.filter(t => NEWBIE_MAIL_TYPES.indexOf(t) >= 0);
    if (!u.mailTypes.length) u.mailTypes = defaultMailTypes(u.role);
    if (u.mailScope === undefined) u.mailScope = u.role === "newbie" ? [u.id] : "all";
    if (u.role === "newbie") u.mailScope = [u.id];
    /* 推送方式：自动=按设定时间自动发；手动=只在账号管理里手动发送（默认自动） */
    if (typeof u.mailAuto !== "boolean") u.mailAuto = true;
  });
  if (!USERS.mailSeedV || USERS.mailSeedV < 4) applyMailSeed();
  writeJson(USERS_FILE, USERS);
}
/* 账号变更：本地落盘 +（若配了 GitHub）同步到仓库，避免重启丢账号 */
function saveUsers() { writeJson(USERS_FILE, USERS); sbPushUsers(); if (GH_ON) ghPushUsers(); }
const findUser = id => (USERS.users || []).find(u => u.id === id) || null;
const findByUsername = n => (USERS.users || []).find(u => u.username === String(n || "").trim().toLowerCase()) || null;
const findByInvite = t => (USERS.users || []).find(u => u.invite && u.invite === String(t || "")) || null;
const findByWecom = w => (USERS.users || []).find(u => u.wecom && u.wecom === String(w || "")) || null;
const pubUser = u => ({ id: u.id, username: u.username, name: u.name, role: u.role,
  active: u.active, activated: !!u.activated, mustReset: !!u.mustReset, wecom: u.wecom || "", pwless: !!u.pwless });

/* 一次性安全迁移：早期版本用过的弱默认密码（仓库里公开可读），启动时强制换成随机密码并打印到日志，
   避免任何人凭已知密码冒用他人身份。已自行改过密码的账号不受影响。 */
const LEGACY_WEAK = { lead: "8888", mentor: "6666", zhan: "1111", tong: "2222" };
function rotateLegacyWeakPasswords() {
  let n = 0;
  (USERS.users || []).forEach(u => {
    const weak = LEGACY_WEAK[u.username];
    if (weak && u.salt && hashPass(weak, u.salt) === u.pass) {
      u.salt = newSalt();
      const np = crypto.randomBytes(4).toString("hex");
      u.pass = hashPass(np, u.salt);
      console.log("[安全迁移] " + u.name + "（" + u.username + "）初始弱密码已重置为随机密码：" + np + "  ← 请分发给本人");
      n++;
    }
  });
  if (n) saveUsers();
}

/* 令牌：id.base64 + 签名（密码变更/停用后旧令牌自动失效） */
function userToken(u) { return Buffer.from(u.id).toString("base64url") + "." + sha(u.id + "|" + u.pass + "|" + APP_SECRET); }
function verifyToken(t) {
  if (!t || t.indexOf(".") < 0) return null;
  const [b, sig] = t.split(".");
  let id; try { id = Buffer.from(b, "base64url").toString("utf8"); } catch (e) { return null; }
  const u = findUser(id);
  if (!u || !u.active) return null;
  return sig === sha(u.id + "|" + u.pass + "|" + APP_SECRET) ? u : null;
}
function tokenFromReq(req) {
  return verifyToken(req.headers["x-token"]) || verifyToken((req.query && req.query.token) || "");
}
const inviteUrl = u => (PUBLIC_URL || "") + "/?invite=" + u.invite;

/* ---------- 文档（唯一数据源） ---------- */
let DOC = readJson(STATE_FILE, null);

function emptyDoc() {
  return { v: 5, t: 0,
    sec: { t: 0, h: {} }, meta: { t: 0 }, people: { t: 0 }, plan: { t: 0 },
    carriers: { t: 0, list: [] }, issues: { t: 0, list: [] }, drills: { t: 0, list: [] },
    map: { t: 0, checks: [] }, kit: { t: 0, list: [] }, cards: { t: 0, list: [] }, quotes: { t: 0, list: [] },
    triggers: { t: 0, list: [] }, fae: { t: 0, map: {} }, reviews: { t: 0, map: {} }, checkins: { t: 0, list: [] },
    quiz: { t: 0, list: [] }, deposits: { t: 0, list: [] }, reveals: { t: 0, list: [] } };
}
function mergeList(L, R) {
  const m = {};
  [(L && L.list) || [], (R && R.list) || []].forEach(a => a.forEach(x => {
    if (!x || !x.id) return;
    const e = m[x.id];
    if (!e || (x.updatedAt || 0) > (e.updatedAt || 0)) m[x.id] = x;
  }));
  return { t: Math.max((L && L.t) || 0, (R && R.t) || 0), list: Object.values(m) };
}
function mergeChecks(A, B) {
  const m = {};
  [(A && A.checks) || [], (B && B.checks) || []].forEach(a => a.forEach(x => {
    if (!x || !x.id) return;
    const e = m[x.id]; if (!e || (x.updatedAt || 0) > (e.updatedAt || 0)) m[x.id] = x;
  }));
  return { t: Math.max((A && A.t) || 0, (B && B.t) || 0), checks: Object.values(m) };
}
function mergeMap(A, B) {
  const map = {};
  [(A && A.map) || {}, (B && B.map) || {}].forEach(s => { for (const k in s) { const e = map[k], c = s[k]; if (!e || (c.t || 0) > (e.t || 0)) map[k] = c; } });
  return { t: Math.max((A && A.t) || 0, (B && B.t) || 0), map };
}
function mergePlain(A, B) { return ((A && A.t) || 0) >= ((B && B.t) || 0) ? (A || {}) : (B || {}); }
function mergeDoc(A, B) {
  const a = A || emptyDoc(), b = B || emptyDoc();
  const o = { v: 5, t: Math.max(a.t || 0, b.t || 0) };
  ["sec", "meta", "people", "plan"].forEach(k => o[k] = mergePlain(a[k], b[k]));
  ["carriers", "issues", "drills", "kit", "cards", "quotes", "triggers", "checkins", "quiz", "deposits", "reveals"].forEach(k => o[k] = mergeList(a[k], b[k]));
  o.map = mergeChecks(a.map, b.map);
  o.fae = mergeMap(a.fae, b.fae);
  o.reviews = mergeMap(a.reviews, b.reviews);
  return o;
}
function normDoc(r) {
  const e = emptyDoc();
  if (!r || typeof r !== "object" || Array.isArray(r)) return e;
  const o = { v: 5, t: r.t || 0 };
  o.sec = (r.sec && r.sec.h) ? r.sec : e.sec;
  ["meta", "people", "plan"].forEach(k => o[k] = (r[k] && typeof r[k] === "object" && !Array.isArray(r[k])) ? r[k] : e[k]);
  ["carriers", "issues", "drills", "kit", "cards", "quotes", "triggers", "checkins", "quiz", "deposits", "reveals"].forEach(k =>
    o[k] = (r[k] && Array.isArray(r[k].list)) ? r[k] : { t: (r[k] && r[k].t) || 0, list: [] });
  o.map = (r.map && Array.isArray(r.map.checks)) ? r.map : { t: 0, checks: [] };
  o.fae = (r.fae && r.fae.map && typeof r.fae.map === "object" && !Array.isArray(r.fae.map)) ? r.fae : { t: 0, map: {} };
  o.reviews = (r.reviews && r.reviews.map && typeof r.reviews.map === "object" && !Array.isArray(r.reviews.map)) ? r.reviews : { t: 0, map: {} };
  return o;
}

/* ---------- 邮件通知实现（Resend） ---------- */
let MS = readJson(MAIL_STATE_FILE, { logins: [], lastLogin: {}, lastReport: "", lastSent: 0 });
function saveMS() { writeJson(MAIL_STATE_FILE, MS); }
/* 统一时间口径：所有业务数据、登录轨迹、日报/周报都按北京时间（UTC+8）。
   toMs 兼容毫秒/秒时间戳、ISO 字符串、Date 对象，避免旧数据格式不一致导致日期判断失效。 */
const toMs = t => {
  if (t == null || t === "") return 0;
  if (typeof t === "number") return t < 1e11 ? Math.round(t * 1000) : t;
  if (t instanceof Date) return t.getTime();
  const n = new Date(t).getTime();
  return Number.isFinite(n) ? n : 0;
};
const bj = t => new Date((toMs(t) || Date.now()) + 8 * 3600000);     // 北京时间（用 UTC 取值）
const bjKey = t => { const d = bj(t); return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0"); };
const bjTime = t => { const d = bj(t); return (d.getUTCMonth() + 1) + "-" + d.getUTCDate() + " " + String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0"); };
const bjHm = t => { const d = bj(t); return String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0"); };
const dayAdd = (day, n) => { const d = new Date(day + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dayRange = (end, n) => { const a = []; for (let i = n - 1; i >= 0; i--) a.push(dayAdd(end, -i)); return a; };
const isDay = (t, day) => { const ms = toMs(t); return !!ms && bjKey(ms) === day; };
/* 近 7 天 / 近 14 天判断用：返回某天与今天相差的自然日数 */
const daysBetween = (a, b) => Math.round((new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 86400000);
const h = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
/* 兜底收件人：邮件中心里配置过就用它，否则用环境变量 ALERT_TO */
const fallbackEmails = () => {
  const fb = (USERS && USERS.mailCfg && Array.isArray(USERS.mailCfg.fallbackTo))
    ? USERS.mailCfg.fallbackTo.map(x => String(x).trim()).filter(x => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x)) : [];
  return fb.length ? fb : MAIL_TO;
};
const mailTo = () => {
  const set = new Set(fallbackEmails());
  (USERS.users || []).forEach(u => { if (u.email && u.active && ["lead", "mentor", "admin"].indexOf(u.role) >= 0) set.add(u.email); });
  return [...set];
};
const nameOf = id => { const u = findUser(id); return u ? u.name : id; };
/* QQ 邮箱等 SMTP 发信：懒加载 nodemailer，连接复用，失败不影响主流程 */
let smtpTransporter = null;
function getSmtp() {
  if (smtpTransporter) return smtpTransporter;
  const nodemailer = require("nodemailer");
  smtpTransporter = nodemailer.createTransport({
    host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_SECURE,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    pool: true, maxConnections: 1, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
  });
  return smtpTransporter;
}
/* 企业微信邮件 API：access_token 缓存（有效期 7200s，提前 5 分钟刷新） */
let wecomToken = { token: "", expire: 0 };
async function getWecomToken() {
  const now = Date.now();
  if (wecomToken.token && wecomToken.expire > now) return wecomToken.token;
  const r = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(WECOM_CORPID)}&corpsecret=${encodeURIComponent(WECOM_SECRET)}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.errcode) throw new Error("企业微信获取 token 失败：" + (j.errmsg || ("HTTP " + r.status)));
  wecomToken = { token: j.access_token, expire: now + (j.expires_in || 7200) * 1000 - 300000 };
  return j.access_token;
}
/* 按人分邮：新人相关提醒只发给他的直属导师 + 直属主管。
   账号上没绑定时，退化为「全部导师与主管」；都没配邮箱时才用兜底收件人。 */
function staffEmailsFor(newbieId, type) {
  const nb = findUser(newbieId);
  const ok = u => u && u.active && u.email && u.mailAuto !== false &&
    (!type || (Array.isArray(u.mailTypes) && u.mailTypes.indexOf(type) >= 0));
  const direct = [nb && nb.mentorId, nb && nb.leadId].filter(Boolean).map(findUser).filter(ok);
  /* 已绑定直属导师/主管：只发给这两位，避免「手动」账号被兜底收件人绕过 */
  if (direct.length) return [...new Set(direct.map(u => u.email))];
  const set = new Set();
  (USERS.users || []).forEach(u => { if (ok(u) && (u.role === "mentor" || u.role === "lead")) set.add(u.email); });
  /* 一个导师/主管都没配邮箱时，才用兜底收件人，保证不漏人 */
  if (!set.size) fallbackEmails().forEach(e => set.add(e));
  return [...set];
}

/* ---------- 邮件中心配置（超管可在网站内维护，随账号数据一起持久化） ----------
   规则 = 一个人 + 邮箱 + 订阅内容 + 关注的新人范围。
   · 订阅内容：daily 整体日报 / weekly 周报 / personal 个人汇总 / risk 风险预警 / login 登录提醒 / issue 问题提醒
   · 关注新人：all=全部；或 [新人id...]=只看这几位（日报、周报、个人汇总、风险预警都按此过滤）
   没有配置任何规则时，完全保持原有行为（发给 ALERT_TO + 已填邮箱的导师/主管），不影响已跑通流程。 */
const MAIL_TYPES = [
  ["daily", "整体日报"], ["weekly", "周报"], ["personal", "个人汇总"],
  ["risk", "风险预警"], ["login", "登录提醒"], ["issue", "问题 / 诉求提醒"],
];
const MAIL_TYPE_NAME = MAIL_TYPES.reduce((o, x) => (o[x[0]] = x[1], o), {});
/* 可汇总的周期内容：同一账号勾选的多项合并为 1 封邮件一次发完。
   login / issue 是事件触发的即时提醒，不参与合并。 */
const DIGEST_TYPES = ["daily", "weekly", "personal", "risk"];
const validEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "").trim());
function defaultMailCfg() {
  return { daily: true, weekly: true, personal: true, personalSelf: true, risk: true, reportHour: REPORT_HOUR, fallbackTo: MAIL_TO, rules: [] };
}
function normMailRule(r) {
  const x = r || {};
  const types = Array.isArray(x.types) ? x.types.filter(t => MAIL_TYPE_NAME[t]) : [];
  let scope = x.scope;
  if (scope !== "all" && !Array.isArray(scope)) scope = "all";
  if (Array.isArray(scope)) scope = scope.map(String).filter(Boolean);
  return { id: String(x.id || uid()), name: String(x.name || "").trim(),
    email: String(x.email || "").trim().toLowerCase(), types, scope, enabled: x.enabled !== false };
}
function getMailCfg() {
  const raw = (USERS && USERS.mailCfg) || {};
  const d = defaultMailCfg();
  const fb = Array.isArray(raw.fallbackTo) ? raw.fallbackTo.map(x => String(x).trim()).filter(Boolean) : d.fallbackTo;
  const h = Number(raw.reportHour);
  return {
    daily: raw.daily !== false,
    weekly: raw.weekly !== false,
    personal: raw.personal !== false,
    personalSelf: raw.personalSelf !== false,
    risk: raw.risk !== false,
    reportHour: Number.isFinite(h) ? Math.max(0, Math.min(23, Math.floor(h))) : d.reportHour,
    fallbackTo: fb.length ? fb : d.fallbackTo,
    rules: (Array.isArray(raw.rules) ? raw.rules : []).map(normMailRule).filter(r => validEmail(r.email)),
  };
}
function saveMailCfg(patch) {
  const cur = getMailCfg();
  const next = {
    daily: patch.daily !== undefined ? !!patch.daily : cur.daily,
    weekly: patch.weekly !== undefined ? !!patch.weekly : cur.weekly,
    personal: patch.personal !== undefined ? !!patch.personal : cur.personal,
    personalSelf: patch.personalSelf !== undefined ? !!patch.personalSelf : cur.personalSelf,
    risk: patch.risk !== undefined ? !!patch.risk : cur.risk,
    reportHour: patch.reportHour !== undefined ? Math.max(0, Math.min(23, Math.floor(Number(patch.reportHour) || 0))) : cur.reportHour,
    fallbackTo: Array.isArray(patch.fallbackTo) ? patch.fallbackTo.map(x => String(x).trim()).filter(validEmail) : cur.fallbackTo,
    rules: Array.isArray(patch.rules) ? patch.rules.map(normMailRule).filter(r => validEmail(r.email)) : cur.rules,
  };
  USERS.mailCfg = next; USERS.changed = true; saveUsers();
  return next;
}
/* 命中某类邮件、且关注范围包含该新人的规则。
   规则来源 = 账号自带的订阅（推荐，账号管理里维护） + 旧版邮件中心的规则（兼容保留）。
   新人的订阅范围永远是本人，避免把别人的数据发给他。 */
function userMailRules(type, newbieId, opts) {
  const autoOnly = !!(opts && opts.autoOnly);
  const out = [];
  (USERS.users || []).forEach(u => {
    if (!u.active || !validEmail(u.email)) return;
    if (!Array.isArray(u.mailTypes) || u.mailTypes.indexOf(type) < 0) return;
    if (autoOnly && u.mailAuto === false) return;      /* 仅手动：不参与定时推送 */
    const scope = u.role === "newbie" ? [u.id]
      : (u.mailScope === "all" ? "all" : (Array.isArray(u.mailScope) ? u.mailScope : []));
    if (scope !== "all" && newbieId && scope.indexOf(newbieId) < 0) return;
    out.push({ id: "u:" + u.id, name: u.name || "", email: u.email, types: u.mailTypes.slice(), scope, enabled: true });
  });
  return out;
}
function rulesFor(type, newbieId, opts) {
  const legacy = getMailCfg().rules.filter(r => r.enabled !== false && r.types.indexOf(type) >= 0 &&
    (!newbieId || r.scope === "all" || (Array.isArray(r.scope) && r.scope.indexOf(newbieId) >= 0)));
  return userMailRules(type, newbieId, opts).concat(legacy);
}
function ruleEmails(type, newbieId, opts) {
  return [...new Set(rulesFor(type, newbieId, opts).map(r => r.email).filter(validEmail))];
}
/* 发送记录持久化到账号库：免费实例重启后不会把「今日已发」清空，避免重复发日报 */
function mailState() { if (!USERS.mailState || typeof USERS.mailState !== "object") USERS.mailState = {}; return USERS.mailState; }
function markMailSent(kind, key) { const s = mailState(); s[kind] = key; s.lastSent = Date.now(); saveUsers(); }
/* 发送日志：谁在什么时候、因为什么触发、发给了谁、成功还是失败。
   出问题（比如「18:00 没收到邮件」）时可直接在「邮件通知」面板看到原因，不用翻 Render 日志。 */
function logMail(e) {
  const s = USERS;
  s.mailLog = (Array.isArray(s.mailLog) ? s.mailLog : []).concat([{
    at: Date.now(),
    kind: String(e.kind || "mail"),
    trigger: String(e.trigger || ""),
    subject: String(e.subject || "").slice(0, 160),
    to: Array.isArray(e.to) ? e.to.slice(0, 20) : [],
    ok: !!e.ok,
    msg: String(e.msg || "").slice(0, 300),
    channel: String(e.channel || ""),
  }]).slice(-200);
  s.changed = true;
  saveUsers();
}
function recentMailLog(n) { return (Array.isArray(USERS.mailLog) ? USERS.mailLog : []).slice(-(n || 30)).reverse(); }

/* GitHub Actions 中继：把整封邮件塞进 client_payload（base64，避开引号/换行问题），由 workflow 用 QQ SMTP 发出 */
async function dispatchViaGithub(mail) {
  /* 合并后的邮件比单类邮件大，先 gzip 再 base64：HTML 重复度高，压缩后通常只有原体积的 1/5，
     可稳定装进 GitHub repository_dispatch 的 64KB 载荷上限。中继脚本按 payload.gz 解压。 */
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(mail), "utf8"));
  const b64 = gz.toString("base64");
  if (b64.length > 60000) return { ok: false, msg: "邮件内容过大（压缩后 " + Math.round(b64.length / 1024) + "KB），超出 GitHub 触发载荷上限" };
  const r = await fetch(`https://api.github.com/repos/${GH_DISPATCH_REPO}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + GH_DISPATCH_TOKEN,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "q4-workbench",
    },
    body: JSON.stringify({ event_type: "send-mail", client_payload: { b64, gz: true } }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    let msg = "GitHub 触发失败 HTTP " + r.status;
    if (r.status === 401) msg = "GH_DISPATCH_TOKEN 无效或已过期";
    else if (r.status === 404) msg = "仓库不存在或 token 无 Actions 权限（" + GH_DISPATCH_REPO + "）";
    else if (r.status === 403) msg = "token 权限不足（需 Actions: write）";
    console.error("[mail] " + msg, t.slice(0, 200));
    return { ok: false, msg };
  }
  MS.lastSent = Date.now(); saveMS();
  console.log("[mail] 已触发 GitHub Actions 发信：" + mail.subject + " → " + mail.to.join(","));
  return { ok: true, id: "", to: mail.to, channel: "github-actions", async: true };
}
function mailShell(subject, inner, note) {
  return `<div style="font-family:-apple-system,'Microsoft YaHei',sans-serif;max-width:680px;margin:0 auto;color:#16202C;line-height:1.7">
    <div style="background:#17558F;color:#fff;padding:15px 20px;border-radius:10px 10px 0 0">
      <b style="font-size:16px">Q4 新人培养 · 协作工作台</b>
      <div style="font-size:13px;opacity:.9;margin-top:4px">${h(subject)}</div></div>
    <div style="border:1px solid #E3E8EE;border-top:0;border-radius:0 0 10px 10px;padding:18px 20px">${inner}
      <div style="color:#7C8896;font-size:12px;margin-top:16px">${note || ""}${PUBLIC_URL ? `<br>打开工作台：<a href="${h(PUBLIC_URL)}">${h(PUBLIC_URL)}</a>` : ""}</div>
    </div></div>`;
}
async function sendMail(subject, inner, note, opts) {
  const o = opts || {};
  const r = await sendMailRaw(subject, inner, note, o);
  try {
    logMail({ kind: o.kind || "mail", trigger: o.trigger || "", subject,
      to: (r && r.to) || o.to || [], ok: !!(r && r.ok), msg: (r && r.msg) || "", channel: (r && r.channel) || "" });
  } catch (e) { console.error("[mail] log", e.message); }
  return r;
}
async function sendMailRaw(subject, inner, note, opts) {
  const o = opts || {};
  const to = (o.to && o.to.length ? o.to : mailTo());
  if (!MAIL_ON) return { ok: false, to, msg: "未配置邮件通道（GH_DISPATCH_TOKEN 或 SMTP_USER/SMTP_PASS 或 RESEND_API_KEY），已记录事件但未发送" };
  if (!to.length) return { ok: false, to: [], msg: "没有收件人（配置 ALERT_TO 或给账号填邮箱）" };
  const html = mailShell(subject, inner, note);
  try {
    if (GHA_ON) return await dispatchViaGithub({ to, subject, html, from: MAIL_FROM, replyTo: MAIL_REPLY_TO });
    if (SMTP_ON) {
      const opt = { from: MAIL_FROM, to: to.join(","), subject, html };
      if (MAIL_REPLY_TO) opt.replyTo = MAIL_REPLY_TO;
      const info = await getSmtp().sendMail(opt);
      MS.lastSent = Date.now(); saveMS();
      console.log("[mail] 已发送(" + SMTP_HOST + ")：" + subject + " → " + to.join(",") + " · " + (info.messageId || ""));
      return { ok: true, id: info.messageId || "", to, channel: "smtp" };
    }
    if (WECOM_ON) {
      const token = await getWecomToken();
      const r = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/exmail/app/compose_send?access_token=${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: { emails: to }, subject, content: html, content_type: "html" }),
      });
      const j = await r.json().catch(() => ({}));
      if (j.errcode) {
        let msg = j.errmsg || ("errcode " + j.errcode);
        if (j.errcode === 40014 || j.errcode === 42001) msg = "企业微信 access_token 失效，请检查 WECOM_CORP_ID / WECOM_CORP_SECRET";
        else if (j.errcode === 60020) msg = "企业微信应用未加入「可调用应用」列表，请在管理后台配置";
        console.error("[mail] 企业微信发送失败", j.errcode, msg);
        return { ok: false, msg };
      }
      MS.lastSent = Date.now(); saveMS();
      console.log("[mail] 已发送(wecom)：" + subject + " → " + to.join(","));
      return { ok: true, id: "", to, channel: "wecom" };
    }
    if (BREVO_KEY) {
      const m = String(MAIL_FROM).match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
      const sender = m ? { name: m[1] || "Q4 工作台", email: m[2] } : { name: "Q4 工作台", email: String(MAIL_FROM).trim() };
      const payload = { sender, to: to.map(email => ({ email })), subject, htmlContent: html };
      if (MAIL_REPLY_TO) payload.replyTo = { email: MAIL_REPLY_TO };
      const r = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: { "api-key": BREVO_KEY, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { console.error("[mail] Brevo 发送失败", r.status, j.message || j.code || j); return { ok: false, msg: j.message || ("HTTP " + r.status) }; }
      MS.lastSent = Date.now(); saveMS();
      console.log("[mail] 已发送(brevo)：" + subject + " → " + to.join(","));
      return { ok: true, id: j.messageId || "", to, channel: "brevo" };
    }
    const payload = { from: MAIL_FROM, to, subject, html };
    if (MAIL_REPLY_TO) payload.reply_to = MAIL_REPLY_TO;
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + RESEND_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      let msg = j.message || ("HTTP " + r.status);
      if (r.status === 403 && /testing emails|verify a domain/i.test(String(msg))) msg = "Resend 未验证发件域名，只能发给注册邮箱本人。请到 resend.com/domains 验证域名（加 DNS 记录），或改用 Brevo / QQ 邮箱通道";
      else if (r.status === 401) msg = "Resend API Key 无效或无发送权限";
      console.error("[mail] 发送失败", r.status, msg);
      return { ok: false, msg };
    }
    MS.lastSent = Date.now(); saveMS();
    console.log("[mail] 已发送(resend)：" + subject + " → " + to.join(","));
    return { ok: true, id: j.id, to, channel: "resend" };
  } catch (e) {
    console.error("[mail]", e.message);
    smtpTransporter = null;   // 认证/连接失败后丢弃旧连接，下次重建
    return { ok: false, msg: e.message };
  }
}

/* 新人登录：记录登录轨迹 + 立即邮件提醒导师/主管（同一人 30 分钟内不重复轰炸） */
function recordLogin(u) {
  const now = Date.now();
  MS.logins = ((MS.logins || []).concat([{ id: u.id, name: u.name, at: now }])).slice(-400);
  const last = MS.lastLogin[u.id] || 0;
  MS.lastLogin[u.id] = now;
  /* 登录时间同时写入账号库（持久化到 Supabase / GitHub），免费实例重启后不会丢 */
  u.lastLoginAt = now;
  USERS.changed = true;
  saveMS(); saveUsers();
  if (!MAIL_ON || now - last < 30 * 60000) return;
  const d = bj(now);
  const wk = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getUTCDay()];
  sendMail(`【登录提醒】${u.name} 已登录工作台`,
    `<p><b>${h(u.name)}</b>（新人）刚登录了工作台。</p>
     <p>时间：${bjTime(now)} ${wk}</p>
     <p style="color:#5C6772;font-size:13px">若长时间无进展，可主动在「协助」或「把控」里看一眼他的问题与待办。</p>`,
    "登录提醒 · 自动发送", { to: [...new Set(staffEmailsFor(u.id, "login").concat(ruleEmails("login", u.id, { autoOnly: true })))] });
}

/* 新人发布问题/诉求：即时邮件提醒导师/主管（一次保存里多条合并成一封） */
function notifyNewIssues(items) {
  if (!MAIL_ON || !items.length) return;
  /* 按人分邮：同一位新人的多条合并成一封，发给他的导师/主管；多人则各自一封 */
  const byWho = {};
  items.forEach(x => { (byWho[x.who] = byWho[x.who] || []).push(x); });
  Object.keys(byWho).forEach(who => {
    const list = byWho[who];
    const rws = list.slice(0, 6).map(x => `<tr>
       <td style="padding:7px 9px;border-bottom:1px solid #E3E8EE;white-space:nowrap">${x.type === "wish" ? "诉求/吐槽" : "项目问题"}</td>
       <td style="padding:7px 9px;border-bottom:1px solid #E3E8EE">${h(x.text || "").slice(0, 300)}
         ${x.proj ? `<div style="color:#7C8896;font-size:12px">项目：${h(x.proj)}${x.cat ? " · " + h(x.cat) : ""}</div>` : ""}
         ${x.blk ? `<div style="color:#7C8896;font-size:12px">卡点：${h(x.blk).slice(0, 160)}</div>` : ""}
         ${x.need ? `<div style="color:#7C8896;font-size:12px">需要谁：${h(x.need)}</div>` : ""}</td></tr>`).join("");
    const m = list.length > 6 ? `<p style="color:#7C8896;font-size:12px">另有 ${list.length - 6} 条，请到工作台查看。</p>` : "";
    sendMail(`【问题协助】${nameOf(who)} 新提了 ${list.length} 条问题/诉求`,
      `<p><b>${h(nameOf(who))}</b> 在工作台提交了新内容，请尽快回应。</p>
       <table style="border-collapse:collapse;width:100%;font-size:13px">
       <tr style="background:#EDF4FA;text-align:left"><th style="padding:7px 9px">类型</th><th style="padding:7px 9px">内容</th></tr>
       ${rws}</table>${m}`,
      "问题协助提醒 · 自动发送", { to: [...new Set(staffEmailsFor(who, "issue").concat(ruleEmails("issue", who, { autoOnly: true })))] });
  });
}

function drillTotalServer(d) {
  const dims = [["content", 30], ["express", 25], ["pro", 25], ["qa", 20]];
  const ss = (d && Array.isArray(d.scores)) ? d.scores.filter(s => s && s.dims && dims.every(x => s.dims[x[0]] != null)) : [];
  if (!ss.length) return null;
  const avg = {}; dims.forEach(x => { avg[x[0]] = Math.round(ss.reduce((a, s) => a + Math.max(0, Math.min(100, +s.dims[x[0]] || 0)), 0) / ss.length); });
  return Math.round(dims.reduce((a, x) => a + avg[x[0]] * x[1], 0) / 100);
}
function helpScoreServer(r) { if (!r || !r.help) return 0; const a = r.acks || {}; const n = (a.mentor ? 1 : 0) + (a.lead ? 1 : 0); return n >= 2 ? 3 : (n === 1 ? 1 : 0); }

/* 产品地图档位（读 public/bank.js，用于日报里的「超期/节奏」判断；读不到则跳过该段） */
let BANK = null;
function loadBank() {
  try {
    const src = fs.readFileSync(path.join(__dirname, "public", "bank.js"), "utf8");
    BANK = new Function("window", src + "\nreturn window.BANK;")({});
    console.log("[bank] 已加载 " + ((BANK && BANK.levels) || []).length + " 个档位");
  } catch (e) { console.log("[bank] 未加载：" + e.message); BANK = null; }
}
function dueOf(L) {
  const s = String((L && L.due) || "").trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return m[1] + "-" + String(+m[2]).padStart(2, "0") + "-" + String(+m[3]).padStart(2, "0");
  const mm = String((L && L.period) || "").match(/(\d{1,2})/);
  if (!mm) return "";
  const y = bj(Date.now()).getUTCFullYear(), mo = +mm[1];
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return y + "-" + String(mo).padStart(2, "0") + "-" + String(last).padStart(2, "0");
}
function mapPaceServer(who, checks, quiz, today) {
  if (!BANK || !BANK.levels) return [];
  const done = completedNodes(who, checks, quiz);
  return BANK.levels.map(L => {
    const d = (L.nodes || []).filter(n => done.has(n.id)).length;
    const remain = Math.max(0, (L.goal || (L.nodes || []).length) - d);
    const due = dueOf(L);
    const left = due ? Math.round((new Date(due + "T00:00:00Z") - new Date(today + "T00:00:00Z")) / 86400000) : 0;
    return { name: L.n, d, goal: L.goal || (L.nodes || []).length, remain, due, left, over: remain > 0 && due && today > due, risk: remain > 0 && due && today <= due && left <= 7 };
  });
}

/* =====================================================================
   统一统计引擎：日报 / 周报 / 个人汇总 / 风险预警 全部走同一套口径
   口径（北京时间自然日）：
     · 活跃：当日有登录，或有任何业务动作（打卡/小测/客户档案/任务/进展/问题/回复/演练/自查/沉淀）
     · 通关节点：以 createdAt 为准（首次完成该节点）
     · 小测正确率：同一节点取当天最后一次作答（重做不重复累计）；累计正确率按每节点最新一次
     · 演练：近 14 天；超期：任务/项目 due < 统计截止日且未闭环
     · 客户档案本身不闭环；闭环只统计档案下经导师确认验收的任务/项目
   ===================================================================== */
function buildActivityMap(D) {
  const map = {};
  const add = (who, t, kind) => { if (!who) return; const ms = toMs(t); if (!ms) return; (map[who] = map[who] || []).push({ at: ms, kind }); };
  ((D.checkins || {}).list || []).filter(x => !x.del).forEach(x => {
    add(x.who, x.createdAt, "通关节点");
    const c = toMs(x.createdAt), u = toMs(x.updatedAt);
    if (u && u > c) add(x.who, x.updatedAt, "重做小测");
  });
  /* 小测作答实时留痕：每答一题都算一次业务动作，退出未交卷也保留 */
  ((D.quiz || {}).list || []).filter(x => !x.del).forEach(x => {
    add(x.who, x.createdAt, "小测作答");
    (x.answerAt || []).forEach(t => add(x.who, t, "小测作答"));
    if (x.status === "done") add(x.who, x.finishedAt || x.updatedAt, "小测交卷");
  });
  /* 只在「确实是后续更新」时记一次更新动作，避免创建当刻 createdAt=updatedAt 被算成两次动作 */
  const upd = (who, c, u, kind) => { if (toMs(u) > toMs(c)) add(who, u, kind); };
  ((D.carriers || {}).list || []).filter(x => !x.del).forEach(c => {
    add(c.who, c.createdAt, "新增客户档案"); upd(c.who, c.createdAt, c.updatedAt, "更新档案/任务");
    (c.actions || []).filter(v => !v.del).forEach(v => {
      add(c.who, v.createdAt, v.kind === "项目" ? "新增项目" : "新增任务");
      upd(c.who, v.createdAt, v.updatedAt, "更新任务/项目");
      /* 删除的进展不计入活跃；导师确认验收单独作为一次关键动作留痕 */
      (v.log || []).filter(l => !l.del).forEach(l => add(l.by || c.who, l.at, "进展记录"));
      if (v.cfm === 1 && v.cfmAt) add(v.cfmBy || c.who, v.cfmAt,
        (v.kind === "项目" ? "项目" : "任务") + "验收闭环");
    });
  });
  ((D.issues || {}).list || []).filter(x => !x.del).forEach(x => {
    add(x.who, x.createdAt, "提出问题"); upd(x.who, x.createdAt, x.updatedAt, "更新问题");
    (x.replies || []).forEach(r => add(r.by, r.at, "回复/互助"));
  });
  ((D.drills || {}).list || []).filter(x => !x.del).forEach(x => {
    add(x.who, x.createdAt, "演练"); upd(x.who, x.createdAt, x.updatedAt, "更新演练");
    (x.scores || []).forEach(sc => add(sc.by, sc.at, "演练评分"));
  });
  ((D.reveals || {}).list || []).filter(x => !x.del).forEach(x => add(x.who, x.at || x.updatedAt, "展开自查"));
  ((D.deposits || {}).list || []).filter(x => !x.del).forEach(x => {
    add(x.who, x.createdAt, "知识沉淀"); upd(x.who, x.createdAt, x.updatedAt, "更新沉淀");
  });
  return map;
}
function snapshot() {
  const D = DOC || emptyDoc();
  return {
    D,
    checkins: (D.checkins.list || []).filter(x => !x.del),
    quiz: ((D.quiz || {}).list || []).filter(x => !x.del),
    carriers: (D.carriers.list || []).filter(x => !x.del),
    issues: (D.issues.list || []).filter(x => !x.del),
    drills: (D.drills.list || []).filter(x => !x.del),
    reveals: ((D.reveals || {}).list || []).filter(x => !x.del),
    deposits: ((D.deposits || {}).list || []).filter(x => !x.del),
    activity: buildActivityMap(D),
  };
}
/* 每个节点的「官方小测成绩」：独立小测记录优先；旧版打卡里自带成绩的节点作为兜底。
   只看交卷记录，避免做了一半的答案把正确率算进去。
   同一节点重做多次时，取「最早一次交卷」作为首次成绩计入口径；
   重做记录完整保留、单独展示，但不会抬高正确率，避免刷题刷分。 */
function firstQuizPerNode(list, quizList) {
  const legacy = {}, qz = {};
  (list || []).filter(x => (+x.total) > 0 && x.nodeId).forEach(x => {
    const k = x.nodeId, t = toMs(x.updatedAt || x.createdAt), p = legacy[k];
    if (!p || t < toMs(p.updatedAt || p.createdAt)) legacy[k] = x;
  });
  (quizList || []).filter(x => x.status === "done" && (+x.total) > 0 && x.nodeId).forEach(x => {
    const k = x.nodeId, t = toMs(x.finishedAt || x.updatedAt || x.createdAt), p = qz[k];
    if (!p || t < toMs(p.finishedAt || p.updatedAt || p.createdAt)) qz[k] = x;
  });
  return Object.values(Object.assign({}, legacy, qz));
}
function quizSum(list) {
  let correct = 0, total = 0;
  list.forEach(x => { correct += Math.max(0, +x.correct || 0); total += Math.max(0, +x.total || 0); });
  return { correct, total, acc: total > 0 ? Math.round(correct * 100 / total) : null };
}
/* 已完成小测的节点：独立小测交卷 或 旧版打卡记录里带小测成绩 */
function quizDoneNodes(who, checks, quiz) {
  const s = new Set();
  (checks || []).filter(x => x.who === who && x.nodeId && (+x.total) > 0).forEach(x => s.add(x.nodeId));
  (quiz || []).filter(x => x.who === who && x.nodeId && x.status === "done").forEach(x => s.add(x.nodeId));
  return s;
}
/* 节点通关 = 小测已交卷 + 学/用笔记已打卡；两者分开记录，但都完成才算通关 */
function completedNodes(who, checks, quiz) {
  const qz = quizDoneNodes(who, checks, quiz);
  const note = new Set((checks || []).filter(x => x.who === who && x.nodeId && (x.note || x.use)).map(x => x.nodeId));
  return new Set([...note].filter(id => qz.has(id)));
}
function goalProgress(who, checks, quiz) {
  if (!BANK || !BANK.levels) return null;
  const done = completedNodes(who, checks, quiz);
  let got = 0, total = 0;
  BANK.levels.forEach(L => {
    const nodes = L.nodes || [];
    total += L.goal || nodes.length;
    got += nodes.filter(n => done.has(n.id)).length;
  });
  return total ? { got, total, pct: Math.round(got * 100 / total) } : null;
}
function workdaysAfter(lastDay, endDay) {
  let n = 0, d = lastDay;
  while (d < endDay) {
    d = dayAdd(d, 1);
    const wd = new Date(d + "T00:00:00Z").getUTCDay();
    if (wd !== 0 && wd !== 6) n++;
  }
  return n;
}
function userStats(u, days, S) {
  const snap = S || snapshot();
  const daySet = new Set(days);
  const end = days[days.length - 1];
  const inRange = t => { const ms = toMs(t); return !!ms && daySet.has(bjKey(ms)); };

  const ci = snap.checkins.filter(x => x.who === u.id);
  const newRecs = ci.filter(x => inRange(x.createdAt));
  const quizAll = snap.quiz.filter(x => x.who === u.id);
  const quizDone = quizAll.filter(x => x.status === "done" && (+x.total) > 0);
  /* 官方成绩：每节点首次交卷；旧版打卡里带成绩的记录作为兼容兜底 */
  const official = firstQuizPerNode(ci, quizAll);
  const officialToday = official.filter(x => inRange(x.finishedAt || x.updatedAt || x.createdAt));
  const q = quizSum(officialToday);
  const cum = quizSum(official);
  const officialIds = new Set(official.map(x => x.id));
  const retryRecs = quizDone.filter(x => !officialIds.has(x.id) && inRange(x.finishedAt || x.updatedAt || x.createdAt))
    .concat(ci.filter(x => (+x.total) > 0 && toMs(x.updatedAt) > toMs(x.createdAt) && inRange(x.updatedAt)));

  const cars = snap.carriers.filter(x => x.who === u.id);
  const acts = [];
  cars.forEach(c => (c.actions || []).filter(v => !v.del).forEach(v => acts.push(v)));
  /* 客户档案不闭环：open/overdue 均只针对档案下的任务/项目 */
  const doneActs = acts.filter(v => (v.st || 0) === 2);
  const openActs = acts.filter(v => (v.st || 0) !== 2);
  const reviewActs = openActs.filter(v => v.cfm === 3);
  const overdue = openActs.filter(v => { const due = String(v.due || "").slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(due) && due < end; });

  const ops = snap.issues.filter(x => x.who === u.id && (x.status || 0) < 2);
  const opsNew = snap.issues.filter(x => x.who === u.id && inRange(x.createdAt));
  let hs = 0, hn = 0;
  snap.issues.forEach(x => (x.replies || []).forEach(r => {
    if (r.by === u.id && inRange(r.at)) { const s = helpScoreServer(r); hs += s; if (s) hn++; }
  }));

  const drills = snap.drills.filter(x => x.who === u.id);
  const last14 = dayAdd(end, -13);
  const drills14 = drills.filter(x => { const k = bjKey(x.createdAt); return k >= last14 && k <= end; });
  /* 均分与「近 14 天演练次数」同口径，避免次数与均分跨时间范围 */
  const scores = drills14.map(drillTotalServer).filter(v => v != null);
  const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;

  const reveals = snap.reveals.filter(x => x.who === u.id);
  const deposits = snap.deposits.filter(x => x.who === u.id);

  const actsOn = (snap.activity[u.id] || []).filter(a => daySet.has(bjKey(a.at)));
  const lastAct = actsOn.length ? actsOn.reduce((m, a) => (a.at >= m.at ? a : m), actsOn[0]) : null;
  const activityAt = lastAct ? lastAct.at : 0;
  const lastAt = (snap.activity[u.id] || []).reduce((m, a) => Math.max(m, a.at), 0);
  const kinds = {};
  actsOn.forEach(a => { kinds[a.kind] = (kinds[a.kind] || 0) + 1; });

  let loginAt = 0;
  const loginDays = new Set();
  (MS.logins || []).forEach(l => {
    if (l.id !== u.id || !inRange(l.at)) return;
    loginAt = Math.max(loginAt, toMs(l.at));
    loginDays.add(bjKey(l.at));
  });
  if (u.lastLoginAt && inRange(u.lastLoginAt)) { loginAt = Math.max(loginAt, toMs(u.lastLoginAt)); loginDays.add(bjKey(u.lastLoginAt)); }

  const inviteDay = u.createdAt ? bjKey(u.createdAt) : "";
  const doneAll = completedNodes(u.id, ci, quizAll);
  return {
    u, days, end, joinsDays: inviteDay ? daysBetween(inviteDay, end) : 999,
    nodesDone: doneAll.size,
    /* 只统计真正关联到产品地图节点、且已同时完成小测与学/用笔记的记录 */
    nodesNew: new Set(newRecs.filter(x => x.nodeId && doneAll.has(x.nodeId)).map(x => x.nodeId)).size,
    newRecs, retryRecs,
    quizNodes: officialToday.length, quizCorrect: q.correct, quizTotal: q.total, quizAcc: q.acc,
    cumCorrect: cum.correct, cumTotal: cum.total, cumAcc: cum.acc,
    cars: cars.length, carsIn: cars.filter(x => inRange(x.createdAt || x.updatedAt)).length,
    tasks: acts.length, tasksDone: doneActs.length, tasksReview: reviewActs.length,
    tasksTodo: openActs.filter(v => (v.st || 0) === 0).length,
    tasksDoing: openActs.filter(v => (v.st || 0) === 1).length,
    tasksIn: acts.filter(v => inRange(v.createdAt)).length,
    open: openActs.length, overdue: overdue.length, review: reviewActs.length, done: doneActs.length,
    ops: ops.length, opsNew: opsNew.length,
    dr14: drills14.length, drTotal: drills.length, avg, hs, hn,
    reveals: reveals.length, revealsIn: reveals.filter(x => inRange(x.at || x.updatedAt)).length,
    deposits: deposits.length, depositsIn: deposits.filter(x => inRange(x.createdAt)).length,
    activityAt, lastKind: lastAct ? lastAct.kind : "", lastActiveAt: lastAt, lastActiveDay: lastAt ? bjKey(lastAt) : "",
    loginAt, activeAt: Math.max(activityAt, loginAt), activeDays: new Set([...actsOn.map(a => bjKey(a.at)), ...loginDays]).size, kinds,
    paces: mapPaceServer(u.id, snap.checkins, quizAll, end),
    goal: goalProgress(u.id, snap.checkins, quizAll),
  };
}
/* 风险预警：所有报表共用；文案带日期/数字，避免“看起来像模板” */
function riskItems(s, spanLabel) {
  const out = [];
  const nm = s.u.name;
  const span = spanLabel || (s.days.length > 1 ? "本周" : "今日");
  /* 账号当天新建的，当天还没动作属于正常，不算风险（避免刚拉进群就被报「未登录」） */
  if (!s.activeAt && s.joinsDays >= 1) {
    out.push(`${nm} ${span}无任何活动（未登录、未打卡、未做题、未更新记录）`);
  } else if (s.loginAt && !s.activityAt) {
    out.push(`${nm} ${span}仅登录，未打卡/做题/更新记录`);
  }
  if (s.overdue) out.push(`${nm} 有 ${s.overdue} 项任务/项目已超期`);
  if (s.review >= 3) out.push(`${nm} 有 ${s.review} 项任务/项目待导师验收（验收积压会影响新人推进节奏）`);
  if (s.ops >= 3) out.push(`${nm} 未闭环问题 ${s.ops} 条`);
  if (s.quizTotal > 0 && s.quizAcc != null && s.quizAcc < 70) out.push(`${nm} ${span}小测正确率 ${s.quizAcc}%（${s.quizCorrect}/${s.quizTotal}，建议回顾 IMA 原文）`);
  if (s.dr14 === 0 && s.joinsDays >= 14) out.push(`${nm} 近 14 天无演讲演练 / 客户现场培训记录`);
  s.paces.forEach(p => {
    if (p.over) out.push(`${nm} 产品地图 ${p.name}档已超期 ${-p.left} 天（还差 ${p.remain} 个节点）`);
    else if (p.risk) out.push(`${nm} 产品地图 ${p.name}档仅剩 ${p.left} 天（还差 ${p.remain} 个节点，需日均 ${Math.ceil(p.remain / Math.max(1, p.left))} 个）`);
  });
  if (s.days.length === 1 && !s.activityAt && s.lastActiveDay) {
    const idle = workdaysAfter(s.lastActiveDay, s.end);
    if (idle >= 2) out.push(`${nm} 连续 ${idle} 个工作日无业务活动（上次 ${s.lastActiveDay}）`);
  }
  return out;
}
const kindText = kinds => Object.entries(kinds || {}).sort((a, b) => b[1] - a[1]).slice(0, 2).map(x => x[0]).join("、");

/* 工作日日报：按北京时间当天聚合，一次发一封 */
function buildDailyReport(day, opts) {
  const o = opts || {};
  const today = day || bjKey(Date.now());
  const S = snapshot();
  const allNewbies = (USERS.users || []).filter(u => u.role === "newbie" && u.active);
  const newbies = o.newbieIds ? allNewbies.filter(u => o.newbieIds.indexOf(u.id) >= 0) : allNewbies;
  const card = newbies.map(u => userStats(u, [today], S));
  const needAtt = [];
  card.forEach(c => riskItems(c).forEach(t => needAtt.push(t)));

  const rows = card.map(c => {
    const mp = c.paces.map(p => `<span style="color:${p.over ? "#B03A2E" : p.risk ? "#A9691B" : "#7C8896"}">${p.name} ${p.d}/${p.goal}${p.over ? " 超期" : ""}${p.risk ? " 临期" : ""}</span>`).join("<br>");
    const live = c.activityAt
      ? `${bjHm(c.activityAt)}<div style="font-size:11.5px;color:#7C8896">${h(c.lastKind || "")}</div>`
      : c.loginAt ? `${bjHm(c.loginAt)}<div style="font-size:11.5px;color:#A9691B">仅登录</div>` : "—";
    return `<tr>
      <td style="padding:8px 9px;border-bottom:1px solid #E3E8EE;font-weight:700">${h(c.u.name)}</td>
      <td style="padding:8px 9px;border-bottom:1px solid #E3E8EE">${live}</td>
      <td style="padding:8px 9px;border-bottom:1px solid #E3E8EE">${c.nodesDone}<span style="color:#7C8896">（今日 +${c.nodesNew}）</span>${mp ? `<div style="font-size:11.5px;margin-top:2px">${mp}</div>` : ""}</td>
      <td style="padding:8px 9px;border-bottom:1px solid #E3E8EE">${c.cumAcc != null ? `累计 ${c.cumAcc}%` : "—"}${c.quizTotal > 0 ? `<span style="color:#7C8896"> · 今日 ${c.quizAcc}%（${c.quizCorrect}/${c.quizTotal}）</span>` : `<span style="color:#7C8896"> · 今日无小测</span>`}</td>
      <td style="padding:8px 9px;border-bottom:1px solid #E3E8EE">${c.open} 项未闭环${c.overdue ? `<span style="color:#B03A2E"> · 超期 ${c.overdue}</span>` : ""}${c.review ? `<span style="color:#A9691B"> · 待验收 ${c.review}</span>` : ""}<div style="font-size:11.5px;color:#7C8896">档案 ${c.cars}${c.carsIn ? ` · 今日动 ${c.carsIn}` : ""} · 已闭环 ${c.done}</div></td>
      <td style="padding:8px 9px;border-bottom:1px solid #E3E8EE">${c.ops}${c.opsNew ? `<span style="color:#A9691B"> · 今日 +${c.opsNew}</span>` : ""}</td>
      <td style="padding:8px 9px;border-bottom:1px solid #E3E8EE">${c.dr14} 次${c.avg != null ? ` · 均分 ${c.avg}` : ""}</td>
      <td style="padding:8px 9px;border-bottom:1px solid #E3E8EE">${c.hs}<span style="color:#7C8896"> 分/${c.hn} 条</span><div style="font-size:11.5px;color:#7C8896">自查 ${c.reveals}${c.revealsIn ? ` · 今日 ${c.revealsIn}` : ""}</div><div style="font-size:11.5px;color:#7C8896">沉淀 ${c.deposits}${c.depositsIn ? ` · 今日 ${c.depositsIn}` : ""}</div></td>
    </tr>`; }).join("");

  const todayDetailHtml = card.filter(c => c.newRecs.length || c.retryRecs.length).map(c => {
    const items = c.newRecs.map(x => `<li>${h(x.module || x.line || "—")}${x.total > 0 ? ` · 小测 ${x.correct}/${x.total}` : ""}${x.note ? ` · ${h(String(x.note).slice(0, 40))}` : ""}</li>`)
      .concat(c.retryRecs.map(x => `<li>${h(x.module || x.line || "—")} · 重做小测 ${x.correct}/${x.total}</li>`));
    return `<div style="margin-top:8px"><b style="color:#2C3E50">${h(c.u.name)}</b> 今日 ${items.length} 条学习记录：<ul style="margin:4px 0 0 18px;padding:0;font-size:12.5px;color:#4A5568">${items.join("")}</ul></div>`;
  }).join("");

  const carrierLines = [];
  const scopeIds = new Set(newbies.map(u => u.id));
  S.carriers.filter(c => scopeIds.has(c.who)).forEach(c => {
    const acts = (c.actions || []).filter(v => !v.del);
    const open = acts.filter(v => (v.st || 0) !== 2);
    carrierLines.push({
      who: c.who, name: c.name, partner: c.partner || "—",
      next: c.nextAt || c.nextDate || "—",
      open: open.length, review: open.filter(v => v.cfm === 3).length,
      done: acts.filter(v => (v.st || 0) === 2).length, total: acts.length
    });
  });
  const carrierHtml = carrierLines.length
    ? `<table style="border-collapse:collapse;width:100%;font-size:12.5px;margin-top:8px"><tr style="background:#EDF4FA;text-align:left"><th style="padding:6px 8px">新人</th><th style="padding:6px 8px">客户档案</th><th style="padding:6px 8px">销售搭档</th><th style="padding:6px 8px">下次跟进</th><th style="padding:6px 8px">任务/项目（未闭环/总）</th><th style="padding:6px 8px">待验收</th><th style="padding:6px 8px">已闭环</th></tr>${carrierLines.map(c => `<tr><td style="padding:6px 8px;border-bottom:1px solid #E3E8EE">${h(nameOf(c.who))}</td><td style="padding:6px 8px;border-bottom:1px solid #E3E8EE">${h(c.name)}</td><td style="padding:6px 8px;border-bottom:1px solid #E3E8EE">${h(c.partner)}</td><td style="padding:6px 8px;border-bottom:1px solid #E3E8EE">${h(c.next)}</td><td style="padding:6px 8px;border-bottom:1px solid #E3E8EE">${c.open}/${c.total}</td><td style="padding:6px 8px;border-bottom:1px solid #E3E8EE">${c.review}</td><td style="padding:6px 8px;border-bottom:1px solid #E3E8EE">${c.done}</td></tr>`).join("")}</table>`
    : "<p style=\"color:#7C8896;font-size:12.5px\">暂无客户档案</p>";

  /* 高频错题只统计每节点首次交卷的错题；重做仅作练习，不重复累计 */
  const wrongCount = {};
  newbies.forEach(u => {
    const mine = firstQuizPerNode(S.checkins.filter(x => x.who === u.id), S.quiz.filter(x => x.who === u.id));
    mine.forEach(x => (x.wrong || []).forEach(w => { wrongCount[w] = (wrongCount[w] || 0) + 1; }));
  });
  const topWrong = Object.entries(wrongCount).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const wrongHtml = topWrong.length
    ? `<table style="border-collapse:collapse;width:100%;font-size:12.5px;margin-top:8px"><tr style="background:#EDF4FA;text-align:left"><th style="padding:6px 8px">错题</th><th style="padding:6px 8px">答错次数</th></tr>${topWrong.map(([q, n]) => `<tr><td style="padding:6px 8px;border-bottom:1px solid #E3E8EE">${h(q)}</td><td style="padding:6px 8px;border-bottom:1px solid #E3E8EE;color:#B03A2E">${n}</td></tr>`).join("")}</table>`
    : "<p style=\"color:#7C8896;font-size:12.5px\">暂无错题记录</p>";

  const html = `<p style="margin:0 0 10px"><b>${today}</b> 工作日整体进度${newbies.length ? "" : "（暂无新人账号）"}</p>
     <table style="border-collapse:collapse;width:100%;font-size:13px">
       <tr style="background:#EDF4FA;text-align:left">
         <th style="padding:8px 9px">新人</th><th style="padding:8px 9px">今日活跃（最近动作）</th>
         <th style="padding:8px 9px">地图打卡</th><th style="padding:8px 9px">小测正确率（累计/今日）</th><th style="padding:8px 9px">任务/项目</th>
         <th style="padding:8px 9px">未闭环问题</th><th style="padding:8px 9px">近 14 天演练</th><th style="padding:8px 9px">互助/自查/沉淀</th></tr>
       ${rows}
     </table>
     ${needAtt.length ? `<div style="margin-top:14px;background:#FDEDEA;border:1px solid #F3CFC9;border-radius:8px;padding:10px 12px">
       <b style="color:#8C2B1F">需要关注（${needAtt.length} 条）</b><ul style="margin:6px 0 0 18px;padding:0;color:#8C2B1F;font-size:13px">${needAtt.map(t => `<li>${h(t)}</li>`).join("")}</ul></div>`
      : `<p style="margin-top:12px;color:#3C6B1A;font-size:13px">今日各项无明显阻塞。</p>`}
     <div style="margin-top:14px;background:#F0F7FF;border:1px solid #CFE2F3;border-radius:8px;padding:10px 12px">
       <b style="color:#1A5276">今日学习记录（通关节点 / 重做小测）</b>${todayDetailHtml || "<p style=\"color:#7C8896;font-size:12.5px;margin:6px 0 0\">今日暂无打卡或小测</p>"}</div>
     <div style="margin-top:14px;background:#F5FFF0;border:1px solid #CFEBD0;border-radius:8px;padding:10px 12px">
       <b style="color:#3C6B1A">客户档案与任务推进</b>${carrierHtml}</div>
     <div style="margin-top:14px;background:#FFFBF0;border:1px solid #F3E7C9;border-radius:8px;padding:10px 12px">
       <b style="color:#8A6D1A">高频错题（本次统计范围）</b>${wrongHtml}</div>
     <p style="margin-top:12px;color:#5C6772;font-size:12px">口径：今日活跃=当天有登录或任何业务动作（含打卡/小测/客户档案/任务/进展/问题/回复/演练/自查/沉淀）；打卡=已通关节点数（今日 +N 为当天首次通关）；小测正确率按每节点「首次交卷」成绩计算（重做记录完整留痕、单独展示，但不会抬高正确率）；客户档案只做登记、不闭环，待办/超期/已闭环均只统计档案下的任务/项目（已闭环=导师确认验收通过，历史已完成记录兼容）；演练=近 14 天；互助分由导师+主管双评认定。全部按北京时间自然日统计。</p>`;
  return { today, card, needAtt, html };
}

/* 周报周期：
   · 周五（周报日）发送 → 统计「本周一 ~ 今天」，当天 18:00 之后就是完整工作周；
   · 其余日期（补发 / 手动发送）→ 统计上一个自然周（周一 ~ 周日），口径固定不跳变。 */
function weekRangeFor(day) {
  const d = new Date(day + "T00:00:00Z");
  const dow = d.getUTCDay();
  const sinceMon = (dow + 6) % 7;
  const thisMon = dayAdd(day, -sinceMon);
  if (dow === WEEKLY_WEEKDAY) {
    const days = [];
    for (let i = 0; i <= sinceMon; i++) days.push(dayAdd(thisMon, i));
    return { start: thisMon, end: day, days, current: true };
  }
  const end = dayAdd(thisMon, -1);
  const days = [];
  for (let i = 6; i >= 0; i--) days.push(dayAdd(end, -i));
  return { start: days[0], end, days, current: false };
}
function buildWeeklyReport(day, opts) {
  const o = opts || {};
  const range = weekRangeFor(day || bjKey(Date.now()));
  const rl = range.current ? "本周" : "上周";
  const S = snapshot();
  const allNewbies = (USERS.users || []).filter(u => u.role === "newbie" && u.active);
  const newbies = o.newbieIds ? allNewbies.filter(u => o.newbieIds.indexOf(u.id) >= 0) : allNewbies;
  const card = newbies.map(u => userStats(u, range.days, S));
  const needAtt = [];
  card.forEach(c => riskItems(c, rl).forEach(t => needAtt.push(t)));
  const rows = card.map(c => `<tr>
     <td style="padding:8px 9px;border-bottom:1px solid #E3E8EE;font-weight:700">${h(c.u.name)}</td>
     <td style="padding:8px 9px;border-bottom:1px solid #E3E8EE">${c.activeDays} 天<div style="font-size:11.5px;color:#7C8896">${h(kindText(c.kinds)) || "—"}</div></td>
     <td style="padding:8px 9px;border-bottom:1px solid #E3E8EE">${c.nodesNew} 个<div style="font-size:11.5px;color:#7C8896">累计 ${c.nodesDone}${c.goal ? ` · 目标 ${c.goal.pct}%` : ""}</div></td>
     <td style="padding:8px 9px;border-bottom:1px solid #E3E8EE">${c.quizCorrect}/${c.quizTotal}${c.quizAcc != null ? ` · ${c.quizAcc}%` : ""}</td>
     <td style="padding:8px 9px;border-bottom:1px solid #E3E8EE">${c.dr14} 次${c.avg != null ? ` · 均分 ${c.avg}` : ""}</td>
     <td style="padding:8px 9px;border-bottom:1px solid #E3E8EE">档案 ${c.cars} 份（本周动 ${c.carsIn}）<div style="font-size:11.5px;color:#7C8896">新增任务 ${c.tasksIn} · 未闭环 ${c.open} · 待验收 ${c.review} · 已闭环 ${c.done}${c.overdue ? ` · 超期 ${c.overdue}` : ""}</div></td>
     <td style="padding:8px 9px;border-bottom:1px solid #E3E8EE">${c.opsNew} 条<div style="font-size:11.5px;color:#7C8896">未闭环 ${c.ops}</div></td>
     <td style="padding:8px 9px;border-bottom:1px solid #E3E8EE">${c.hs} 分/${c.hn} 条<div style="font-size:11.5px;color:#7C8896">自查 ${c.revealsIn} · 沉淀 ${c.depositsIn}</div></td>
   </tr>`).join("");
  const html = `<p style="margin:0 0 10px"><b>${range.start} ～ ${range.end}</b> 新人培养周报</p>
     <table style="border-collapse:collapse;width:100%;font-size:13px">
       <tr style="background:#EDF4FA;text-align:left">
         <th style="padding:8px 9px">新人</th><th style="padding:8px 9px">活跃天数</th><th style="padding:8px 9px">${rl}通关</th>
         <th style="padding:8px 9px">${rl}小测</th><th style="padding:8px 9px">演练（截至${range.current ? "今天" : "上周日"}）</th><th style="padding:8px 9px">客户档案 / 任务</th>
         <th style="padding:8px 9px">新问题</th><th style="padding:8px 9px">互助/自查/沉淀</th></tr>
       ${rows}
     </table>
     ${needAtt.length ? `<div style="margin-top:14px;background:#FDEDEA;border:1px solid #F3CFC9;border-radius:8px;padding:10px 12px">
       <b style="color:#8C2B1F">需要关注（按${rl}数据，${needAtt.length} 条）</b><ul style="margin:6px 0 0 18px;padding:0;color:#8C2B1F;font-size:13px">${needAtt.map(t => `<li>${h(t)}</li>`).join("")}</ul></div>`
      : `<p style="margin-top:12px;color:#3C6B1A;font-size:13px">${rl}各项无明显阻塞。</p>`}
     <p style="margin-top:12px;color:#5C6772;font-size:12px">口径同日报：按北京时间自然日；活跃天数=${rl}一至周${range.current ? "五" : "日"}有登录或任何业务动作的天数；通关=${rl}首次通关节点；小测正确率按每节点${rl}最后一次作答汇总；客户档案只登记不闭环，闭环=${rl}经导师确认验收的任务/项目。</p>`;
  return { range, card, needAtt, html };
}

/* 个人汇总：某位新人的当日概览 + 目标达成率 + 风险提示 */
function personalSection(c) {
  const g = c.goal;
  const kinds = Object.entries(c.kinds || {}).map(([k, n]) => `${k} ${n}`).join(" · ") || "无业务动作";
  const risks = riskItems(c);
  return `<div style="border:1px solid #E3E8EE;border-radius:10px;padding:14px 16px;margin-top:12px">
    <div style="font-size:15px;font-weight:700;color:#17558F">${h(c.u.name)} <span style="font-size:12px;color:#7C8896;font-weight:400">${c.end}</span></div>
    <table style="border-collapse:collapse;width:100%;font-size:12.5px;margin-top:8px">
      <tr><td style="padding:5px 8px;color:#5C6772;width:110px">今日活跃</td><td style="padding:5px 8px">${c.activeAt ? bjHm(c.activeAt) + "（" + h(c.lastKind || "登录") + "）" : "无"}</td></tr>
      <tr><td style="padding:5px 8px;color:#5C6772">今日学习</td><td style="padding:5px 8px">通关 ${c.nodesNew} 个节点；小测 ${c.quizTotal > 0 ? c.quizCorrect + "/" + c.quizTotal + "（" + c.quizAcc + "%）" : "无"}</td></tr>
      <tr><td style="padding:5px 8px;color:#5C6772">累计进度</td><td style="padding:5px 8px">地图 ${c.nodesDone}/${g ? g.total : "—"} 个节点${g ? `（目标达成 ${g.pct}%）` : ""}；累计正确率 ${c.cumAcc != null ? c.cumAcc + "%" : "—"}</td></tr>
      <tr><td style="padding:5px 8px;color:#5C6772">业务动作</td><td style="padding:5px 8px">${h(kinds)}</td></tr>
      <tr><td style="padding:5px 8px;color:#5C6772">待办 / 问题</td><td style="padding:5px 8px">任务/项目：未闭环 ${c.open}（待验收 ${c.review} · 超期 ${c.overdue}）· 已闭环 ${c.done}；未闭环问题 ${c.ops}</td></tr>
      <tr><td style="padding:5px 8px;color:#5C6772">演练 / 互助</td><td style="padding:5px 8px">近 14 天演练 ${c.dr14} 次${c.avg != null ? `（均分 ${c.avg}）` : ""}；互助 ${c.hs} 分/${c.hn} 条</td></tr>
    </table>
    ${risks.length ? `<div style="margin-top:8px;background:#FDEDEA;border:1px solid #F3CFC9;border-radius:8px;padding:8px 10px;color:#8C2B1F;font-size:12.5px"><b>风险提示</b><ul style="margin:4px 0 0 18px;padding:0">${risks.map(x => `<li>${h(x)}</li>`).join("")}</ul></div>`
      : `<div style="margin-top:8px;color:#3C6B1A;font-size:12.5px">今日无明显风险。</div>`}
  </div>`;
}
function buildPersonalReport(users, day) {
  const S = snapshot();
  const today = day || bjKey(Date.now());
  const list = (users || []).map(u => userStats(u, [today], S));
  const html = `<p style="margin:0 0 6px"><b>${today}</b> 个人学习汇总</p>
    <p style="color:#5C6772;font-size:12.5px">包含当日活跃、学习记录、目标达成率与风险提示，数据以工作台实际记录为准（北京时间）。</p>
    ${list.map(personalSection).join("") || "<p style=\"color:#7C8896\">暂无新人数据</p>"}`;
  return { today, list, html };
}

/* 风险预警内容：只列有风险的新人；无风险返回 null */
function buildRiskReport(users, day) {
  const theDay = day || bjKey(Date.now());
  const S = snapshot();
  const list = (users || []).map(u => userStats(u, [theDay], S)).map(c => ({ c, risks: riskItems(c) })).filter(x => x.risks.length);
  if (!list.length) return null;
  const html = `<p style="margin:0 0 8px"><b>${theDay}</b> 风险预警（仅列有风险的新人）</p>
    ${list.map(({ c, risks }) => `<div style="margin-top:10px"><b>${h(c.u.name)}</b><ul style="margin:4px 0 0 18px;padding:0;color:#8C2B1F;font-size:13px">${risks.map(x => `<li>${h(x)}</li>`).join("")}</ul></div>`).join("")}
    <p style="margin-top:12px;color:#5C6772;font-size:12px">统计口径与日报一致（北京时间自然日）。</p>`;
  return { html, count: list.length, list };
}
/* ---------- 合并汇总：同一账号勾选的多项内容 → 只发 1 封 ----------
   withWeekly=true 时才带上周报（仅周五）。
   新人账号固定只发「自己的」内容：勾了整体日报/风险预警也按个人范围处理，避免收到别人的数据。 */
function digestSubscribers(withWeekly) {
  const alive = new Set((USERS.users || []).filter(u => u.role === "newbie" && u.active).map(u => u.id));
  const map = new Map();
  const add = (email, types, scope) => {
    if (!validEmail(email)) return;
    let e = map.get(email);
    if (!e) { e = { email, types: new Set(), all: false, ids: new Set() }; map.set(email, e); }
    types.forEach(t => e.types.add(t));
    if (scope === "all" || scope == null) e.all = true;
    else (scope || []).forEach(id => { if (alive.has(id)) e.ids.add(id); });
  };
  (USERS.users || []).forEach(u => {
    if (!u.active || !validEmail(u.email) || u.mailAuto === false) return;
    const allowed = u.role === "newbie" ? ["personal", "weekly"] : DIGEST_TYPES;
    const types = (u.mailTypes || []).filter(t => allowed.indexOf(t) >= 0 && (withWeekly || t !== "weekly"));
    if (!types.length) return;
    const scope = u.role === "newbie" ? [u.id]
      : (u.mailScope === "all" ? "all" : (Array.isArray(u.mailScope) ? u.mailScope : []));
    add(u.email, types, scope);
  });
  /* 兼容旧版邮件中心的收件人规则；同一邮箱自动合并类型与关注范围，避免重复发 */
  getMailCfg().rules.forEach(r => {
    if (r.enabled === false) return;
    const types = (r.types || []).filter(t => DIGEST_TYPES.indexOf(t) >= 0 && (withWeekly || t !== "weekly"));
    if (!types.length) return;
    add(r.email, types, r.scope);
  });
  return [...map.values()].map(e => ({ email: e.email, types: e.types, ids: e.all ? null : [...e.ids] }))
    .filter(e => e.ids === null || e.ids.length);
}
function buildDigestParts(theDay, target) {
  const ids = target.ids;
  const allNewbies = (USERS.users || []).filter(u => u.role === "newbie" && u.active);
  const newbies = ids === null ? allNewbies : allNewbies.filter(u => ids.indexOf(u.id) >= 0);
  const parts = [];
  if (target.types.has("daily")) {
    const r = buildDailyReport(theDay, { newbieIds: ids === null ? undefined : ids });
    parts.push({ key: "daily", label: "整体日报", short: "整体日报", html: r.html });
  }
  if (target.types.has("weekly")) {
    const r = buildWeeklyReport(theDay, { newbieIds: ids === null ? undefined : ids });
    parts.push({ key: "weekly", label: `周报 ${r.range.start}～${r.range.end}`, short: "周报", html: r.html });
  }
  if (target.types.has("personal") && newbies.length) {
    const r = buildPersonalReport(newbies, theDay);
    parts.push({ key: "personal", label: "个人汇总（目标达成率 / 风险）", short: "个人汇总", html: r.html });
  }
  if (target.types.has("risk")) {
    const r = buildRiskReport(newbies, theDay);
    if (r) parts.push({ key: "risk", label: `风险预警（${r.count} 位新人）`, short: "风险预警", html: r.html });
  }
  return parts;
}
function digestSubject(theDay, parts) {
  const labels = parts.map(p => p.short);
  if (labels.length === 1) return `【Q4 工作台】${theDay} ${labels[0]}`;
  return `【Q4 工作台】${theDay} 汇总 · ${labels.join(" / ")}`;
}
function renderDigest(parts) {
  const nav = parts.map(p => p.label).join(" · ");
  return `<div style="background:#EDF4FA;border:1px solid #CFE2F3;border-radius:8px;padding:9px 12px;font-size:12.5px;color:#1A5276">
      <b>本封汇总（1 封）</b>：${h(nav)}
      <div style="color:#5C6772;font-size:11.8px;margin-top:2px">同一账号勾选的内容已合并为一封；登录提醒 / 问题提醒仍为即时单发。</div>
    </div>
    ${parts.map((p, i) => `<div style="${i ? "margin-top:22px;padding-top:16px;border-top:2px solid #E3E8EE;" : "margin-top:14px;"}">
      <div style="font-size:15px;font-weight:700;color:#0B3A63;margin-bottom:6px">${i + 1}. ${h(p.label)}</div>
      ${p.html}
    </div>`).join("")}`;
}
async function sendDigestAll(day, opts) {
  const o = opts || {};
  const cfg = getMailCfg();
  const theDay = day || bjKey(Date.now());
  const withWeekly = o.withWeekly !== undefined ? !!o.withWeekly : isWeeklyDay(theDay);
  const skip = new Set((o.skipEmails || []).map(x => String(x).toLowerCase()));
  const onlyTo = o.onlyTo ? String(o.onlyTo).trim().toLowerCase() : "";
  const note = `自动发送 · 工作日 ${cfg.reportHour}:00 · 按账号订阅合并为 1 封（登录 / 问题提醒为即时单发）${withWeekly ? " · 周五含本周周报" : ""}。`;
  const targets = onlyTo
    ? [{ email: onlyTo, types: new Set(DIGEST_TYPES.filter(t => withWeekly || t !== "weekly")), ids: null }]
    : digestSubscribers(withWeekly).filter(t => !skip.has(t.email.toLowerCase()));
  const results = [];
  if (!targets.length) {
    if (skip.size) return { ok: true, to: [], skipped: true, results, msg: "今日收件人均已发送" };
    /* 没有任何自动订阅时保留兜底：给 ALERT_TO 发一封完整汇总 */
    const fb = mailTo();
    if (!fb.length) return { ok: true, to: [], skipped: true, results, msg: "没有自动订阅收件人" };
    const types = new Set(["daily", "personal", "risk"].concat(withWeekly ? ["weekly"] : []));
    const parts = buildDigestParts(theDay, { types, ids: null });
    const subject = digestSubject(theDay, parts);
    const x = await sendMail(subject, renderDigest(parts), note, { to: fb, kind: "digest", trigger: o.trigger || "" });
    return Object.assign({ to: fb, subject, merged: true, results: [Object.assign({ to: fb }, x)] }, x);
  }
  for (const t of targets) {
    const parts = buildDigestParts(theDay, t);
    if (!parts.length) { results.push({ to: [t.email], skipped: true, msg: "本日无符合条件的内容" }); continue; }
    const subject = digestSubject(theDay, parts);
    const x = await sendMail(subject, renderDigest(parts), note, { to: [t.email], kind: "digest", trigger: o.trigger || "" });
    results.push(Object.assign({ to: [t.email], subject, merged: true,
      types: parts.map(p => p.key), labels: parts.map(p => p.label) }, x));
  }
  const sent = results.filter(x => x.ok);
  if (!sent.length) {
    const allSkipped = results.length && results.every(x => x.skipped);
    const first = results.find(x => x.msg) || {};
    return { ok: allSkipped, skipped: allSkipped, to: [], results, msg: first.msg || "没有可发送的内容" };
  }
  return { ok: true, to: sent.map(x => x.to[0]), channel: (sent.find(x => x.channel) || {}).channel || "", results, msg: "" };
}
/* 今日是否已完整发过：以 lastDigest 为准；兼容升级当天旧版按类型分开发的记录。
   周报日若只发过日报、周报还没发，仍要继续补一次（不会重复日报，sentTo 会兜住）。 */
function digestDone(st, key, withWeekly) {
  if (st.lastDigest === key) return true;
  if (st.lastDaily === key || st.lastPersonal === key || st.lastRisk === key) {
    if (!withWeekly) { st.lastDigest = key; saveUsers(); return true; }
    if (st.lastWeekly === key || st.weeklyDay === key) { st.lastDigest = key; saveUsers(); return true; }
    return false;
  }
  return false;
}
/* 定时任务统一入口：每个订阅账号只发 1 封合并邮件（周五含本周周报）。
   幂等：按「日期 + 已成功收件人」记录，失败的下一次自动重试，成功的不重复发。 */
let scheduledLock = false;
async function runScheduled(day, opts) {
  const o = opts || {};
  if (scheduledLock) return { ok: true, skipped: "正在发送中" };
  scheduledLock = true;
  try {
    const theDay = day || bjKey(Date.now());
    const withWeekly = isWeeklyDay(theDay);
    const st = mailState();
    const sentToday = (st.sentTo && Array.isArray(st.sentTo[theDay])) ? st.sentTo[theDay] : [];
    if (!o.force && digestDone(st, theDay, withWeekly)) return { ok: true, skipped: "今日已发", withWeekly, day: theDay };
    if (!o.onlyTo && !digestSubscribers(withWeekly).length && !mailTo().length) return { ok: true, skipped: "没有订阅收件人", withWeekly, day: theDay };
    const out = await sendDigestAll(theDay, {
      withWeekly, onlyTo: o.onlyTo, trigger: o.trigger || "auto",
      skipEmails: o.force || o.onlyTo ? [] : sentToday,
    });
    const st2 = mailState();
    st2.sentTo = st2.sentTo || {};
    const cur = new Set((st2.sentTo[theDay] || []).map(x => String(x).toLowerCase()));
    if (!o.onlyTo) (out.results || []).forEach(r => { if (r.ok && r.to && r.to[0]) cur.add(String(r.to[0]).toLowerCase()); });
    st2.sentTo[theDay] = [...cur];
    /* 只保留最近 14 天的已发记录，避免账号文件无限膨胀 */
    Object.keys(st2.sentTo).forEach(k => { if (k < dayAdd(theDay, -14)) delete st2.sentTo[k]; });
    const failed = (out.results || []).filter(r => r.ok === false && !r.skipped);
    if (!o.onlyTo && !failed.length && (out.ok || out.skipped)) {
      st2.lastDigest = theDay;
      st2.lastDaily = theDay; st2.lastPersonal = theDay; st2.lastRisk = theDay;
      if (withWeekly) { st2.lastWeekly = theDay; st2.weeklyDay = theDay; }
      st2.lastSent = Date.now();
      st2.tries = {};
    } else if (failed.length) {
      st2.tries = st2.tries || {};
      st2.tries[theDay] = (st2.tries[theDay] || 0) + 1;
      st2.lastFail = { at: Date.now(), day: theDay, msg: (failed[0] && failed[0].msg) || out.msg || "发送失败" };
    }
    saveUsers();
    return Object.assign({ ok: out.ok, day: theDay, withWeekly, sentTo: st2.sentTo[theDay], failed: failed.length }, out);
  } finally { scheduledLock = false; }
}
/* 按类型生成邮件内容（供「邮件中心」预览 / 手动发送，与自动发送共用同一套统计口径） */
function reportOf(type, day, ids) {
  const theDay = day || bjKey(Date.now());
  const allNewbies = (USERS.users || []).filter(u => u.role === "newbie" && u.active);
  const sel = ids && ids.length ? allNewbies.filter(u => ids.indexOf(u.id) >= 0) : allNewbies;
  const scope = ids && ids.length ? ids : undefined;
  if (type === "weekly") {
    const r = buildWeeklyReport(theDay, { newbieIds: scope });
    return { subject: `【周报】${r.range.start}～${r.range.end} 新人培养周报`, html: r.html,
      note: `手动发送 · ${r.range.current ? "本周（周一至发送日）" : "上一自然周（周一至周日）"}。` };
  }
  if (type === "personal") {
    const r = buildPersonalReport(sel, theDay);
    return { subject: `【个人汇总】${theDay} 学习进展与风险提示`, html: r.html,
      note: "手动发送 · 个人汇总（含目标达成率与风险提示）。" };
  }
  if (type === "risk") {
    const r = buildRiskReport(sel, theDay);
    if (!r) return null;
    return { subject: `【风险预警】${theDay} 有 ${r.count} 位新人需要关注`, html: r.html,
      note: "手动发送 · 仅列有风险的新人。" };
  }
  const r = buildDailyReport(theDay, { newbieIds: scope });
  return { subject: `【每日进度】${r.today} 新人培养整体进度`, html: r.html,
    note: `手动发送 · 工作日 ${getMailCfg().reportHour}:00 汇总。` };
}
/* 供 GitHub Actions 定时任务拉取日报（只生成内容，不在服务端发送；Render 免费实例会休眠，定时器不可靠） */
function reportPayload() {
  const r = buildDailyReport();
  const subject = `【每日进度】${r.today} 新人培养整体进度`;
  const note = `自动发送 · 工作日 ${getMailCfg().reportHour}:00 汇总。`;
  return { to: mailTo(), subject, html: mailShell(subject, r.html, note), from: MAIL_FROM, replyTo: MAIL_REPLY_TO, today: r.today };
}
/* 工作日到点自动发：每分钟检查一次（实例醒着时 18:00 准点发出）。
   Render 免费实例会休眠，所以真正的准点保障靠 GitHub Actions 定时唤醒 + /api/daily_ping。
   发送失败会自动重试：每次间隔 5 分钟，当天最多 6 次；成功后不再重复。 */
function startDailyReportTimer() {
  setInterval(() => {
    if (!MAIL_ON) return;
    const cfg = getMailCfg();
    const d = bj(Date.now());
    const wd = d.getUTCDay(), hour = d.getUTCHours();
    if (wd === 0 || wd === 6) return;
    if (hour < cfg.reportHour) return;
    const key = bjKey(Date.now());
    const withWeekly = isWeeklyDay(key);
    const st = mailState();
    if (digestDone(st, key, withWeekly)) return;
    if (!digestSubscribers(withWeekly).length && !mailTo().length) return;
    const tries = (st.tries && st.tries[key]) || 0;
    if (tries >= 6) return;
    if (MS.lastTry && Date.now() - MS.lastTry < 5 * 60000) return;
    MS.lastTry = Date.now(); saveMS();
    runScheduled(key, { trigger: "timer" }).then(r => {
      if (!r.ok) console.log("[mail] 定时发送未完成：", r.msg || "");
      else if (!r.skipped) console.log("[mail] 定时邮件已处理：" + key + (r.withWeekly ? "（含周报）" : ""));
    });
  }, 60000);
}

/* ---------- GitHub 持久化 ---------- */
async function ghFetchPath(pathInRepo, method, body) {
  const url = `https://api.github.com/repos/${GH_REPO}/contents/${pathInRepo}` + (method === "GET" ? `?ref=${GH_BRANCH}` : "");
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "q4-workbench" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error("GitHub " + res.status);
  return res.json();
}
const ghFetch = (method, body) => ghFetchPath(GH_PATH, method, body);
async function ghGetJson(pathInRepo) {
  const cur = await ghFetchPath(pathInRepo, "GET");
  if (!cur || !cur.content) return null;
  return JSON.parse(Buffer.from(cur.content, "base64").toString("utf8"));
}
async function ghPutJson(pathInRepo, obj, tag) {
  let shaPrev = null;
  try { const cur = await ghFetchPath(pathInRepo, "GET"); if (cur && cur.sha) shaPrev = cur.sha; } catch (e) {}
  await ghFetchPath(pathInRepo, "PUT", {
    message: tag + " " + new Date().toISOString(),
    content: Buffer.from(JSON.stringify(obj)).toString("base64"),
    branch: GH_BRANCH, sha: shaPrev || undefined,
  });
}
async function ghPush() {
  if (!GH_ON || !DOC) return;
  try { await ghPutJson(GH_PATH, DOC, "workbench sync"); }
  catch (e) { console.error("[ghPush]", e.message); }
}
async function ghPull() {
  if (!GH_ON) return;
  try {
    const d = await ghGetJson(GH_PATH);
    if (d) { DOC = normDoc(d); console.log("[ghPull] loaded from GitHub"); }
  } catch (e) { console.error("[ghPull]", e.message); }
}
async function ghPushUsers() {
  if (!GH_ON || !USERS) return;
  try { await ghPutJson(GH_USERS_PATH, USERS, "users sync"); }
  catch (e) { console.error("[ghPushUsers]", e.message); }
}
async function ghPullUsers() {
  if (!GH_ON) return false;
  try {
    const d = await ghGetJson(GH_USERS_PATH);
    if (d && Array.isArray(d.users) && d.users.length) { USERS = d; console.log("[ghPullUsers] loaded from GitHub"); return true; }
  } catch (e) { console.error("[ghPullUsers]", e.message); }
  return false;
}

/* ---------- Supabase 读写（PostgREST） ---------- */
function sbHeaders(extra) {
  return Object.assign({
    apikey: SB_KEY,
    Authorization: "Bearer " + SB_KEY,
    "Content-Type": "application/json",
  }, extra || {});
}
async function sbGet(key) {
  const r = await fetch(`${SB_URL}/rest/v1/${SB_TABLE}?k=eq.${encodeURIComponent(key)}&select=v`, { headers: sbHeaders() });
  if (!r.ok) throw new Error("Supabase GET " + r.status + " " + (await r.text()).slice(0, 160));
  const rows = await r.json();
  return rows && rows[0] ? rows[0].v : null;
}
async function sbPut(key, value) {
  const r = await fetch(`${SB_URL}/rest/v1/${SB_TABLE}`, {
    method: "POST",
    headers: sbHeaders({ Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify([{ k: key, v: value, updated_at: new Date().toISOString() }]),
  });
  if (!r.ok) throw new Error("Supabase PUT " + r.status + " " + (await r.text()).slice(0, 160));
}
async function sbPullUsers() {
  if (!SB_ON) return false;
  try {
    const d = await sbGet("users");
    if (d && Array.isArray(d.users) && d.users.length) { USERS = d; console.log("[sbPullUsers] loaded from Supabase"); return true; }
  } catch (e) { console.error("[sbPullUsers]", e.message); }
  return false;
}
async function sbPullDoc() {
  if (!SB_ON) return;
  try {
    const d = await sbGet("state");
    if (d) { DOC = normDoc(d); console.log("[sbPullDoc] loaded from Supabase"); }
  } catch (e) { console.error("[sbPullDoc]", e.message); }
}
async function sbPushUsers() { if (!SB_ON || !USERS) return; try { await sbPut("users", USERS); } catch (e) { console.error("[sbPushUsers]", e.message); } }
async function sbPushDoc() { if (!SB_ON || !DOC) return; try { await sbPut("state", DOC); } catch (e) { console.error("[sbPushDoc]", e.message); } }

/* ---------- 企业微信（可选）：换取 access_token / userid ---------- */
let WX_TOKEN = { v: "", exp: 0 };
async function wecomAccessToken() {
  if (WX_TOKEN.v && Date.now() < WX_TOKEN.exp) return WX_TOKEN.v;
  const r = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${WECOM_CORPID}&corpsecret=${WECOM_SECRET}`);
  const d = await r.json();
  if (d.errcode) throw new Error("wecom gettoken errcode=" + d.errcode);
  WX_TOKEN = { v: d.access_token, exp: Date.now() + (d.expires_in - 120) * 1000 };
  return WX_TOKEN.v;
}
async function wecomUseridByCode(code) {
  const t = await wecomAccessToken();
  const r = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/auth/getuserinfo?access_token=${t}&code=${encodeURIComponent(code)}`);
  const d = await r.json();
  if (d.errcode) throw new Error("wecom getuserinfo errcode=" + d.errcode);
  return d.userid || d.openid || "";
}

/* ---------- SSE 实时推送 ---------- */
const sseClients = new Set();
function broadcast() {
  const payload = `data: ${JSON.stringify({ ts: Date.now() })}\n\n`;
  for (const res of sseClients) { try { res.write(payload); } catch (e) {} }
}

/* ---------- Express ---------- */
const app = express();
app.use(express.json({ limit: "8mb" }));
app.use((req, res, next) => { res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type,x-token");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204); next(); });

/* 登录页需要：角色清单 + 企业微信是否可用（不对外暴露任何账号密码） */
app.get("/api/config", (req, res) => {
  res.json({ ok: true, roles: ROLES, roleName: ROLE_NAME,
    users: (USERS.users || []).filter(u => u.active).map(pubUser),
    initialized: !!(DOC && Object.keys(DOC.people || {}).length),
    wecom: { enabled: WECOM_ON, corpid: WECOM_CORPID, agentid: WECOM_AGENTID },
    github: GH_ON, supabase: SB_ON, publicUrl: PUBLIC_URL });
});

/* 账号 + 密码登录 */
app.post("/api/login", (req, res) => {
  const username = (req.body && req.body.username || "").trim().toLowerCase();
  const password = (req.body && req.body.password || "");
  const u = findByUsername(username);
  if (!u) return res.status(401).json({ ok: false, msg: "账号或密码不正确" });
  if (!u.active) return res.status(403).json({ ok: false, msg: "账号已停用，请联系管理员" });
  if (!u.activated) return res.status(403).json({ ok: false, msg: "账号未激活：请使用管理员发来的邀请链接设置密码" });
  if (hashPass(password, u.salt) !== u.pass) return res.status(401).json({ ok: false, msg: "账号或密码不正确" });
  if (u.role === "newbie") { try { recordLogin(u); } catch (e) { console.error("[mail] login", e.message); } }
  res.json({ ok: true, token: userToken(u), user: pubUser(u), roleName: ROLE_NAME[u.role] });
});

/* ---------- 学员自助注册：姓名 + 用户名 + 密码 → 注册即「新人」身份 ---------- */
app.post("/api/register", (req, res) => {
  const b = req.body || {};
  const name = String(b.name || "").trim();
  const username = String(b.username || "").trim().toLowerCase();
  const password = String(b.password || "");
  if (!name) return res.status(400).json({ ok: false, msg: "请填写姓名" });
  if (!/^[a-z0-9_]{3,20}$/.test(username)) return res.status(400).json({ ok: false, msg: "用户名需为 3–20 位小写字母 / 数字 / 下划线" });
  if (password.length < 4) return res.status(400).json({ ok: false, msg: "密码至少 4 位" });
  if (findByUsername(username)) return res.status(409).json({ ok: false, msg: "该用户名已被占用，请换一个" });
  const salt = newSalt();
  const u = { id: uid(), username, name, role: "newbie", salt,
    pass: hashPass(password, salt), active: true, activated: true, invite: null,
    mustReset: false, wecom: "", pwless: false, createdAt: Date.now() };
  USERS.users.push(u);
  saveUsers();
  res.json({ ok: true, token: userToken(u), user: pubUser(u), roleName: ROLE_NAME[u.role] });
});

app.get("/api/me", (req, res) => {
  const me = tokenFromReq(req);
  if (!me) return res.status(401).json({ ok: false, msg: "未登录或会话失效" });
  res.json({ ok: true, user: pubUser(me), roleName: ROLE_NAME[me.role] });
});

/* ---------- 邀请链接（本人首次进入必须设置一个自己的密码） ---------- */
app.get("/api/invite_info", (req, res) => {
  const u = findByInvite(req.query.invite);
  if (!u) return res.json({ ok: false, msg: "邀请链接无效或已使用" });
  if (!u.active) return res.json({ ok: false, msg: "账号已停用，请联系管理员" });
  res.json({ ok: true, name: u.name, role: u.role, roleName: ROLE_NAME[u.role], username: u.username });
});
app.post("/api/activate", (req, res) => {
  const b = req.body || {};
  const u = findByInvite(b.invite);
  if (!u) return res.status(400).json({ ok: false, msg: "邀请链接无效或已使用" });
  if (!u.active) return res.status(403).json({ ok: false, msg: "账号已停用，请联系管理员" });
  const np = String(b.password || "");
  if (np.length < 4) return res.status(400).json({ ok: false, msg: "请设置至少 4 位密码（不接受免密码进入）" });
  u.salt = newSalt();
  u.pass = hashPass(np, u.salt);
  u.pwless = false;
  u.activated = true; u.invite = null; u.mustReset = false;
  saveUsers();
  res.json({ ok: true, token: userToken(u), user: pubUser(u), roleName: ROLE_NAME[u.role] });
});

app.get("/api/state", (req, res) => {
  const me = tokenFromReq(req);
  if (!me) return res.status(401).json({ ok: false, msg: "未登录或会话失效" });
  res.json({ ok: true, who: me.id, role: me.role, doc: DOC || null });
});

app.post("/api/save", async (req, res) => {
  const me = tokenFromReq(req);
  if (!me) return res.status(401).json({ ok: false, msg: "未登录或会话失效" });
  const incoming = normDoc(req.body && req.body.doc);
  const oldIds = new Set(((DOC && DOC.issues && DOC.issues.list) || []).map(x => x.id));
  DOC = DOC ? mergeDoc(DOC, incoming) : incoming;
  DOC.t = Date.now();
  ensureDir(); writeJson(STATE_FILE, DOC);
  broadcast();
  sbPushDoc();
  ghPush();
  /* 新人新发的问题 / 诉求 → 立即邮件提醒导师、主管 */
  try {
    const fresh = ((DOC.issues && DOC.issues.list) || []).filter(x => !x.del && !oldIds.has(x.id) && findUser(x.who) && findUser(x.who).role === "newbie");
    if (fresh.length) notifyNewIssues(fresh);
  } catch (e) { console.error("[mail] issue", e.message); }
  res.json({ ok: true, doc: DOC });
});

/* ---------- 账号管理（仅超级管理员） ---------- */
function requireAdmin(req, res) {
  const me = tokenFromReq(req);
  if (!me) { res.status(401).json({ ok: false, msg: "未登录或会话失效" }); return null; }
  if (me.role !== "admin") { res.status(403).json({ ok: false, msg: "仅超级管理员可管理账号" }); return null; }
  return me;
}

app.get("/api/users", (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ ok: true, teamPasscode: USERS.teamPasscode || "",
    users: (USERS.users || []).map(u => Object.assign(pubUser(u), { email: u.email || "", mentorId: u.mentorId || "", leadId: u.leadId || "",
      mailTypes: Array.isArray(u.mailTypes) ? u.mailTypes.slice() : defaultMailTypes(u.role),
      mailScope: u.role === "newbie" ? [u.id] : (u.mailScope === "all" ? "all" : (Array.isArray(u.mailScope) ? u.mailScope.slice() : "all")),
      mailAuto: u.mailAuto !== false,
      inviteUrl: u.invite ? inviteUrl(u) : "" })) });
});

/* 团队口令（可选）：全组共用一个，开启后「选名字进入」需带上它；留空=完全免口令 */
app.post("/api/team_passcode", (req, res) => {
  const me = requireAdmin(req, res); if (!me) return;
  const np = String((req.body || {}).passcode || "").trim();
  if (np && (np.length < 3 || np.length > 20)) return res.status(400).json({ ok: false, msg: "团队口令请用 3–20 个字符（或留空表示不需要口令）" });
  USERS.teamPasscode = np; USERS.changed = true; saveUsers();
  res.json({ ok: true, needPasscode: !!np });
});

app.post("/api/users", (req, res) => {
  const me = requireAdmin(req, res); if (!me) return;
  const b = req.body || {};
  const username = String(b.username || "").trim().toLowerCase();
  const name = String(b.name || "").trim();
  const role = String(b.role || "").trim();
  const password = String(b.password || "");
  if (!/^[a-z0-9_]{3,20}$/.test(username)) return res.status(400).json({ ok: false, msg: "登录名需 3–20 位小写字母/数字/下划线" });
  if (!name) return res.status(400).json({ ok: false, msg: "请填写姓名" });
  if (ROLES.indexOf(role) < 0) return res.status(400).json({ ok: false, msg: "角色无效" });
  if (findByUsername(username)) return res.status(409).json({ ok: false, msg: "登录名已存在" });
  const salt = newSalt();
  const id = uid();
  const email = String(b.email || "").trim();
  if (email && !validEmail(email)) return res.status(400).json({ ok: false, msg: "邮箱格式不正确" });
  /* 新账号自带默认邮件订阅：新人只收自己的个人日报/周报；导师/主管收整体汇总 */
  const subs = { email, mailTypes: defaultMailTypes(role), mailScope: role === "newbie" ? [id] : "all", mailAuto: true };
  let u;
  if (password) {
    if (password.length < 4) return res.status(400).json({ ok: false, msg: "密码至少 4 位" });
    u = Object.assign({ id, username, name, role, salt, pass: hashPass(password, salt), active: true, activated: true, invite: null, mustReset: true, wecom: "", pwless: false, createdAt: Date.now() }, subs);
  } else {
    // 不设密码 → 生成邀请链接，由本人自己设密码（管理员无需记录任何口令）
    u = Object.assign({ id, username, name, role, salt, pass: "", active: true, activated: false, invite: newInvite(), mustReset: false, wecom: "", pwless: false, createdAt: Date.now() }, subs);
  }
  USERS.users.push(u); USERS.changed = true; saveUsers();
  res.json({ ok: true, user: Object.assign(pubUser(u), { inviteUrl: u.invite ? inviteUrl(u) : "" }) });
});

app.post("/api/user_update", (req, res) => {
  const me = requireAdmin(req, res); if (!me) return;
  const b = req.body || {};
  const u = findUser(String(b.id || ""));
  if (!u) return res.status(404).json({ ok: false, msg: "账号不存在" });
  if (b.name != null && String(b.name).trim()) u.name = String(b.name).trim();
  if (b.role != null && ROLES.indexOf(b.role) >= 0) {
    if (u.id === me.id && b.role !== "admin") return res.status(400).json({ ok: false, msg: "不能取消自己的超级管理员角色" });
    if (u.role === "newbie" && b.role !== "newbie") { /* 允许转岗，不改动历史数据 */ }
    u.role = b.role;
  }
  if (b.active != null) {
    if (u.id === me.id && !b.active) return res.status(400).json({ ok: false, msg: "不能停用当前登录账号" });
    u.active = !!b.active;
  }
  if (b.wecom != null) u.wecom = String(b.wecom).trim();
  if (b.email != null) {
    const em = String(b.email).trim();
    if (em && !validEmail(em)) return res.status(400).json({ ok: false, msg: "邮箱格式不正确" });
    u.email = em;
  }
  /* 邮件订阅：类型可多选；关注新人 all=全部，或新人 id 数组。新人固定为本人、且只允许个人日报/周报。 */
  if (b.mailTypes != null) {
    let types = (Array.isArray(b.mailTypes) ? b.mailTypes : []).map(String).filter(t => MAIL_TYPE_NAME[t]);
    u.mailTypes = u.role === "newbie" ? types.filter(t => NEWBIE_MAIL_TYPES.indexOf(t) >= 0) : types;
  }
  if (b.mailAuto != null) u.mailAuto = !!b.mailAuto;
  if (b.mailScope != null) {
    if (u.role === "newbie") u.mailScope = [u.id];
    else if (b.mailScope === "all") u.mailScope = "all";
    else u.mailScope = (Array.isArray(b.mailScope) ? b.mailScope : []).map(String).filter(id => findUser(id));
  }
  /* 直属导师 / 直属主管：只影响「提醒邮件发给谁」，不改变任何业务数据 */
  if (b.mentorId != null) u.mentorId = String(b.mentorId).trim();
  if (b.leadId != null) u.leadId = String(b.leadId).trim();
  /* 转岗后保持订阅合法：新人只看自己；不再是新人且范围只有自己时改为全部 */
  if (u.role === "newbie") u.mailScope = [u.id];
  else if (!Array.isArray(u.mailTypes)) u.mailTypes = defaultMailTypes(u.role);
  if (u.role !== "newbie" && Array.isArray(u.mailScope) && u.mailScope.length === 1 && u.mailScope[0] === u.id) u.mailScope = "all";
  if (b.password != null && String(b.password).length) {
    const np = String(b.password);
    if (np.length < 4) return res.status(400).json({ ok: false, msg: "密码至少 4 位" });
    u.salt = newSalt(); u.pass = hashPass(np, u.salt); u.activated = true; u.invite = null; u.mustReset = true;
  }
  USERS.changed = true; saveUsers();
  res.json({ ok: true, user: Object.assign(pubUser(u), { inviteUrl: u.invite ? inviteUrl(u) : "" }) });
});

/* 重新生成邀请链接（等于重置：本人再次设密码即可，无需管理员记口令） */
app.post("/api/user_invite", (req, res) => {
  const me = requireAdmin(req, res); if (!me) return;
  const u = findUser(String((req.body || {}).id || ""));
  if (!u) return res.status(404).json({ ok: false, msg: "账号不存在" });
  if (u.id === me.id) return res.status(400).json({ ok: false, msg: "不能对自己生成邀请链接，请直接用「改密码」" });
  u.invite = newInvite(); u.activated = false; u.pass = "";
  USERS.changed = true; saveUsers();
  res.json({ ok: true, user: Object.assign(pubUser(u), { inviteUrl: inviteUrl(u) }) });
});

app.post("/api/user_delete", (req, res) => {
  const me = requireAdmin(req, res); if (!me) return;
  const id = String(req.body && req.body.id || "");
  if (id === me.id) return res.status(400).json({ ok: false, msg: "不能删除当前登录账号" });
  const u = findUser(id);
  if (!u) return res.status(404).json({ ok: false, msg: "账号不存在" });
  if (u.role === "admin" && (USERS.users || []).filter(x => x.role === "admin").length <= 1)
    return res.status(400).json({ ok: false, msg: "至少保留一个超级管理员" });
  USERS.users = USERS.users.filter(x => x.id !== id);
  USERS.changed = true; saveUsers();
  res.json({ ok: true });
});

/* 本人改密码（免口令用户无需原密码，直接补设一个密码以便换设备登录） */
app.post("/api/passwd", (req, res) => {
  const me = tokenFromReq(req);
  if (!me) return res.status(401).json({ ok: false, msg: "未登录或会话失效" });
  const b = req.body || {};
  if (!me.pwless && hashPass(String(b.oldPassword || ""), me.salt) !== me.pass) return res.status(401).json({ ok: false, msg: "原密码不正确" });
  const np = String(b.newPassword || "");
  if (np.length < 4) return res.status(400).json({ ok: false, msg: "新密码至少 4 位" });
  me.salt = newSalt(); me.pass = hashPass(np, me.salt); me.mustReset = false; me.pwless = false;
  USERS.changed = true; saveUsers();
  res.json({ ok: true, token: userToken(me) });
});

/* ---------- 邮件通知：状态 / 测试 / 立即发送日报（导师、主管、超管可用） ---------- */
function requireStaff(req, res) {
  const me = tokenFromReq(req);
  if (!me) { res.status(401).json({ ok: false, msg: "未登录或会话失效" }); return null; }
  if (["lead", "mentor", "admin"].indexOf(me.role) < 0) { res.status(403).json({ ok: false, msg: "仅导师 / 主管 / 超管可用" }); return null; }
  return me;
}
app.get("/api/mail_status", (req, res) => {
  if (!requireStaff(req, res)) return;
  const cfg = getMailCfg();
  const st = mailState();
  const today = bjKey(Date.now());
  const withWeekly = isWeeklyDay(today);
  const sentToday = (st.sentTo && st.sentTo[today]) || [];
  const targets = digestSubscribers(withWeekly).map(t => t.email);
  res.json({ ok: true, enabled: MAIL_ON, channel: MAIL_CHANNEL, smtpHost: SMTP_ON ? SMTP_HOST : "", smtpUser: SMTP_ON ? SMTP_USER : "",
    from: MAIL_FROM, replyTo: MAIL_REPLY_TO, to: mailTo(), reportHour: cfg.reportHour,
    lastSent: MS.lastSent || 0, lastReport: MS.lastReport || "", today,
    schedule: { hour: cfg.reportHour, weekday: WEEKLY_WEEKDAY, weekdayName: "周五", timezone: "北京时间" },
    todayState: {
      isWorkday: [0, 6].indexOf(bj(today).getUTCDay()) < 0,
      isWeeklyDay: withWeekly,
      done: st.lastDigest === today
        || (!withWeekly && (st.lastDaily === today || st.lastPersonal === today || st.lastRisk === today))
        || (withWeekly && (st.weeklyDay === today || st.lastWeekly === today)),
      sentTo: sentToday,
      pending: targets.filter(e => sentToday.map(x => x.toLowerCase()).indexOf(e.toLowerCase()) < 0),
      tries: (st.tries && st.tries[today]) || 0,
      lastFail: st.lastFail && st.lastFail.day === today ? st.lastFail : null,
    },
    log: recentMailLog(30) });
});
app.post("/api/mail_test", async (req, res) => {
  const me = requireStaff(req, res); if (!me) return;
  /* 测试只发给操作人自己，避免打扰其他导师/主管/新人；也支持显式传 to */
  const b = req.body || {};
  const ask = (Array.isArray(b.to) ? b.to : String(b.to || "").split(",")).map(x => String(x).trim()).filter(validEmail);
  const self = validEmail(me.email) ? me.email : "";
  const to = ask.length ? ask : (self ? [self] : []);
  if (!to.length) return res.status(400).json({ ok: false, msg: "你的账号还没填邮箱，无法给自己发测试邮件（也可以手动填一个收件邮箱）" });
  const r = await sendMail("【测试】Q4 工作台邮件通知链路已连通",
    `<p>这是一封测试邮件。</p><p>收到它说明邮件通道（QQ 邮箱 SMTP / Resend）、发件人、收件人都已配置正确。</p>
     <p style="color:#5C6772;font-size:13px">后续会在工作日 ${getMailCfg().reportHour}:00 自动发送：整体日报 + 个人汇总 + 风险预警，周五加发本周周报（按账号订阅合并为 1 封）。</p>`,
    "测试邮件 · 手动触发", { to, kind: "test", trigger: "manual" });
  res.status(r.ok ? 200 : 400).json(r);
});
app.post("/api/mail_report", async (req, res) => {
  const me = requireStaff(req, res); if (!me) return;
  /* 可选 ?day=YYYY-MM-DD 补发指定某天；?to=邮箱 只发给该邮箱（验证用，不影响其他人）；
     ?force=1 忽略「今日已发」强制重发。默认发给全部自动订阅账号。 */
  const day = String(req.query.day || "");
  const theDay = /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : bjKey(Date.now());
  const bodyTo = (req.body && req.body.to) || "";
  const toList = (Array.isArray(bodyTo) ? bodyTo : String(bodyTo || "").split(",")).map(x => String(x).trim().toLowerCase()).filter(validEmail);
  /* ?self=1：只发给操作人自己，用于验证，不打扰其他人 */
  const selfOnly = String(req.query.self || "") === "1" && validEmail(me.email);
  const onlyTo = toList[0] || (selfOnly ? me.email : "");
  const force = String(req.query.force || "") === "1" || !!onlyTo;
  const r = await runScheduled(theDay, { force, onlyTo, trigger: onlyTo ? "manual-test" : "manual" });
  res.status(r.ok ? 200 : 400).json(r);
});

/* ---------- 邮件基础配置 / 订阅查询（配置入口统一在「账号管理」） ---------- */
function mailCfgPayload() {
  const cfg = getMailCfg();
  const users = (USERS.users || []).map(u => ({ id: u.id, name: u.name, username: u.username,
    role: u.role, roleName: ROLE_NAME[u.role], email: u.email || "", active: !!u.active,
    mentorId: u.mentorId || "", leadId: u.leadId || "",
    mailTypes: Array.isArray(u.mailTypes) ? u.mailTypes.slice() : defaultMailTypes(u.role),
    mailScope: u.role === "newbie" ? [u.id] : (u.mailScope === "all" ? "all" : (Array.isArray(u.mailScope) ? u.mailScope.slice() : "all")),
    mailAuto: u.mailAuto !== false }));
  return {
    ok: true, enabled: MAIL_ON, channel: MAIL_CHANNEL,
    types: MAIL_TYPES.map(x => ({ key: x[0], name: x[1] })),
    cfg, users,
    newbies: users.filter(u => u.role === "newbie" && u.active),
    staff: users.filter(u => u.role !== "newbie" && u.active),
    today: bjKey(Date.now()), lastSent: MS.lastSent || 0, state: mailState(),
  };
}
app.get("/api/mail_cfg", (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(mailCfgPayload());
});
app.post("/api/mail_cfg", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const cfg = saveMailCfg(req.body || {});
  res.json({ ok: true, cfg });
});
/* 预览：返回渲染好的邮件 HTML，供后台直接看内容（不发送） */
app.get("/api/mail_preview", (req, res) => {
  if (!requireStaff(req, res)) return;
  const type = String(req.query.type || "daily");
  if (!MAIL_TYPE_NAME[type]) return res.status(400).json({ ok: false, msg: "未知的邮件类型" });
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.day || "")) ? String(req.query.day) : bjKey(Date.now());
  const ids = String(req.query.ids || "").split(",").map(x => x.trim()).filter(Boolean);
  const r = reportOf(type, day, ids);
  if (!r) return res.json({ ok: true, empty: true, day, subject: "无内容", html: mailShell("无内容", "<p>当前没有符合条件的内容（例如今日无风险项）。</p>", "预览") });
  res.json({ ok: true, day, subject: r.subject, html: mailShell(r.subject, r.html, r.note) });
});
/* 手动发送：指定类型 / 日期 / 新人范围 / 收件人（收件人留空则按邮件中心规则或兜底收件人） */
app.post("/api/mail_send", async (req, res) => {
  if (!requireStaff(req, res)) return;
  const b = req.body || {};
  const type = String(b.type || "daily");
  if (!MAIL_TYPE_NAME[type]) return res.status(400).json({ ok: false, msg: "未知的邮件类型" });
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(b.day || "")) ? String(b.day) : bjKey(Date.now());
  const ids = Array.isArray(b.ids) ? b.ids.map(String).filter(Boolean) : [];
  let to = (Array.isArray(b.to) ? b.to : String(b.to || "").split(",")).map(x => String(x).trim().toLowerCase()).filter(validEmail);
  /* 没手填收件人时：限定了新人范围，就只取「订阅了这些新人」的规则邮箱，避免把 A 的数据发给只关注 B 的人 */
  if (!to.length) to = ids.length ? [...new Set(ids.flatMap(id => ruleEmails(type, id)))] : ruleEmails(type);
  if (!to.length) to = mailTo();
  if (!to.length) return res.status(400).json({ ok: false, msg: "没有收件人：请填写邮箱，或在邮件中心配置规则" });
  const r = reportOf(type, day, ids);
  if (!r) return res.json({ ok: true, skipped: true, msg: "当前没有符合条件的内容，未发送", to: [] });
  const x = await sendMail(r.subject, r.html, r.note + " · 邮件中心手动发送。", { to, kind: type, trigger: "manual" });
  res.status(x.ok ? 200 : 400).json(Object.assign({ to, subject: r.subject, day, type }, x));
});
/* 账号管理里「手动发送」：按该账号已保存的订阅内容，把指定日期的邮件发到其邮箱。
   · 自动订阅控制的是定时推送；手动发送始终可用，不受 mailAuto 影响。
   · 多项勾选同样合并为 1 封，不再按类型分别发多封。 */
app.post("/api/mail_send_user", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const b = req.body || {};
  const u = findUser(String(b.userId || ""));
  if (!u) return res.status(404).json({ ok: false, msg: "账号不存在" });
  if (!validEmail(u.email)) return res.status(400).json({ ok: false, msg: "该账号还没有填写有效邮箱" });
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(b.day || "")) ? String(b.day) : bjKey(Date.now());
  const types = (Array.isArray(b.types) && b.types.length ? b.types : (u.mailTypes || []))
    .map(String).filter(t => MAIL_TYPE_NAME[t]);
  if (!types.length) return res.status(400).json({ ok: false, msg: "该账号未勾选任何邮件内容" });
  const digestTypes = types.filter(t => DIGEST_TYPES.indexOf(t) >= 0);
  if (!digestTypes.length) return res.status(400).json({ ok: false, msg: "登录提醒 / 问题提醒为事件触发，没有可手动发送的周期内容" });
  const ids = u.role === "newbie" ? [u.id] : (u.mailScope === "all" ? null : (u.mailScope || []));
  const parts = buildDigestParts(day, { email: u.email, types: new Set(digestTypes), ids });
  if (!parts.length) return res.json({ ok: true, skipped: true, msg: "当日无符合条件的内容，未发送", to: [] });
  const subject = digestSubject(day, parts);
  const x = await sendMail(subject, renderDigest(parts),
    `手动发送 · 已按该账号勾选合并为 1 封 · ${day}。`, { to: [u.email], kind: "digest", trigger: "manual-user" });
  res.status(x.ok ? 200 : 400).json(Object.assign({ to: [u.email], subject, day,
    types: parts.map(p => p.key), labels: parts.map(p => p.label), merged: true }, x));
});
/* GitHub Actions 定时任务用它拉取日报内容（备用；主链路是下面的 daily_ping 让服务端自己触发） */
app.get("/api/report_payload", (req, res) => {
  const t = String(req.query.token || "");
  if (!RELAY_TOKEN || t !== RELAY_TOKEN) return res.status(403).json({ ok: false, msg: "口令不正确" });
  try { res.json({ ok: true, mail: reportPayload() }); }
  catch (e) { res.status(500).json({ ok: false, msg: e.message }); }
});
/* 定时唤醒入口：GitHub Actions 在工作日 17:50–19:30 之间多次访问，唤醒免费实例并触发发送。
   特点：
     · 幂等：同一天已发过直接返回 skipped，可安全地被多次调用；
     · 自愈：部分收件人失败时，下一次 ping 会只补发失败的；
     · 可手动：?day=YYYY-MM-DD 补发历史 / ?to=邮箱 只发给自己验证 / ?force=1 强制重发。 */
app.get("/api/daily_ping", async (req, res) => {
  const key = bjKey(Date.now());
  if (!MAIL_ON) return res.json({ ok: false, msg: "邮件通道未配置", skipped: "未配置" });
  const cfg = getMailCfg();
  const d = bj(Date.now());
  const wd = d.getUTCDay(), hour = d.getUTCHours();
  const qDay = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.day || "")) ? String(req.query.day) : "";
  const theDay = qDay || key;
  const toOverride = String(req.query.to || "").trim().toLowerCase();
  const force = String(req.query.force || "") === "1";
  if (!toOverride && !qDay && !force) {
    if (wd === 0 || wd === 6) return res.json({ ok: true, skipped: "周末" });
    if (hour < cfg.reportHour) return res.json({ ok: true, skipped: "未到 " + cfg.reportHour + ":00", hour, now: bjTime(Date.now()) });
  }
  const r = await runScheduled(theDay, { trigger: "ping", force, onlyTo: validEmail(toOverride) ? toOverride : "" });
  if (!toOverride) { MS.lastReport = theDay; saveMS(); }
  res.json({ ok: !!r.ok, msg: r.msg || "", skipped: r.skipped || "", to: r.to || [],
    failed: r.failed || 0, withWeekly: !!r.withWeekly, day: theDay, channel: r.channel || "", result: r });
});

/* ---------- 企业微信扫码登录（可选） ---------- */
app.get("/api/wecom_login", (req, res) => {
  if (!WECOM_ON) return res.status(501).send("企业微信登录未配置");
  const base = PUBLIC_URL || (req.protocol + "://" + req.get("host"));
  const redirect = encodeURIComponent(base + "/api/wecom_callback");
  const state = req.query.to ? "to=" + encodeURIComponent(String(req.query.to)) : "";
  const url = `https://login.work.weixin.qq.com/wwlogin/sso/login?login_type=CorpApp&appid=${WECOM_CORPID}` +
    `&agentid=${WECOM_AGENTID}&redirect_uri=${redirect}&state=${state}`;
  res.redirect(url);
});
app.get("/api/wecom_callback", async (req, res) => {
  const base = PUBLIC_URL || (req.protocol + "://" + req.get("host"));
  try {
    if (!WECOM_ON) throw new Error("未配置企业微信");
    const userid = await wecomUseridByCode(String(req.query.code || ""));
    const u = findByWecom(userid);
    if (!u || !u.active) return res.redirect(base + "/?wxmsg=" + encodeURIComponent("企业微信（账号：" + userid + "）尚未开通，请联系超级管理员在「账号管理」里绑定"));
    return res.redirect(base + "/?token=" + encodeURIComponent(userToken(u)));
  } catch (e) {
    return res.redirect(base + "/?wxmsg=" + encodeURIComponent("企业微信登录失败：" + e.message));
  }
});

// SSE：实时变更通知
app.get("/api/events", (req, res) => {
  const me = tokenFromReq(req);
  if (!me) return res.status(401).end();
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders && res.flushHeaders();
  res.write("retry: 4000\n\n");
  res.write(`data: ${JSON.stringify({ ts: Date.now(), hello: true })}\n\n`);
  sseClients.add(res);
  const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch (e) {} }, 25000);
  req.on("close", () => { clearInterval(ping); sseClients.delete(res); });
});

app.use(express.static(path.join(__dirname, "public")));
/* 未匹配的 /api/* 一律 404（不进入 SPA 兜底），避免已下线的接口被静态页"顶包" */
app.use("/api", (req, res) => res.status(404).json({ ok: false, msg: "接口不存在" }));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

/* ---------- 启动 ---------- */
(async () => {
  ensureDir();
  // 数据恢复优先级：Supabase（云库，最可靠）→ GitHub → 本地文件 → 默认账号
  let usersLoaded = false;
  if (SB_ON) usersLoaded = await sbPullUsers();
  if (!usersLoaded) await ghPullUsers();
  ensureUsers();                // 本地文件兜底；都没有则建默认账号
  if (MAIL_SEED_DIRTY) { MAIL_SEED_DIRTY = false; saveUsers(); console.log("[邮件] 已按初始名单配置邮件订阅（李雯锋/彭灿/詹祥雨/童伟桀）"); }
  loadBank();                   // 产品地图档位/截止日（日报进度判定用）
  rotateLegacyWeakPasswords();  // 历史弱默认密码 → 随机密码（防冒用）
  if (SB_ON) { await sbPullDoc(); if (!DOC) console.log("[boot] Supabase 中尚无业务数据，等待前端首次写入"); }
  else if (GH_ON) await ghPull();
  else if (!DOC) console.log("[boot] 尚无数据，等待前端首次写入");
  app.listen(PORT, () => {
    console.log(`Q4 工作台在线版已启动： http://localhost:${PORT}`);
    console.log(`持久化： ${SB_ON ? "Supabase 云库（" + SB_URL + " · 表 " + SB_TABLE + "）" : GH_ON ? "GitHub " + GH_REPO : "本地 " + STATE_FILE}`);
    console.log(`企业微信扫码登录： ${WECOM_ON ? "已启用（" + WECOM_CORPID + "）" : "未配置（可留空）"}`);
    console.log(`邮件通知： ${MAIL_ON ? "已启用 · " + (MAIL_CHANNEL === "github-actions" ? "GitHub Actions + QQ 邮箱（按人分邮）" : MAIL_CHANNEL === "smtp" ? "QQ/SMTP " + SMTP_HOST : MAIL_CHANNEL === "brevo" ? "Brevo HTTP API" : "Resend") + " · 收件人 " + mailTo().join(",") + " · 工作日 " + REPORT_HOUR + ":00 日报 / 周五 " + REPORT_HOUR + ":00 周报" : "未配置（GH_DISPATCH_TOKEN / SMTP_USER+SMTP_PASS / BREVO_API_KEY / RESEND_API_KEY；登录/问题提醒会记录但不发信）"}`);
    startDailyReportTimer();
    console.log("[账号] 超级管理员初始账号： admin / admin123（请首次登录后立即改密）；其余账号密码见上方日志或由管理员在「账号管理」里设置");
    console.log(`[账号] 当前 ${(USERS.users || []).length} 个账号：` + (USERS.users || []).map(u => `${u.username}(${ROLE_NAME[u.role]}${u.activated ? "" : "·待激活"})`).join(" · "));
  });
})();
