// Unit test for sanitizeToolArgs (extracted from zai-provider source).
import { readFileSync } from 'node:fs';
import { Transpiler } from 'bun';

const src = readFileSync('src/lib/ai/zai-provider.ts', 'utf-8');
const start = src.indexOf('function sanitizeToolArgs');
const end = src.indexOf('function mapToolChoice');
const code = src.slice(start, end);
const transpiler = new Transpiler({ loader: 'ts' });
const js = transpiler.transformSync(code);
const sanitizeToolArgs = new Function(`${js}; return sanitizeToolArgs;`)() as unknown as (s: string) => string;

const cases: Array<[string, string]> = [
  ['{"a":1}', 'valid passthrough'],
  ['{"a":"line1\nline2"}', 'raw newline inside string'],
  ['{"root":"x","elements":{"a":{"type":"StatGrid","props":{"stats":[{"label":"Spo', 'truncated mid-string'],
  ['{"a":{"b":[1,2,', 'truncated after comma'],
  ['{"a":', 'truncated after colon'],
  ['{"a":1,"b"', 'truncated dangling key'],
  ['garbage', 'total garbage'],
  ['', 'empty'],
];

let failures = 0;
for (const [input, label] of cases) {
  const out = sanitizeToolArgs(input);
  let ok = 'parses';
  try {
    JSON.parse(out);
  } catch {
    ok = 'STILL BROKEN';
    failures++;
  }
  console.log(`[${label}] → ${ok}: ${JSON.stringify(out).slice(0, 110)}`);
}
console.log(failures === 0 ? '\nALL REPAIRS OK' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
