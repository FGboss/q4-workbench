/* 校验闸门：模型说的话，只有通过这里才会进入平台。
   五道闸门（当前阶段只读，所以没有权限写入风险）：
     1. 结构闸门：必须有 headline 和至少 1 个真实新人
     2. 引用闸门：evidence 必须是快照 refs 里真实存在的 key
     3. 事实闸门：句子里出现的数字必须在本人 facts 里找得到，找不到就删这句
     4. 越权闸门：过滤「我已发送/已修改」这类它根本没能力做的事
     5. 体量闸门：focus ≤5、每人 next ≤3、每条字数上限
   任何一道不通过都不会让页面报错，只会退化成规则版。 */

const BAN = /(我|系统|AI)[^。；;]{0,8}已(经)?[^。；;]{0,3}(发送|通知|修改|删除|创建|派发|执行)/;
const STATES = ["tight", "steady", "loose"];

function str(x, n) {
  const t = String(x == null ? "" : x).replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}
function numsIn(t) {
  return (String(t).replace(/\d{4}-\d{1,2}-\d{1,2}/g, "").match(/\d+(?:\.\d+)?/g) || []).map(Number);
}
function sentences(t) {
  return String(t || "").replace(/([。；;])/g, "$1\n").split("\n").map(s => s.trim()).filter(Boolean);
}
/* 只保留「数字都能在事实里找到」的句子；不带数字的句子放行 */
function cleanText(t, allowed, max) {
  const keep = sentences(t).filter(s => {
    if (BAN.test(s)) return false;
    const ns = numsIn(s);
    return !ns.length || ns.every(n => allowed.has(n));
  });
  return str(keep.join(""), max);
}
function numsOfPerson(p) {
  const s = new Set();
  Object.keys(p.facts || {}).forEach(k => {
    const v = p.facts[k];
    if (typeof v === "number") s.add(v);
  });
  (p.tasks || []).forEach(t => { if (t.over) s.add(t.over); if (t.wait) s.add(t.wait); });
  if (p.days) s.add(p.days);
  return s;
}

function verify(raw, snap) {
  if (!raw || typeof raw !== "object") return null;
  const refs = snap.refs || {};
  const byId = {};
  (snap.people || []).forEach(p => { byId[p.id] = p; });
  const allNums = new Set();
  (snap.people || []).forEach(p => numsOfPerson(p).forEach(n => allNums.add(n)));
  Object.keys(snap.team || {}).forEach(k => { if (typeof snap.team[k] === "number") allNums.add(snap.team[k]); });

  const g = raw.global || {};
  const headline = cleanText(g.headline, allNums, 70);
  if (!headline) return null;

  const focus = [];
  (Array.isArray(raw.focus) ? raw.focus : []).forEach(f => {
    if (!f || focus.length >= 5) return;
    const p = byId[String(f.id || "")];
    if (!p || p.risk.level === "green" || focus.some(x => x.id === p.id)) return;
    const allowed = numsOfPerson(p);
    const item = {
      id: p.id,
      name: p.name,
      level: p.risk.level,
      verdict: cleanText(f.verdict, allowed, 60) || (p.risk.red[0] || p.risk.yellow[0] || "推进正常"),
      why: cleanText(f.why, allowed, 150),
      next: (Array.isArray(f.next) ? f.next : []).map(x => cleanText(x, allowed, 42)).filter(Boolean).slice(0, 3),
      evidence: (Array.isArray(f.evidence) ? f.evidence : []).map(String).filter(e => refs[e]).slice(0, 5),
    };
    focus.push(item);
  });
  if (!focus.length) return null;

  const focusIds = new Set(focus.map(x => x.id));
  const others = (Array.isArray(raw.others) ? raw.others : [])
    .map(o => { const p = byId[String((o && o.id) || "")]; return p && !focusIds.has(p.id) ? { id: p.id, name: p.name, oneLine: cleanText(o.oneLine, numsOfPerson(p), 44) } : null; })
    .filter(Boolean).slice(0, 10);

  const cross = (Array.isArray(raw.cross) ? raw.cross : [])
    .map(c => ({ text: cleanText(c && c.text, allNums, 64), evidence: (Array.isArray(c && c.evidence) ? c.evidence : []).map(String).filter(e => refs[e]).slice(0, 4) }))
    .filter(x => x.text).slice(0, 3);

  const excluded = (Array.isArray(raw.excluded) ? raw.excluded : [])
    .map(x => ({ what: cleanText(x && x.what, allNums, 44), because: cleanText(x && x.because, allNums, 60) }))
    .filter(x => x.what).slice(0, 4);

  const dataGaps = (Array.isArray(raw.dataGaps) ? raw.dataGaps : [])
    .map(x => ({ text: cleanText(x && x.text, allNums, 52) }))
    .filter(x => x.text).slice(0, 3);

  const topRiskId = byId[String(g.topRiskId || "")] ? String(g.topRiskId) : focus[0].id;

  return {
    ok: true,
    data: {
      global: {
        headline,
        state: STATES.indexOf(String(g.state)) >= 0 ? String(g.state) : "steady",
        topRiskId,
        why: (Array.isArray(g.why) ? g.why : []).map(x => cleanText(x, allNums, 64)).filter(Boolean).slice(0, 3),
      },
      focus, others, cross, excluded, dataGaps,
    },
  };
}

module.exports = { verify };
