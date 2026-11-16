// Ask Opus 5.5 for a short answer WITH a tool available, and dump the raw
// stream event types + content block types. This is the only way to know what
// the model actually emits rather than guessing.
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Reuse a key from the app's DB via sql.js would need the encryption path;
// simplest: read ANTHROPIC_API_KEY from env.
const key = process.env.ANTHROPIC_API_KEY;
if (!key) {
  console.log('NO ANTHROPIC_API_KEY in env - set it and re-run');
  process.exit(2);
}
const client = new Anthropic({ apiKey: key });

const model = process.argv[2] || 'claude-opus-5-5';
console.log('model:', model);

const stream = client.messages.stream(
  {
    model,
    max_tokens: 1024,
    system: 'You are a helpful coding agent. Narrate briefly before using a tool.',
    tools: [
      {
        name: 'PowerShell',
        description: 'Run a PowerShell command',
        input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      },
    ],
    messages: [
      { role: 'user', content: 'Tell me in one sentence what you are about to do, then check the current directory with PowerShell.' },
    ],
  },
  { headers: { 'anthropic-beta': 'context-1m-2025-08-07' } }
);

const eventTypes = new Map();
const blockTypes = new Map();
const deltaTypes = new Map();
let textSeen = '';

for await (const ev of stream) {
  eventTypes.set(ev.type, (eventTypes.get(ev.type) || 0) + 1);
  if (ev.type === 'content_block_start') {
    const t = ev.content_block?.type;
    blockTypes.set(t, (blockTypes.get(t) || 0) + 1);
  }
  if (ev.type === 'content_block_delta') {
    const t = ev.delta?.type;
    deltaTypes.set(t, (deltaTypes.get(t) || 0) + 1);
    if (t === 'text_delta') textSeen += ev.delta.text;
  }
}
const final = await stream.finalMessage();

console.log('\nEVENT TYPES:', [...eventTypes.entries()].map(([k, v]) => `${k}x${v}`).join(', '));
console.log('BLOCK TYPES:', [...blockTypes.entries()].map(([k, v]) => `${k}x${v}`).join(', '));
console.log('DELTA TYPES:', [...deltaTypes.entries()].map(([k, v]) => `${k}x${v}`).join(', '));
console.log('\ntext captured via text_delta:', JSON.stringify(textSeen.slice(0, 300)));
console.log('\nFINAL MESSAGE content blocks:');
for (const b of final.content) {
  const keys = Object.keys(b).join(',');
  let preview = '';
  if (b.type === 'text') preview = JSON.stringify(String(b.text).slice(0, 160));
  else if (b.type === 'tool_use') preview = b.name;
  else preview = JSON.stringify(b).slice(0, 200);
  console.log(`  - type=${b.type} keys=[${keys}] :: ${preview}`);
}
