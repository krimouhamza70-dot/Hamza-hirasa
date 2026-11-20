// يتحقق أن كل نصوص bac.js تُعرض بترتيب صحيح (المقاطع الرياضية معزولة ومتوازنة الأقواس)
const fs = require("fs"), path = require("path"), ROOT = path.join(__dirname, "..");
const app = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
eval(app.slice(app.indexOf("const esc"), app.indexOf("\n", app.indexOf("const M ="))) + ";global.M = M");
eval(fs.readFileSync(path.join(ROOT, "bac.js"), "utf8") + ";global.B = BAC");
const un = t => t.replace(/<\/?span[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const all = [];
for (const x of B) { all.push(...x.intro.split("\n")); for (const p of x.parts) all.push(...p.q.split("\n"), p.ans, ...p.s); }
let bad = 0;
for (const t of all) {
  const o = M(t);
  if (un(o) !== t) { bad++; console.log("نص متغير:", t); }
  for (const r of o.matchAll(/dir="ltr">([^<]*)</g)) if (r[1].split("(").length !== r[1].split(")").length) { bad++; console.log("أقواس:", r[1]); }
}
console.log(`نصوص: ${all.length}، مشاكل: ${bad}`);
process.exit(bad ? 1 : 0);
