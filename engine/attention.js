/* =====================================================================
   统一待办引擎（Attention Engine）
   ---------------------------------------------------------------------
   为什么单独成文件：
     平台原来有 4 套「有没有问题」的判断（riskOf / customerRisks / 前端 carIssues /
     mapAlerts），首页、把控页、邮件各说各话。这个文件是唯一的「该谁做什么」规则源：
     首页三件事、把控页待办队列、自动升级、邮件提醒都从这里取结果。

   设计约束（改这个文件前先读）：
     1. 纯函数：不读文件、不发请求、不写 DOC；输入是普通对象，输出是普通数组，方便单测。
     2. 每条待办必须有稳定 id（type + 业务主键），保证重复扫描不会重复生成/重复发信。
     3. 规则只在这里写一次；页面只负责展示，不得再自己算一套。
     4. 文案集中在这里，改口径只改一处。
   ===================================================================== */

const DAY = 86400000;

/* 时间容错：兼容毫秒/秒/ISO 字符串 */
function ms(t) {
  if (t == null || t === "") return 0;
  if (typeof t === "number") return t < 1e11 ? Math.round(t * 1000) : t;
  const n = new Date(t).getTime();
  return Number.isFinite(n) ? n : 0;
}
const days = (from, now) => (from ? Math.max(0, Math.floor((now - from) / DAY)) : 0);
const openTask = v => (v.st || 0) !== 2;

/* 待办等级：red 必须先处理，yellow 观察 */
const RANK = { red: 0, yellow: 1, green: 2 };

/**
 * @param {object} ctx
 * @param {number} ctx.now              当前时间戳
 * @param {Array}  ctx.people           [{id,name,role,mentorId,leadId}]
 * @param {Array}  ctx.tasks            [{key,carrierId,carrierName,ownerId,text,kind,due,st,cfm,by,createdAt,updatedAt,logs:[{by,at,text}]}]
 * @param {Array}  ctx.customers        [{id,name,ownerId,nextAt,goalAt,openCount,idleDays}]
 * @param {Array}  ctx.issues           [{id,who,text,status,createdAt,updatedAt,src}]
 * @param {object} ctx.planConfirm      {newbieId:true/false}
 * @param {object} ctx.retests          {newbieId:待复练题数}
 * @param {object} ctx.learning         {newbieId:{idleDays,joinsDays,drill14,quizAcc}}
 */
