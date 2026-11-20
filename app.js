const KEY = "bacmath.history.v1";
const $app = document.getElementById("app");
// السجل: من الخادم إذا كان التلميذ مسجّلاً، وإلا من المتصفح (وضع الضيف)
let online = false, user = null, cache = null;
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
async function setUser(u) {
  user = u || null; cache = null;
  if (user && user.role === "student") {
    const local = localHistory(); // نقل نتائج وضع الضيف إلى الحساب مرة واحدة
    if (local.length) { try { await api("attempts/import", { items: local }); localStorage.removeItem(KEY); } catch {} }
    cache = (await api("attempts")).history;
  }
  const acc = document.getElementById("acc");
  if (acc) { acc.hidden = !online; acc.textContent = user ? "👤 " + user.name : "دخول / حساب جديد"; }
}

// العدد مع المعدود حسب قواعد العربية: [مفرد، مثنى، جمع (3–10)، تمييز (11 فأكثر)]
const QS = ["سؤال واحد", "سؤالان", "أسئلة", "سؤالاً"], STUD = ["تلميذ واحد", "تلميذان", "تلاميذ", "تلميذاً"], ANS = ["إجابة واحدة", "إجابتان", "إجابات", "إجابة"];
const nOf = (n, f) => n === 1 ? f[0] : n === 2 ? f[1] : `${n} ${n % 100 >= 3 && n % 100 <= 10 ? f[2] : f[3]}`;
const dateStr = t => new Date(t).toLocaleDateString("ar-DZ");
const loading = () => { $app.innerHTML = `<div class="card"><p class="mute">جاري التحميل…</p></div>`; };
const failed = (e, back = "#account") => { $app.innerHTML = `<div class="card"><p class="msg">${esc(e.message)}</p><a href="${back}">العودة</a></div>`; };
// إحصائيات الوحدات من مجاميع الخادم {lim: [محاولات، صحيحة], ...}
const statsOf = ch => CHAPTERS.map(c => { const [a, k] = ch[c.id] || [0, 0]; return { ...c, attempts: a, correct: k, mastery: (k + 1) / (a + 2) }; });

// ---------- الحل المفصل ----------
// k = رقم الخيار الذي اختاره التلميذ (أو undefined إن لم يُجب)
function steps(q) {
  const sol = typeof SOLUTIONS !== "undefined" && SOLUTIONS[q.id];
  return sol ? `<ol class="steps">${sol.s.map(x => `<li>${M(x)}</li>`).join("")}</ol>` : `<p>${M(q.e)}</p>`;
}
function correction(q, k) {
  const sol = typeof SOLUTIONS !== "undefined" && SOLUTIONS[q.id];
  if (k === q.a) return `<div class="expl"><b class="okt">✅ إجابة صحيحة</b><p>${M(q.e)}</p>
    <details><summary>عرض الحل المفصل</summary>${steps(q)}</details></div>`;
  const why = k !== undefined && sol && sol.w[k];
  return `<div class="expl wrong">
    <b class="badt">${k === undefined ? "⏳ لم تُجب عن هذا السؤال" : `❌ إجابة خاطئة: اخترت ${M(q.o[k])}`}</b>
    ${why ? `<div class="why"><b>لماذا هذا الجواب خاطئ؟</b><br>${M(why)}</div>` : ""}
    <p><b>الجواب الصحيح:</b> ${M(q.o[q.a])}</p>
    <b>الحل المفصل:</b>${steps(q)}</div>`;
}

