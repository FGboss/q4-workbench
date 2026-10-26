/* 模型调用：只负责「把快照交给模型，拿回结构化判断」。
   不解析业务、不做校验（校验在 verify.js），也不写任何数据。
   支持四类免费/兼容通道，配了哪个用哪个：
     · BRAIN_BASE_URL + BRAIN_API_KEY  任意 OpenAI 兼容接口（火山/DeepSeek/自建等）
     · GROQ_API_KEY                    Groq
     · OPENROUTER_API_KEY              OpenRouter（可用 :free 模型）
     · GEMINI_API_KEY                  Google AI Studio
   一个都没配时不报错，上层自动走规则版。 */

const TIMEOUT = +(process.env.BRAIN_TIMEOUT_MS || 25000);

function pick() {
  const base = (process.env.BRAIN_BASE_URL || "").replace(/\/$/, "");
  const key = process.env.BRAIN_API_KEY || "";
  if (base && key) {
    return { name: "custom", kind: "openai", url: base + "/chat/completions", key,
      model: process.env.BRAIN_MODEL || "gpt-4o-mini", jsonMode: true };
  }
  if (process.env.GROQ_API_KEY) {
    return { name: "groq", kind: "openai", url: "https://api.groq.com/openai/v1/chat/completions",
      key: process.env.GROQ_API_KEY, model: process.env.BRAIN_MODEL || "llama-3.3-70b-versatile", jsonMode: true };
  }
  if (process.env.OPENROUTER_API_KEY) {
    return { name: "openrouter", kind: "openai", url: "https://openrouter.ai/api/v1/chat/completions",
      key: process.env.OPENROUTER_API_KEY, model: process.env.BRAIN_MODEL || "google/gemini-2.0-flash-exp:free", jsonMode: false };
  }
  const gk = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
  if (gk) {
    const m = process.env.BRAIN_MODEL || "gemini-2.0-flash";
    return { name: "gemini", kind: "gemini", key: gk, model: m,
      url: "https://generativelanguage.googleapis.com/v1beta/models/" + m + ":generateContent?key=" + encodeURIComponent(gk) };
  }
  return null;
}

const enabled = () => !!pick();
const modelName = () => { const p = pick(); return p ? p.model : ""; };

const SYSTEM = [
  "你是这个「新人培养工作台」的 AI 主管。你看全平台数据，只做判断和排序，不执行任何操作。",
  "硬性规则：",
  "1. 只输出一个 JSON 对象，不要 markdown、不要解释文字。",
  "2. 所有数字必须来自快照 facts，不得估算、不得四舍五入、不得编造。",
  "3. 每条判断的 evidence 只能填快照 refs 里真实存在的 key（如 task:c1.a3 / car:c1 / issue:i1 / person:zhan）。",
  "4. 不要复述数据。headline 一句话说清「今天最该干什么」。",
  "5. focus 按优先级从高到低，最多 5 人；没进 focus 的人放 others，每人一句。",
  "6. next 是给导师/主管的动作建议，动词开头，每人最多 3 条，每条不超过 40 字。",
  "7. excluded 至少 1 条：说明你看到了但决定不提醒的事，以及原因。",
  "8. 你没有任何写入能力，禁止出现「我已发送/我已修改/我已通知」这类表述。",
  "输出结构：",
  '{"global":{"headline":"","state":"tight|steady|loose","topRiskId":"","why":[""]},',
  '"focus":[{"id":"","verdict":"","why":"","evidence":[""],"next":["",""]}],',
  '"others":[{"id":"","oneLine":""}],',
  '"cross":[{"text":"","evidence":[""]}],',
  '"excluded":[{"what":"","because":""}],',
  '"dataGaps":[{"text":""}]}',
].join("\n");

function parseJson(t) {
  let s = String(t || "").trim();
  s = s.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
}

async function call(p, userMsg) {
  const ac = new AbortController();
  const timer = setTimeout(() => { try { ac.abort(); } catch (e) {} }, TIMEOUT);
  try {
    let url = p.url, body, headers = { "content-type": "application/json" };
    if (p.kind === "gemini") {
      body = {
        system_instruction: { parts: [{ text: SYSTEM }] },
        contents: [{ role: "user", parts: [{ text: userMsg }] }],
        generationConfig: { temperature: 0.2, responseMimeType: "application/json", maxOutputTokens: 1600 },
      };
    } else {
      headers.authorization = "Bearer " + p.key;
      body = {
        model: p.model,
        messages: [{ role: "system", content: SYSTEM }, { role: "user", content: userMsg }],
        temperature: 0.2,
        max_tokens: 1600,
      };
      if (p.jsonMode) body.response_format = { type: "json_object" };
      if (p.name === "openrouter") headers["x-title"] = "Q4 Workbench Brain";
    }
    const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: ac.signal });
    const txt = await r.text();
    if (!r.ok) throw new Error(p.name + " HTTP " + r.status + " " + txt.slice(0, 160));
    const d = JSON.parse(txt);
    const out = p.kind === "gemini"
      ? (((d.candidates || [])[0] || {}).content || { parts: [] }).parts.map(x => x.text || "").join("")
      : ((((d.choices || [])[0] || {}).message || {}).content || "");
    if (!out) throw new Error(p.name + " 返回为空");
    return { text: out, model: p.model, provider: p.name };
  } finally {
    clearTimeout(timer);
  }
}

async function think(snap) {
  const p = pick();
  if (!p) throw new Error("未配置任何模型通道");
  const userMsg = "今天是 " + snap.day + "，以下是全平台快照（JSON）：\n" + JSON.stringify(snap);
  const r = await call(p, userMsg);
  const raw = parseJson(r.text);
  if (!raw) throw new Error("模型输出不是合法 JSON");
  return { raw, model: r.model, provider: r.provider, ms: 0 };
}

module.exports = { think, enabled, modelName, pick };
