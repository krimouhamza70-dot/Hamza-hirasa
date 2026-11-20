"use strict";
// خادم منصة رياضيات الباك — بدون مكتبات خارجية (Node.js 22.13 أو أحدث)
// التشغيل: node server/server.js   ثم افتح http://localhost:3000
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const vm = require("node:vm");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.join(__dirname, "..");
const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = process.env.DB_PATH || path.join(ROOT, "data", "app.db");
const SECURE_COOKIE = process.env.COOKIE_SECURE === "1"; // فعّله عند العمل عبر https
const TRUST_PROXY = process.env.TRUST_PROXY === "1";     // فعّله خلف خادم وسيط (Nginx، Render...)
const SESSION_DAYS = 30;
const RATE_LIMIT = Number(process.env.RATE_LIMIT) || 20;   // عدد محاولات الدخول/التسجيل المسموحة كل 15 دقيقة

// ---------- الأجوبة الصحيحة من data.js (الخادم يصحح بنفسه) ----------
const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(ROOT, "data.js"), "utf8") + ";this.Q = QUESTIONS;", ctx);
const ANSWER = new Map(ctx.Q.map(q => [q.id, q.a]));
const QMAP = new Map(ctx.Q.map(q => [q.id, q]));
const CHAPTER_IDS = new Set(ctx.Q.map(q => q.ch));

