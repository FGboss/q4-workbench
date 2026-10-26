/* 规则版判断：没有任何模型、模型超时、模型输出不合格时使用。
   它不是「占位空壳」——排序、优先级、下一步建议都按现有口径算出来，
   所以就算一直不配模型，把控页也能用；配了模型再升级成会解释的版本。 */

const LEVEL_TEXT = { red: "需介入", yellow: "需关注", green: "正常" };

function nextOf(p) {
  const out = [];
  const over = (p.tasks || []).find(t => t.why === "over");
  const back = (p.tasks || []).find(t => t.why === "returned");
  if (back) out.push("按导师意见改完重新提交「" + back.text + "」");
  if (over) out.push("先处理超期 " + over.over + " 天的「" + over.text + "」");
  if (p.facts.review) out.push("催一次验收（" + p.facts.review + " 项在等" + (p.facts.reviewWait > 0 ? "，最久 " + p.facts.reviewWait + " 天" : "") + "）");
  if (p.facts.carsNoNext) out.push("给 " + p.facts.carsNoNext + " 个客户档案补下次跟进日");
  if (p.facts.carsNoTask) out.push("给空档案拆出下一步任务（做什么 + 截止日）");
  if (p.facts.quizAcc != null && p.facts.quizAcc < 70) out.push("重做错题，当前正确率 " + p.facts.quizAcc + "%");
  if (p.facts.drills14 === 0 && p.days >= 14) out.push("安排一次演练并当场复盘");
  if (p.facts.idleDays >= 99) out.push("从未产生动作记录，先确认他是否还会登录");
  else if (p.facts.idleDays >= 2) out.push("已连续 " + p.facts.idleDays + " 个工作日无动作，先问一句卡在哪");
  if (p.facts.openIssues) out.push("把未答复的问题收口（" + p.facts.openIssues + " 个）");
  out.push("和导师约 10 分钟确认下周优先级");
  return [...new Set(out)].slice(0, 3);
}

function build(snap) {
  const P = snap.people || [];
  const T = snap.team || {};
  const focus = P.filter(p => p.risk.level !== "green").slice(0, 5).map(p => ({
    id: p.id,
    name: p.name,
    level: p.risk.level,
    verdict: p.risk.red[0] || p.risk.yellow[0] || "推进正常，保持节奏",
    why: (p.risk.red.concat(p.risk.yellow)).slice(0, 2).join("；"),
    next: nextOf(p),
    evidence: (p.tasks || []).map(t => t.ref).concat(p.carRefs || []).filter(Boolean).slice(0, 3),
  }));
  const focusIds = new Set(focus.map(x => x.id));
  const others = P.filter(p => !focusIds.has(p.id)).slice(0, 10).map(p => ({
    id: p.id,
    name: p.name,
    oneLine: LEVEL_TEXT[p.risk.level] + "，" + (p.facts.idleDays >= 2 ? "已 " + p.facts.idleDays + " 个工作日无动作" : "推进中"),
  }));

  let headline;
  if (T.red > 0 && focus.length) headline = "今天 " + T.red + " 人需介入、" + T.yellow + " 人需关注；先处理 " + focus[0].name + "（" + String(focus[0].verdict).split("：")[0] + "）";
  else if (T.yellow > 0) headline = "没有红灯，" + T.yellow + " 人需关注；今天的重点是把空档案和过期跟进补上";
  else headline = "全员正常，今天不需要额外干预；建议做一次复盘沉淀";

  const why = [];
  if (T.overdue) why.push(T.overdue + " 项任务超期");
  if (T.review) why.push(T.review + " 项在等验收");
  if (T.openIssues) why.push(T.openIssues + " 个问题未答复");
  if (T.carsNoNext) why.push(T.carsNoNext + " 个客户档案没有下次跟进日");
  if (T.idle2plus) why.push(T.idle2plus + " 人超过 2 个工作日没有动作");

  const cross = [];
  if (T.carsNoNext) cross.push({ text: "全团队 " + T.carsNoNext + " 个客户档案没有下次跟进日，跟进容易断线", evidence: [] });
  const noDrill = P.filter(p => p.facts.drills14 === 0 && p.days >= 14).length;
  if (noDrill >= 2) cross.push({ text: noDrill + " 人近 14 天没有演练，建议统一排一次", evidence: [] });

  const dataGaps = [];
  if (T.carsNoNext) dataGaps.push({ text: T.carsNoNext + " 个客户档案没有下次跟进日" });
  if (T.carsNoTask) dataGaps.push({ text: T.carsNoTask + " 个客户档案下没有任何任务" });
  if (T.idle2plus) dataGaps.push({ text: T.idle2plus + " 人超过 2 个工作日没有任何动作" });

  return {
    global: {
      headline,
      state: T.red > 0 ? "tight" : T.yellow > 0 ? "steady" : "loose",
      topRiskId: focus.length ? focus[0].id : "",
      why: why.slice(0, 3),
    },
    focus,
    others,
    cross,
    excluded: [{ what: "未逐人列出全部待办", because: "同类问题合并成优先级，避免一天堆太多提醒" }],
    dataGaps,
  };
}

module.exports = { build };
