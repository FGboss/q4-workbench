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
function saveUsers() { writeJson(USERS_FILE, USERS); if (GH_ON) ghPushUsers(); }
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
    triggers: { t: 0, list: [] }, fae: { t: 0, map: {} }, reviews: { t: 0, map: {} }, checkins: { t: 0, list: [] } };
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
  ["carriers", "issues", "drills", "kit", "cards", "quotes", "triggers", "checkins"].forEach(k => o[k] = mergeList(a[k], b[k]));
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
  ["carriers", "issues", "drills", "kit", "cards", "quotes", "triggers", "checkins"].forEach(k =>
    o[k] = (r[k] && Array.isArray(r[k].list)) ? r[k] : { t: (r[k] && r[k].t) || 0, list: [] });
  o.map = (r.map && Array.isArray(r.map.checks)) ? r.map : { t: 0, checks: [] };
  o.fae = (r.fae && r.fae.map && typeof r.fae.map === "object" && !Array.isArray(r.fae.map)) ? r.fae : { t: 0, map: {} };
  o.reviews = (r.reviews && r.reviews.map && typeof r.reviews.map === "object" && !Array.isArray(r.reviews.map)) ? r.reviews : { t: 0, map: {} };
  return o;
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
    github: GH_ON, publicUrl: PUBLIC_URL });
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
  DOC = DOC ? mergeDoc(DOC, incoming) : incoming;
  DOC.t = Date.now();
  ensureDir(); writeJson(STATE_FILE, DOC);
  broadcast();
  ghPush();
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
    users: (USERS.users || []).map(u => Object.assign(pubUser(u), { inviteUrl: u.invite ? inviteUrl(u) : "" })) });
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
  await ghPullUsers();          // 账号优先从 GitHub 恢复（若配置），避免重启丢成员
  ensureUsers();                // 否则用本地文件；都没有则建默认账号
  rotateLegacyWeakPasswords();  // 历史弱默认密码 → 随机密码（防冒用）
  if (GH_ON) await ghPull();
  else if (!DOC) console.log("[boot] 尚无数据，等待前端首次写入");
  app.listen(PORT, () => {
    console.log(`Q4 工作台在线版已启动： http://localhost:${PORT}`);
    console.log(`持久化： ${GH_ON ? "GitHub " + GH_REPO : "本地 " + STATE_FILE}`);
    console.log(`企业微信扫码登录： ${WECOM_ON ? "已启用（" + WECOM_CORPID + "）" : "未配置（可留空）"}`);
    console.log("[账号] 超级管理员初始账号： admin / admin123（请首次登录后立即改密）；其余账号密码见上方日志或由管理员在「账号管理」里设置");
    console.log(`[账号] 当前 ${(USERS.users || []).length} 个账号：` + (USERS.users || []).map(u => `${u.username}(${ROLE_NAME[u.role]}${u.activated ? "" : "·待激活"})`).join(" · "));
  });
})();
