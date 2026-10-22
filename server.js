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
  { id: "lead",   username: "lead",   name: "主管",       role: "lead",   random: true },
  { id: "mentor", username: "mentor", name: "导师",       role: "mentor", random: true },
  { id: "zhan",   username: "zhan",   name: "詹祥雨",     role: "newbie", random: true },
  { id: "tong",   username: "tong",   name: "童伟桀",     role: "newbie", random: true },
];

const sha = s => crypto.createHash("sha256").update(String(s)).digest("hex");
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const newSalt = () => crypto.randomBytes(8).toString("hex");
const newInvite = () => crypto.randomBytes(12).toString("hex");
const hashPass = (p, salt) => sha("p|" + salt + "|" + p + "|" + APP_SECRET);

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
  });
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
    deposits: { t: 0, list: [] }, reveals: { t: 0, list: [] } };
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
  ["carriers", "issues", "drills", "kit", "cards", "quotes", "triggers", "checkins", "deposits", "reveals"].forEach(k => o[k] = mergeList(a[k], b[k]));
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
  ["carriers", "issues", "drills", "kit", "cards", "quotes", "triggers", "checkins", "deposits", "reveals"].forEach(k =>
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
/* 按人分邮：新人相关提醒只发给他的直属导师 + 直属主管 + 兜底收件人。
   账号上没配 mentorId/leadId 时，退化为「全部导师与主管」，保证不漏人。 */
function staffEmailsFor(newbieId) {
  const set = new Set(fallbackEmails());
  const nb = findUser(newbieId);
  const direct = [nb && nb.mentorId, nb && nb.leadId].filter(Boolean).map(findUser).filter(u => u && u.active && u.email);
  if (direct.length) direct.forEach(u => set.add(u.email));
  else (USERS.users || []).forEach(u => { if (u.email && u.active && (u.role === "mentor" || u.role === "lead" || u.role === "admin")) set.add(u.email); });
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
/* 命中某类邮件、且关注范围包含该新人的规则（newbieId 为空时只按类型匹配，用于整体邮件） */
function rulesFor(type, newbieId) {
  return getMailCfg().rules.filter(r => r.enabled !== false && r.types.indexOf(type) >= 0 &&
    (!newbieId || r.scope === "all" || (Array.isArray(r.scope) && r.scope.indexOf(newbieId) >= 0)));
}
function ruleEmails(type, newbieId) {
  return [...new Set(rulesFor(type, newbieId).map(r => r.email).filter(validEmail))];
}
/* 发送记录持久化到账号库：免费实例重启后不会把「今日已发」清空，避免重复发日报 */
function mailState() { if (!USERS.mailState || typeof USERS.mailState !== "object") USERS.mailState = {}; return USERS.mailState; }
function markMailSent(kind, key) { const s = mailState(); s[kind] = key; s.lastSent = Date.now(); saveUsers(); }

/* GitHub Actions 中继：把整封邮件塞进 client_payload（base64，避开引号/换行问题），由 workflow 用 QQ SMTP 发出 */
async function dispatchViaGithub(mail) {
  const b64 = Buffer.from(JSON.stringify(mail), "utf8").toString("base64");
  if (b64.length > 60000) return { ok: false, msg: "邮件内容过大（" + Math.round(b64.length / 1024) + "KB），超出 GitHub 触发载荷上限" };
  const r = await fetch(`https://api.github.com/repos/${GH_DISPATCH_REPO}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + GH_DISPATCH_TOKEN,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "q4-workbench",
    },
    body: JSON.stringify({ event_type: "send-mail", client_payload: { b64 } }),
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
  if (!MAIL_ON) return { ok: false, msg: "未配置邮件通道（GH_DISPATCH_TOKEN 或 SMTP_USER/SMTP_PASS 或 RESEND_API_KEY），已记录事件但未发送" };
  const to = (o.to && o.to.length ? o.to : mailTo());
  if (!to.length) return { ok: false, msg: "没有收件人（配置 ALERT_TO 或给账号填邮箱）" };
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
    "登录提醒 · 自动发送", { to: [...new Set(staffEmailsFor(u.id).concat(ruleEmails("login", u.id)))] });
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
      "问题协助提醒 · 自动发送", { to: [...new Set(staffEmailsFor(who).concat(ruleEmails("issue", who)))] });
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
function mapPaceServer(who, checks, today) {
  if (!BANK || !BANK.levels) return [];
  const done = new Set(checks.filter(x => x.who === who && x.nodeId).map(x => x.nodeId));
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
     · 活跃：当日有登录，或有任何业务动作（打卡/小测/载体/行动/问题/回复/演练/自查/沉淀）
     · 通关节点：以 createdAt 为准（首次完成该节点）
     · 小测正确率：同一节点取当天最后一次作答（重做不重复累计）；累计正确率按每节点最新一次
     · 演练：近 14 天；超期：载体行动 due < 统计截止日
   ===================================================================== */
function buildActivityMap(D) {
  const map = {};
  const add = (who, t, kind) => { if (!who) return; const ms = toMs(t); if (!ms) return; (map[who] = map[who] || []).push({ at: ms, kind }); };
  ((D.checkins || {}).list || []).filter(x => !x.del).forEach(x => {
    add(x.who, x.createdAt, "通关节点");
    const c = toMs(x.createdAt), u = toMs(x.updatedAt);
    if (u && u > c) add(x.who, x.updatedAt, "重做小测");
  });
  /* 只在「确实是后续更新」时记一次更新动作，避免创建当刻 createdAt=updatedAt 被算成两次动作 */
  const upd = (who, c, u, kind) => { if (toMs(u) > toMs(c)) add(who, u, kind); };
  ((D.carriers || {}).list || []).filter(x => !x.del).forEach(c => {
    add(c.who, c.createdAt, "新增载体"); upd(c.who, c.createdAt, c.updatedAt, "更新载体");
    (c.actions || []).filter(v => !v.del).forEach(v => {
      add(c.who, v.createdAt, "新增行动"); upd(c.who, v.createdAt, v.updatedAt, "更新行动");
      (v.log || []).forEach(l => add(l.by || c.who, l.at, "行动记录"));
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
    carriers: (D.carriers.list || []).filter(x => !x.del),
    issues: (D.issues.list || []).filter(x => !x.del),
    drills: (D.drills.list || []).filter(x => !x.del),
    reveals: ((D.reveals || {}).list || []).filter(x => !x.del),
    deposits: ((D.deposits || {}).list || []).filter(x => !x.del),
    activity: buildActivityMap(D),
  };
}
function latestQuizPerNode(list) {
  const m = {};
  list.filter(x => (+x.total) > 0).forEach(x => {
    const k = x.nodeId || x.id;
    const t = toMs(x.updatedAt || x.createdAt);
    const p = m[k];
    if (!p || t >= toMs(p.updatedAt || p.createdAt)) m[k] = x;
  });
  return Object.values(m);
}
function quizSum(list) {
  let correct = 0, total = 0;
  list.forEach(x => { correct += Math.max(0, +x.correct || 0); total += Math.max(0, +x.total || 0); });
  return { correct, total, acc: total > 0 ? Math.round(correct * 100 / total) : null };
}
function goalProgress(who, checks) {
  if (!BANK || !BANK.levels) return null;
  const done = new Set(checks.filter(x => x.who === who && x.nodeId).map(x => x.nodeId));
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
  const quizRecs = ci.filter(x => (+x.total) > 0 && inRange(x.updatedAt || x.createdAt));
  const quizLatest = latestQuizPerNode(quizRecs);
  const q = quizSum(quizLatest);
  const cum = quizSum(latestQuizPerNode(ci));
  const retryRecs = quizRecs.filter(x => !inRange(x.createdAt));

  const cars = snap.carriers.filter(x => x.who === u.id);
  const acts = [];
  cars.forEach(c => (c.actions || []).filter(v => !v.del).forEach(v => acts.push(v)));
  const open = acts.filter(v => (v.st || 0) !== 2);
  const overdue = open.filter(v => { const due = String(v.due || "").slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(due) && due < end; });

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
  return {
    u, days, end, joinsDays: inviteDay ? daysBetween(inviteDay, end) : 999,
    nodesDone: new Set(ci.filter(x => x.nodeId).map(x => x.nodeId)).size,
    /* 只统计真正关联到产品地图节点的记录，避免「自定义学习记录」被当成通关节点虚增 */
    nodesNew: new Set(newRecs.filter(x => x.nodeId).map(x => x.nodeId)).size,
    newRecs, retryRecs,
    quizNodes: quizLatest.length, quizCorrect: q.correct, quizTotal: q.total, quizAcc: q.acc,
    cumCorrect: cum.correct, cumTotal: cum.total, cumAcc: cum.acc,
    cars: cars.length, carsIn: cars.filter(x => inRange(x.createdAt || x.updatedAt)).length,
    open: open.length, overdue: overdue.length,
    ops: ops.length, opsNew: opsNew.length,
    dr14: drills14.length, drTotal: drills.length, avg, hs, hn,
    reveals: reveals.length, revealsIn: reveals.filter(x => inRange(x.at || x.updatedAt)).length,
    deposits: deposits.length, depositsIn: deposits.filter(x => inRange(x.createdAt)).length,
    activityAt, lastKind: lastAct ? lastAct.kind : "", lastActiveAt: lastAt, lastActiveDay: lastAt ? bjKey(lastAt) : "",
    loginAt, activeAt: Math.max(activityAt, loginAt), activeDays: new Set([...actsOn.map(a => bjKey(a.at)), ...loginDays]).size, kinds,
    paces: mapPaceServer(u.id, snap.checkins, end),
    goal: goalProgress(u.id, snap.checkins),
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
  if (s.overdue) out.push(`${nm} 有 ${s.overdue} 条行动已超期`);
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
      <td style="padding:8px 9px;border-bottom:1px solid #E3E8EE">${c.open}${c.overdue ? `<span style="color:#B03A2E"> · 超期 ${c.overdue}</span>` : ""}<div style="font-size:11.5px;color:#7C8896">载体 ${c.cars}${c.carsIn ? ` · 今日动 ${c.carsIn}` : ""}</div></td>
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
    carrierLines.push({ who: c.who, name: c.name, partner: c.partner || "—", next: c.nextDate || "—", open: open.length, total: acts.length });
  });
  const carrierHtml = carrierLines.length
    ? `<table style="border-collapse:collapse;width:100%;font-size:12.5px;margin-top:8px"><tr style="background:#EDF4FA;text-align:left"><th style="padding:6px 8px">新人</th><th style="padding:6px 8px">载体</th><th style="padding:6px 8px">销售搭档</th><th style="padding:6px 8px">下次跟进</th><th style="padding:6px 8px">待办/总</th></tr>${carrierLines.map(c => `<tr><td style="padding:6px 8px;border-bottom:1px solid #E3E8EE">${h(nameOf(c.who))}</td><td style="padding:6px 8px;border-bottom:1px solid #E3E8EE">${h(c.name)}</td><td style="padding:6px 8px;border-bottom:1px solid #E3E8EE">${h(c.partner)}</td><td style="padding:6px 8px;border-bottom:1px solid #E3E8EE">${h(c.next)}</td><td style="padding:6px 8px;border-bottom:1px solid #E3E8EE">${c.open}/${c.total}</td></tr>`).join("")}</table>`
    : "<p style=\"color:#7C8896;font-size:12.5px\">暂无载体记录</p>";

  const wrongCount = {};
  S.checkins.filter(x => scopeIds.has(x.who)).forEach(x => (x.wrong || []).forEach(w => { wrongCount[w] = (wrongCount[w] || 0) + 1; }));
  const topWrong = Object.entries(wrongCount).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const wrongHtml = topWrong.length
    ? `<table style="border-collapse:collapse;width:100%;font-size:12.5px;margin-top:8px"><tr style="background:#EDF4FA;text-align:left"><th style="padding:6px 8px">错题</th><th style="padding:6px 8px">答错次数</th></tr>${topWrong.map(([q, n]) => `<tr><td style="padding:6px 8px;border-bottom:1px solid #E3E8EE">${h(q)}</td><td style="padding:6px 8px;border-bottom:1px solid #E3E8EE;color:#B03A2E">${n}</td></tr>`).join("")}</table>`
    : "<p style=\"color:#7C8896;font-size:12.5px\">暂无错题记录</p>";

  const html = `<p style="margin:0 0 10px"><b>${today}</b> 工作日整体进度${newbies.length ? "" : "（暂无新人账号）"}</p>
     <table style="border-collapse:collapse;width:100%;font-size:13px">
       <tr style="background:#EDF4FA;text-align:left">
         <th style="padding:8px 9px">新人</th><th style="padding:8px 9px">今日活跃（最近动作）</th>
         <th style="padding:8px 9px">地图打卡</th><th style="padding:8px 9px">小测正确率（累计/今日）</th><th style="padding:8px 9px">载体待办</th>
         <th style="padding:8px 9px">未闭环问题</th><th style="padding:8px 9px">近 14 天演练</th><th style="padding:8px 9px">互助/自查/沉淀</th></tr>
       ${rows}
     </table>
     ${needAtt.length ? `<div style="margin-top:14px;background:#FDEDEA;border:1px solid #F3CFC9;border-radius:8px;padding:10px 12px">
       <b style="color:#8C2B1F">需要关注（${needAtt.length} 条）</b><ul style="margin:6px 0 0 18px;padding:0;color:#8C2B1F;font-size:13px">${needAtt.map(t => `<li>${h(t)}</li>`).join("")}</ul></div>`
      : `<p style="margin-top:12px;color:#3C6B1A;font-size:13px">今日各项无明显阻塞。</p>`}
     <div style="margin-top:14px;background:#F0F7FF;border:1px solid #CFE2F3;border-radius:8px;padding:10px 12px">
       <b style="color:#1A5276">今日学习记录（通关节点 / 重做小测）</b>${todayDetailHtml || "<p style=\"color:#7C8896;font-size:12.5px;margin:6px 0 0\">今日暂无打卡或小测</p>"}</div>
     <div style="margin-top:14px;background:#F5FFF0;border:1px solid #CFEBD0;border-radius:8px;padding:10px 12px">
       <b style="color:#3C6B1A">客户载体跟进</b>${carrierHtml}</div>
     <div style="margin-top:14px;background:#FFFBF0;border:1px solid #F3E7C9;border-radius:8px;padding:10px 12px">
       <b style="color:#8A6D1A">高频错题（本次统计范围）</b>${wrongHtml}</div>
     <p style="margin-top:12px;color:#5C6772;font-size:12px">口径：今日活跃=当天有登录或任何业务动作（含打卡/小测/载体/问题/回复/演练/自查/沉淀）；打卡=已通关节点数（今日 +N 为当天首次通关）；小测正确率累计值按每节点最新一次作答计算，同一节点重做不重复累计；待办=载体下未闭环行动；演练=近 14 天；互助分由导师+主管双评认定。全部按北京时间自然日统计。</p>`;
  return { today, card, needAtt, html };
}

/* 周报：默认统计上一个自然周（周一至周日） */
function lastWeekRange(day) {
  const d = new Date(day + "T00:00:00Z");
  const sinceMon = (d.getUTCDay() + 6) % 7;
  const thisMon = dayAdd(day, -sinceMon);
  const end = dayAdd(thisMon, -1);
  const days = [];
  for (let i = 6; i >= 0; i--) days.push(dayAdd(end, -i));
  return { start: days[0], end, days };
}
function buildWeeklyReport(day, opts) {
  const o = opts || {};
  const range = lastWeekRange(day || bjKey(Date.now()));
  const S = snapshot();
  const allNewbies = (USERS.users || []).filter(u => u.role === "newbie" && u.active);
  const newbies = o.newbieIds ? allNewbies.filter(u => o.newbieIds.indexOf(u.id) >= 0) : allNewbies;
  const card = newbies.map(u => userStats(u, range.days, S));
  const needAtt = [];
  card.forEach(c => riskItems(c, "上周").forEach(t => needAtt.push(t)));
  const rows = card.map(c => `<tr>
     <td style="padding:8px 9px;border-bottom:1px solid #E3E8EE;font-weight:700">${h(c.u.name)}</td>
     <td style="padding:8px 9px;border-bottom:1px solid #E3E8EE">${c.activeDays} 天<div style="font-size:11.5px;color:#7C8896">${h(kindText(c.kinds)) || "—"}</div></td>
     <td style="padding:8px 9px;border-bottom:1px solid #E3E8EE">${c.nodesNew} 个<div style="font-size:11.5px;color:#7C8896">累计 ${c.nodesDone}${c.goal ? ` · 目标 ${c.goal.pct}%` : ""}</div></td>
     <td style="padding:8px 9px;border-bottom:1px solid #E3E8EE">${c.quizCorrect}/${c.quizTotal}${c.quizAcc != null ? ` · ${c.quizAcc}%` : ""}</td>
     <td style="padding:8px 9px;border-bottom:1px solid #E3E8EE">${c.dr14} 次${c.avg != null ? ` · 均分 ${c.avg}` : ""}</td>
     <td style="padding:8px 9px;border-bottom:1px solid #E3E8EE">${c.carsIn} 个<div style="font-size:11.5px;color:#7C8896">待办 ${c.open}${c.overdue ? ` · 超期 ${c.overdue}` : ""}</div></td>
     <td style="padding:8px 9px;border-bottom:1px solid #E3E8EE">${c.opsNew} 条<div style="font-size:11.5px;color:#7C8896">未闭环 ${c.ops}</div></td>
     <td style="padding:8px 9px;border-bottom:1px solid #E3E8EE">${c.hs} 分/${c.hn} 条<div style="font-size:11.5px;color:#7C8896">自查 ${c.revealsIn} · 沉淀 ${c.depositsIn}</div></td>
   </tr>`).join("");
  const html = `<p style="margin:0 0 10px"><b>${range.start} ～ ${range.end}</b> 新人培养周报</p>
     <table style="border-collapse:collapse;width:100%;font-size:13px">
       <tr style="background:#EDF4FA;text-align:left">
         <th style="padding:8px 9px">新人</th><th style="padding:8px 9px">活跃天数</th><th style="padding:8px 9px">上周通关</th>
         <th style="padding:8px 9px">上周小测</th><th style="padding:8px 9px">演练（截至上周日）</th><th style="padding:8px 9px">载体</th>
         <th style="padding:8px 9px">新问题</th><th style="padding:8px 9px">互助/自查/沉淀</th></tr>
       ${rows}
     </table>
     ${needAtt.length ? `<div style="margin-top:14px;background:#FDEDEA;border:1px solid #F3CFC9;border-radius:8px;padding:10px 12px">
       <b style="color:#8C2B1F">需要关注（按上周数据，${needAtt.length} 条）</b><ul style="margin:6px 0 0 18px;padding:0;color:#8C2B1F;font-size:13px">${needAtt.map(t => `<li>${h(t)}</li>`).join("")}</ul></div>`
      : `<p style="margin-top:12px;color:#3C6B1A;font-size:13px">上周各项无明显阻塞。</p>`}
     <p style="margin-top:12px;color:#5C6772;font-size:12px">口径同日报：按北京时间自然日；活跃天数=上周一至周日有登录或任何业务动作的天数；通关=上周首次通关节点；小测正确率按每节点上周最后一次作答汇总。</p>`;
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
      <tr><td style="padding:5px 8px;color:#5C6772">待办 / 问题</td><td style="padding:5px 8px">载体待办 ${c.open}${c.overdue ? `（超期 ${c.overdue}）` : ""}；未闭环问题 ${c.ops}</td></tr>
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

function mergeRuleScopes(rules) {
  const m = {};
  rules.forEach(r => {
    if (!m[r.email]) m[r.email] = { email: r.email, all: false, ids: new Set() };
    if (r.scope === "all") m[r.email].all = true;
    else r.scope.forEach(id => m[r.email].ids.add(id));
  });
  return Object.values(m).map(x => ({ email: x.email, ids: x.all ? null : [...x.ids] })).filter(x => x.ids === null || x.ids.length);
}
async function sendDailyAll(day) {
  const cfg = getMailCfg();
  if (!cfg.daily) return { ok: false, msg: "日报已在邮件中心关闭", skipped: true };
  const theDay = day || bjKey(Date.now());
  /* 只保留「范围内仍有在职新人」的规则；勾选的人被删/停用后不再发空表 */
  const aliveIds = new Set((USERS.users || []).filter(u => u.role === "newbie" && u.active).map(u => u.id));
  const rawGroups = mergeRuleScopes(rulesFor("daily"));
  const groups = rawGroups.map(g => ({
    email: g.email, ids: g.ids === null ? null : g.ids.filter(id => aliveIds.has(id)),
  })).filter(g => g.ids === null || g.ids.length);
  if (rawGroups.length && !groups.length) return { ok: true, to: [], skipped: true, msg: "日报规则勾选的新人均已停用/删除，未发送" };
  if (!groups.length) {
    const r = buildDailyReport(theDay);
    return sendMail(`【每日进度】${r.today} 新人培养整体进度`, r.html,
      `自动发送 · 工作日 ${cfg.reportHour}:00 汇总（邮件中心未配置规则时，沿用兜底收件人 + 已填邮箱的导师/主管）。`, { to: mailTo() });
  }
  const results = [];
  for (const g of groups) {
    const r = buildDailyReport(theDay, { newbieIds: g.ids });
    const x = await sendMail(`【每日进度】${r.today} 新人培养整体进度`, r.html,
      `自动发送 · 工作日 ${cfg.reportHour}:00 汇总。`, { to: [g.email] });
    results.push(Object.assign({ to: [g.email] }, x));
  }
  const ok = results.some(x => x.ok);
  return { ok, to: results.map(x => x.to[0]), channel: (results.find(x => x.channel) || {}).channel || "", results,
    msg: ok ? "" : (results[0] && results[0].msg) || "发送失败" };
}
async function sendWeeklyAll(day) {
  const cfg = getMailCfg();
  if (!cfg.weekly) return { ok: false, msg: "周报已在邮件中心关闭", skipped: true };
  const theDay = day || bjKey(Date.now());
  const aliveIds = new Set((USERS.users || []).filter(u => u.role === "newbie" && u.active).map(u => u.id));
  const rawGroups = mergeRuleScopes(rulesFor("weekly"));
  const groups = rawGroups.map(g => ({
    email: g.email, ids: g.ids === null ? null : g.ids.filter(id => aliveIds.has(id)),
  })).filter(g => g.ids === null || g.ids.length);
  if (rawGroups.length && !groups.length) return { ok: true, to: [], skipped: true, msg: "周报规则勾选的新人均已停用/删除，未发送" };
  if (!groups.length) {
    const r = buildWeeklyReport(theDay);
    return sendMail(`【周报】${r.range.start}～${r.range.end} 新人培养周报`, r.html,
      "自动发送 · 每周一汇总上一自然周（周一至周日）。", { to: mailTo() });
  }
  const results = [];
  for (const g of groups) {
    const r = buildWeeklyReport(theDay, { newbieIds: g.ids });
    const x = await sendMail(`【周报】${r.range.start}～${r.range.end} 新人培养周报`, r.html,
      "自动发送 · 每周一汇总上一自然周（周一至周日）。", { to: [g.email] });
    results.push(Object.assign({ to: [g.email] }, x));
  }
  const ok = results.some(x => x.ok);
  return { ok, to: results.map(x => x.to[0]), channel: (results.find(x => x.channel) || {}).channel || "", results,
    msg: ok ? "" : (results[0] && results[0].msg) || "发送失败" };
}
async function sendPersonalAll(day) {
  const cfg = getMailCfg();
  const theDay = day || bjKey(Date.now());
  const newbies = (USERS.users || []).filter(u => u.role === "newbie" && u.active);
  const targets = {};
  const add = (email, id) => { if (!validEmail(email)) return; (targets[email] = targets[email] || []).push(id); };
  if (cfg.personalSelf) newbies.forEach(u => { if (validEmail(u.email)) add(u.email, u.id); });
  rulesFor("personal").forEach(r => {
    const ids = r.scope === "all" ? newbies.map(u => u.id) : r.scope;
    ids.forEach(id => add(r.email, id));
  });
  const emails = Object.keys(targets);
  if (!emails.length) return { ok: true, to: [], msg: "没有配置个人汇总收件人（可在账号或邮件中心填邮箱）", skipped: true };
  const results = [];
  for (const email of emails) {
    const us = newbies.filter(u => targets[email].indexOf(u.id) >= 0);
    const r = buildPersonalReport(us, theDay);
    const x = await sendMail(`【个人汇总】${r.today} 学习进展与风险提示`, r.html,
      "自动发送 · 工作日个人汇总（含目标达成率与风险提示）。", { to: [email] });
    results.push(Object.assign({ to: [email] }, x));
  }
  const ok = results.some(x => x.ok);
  return { ok, to: emails, channel: (results.find(x => x.channel) || {}).channel || "", results,
    msg: ok ? "" : (results[0] && results[0].msg) || "发送失败" };
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
async function sendRiskAll(day) {
  const theDay = day || bjKey(Date.now());
  const groups = mergeRuleScopes(rulesFor("risk"));
  if (!groups.length) return { ok: true, to: [], msg: "未配置风险预警收件人", skipped: true };
  const allNewbies = (USERS.users || []).filter(u => u.role === "newbie" && u.active);
  const results = [];
  for (const g of groups) {
    const us = g.ids ? allNewbies.filter(u => g.ids.indexOf(u.id) >= 0) : allNewbies;
    const r = buildRiskReport(us, theDay);
    if (!r) continue;
    const x = await sendMail(`【风险预警】${theDay} 有 ${r.count} 位新人需要关注`, r.html,
      "自动发送 · 仅在有风险时发送。", { to: [g.email] });
    results.push(Object.assign({ to: [g.email] }, x));
  }
  if (!results.length) return { ok: true, to: [], msg: "今日无风险项，未发送", skipped: true };
  const ok = results.some(x => x.ok);
  return { ok, to: results.map(x => x.to[0]), channel: (results.find(x => x.channel) || {}).channel || "", results,
    msg: ok ? "" : (results[0] && results[0].msg) || "发送失败" };
}
/* 定时任务统一入口：日报 + 个人汇总 + 风险预警（工作日）；周一再加周报 */
let scheduledLock = false;
async function runScheduled(day) {
  if (scheduledLock) return { ok: true, skipped: "正在发送中" };
  scheduledLock = true;
  try {
    const cfg = getMailCfg();
    const theDay = day || bjKey(Date.now());
    const st = mailState();
    const out = {};
    if (cfg.daily && st.lastDaily !== theDay) {
      out.daily = await sendDailyAll(theDay);
      if (out.daily.ok) markMailSent("lastDaily", theDay);
    }
    if (cfg.personal && st.lastPersonal !== theDay) {
      out.personal = await sendPersonalAll(theDay);
      if (out.personal.ok) markMailSent("lastPersonal", theDay);
    }
    if (cfg.risk && st.lastRisk !== theDay) {
      out.risk = await sendRiskAll(theDay);
      if (out.risk.ok) markMailSent("lastRisk", theDay);
    }
    const wd = bj(theDay).getUTCDay();
    if (wd === 1 && cfg.weekly && st.lastWeekly !== theDay) {
      out.weekly = await sendWeeklyAll(theDay);
      if (out.weekly.ok) markMailSent("lastWeekly", theDay);
    }
    if (!Object.keys(out).length) return { ok: true, skipped: "今日已发" };
    return Object.assign({ ok: true, day: theDay }, out);
  } finally { scheduledLock = false; }
}
function sendDailyReport(day) { return sendDailyAll(day); }
/* 按类型生成邮件内容（供「邮件中心」预览 / 手动发送，与自动发送共用同一套统计口径） */
function reportOf(type, day, ids) {
  const theDay = day || bjKey(Date.now());
  const allNewbies = (USERS.users || []).filter(u => u.role === "newbie" && u.active);
  const sel = ids && ids.length ? allNewbies.filter(u => ids.indexOf(u.id) >= 0) : allNewbies;
  const scope = ids && ids.length ? ids : undefined;
  if (type === "weekly") {
    const r = buildWeeklyReport(theDay, { newbieIds: scope });
    return { subject: `【周报】${r.range.start}～${r.range.end} 新人培养周报`, html: r.html,
      note: "手动发送 · 上一自然周（周一至周日）。" };
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
/* 工作日到点自动发：每 5 分钟检查一次，同一天只发一次（发送记录持久化，重启不重复）。
   GitHub Actions 的 cron 只负责「唤醒实例 + 触发 /api/daily_ping」兜底。 */
function startDailyReportTimer() {
  setInterval(() => {
    if (!MAIL_ON) return;
    const cfg = getMailCfg();
    const d = bj(Date.now());
    const wd = d.getUTCDay(), hour = d.getUTCHours();
    if (wd === 0 || wd === 6) return;
    if (hour < cfg.reportHour) return;
    const key = bjKey(Date.now());
    const st = mailState();
    if (!(cfg.daily && st.lastDaily !== key) && !(cfg.personal && st.lastPersonal !== key) &&
      !(cfg.risk && st.lastRisk !== key) && !(wd === 1 && cfg.weekly && st.lastWeekly !== key)) return;
    if (MS.lastTry && Date.now() - MS.lastTry < 30 * 60000) return;
    MS.lastTry = Date.now(); saveMS();
    runScheduled(key).then(r => {
      if (!r.ok) console.log("[mail] 定时发送未完成：", r.msg || "");
      else if (!r.skipped) console.log("[mail] 定时邮件已处理：" + key);
    });
  }, 5 * 60000);
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
    users: (USERS.users || []).map(u => Object.assign(pubUser(u), { email: u.email || "", mentorId: u.mentorId || "", leadId: u.leadId || "", inviteUrl: u.invite ? inviteUrl(u) : "" })) });
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
  let u;
  if (password) {
    if (password.length < 4) return res.status(400).json({ ok: false, msg: "密码至少 4 位" });
    u = { id: uid(), username, name, role, salt, pass: hashPass(password, salt), active: true, activated: true, invite: null, mustReset: true, wecom: "", pwless: false, createdAt: Date.now() };
  } else {
    // 不设密码 → 生成邀请链接，由本人自己设密码（管理员无需记录任何口令）
    u = { id: uid(), username, name, role, salt, pass: "", active: true, activated: false, invite: newInvite(), mustReset: false, wecom: "", pwless: false, createdAt: Date.now() };
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
  if (b.email != null) u.email = String(b.email).trim();
  /* 直属导师 / 直属主管：只影响「提醒邮件发给谁」，不改变任何业务数据 */
  if (b.mentorId != null) u.mentorId = String(b.mentorId).trim();
  if (b.leadId != null) u.leadId = String(b.leadId).trim();
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
  res.json({ ok: true, enabled: MAIL_ON, channel: MAIL_CHANNEL, smtpHost: SMTP_ON ? SMTP_HOST : "", smtpUser: SMTP_ON ? SMTP_USER : "",
    from: MAIL_FROM, replyTo: MAIL_REPLY_TO, to: mailTo(), reportHour: getMailCfg().reportHour,
    lastSent: MS.lastSent || 0, lastReport: MS.lastReport || "", today: bjKey(Date.now()) });
});
app.post("/api/mail_test", async (req, res) => {
  if (!requireStaff(req, res)) return;
  const r = await sendMail("【测试】Q4 工作台邮件通知链路已连通",
    `<p>这是一封测试邮件。</p><p>收到它说明邮件通道（QQ 邮箱 SMTP / Resend）、发件人、收件人都已配置正确。</p>
     <p style="color:#5C6772;font-size:13px">后续会自动发送：新人登录提醒、新人问题/诉求提醒、工作日 ${REPORT_HOUR}:00 的每日进度报告。</p>`,
    "测试邮件 · 手动触发");
  res.status(r.ok ? 200 : 400).json(r);
});
app.post("/api/mail_report", async (req, res) => {
  if (!requireStaff(req, res)) return;
  /* 可选 ?day=YYYY-MM-DD：补发/重发指定某天的日报；不传则发当天 */
  const day = String(req.query.day || "");
  const r = await sendDailyReport(/^\d{4}-\d{2}-\d{2}$/.test(day) ? day : bjKey(Date.now()));
  res.status(r.ok ? 200 : 400).json(r);
});

/* ---------- 邮件中心（超管在网站内配置收件人 / 内容 / 关注新人） ---------- */
function requireAdmin(req, res) {
  const me = tokenFromReq(req);
  if (!me) { res.status(401).json({ ok: false, msg: "未登录或会话失效" }); return null; }
  if (me.role !== "admin") { res.status(403).json({ ok: false, msg: "仅超级管理员可配置邮件中心" }); return null; }
  return me;
}
function mailCfgPayload() {
  const cfg = getMailCfg();
  const users = (USERS.users || []).map(u => ({ id: u.id, name: u.name, username: u.username,
    role: u.role, roleName: ROLE_NAME[u.role], email: u.email || "", active: !!u.active,
    mentorId: u.mentorId || "", leadId: u.leadId || "" }));
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
  const x = await sendMail(r.subject, r.html, r.note + " · 邮件中心手动发送。", { to });
  res.status(x.ok ? 200 : 400).json(Object.assign({ to, subject: r.subject, day, type }, x));
});
/* GitHub Actions 定时任务用它拉取日报内容（备用；主链路是下面的 daily_ping 让服务端自己触发） */
app.get("/api/report_payload", (req, res) => {
  const t = String(req.query.token || "");
  if (!RELAY_TOKEN || t !== RELAY_TOKEN) return res.status(403).json({ ok: false, msg: "口令不正确" });
  try { res.json({ ok: true, mail: reportPayload() }); }
  catch (e) { res.status(500).json({ ok: false, msg: e.message }); }
});
/* 定时兜底：GitHub Actions 工作日 18:15 访问此接口唤醒免费实例，由服务端自己判断是否该发今日日报。
   同一天只发一次（看 MS.lastReport），重复访问不会重复发信。 */
app.get("/api/daily_ping", async (req, res) => {
  const key = bjKey(Date.now());
  if (!MAIL_ON) return res.json({ ok: false, msg: "邮件通道未配置", skipped: "未配置" });
  const cfg = getMailCfg();
  const d = bj(Date.now());
  const wd = d.getUTCDay(), hour = d.getUTCHours();
  if (wd === 0 || wd === 6) return res.json({ ok: true, skipped: "周末" });
  if (hour < cfg.reportHour) return res.json({ ok: true, skipped: "未到 " + cfg.reportHour + ":00" });
  const st = mailState();
  const pending = (cfg.daily && st.lastDaily !== key) || (cfg.personal && st.lastPersonal !== key) ||
    (cfg.risk && st.lastRisk !== key) || (wd === 1 && cfg.weekly && st.lastWeekly !== key);
  if (!pending) return res.json({ ok: true, skipped: "今日已发" });
  const r = await runScheduled(key);
  MS.lastReport = key; saveMS();
  res.json({ ok: !!r.ok, msg: r.msg || "", to: r.to || [], channel: r.channel || "", result: r });
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
  loadBank();                   // 产品地图档位/截止日（日报进度判定用）
  rotateLegacyWeakPasswords();  // 历史弱默认密码 → 随机密码（防冒用）
  if (SB_ON) { await sbPullDoc(); if (!DOC) console.log("[boot] Supabase 中尚无业务数据，等待前端首次写入"); }
  else if (GH_ON) await ghPull();
  else if (!DOC) console.log("[boot] 尚无数据，等待前端首次写入");
  app.listen(PORT, () => {
    console.log(`Q4 工作台在线版已启动： http://localhost:${PORT}`);
    console.log(`持久化： ${SB_ON ? "Supabase 云库（" + SB_URL + " · 表 " + SB_TABLE + "）" : GH_ON ? "GitHub " + GH_REPO : "本地 " + STATE_FILE}`);
    console.log(`企业微信扫码登录： ${WECOM_ON ? "已启用（" + WECOM_CORPID + "）" : "未配置（可留空）"}`);
    console.log(`邮件通知： ${MAIL_ON ? "已启用 · " + (MAIL_CHANNEL === "github-actions" ? "GitHub Actions + QQ 邮箱（按人分邮）" : MAIL_CHANNEL === "smtp" ? "QQ/SMTP " + SMTP_HOST : MAIL_CHANNEL === "brevo" ? "Brevo HTTP API" : "Resend") + " · 收件人 " + mailTo().join(",") + " · 工作日 " + REPORT_HOUR + ":00 日报" : "未配置（GH_DISPATCH_TOKEN / SMTP_USER+SMTP_PASS / BREVO_API_KEY / RESEND_API_KEY；登录/问题提醒会记录但不发信）"}`);
    startDailyReportTimer();
    console.log("[账号] 超级管理员初始账号： admin / admin123（请首次登录后立即改密）；其余账号密码见上方日志或由管理员在「账号管理」里设置");
    console.log(`[账号] 当前 ${(USERS.users || []).length} 个账号：` + (USERS.users || []).map(u => `${u.username}(${ROLE_NAME[u.role]}${u.activated ? "" : "·待激活"})`).join(" · "));
  });
})();
