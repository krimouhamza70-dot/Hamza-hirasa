// يجمع ملفات bac/src/*.json في bac.js بعد التحقق منها
// التشغيل: npm run build:bac
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(ROOT, "data.js"), "utf8") + ";this.C = CHAPTERS; this.ST = STREAMS;", ctx);
const CH = new Set(ctx.C.map(c => c.id)), ST = new Set(ctx.ST.map(s => s.id));

const errors = [], all = [];
const srcDir = path.join(ROOT, "bac", "src");
for (const file of fs.readdirSync(srcDir).filter(f => f.endsWith(".json")).sort()) {
  const doc = JSON.parse(fs.readFileSync(path.join(srcDir, file), "utf8"));
  const err = m => errors.push(`${file}: ${m}`);
  if (!ST.has(doc.stream)) err(`شعبة غير معروفة ${doc.stream}`);
  if (!Number.isInteger(doc.year)) err("السنة مفقودة");
  for (const x of doc.exercises || []) {
    const id = `${doc.stream}-${doc.year}-${x.subject}-${x.num}`, e = m => err(`${id}: ${m}`);
    if (![1, 2].includes(x.subject) || !Number.isInteger(x.num)) e("رقم الموضوع أو التمرين غير صالح");
    if (!x.ch?.length || x.ch.some(c => !CH.has(c))) e(`وحدات غير معروفة: ${x.ch}`);
    if (!x.intro?.trim()) e("نص التمرين فارغ");
    if (!x.parts?.length) e("لا توجد أجزاء");
    for (const [i, p] of (x.parts || []).entries()) {
      if (!p.q?.trim() || !p.ans?.trim() || !p.s?.length) e(`الجزء ${i + 1} ناقص (السؤال أو الجواب أو الحل)`);
      if (!(p.pts > 0)) e(`الجزء ${i + 1} بدون نقاط`);
    }
    const sum = (x.parts || []).reduce((t, p) => t + (p.pts || 0), 0);
    if (Math.abs(sum - x.points) > 1e-9) e(`مجموع نقاط الأجزاء ${sum} لا يساوي نقاط التمرين ${x.points}`);
    for (const f of [x.fig, ...(x.parts || []).map(p => p.sfig)].filter(Boolean))
      if (!/^[A-Za-z0-9_-]+\.(png|jpe?g|webp)$/.test(f) || !fs.existsSync(path.join(ROOT, "bac", "fig", f))) e(`الصورة غير موجودة: ${f}`);
    if (all.some(y => y.id === id)) e("تمرين مكرر");
    all.push({ id, stream: doc.stream, year: doc.year, ...x });
  }
}
if (errors.length) { console.error("أخطاء:\n" + errors.join("\n")); process.exit(1); }
all.sort((a, b) => a.stream.localeCompare(b.stream) || b.year - a.year || a.subject - b.subject || a.num - b.num);
const header = fs.readFileSync(path.join(ROOT, "bac.js"), "utf8").split("const BAC = ")[0];
fs.writeFileSync(path.join(ROOT, "bac.js"), header + "const BAC = " + JSON.stringify(all, null, 1) + ";\n");
const by = {}; for (const x of all) by[`${x.stream} ${x.year}`] = (by[`${x.stream} ${x.year}`] || 0) + 1;
console.log(`bac.js: ${all.length} تمريناً`, by);
