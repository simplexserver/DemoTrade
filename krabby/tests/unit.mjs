/**
 * unit.mjs — test runner for SimpleXEngine [BOT].
 * Runs every *.test.mjs file in this directory using node:test.
 * Exits non-zero if any test fails.
 */
import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import { readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
// runner.test.mjs contains a background-worker test that spawns real Node worker threads.
// Those workers don't terminate cleanly under node:test's runner, causing the suite to hang.
// Run it separately: node --test-timeout=90000 tests/runner.test.mjs
const SKIP = new Set(['runner.test.mjs']);

const files = (await readdir(dir))
  .filter(f => f.endsWith('.test.mjs') && !SKIP.has(f))
  .sort()
  .map(f => join(dir, f));

if (files.length === 0) {
  console.log('No test files found.');
  process.exit(0);
}

console.log(`Running ${files.length} test suite(s)...\n`);

const stream = run({ files, timeout: 120_000 });
stream.compose(spec()).pipe(process.stdout);

stream.on('test:fail', () => { process.exitCode = 1; });
stream.on('error', (err) => { console.error(err); process.exitCode = 1; });
