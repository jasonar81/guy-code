// Simulate what loadMessagesWithTsFromJsonl returns for a given JSONL.
const fs = require('node:fs');

const p = process.argv[2];
if (!p) {
  console.log('usage: node simulate-load.cjs <path>');
  process.exit(1);
}

const text = fs.readFileSync(p, 'utf8');
const out = [];
let skipped = { not_ua: 0, no_msg: 0, bad_role: 0, no_content: 0, empty_filtered: 0 };
for (const line of text.split('\n')) {
  if (!line.trim()) continue;
  let evt;
  try {
    evt = JSON.parse(line);
  } catch {
    continue;
  }
  if (evt?.type !== 'user' && evt?.type !== 'assistant') {
    skipped.not_ua++;
    continue;
  }
  const msg = evt?.message;
  if (!msg) {
    skipped.no_msg++;
    continue;
  }
  const role = msg.role;
  if (role !== 'user' && role !== 'assistant') {
    skipped.bad_role++;
    continue;
  }
  let content = msg.content;
  if (typeof content === 'string') {
    out.push({ role, kind: 'string', preview: content.slice(0, 60) });
    continue;
  }
  if (!Array.isArray(content)) {
    skipped.no_content++;
    continue;
  }
  const filtered = content
    .filter((b) => b?.type !== 'thinking')
    .map((b) => {
      if (b.type === 'text') return { type: 'text' };
      if (b.type === 'tool_use') return { type: 'tool_use', name: b.name };
      if (b.type === 'tool_result') return { type: 'tool_result' };
      if (b.type === 'image') return { type: 'image' };
      return null;
    })
    .filter(Boolean);
  if (filtered.length === 0) {
    skipped.empty_filtered++;
    continue;
  }
  out.push({ role, blocks: filtered.map((b) => b.type).join(',') });
}

console.log(`Returned ${out.length} messages.`);
console.log(`Skipped breakdown:`, skipped);
console.log(`\nFirst 5 returned:`);
for (const m of out.slice(0, 5)) console.log('  ', m);
console.log(`\nLast 5 returned:`);
for (const m of out.slice(-5)) console.log('  ', m);
