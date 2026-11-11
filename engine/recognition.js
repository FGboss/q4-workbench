/* =====================================================================
   认可引擎（Recognition Engine）
   ---------------------------------------------------------------------
   解决一个失衡：平台过去只会「记录 + 分级 + 预警」，新人做了事也看不到反馈。
   这个文件只做一件事：从真实动作里找出「值得肯定」的证据，并说人话。

   硬约束（改之前先读）：
     1. 纯函数，不读文件、不发请求、不写 DOC。
     2. 只讲已经发生的事实，不编造、不给人打分、不做排名。
     3. 没有证据就明确说「这周还没留下记录」，绝不硬夸。
     4. 文案和阈值只在这里写一次；页面与邮件都从这里取。
   ===================================================================== */

const DAY = 86400000;
function ms(t) {
  if (t == null || t === "") return 0;
  if (typeof t === "number") return t < 1e11 ? Math.round(t * 1000) : t;
  const n = new Date(t).getTime();
  return Number.isFinite(n) ? n : 0;
}
const dayKey = t => new Date(ms(t) + 8 * 3600000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.floor((Date.parse(b) - Date.parse(a)) / DAY);

/**
 * @param {object} ctx
 * @param {number} ctx.now
 * @param {string} ctx.day            今天 YYYY-MM-DD（北京时间）
 * @param {string} ctx.weekStart      本周一 YYYY-MM-DD
 * @param {Array}  ctx.people         [{id,name}]
 * @param {Array}  ctx.checkins       [{who,at,nodeId,module}]
 * @param {Array}  ctx.quiz           [{who,at,correct,total,nodeId}]
 * @param {Array}  ctx.tasks          [{ownerId,carrierName,text,st,cfmAt,updatedAt,createdAt,logs:[{by,at}]}]
 * @param {Array}  ctx.issues         [{who,createdAt,status,replies:[{by,at}]}]
 * @param {Array}  ctx.drills         [{who,at,score,topic}]
 * @param {Array}  ctx.deposits       [{who,at,title}]
 * @param {Array}  ctx.retests        [{who,at,items:[{ok}]}]
 * @param {object} ctx.planConfirm    {id:true}
 */
function build(ctx) {
  const day = ctx.day, weekStart = ctx.weekStart;
  const inWeek = t => { const k = dayKey(t); return k >= weekStart && k <= day; };
  const beforeWeek = t => dayKey(t) < weekStart;
  const byWho = {}, team = [];

  (ctx.people || []).forEach(p => {
    const id = p.id;
    const ck = (ctx.checkins || []).filter(x => x.who === id);
    const qz = (ctx.quiz || []).filter(x => x.who === id);
    const tk = (ctx.tasks || []).filter(x => x.ownerId === id);
    const iss = (ctx.issues || []).filter(x => x.who === id);
    const dr = (ctx.drills || []).filter(x => x.who === id);
    const dp = (ctx.deposits || []).filter(x => x.who === id);
    const rt = (ctx.retests || []).filter(x => x.who === id);

    /* ---- 本周事实 ---- */
    const ckIn = ck.filter(x => inWeek(x.at));
    const nodes = new Set(ckIn.map(x => x.nodeId).filter(Boolean)).size;
    const qzIn = qz.filter(x => inWeek(x.at));
    const quizTotal = qzIn.reduce((n, x) => n + (x.total || 0), 0);
    const quizCorrect = qzIn.reduce((n, x) => n + (x.correct || 0), 0);
    const perfect = qzIn.filter(x => (x.total || 0) >= 5 && x.correct === x.total).length;
    const logs = tk.reduce((n, t) => n + (t.logs || []).filter(l => l.by === id && inWeek(l.at)).length, 0);
    const closed = tk.filter(t => (t.st || 0) === 2 && inWeek(t.cfmAt || t.updatedAt)).length;
    const issIn = iss.filter(x => inWeek(x.createdAt));
    const issAnswered = issIn.filter(x => (x.replies || []).some(r => r.by !== id)).length;
    const drIn = dr.filter(x => inWeek(x.at));
    const dpIn = dp.filter(x => inWeek(x.at));
    const retestOk = rt.filter(x => inWeek(x.at)).reduce((n, r) => n + (r.items || []).filter(i => i.ok).length, 0);

    /* ---- 连续天数：今天或昨天有动作就不断 ---- */
    const actDays = new Set([].concat(
      ck.map(x => dayKey(x.at)), qz.map(x => dayKey(x.at)),
      tk.flatMap(t => (t.logs || []).filter(l => l.by === id).map(l => dayKey(l.at))),
      iss.map(x => dayKey(x.createdAt)), dr.map(x => dayKey(x.at))
    ).filter(Boolean));
    let streak = 0, cursor = new Date(day + "T00:00:00Z");
    if (!actDays.has(day)) cursor = new Date(cursor.getTime() - DAY);
    while (actDays.has(cursor.toISOString().slice(0, 10))) { streak++; cursor = new Date(cursor.getTime() - DAY); }
    const activeDays = [...actDays].filter(k => k >= weekStart && k <= day).length;

    /* ---- 亮点：只放有证据的，按分量排序 ---- */
    const H = [];
    const add = (type, text, weight) => H.push({ type, text, weight });

    if (closed >= 2) add("closed", `本周闭环 ${closed} 项任务 / 项目`, 90);
    else if (closed === 1) add("closed", "本周闭环 1 项任务，交付有了结果", 72);

    if (nodes >= 5) add("learn", `本周打通 ${nodes} 个学习节点`, 86);
    else if (nodes >= 3) add("learn", `本周完成 ${nodes} 个节点打卡`, 66);

    if (perfect >= 2) add("quiz", `小测拿到 ${perfect} 次满分`, 82);
    else if (perfect === 1) add("quiz", "有 1 次小测满分", 74);

    if (quizTotal >= 10 && quizCorrect / quizTotal >= 0.9) {
      add("acc", `小测正确率 ${Math.round(quizCorrect / quizTotal * 100)}%（${quizCorrect}/${quizTotal}）`, 76);
    }

    if (streak >= 5) add("streak", `连续 ${streak} 天都在推进`, 88);
    else if (streak >= 3) add("streak", `连续 ${streak} 天有动作`, 62);

    if (logs >= 5) add("log", `更新了 ${logs} 条任务进展`, 70);
    else if (logs >= 3) add("log", `更新了 ${logs} 条任务进展`, 56);

    if (issIn.length && issAnswered === issIn.length) add("issue", `主动提出 ${issIn.length} 个问题，并且都跟到了回复`, 73);
    else if (issIn.length) add("issue", `主动提出 ${issIn.length} 个问题，把卡点摆到了台面上`, 68);

    if (drIn.length) add("drill", `完成 ${drIn.length} 次演练${drIn[0].topic ? `（${drIn[0].topic}）` : ""}`, 66);
    if (dpIn.length) add("deposit", `沉淀了 ${dpIn.length} 篇资料`, 55);
    if (retestOk >= 2) add("retest", `订正了 ${retestOk} 道错题`, 52);

    /* 第一次：只在本周首次发生时表扬，并把同类的一般描述去掉，避免同一件事说两遍 */
    const addFirst = (list, label, genericType) => {
      const now = list.filter(x => inWeek(x.at || x.createdAt));
      if (!now.length) return;
      const earlier = list.filter(x => beforeWeek(x.at || x.createdAt));
      if (earlier.length) return;
      for (let i = H.length - 1; i >= 0; i--) if (H[i].type === genericType) H.splice(i, 1);
      add("first", `第一次${label}`, 78);
    };
    addFirst(iss.map(x => ({ at: x.createdAt })), "主动发起求助", "issue");
    addFirst(dr.map(x => ({ at: x.at })), "完成演练", "drill");
    addFirst(tk.filter(t => (t.st || 0) === 2).map(t => ({ at: t.cfmAt || t.updatedAt })), "把任务做到闭环", "closed");

    /* 重新开始：上周断档 ≥5 天，本周又动了 */
    const lastBefore = Math.max(0, ...ck.filter(x => beforeWeek(x.at)).map(x => ms(x.at)),
      ...qz.filter(x => beforeWeek(x.at)).map(x => ms(x.at)));
    if (lastBefore) {
      const gap = daysBetween(dayKey(lastBefore), weekStart);
      if (gap >= 5 && (activeDays >= 1)) add("comeback", `停了 ${gap} 天后重新开始，本周已经有 ${activeDays} 天在推进`, 80);
    }

    H.sort((a, b) => b.weight - a.weight);
    const highlights = H.slice(0, 3);
    const headline = highlights.length
      ? "这周最值得肯定的是：" + highlights[0].text + "。"
      : "";
    const support = !highlights.length
      ? "这周还没有留下动作记录。不用补，从一次打卡或一条任务进展开始，系统就会记下来。"
      : issIn.length && issAnswered < issIn.length
        ? "你提的问题已经进「协助」，导师会跟进；有卡点继续提，不用自己扛。"
        : "这些动作都已经被记录。想再往前走一步，就挑一个红灯任务先闭环。";

    /* ---- 今天的事实：日报只讲今天，周报讲本周 ---- */
    const ckT = ckIn.filter(x => dayKey(x.at) === day).length;
    const qzT = qzIn.filter(x => dayKey(x.at) === day);
    const logT = tk.reduce((n, t) => n + (t.logs || []).filter(l => l.by === id && dayKey(l.at) === day).length, 0);
    const closedT = tk.filter(t => (t.st || 0) === 2 && dayKey(t.cfmAt || t.updatedAt) === day).length;
    const issT = issIn.filter(x => dayKey(x.createdAt) === day).length;
    const todayH = [];
    if (closedT) todayH.push(`今天闭环 ${closedT} 项任务`);
    if (ckT) todayH.push(`今天完成 ${ckT} 个节点打卡`);
    if (qzT.length) {
      const ct = qzT.reduce((n, x) => n + (x.correct || 0), 0);
      const tt = qzT.reduce((n, x) => n + (x.total || 0), 0);
      todayH.push(tt ? `今天小测 ${ct}/${tt}` : "今天做了小测");
    }
    if (logT) todayH.push(`今天更新了 ${logT} 条任务进展`);
    if (issT) todayH.push(`今天主动提了 ${issT} 个问题`);

    byWho[id] = {
      id, name: p.name,
      week: { checkins: ckIn.length, nodes, quizTotal, quizCorrect,
        quizAcc: quizTotal ? Math.round(quizCorrect / quizTotal * 100) : null,
        perfect, logs, closed, issues: issIn.length, issuesAnswered: issAnswered,
        drills: drIn.length, deposits: dpIn.length, retestOk, streak, activeDays },
      today: { checkins: ckT, quizTotal: qzT.reduce((n, x) => n + (x.total || 0), 0),
        quizCorrect: qzT.reduce((n, x) => n + (x.correct || 0), 0),
        logs: logT, closed: closedT, issues: issT },
      todayH, highlights, headline, support,
      praised: highlights.length > 0,
    };
    if (highlights.length) team.push({ id, name: p.name, top: highlights[0].text, count: highlights.length });
  });

  team.sort((a, b) => b.count - a.count);
  return { at: ctx.now || Date.now(), day, weekStart, byWho, team };
}

module.exports = { build };
