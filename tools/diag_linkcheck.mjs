// Standalone ESM link check: imports the three entry files with Node's real
// module loader. Chrome/V8 link rules are identical, so this reproduces the
// "status code: 15" load failure. ANY error other than hitting a known
// browser-only global (chrome, document, localStorage...) is FATAL - that
// includes redeclaration SyntaxErrors and missing exports, which plain
// `node --check` cannot see (it is parse-only).
const targets = ['../background.js', '../popup.js', '../results.js'];
const BENIGN = /\b(chrome|document|window|localStorage|navigator|location|fetch|AbortController|crypto)\s+is not defined\b/i;
let fatal = 0;
for (const t of targets) {
  const url = new URL(t, import.meta.url).href;
  try {
    await import(url);
    console.log('EVAL OK (fully evaluated):', t);
  } catch (e) {
    const msg = String((e && e.message) || e);
    const isFatal = !BENIGN.test(msg);
    if (isFatal) fatal++;
    console.log((isFatal ? 'FATAL - ' : 'link OK - stopped at browser API: ') + t);
    console.log('   ' + msg.split('\n')[0]);
  }
}
process.exit(fatal ? 1 : 0);
