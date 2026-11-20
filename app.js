const KEY = "bacmath.history.v1";
const $app = document.getElementById("app");
// السجل: من الخادم إذا كان التلميذ مسجّلاً، وإلا من المتصفح (وضع الضيف)
let online = false, user = null, cache = null;
// ALLQ = كل الأسئلة التي يراها المستخدم (منها أسئلة الواجبات وأسئلة الأستاذ قيد المراجعة)
// QUESTIONS = الأسئلة المنشورة فقط، وهي المستعملة في التدريب والاختبار
let ALLQ = QUESTIONS.slice();
const isPublic = x => !x.status || x.status === "approved";
// تقدم مواضيع البكالوريا: {eid: {part: score}} — من الخادم للتلميذ المسجّل، وإلا من المتصفح
const BKEY = "bacmath.bac.v1";
let bacProg = null;
const bacLocal = () => { try { return JSON.parse(localStorage.getItem(BKEY)) || {}; } catch { return {}; } };
const bacGet = () => bacProg || bacLocal();
function bacSet(eid, part, score) {
  if (bacProg) { (bacProg[eid] ||= {})[part] = score; api("bac/progress", { eid, part, score }).catch(() => {}); }
  else { const p = bacLocal(); (p[eid] ||= {})[part] = score; try { localStorage.setItem(BKEY, JSON.stringify(p)); } catch {} }
}
// ---------- الشعب ----------
const SKEY = "bacmath.stream";
const streamOf = id => STREAMS.find(x => x.id === id) || STREAMS[0];
function myStream() {
  if (user && user.role === "student" && user.stream) return user.stream;
  try { return localStorage.getItem(SKEY) || "se"; } catch { return "se"; }
}
const chaptersOf = sid => streamOf(sid).ch.map(id => CHAPTERS.find(c => c.id === id)).filter(Boolean);
// أسئلة الشعبة: من وحداتها، بدون أنواع الدوال غير المقررة فيها (مثلاً المثلثية في آداب وفلسفة)
const tagsOf = q => q.tags || (q.tags = questionTags(q, (SOLUTIONS[q.id] || {}).s || []));
const excluded = (q, sid) => (streamOf(sid).exclude || []).some(t => tagsOf(q).includes(t));
const forStream = (list, sid) => list.filter(q => streamOf(sid).ch.includes(q.ch) && !excluded(q, sid));
const hasQ = (c, sid) => forStream(QUESTIONS, sid).some(q => q.ch === c.id);
const statChs = sid => chaptersOf(sid).filter(c => hasQ(c, sid)); // الوحدات التي فيها أسئلة تدخل في حساب العلامة
async function setStream(id) {
  if (user && user.role === "student") user = (await api("me/stream", { stream: id })).user;
  else try { localStorage.setItem(SKEY, id); } catch {}
}
const streamSelect = (id, sel) => `<select id="${id}">${STREAMS.map(x => `<option value="${x.id}"${x.id === sel ? " selected" : ""}>${x.name}</option>`).join("")}</select>`;
const chName = id => (CHAPTERS.find(c => c.id === id) || {}).name || "";
const localHistory = () => { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; } };
const load = () => cache ? cache.slice() : localHistory();
const save = h => { try { localStorage.setItem(KEY, JSON.stringify(h)); } catch {} };
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };
const pct = x => Math.round(x * 100);
let timerId = null;
const inFrame = (() => { try { return window.self !== window.top; } catch { return true; } })();

// عزل المقاطع الرياضية (اتجاه يسار←يمين) داخل النص العربي حتى لا ينقلب ترتيبها.
// السهم ← وعلامات «» والأقواس غير المتوازنة وعلامات الترقيم في الآخر تبقى في السياق العربي.
const esc = t => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const MATHY = /[A-Za-z0-9\u0370-\u03FF\u2070-\u209F\u2100-\u22FF√∫π∞]/;
function iso(run) {
  const lead = run.match(/^\s*/)[0], trail = run.slice(lead.length).match(/\s*$/)[0];
  let core = run.slice(lead.length, run.length - trail.length);
  if (!core) return run;
  const pre = core.match(/^[.,:;!?]+\s*/); // علامة ترقيم تابعة للجملة العربية السابقة
  if (pre) return lead + pre[0] + iso(core.slice(pre[0].length)) + trail;
  const open = []; let cut = -1;
  for (let i = 0; i < core.length && cut < 0; i++) {
    if (core[i] === "(") open.push(i);
    else if (core[i] === ")") { if (open.length) open.pop(); else cut = i; }
  }
  if (cut < 0 && open.length) cut = open[0];
  if (cut >= 0) return lead + iso(core.slice(0, cut)) + core[cut] + iso(core.slice(cut + 1)) + trail;
  const punct = core.match(/[.,:;]*$/)[0];
  core = core.slice(0, core.length - punct.length);
  return lead + (MATHY.test(core) ? `<span class="m" dir="ltr">${esc(core)}</span>` : esc(core)) + punct + trail;
}
const M = text => text.replace(/[^\u0600-\u06FF←«»]+/g, run => iso(run));

function record(qid, k, ok, hw = null) {
  const entry = { qid, ok, ts: Date.now() };
  if (cache) { cache.push(entry); api("attempts", { qid, k: k === undefined ? null : k, assignmentId: hw }).catch(() => {}); }
  else { const h = localHistory(); h.push(entry); save(h); }
}

