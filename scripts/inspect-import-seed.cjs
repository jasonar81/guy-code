// Look at a few raw events of an unopened imported session to verify the
// loader would extract them.
const fs = require('node:fs');

const seedPath = process.argv[2];
if (!seedPath) {
  console.log('usage: node inspect-import-seed.cjs <path>');
  process.exit(1);
}

const text = fs.readFileSync(seedPath, 'utf8');
const lines = text.split('\n').filter(Boolean);
console.log(`Total lines: ${lines.length}`);

// Count by event type
const counts = {};
for (const ln of lines) {
  try {
    const e = JSON.parse(ln);
    counts[e.type] = (counts[e.type] ?? 0) + 1;
  } catch {}
}
console.log('Type counts:', counts);

// First 5 user/assistant events
console.log('\nFirst 5 user/assistant events:');
let shown = 0;
for (let i = 0; i < lines.length && shown < 5; i++) {
  try {
    const e = JSON.parse(lines[i]);
    if (e.type !== 'user' && e.type !== 'assistant') continue;
    const role = e.message?.role;
    const hasMsg = !!e.message;
    const hasContent = e.message?.content !== undefined;
    const ctype = Array.isArray(e.message?.content) ? 'array' : typeof e.message?.content;
    const blocks = Array.isArray(e.message?.content)
      ? e.message.content
          .map((b) => b?.type ?? '?')
          .join(',')
      : '(string)';
    console.log(
      `  [${i}] type=${e.type} role=${role} hasMsg=${hasMsg} hasContent=${hasContent} ctype=${ctype} blocks=[${blocks}]`
    );
    shown++;
  } catch (err) {
    console.log(`  [${i}] PARSE_ERR: ${err.message}`);
  }
}

// Check for sidechain / isSidechain fields that may exclude events
let sidechainCount = 0;
let parentUuidCount = 0;
for (const ln of lines) {
  try {
    const e = JSON.parse(ln);
    if (e.isSidechain) sidechainCount++;
    if (e.parentUuid) parentUuidCount++;
  } catch {}
}
console.log(`\nisSidechain=true: ${sidechainCount}`);
console.log(`has parentUuid: ${parentUuidCount}`);
