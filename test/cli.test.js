import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/wcag.js', import.meta.url));
// WCAG_CLI_NO_NETWORK keeps every subprocess off the network, so these tests
// are deterministic and cannot be slowed or reshaped by a live w3.org refresh.
const ENV = { ...process.env, WCAG_CLI_NO_NETWORK: '1' };
const run = (args) =>
  execFileSync('node', [BIN, ...args], { encoding: 'utf8', env: ENV });
const runFail = (args) => {
  try {
    execFileSync('node', [BIN, ...args], { encoding: 'utf8', stdio: 'pipe', env: ENV });
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

// A boolean flag placed BEFORE the positional used to swallow it: argparse
// cannot tell `--normative 1.4.3` from `--normative` + positional, so the
// ref_id vanished and the CLI died with "requires argument(s): ref_id".
// bin/wcag.js reclaims it, so flag order must not matter.
test('boolean flag before the positional does not swallow it (--normative 1.4.3)', () => {
  const flagFirst = run(['get-criterion', '--normative', '1.4.3']);
  const flagLast = run(['get-criterion', '1.4.3', '--normative']);

  assert.equal(flagFirst, flagLast);
  assert.match(flagFirst, /^# 1\.4\.3 Contrast \(Minimum\)/);
});

test('get-criterion --normative and the get-success-criteria-detail alias agree', () => {
  const normative = run(['get-criterion', '--normative', '1.4.3']);
  const alias = run(['get-success-criteria-detail', '1.4.3']);

  assert.equal(normative, alias);
});

test('--normative drops Understanding, the full get-criterion keeps it', () => {
  const normative = run(['get-criterion', '--normative', '1.4.3']);
  const full = run(['get-criterion', '1.4.3']);

  assert.match(full, /^## Intent$/m);
  assert.match(full, /^## Benefits$/m);
  assert.doesNotMatch(normative, /^## Intent$/m);
  assert.doesNotMatch(normative, /^## Benefits$/m);
  assert.ok(full.length > normative.length);
});

test('boolean flag reclamation covers --include_lower and the global --refresh', () => {
  assert.equal(
    run(['get-criteria-by-level', '--include_lower', 'AA']),
    run(['get-criteria-by-level', 'AA', '--include_lower'])
  );
  // --refresh is a CLI-owned flag, not in any inputSchema; it must be
  // recognised as boolean too. WCAG_CLI_NO_NETWORK keeps the refresh offline.
  assert.match(run(['get-criterion', '--refresh', '1.4.3']), /^# 1\.4\.3 /);
});

test('the removed criterion 4.1.1 reports its removal instead of a blank level', () => {
  const out = run(['get-success-criteria-detail', '4.1.1']);

  assert.match(out, /^\*\*Level:\*\* Removed in WCAG 2\.2$/m);
  assert.doesNotMatch(out, /^\*\*Level:\*\* *$/m);
});

test('a valid command with a not-found argument prints a miss and exits 0', () => {
  const out = run(['get-criterion', '9.9.9']);
  assert.match(out, /No success criterion found/i);
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
