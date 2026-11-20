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
    { env: { ...process.env, PORT, DB_PATH: path.join(dir, "t.db") }, stdio: "ignore" });
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
  const reg = await c("register", { name: "أمين", login: "0555 12 34 56", password: "secret1", role: "student" });
  assert.equal(reg.status, 200);
  assert.match(reg.body.user.linkCode, /^[A-Z2-9]{6}$/);
  assert.equal((await c("me")).body.user.name, "أمين");
  assert.equal((await c("register", { name: "x2", login: "0555123456", password: "secret1", role: "student" })).status, 409, "نفس الرقم بمسافات");
  await c("logout", {});
  assert.equal((await c("me")).body.user, null);
  assert.equal((await c("login", { login: "0555123456", password: "wrong!!" })).status, 401);
  assert.equal((await c("login", { login: "0555123456", password: "secret1" })).status, 200);
});

test("رفض البيانات غير الصالحة", async () => {
  const c = client();
  assert.equal((await c("register", { name: "a", login: "x@y.dz", password: "secret1", role: "student" })).status, 400);
  assert.equal((await c("register", { name: "علي", login: "x@y.dz", password: "123", role: "student" })).status, 400);
  assert.equal((await c("register", { name: "علي", login: "x@y.dz", password: "secret1", role: "admin" })).status, 400);
  const r = await fetch(BASE + "/api/login", { method: "POST", body: "login=a", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  assert.equal(r.status, 415, "يقبل JSON فقط (حماية من CSRF)");
});

test("الخادم يصحح الإجابة بنفسه", async () => {
  const c = client();
  await c("register", { name: "سارة", login: "sara@mail.dz", password: "secret1", role: "student" });
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
  await c("register", { name: "يوسف", login: "youcef@mail.dz", password: "secret1", role: "student" });
  const now = Date.now();
  const r = await c("attempts/import", { items: [{ qid: 2, ok: true, ts: now - 1000 }, { qid: 3, ok: false, ts: now - 500 }, { qid: 9999, ok: true, ts: now }, { qid: 2, ok: true, ts: now + 1e9 }] });
  assert.equal(r.body.imported, 2, "يتجاهل الأسئلة غير الموجودة والتواريخ المستقبلية");
  assert.equal((await c("attempts")).body.history.length, 2);
});

test("الربط بين الولي والتلميذ وعزل البيانات", async () => {
  const s = client(), p = client(), other = client();
  const code = (await s("register", { name: "ريم", login: "rim@mail.dz", password: "secret1", role: "student" })).body.user.linkCode;
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
