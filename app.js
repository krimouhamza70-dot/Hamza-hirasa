const KEY = "bacmath.history.v1";
const $app = document.getElementById("app");
const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; } };
const save = h => { try { localStorage.setItem(KEY, JSON.stringify(h)); } catch {} };
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };
const pct = x => Math.round(x * 100);
let timerId = null;

// عزل المقاطع الرياضية (اتجاه يسار←يمين) داخل النص العربي حتى لا ينقلب ترتيبها.
// السهم ← وعلامات «» والأقواس غير المتوازنة وعلامات الترقيم في الآخر تبقى في السياق العربي.
const esc = t => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const MATHY = /[A-Za-z0-9\u0370-\u03FF\u2070-\u209F\u2100-\u22FF√∫π∞]/;
function iso(run) {
  const lead = run.match(/^\s*/)[0], trail = run.slice(lead.length).match(/\s*$/)[0];
  let core = run.slice(lead.length, run.length - trail.length);
  if (!core) return run;
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

function record(qid, ok) { const h = load(); h.push({ qid, ok, ts: Date.now() }); save(h); }

// ---------- الصفحة الرئيسية ----------
function home() {
  const st = chapterStats(load(), CHAPTERS, QUESTIONS), p = predict(st);
  const weak = st.filter(c => c.attempts).sort((a, b) => a.mastery - b.mastery)[0];
  $app.innerHTML = `
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
      <span class="mute">${c.correct}/${c.attempts} · إتقان ${pct(c.mastery)}%</span></div>
      <div class="bar"><i style="width:${pct(c.mastery)}%"></i></div>
      <a class="btn sec" style="margin-top:6px;padding:4px 12px" href="#/practice/${c.id}">تدرّب</a></div>`).join("")}
  </div>
  <div class="card row"><span>اختبار مدته ٢٠ دقيقة من ١٠ أسئلة تغطي كل الوحدات</span><a class="btn" href="#/exam">ابدأ الاختبار</a></div>`;
}

// ---------- جلسة أسئلة (تدريب أو اختبار) ----------
function runQuiz({ questions, exam, title }) {
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
    const ok = k === q.a; if (ok) score++; record(q.id, ok);
    document.querySelectorAll(".opt").forEach(b => { b.disabled = true; if (+b.dataset.k === q.a) b.classList.add("ok"); });
    if (!ok) btn.classList.add("bad");
    document.getElementById("fb").innerHTML = `<div class="expl">${ok ? "✅ إجابة صحيحة" : "❌ إجابة خاطئة"}<br>${M(q.e)}</div>`;
    document.getElementById("next").disabled = false;
  }
  function finish() {
    clearInterval(timerId);
    if (exam) { score = 0; qs.forEach((q, n) => { const ok = answers[n] === q.a; if (ok) score++; record(q.id, ok); }); }
    const mark = (score / qs.length * 20).toFixed(1);
    $app.innerHTML = `<div class="card" style="text-align:center"><h2>انتهت الجلسة</h2>
      <div class="big">${score} / ${qs.length}</div><div class="mute">العلامة: ${mark} / 20</div>
      <p><a class="btn" href="#/">لوحة النتائج</a></p></div>
      ${exam ? `<div class="card"><h2>التصحيح</h2>${qs.map((q, n) => `<p>${answers[n] === q.a ? "✅" : "❌"} ${M(q.q)}<br><span class="mute">الجواب: ${M(q.o[q.a])} — ${M(q.e)}</span></p>`).join("")}</div>` : ""}`;
  }
  show();
}

// ---------- تقرير الولي ----------
function report() {
  const h = load(), st = chapterStats(h, CHAPTERS, QUESTIONS), p = predict(st);
  $app.innerHTML = `<div class="card"><h2>تقرير متابعة التلميذ</h2>
    <p>التاريخ: ${new Date().toLocaleDateString("ar-DZ")}</p>
    <p>عدد الأسئلة المحلولة: <b>${p.attempts}</b> — العلامة المتوقعة: <b>${p.attempts ? p.score.toFixed(1) + " / 20" : "—"}</b>
      ${p.attempts && p.reliable ? `(${p.low.toFixed(1)} – ${p.high.toFixed(1)})` : ""}</p>
    <table style="width:100%;border-collapse:collapse">
      <tr style="text-align:start"><th>الوحدة</th><th>محاولات</th><th>صحيحة</th><th>الإتقان</th><th>التوصية</th></tr>
      ${st.map(c => `<tr style="border-top:1px solid var(--line)"><td>${c.name}</td><td>${c.attempts}</td><td>${c.correct}</td><td>${pct(c.mastery)}%</td>
        <td>${!c.attempts ? "لم تُدرَّس بعد" : c.mastery < .5 ? "⚠️ تحتاج مراجعة" : c.mastery < .75 ? "جيد — واصل" : "ممتاز"}</td></tr>`).join("")}
    </table>
    <h2 style="margin-top:16px">حسب مستوى الصعوبة</h2>
    ${[1, 2, 3].map(d => { const ids = new Set(QUESTIONS.filter(q => q.d === d).map(q => q.id)), x = h.filter(r => ids.has(r.qid)), c = x.filter(r => r.ok).length;
      return `<p>${DIFF[d]}: <b>${x.length ? pct(c / x.length) + "%" : "—"}</b> <span class="mute">(${c}/${x.length})</span></p>`; }).join("")}
    <p class="noprint" style="margin-top:12px"><button onclick="print()">طباعة</button>
      <button class="sec" onclick="if(confirm('مسح كل النتائج؟')){localStorage.removeItem(KEY);report()}">مسح النتائج</button></p></div>`;
}

// ---------- اختيار مستوى الصعوبة ----------
function chooser(ch) {
  const qs = QUESTIONS.filter(q => q.ch === ch.id);
  $app.innerHTML = `<div class="card"><h2>${ch.name}</h2><p class="mute">اختر مستوى الصعوبة</p>
    <div class="grid">${[0, 1, 2, 3].map(d => { const n = d ? qs.filter(q => q.d === d).length : qs.length;
      return n ? `<a class="btn ${d ? "sec" : ""}" href="#/practice/${ch.id}/${d}">${d ? DIFF[d] : "الكل"} (${n})</a>` : ""; }).join("")}</div></div>`;
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
  const [, page, arg, lvl] = location.hash.split("/");
  if (page === "practice") {
    const ch = CHAPTERS.find(c => c.id === arg);
    if (ch && lvl === undefined) return chooser(ch);
    const d = +lvl, qs = ch ? QUESTIONS.filter(q => q.ch === ch.id && (!d || q.d === d)) : [];
    // الترتيب: من السهل إلى الصعب، مع خلط داخل كل مستوى
    if (qs.length) return runQuiz({ questions: [1, 2, 3].flatMap(k => shuffle(qs.filter(q => q.d === k))), exam: false, title: ch.name + (d ? " — " + DIFF[d] : "") });
  }
  if (page === "exam") return runQuiz({ questions: examQuestions(), exam: true, title: "اختبار تجريبي" });
  if (page === "report") return report();
  home();
}
addEventListener("hashchange", route);
route();
