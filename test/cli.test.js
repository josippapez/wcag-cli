import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/wcag.js', import.meta.url));
const run = (args) =>
  execFileSync('node', [BIN, ...args], { encoding: 'utf8' });
const runFail = (args) => {
  try {
    execFileSync('node', [BIN, ...args], { encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, stderr: '' };
  } catch (e) {
    return { code: e.status, stderr: (e.stderr || '').toString() };
  }
};

test('get-criterion positional prints the criterion', () => {
  const out = run(['get-criterion', '1.1.1']);
  assert.match(out, /1\.1\.1/);
});

test('get-criteria-by-level with boolean flag', () => {
  const out = run(['get-criteria-by-level', 'AA', '--include_lower']);
  assert.match(out, /including lower levels/i);
});

test('no args lists commands', () => {
  const out = run([]);
  assert.match(out, /get-criterion/);
  assert.match(out, /search-wcag/);
});

test('command --help shows params', () => {
  const out = run(['get-criterion', '--help']);
  assert.match(out, /ref_id/);
});

test('unknown command exits 1 with stderr', () => {
  const r = runFail(['does-not-exist']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown command/i);
});

test('get-criterion with no positional exits 1 with stderr', () => {
  const r = runFail(['get-criterion']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /requires argument/i);
});

test('search-wcag with no positional exits 1 with stderr', () => {
  const r = runFail(['search-wcag']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /requires argument/i);
});