function build(ctx) {
  const now = ctx.now || Date.now();
  const people = ctx.people || [];
  const staffOf = id => {
    const p = people.filter(x => x.id === id)[0];
    return p ? (p.mentorId || p.leadId || "") : "";
  };
  const nameOf = id => (people.filter(x => x.id === id)[0] || {}).name || id;
  const items = [];
  const seen = {};

  const add = (it) => {
    /* 稳定 id：类型 + 业务主键。没有主键就会退化成 type:undefined，
       同类型多条待办会互相覆盖（验收 4 条只剩 1 条就是这么来的）。 */
    const r = it.ref || {};
    const biz = (r.actionId ? (r.carrierId ? r.carrierId + "." + r.actionId : r.actionId) : "")
      || r.issueId || r.nodeId || r.triggerId || r.key
      || (r.carrierId ? r.carrierId + (it.who ? "." + it.who : "") : (it.who || "all"));
    const id = it.type + ":" + (it.refKey || biz);
    if (seen[id]) return;                       // 同一件事只出现一次
    seen[id] = 1;
    items.push(Object.assign({ id, at: now }, it));
  };

  /* ---------- 1. 任务：待验收 / 超期 / 长期停滞 / 新派任务 ---------- */
  (ctx.tasks || []).forEach(t => {
    if (!openTask(t)) return;
    const owner = t.ownerId || "";
    if (!owner) return;
    const over = t.due ? Math.max(0, Math.floor((now - new Date(t.due + "T23:59:59+08:00").getTime()) / DAY)) : 0;
    const quiet = days(ms(t.updatedAt || t.createdAt), now);

    /* 1.0 延期待批：球在导师这边，优先处理 */
    if (t.state === "delay_pending") {
      const wait = days(ms((t.delay && t.delay.reqAt) || t.updatedAt), now);
      add({
        type: "delay_request", role: "staff", level: "red",
        who: staffOf(owner), ownerId: owner,
        title: `延期待批：${t.text}`,
        detail: `${nameOf(owner)} · ${t.carrierName || ""} · 新截止 ${(t.delay && t.delay.newDue) || "未填"}${t.delay && t.delay.reason ? ` · 理由：${t.delay.reason}` : ""}`,
        ref: { kind: "task", carrierId: t.carrierId, actionId: t.actionId || t.key },
        action: "delay", since: ms((t.delay && t.delay.reqAt) || t.updatedAt), wait,
      });
      return;
    }

    /* 1.1 新人已提交，等导师验收：这是导师的第一优先级 */
    if (t.cfm === 3 || t.state === "submitted") {
      const wait = days(ms(t.updatedAt), now);
      add({
        type: "accept", role: "staff", level: wait >= 3 ? "red" : "yellow",
        who: staffOf(owner), ownerId: owner,
        title: `验收：${t.text}`,
        detail: `${nameOf(owner)} · ${t.carrierName || ""}${wait ? ` · 已等 ${wait} 天` : " · 今天提交"}`,
        ref: { kind: "task", carrierId: t.carrierId, actionId: t.actionId || t.key },
        action: "accept", since: ms(t.updatedAt), wait,
      });
      return;   // 已提交验收的任务不再重复报「超期」，避免同一件事两个红灯
    }

    /* 挂起：导师明确「这件事先不做」，到复核日之前不再报超期/停更 */
    const holdUntil = t.hold && String(t.hold.until || "").slice(0, 10);
    if (holdUntil && holdUntil >= ctx.day) return;

    /* 1.2 超期：责任人处理，导师同步可见 */
    if (over >= 1) {
      add({
        type: "overdue", role: "newbie", level: over >= 3 ? "red" : "yellow",
        who: owner, ownerId: owner,
        title: `超期 ${over} 天：${t.text}`,
        detail: `${t.carrierName || ""}${t.due ? ` · 截止 ${t.due}` : ""}`,
        ref: { kind: "task", carrierId: t.carrierId, actionId: t.actionId || t.key },
        action: "fix", since: ms(t.updatedAt), wait: over,
      });
      return;
    }

    /* 1.3 长期没动：7 天起黄灯，10 天升级 */
    if (quiet >= 7) {
      add({
        type: "stale", role: "newbie", level: quiet >= 10 ? "red" : "yellow",
        who: owner, ownerId: owner,
        title: `${quiet} 天没更新：${t.text}`,
        detail: t.carrierName || "",
        ref: { kind: "task", carrierId: t.carrierId, actionId: t.actionId || t.key },
        action: "fix", since: ms(t.updatedAt), wait: quiet,
      });
      return;
    }

    /* 1.4 导师刚派的任务：3 天内提示新人（新人从未在进展里留过言才算「新」） */
    const mine = (t.logs || []).some(l => l.by === owner);
    const fresh = days(ms(t.createdAt), now);
    if (!mine && t.by && t.by !== owner && fresh <= 3) {
      add({
        type: "new_task", role: "newbie", level: "yellow",
        who: owner, ownerId: owner,
        title: `新任务：${t.text}`,
        detail: `${t.carrierName || ""}${t.due ? ` · 截止 ${t.due}` : ""} · ${nameOf(t.by)} 派给你`,
        ref: { kind: "task", carrierId: t.carrierId, actionId: t.actionId || t.key },
        action: "start", since: ms(t.createdAt), wait: fresh,
      });
    }
  });

  /* ---------- 2. 客户：跟进日过期 / 没有下一步 ----------
     没有跟进日属于「同一类低优先级提醒」，按人聚合成一条；
     过期跟进有明确时限，仍然逐客户列出（通常很少）。 */
  const noNext = {};
  (ctx.customers || []).forEach(c => {
    if (!c.ownerId || !c.openCount) return;
    const next = String(c.nextAt || "").slice(0, 10);
    const late = next && next < ctx.day ? Math.round((new Date(ctx.day + "T00:00:00Z") - new Date(next + "T00:00:00Z")) / DAY) : 0;
    if (!next) {
      if (c.idleDays >= 7) {
        const g = noNext[c.ownerId] = noNext[c.ownerId] || { n: 0, max: 0, names: [] };
        g.n++; g.max = Math.max(g.max, c.idleDays);
        if (g.names.length < 3) g.names.push(c.name);
      }
    } else if (late >= 1) {
      add({
        type: "followup_late", role: "newbie", level: late >= 3 ? "red" : "yellow", who: c.ownerId, ownerId: c.ownerId,
        title: `客户「${c.name}」跟进日已过 ${late} 天`,
        detail: `${c.openCount} 项未闭环`,
        ref: { kind: "carrier", carrierId: c.id }, action: "followup", since: ms(c.updatedAt), wait: late,
      });
    }
  });
  Object.keys(noNext).forEach(who => {
    const g = noNext[who];
    add({
      type: "followup_none", role: "newbie", level: "yellow", who, ownerId: who,
      title: `${g.n} 个客户没有下一步跟进日`,
      detail: `最早 ${g.max} 天没进展 · 例如：${g.names.join("、")}${g.n > 3 ? " 等" : ""}`,
      ref: { kind: "carriers", who, carrierId: "", count: g.n },
      action: "followups", since: now - g.max * DAY, wait: g.max,
    });
  });

  /* ---------- 3. 协助：只有「等导师/主管回复」才算待办 ---------- */
  (ctx.issues || []).forEach(x => {
    if ((x.status || 0) !== 0) return;          // 1=已回复等新人，2=已闭环
    const wait = days(ms(x.waitingSince || x.createdAt), now);
    add({
      type: "issue_wait", role: "staff", level: wait >= 3 ? "red" : "yellow",
      who: staffOf(x.who), ownerId: x.who,
      title: `${x.src === "auto" ? "系统升级" : "求助"}已等 ${wait} 天：${String(x.text || "").slice(0, 40)}`,
      detail: nameOf(x.who),
      ref: { kind: "issue", issueId: x.id }, action: "answer", since: ms(x.createdAt), wait,
    });
  });

  /* 先算出「已登记但还没做」的加练：同一人的加练待办只保留一条，
     已安排日期的降为黄灯，过期才回红；避免和「14 天没演练」重复报两次。 */
  const trigInfo = (ctx.triggers || []).filter(tg => {
    if (!tg.who) return false;
    const done = (ctx.drills || []).some(d => d.who === tg.who && ms(d.at) >= ms(tg.at)
      && (!d.topic || !tg.reason || String(d.topic).indexOf(tg.reason) >= 0 || String(tg.reason).indexOf(d.topic) >= 0));
    return !done;
  }).map(tg => {
    const due = String(tg.due || "").slice(0, 10);
    const late = due && due < ctx.day ? Math.round((new Date(ctx.day + "T00:00:00Z") - new Date(due + "T00:00:00Z")) / DAY) : 0;
    return { tg, due, late };
  });
  const trigByWho = {};
  trigInfo.forEach(x => { trigByWho[x.tg.who] = x; });

  /* ---------- 4. 学习：长时间不打卡 / 计划未确认 / 错题待复练 ---------- */
  (ctx.people || []).filter(p => p.role === "newbie").forEach(p => {
    const l = (ctx.learning || {})[p.id] || {};
    if (!(ctx.planConfirm || {})[p.id]) {
      add({
        type: "plan_unconfirmed", role: "newbie", level: "yellow", who: p.id, ownerId: p.id,
        title: "培养计划还没确认", detail: "确认后导师才知道你的目标",
        ref: { kind: "plan" }, action: "confirm_plan", since: now, wait: 0,
      });
    }
    const idle = l.idleDays | 0;
    if (idle >= 5 && (l.joinsDays | 0) >= 3) {
      add({
        type: "learning_idle", role: "newbie", level: idle >= 10 ? "red" : "yellow", who: p.id, ownerId: p.id,
        title: `已经 ${idle} 天没打卡 / 小测`,
        detail: l.drill14 === 0 ? "近 14 天也没有演练" : `近 14 天演练 ${l.drill14} 次`,
        ref: { kind: "learn" }, action: "learn", since: now, wait: idle,
      });
    }
    /* 缺练：14 天没有演练 → 生成一条可执行的练习待办；已登记加练时不再重复 */
    if (!trigByWho[p.id] && (l.drill14 | 0) === 0 && (l.joinsDays | 0) >= 14) {
      const dd = l.drillIdleDays | 0;
      add({
        type: "drill_due", role: "newbie", level: dd >= 21 ? "red" : "yellow", who: p.id, ownerId: p.id,
        title: dd ? `已经 ${dd} 天没有演练` : "还没有演练记录",
        detail: "安排一次真实场景讲解或客户培训，导师评分后闭环",
        ref: { kind: "drill" }, action: "drill", since: now, wait: dd,
      });
    }
    const rt = (ctx.retests || {})[p.id] | 0;
    if (rt > 0) {
      add({
        type: "retest", role: "newbie", level: "yellow", who: p.id, ownerId: p.id,
        title: `错题本还有 ${rt} 道待复练`, detail: "答对 2 次即移出错题本",
        ref: { kind: "retest" }, action: "retest", since: now, wait: 0,
      });
    }
  });

  /* ---------- 5. 触发式加练：已安排 → 黄灯；过期/没日期 → 红灯 ---------- */
  trigInfo.forEach(({ tg, due, late }) => {
    add({
      type: "drill_trigger", role: "newbie", level: late || !due ? "red" : "yellow", who: tg.who, ownerId: tg.who,
      title: late ? `加练逾期 ${late} 天：${tg.reason}` : due ? `已安排加练：${tg.reason}` : `触发加练未落实：${tg.reason}`,
      detail: due ? `${tg.action || ""} · ${due} 前完成` : (tg.action || "登记后需要安排一次演练并评分"),
      ref: { kind: "trigger", triggerId: tg.id || "", who: tg.who }, action: "drill",
      since: ms(tg.at), wait: late || 0,
    });
  });

  /* ---------- 排序与汇总 ---------- */
  items.sort((a, b) => (RANK[a.level] - RANK[b.level]) || (b.wait - a.wait) || (b.at - a.at));
  return Object.assign({ at: now, day: ctx.day, items }, summarize(items, ctx.day, now));
}

/* 汇总口径也只写一份：角色过滤后重新汇总，页面拿到的数字和列表永远一致 */
function summarize(items, day, now) {
  const byWho = {}, byType = {};
  items.forEach(it => {
    (byWho[it.who] = byWho[it.who] || []).push(it);
    byType[it.type] = (byType[it.type] || 0) + 1;
  });
  const red = items.filter(x => x.level === "red").length;
  const startDay = Date.parse((day || "") + "T00:00:00+08:00") || (now || Date.now());
  return {
    byWho, byType,
    counts: { total: items.length, red, yellow: items.length - red,
      accept: byType.accept || 0, newbie: items.filter(x => x.role === "newbie").length,
      staff: items.filter(x => x.role === "staff").length,
      /* 今日新增：用 since 判断，方便页面显示「今天比昨天多了什么」 */
      newToday: items.filter(x => x.type !== "retest" && x.type !== "plan_unconfirmed" && x.since >= startDay).length },
  };
}

module.exports = { build, summarize, openTask };
