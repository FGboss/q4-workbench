/* =====================================================================
   GitHub Actions 发信中继
   为什么需要它：Render / Railway 等免费云封锁了 25/465/587 端口，
   服务端自己连不上 QQ 邮箱 SMTP。本脚本跑在 GitHub Actions runner 上
   （公开仓库 Actions 分钟数不限），用 QQ 邮箱 SMTP 把邮件真正投递出去。

   触发方式：服务端发生事件（登录、新问题、测试、日报）时通过
   repository_dispatch 立即触发，整封邮件 base64 编码后放在
   client_payload.b64。收件人已在服务端按人算好，这里只负责投递。

   需要的仓库 Secrets：
     SMTP_USER      发件 QQ 邮箱，如 916941476@qq.com
     SMTP_PASS      QQ 邮箱「授权码」（不是登录密码）
   ===================================================================== */
const nodemailer = require("nodemailer");
const zlib = require("zlib");

const SMTP_HOST = process.env.SMTP_HOST || "smtp.qq.com";
const SMTP_PORT = +(process.env.SMTP_PORT || 465);
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";

function loadMail() {
  const b64 = process.env.PAYLOAD_B64 || "";
  if (!b64 || b64 === "null") throw new Error("没有收到邮件载荷（payload 为空）");
  const buf = Buffer.from(b64, "base64");
  /* 服务端合并多类内容后邮件变大，会先 gzip 再 base64（payload.gz）。
     这里用 gzip 魔数 1F 8B 自动识别，新旧载荷都能正确解析。 */
  const gz = buf.length > 1 && buf[0] === 0x1f && buf[1] === 0x8b;
  const json = (gz ? zlib.gunzipSync(buf) : buf).toString("utf8");
  return JSON.parse(json);
}

async function main() {
  if (!SMTP_USER || !SMTP_PASS) throw new Error("缺少 SMTP_USER / SMTP_PASS secret（QQ 邮箱地址与授权码）");
  const mail = loadMail();
  const to = Array.isArray(mail.to) ? mail.to.filter(Boolean) : String(mail.to || "").split(/[,;\s]+/).filter(Boolean);
  if (!to.length) throw new Error("邮件没有收件人");
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    connectionTimeout: 20000, greetingTimeout: 20000, socketTimeout: 30000,
  });
  /* 发件人固定用登录授权的 QQ 邮箱：QQ SMTP 不允许冒用其他地址（服务端默认的
     onboarding@resend.dev 在这里会被拒信），显示名沿用服务端传来的即可 */
  const nameMatch = String(mail.from || "").match(/^\s*(.*?)\s*</);
  const from = `${(nameMatch && nameMatch[1]) || "Q4 工作台"} <${SMTP_USER}>`;
  const opt = { from, to: to.join(","), subject: mail.subject || "Q4 工作台通知", html: mail.html || "" };
  if (mail.replyTo) opt.replyTo = mail.replyTo;
  const info = await transporter.sendMail(opt);
  console.log("已发送：" + opt.subject);
  console.log("收件人：" + to.join(", "));
  console.log("messageId：" + (info.messageId || ""));
  transporter.close();
}

main().catch(e => { console.error("发送失败：" + e.message); process.exit(1); });
