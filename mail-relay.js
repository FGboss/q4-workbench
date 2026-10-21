/* =====================================================================
   GitHub Actions 发信中继
   为什么需要它：Render / Railway 等免费云封锁了 25/465/587 端口，
   服务端自己连不上 QQ 邮箱 SMTP。本脚本跑在 GitHub Actions runner 上
   （公开仓库分钟数不限），用 QQ 邮箱 SMTP 把邮件真正投递出去。

   两种触发：
     · repository_dispatch：服务端发生事件（登录、新问题、测试、日报）
       时立即触发，邮件内容由服务端 base64 编码后放在 client_payload.b64
     · schedule：工作日 18:00 定时触发，脚本反向拉取日报内容
       （Render 免费实例 15 分钟无请求会休眠，服务端定时器不可靠）

   需要的仓库 Secrets：
     SMTP_USER      发件 QQ 邮箱，如 916941476@qq.com
     SMTP_PASS      QQ 邮箱「授权码」（不是登录密码）
     RELAY_TOKEN    与服务端 RELAY_TOKEN 一致的口令
   ===================================================================== */
const nodemailer = require("nodemailer");

const SMTP_HOST = process.env.SMTP_HOST || "smtp.qq.com";
const SMTP_PORT = +(process.env.SMTP_PORT || 465);
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const RELAY_TOKEN = process.env.RELAY_TOKEN || "";
const APP_URL = (process.env.APP_URL || "https://q4-workbench.onrender.com").replace(/\/$/, "");

async function loadMail() {
  const b64 = process.env.PAYLOAD_B64 || "";
  if (b64 && b64 !== "null") {
    return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  }
  if (!RELAY_TOKEN) throw new Error("定时任务缺少 RELAY_TOKEN secret");
  const r = await fetch(`${APP_URL}/api/report_payload?token=${encodeURIComponent(RELAY_TOKEN)}`, {
    headers: { "User-Agent": "q4-mail-relay" },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error("拉取日报失败：HTTP " + r.status + " " + (j.msg || ""));
  return j.mail;
}

async function main() {
  if (!SMTP_USER || !SMTP_PASS) throw new Error("缺少 SMTP_USER / SMTP_PASS secret（QQ 邮箱地址与授权码）");
  const mail = await loadMail();
  const to = Array.isArray(mail.to) ? mail.to.filter(Boolean) : String(mail.to || "").split(/[,;\s]+/).filter(Boolean);
  if (!to.length) throw new Error("邮件没有收件人");
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    connectionTimeout: 20000, greetingTimeout: 20000, socketTimeout: 30000,
  });
  const opt = { from: mail.from || `Q4 工作台 <${SMTP_USER}>`, to: to.join(","), subject: mail.subject || "Q4 工作台通知", html: mail.html || "" };
  if (mail.replyTo) opt.replyTo = mail.replyTo;
  const info = await transporter.sendMail(opt);
  console.log("已发送：" + opt.subject);
  console.log("收件人：" + to.join(", "));
  console.log("messageId：" + (info.messageId || ""));
  transporter.close();
}

main().catch(e => { console.error("发送失败：" + e.message); process.exit(1); });