// ---------- الصفحة الرئيسية ----------
function home() {
  const st = chapterStats(load(), CHAPTERS, QUESTIONS), p = predict(st);
  const weak = st.filter(c => c.attempts).sort((a, b) => a.mastery - b.mastery)[0];
  $app.innerHTML = `
  ${user && user.role === "parent" ? `<div class="card row"><span>أنت مسجّل كولي أمر. نتائج أبنائك في صفحة حسابك.</span><a class="btn" href="#account">متابعة أبنائي</a></div>` : ""}
  ${user && user.role === "teacher" ? `<div class="card row"><span>أنت مسجّل كأستاذ. نتائج تلاميذك وواجباتهم في صفحة أقسامك.</span><a class="btn" href="#account">أقسامي</a></div>` : ""}
  ${user && user.role === "student" ? `<div id="hwbox"></div>` : ""}
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
    ${st.map(c => `<div style="margin:12px 0"><div class="row"><b>${c.name}</b>
      <span class="mute">${c.attempts ? `${c.correct}/${c.attempts} · إتقان ${pct(c.mastery)}%` : "لم تبدأ بعد"}</span></div>
      <div class="bar"><i style="width:${c.attempts ? pct(c.mastery) : 0}%"></i></div>
      <a class="btn sec" style="margin-top:6px;padding:4px 12px" href="#practice-${c.id}">تدرّب</a></div>`).join("")}
  </div>
  <div class="card row"><span>اختبار مدته ٢٠ دقيقة من ١٠ أسئلة تغطي كل الوحدات</span><a class="btn" href="#exam">ابدأ الاختبار</a></div>`;
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
  runQuiz({ questions: a.qids.map(i => QUESTIONS.find(q => q.id === i)).filter(Boolean), exam: false, title: a.title, hw: a.id });
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
function report(h = load(), who = null, back = "#account", backLabel = "العودة إلى قائمة أبنائي") {
  const st = chapterStats(h, CHAPTERS, QUESTIONS), p = predict(st);
  const last = h.length ? new Date(Math.max(...h.map(r => r.ts))).toLocaleDateString("ar-DZ") : "—";
  $app.innerHTML = `<div class="card"><h2>تقرير متابعة ${who ? esc(who) : "التلميذ"}</h2>
    ${who ? `<p><a href="${back}">← ${backLabel}</a></p>` : ""}
    <p class="mute">آخر نشاط: ${last}</p>
    <p>عدد الأسئلة المحلولة: <b>${p.attempts}</b> — العلامة المتوقعة: <b>${p.attempts ? p.score.toFixed(1) + " / 20" : "—"}</b>
      ${p.attempts && p.reliable ? `(${p.low.toFixed(1)} – ${p.high.toFixed(1)})` : ""}</p>
    <div class="tablewrap"><table style="width:100%;border-collapse:collapse">
      <tr style="text-align:start"><th>الوحدة</th><th>محاولات</th><th>صحيحة</th><th>الإتقان</th><th>التوصية</th></tr>
      ${st.map(c => `<tr style="border-top:1px solid var(--line)"><td>${c.name}</td><td>${c.attempts}</td><td>${c.correct}</td><td>${c.attempts ? pct(c.mastery) + "%" : "—"}</td>
        <td>${!c.attempts ? "لم تُدرَّس بعد" : c.mastery < .5 ? "⚠️ تحتاج مراجعة" : c.mastery < .75 ? "جيد — واصل" : "ممتاز"}</td></tr>`).join("")}
    </table></div>
    <h2 style="margin-top:16px">حسب مستوى الصعوبة</h2>
    ${[1, 2, 3].map(d => { const ids = new Set(QUESTIONS.filter(q => q.d === d).map(q => q.id)), x = h.filter(r => ids.has(r.qid)), c = x.filter(r => r.ok).length;
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
        <label>الاسم الكامل<input id="rName" required minlength="2" maxlength="60" autocomplete="name"></label>
        <label>رقم الهاتف أو البريد الإلكتروني<input id="rLogin" required autocomplete="username"></label>
        <label>كلمة السر (6 أحرف على الأقل)<input id="rPass" type="password" required minlength="6" autocomplete="new-password"></label>
        <button type="submit">إنشاء الحساب</button></form>
    </div>`;
    onSubmit(document.getElementById("fLogin"), async () => {
      const r = await api("login", { login: val("lLogin"), password: val("lPass") });
      await setUser(r.user); account();
    });
    onSubmit(document.getElementById("fReg"), async () => {
      const role = ["rParent", "rTeacher"].map(i => document.getElementById(i)).find(x => x.checked)?.value || "student";
      const r = await api("register", { name: val("rName"), login: val("rLogin"), password: val("rPass"), role });
      await setUser(r.user); account();
    });
    return;
  }
  if (user.role === "teacher") return teacherHome();
  if (user.role === "student") {
    loading();
    let mine = { classes: [] }; try { mine = await api("my/classes"); } catch {}
    $app.innerHTML = `<div class="card"><h2>مرحباً ${esc(user.name)}</h2><p class="mute">حساب تلميذ</p>
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
      ${children.length ? children.map(c => `<div class="child row"><div><b>${esc(c.name)}</b><br>
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
  try { const r = await api(`children/${id}/attempts`); report(r.history, r.name); } catch (e) { failed(e); }
}

// ---------- الأستاذ ----------
async function teacherHome() {
  loading();
  let classes; try { classes = (await api("classes")).classes; } catch (e) { return failed(e, "#home"); }
  $app.innerHTML = `<div class="card"><h2>مرحباً ${esc(user.name)}</h2><p class="mute">حساب أستاذ</p></div>
    <div class="card"><h2>أقسامي</h2>
      ${classes.length ? classes.map(c => `<div class="child row"><div><b>${esc(c.name)}</b><br>
          <span class="mute">${nOf(c.students, STUD)} · الرمز <span dir="ltr">${esc(c.code)}</span></span></div>
          <a class="btn sec" href="#class-${c.id}">فتح القسم</a></div>`).join("")
        : `<p class="mute">لم تُنشئ أي قسم بعد. أنشئ قسماً ثم أعطِ رمزه لتلاميذك.</p>`}</div>
    <form class="card" id="fClass"><h2>إنشاء قسم جديد</h2><p class="msg" id="msg" role="alert"></p>
      <label>اسم القسم<input id="cName" required maxlength="60" placeholder="مثال: 3 علوم تجريبية 2"></label>
      <button type="submit">إنشاء القسم</button></form>
    <p><button class="sec" id="out">تسجيل الخروج</button></p>`;
  onSubmit(document.getElementById("fClass"), async () => { const r = await api("classes", { name: val("cName") }); location.hash = "#class-" + r.class.id; });
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
  const preds = active.map(s => predict(statsOf(s.ch)).score);
  const avgPred = preds.length ? preds.reduce((a, b) => a + b, 0) / preds.length : null;
  const tot = {};
  for (const s of students) for (const [ch, [a, k]] of Object.entries(s.ch)) { const t = tot[ch] || (tot[ch] = [0, 0]); t[0] += a; t[1] += k; }
  const weak = CHAPTERS.filter(c => tot[c.id]).sort((a, b) => rate(tot[a.id]) - rate(tot[b.id]))[0];
  const cell = c => { const r = rate(c); return `<td class="${lvl(r)}"${c ? ` title="${c[1]} صحيحة من ${c[0]}"` : ""}>${r === null ? "—" : pct(r) + "%"}</td>`; };
  $app.innerHTML = `<p><a href="#account">← أقسامي</a></p>
  <div class="card"><h2>${esc(cls.name)}</h2><p>رمز القسم:</p><p class="code">${esc(cls.code)}</p>
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
      <div class="tablewrap"><table class="heat"><thead><tr><th>التلميذ</th><th>إجابات</th><th>العلامة المتوقعة</th>${CHAPTERS.map(c => `<th>${c.name}</th>`).join("")}<th>آخر نشاط</th></tr></thead>
      <tbody>${students.map(s => `<tr><th><a href="#student-${cls.id}-${s.id}">${esc(s.name)}</a></th><td>${s.attempts}</td>
        <td>${!s.attempts ? "—" : s.attempts < 15 ? `<span class="mute" title="تقدير أولي: أقل من 15 إجابة">${predict(statsOf(s.ch)).score.toFixed(1)}*</span>` : predict(statsOf(s.ch)).score.toFixed(1)}</td>${CHAPTERS.map(c => cell(s.ch[c.id])).join("")}<td>${s.last ? dateStr(s.last) : "—"}</td></tr>`).join("")}</tbody>
      <tfoot><tr><th>القسم</th><td>${students.reduce((a, s) => a + s.attempts, 0)}</td><td>${avgPred === null ? "—" : avgPred.toFixed(1)}</td>${CHAPTERS.map(c => cell(tot[c.id])).join("")}<td></td></tr></tfoot></table></div>`
      : `<p class="mute">لم ينضم أي تلميذ بعد.</p>`}</div>
  <div class="card"><h2>الواجبات</h2>${assignments.length ? assignments.map(a => hwTeacherRow(a, students)).join("") : `<p class="mute">لم تُرسل أي واجب بعد.</p>`}</div>
  <form class="card" id="fHw"><h2>إرسال واجب جديد</h2><p class="msg" id="msg" role="alert"></p>
    <label>العنوان<input id="hTitle" required maxlength="80" placeholder="مثال: مراجعة الدالة الأسية"></label>
    <div class="grid2">
      <label>الوحدة<select id="hCh"><option value="">كل الوحدات</option>${CHAPTERS.map(c => `<option value="${c.id}">${c.name}</option>`).join("")}</select></label>
      <label>الصعوبة<select id="hD"><option value="0">كل المستويات</option>${[1, 2, 3].map(d => `<option value="${d}">${DIFF[d]}</option>`).join("")}</select></label>
      <label>عدد الأسئلة<input id="hN" type="number" min="1" max="20" value="5" required></label>
      <label>آخر أجل للتسليم (اختياري)<input id="hDue" type="date"></label>
    </div>
    <p class="mute" id="hAvail"></p>
    <button type="submit">إرسال الواجب إلى القسم</button></form>`;
  const avail = () => {
    const ch = val("hCh"), d = +val("hD"), n = QUESTIONS.filter(q => (!ch || q.ch === ch) && (!d || q.d === d)).length;
    document.getElementById("hAvail").textContent = n ? `متوفر ${nOf(n, QS)} بهذه الشروط، وتُختار الأسئلة عشوائياً منها.` : "لا توجد أسئلة بهذه الشروط، غيّر الوحدة أو الصعوبة.";
  };
  ["hCh", "hD"].forEach(i => document.getElementById(i).onchange = avail); avail();
  onSubmit(document.getElementById("fHw"), async () => {
    const due = val("hDue") ? new Date(val("hDue") + "T23:59:59").getTime() : null;
    await api(`classes/${cls.id}/assignments`, { title: val("hTitle"), chapter: val("hCh"), difficulty: +val("hD"), count: +val("hN"), due });
    classPage(cls.id);
  });
  document.querySelectorAll(".del").forEach(b => b.onclick = async () => { // تأكيد بضغطتين
    if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = "اضغط مرة أخرى لتأكيد الحذف"; return; }
    try { await api(`assignments/${b.dataset.id}/delete`, {}); classPage(cls.id); } catch (e) { b.textContent = e.message; }
  });
}
async function teacherStudent(cid, sid) {
  if (!user || user.role !== "teacher") return account();
  loading();
  try { const r = await api(`classes/${cid}/students/${sid}/attempts`); report(r.history, r.name, `#class-${cid}`, "العودة إلى القسم"); }
  catch (e) { failed(e, `#class-${cid}`); }
}

