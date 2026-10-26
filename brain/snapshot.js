/* 快照编译：把全平台数据压成一份「可判断」的紧凑事实。
   原则：这里只搬运事实，不做任何推断。所有数字都来自 server.js 里已有的统计函数
   （userStats / riskOf / tasksOf），避免出现「AI 算一套、页面算一套」的两个口径。 */

const MAX_PEOPLE = 20;

function cut(s, n) {
  const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}
function dayOf(ms) {
  const n = Number(ms) || 0;
  return n ? new Date(n).toISOString().slice(0, 10) : "";
}

/* ctx = { day, users, S, helpers } */
function build(ctx) {
  const { day, users, S } = ctx;
  const h = ctx.helpers;
  const all = (users || []).filter(u => u.role === "newbie" && u.active !== false).slice(0, MAX_PEOPLE);

  const refs = {};
  const people = [];
  let red = 0, yellow = 0, green = 0;

  all.forEach(u => {
    const s = h.userStats(u, [day], S);
    const r = h.riskOf(u, S, s, day);
    if (r.level === "red") red++; else if (r.level === "yellow") yellow++; else green++;

    const tasks = h.tasksOf(u, S).filter(h.taskOpen);
    const overdue = tasks.filter(v => h.taskOverDays(v, day) >= 1)
      .sort((a, b) => h.taskOverDays(b, day) - h.taskOverDays(a, day));
    const returned = tasks.filter(v => v.cfm === 2);
    const reviews = tasks.filter(v => v.cfm === 3).sort((a, b) => (+a.updatedAt || 0) - (+b.updatedAt || 0));
    const cars = (S.carriers || []).filter(c => c.who === u.id);
    const carsNoNext = cars.filter(c => !h.carNext(c));
    const carsNoTask = cars.filter(c => !(c.actions || []).filter(v => !v.del).length);
    const openIssues = (S.issues || []).filter(x => x.who === u.id && (x.status || 0) < 2);

    /* 最该被处理的 3 条任务：超期 > 被退回 > 待验收 > 最近截止 */
    const picked = []
      .concat(overdue.slice(0, 2).map(v => ({ v, why: "over" })))
      .concat(returned.slice(0, 1).map(v => ({ v, why: "returned" })))
      .concat(reviews.slice(0, 1).map(v => ({ v, why: "review" })))
      .concat(tasks.filter(v => v.due && !overdue.includes(v)).sort((a, b) => String(a.due).localeCompare(String(b.due))).slice(0, 1).map(v => ({ v, why: "due" })));
    const seen = new Set();
    const topTasks = [];
    picked.forEach(({ v, why }) => {
      if (seen.has(v.id) || topTasks.length >= 3) return;
      seen.add(v.id);
      const ref = "task:" + (v.carId || "") + "." + v.id;
      topTasks.push({
        id: v.id,
        ref,
        text: cut(v.text, 26),
        why,
        due: String(v.due || "").slice(0, 10),
        over: h.taskOverDays(v, day),
        wait: v.updatedAt ? h.waitDays(v.updatedAt) : 0,
      });
      refs[ref] = "任务「" + cut(v.text, 18) + "」";
    });

    cars.forEach(c => { refs["car:" + c.id] = "客户「" + cut(c.name, 18) + "」"; });
    openIssues.forEach(x => { refs["issue:" + x.id] = "问题「" + cut(x.text, 18) + "」"; });
    refs["person:" + u.id] = u.name;

    /* 最近 3 条实际动作（任务日志 + 学习打卡），只用于让模型看出「他到底在干什么」 */
    const acts = [];
    h.tasksOf(u, S).forEach(v => (v.log || []).filter(y => !y.del).forEach(y => {
      acts.push({ at: Number(y.at) || 0, text: "任务「" + cut(v.text, 18) + "」：" + cut(y.text, 24) });
    }));
    (S.checkins || []).filter(x => x.who === u.id).forEach(x => {
      acts.push({ at: Number(x.createdAt) || 0, text: "打卡 " + cut(x.module || x.nodeId || "", 12) + (x.note ? "：" + cut(x.note, 20) : "") });
    });
    acts.sort((a, b) => b.at - a.at);
    const last3 = acts.slice(0, 3).map(a => dayOf(a.at) + " " + a.text);

    const mentor = (users || []).find(x => x.id === u.mentorId);
    /* idle=99 是「从未有动作」的哨兵值，直接显示会变成「连续 99 个工作日」，转成人话 */
    const humanize = x => cut(String(x).replace(/连续\s*99\s*个工作日无任何动作/, "从未产生任何动作记录"), 46);

    people.push({
      id: u.id,
      name: u.name,
      mentor: mentor ? mentor.name : "",
      days: s.joinsDays,
      risk: { level: r.level, red: r.red.slice(0, 4).map(humanize), yellow: r.yellow.slice(0, 4).map(humanize) },
      facts: {
        open: tasks.length,
        overdue: overdue.length,
        maxOverdueDays: overdue.length ? h.taskOverDays(overdue[0], day) : 0,
        returned: returned.length,
        review: reviews.length,
        reviewWait: reviews.length ? h.waitDays(reviews[0].updatedAt) : 0,
        idleDays: r.idle,
        lastActive: s.lastActiveDay || "",
        quizAcc: s.quizAcc,
        quizScore: (s.quizCorrect || 0) + "/" + (s.quizTotal || 0),
        drills14: s.dr14,
        cars: cars.length,
        carsNoNext: carsNoNext.length,
        carsNoTask: carsNoTask.length,
        openIssues: openIssues.length,
      },
      tasks: topTasks,
      carRefs: cars.slice(0, 2).map(c => "car:" + c.id),
      issueRefs: openIssues.slice(0, 2).map(x => "issue:" + x.id),
      gaps: carsNoNext.slice(0, 3).map(c => cut(c.name, 14)),
      last3,
      issues: openIssues.slice(0, 2).map(x => ({
        id: x.id,
        text: cut(x.text, 34),
        waitDays: h.waitDays(x.createdAt),
        replied: (x.replies || []).filter(r => !r.del).length,
      })),
      human: u.mentorNext ? { by: (users.find(x => x.id === u.mentorNextBy) || {}).name || "", text: cut(u.mentorNext, 100) } : null,
    });
  });

  /* 优先级排序不交给模型也能用：红灯 > 黄灯 > 其余，且越久没动作越靠前 */
  people.sort((a, b) => {
    const w = p => (p.risk.level === "red" ? 2 : p.risk.level === "yellow" ? 1 : 0);
    if (w(b) !== w(a)) return w(b) - w(a);
    return (b.facts.maxOverdueDays * 10 + b.facts.idleDays) - (a.facts.maxOverdueDays * 10 + a.facts.idleDays);
  });

  const sum = k => people.reduce((n, p) => n + (p.facts[k] || 0), 0);

  return {
    asOf: Date.now(),
    day,
    team: {
      total: people.length,
      red, yellow, green,
      openTasks: sum("open"),
      overdue: sum("overdue"),
      review: sum("review"),
      openIssues: sum("openIssues"),
      carsNoNext: sum("carsNoNext"),
      carsNoTask: sum("carsNoTask"),
      idle2plus: people.filter(p => p.facts.idleDays >= 2).length,
    },
    people,
    refs,
  };
}

module.exports = { build, cut };