// ---------- الاتصال بالخادم ----------
async function api(path, body) {
  const r = await fetch("/api/" + path, body === undefined ? { credentials: "same-origin" }
    : { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || "تعذّر الاتصال بالخادم، تحقق من الإنترنت");
  return data;
}
async function loadBank() {
  const r = await api("questions");
  ALLQ = r.questions;
  QUESTIONS.length = 0; QUESTIONS.push(...ALLQ.filter(isPublic));
  for (const k of Object.keys(SOLUTIONS)) delete SOLUTIONS[k];
  Object.assign(SOLUTIONS, r.solutions);
  ALLQ.forEach(q => { delete q.tags; tagsOf(q); });
}
async function setUser(u) {
  user = u || null; cache = null;
  if (user && user.role === "student") {
    const local = localHistory(); // نقل نتائج وضع الضيف إلى الحساب مرة واحدة
    if (local.length) { try { await api("attempts/import", { items: local }); localStorage.removeItem(KEY); } catch {} }
    cache = (await api("attempts")).history;
    const localBac = bacLocal(); // نقل تقييمات البكالوريا من وضع الضيف
    for (const [eid, parts] of Object.entries(localBac)) for (const [part, score] of Object.entries(parts))
      await api("bac/progress", { eid, part: Number(part), score }).catch(() => {});
    try { localStorage.removeItem(BKEY); } catch {}
    bacProg = (await api("bac/progress")).progress;
  } else bacProg = null;
  if (online) { try { await loadBank(); } catch {} }
  const acc = document.getElementById("acc");
  if (acc) { acc.hidden = !online; acc.textContent = user ? "👤 " + user.name : "دخول / حساب جديد"; }
}

// العدد مع المعدود حسب قواعد العربية: [مفرد، مثنى، جمع (3–10)، تمييز (11 فأكثر)]
const EXS = ["تمرين واحد", "تمرينان", "تمارين", "تمريناً"], PARTS = ["جزء واحد", "جزءان", "أجزاء", "جزءاً"];
const QS = ["سؤال واحد", "سؤالان", "أسئلة", "سؤالاً"], STUD = ["تلميذ واحد", "تلميذان", "تلاميذ", "تلميذاً"], ANS = ["إجابة واحدة", "إجابتان", "إجابات", "إجابة"];
const nOf = (n, f) => n === 1 ? f[0] : n === 2 ? f[1] : `${n} ${n % 100 >= 3 && n % 100 <= 10 ? f[2] : f[3]}`;
const dateStr = t => new Date(t).toLocaleDateString("ar-DZ");
const loading = () => { $app.innerHTML = `<div class="card"><p class="mute">جاري التحميل…</p></div>`; };
const failed = (e, back = "#account") => { $app.innerHTML = `<div class="card"><p class="msg">${esc(e.message)}</p><a href="${back}">العودة</a></div>`; };
// إحصائيات الوحدات من مجاميع الخادم {lim: [محاولات، صحيحة], ...}
const statsOf = (ch, chs = CHAPTERS) => chs.map(c => { const [a, k] = ch[c.id] || [0, 0]; return { ...c, attempts: a, correct: k, mastery: (k + 1) / (a + 2) }; });

// ---------- الحل المفصل ----------
// k = رقم الخيار الذي اختاره التلميذ (أو undefined إن لم يُجب)
function steps(q, sol = SOLUTIONS[q.id]) {
  return sol ? `<ol class="steps">${sol.s.map(x => `<li>${M(x)}</li>`).join("")}</ol>` : `<p>${M(q.e)}</p>`;
}
function correction(q, k, sol = SOLUTIONS[q.id]) {
  if (k === q.a) return `<div class="expl"><b class="okt">✅ إجابة صحيحة</b><p>${M(q.e)}</p>
    <details><summary>عرض الحل المفصل</summary>${steps(q, sol)}</details></div>`;
  const why = k !== undefined && sol && sol.w[k];
  return `<div class="expl wrong">
    <b class="badt">${k === undefined ? "⏳ لم تُجب عن هذا السؤال" : `❌ إجابة خاطئة: اخترت ${M(q.o[k])}`}</b>
    ${why ? `<div class="why"><b>لماذا هذا الجواب خاطئ؟</b><br>${M(why)}</div>` : ""}
    <p><b>الجواب الصحيح:</b> ${M(q.o[q.a])}</p>
    <b>الحل المفصل:</b>${steps(q, sol)}</div>`;
}

// ---------- الصفحة الرئيسية ----------
function home() {
  const sid = myStream(), st = chapterStats(load(), statChs(sid), ALLQ), p = predict(st);
  const weak = st.filter(c => c.attempts).sort((a, b) => a.mastery - b.mastery)[0];
  $app.innerHTML = `
  ${user && user.role === "parent" ? `<div class="card row"><span>أنت مسجّل كولي أمر. نتائج أبنائك في صفحة حسابك.</span><a class="btn" href="#account">متابعة أبنائي</a></div>` : ""}
  ${user && user.role === "teacher" ? `<div class="card row"><span>أنت مسجّل كأستاذ. نتائج تلاميذك وواجباتهم في صفحة أقسامك.</span><a class="btn" href="#account">أقسامي</a></div>` : ""}
  ${user && user.role === "student" ? `<div id="hwbox"></div>` : ""}
  <div class="card row"><label class="inline">شعبتي ${streamSelect("myStream", sid)}</label>
    <span class="mute">${p.attempts ? "" : "اختر شعبتك لترى وحداتها فقط."}</span></div>
  ${online && !user ? `<div class="card row"><span>أنشئ حساباً لتُحفظ نتائجك ويتابعها وليّك من هاتفه.</span><a class="btn sec" href="#account">إنشاء حساب</a></div>` : ""}
  <div class="grid">
    <div class="card"><div class="mute">العلامة المتوقعة في الباك</div>
      <div class="big">${p.attempts ? p.score.toFixed(1) : "—"}<small style="font-size:16px"> / 20</small></div>
      <div class="mute">${p.attempts ? (p.reliable ? `المجال: ${p.low.toFixed(1)} – ${p.high.toFixed(1)}` : "حل ١٥ سؤالاً على الأقل لتصبح النتيجة موثوقة") : "ابدأ بحل الأسئلة"}</div></div>
    <div class="card"><div class="mute">الأسئلة المحلولة</div><div class="big">${p.attempts}</div></div>
    <div class="card"><div class="mute">أضعف وحدة</div><div class="big" style="font-size:20px">${weak ? weak.name : "—"}</div>
      ${weak ? `<div class="mute">إتقان ${pct(weak.mastery)}%</div>` : ""}</div>
  </div>
  <div class="card"><h2>الوحدات</h2>
    ${chaptersOf(sid).map(c0 => { const c = st.find(x => x.id === c0.id);
      return c ? `<div style="margin:12px 0"><div class="row"><b>${c.name}</b>
      <span class="mute">${c.attempts ? `${c.correct}/${c.attempts} · إتقان ${pct(c.mastery)}%` : "لم تبدأ بعد"}</span></div>
      <div class="bar"><i style="width:${c.attempts ? pct(c.mastery) : 0}%"></i></div>
      <a class="btn sec" style="margin-top:6px;padding:4px 12px" href="#practice-${c.id}">تدرّب</a></div>`
      : `<div style="margin:12px 0" class="row"><b>${c0.name}</b><span class="mute">لا توجد أسئلة في هذه الوحدة بعد</span></div>`; }).join("")}
  </div>
  <div class="card row"><span>اختبار مدته ٢٠ دقيقة من ١٠ أسئلة تغطي كل الوحدات</span><a class="btn" href="#exam">ابدأ الاختبار</a></div>`;
  document.getElementById("myStream").onchange = async e => { try { await setStream(e.target.value); } catch {} home(); };
  if (user && user.role === "student") loadHomework();
}

// ---------- واجبات التلميذ ----------
async function loadHomework() {
  let list; try { list = (await api("my/classes")).assignments; } catch { return; }
  const box = document.getElementById("hwbox"); if (!box || !list.length) return; // ربما انتقل التلميذ إلى صفحة أخرى
  const todo = list.filter(x => x.mine.answered < x.qids.length).length;
  box.innerHTML = `<div class="card"><h2>واجباتي ${todo ? `<span class="tag">${todo} لم يُنجز</span>` : ""}</h2>${list.map(hwStudentRow).join("")}</div>`;
}
function hwStudentRow(x) {
  const n = x.qids.length, done = x.mine.answered >= n, late = x.due && x.due < Date.now() && !done;
  return `<div class="hw row"><div><b>${esc(x.title)}</b><br>
      <span class="mute">${esc(x.className)} · ${nOf(n, QS)} · ${x.due ? `<span class="${late ? "badt" : ""}">${late ? "انتهى الأجل" : "آخر أجل"} ${dateStr(x.due)}</span>` : "بدون أجل"}</span><br>
      <span class="${done ? "okt" : "mute"}">${done ? `✅ أنجزته: ${x.mine.correct}/${n} صحيحة` : `أجبت عن ${x.mine.answered} من ${n}`}</span></div>
    <a class="btn ${done ? "sec" : ""}" href="#hw-${x.id}">${done ? "مراجعة" : x.mine.answered ? "أكمل" : "ابدأ"}</a></div>`;
}
async function homework(id) {
  if (!user || user.role !== "student") return account();
  loading();
  let a; try { a = (await api("my/classes")).assignments.find(x => x.id === Number(id)); } catch (e) { return failed(e, "#home"); }
  if (!a) return failed(new Error("هذا الواجب غير موجود أو حذفه الأستاذ"), "#home");
  runQuiz({ questions: a.qids.map(i => ALLQ.find(q => q.id === i)).filter(Boolean), exam: false, title: a.title, hw: a.id });
}

// ---------- جلسة أسئلة (تدريب أو اختبار) ----------
function runQuiz({ questions, exam, title, hw = null }) {
  let i = 0, score = 0, answered = false, left = 20 * 60;
  const answers = [];
  const qs = questions.map(q => {
    const order = shuffle(q.o.map((_, k) => k));
    return { ...q, order };
  });
  if (exam) {
    timerId = setInterval(() => { left--; const t = document.getElementById("t"); if (t) t.textContent = fmt(left); if (left <= 0) finish(); }, 1000);
  }
  const fmt = s => `${String(s / 60 | 0).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

  function show() {
    const q = qs[i]; answered = false;
    $app.innerHTML = `<div class="card">
      <div class="row"><b>${title}</b><span class="mute">سؤال ${i + 1} / ${qs.length}</span>${exam ? `<span class="timer" id="t">${fmt(left)}</span>` : ""}</div>
      <div class="bar" style="margin:10px 0"><i style="width:${i / qs.length * 100}%"></i></div>
      <p class="q"><span class="tag">${DIFF[q.d]}</span> ${M(q.q)}</p>
      ${q.order.map((k, n) => `<button class="opt" data-k="${k}">${M(q.o[k])}</button>`).join("")}
      <div id="fb"></div>
      <div style="margin-top:12px"><button id="next" ${exam ? "" : "disabled"}>${i === qs.length - 1 ? "إنهاء" : "التالي"}</button></div></div>`;
    document.querySelectorAll(".opt").forEach(b => b.onclick = () => choose(+b.dataset.k, b));
    document.getElementById("next").onclick = () => { if (!exam && !answered) return; if (i === qs.length - 1) finish(); else { i++; show(); } };
  }
  function choose(k, btn) {
    const q = qs[i];
    if (exam) { // في الاختبار: لا كشف للإجابة، يمكن تغييرها قبل المتابعة
      document.querySelectorAll(".opt").forEach(b => b.classList.remove("sel")); btn.classList.add("sel");
      answers[i] = k; return;
    }
    if (answered) return; answered = true;
    const ok = k === q.a; if (ok) score++; record(q.id, k, ok, hw);
    document.querySelectorAll(".opt").forEach(b => { b.disabled = true; if (+b.dataset.k === q.a) b.classList.add("ok"); });
    if (!ok) btn.classList.add("bad");
    document.getElementById("fb").innerHTML = correction(q, k);
    document.getElementById("next").disabled = false;
  }
  function finish() {
    clearInterval(timerId);
    if (exam) { score = 0; qs.forEach((q, n) => { const ok = answers[n] === q.a; if (ok) score++; record(q.id, answers[n], ok); }); }
    const mark = (score / qs.length * 20).toFixed(1);
    $app.innerHTML = `<div class="card" style="text-align:center"><h2>انتهت الجلسة</h2>
      <div class="big">${score} / ${qs.length}</div><div class="mute">العلامة: ${mark} / 20</div>
      <p><a class="btn" href="#home">${hw ? "العودة إلى واجباتي" : "لوحة النتائج"}</a></p></div>
      ${exam ? `<div class="card"><h2>التصحيح</h2>${qs.map((q, n) => `<div class="corr"><p class="q"><span class="tag">${n + 1}</span> ${M(q.q)}</p>${correction(q, answers[n])}</div>`).join("")}</div>` : ""}`;
  }
  show();
}

// ---------- تقرير الولي ----------
// h = سجل التلميذ، who = اسمه (عند عرض الولي لتقرير ابنه)
function report(h = load(), who = null, back = "#account", backLabel = "العودة إلى قائمة أبنائي", sid = myStream()) {
  const st = chapterStats(h, statChs(sid), ALLQ), p = predict(st);
  const last = h.length ? new Date(Math.max(...h.map(r => r.ts))).toLocaleDateString("ar-DZ") : "—";
  $app.innerHTML = `<div class="card"><h2>تقرير متابعة ${who ? esc(who) : "التلميذ"}</h2>
    ${who ? `<p><a href="${back}">← ${backLabel}</a></p>` : ""}
    <p class="mute">الشعبة: ${streamOf(sid).name} · آخر نشاط: ${last}</p>
    <p>عدد الأسئلة المحلولة: <b>${p.attempts}</b> — العلامة المتوقعة: <b>${p.attempts ? p.score.toFixed(1) + " / 20" : "—"}</b>
      ${p.attempts && p.reliable ? `(${p.low.toFixed(1)} – ${p.high.toFixed(1)})` : ""}</p>
    <div class="tablewrap"><table style="width:100%;border-collapse:collapse">
      <tr style="text-align:start"><th>الوحدة</th><th>محاولات</th><th>صحيحة</th><th>الإتقان</th><th>التوصية</th></tr>
      ${st.map(c => `<tr style="border-top:1px solid var(--line)"><td>${c.name}</td><td>${c.attempts}</td><td>${c.correct}</td><td>${c.attempts ? pct(c.mastery) + "%" : "—"}</td>
        <td>${!c.attempts ? "لم تُدرَّس بعد" : c.mastery < .5 ? "⚠️ تحتاج مراجعة" : c.mastery < .75 ? "جيد — واصل" : "ممتاز"}</td></tr>`).join("")}
    </table></div>
    <h2 style="margin-top:16px">حسب مستوى الصعوبة</h2>
    ${[1, 2, 3].map(d => { const ids = new Set(ALLQ.filter(q => q.d === d).map(q => q.id)), x = h.filter(r => ids.has(r.qid)), c = x.filter(r => r.ok).length;
      return `<p>${DIFF[d]}: <b>${x.length ? pct(c / x.length) + "%" : "—"}</b> <span class="mute">(${c}/${x.length})</span></p>`; }).join("")}
    <p class="noprint row" style="margin-top:12px;justify-content:flex-start">${inFrame ? "" : `<button id="prt">طباعة</button>`}
      ${who || cache ? "" : `<button class="sec" id="clr">مسح النتائج</button>`}</p></div>`;
  const prt = document.getElementById("prt"); if (prt) prt.onclick = () => print();
  const clr = document.getElementById("clr");
  if (clr) clr.onclick = () => { // تأكيد بضغطتين بدل نافذة confirm
    if (clr.dataset.armed) { try { localStorage.removeItem(KEY); } catch {} report(); return; }
    clr.dataset.armed = "1"; clr.textContent = "اضغط مرة أخرى لتأكيد المسح";
  };
}

// ---------- الحساب ----------
const val = id => document.getElementById(id).value;
function onSubmit(form, fn) {
  form.onsubmit = async ev => {
    ev.preventDefault();
    const btn = form.querySelector("button[type=submit]"), msg = document.getElementById("msg");
    btn.disabled = true; msg.textContent = "";
    try { await fn(); } catch (e) { msg.textContent = e.message; btn.disabled = false; }
  };
}
function logoutButton() {
  document.getElementById("out").onclick = async () => {
    try { await api("logout", {}); } catch {}
    await setUser(null); location.hash = "#home";
  };
}
async function account() {
  if (!online) return home();
  if (!user) {
    $app.innerHTML = `<p class="msg" id="msg" role="alert"></p>
    <div class="grid">
      <form class="card" id="fLogin"><h2>تسجيل الدخول</h2>
        <label>رقم الهاتف أو البريد الإلكتروني<input id="lLogin" autocomplete="username" required></label>
        <label>كلمة السر<input id="lPass" type="password" autocomplete="current-password" required></label>
        <button type="submit">دخول</button></form>
      <form class="card" id="fReg"><h2>حساب جديد</h2>
        <fieldset class="roles"><legend>نوع الحساب</legend>
          <label><input type="radio" name="role" id="rStudent" value="student" checked> تلميذ</label>
          <label><input type="radio" name="role" id="rParent" value="parent"> ولي أمر</label>
          <label><input type="radio" name="role" id="rTeacher" value="teacher"> أستاذ</label></fieldset>
        <label id="rStreamL">الشعبة${streamSelect("rStream", myStream())}</label>
        <label>الاسم الكامل<input id="rName" required minlength="2" maxlength="60" autocomplete="name"></label>
        <label>رقم الهاتف أو البريد الإلكتروني<input id="rLogin" required autocomplete="username"></label>
        <label>كلمة السر (6 أحرف على الأقل)<input id="rPass" type="password" required minlength="6" autocomplete="new-password"></label>
        <button type="submit">إنشاء الحساب</button></form>
    </div>`;
    document.querySelectorAll("input[name=role]").forEach(r => r.onchange = () => { document.getElementById("rStreamL").hidden = !document.getElementById("rStudent").checked; });
    onSubmit(document.getElementById("fLogin"), async () => {
      const r = await api("login", { login: val("lLogin"), password: val("lPass") });
      await setUser(r.user); account();
    });
    onSubmit(document.getElementById("fReg"), async () => {
      const role = ["rParent", "rTeacher"].map(i => document.getElementById(i)).find(x => x.checked)?.value || "student";
      const r = await api("register", { name: val("rName"), login: val("rLogin"), password: val("rPass"), role, ...(role === "student" ? { stream: val("rStream") } : {}) });
      await setUser(r.user); account();
    });
    return;
  }
  if (user.role === "teacher") return teacherHome();
  if (user.role === "student") {
    loading();
    let mine = { classes: [] }; try { mine = await api("my/classes"); } catch {}
    $app.innerHTML = `<div class="card"><h2>مرحباً ${esc(user.name)}</h2><p class="mute">حساب تلميذ · شعبة ${streamOf(user.stream).name}</p>
      <p>رمز الربط الخاص بك:</p><p class="code">${esc(user.linkCode)}</p>
      <p class="mute">أعطِ هذا الرمز لولي أمرك ليربط حسابه بحسابك ويتابع نتائجك من هاتفه.</p>
      <p>نتائجك محفوظة في حسابك: <b>${nOf(cache.length, ANS)}</b>، وتجدها من أي جهاز تسجّل منه الدخول.</p>
      <div class="row" style="justify-content:flex-start"><a class="btn" href="#home">ابدأ التدريب</a><button class="sec" id="out">تسجيل الخروج</button></div></div>
    <form class="card" id="fJoin"><h2>أقسامي</h2>
      ${mine.classes.length ? mine.classes.map(c => `<p><b>${esc(c.name)}</b> <span class="mute">· الأستاذ: ${esc(c.teacher)}</span></p>`).join("") : `<p class="mute">لم تنضم إلى أي قسم بعد.</p>`}
      <p class="msg" id="msg" role="alert"></p>
      <label>رمز القسم (يعطيك إياه أستاذك)<input id="jCode" required maxlength="6" autocomplete="off" dir="ltr" class="codein"></label>
      <button type="submit">الانضمام إلى القسم</button></form>`;
    onSubmit(document.getElementById("fJoin"), async () => { await api("classes/join", { code: val("jCode") }); account(); });
    return logoutButton();
  }
  // ولي أمر
  $app.innerHTML = `<div class="card"><p class="mute">جاري التحميل…</p></div>`;
  let children = [];
  try { children = (await api("children")).children; } catch (e) { $app.innerHTML = `<div class="card msg">${esc(e.message)}</div>`; return; }
  $app.innerHTML = `<div class="card"><h2>مرحباً ${esc(user.name)}</h2><p class="mute">حساب ولي أمر</p></div>
    <div class="card"><h2>أبنائي</h2>
      ${children.length ? children.map(c => `<div class="child row"><div><b>${esc(c.name)}</b> <span class="mute">· ${streamOf(c.stream).name}</span><br>
          <span class="mute">${c.attempts ? `${nOf(c.attempts, ANS)} · ${pct(c.correct / c.attempts)}% صحيحة · آخر نشاط ${new Date(c.last).toLocaleDateString("ar-DZ")}` : "لم يبدأ التدريب بعد"}</span></div>
          <a class="btn sec" href="#child-${c.id}">التقرير المفصل</a></div>`).join("")
        : `<p class="mute">لم تربط أي تلميذ بعد. اطلب من ابنك رمز الربط الظاهر في صفحة «حسابي» عنده.</p>`}</div>
    <form class="card" id="fLink"><h2>ربط تلميذ بحسابي</h2>
      <p class="msg" id="msg" role="alert"></p>
      <label>رمز الربط (6 أحرف)<input id="code" required maxlength="6" autocomplete="off" dir="ltr" class="codein"></label>
      <button type="submit">ربط</button></form>
    <p><button class="sec" id="out">تسجيل الخروج</button></p>`;
  onSubmit(document.getElementById("fLink"), async () => { await api("children/link", { code: val("code") }); account(); });
  logoutButton();
}
async function childReport(id) {
  if (!user || user.role !== "parent") return account();
  loading();
  try { const r = await api(`children/${id}/attempts`); report(r.history, r.name, "#account", "العودة إلى قائمة أبنائي", r.stream); } catch (e) { failed(e); }
}

// ---------- الأستاذ ----------
async function teacherHome() {
  loading();
  let classes; try { classes = (await api("classes")).classes; } catch (e) { return failed(e, "#home"); }
  $app.innerHTML = `<div class="card"><h2>مرحباً ${esc(user.name)}</h2><p class="mute">حساب أستاذ</p></div>
    <div class="card"><h2>أقسامي</h2>
      ${classes.length ? classes.map(c => `<div class="child row"><div><b>${esc(c.name)}</b><br>
          <span class="mute">${streamOf(c.stream).name} · ${nOf(c.students, STUD)} · الرمز <span dir="ltr">${esc(c.code)}</span></span></div>
          <a class="btn sec" href="#class-${c.id}">فتح القسم</a></div>`).join("")
        : `<p class="mute">لم تُنشئ أي قسم بعد. أنشئ قسماً ثم أعطِ رمزه لتلاميذك.</p>`}</div>
    <div class="card row"><div><h2>بنك أسئلتي</h2><p class="mute">أضف أسئلتك وحلولها. تُستعمل فوراً في واجبات أقسامك، وتظهر لكل التلاميذ بعد المراجعة.</p></div>
      <a class="btn sec" href="#questions">أسئلتي</a></div>
    ${user.admin ? `<div class="card row"><span>أنت مدير المنصة.</span><a class="btn" href="#review">مراجعة أسئلة الأساتذة</a></div>` : ""}
    <form class="card" id="fClass"><h2>إنشاء قسم جديد</h2><p class="msg" id="msg" role="alert"></p>
      <label>اسم القسم<input id="cName" required maxlength="60" placeholder="مثال: 3 علوم تجريبية 2"></label>
      <label>الشعبة${streamSelect("cStream", "se")}</label>
      <button type="submit">إنشاء القسم</button></form>
    <p><button class="sec" id="out">تسجيل الخروج</button></p>`;
  onSubmit(document.getElementById("fClass"), async () => { const r = await api("classes", { name: val("cName"), stream: val("cStream") }); location.hash = "#class-" + r.class.id; });
  logoutButton();
}
const lvl = r => r === null ? "" : r < .5 ? "lv-bad" : r < .75 ? "lv-mid" : "lv-good";
const rate = c => c && c[0] ? c[1] / c[0] : null;
function hwTeacherRow(a, students) {
  const n = a.qids.length, prog = s => a.progress[s.id];
  const done = students.filter(s => (prog(s)?.answered || 0) >= n), started = students.filter(prog);
  const avg = started.length ? started.reduce((t, s) => t + prog(s).correct / n, 0) / started.length : null;
  const late = a.due && a.due < Date.now();
  return `<div class="hw"><div class="row"><div><b>${esc(a.title)}</b><br>
      <span class="mute">${nOf(n, QS)} · ${a.due ? `${late ? "انتهى الأجل" : "آخر أجل"} ${dateStr(a.due)}` : "بدون أجل"}</span></div>
      <span class="mute">أنجزه ${done.length} من ${students.length}${avg === null ? "" : ` · المعدل ${(avg * 20).toFixed(1)} / 20`}</span></div>
    <div class="bar"><i style="width:${students.length ? done.length / students.length * 100 : 0}%"></i></div>
    <details><summary>تفاصيل التلاميذ</summary>
      <table class="mini">${students.map(s => { const p = prog(s);
        return `<tr><td>${esc(s.name)}</td><td>${!p ? `<span class="badt">لم يبدأ</span>` : p.answered < n ? `أجاب عن ${p.answered} من ${n}` : `<span class="okt">أنجزه: ${p.correct}/${n} صحيحة</span>`}</td></tr>`; }).join("")}</table>
      <button class="sec del" type="button" data-id="${a.id}">حذف الواجب</button></details></div>`;
}
async function classPage(id) {
  if (!user || user.role !== "teacher") return account();
  loading();
  let d; try { d = await api(`classes/${id}`); } catch (e) { return failed(e); }
  const { students, assignments } = d, cls = d.class, active = students.filter(s => s.attempts);
  const chs = chaptersOf(cls.stream), pchs = chs.filter(c => hasQ(c, cls.stream));
  const preds = active.map(s => predict(statsOf(s.ch, pchs)).score);
  const avgPred = preds.length ? preds.reduce((a, b) => a + b, 0) / preds.length : null;
  const tot = {};
  for (const s of students) for (const [ch, [a, k]] of Object.entries(s.ch)) { const t = tot[ch] || (tot[ch] = [0, 0]); t[0] += a; t[1] += k; }
  const weak = chs.filter(c => tot[c.id]).sort((a, b) => rate(tot[a.id]) - rate(tot[b.id]))[0];
  const cell = c => { const r = rate(c); return `<td class="${lvl(r)}"${c ? ` title="${c[1]} صحيحة من ${c[0]}"` : ""}>${r === null ? "—" : pct(r) + "%"}</td>`; };
  $app.innerHTML = `<p><a href="#account">← أقسامي</a></p>
  <div class="card"><h2>${esc(cls.name)}</h2><p class="mute">شعبة ${streamOf(cls.stream).name}</p><p>رمز القسم:</p><p class="code">${esc(cls.code)}</p>
    <p class="mute">أعطِ هذا الرمز لتلاميذك: ينشئ كل تلميذ حساباً، ثم يُدخل الرمز في صفحة «حسابي».</p></div>
  <div class="grid">
    <div class="card"><div class="mute">التلاميذ</div><div class="big">${students.length}</div><div class="mute">${active.length} بدأوا التدريب</div></div>
    <div class="card"><div class="mute">متوسط العلامة المتوقعة</div><div class="big">${avgPred === null ? "—" : avgPred.toFixed(1)}<small style="font-size:16px"> / 20</small></div></div>
    <div class="card"><div class="mute">أضعف وحدة في القسم</div><div class="big" style="font-size:20px">${weak ? weak.name : "—"}</div>
      ${weak ? `<div class="mute">${pct(rate(tot[weak.id]))}% إجابات صحيحة</div>` : ""}</div>
  </div>
  <div class="card"><h2>نتائج التلاميذ حسب الوحدة</h2>
    ${students.length ? `<p class="mute">النسبة = الإجابات الصحيحة من مجموع إجابات التلميذ في الوحدة. اضغط على اسم التلميذ لرؤية تقريره المفصل. العلامة المعلّمة بـ * تقدير أولي لأن التلميذ أجاب عن أقل من 15 سؤالاً.</p>
      <div class="legend"><span class="lv-bad">أقل من 50%</span><span class="lv-mid">من 50% إلى 75%</span><span class="lv-good">75% فأكثر</span></div>
      <div class="tablewrap"><table class="heat"><thead><tr><th>التلميذ</th><th>إجابات</th><th>العلامة المتوقعة</th>${chs.map(c => `<th>${c.name}</th>`).join("")}<th>آخر نشاط</th></tr></thead>
      <tbody>${students.map(s => `<tr><th><a href="#student-${cls.id}-${s.id}">${esc(s.name)}</a></th><td>${s.attempts}</td>
        <td>${!s.attempts ? "—" : s.attempts < 15 ? `<span class="mute" title="تقدير أولي: أقل من 15 إجابة">${predict(statsOf(s.ch, pchs)).score.toFixed(1)}*</span>` : predict(statsOf(s.ch, pchs)).score.toFixed(1)}</td>${chs.map(c => cell(s.ch[c.id])).join("")}<td>${s.last ? dateStr(s.last) : "—"}</td></tr>`).join("")}</tbody>
      <tfoot><tr><th>القسم</th><td>${students.reduce((a, s) => a + s.attempts, 0)}</td><td>${avgPred === null ? "—" : avgPred.toFixed(1)}</td>${chs.map(c => cell(tot[c.id])).join("")}<td></td></tr></tfoot></table></div>`
      : `<p class="mute">لم ينضم أي تلميذ بعد.</p>`}</div>
  <div class="card"><h2>الواجبات</h2>${assignments.length ? assignments.map(a => hwTeacherRow(a, students)).join("") : `<p class="mute">لم تُرسل أي واجب بعد.</p>`}</div>
  <form class="card" id="fHw"><h2>إرسال واجب جديد</h2><p class="msg" id="msg" role="alert"></p>
    <label>العنوان<input id="hTitle" required maxlength="80" placeholder="مثال: مراجعة الدالة الأسية"></label>
    <div class="grid2">
      <label>الوحدة<select id="hCh"><option value="">كل وحدات الشعبة</option>${chs.map(c => `<option value="${c.id}">${c.name}</option>`).join("")}</select></label>
      <label>الصعوبة<select id="hD"><option value="0">كل المستويات</option>${[1, 2, 3].map(d => `<option value="${d}">${DIFF[d]}</option>`).join("")}</select></label>
      <label>عدد الأسئلة<input id="hN" type="number" min="1" max="20" value="5" required></label>
      <label>آخر أجل للتسليم (اختياري)<input id="hDue" type="date"></label>
    </div>
    <p class="mute" id="hAvail"></p>
    <button type="submit">إرسال الواجب إلى القسم</button></form>`;
  const avail = () => {
    const ch = val("hCh"), d = +val("hD");
    const n = ALLQ.filter(q => (isPublic(q) || (q.mine && q.status === "pending")) && !excluded(q, cls.stream)
      && (ch ? q.ch === ch : chs.some(c => c.id === q.ch)) && (!d || q.d === d)).length;
    document.getElementById("hAvail").textContent = n ? `متوفر ${nOf(n, QS)} بهذه الشروط، وتُختار الأسئلة عشوائياً منها.` : "لا توجد أسئلة بهذه الشروط، غيّر الوحدة أو الصعوبة.";
  };
  ["hCh", "hD"].forEach(i => document.getElementById(i).onchange = avail); avail();
  onSubmit(document.getElementById("fHw"), async () => {
    const due = val("hDue") ? new Date(val("hDue") + "T23:59:59").getTime() : null;
    await api(`classes/${cls.id}/assignments`, { title: val("hTitle"), chapter: val("hCh"), difficulty: +val("hD"), count: +val("hN"), due });
    classPage(cls.id);
  });
  document.querySelectorAll(".del").forEach(b => twoClick(b, async () => { await api(`assignments/${b.dataset.id}/delete`, {}); classPage(cls.id); }));
}
async function teacherStudent(cid, sid) {
  if (!user || user.role !== "teacher") return account();
  loading();
  try { const r = await api(`classes/${cid}/students/${sid}/attempts`); report(r.history, r.name, `#class-${cid}`, "العودة إلى القسم", r.stream); }
  catch (e) { failed(e, `#class-${cid}`); }
}

// ---------- بنك أسئلة الأستاذ ----------
const attr = t => esc(String(t)).replace(/"/g, "&quot;");
const STATUS = { pending: "بانتظار المراجعة", approved: "منشور", rejected: "مرفوض" };
function twoClick(btn, action) { // تأكيد بضغطتين بدل نافذة confirm
  btn.onclick = async () => {
    if (!btn.dataset.armed) { btn.dataset.armed = "1"; btn.textContent = "اضغط مرة أخرى للتأكيد"; return; }
    try { await action(); } catch (e) { btn.textContent = e.message; }
  };
}
async function myQuestions() {
  if (!user || user.role !== "teacher") return account();
  loading();
  try { await loadBank(); } catch (e) { return failed(e); }
  const mine = ALLQ.filter(x => x.mine).sort((a, b) => b.id - a.id);
  const count = st => mine.filter(x => x.status === st).length;
  $app.innerHTML = `<p><a href="#account">← حسابي</a></p>
    <div class="card row"><div><h2>بنك أسئلتي</h2>
      <p class="mute">${mine.length ? `${count("approved")} منشور · ${count("pending")} بانتظار المراجعة · ${count("rejected")} مرفوض` : "لم تضف أي سؤال بعد."}</p></div>
      <a class="btn" href="#qedit">+ سؤال جديد</a></div>
    ${user.admin ? `<div class="card row"><span>أنت مدير المنصة.</span><a class="btn sec" href="#review">مراجعة أسئلة الأساتذة</a></div>` : ""}
    ${mine.length ? `<div class="card">${mine.map(x => `<div class="qitem">
        <div class="row"><span><span class="chip ${x.status}">${STATUS[x.status]}</span> <span class="mute">${chName(x.ch)} · ${DIFF[x.d]}</span></span>
          <span class="row">${x.status !== "approved" || user.admin ? `<a class="btn sec" href="#qedit-${x.id}">تعديل</a>` : ""}
            ${x.status !== "approved" ? `<button class="sec del" type="button" data-id="${x.id}">حذف</button>` : ""}</span></div>
        <p class="q">${M(x.q)}</p>
        ${x.status === "rejected" && x.note ? `<div class="why"><b>ملاحظة المراجع:</b> ${esc(x.note)}</div>` : ""}</div>`).join("")}</div>` : ""}`;
  document.querySelectorAll(".del").forEach(b => twoClick(b, async () => { await api(`questions/${b.dataset.id}/delete`, {}); myQuestions(); }));
}

const SYMBOLS = ["²", "³", "ⁿ", "√", "π", "∞", "≤", "≥", "≠", "⇔", "←", "∫", "Σ", "Δ", "θ", "∈", "ℝ", "ℂ", "−", "×", "·", "₀", "₁", "ₙ", "ₙ₊₁", "e^x", "ln", "lim"];
async function editor(id) {
  if (!user || user.role !== "teacher") return account();
  let q0 = null, sol0 = { s: [], w: {} };
  if (id) {
    loading();
    try { await loadBank(); } catch (e) { return failed(e, "#questions"); }
    q0 = ALLQ.find(x => x.id === Number(id)); sol0 = q0 && SOLUTIONS[q0.id];
    if (!q0 && user.admin) { // سؤال أستاذ آخر بانتظار المراجعة
      try { const r = (await api("review")).questions.find(x => x.id === Number(id)); if (r) { q0 = r; sol0 = { s: r.s, w: r.w }; } } catch {}
    }
    if (!q0) return failed(new Error("السؤال غير موجود"), "#questions");
    if (!q0.mine && !user.admin) return failed(new Error("لا يمكنك تعديل هذا السؤال"), "#questions");
  }
  const back = user.admin && q0 && !q0.mine ? "#review" : "#questions";
  const st = { o: q0 ? q0.o.slice() : ["", "", "", ""], a: q0 ? q0.a : 0 };
  st.w = st.o.map((_, i) => (sol0 && sol0.w[i]) || "");
  $app.innerHTML = `<p><a href="${back}">← رجوع</a></p>
  <form class="card" id="fQ"><h2>${q0 ? "تعديل السؤال" : "سؤال جديد"}</h2>
    ${q0 && q0.status === "rejected" && q0.note ? `<div class="why"><b>ملاحظة المراجع:</b> ${esc(q0.note)}</div>` : ""}
    <div class="symbols" id="sym">${SYMBOLS.map(x => `<button type="button" class="sec" dir="ltr">${x}</button>`).join("")}</div>
    <p class="mute small">اضغط على رمز لإدراجه في الخانة التي تكتب فيها.</p>
    <div class="grid2">
      <label>الوحدة<select id="eCh">${CHAPTERS.map(c => `<option value="${c.id}"${q0 && q0.ch === c.id ? " selected" : ""}>${c.name}</option>`).join("")}</select></label>
      <label>الصعوبة<select id="eD">${[1, 2, 3].map(d => `<option value="${d}"${(q0 ? q0.d : 2) === d ? " selected" : ""}>${DIFF[d]}</option>`).join("")}</select></label>
    </div>
    <label>نص السؤال<textarea id="eQ" rows="2" maxlength="600" required>${q0 ? esc(q0.q) : ""}</textarea></label>
    <fieldset class="opts"><legend>الخيارات: حدّد الجواب الصحيح، واشرح تحت كل خيار خاطئ سبب الخطأ</legend>
      <div id="optRows"></div><button type="button" class="sec" id="addOpt">+ إضافة خيار</button></fieldset>
    <label>شرح مختصر (يظهر عند الإجابة الصحيحة)<textarea id="eE" rows="2" maxlength="600" required>${q0 ? esc(q0.e) : ""}</textarea></label>
    <label>خطوات الحل المفصل (اكتب كل خطوة في سطر)<textarea id="eS" rows="5" required>${esc(((sol0 && sol0.s) || []).join("\n"))}</textarea></label>
    <p class="mute small" id="eTags"></p>
    <p class="msg" id="msg" role="alert"></p>
    <button type="submit">${q0 ? "حفظ التعديلات" : "إرسال السؤال للمراجعة"}</button>
    ${!user.admin ? `<p class="mute small">يمكنك استعمال السؤال في واجبات أقسامك فوراً، ويظهر لكل التلاميذ بعد قبوله.</p>` : ""}
  </form>
  <div class="card"><h2>معاينة كما يراها التلميذ</h2><div id="prev"></div>
    <label>معاينة التصحيح عند اختيار<select id="pK"></select></label><div id="prevFb"></div></div>`;
  const form = document.getElementById("fQ"), rows = document.getElementById("optRows");
  const readRows = () => { st.o = st.o.map((_, i) => val("o" + i)); st.w = st.w.map((_, i) => document.getElementById("w" + i)?.value || ""); };
  const drawRows = () => {
    rows.innerHTML = st.o.map((o, i) => `<div class="optrow${i === st.a ? " right" : ""}">
      <div class="row"><label class="radio"><input type="radio" name="right" value="${i}"${i === st.a ? " checked" : ""}> صحيح</label>
        <input id="o${i}" value="${attr(o)}" placeholder="الخيار ${i + 1}" maxlength="200" required>
        ${st.o.length > 2 ? `<button type="button" class="sec rm" data-i="${i}" aria-label="حذف الخيار ${i + 1}">✕</button>` : ""}</div>
      ${i === st.a ? "" : `<textarea id="w${i}" rows="1" maxlength="400" placeholder="لماذا هذا الخيار خاطئ؟ ما الخطأ الشائع الذي يقود إليه؟">${esc(st.w[i])}</textarea>`}</div>`).join("");
    rows.querySelectorAll("input[name=right]").forEach(r => r.onchange = () => { readRows(); st.a = +r.value; drawRows(); preview(); });
    rows.querySelectorAll(".rm").forEach(b => b.onclick = () => {
      readRows(); const i = +b.dataset.i; st.o.splice(i, 1); st.w.splice(i, 1);
      if (st.a === i) st.a = 0; else if (st.a > i) st.a--; drawRows(); preview();
    });
    document.getElementById("addOpt").hidden = st.o.length >= 6;
  };
  const build = () => {
    readRows();
    return { ch: val("eCh"), d: +val("eD"), q: val("eQ").trim(), o: st.o.map(x => x.trim()), a: st.a, e: val("eE").trim(),
      s: val("eS").split("\n").map(x => x.trim()).filter(Boolean),
      w: Object.fromEntries(st.w.map((x, i) => [i, x.trim()]).filter(([i, x]) => x && Number(i) !== st.a)) };
  };
  const preview = () => {
    const x = build(), pk = document.getElementById("pK"), cur = pk.value;
    document.getElementById("prev").innerHTML = `<p class="q"><span class="tag">${DIFF[x.d]}</span> ${M(x.q || "…")}</p>
      ${x.o.map((o, i) => `<div class="opt${i === x.a ? " ok" : ""}">${M(o || "…")}</div>`).join("")}`;
    pk.innerHTML = x.o.map((_, i) => `<option value="${i}">${i === x.a ? "الجواب الصحيح" : `الخيار ${i + 1} (خاطئ)`}</option>`).join("");
    pk.value = cur !== "" && +cur < x.o.length ? cur : String(x.o.findIndex((_, i) => i !== x.a));
    document.getElementById("prevFb").innerHTML = correction({ ...x, id: 0 }, +pk.value, { s: x.s.length ? x.s : ["…"], w: x.w });
    const tg = questionTags(x, x.s), TN = { trig: "دوال مثلثية", exp: "دالة أسية", log: "دالة لوغاريتمية" };
    const out = STREAMS.filter(st => st.ch.includes(x.ch) && (st.exclude || []).some(t => tg.includes(t))).map(st => st.name);
    document.getElementById("eTags").textContent = tg.length ? `يحتوي السؤال على: ${tg.map(t => TN[t]).join("، ")}.${out.length ? ` لن يظهر لشعبة ${out.join(" و")} لأنها غير مقررة فيها.` : ""}` : "";
  };
  document.getElementById("addOpt").onclick = () => { readRows(); st.o.push(""); st.w.push(""); drawRows(); preview(); };
  document.getElementById("pK").onchange = preview;
  form.addEventListener("input", preview);
  let last = null; // آخر خانة كتابة لإدراج الرموز فيها
  form.addEventListener("focusin", e => { if (e.target.matches("textarea, input:not([type=radio])")) last = e.target; });
  document.querySelectorAll("#sym button").forEach(b => {
    b.onmousedown = e => e.preventDefault(); // لا تفقد الخانة التركيز
    b.onclick = () => {
      if (!last) return;
      const i = last.selectionStart ?? last.value.length, j = last.selectionEnd ?? i;
      last.value = last.value.slice(0, i) + b.textContent + last.value.slice(j);
      last.focus(); last.setSelectionRange(i + b.textContent.length, i + b.textContent.length); preview();
    };
  });
  drawRows(); preview();
  onSubmit(form, async () => { await api(q0 ? `questions/${q0.id}` : "questions", build()); location.hash = back; });
}

async function review() {
  if (!user || !user.admin) return account();
  loading();
  let list; try { list = (await api("review")).questions; } catch (e) { return failed(e); }
  $app.innerHTML = `<p><a href="#questions">← بنك أسئلتي</a></p>
    <div class="card"><h2>مراجعة أسئلة الأساتذة</h2>
      <p class="mute">${list.length ? `${nOf(list.length, QS)} بانتظار المراجعة. بعد القبول يظهر السؤال لكل تلاميذ المنصة.` : "لا توجد أسئلة بانتظار المراجعة."}</p></div>
    ${list.map(x => `<div class="card rv" data-id="${x.id}">
      <div class="row"><span class="mute">من: <b>${esc(x.author || "—")}</b> · ${chName(x.ch)} · ${DIFF[x.d]}</span><a href="#qedit-${x.id}">تعديل قبل القبول</a></div>
      <p class="q">${M(x.q)}</p>
      ${x.o.map((o, i) => `<div class="opt${i === x.a ? " ok" : ""}">${M(o)}
        ${i === x.a ? "" : x.w[i] ? `<div class="mute small">سبب الخطأ: ${M(x.w[i])}</div>` : `<div class="badt small">لا يوجد شرح لسبب الخطأ</div>`}</div>`).join("")}
      <p><b>الشرح المختصر:</b> ${M(x.e)}</p>
      <b>الحل المفصل:</b><ol class="steps">${x.s.map(t => `<li>${M(t)}</li>`).join("")}</ol>
      <label>ملاحظة للأستاذ (مطلوبة عند الرفض)<textarea rows="2" maxlength="500"></textarea></label>
      <p class="msg" role="alert"></p>
      <div class="row" style="justify-content:flex-start"><button type="button" class="ap">قبول ونشر</button><button type="button" class="sec rj">رفض</button></div></div>`).join("")}`;
  document.querySelectorAll(".rv").forEach(card => {
    const decide = async decision => {
      try {
        await api(`questions/${card.dataset.id}/review`, { decision, note: card.querySelector("textarea").value });
        card.innerHTML = `<p class="${decision === "approve" ? "okt" : "badt"}">${decision === "approve" ? "✅ قُبل السؤال ونُشر لكل التلاميذ." : "رُفض السؤال وأُرسلت ملاحظتك إلى الأستاذ."}</p>`;
      } catch (e) { card.querySelector(".msg").textContent = e.message; }
    };
    card.querySelector(".ap").onclick = () => decide("approve");
    card.querySelector(".rj").onclick = () => decide("reject");
  });
}

// ---------- مواضيع البكالوريا ----------
const SUBJ = { 1: "الموضوع الأول", 2: "الموضوع الثاني" };
const lines = t => String(t).split("\n").map(M).join("<br>");
const bacSource = x => `بكالوريا ${x.year} · ${SUBJ[x.subject] || "الموضوع " + x.subject} · التمرين ${x.num}`;
// العلامة التقديرية في تمرين: مجموع (التقييم × نقاط الجزء)
function bacScore(x, prog = bacGet()[x.id] || {}) {
  const done = x.parts.filter((_, i) => prog[i] !== undefined).length;
  const got = x.parts.reduce((t, p, i) => t + (prog[i] || 0) * (p.pts || 0), 0);
  return { done, got };
}
const fmtPts = n => Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, "");
let bacFilter = { stream: null, year: "", ch: "" };
function bacList() {
  const sid = bacFilter.stream || myStream(), sname = streamOf(sid).name, list = BAC.filter(x => x.stream === sid);
  const years = [...new Set(list.map(x => x.year))].sort((a, b) => b - a);
  const shown = list.filter(x => (!bacFilter.year || x.year === +bacFilter.year) && (!bacFilter.ch || x.ch.includes(bacFilter.ch)))
    .sort((a, b) => b.year - a.year || a.subject - b.subject || a.num - b.num);
  const prog = bacGet();
  const solved = list.filter(x => bacScore(x, prog[x.id] || {}).done === x.parts.length).length;
  $app.innerHTML = `<div class="card"><h2>مواضيع البكالوريا</h2>
    <div class="grid2"><label>الشعبة${streamSelect("fs", sid)}</label></div>
    ${list.length ? `<p class="mute">${nOf(list.length, EXS)} من المواضيع الرسمية لشعبة ${sname}، مع الحل المفصل لكل جزء. حل التمرين على ورقتك، ثم قارن حلك وقيّم نفسك. أنجزت ${solved} منها.</p>
      <div class="grid2">
        <label>السنة<select id="fy"><option value="">كل السنوات</option>${years.map(y => `<option${String(y) === bacFilter.year ? " selected" : ""}>${y}</option>`).join("")}</select></label>
        <label>الوحدة<select id="fc"><option value="">كل الوحدات</option>${CHAPTERS.filter(c => list.some(x => x.ch.includes(c.id))).map(c => `<option value="${c.id}"${c.id === bacFilter.ch ? " selected" : ""}>${c.name}</option>`).join("")}</select></label>
      </div>` : `<p class="mute">لم تُضف مواضيع شعبة ${sname} بعد. نعمل على إضافة المواضيع الرسمية من 2008 إلى 2026 مع حلولها المفصلة.</p>`}</div>
    ${shown.length ? `<div class="card">${shown.map(x => { const sc = bacScore(x, prog[x.id] || {}), all = sc.done === x.parts.length;
      return `<div class="hw row"><div><b>${bacSource(x)}</b><br>
          <span class="mute">${x.ch.map(chName).join("، ")} · ${fmtPts(x.points)} نقاط · ${nOf(x.parts.length, PARTS)}</span><br>
          <span class="${all ? "okt" : "mute"}">${!sc.done ? "لم تبدأ بعد" : all ? `✅ أنجزته · علامتك التقديرية ${fmtPts(sc.got)} / ${fmtPts(x.points)}` : `قيّمت ${sc.done} من ${x.parts.length} أجزاء`}</span></div>
        <a class="btn ${all ? "sec" : ""}" href="#bacx-${x.id}">${all ? "مراجعة" : sc.done ? "أكمل" : "ابدأ"}</a></div>`; }).join("")}</div>`
      : list.length ? `<div class="card"><p class="mute">لا توجد تمارين بهذه الشروط.</p></div>` : ""}`;
  document.getElementById("fs").onchange = e => { bacFilter = { stream: e.target.value, year: "", ch: "" }; bacList(); };
  for (const [id, key] of [["fy", "year"], ["fc", "ch"]]) { const el = document.getElementById(id); if (el) el.onchange = () => { bacFilter[key] = el.value; bacList(); }; }
}
function bacExercise(id) {
  const x = BAC.find(e => e.id === id);
  if (!x) return failed(new Error("هذا التمرين غير موجود"), "#bac");
  const prog = bacGet()[x.id] || {};
  const RATE = [[1, "✅ حللته صحيحاً"], [0.5, "½ صحيح جزئياً"], [0, "❌ أخطأت"]];
  $app.innerHTML = `<p><a href="#bac">← مواضيع البكالوريا</a></p>
    <div class="card"><h2>${bacSource(x)}</h2>
      <p class="mute">${streamOf(x.stream).name} · ${x.ch.map(chName).join("، ")} · ${fmtPts(x.points)} نقاط</p>
      <div class="statement">${lines(x.intro)}</div>
      ${x.fig ? `<img class="fig" src="bac/fig/${attr(x.fig)}" alt="الشكل المرفق بالتمرين">` : ""}</div>
    ${x.parts.map((p, i) => `<div class="card part" data-i="${i}">
      <p class="q"><b>${esc(p.label || "")}</b> ${lines(p.q)} ${p.pts ? `<span class="tag">${fmtPts(p.pts)} ن</span>` : ""}</p>
      <button type="button" class="sec show">أظهر الحل</button>
      <div class="sol" hidden>
        <p><b>الجواب:</b> ${lines(p.ans)}</p>
        <b>الحل المفصل:</b><ol class="steps">${p.s.map(t => `<li>${lines(t)}</li>`).join("")}</ol>
        ${p.sfig ? `<img class="fig" src="bac/fig/${attr(p.sfig)}" alt="الرسم المطلوب" loading="lazy">` : ""}
        <p><b>قارن حلك بالحل، ثم قيّم نفسك:</b></p>
        <div class="rate">${RATE.map(([v, t]) => `<button type="button" class="sec${prog[i] === v ? " on" : ""}" data-v="${v}">${t}</button>`).join("")}</div>
      </div></div>`).join("")}
    <div class="card" id="bsum"></div>`;
  const summary = () => {
    const sc = bacScore(x);
    document.getElementById("bsum").innerHTML = sc.done
      ? `<h2>علامتك التقديرية: ${fmtPts(sc.got)} / ${fmtPts(x.points)}</h2><p class="mute">قيّمت ${sc.done} من ${x.parts.length} أجزاء. العلامة محسوبة على سلم التنقيط الرسمي للتمرين.</p>`
      : `<p class="mute">حل كل جزء على ورقتك أولاً، ثم اضغط «أظهر الحل» وقيّم نفسك لتحصل على علامتك التقديرية.</p>`;
  };
  document.querySelectorAll(".part").forEach(card => {
    const i = +card.dataset.i, sol = card.querySelector(".sol"), show = card.querySelector(".show");
    if (prog[i] !== undefined) { sol.hidden = false; show.hidden = true; }
    show.onclick = () => { sol.hidden = false; show.hidden = true; };
    card.querySelectorAll(".rate button").forEach(b => b.onclick = () => {
      bacSet(x.id, i, Number(b.dataset.v));
      card.querySelectorAll(".rate button").forEach(o => o.classList.toggle("on", o === b)); summary();
    });
  });
  summary();
}

// ---------- اختيار مستوى الصعوبة ----------
function chooser(ch) {
  const qs = QUESTIONS.filter(q => q.ch === ch.id && !excluded(q, myStream()));
  $app.innerHTML = `<div class="card"><h2>${ch.name}</h2><p class="mute">اختر مستوى الصعوبة</p>
    <div class="grid">${[0, 1, 2, 3].map(d => { const n = d ? qs.filter(q => q.d === d).length : qs.length;
      return n ? `<a class="btn ${d ? "sec" : ""}" href="#practice-${ch.id}-${d}">${d ? DIFF[d] : "الكل"} (${n})</a>` : ""; }).join("")}</div></div>`;
}

// اختبار متوازن: سؤال من كل وحدة ثم سؤالان إضافيان من الأصعب
function examQuestions() { // من وحدات شعبة التلميذ
  const sid = myStream(), ids = statChs(sid).map(c => c.id), pool = forStream(QUESTIONS, sid);
  const picked = ids.map(id => shuffle(pool.filter(q => q.ch === id))[0]).filter(Boolean);
  const others = pool.filter(q => !picked.includes(q));
  return shuffle(picked.concat(shuffle(others.filter(q => q.d >= 2)), shuffle(others.filter(q => q.d < 2))).slice(0, 10));
}

// ---------- التوجيه ----------
function route() {
  clearInterval(timerId);
  if (location.hash.startsWith("#bacx-")) return bacExercise(location.hash.slice(6));
  if (location.hash === "#bac") return bacList();
  const [page, arg, lvl] = location.hash.slice(1).split("-");
  if (page === "practice") {
    const ch = CHAPTERS.find(c => c.id === arg);
    if (ch && lvl === undefined) return chooser(ch);
    const d = +lvl, qs = ch ? QUESTIONS.filter(q => q.ch === ch.id && (!d || q.d === d) && !excluded(q, myStream())) : [];
    // الترتيب: من السهل إلى الصعب، مع خلط داخل كل مستوى
    if (qs.length) return runQuiz({ questions: [1, 2, 3].flatMap(k => shuffle(qs.filter(q => q.d === k))), exam: false, title: ch.name + (d ? " — " + DIFF[d] : "") });
  }
  if (page === "exam") return runQuiz({ questions: examQuestions(), exam: true, title: "اختبار تجريبي" });
  if (page === "report") return user && user.role !== "student" ? account() : report();
  const num = x => /^\d+$/.test(x || "");
  if (page === "class" && num(arg)) return classPage(arg);
  if (page === "student" && num(arg) && num(lvl)) return teacherStudent(arg, lvl);
  if (page === "hw" && num(arg)) return homework(arg);
  if (page === "questions") return myQuestions();
  if (page === "qedit") return editor(num(arg) ? arg : null);
  if (page === "review") return review();
  if (page === "account") return account();
  if (page === "child" && /^\d+$/.test(arg || "")) return childReport(arg);
  home();
}
addEventListener("hashchange", route);

// عند التشغيل عبر الخادم تظهر الحسابات، وإلا تعمل المنصة في وضع الضيف
(async function init() {
  if (location.protocol.startsWith("http")) {
    try { const me = await api("me"); if ("user" in me) { online = true; await setUser(me.user); } } catch { online = false; }
  }
  route();
})();