// ---------- اختيار مستوى الصعوبة ----------
function chooser(ch) {
  const qs = QUESTIONS.filter(q => q.ch === ch.id);
  $app.innerHTML = `<div class="card"><h2>${ch.name}</h2><p class="mute">اختر مستوى الصعوبة</p>
    <div class="grid">${[0, 1, 2, 3].map(d => { const n = d ? qs.filter(q => q.d === d).length : qs.length;
      return n ? `<a class="btn ${d ? "sec" : ""}" href="#practice-${ch.id}-${d}">${d ? DIFF[d] : "الكل"} (${n})</a>` : ""; }).join("")}</div></div>`;
}

// اختبار متوازن: سؤال من كل وحدة ثم سؤالان إضافيان من الأصعب
function examQuestions() {
  const picked = CHAPTERS.map(c => shuffle(QUESTIONS.filter(q => q.ch === c.id))[0]);
  const rest = shuffle(QUESTIONS.filter(q => !picked.includes(q) && q.d >= 2)).slice(0, 10 - picked.length);
  return shuffle(picked.concat(rest));
}

// ---------- التوجيه ----------
function route() {
  clearInterval(timerId);
  const [page, arg, lvl] = location.hash.slice(1).split("-");
  if (page === "practice") {
    const ch = CHAPTERS.find(c => c.id === arg);
    if (ch && lvl === undefined) return chooser(ch);
    const d = +lvl, qs = ch ? QUESTIONS.filter(q => q.ch === ch.id && (!d || q.d === d)) : [];
    // الترتيب: من السهل إلى الصعب، مع خلط داخل كل مستوى
    if (qs.length) return runQuiz({ questions: [1, 2, 3].flatMap(k => shuffle(qs.filter(q => q.d === k))), exam: false, title: ch.name + (d ? " — " + DIFF[d] : "") });
  }
  if (page === "exam") return runQuiz({ questions: examQuestions(), exam: true, title: "اختبار تجريبي" });
  if (page === "report") return user && user.role !== "student" ? account() : report();
  const num = x => /^\d+$/.test(x || "");
  if (page === "class" && num(arg)) return classPage(arg);
  if (page === "student" && num(arg) && num(lvl)) return teacherStudent(arg, lvl);
  if (page === "hw" && num(arg)) return homework(arg);
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
