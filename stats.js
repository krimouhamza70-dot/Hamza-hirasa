// حسابات إحصائية: إتقان كل وحدة + توقع علامة الباك
// الإتقان = تقدير لابلاس (c+1)/(a+2) حتى لا تكون النتيجة متطرفة عند قلة المحاولات
function chapterStats(history, chapters, questions) {
  const byQ = Object.fromEntries(questions.map(q => [q.id, q.ch]));
  return chapters.map(ch => {
    const h = history.filter(x => byQ[x.qid] === ch.id);
    const attempts = h.length, correct = h.filter(x => x.ok).length;
    return { ...ch, attempts, correct, mastery: (correct + 1) / (attempts + 2) };
  });
}
function predict(stats) {
  const attempts = stats.reduce((s, c) => s + c.attempts, 0);
  const mean = stats.reduce((s, c) => s + c.mastery, 0) / stats.length;
  // هامش الخطأ يتقلص كلما زاد عدد المحاولات (تقريب ثنائي الحد بأسوأ حالة p=0.5)
  const margin = attempts ? 20 * 1.96 * Math.sqrt(0.25 / attempts) : 20;
  const score = 20 * mean;
  return { attempts, score, low: Math.max(0, score - margin), high: Math.min(20, score + margin), reliable: attempts >= 15 };
}
if (typeof module !== "undefined") module.exports = { chapterStats, predict };
