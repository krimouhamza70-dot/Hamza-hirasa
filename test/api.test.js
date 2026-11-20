// اختبارات الخادم: npm test
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bac-"));
let proc;

before(async () => {
  proc = spawn(process.execPath, ["--no-warnings", path.join(__dirname, "..", "server", "server.js")],
    { env: { ...process.env, PORT, DB_PATH: path.join(dir, "t.db"), BAC_FILE: path.join(__dirname, "fixtures", "bac.sample.js"), RATE_LIMIT: "1000", ADMIN_LOGINS: "Admin@Mail.dz, 0770 00 00 00" }, stdio: "ignore" });
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + "/api/me"); return; } catch { await new Promise(r => setTimeout(r, 100)); } }
  throw new Error("server did not start");
});
after(() => { proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

// عميل بسيط يحتفظ بالكوكي
function client() {
  let cookie = "";
  return async (p, body) => {
    const r = await fetch(BASE + "/api/" + p, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...(cookie && { Cookie: cookie }), ...(body !== undefined && { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
    return { status: r.status, body: await r.json() };
  };
}

test("التسجيل والدخول والخروج", async () => {
  const c = client();
  assert.equal((await c("me")).body.user, null);
  const reg = await c("register", { name: "أمين", login: "0555 12 34 56", password: "secret1", role: "student", stream: "se" });
  assert.equal(reg.status, 200);
  assert.match(reg.body.user.linkCode, /^[A-Z2-9]{6}$/);
  assert.equal((await c("me")).body.user.name, "أمين");
  assert.equal((await c("register", { name: "x2", login: "0555123456", password: "secret1", role: "student", stream: "se" })).status, 409, "نفس الرقم بمسافات");
  await c("logout", {});
  assert.equal((await c("me")).body.user, null);
  assert.equal((await c("login", { login: "0555123456", password: "wrong!!" })).status, 401);
  assert.equal((await c("login", { login: "0555123456", password: "secret1" })).status, 200);
});

test("رفض البيانات غير الصالحة", async () => {
  const c = client();
  assert.equal((await c("register", { name: "a", login: "x@y.dz", password: "secret1", role: "student", stream: "se" })).status, 400);
  assert.equal((await c("register", { name: "علي", login: "x@y.dz", password: "123", role: "student", stream: "se" })).status, 400);
  assert.equal((await c("register", { name: "علي", login: "x@y.dz", password: "secret1", role: "admin" })).status, 400);
  const r = await fetch(BASE + "/api/login", { method: "POST", body: "login=a", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  assert.equal(r.status, 415, "يقبل JSON فقط (حماية من CSRF)");
});

test("الخادم يصحح الإجابة بنفسه", async () => {
  const c = client();
  await c("register", { name: "سارة", login: "sara@mail.dz", password: "secret1", role: "student", stream: "se" });
  assert.equal((await c("attempts", { qid: 1, k: 1 })).body.ok, true);   // الجواب الصحيح للسؤال 1 هو 1
  assert.equal((await c("attempts", { qid: 1, k: 0 })).body.ok, false);
  assert.equal((await c("attempts", { qid: 1, k: null })).body.ok, false); // لم يُجب
  assert.equal((await c("attempts", { qid: 1, ok: true })).body.ok, false, "لا يُقبل ok من العميل");
  assert.equal((await c("attempts", { qid: 9999, k: 0 })).status, 400);
  const h = (await c("attempts")).body.history;
  assert.deepEqual(h.map(x => x.ok), [true, false, false, false]);
});

test("نقل نتائج وضع الضيف", async () => {
  const c = client();
  await c("register", { name: "يوسف", login: "youcef@mail.dz", password: "secret1", role: "student", stream: "se" });
  const now = Date.now();
  const r = await c("attempts/import", { items: [{ qid: 2, ok: true, ts: now - 1000 }, { qid: 3, ok: false, ts: now - 500 }, { qid: 9999, ok: true, ts: now }, { qid: 2, ok: true, ts: now + 1e9 }] });
  assert.equal(r.body.imported, 2, "يتجاهل الأسئلة غير الموجودة والتواريخ المستقبلية");
  assert.equal((await c("attempts")).body.history.length, 2);
});

test("الربط بين الولي والتلميذ وعزل البيانات", async () => {
  const s = client(), p = client(), other = client();
  const code = (await s("register", { name: "ريم", login: "rim@mail.dz", password: "secret1", role: "student", stream: "se" })).body.user.linkCode;
  await s("attempts", { qid: 4, k: 0 });
  await p("register", { name: "والد ريم", login: "0661000000", password: "secret1", role: "parent" });
  await other("register", { name: "ولي آخر", login: "0662000000", password: "secret1", role: "parent" });

  assert.equal((await p("attempts")).status, 403, "الولي لا يسجل إجابات");
  assert.equal((await s("children")).status, 403, "التلميذ لا يرى قائمة الأبناء");
  assert.equal((await p("children/link", { code: "ZZZZZZ" })).status, 404);
  const link = await p("children/link", { code: code.toLowerCase() });
  assert.equal(link.status, 200, "الرمز لا يتأثر بحالة الأحرف");
  const kids = (await p("children")).body.children;
  assert.equal(kids.length, 1); assert.equal(kids[0].name, "ريم"); assert.equal(kids[0].attempts, 1); assert.equal(kids[0].correct, 1);
  const rep = await p(`children/${kids[0].id}/attempts`);
  assert.equal(rep.body.name, "ريم"); assert.equal(rep.body.history.length, 1);
  assert.equal((await other(`children/${kids[0].id}/attempts`)).status, 404, "ولي غير مرتبط لا يرى التقرير");
  assert.equal((await client()(`children/${kids[0].id}/attempts`)).status, 401);
});

test("الملفات الثابتة ورؤوس الأمان", async () => {
  const r = await fetch(BASE + "/");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-security-policy"), /default-src 'self'/);
  assert.equal((await fetch(BASE + "/server/server.js")).status, 404, "لا يكشف كود الخادم");
  assert.equal((await fetch(BASE + "/data/app.db")).status, 404, "لا يكشف قاعدة البيانات");
  assert.equal((await fetch(BASE + "/../package.json")).status, 404);
});

test("الأستاذ: الأقسام والواجبات وتقدم التلاميذ", async () => {
  const t = client(), t2 = client(), s1 = client(), s2 = client(), out = client();
  await t("register", { name: "الأستاذ حمزة", login: "prof@mail.dz", password: "secret1", role: "teacher" });
  await t2("register", { name: "أستاذ آخر", login: "prof2@mail.dz", password: "secret1", role: "teacher" });
  await s1("register", { name: "تلميذ أ", login: "s1@mail.dz", password: "secret1", role: "student", stream: "se" });
  await s2("register", { name: "تلميذ ب", login: "s2@mail.dz", password: "secret1", role: "student", stream: "se" });
  await out("register", { name: "تلميذ خارج القسم", login: "s3@mail.dz", password: "secret1", role: "student", stream: "se" });

  assert.equal((await s1("classes", { name: "قسم", stream: "se" })).status, 403, "التلميذ لا ينشئ قسماً");
  const cls = (await t("classes", { name: "3 علوم تجريبية 1", stream: "se" })).body.class;
  assert.match(cls.code, /^[A-Z2-9]{6}$/);
  assert.equal((await s1("classes/join", { code: "XXXXXX" })).status, 404);
  assert.equal((await s1("classes/join", { code: cls.code.toLowerCase() })).status, 200);
  await s1("classes/join", { code: cls.code }); // الانضمام مرتين لا يكرر
  await s2("classes/join", { code: cls.code });
  assert.equal((await t("classes")).body.classes[0].students, 2);

  // واجب من 3 أسئلة في وحدة الأعداد المركبة، سهلة
  const bad = await t(`classes/${cls.id}/assignments`, { title: "واجب", chapter: "nope", difficulty: 0, count: 3 });
  assert.equal(bad.status, 400);
  const hw = (await t(`classes/${cls.id}/assignments`, { title: "واجب المركبة", chapter: "cpx", difficulty: 1, count: 3, due: Date.now() + 3 * 864e5 })).body.assignment;
  assert.equal(hw.qids.length, 3);
  assert.equal((await t2(`classes/${cls.id}/assignments`, { title: "x", chapter: "", difficulty: 0, count: 3 })).status, 404, "أستاذ آخر لا يضيف واجباً");
  assert.equal((await t2(`classes/${cls.id}`)).status, 404, "أستاذ آخر لا يرى القسم");

  // التلميذ أ ينجز الواجب: الأول صحيح ثم خطأ ثم يعيد الأول خطأ (تحتسب المحاولة الأولى فقط)
  const mine = (await s1("my/classes")).body;
  assert.equal(mine.classes[0].teacher, "الأستاذ حمزة");
  assert.equal(mine.assignments[0].qids.length, 3);
  const [q1, q2, q3] = hw.qids, A = { 16: 1, 17: 2, 18: 0, 47: 1 }; // أجوبة الأسئلة السهلة في المركبة
  await s1("attempts", { qid: q1, k: A[q1], assignmentId: hw.id });
  await s1("attempts", { qid: q2, k: (A[q2] + 1) % 4, assignmentId: hw.id });
  await s1("attempts", { qid: q1, k: (A[q1] + 1) % 4, assignmentId: hw.id });
  await s1("attempts", { qid: q3, k: A[q3], assignmentId: hw.id });
  assert.deepEqual((await s1("my/classes")).body.assignments[0].mine, { answered: 3, correct: 2 });
  assert.equal((await out("attempts", { qid: q1, k: 0, assignmentId: hw.id })).status, 400, "تلميذ خارج القسم لا يجيب في الواجب");
  assert.equal((await s1("attempts", { qid: 1, k: 1, assignmentId: hw.id })).status, 400, "سؤال ليس في الواجب");

  const detail = (await t(`classes/${cls.id}`)).body;
  assert.equal(detail.students.length, 2);
  const a = detail.students.find(s => s.name === "تلميذ أ");
  assert.equal(a.attempts, 4); assert.deepEqual(a.ch.cpx, [4, 2]);
  assert.deepEqual(detail.assignments[0].progress[a.id], { answered: 3, correct: 2 });
  const rep = await t(`classes/${cls.id}/students/${a.id}/attempts`);
  assert.equal(rep.body.history.length, 4);
  const outsider = (await out("me")).body.user.id;
  assert.equal((await t(`classes/${cls.id}/students/${outsider}/attempts`)).status, 404, "لا يرى تلميذاً خارج قسمه");

  assert.equal((await t2(`assignments/${hw.id}/delete`, {})).status, 404);
  assert.equal((await t(`assignments/${hw.id}/delete`, {})).status, 200);
  assert.equal((await s1("my/classes")).body.assignments.length, 0);
  assert.equal((await s1("attempts")).body.history.length, 4, "حذف الواجب لا يحذف إجابات التلميذ");
});

test("حد محاولات الدخول", async () => {
  const PORT2 = PORT + 100, dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "bac-rl-"));
  const p2 = spawn(process.execPath, ["--no-warnings", path.join(__dirname, "..", "server", "server.js")],
    { env: { ...process.env, PORT: PORT2, DB_PATH: path.join(dir2, "t.db"), RATE_LIMIT: "3" }, stdio: "ignore" });
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${PORT2}/api/me`); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
    const login = () => fetch(`http://127.0.0.1:${PORT2}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"login":"a","password":"b"}' }).then(r => r.status);
    assert.deepEqual([await login(), await login(), await login(), await login()], [401, 401, 401, 429]);
  } finally { p2.kill(); fs.rmSync(dir2, { recursive: true, force: true }); }
});

test("بنك الأسئلة: إضافة الأستاذ ومراجعة المدير", async () => {
  const t = client(), t2 = client(), admin = client(), s = client(), guest = client();
  await t("register", { name: "أستاذة ليلى", login: "leila@mail.dz", password: "secret1", role: "teacher" });
  await t2("register", { name: "أستاذ آخر", login: "other@mail.dz", password: "secret1", role: "teacher" });
  const me = (await admin("register", { name: "المدير", login: "admin@mail.dz", password: "secret1", role: "teacher" })).body.user;
  assert.equal(me.admin, true, "المدير يُعرف من ADMIN_LOGINS");
  assert.equal((await t("me")).body.user.admin, undefined);
  await s("register", { name: "تلميذ", login: "stud@mail.dz", password: "secret1", role: "student", stream: "se" });

  const before = (await guest("questions")).body;
  assert.equal(before.questions.length, 61);
  assert.equal(before.solutions[10].s.length, 5);

  const good = { ch: "exp", d: 2, q: "ما قيمة e^(ln 3) ؟", o: ["3", "ln 3", "e³"], a: 0, e: "exp و ln متعاكستان.",
    s: ["e^(ln a) = a لكل a > 0.", "إذن e^(ln 3) = 3."], w: { 1: "الأسية تلغي ln.", 2: "الأس هو ln 3 وليس 3.", 0: "يُتجاهل: هذا الجواب الصحيح" } };
  assert.equal((await s("questions", good)).status, 403, "التلميذ لا يضيف أسئلة");
  for (const [bad, why] of [[{ ...good, ch: "x" }, "وحدة"], [{ ...good, d: 5 }, "صعوبة"], [{ ...good, o: ["3"] }, "خيار واحد"],
    [{ ...good, o: ["3", "3"] }, "خياران متطابقان"], [{ ...good, a: 7 }, "جواب خارج الخيارات"], [{ ...good, s: [] }, "بدون حل"], [{ ...good, q: "" }, "بدون نص"]])
    assert.equal((await t("questions", bad)).status, 400, why);

  const { id } = (await t("questions", good)).body;
  assert.ok(id >= 10001, "رقم سؤال الأستاذ لا يتعارض مع الأسئلة المدمجة");
  assert.equal((await guest("questions")).body.questions.length, 61, "السؤال غير المراجع لا يظهر للجميع");
  const mineQ = (await t("questions")).body.questions.find(x => x.id === id);
  assert.equal(mineQ.status, "pending"); assert.equal(mineQ.mine, true);
  assert.deepEqual((await t("questions")).body.solutions[id].w, { 1: "الأسية تلغي ln.", 2: "الأس هو ln 3 وليس 3." }, "يتجاهل شرح الخطأ على الجواب الصحيح");
  assert.equal((await t2("questions")).body.questions.some(x => x.id === id), false, "أستاذ آخر لا يرى السؤال");
  assert.equal((await t2(`questions/${id}`, good)).status, 403, "أستاذ آخر لا يعدل السؤال");
  assert.equal((await s("attempts", { qid: id, k: 0 })).status, 400, "التلميذ لا يجيب على سؤال غير مراجع خارج الواجبات");

  // الأستاذ يستعمل سؤاله في واجب قبل المراجعة
  const cls = (await t("classes", { name: "قسم ليلى", stream: "se" })).body.class;
  await s("classes/join", { code: cls.code });
  const hw = (await t(`classes/${cls.id}/assignments`, { title: "واجب", chapter: "exp", difficulty: 2, count: 20 })).body.assignment;
  assert.ok(hw.qids.includes(id), "أسئلة الأستاذ قيد المراجعة تدخل في واجباته");
  const other = (await t2("classes", { name: "قسم آخر", stream: "se" })).body.class;
  const hw2 = (await t2(`classes/${other.id}/assignments`, { title: "واجب", chapter: "exp", difficulty: 2, count: 20 })).body.assignment;
  assert.ok(!hw2.qids.includes(id), "ولا تدخل في واجبات غيره");
  assert.ok((await s("questions")).body.questions.some(x => x.id === id), "التلميذ يرى سؤال واجبه");
  assert.equal((await s("attempts", { qid: id, k: 0, assignmentId: hw.id })).body.ok, true);

  // المراجعة
  assert.equal((await t("review")).status, 403, "الأستاذ العادي ليس مديراً");
  const pending = (await admin("review")).body.questions;
  assert.equal(pending.length, 1); assert.equal(pending[0].author, "أستاذة ليلى");
  assert.equal((await admin(`questions/${id}/review`, { decision: "reject", note: "" })).status, 400, "الرفض يتطلب سبباً");
  assert.equal((await admin(`questions/${id}/review`, { decision: "reject", note: "صحح الخيار الثالث" })).status, 200);
  const rejected = (await t("questions")).body.questions.find(x => x.id === id);
  assert.equal(rejected.status, "rejected"); assert.equal(rejected.note, "صحح الخيار الثالث");
  // الأستاذ يصحح فيعود إلى المراجعة
  assert.equal((await t(`questions/${id}`, { ...good, o: ["3", "ln 3", "3e"] })).body.status, "pending");
  assert.equal((await admin(`questions/${id}/review`, { decision: "approve" })).status, 200);
  assert.equal((await admin(`questions/${id}/review`, { decision: "approve" })).status, 404, "لا يُراجع مرتين");
  const pub = (await guest("questions")).body;
  assert.equal(pub.questions.length, 62, "بعد القبول يظهر للجميع");
  assert.equal(pub.questions.find(x => x.id === id).mine, undefined);
  assert.equal((await t(`questions/${id}`, good)).status, 403, "الأستاذ لا يعدل سؤالاً منشوراً");
  assert.equal((await admin(`questions/${id}`, { ...good, e: "شرح محسّن" })).body.status, "approved", "المدير يعدل دون إلغاء النشر");
  assert.equal((await t(`questions/${id}/delete`, {})).status, 403);
  assert.equal((await admin(`questions/${id}/delete`, {})).status, 400, "لا يُحذف سؤال أجاب عنه تلاميذ");
  // المدير يعدل سؤالاً مدمجاً
  assert.equal((await admin("questions/1", { ...good, ch: "lim", d: 1 })).status, 200);
  assert.equal((await t2("questions/1", good)).status, 403);
});

test("مواضيع البكالوريا: حفظ التقييم الذاتي", async () => {
  const s = client(), p = client();
  await s("register", { name: "تلميذة", login: "bac@mail.dz", password: "secret1", role: "student", stream: "se" });
  await p("register", { name: "ولي", login: "bacp@mail.dz", password: "secret1", role: "parent" });
  assert.match(await (await fetch(BASE + "/bac.js")).text(), /تمرين تجريبي/);
  assert.equal((await s("bac/progress", { eid: "se-2000-1-1", part: 0, score: 1 })).status, 200);
  assert.equal((await s("bac/progress", { eid: "se-2000-1-1", part: 2, score: 0.5 })).status, 200);
  assert.equal((await s("bac/progress", { eid: "se-2000-1-1", part: 0, score: 0 })).status, 200, "تغيير التقييم");
  assert.equal((await s("bac/progress", { eid: "se-2000-1-1", part: 3, score: 1 })).status, 400, "جزء غير موجود");
  assert.equal((await s("bac/progress", { eid: "1999-9-9", part: 0, score: 1 })).status, 400, "تمرين غير موجود");
  assert.equal((await s("bac/progress", { eid: "se-2000-1-1", part: 1, score: 0.7 })).status, 400, "تقييم غير صالح");
  assert.equal((await p("bac/progress", { eid: "se-2000-1-1", part: 0, score: 1 })).status, 403);
  assert.deepEqual((await s("bac/progress")).body.progress, { "se-2000-1-1": { 0: 0, 2: 0.5 } });
  assert.equal((await fetch(BASE + "/bac/fig/../../server/server.js")).status, 404);
  assert.equal((await fetch(BASE + "/bac/fig/nope.png")).status, 404);
});

test("الشعب", async () => {
  const s = client(), t = client(), p = client();
  assert.equal((await s("register", { name: "بلا شعبة", login: "nostream@mail.dz", password: "secret1", role: "student" })).status, 400, "التلميذ يجب أن يختار شعبته");
  assert.equal((await s("register", { name: "شعبة خاطئة", login: "badstream@mail.dz", password: "secret1", role: "student", stream: "xx" })).status, 400);
  const u = (await s("register", { name: "تلميذ رياضيات", login: "math@mail.dz", password: "secret1", role: "student", stream: "m" })).body.user;
  assert.equal(u.stream, "m");
  assert.equal((await s("me/stream", { stream: "ge" })).body.user.stream, "ge");
  assert.equal((await s("me")).body.user.stream, "ge");
  await t("register", { name: "أستاذ", login: "tstream@mail.dz", password: "secret1", role: "teacher" });
  assert.equal((await t("me/stream", { stream: "ge" })).status, 403);
  assert.equal((await t("classes", { name: "قسم بلا شعبة" })).status, 400, "القسم يحتاج شعبة");
  const c = (await t("classes", { name: "3 تسيير", stream: "ge" })).body.class;
  assert.equal(c.stream, "ge");
  await s("classes/join", { code: c.code });
  assert.equal((await t(`classes/${c.id}`)).body.class.stream, "ge");
  assert.equal((await t(`classes/${c.id}/students/${u.id}/attempts`)).body.stream, "ge");
  await p("register", { name: "ولي", login: "pstream@mail.dz", password: "secret1", role: "parent" });
  await p("children/link", { code: u.linkCode });
  assert.equal((await p("children")).body.children[0].stream, "ge");
  assert.equal((await p(`children/${u.id}/attempts`)).body.stream, "ge");
});
