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

// ---------- الأجوبة الصحيحة من data.js (الخادم يصحح بنفسه) ----------
const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(ROOT, "data.js"), "utf8") + ";this.Q = QUESTIONS;", ctx);
const ANSWER = new Map(ctx.Q.map(q => [q.id, q.a]));

// ---------- قاعدة البيانات ----------
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    login TEXT NOT NULL UNIQUE,
    pass TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('student', 'parent')),
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
    ts INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS attempts_user ON attempts(user_id, ts);
`);
const q = sql => db.prepare(sql);
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
function newLinkCode() {
  for (;;) {
    const c = Array.from(crypto.randomBytes(6), b => CODE_CHARS[b % CODE_CHARS.length]).join("");
    if (!q("SELECT 1 FROM users WHERE link_code = ?").get(c)) return c;
  }
}
const hits = new Map(); // حد بسيط لمحاولات الدخول والتسجيل
function limited(ip) {
  const now = Date.now(); let e = hits.get(ip);
  if (!e || e.reset < now) e = { n: 0, reset: now + 15 * 60e3 };
  e.n++; hits.set(ip, e); return e.n > 20;
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
    if (!["student", "parent"].includes(b.role)) throw new HttpError(400, "اختر نوع الحساب");
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
    const ok = k !== null && ANSWER.get(b.qid) === k, ts = Date.now();
    q("INSERT INTO attempts (user_id, qid, k, ok, ts) VALUES (?, ?, ?, ?, ?)").run(user.id, b.qid, k, ok ? 1 : 0, ts);
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

  const m = url.pathname.match(/^\/api\/children\/(\d+)\/attempts$/);
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