// ---------- قاعدة البيانات ----------
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
const q = sql => db.prepare(sql);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    login TEXT NOT NULL UNIQUE,
    pass TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('student', 'parent', 'teacher')),
    link_code TEXT UNIQUE,
    created INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS links (
    parent_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (parent_id, student_id)
  );
  CREATE TABLE IF NOT EXISTS attempts (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    qid INTEGER NOT NULL,
    k INTEGER,
    ok INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    assignment_id INTEGER REFERENCES assignments(id) ON DELETE SET NULL
  );
  CREATE TABLE IF NOT EXISTS classes (
    id INTEGER PRIMARY KEY,
    teacher_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    code TEXT NOT NULL UNIQUE,
    created INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS class_members (
    class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
    student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined INTEGER NOT NULL,
    PRIMARY KEY (class_id, student_id)
  );
  CREATE TABLE IF NOT EXISTS assignments (
    id INTEGER PRIMARY KEY,
    class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    qids TEXT NOT NULL,
    due INTEGER,
    created INTEGER NOT NULL
  );
`);
// ترقية قواعد البيانات القديمة (قبل إضافة الأستاذ والواجبات)
if (!q("SELECT sql FROM sqlite_master WHERE name = 'users'").get().sql.includes("'teacher'")) {
  db.exec(`PRAGMA foreign_keys = OFF; BEGIN;
    CREATE TABLE users_new (id INTEGER PRIMARY KEY, name TEXT NOT NULL, login TEXT NOT NULL UNIQUE, pass TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('student', 'parent', 'teacher')), link_code TEXT UNIQUE, created INTEGER NOT NULL);
    INSERT INTO users_new SELECT id, name, login, pass, role, link_code, created FROM users;
    DROP TABLE users; ALTER TABLE users_new RENAME TO users; COMMIT; PRAGMA foreign_keys = ON;`);
}
if (!q("PRAGMA table_info(attempts)").all().some(c => c.name === "assignment_id")) {
  db.exec("ALTER TABLE attempts ADD COLUMN assignment_id INTEGER REFERENCES assignments(id) ON DELETE SET NULL");
}
db.exec(`CREATE INDEX IF NOT EXISTS attempts_user ON attempts(user_id, ts);
         CREATE INDEX IF NOT EXISTS attempts_assignment ON attempts(assignment_id);
         CREATE INDEX IF NOT EXISTS members_student ON class_members(student_id);`);
const tx = fn => { db.exec("BEGIN"); try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; } };

// ---------- أدوات الأمان ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return salt.toString("hex") + ":" + crypto.scryptSync(pw, salt, 32).toString("hex");
}
function checkPassword(pw, stored) {
  const [salt, hash] = stored.split(":");
  const got = crypto.scryptSync(pw, Buffer.from(salt, "hex"), 32);
  return crypto.timingSafeEqual(got, Buffer.from(hash, "hex"));
}
const sha = t => crypto.createHash("sha256").update(t).digest("hex");
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // بدون O/0 و I/1 لتفادي الالتباس
function newCode(taken) {
  for (;;) {
    const c = Array.from(crypto.randomBytes(6), b => CODE_CHARS[b % CODE_CHARS.length]).join("");
    if (!taken(c)) return c;
  }
}
const newLinkCode = () => newCode(c => q("SELECT 1 FROM users WHERE link_code = ?").get(c));
const hits = new Map(); // حد بسيط لمحاولات الدخول والتسجيل
function limited(ip) {
  const now = Date.now(); let e = hits.get(ip);
  if (!e || e.reset < now) e = { n: 0, reset: now + 15 * 60e3 };
  e.n++; hits.set(ip, e); return e.n > RATE_LIMIT;
}
// تسجيل دخول وهمي بنفس التكلفة عند عدم وجود الحساب (لا يكشف وجود الحسابات بالتوقيت)
const DUMMY_HASH = hashPassword(crypto.randomBytes(8).toString("hex"));

// ---------- أدوات HTTP ----------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}
function readJson(req) {
  if (!(req.headers["content-type"] || "").includes("application/json")) throw new HttpError(415, "صيغة الطلب غير مدعومة");
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > 200_000) { reject(new HttpError(413, "الطلب كبير جداً")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch { reject(new HttpError(400, "بيانات غير صالحة")); } });
    req.on("error", reject);
  });
}
const cookieOf = req => Object.fromEntries((req.headers.cookie || "").split(";").map(c => c.trim().split("=")).filter(p => p.length === 2));
function sessionCookie(token, maxAge) {
  return `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}` + (SECURE_COOKIE ? "; Secure" : "");
}
function currentUser(req) {
  const t = cookieOf(req).sid; if (!t) return null;
  return q(`SELECT u.id, u.name, u.role, u.link_code FROM sessions s JOIN users u ON u.id = s.user_id
            WHERE s.token_hash = ? AND s.expires > ?`).get(sha(t), Date.now()) || null;
}
function publicUser(u) { return u && { id: u.id, name: u.name, role: u.role, ...(u.role === "student" ? { linkCode: u.link_code } : {}) }; }
function startSession(res, user) {
  const token = crypto.randomBytes(32).toString("base64url");
  q("INSERT INTO sessions (token_hash, user_id, expires) VALUES (?, ?, ?)").run(sha(token), user.id, Date.now() + SESSION_DAYS * 864e5);
  send(res, 200, { user: publicUser(user) }, { "Set-Cookie": sessionCookie(token, SESSION_DAYS * 86400) });
}
const str = (v, min, max, msg) => { if (typeof v !== "string" || v.trim().length < min || v.trim().length > max) throw new HttpError(400, msg); return v.trim(); };
const need = (u, role) => { if (!u) throw new HttpError(401, "يجب تسجيل الدخول"); if (role && u.role !== role) throw new HttpError(403, "غير مسموح لهذا النوع من الحسابات"); };
function ownClass(u, id) {
  const c = q("SELECT id, name, code FROM classes WHERE id = ? AND teacher_id = ?").get(Number(id), u.id);
  if (!c) throw new HttpError(404, "القسم غير موجود");
  return c;
}
// تقدم كل تلميذ في واجب: عدد الأسئلة المجاب عنها، والصحيحة في المحاولة الأولى
function progressOf(assignmentId) {
  const out = {}, seen = new Set();
  for (const r of q("SELECT user_id, qid, ok FROM attempts WHERE assignment_id = ? ORDER BY id").all(assignmentId)) {
    const key = r.user_id + ":" + r.qid; if (seen.has(key)) continue; seen.add(key);
    const p = out[r.user_id] || (out[r.user_id] = { answered: 0, correct: 0 }); p.answered++; p.correct += r.ok;
  }
  return out;
}
const history = id => q("SELECT qid, ok, ts FROM attempts WHERE user_id = ? ORDER BY ts, id").all(id).map(r => ({ qid: r.qid, ok: !!r.ok, ts: r.ts }));

// ---------- الواجهة البرمجية ----------
async function api(req, res, url) {
  const ip = TRUST_PROXY ? String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress : req.socket.remoteAddress;
  const user = currentUser(req), route = req.method + " " + url.pathname;

  if (route === "GET /api/me") return send(res, 200, { user: publicUser(user) });

  if (route === "POST /api/register") {
    if (limited(ip)) throw new HttpError(429, "محاولات كثيرة، أعد المحاولة بعد 15 دقيقة");
    const b = await readJson(req);
    const name = str(b.name, 2, 60, "الاسم يجب أن يكون بين 2 و 60 حرفاً");
    const login = str(b.login, 4, 100, "أدخل رقم هاتف أو بريداً إلكترونياً صحيحاً").toLowerCase().replace(/\s+/g, "");
    if (typeof b.password !== "string" || b.password.length < 6 || b.password.length > 200) throw new HttpError(400, "كلمة السر يجب أن تحتوي 6 أحرف على الأقل");
    if (!["student", "parent", "teacher"].includes(b.role)) throw new HttpError(400, "اختر نوع الحساب");
    if (q("SELECT 1 FROM users WHERE login = ?").get(login)) throw new HttpError(409, "يوجد حساب بهذا الرقم أو البريد، سجّل الدخول بدلاً من ذلك");
    const r = q("INSERT INTO users (name, login, pass, role, link_code, created) VALUES (?, ?, ?, ?, ?, ?)")
      .run(name, login, hashPassword(b.password), b.role, b.role === "student" ? newLinkCode() : null, Date.now());
    return startSession(res, q("SELECT id, name, role, link_code FROM users WHERE id = ?").get(Number(r.lastInsertRowid)));
  }

  if (route === "POST /api/login") {
    if (limited(ip)) throw new HttpError(429, "محاولات كثيرة، أعد المحاولة بعد 15 دقيقة");
    const b = await readJson(req);
    const login = String(b.login || "").trim().toLowerCase().replace(/\s+/g, "");
    const u = q("SELECT id, name, role, link_code, pass FROM users WHERE login = ?").get(login);
    const okPw = checkPassword(String(b.password || ""), u ? u.pass : DUMMY_HASH);
    if (!u || !okPw) throw new HttpError(401, "رقم الهاتف/البريد أو كلمة السر غير صحيحة");
    return startSession(res, u);
  }

  if (route === "POST /api/logout") {
    const t = cookieOf(req).sid; if (t) q("DELETE FROM sessions WHERE token_hash = ?").run(sha(t));
    return send(res, 200, { ok: true }, { "Set-Cookie": sessionCookie("", 0) });
  }

  if (route === "GET /api/attempts") { need(user, "student"); return send(res, 200, { history: history(user.id) }); }

  if (route === "POST /api/attempts") {
    need(user, "student");
    const b = await readJson(req);
    if (!ANSWER.has(b.qid)) throw new HttpError(400, "سؤال غير موجود");
    const k = Number.isInteger(b.k) && b.k >= 0 && b.k < 10 ? b.k : null;
    let aid = null;
    if (b.assignmentId !== undefined && b.assignmentId !== null) { // إجابة ضمن واجب: يجب أن يكون التلميذ في القسم والسؤال في الواجب
      const a = q(`SELECT a.id, a.qids FROM assignments a JOIN class_members m ON m.class_id = a.class_id
                   WHERE a.id = ? AND m.student_id = ?`).get(Number(b.assignmentId), user.id);
      if (!a || !JSON.parse(a.qids).includes(b.qid)) throw new HttpError(400, "هذا الواجب غير موجود");
      aid = a.id;
    }
    const ok = k !== null && ANSWER.get(b.qid) === k, ts = Date.now();
    q("INSERT INTO attempts (user_id, qid, k, ok, ts, assignment_id) VALUES (?, ?, ?, ?, ?, ?)").run(user.id, b.qid, k, ok ? 1 : 0, ts, aid);
    return send(res, 200, { ok, ts });
  }

  if (route === "POST /api/attempts/import") { // نقل نتائج وضع الضيف إلى الحساب
    need(user, "student");
    const b = await readJson(req);
    if (!Array.isArray(b.items) || b.items.length > 5000) throw new HttpError(400, "بيانات غير صالحة");
    const now = Date.now(), ins = q("INSERT INTO attempts (user_id, qid, k, ok, ts) VALUES (?, ?, NULL, ?, ?)");
    const items = b.items.filter(x => x && ANSWER.has(x.qid) && typeof x.ok === "boolean" && Number.isFinite(x.ts) && x.ts > 1.5e12 && x.ts <= now);
    tx(() => items.forEach(x => ins.run(user.id, x.qid, x.ok ? 1 : 0, Math.floor(x.ts))));
    return send(res, 200, { imported: items.length });
  }

  if (route === "GET /api/children") {
    need(user, "parent");
    const children = q(`SELECT u.id, u.name, COUNT(a.id) AS attempts, COALESCE(SUM(a.ok), 0) AS correct, MAX(a.ts) AS last
                        FROM links l JOIN users u ON u.id = l.student_id LEFT JOIN attempts a ON a.user_id = u.id
                        WHERE l.parent_id = ? GROUP BY u.id ORDER BY u.name`).all(user.id);
    return send(res, 200, { children });
  }

  if (route === "POST /api/children/link") {
    need(user, "parent");
    if (limited(ip)) throw new HttpError(429, "محاولات كثيرة، أعد المحاولة بعد 15 دقيقة");
    const b = await readJson(req);
    const code = String(b.code || "").trim().toUpperCase();
    const s = q("SELECT id, name FROM users WHERE link_code = ? AND role = 'student'").get(code);
    if (!s) throw new HttpError(404, "رمز الربط غير صحيح. تأكد منه في صفحة «حسابي» عند التلميذ");
    q("INSERT OR IGNORE INTO links (parent_id, student_id) VALUES (?, ?)").run(user.id, s.id);
    return send(res, 200, { child: s });
  }

  // ---------- الأستاذ: الأقسام والواجبات ----------
  if (route === "GET /api/classes") {
    need(user, "teacher");
    return send(res, 200, { classes: q(`SELECT c.id, c.name, c.code, COUNT(m.student_id) AS students FROM classes c
      LEFT JOIN class_members m ON m.class_id = c.id WHERE c.teacher_id = ? GROUP BY c.id ORDER BY c.created DESC`).all(user.id) });
  }
  if (route === "POST /api/classes") {
    need(user, "teacher");
    const b = await readJson(req);
    const name = str(b.name, 2, 60, "اسم القسم يجب أن يكون بين 2 و 60 حرفاً");
    if (q("SELECT COUNT(*) AS n FROM classes WHERE teacher_id = ?").get(user.id).n >= 30) throw new HttpError(400, "الحد الأقصى 30 قسماً");
    const code = newCode(c => q("SELECT 1 FROM classes WHERE code = ?").get(c));
    const r = q("INSERT INTO classes (teacher_id, name, code, created) VALUES (?, ?, ?, ?)").run(user.id, name, code, Date.now());
    return send(res, 200, { class: { id: Number(r.lastInsertRowid), name, code, students: 0 } });
  }
  let m;
  if (req.method === "GET" && (m = url.pathname.match(/^\/api\/classes\/(\d+)$/))) {
    need(user, "teacher");
    const c = ownClass(user, m[1]);
    const students = q(`SELECT u.id, u.name FROM class_members m JOIN users u ON u.id = m.student_id
                        WHERE m.class_id = ? ORDER BY u.name`).all(c.id).map(s => ({ ...s, ch: {}, attempts: 0, correct: 0, last: null }));
    const byId = new Map(students.map(s => [s.id, s]));
    for (const r of q(`SELECT a.user_id, a.qid, a.ok, a.ts FROM attempts a JOIN class_members m ON m.student_id = a.user_id
                       WHERE m.class_id = ?`).all(c.id)) {
      const s = byId.get(r.user_id), ch = QMAP.get(r.qid)?.ch; if (!s || !ch) continue;
      const cell = s.ch[ch] || (s.ch[ch] = [0, 0]); cell[0]++; cell[1] += r.ok;
      s.attempts++; s.correct += r.ok; s.last = Math.max(s.last || 0, r.ts);
    }
    const assignments = q("SELECT id, title, qids, due, created FROM assignments WHERE class_id = ? ORDER BY created DESC").all(c.id)
      .map(a => ({ id: a.id, title: a.title, qids: JSON.parse(a.qids), due: a.due, created: a.created, progress: progressOf(a.id) }));
    return send(res, 200, { class: { id: c.id, name: c.name, code: c.code }, students, assignments });
  }
  if (req.method === "POST" && (m = url.pathname.match(/^\/api\/classes\/(\d+)\/assignments$/))) {
    need(user, "teacher");
    const c = ownClass(user, m[1]), b = await readJson(req);
    const title = str(b.title, 2, 80, "عنوان الواجب يجب أن يكون بين 2 و 80 حرفاً");
    const chapter = b.chapter || "", difficulty = Number(b.difficulty) || 0, count = Number(b.count);
    if (chapter && !CHAPTER_IDS.has(chapter)) throw new HttpError(400, "وحدة غير معروفة");
    if (![0, 1, 2, 3].includes(difficulty)) throw new HttpError(400, "مستوى صعوبة غير معروف");
    if (!Number.isInteger(count) || count < 1 || count > 20) throw new HttpError(400, "عدد الأسئلة يجب أن يكون بين 1 و 20");
    const due = b.due === null || b.due === undefined || b.due === "" ? null : Number(b.due);
    if (due !== null && (!Number.isFinite(due) || due < Date.now() - 864e5)) throw new HttpError(400, "تاريخ التسليم غير صالح");
    const pool = ctx.Q.filter(x => (!chapter || x.ch === chapter) && (!difficulty || x.d === difficulty));
    if (!pool.length) throw new HttpError(400, "لا توجد أسئلة بهذه الشروط");
    const qids = pool.map(x => [crypto.randomInt(1e9), x]).sort((a, z) => a[0] - z[0]).slice(0, count)
      .map(p => p[1]).sort((a, z) => a.d - z.d).map(x => x.id); // من الأسهل إلى الأصعب
    const r = q("INSERT INTO assignments (class_id, title, qids, due, created) VALUES (?, ?, ?, ?, ?)").run(c.id, title, JSON.stringify(qids), due, Date.now());
    return send(res, 200, { assignment: { id: Number(r.lastInsertRowid), title, qids, due } });
  }
  if (req.method === "POST" && (m = url.pathname.match(/^\/api\/assignments\/(\d+)\/delete$/))) {
    need(user, "teacher");
    const r = q(`DELETE FROM assignments WHERE id = ? AND class_id IN (SELECT id FROM classes WHERE teacher_id = ?)`).run(Number(m[1]), user.id);
    if (!r.changes) throw new HttpError(404, "الواجب غير موجود");
    return send(res, 200, { ok: true });
  }
  if (req.method === "GET" && (m = url.pathname.match(/^\/api\/classes\/(\d+)\/students\/(\d+)\/attempts$/))) {
    need(user, "teacher");
    const c = ownClass(user, m[1]);
    const s = q(`SELECT u.id, u.name FROM class_members m JOIN users u ON u.id = m.student_id WHERE m.class_id = ? AND u.id = ?`).get(c.id, Number(m[2]));
    if (!s) throw new HttpError(404, "هذا التلميذ ليس في القسم");
    return send(res, 200, { name: s.name, history: history(s.id) });
  }

  // ---------- التلميذ: الانضمام إلى قسم والواجبات ----------
  if (route === "POST /api/classes/join") {
    need(user, "student");
    if (limited(ip)) throw new HttpError(429, "محاولات كثيرة، أعد المحاولة بعد 15 دقيقة");
    const b = await readJson(req);
    const c = q(`SELECT c.id, c.name, u.name AS teacher FROM classes c JOIN users u ON u.id = c.teacher_id WHERE c.code = ?`)
      .get(String(b.code || "").trim().toUpperCase());
    if (!c) throw new HttpError(404, "رمز القسم غير صحيح. اطلبه من أستاذك");
    q("INSERT OR IGNORE INTO class_members (class_id, student_id, joined) VALUES (?, ?, ?)").run(c.id, user.id, Date.now());
    return send(res, 200, { class: c });
  }
  if (route === "GET /api/my/classes") {
    need(user, "student");
    const classes = q(`SELECT c.id, c.name, u.name AS teacher FROM class_members m JOIN classes c ON c.id = m.class_id
                       JOIN users u ON u.id = c.teacher_id WHERE m.student_id = ? ORDER BY m.joined`).all(user.id);
    const assignments = q(`SELECT a.id, a.title, a.qids, a.due, a.created, c.name AS className FROM assignments a
                           JOIN class_members m ON m.class_id = a.class_id JOIN classes c ON c.id = a.class_id
                           WHERE m.student_id = ? ORDER BY COALESCE(a.due, a.created + 7 * 864e5)`).all(user.id)
      .map(a => ({ ...a, qids: JSON.parse(a.qids), mine: progressOf(a.id)[user.id] || { answered: 0, correct: 0 } }));
    return send(res, 200, { classes, assignments });
  }

  m = url.pathname.match(/^\/api\/children\/(\d+)\/attempts$/);
  if (req.method === "GET" && m) {
    need(user, "parent");
    const s = q(`SELECT u.id, u.name FROM links l JOIN users u ON u.id = l.student_id WHERE l.parent_id = ? AND l.student_id = ?`).get(user.id, Number(m[1]));
    if (!s) throw new HttpError(404, "هذا التلميذ غير مرتبط بحسابك");
    return send(res, 200, { name: s.name, history: history(s.id) });
  }

  throw new HttpError(404, "غير موجود");
}

// ---------- الملفات الثابتة ----------
const STATIC = { "/": "index.html", "/index.html": "index.html", "/style.css": "style.css", "/data.js": "data.js",
  "/solutions.js": "solutions.js", "/stats.js": "stats.js", "/app.js": "app.js" };
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; frame-ancestors 'none'"
};
function serveStatic(req, res, url) {
  if (url.pathname === "/favicon.ico") { res.writeHead(204, SECURITY_HEADERS); return res.end(); }
  const file = STATIC[url.pathname];
  if (!file || !["GET", "HEAD"].includes(req.method)) { res.writeHead(404, SECURITY_HEADERS); return res.end("Not found"); }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)], "Cache-Control": "no-cache", ...SECURITY_HEADERS });
  res.end(req.method === "HEAD" ? undefined : fs.readFileSync(path.join(ROOT, file)));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/api/")) await api(req, res, url);
    else serveStatic(req, res, url);
  } catch (e) {
    if (e instanceof HttpError) send(res, e.status, { error: e.message });
    else { console.error(e); send(res, 500, { error: "خطأ في الخادم، أعد المحاولة" }); }
  }
});
// تنظيف الجلسات المنتهية مرة كل ساعة
setInterval(() => q("DELETE FROM sessions WHERE expires < ?").run(Date.now()), 3600e3).unref();
server.listen(PORT, () => console.log(`المنصة تعمل على http://localhost:${PORT}`));
module.exports = server;
