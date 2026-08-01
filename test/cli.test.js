import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

// The CLI is the only place WCAG_CLI_NO_NETWORK is read, so assert it end to
// end: --refresh explicitly asks for a fetch, the env var forbids one, and
// no-network wins. If bin/wcag.js stopped forwarding it, the refresh would
// reach w3.org and write a cache into this throwaway directory.
test('WCAG_CLI_NO_NETWORK=1 beats --refresh and writes no cache', () => {
  const cacheHome = mkdtempSync(join(tmpdir(), 'wcag-cli-cli-test-'));
  try {
    const out = execFileSync('node', [BIN, '--refresh', 'get-criterion', '1.4.3'], {
      encoding: 'utf8',
      env: { ...process.env, WCAG_CLI_NO_NETWORK: '1', XDG_CACHE_HOME: cacheHome },
    });
    assert.match(out, /1\.4\.3/);
    assert.equal(existsSync(join(cacheHome, 'wcag-cli')), false);
  } finally {
    rmSync(cacheHome, { recursive: true, force: true });
  }
});

// The Understanding corpus is far larger than the normative text, so a keyword
// that only appears in the prose used to be a dead end. `placeholder` is the
// real case that motivated the flag: absent from every SC title/description.
test('search-wcag --understanding reaches prose the default search cannot', () => {
  const plain = run(['search-wcag', 'placeholder']);
  assert.match(plain, /No success criteria found/);
  assert.match(plain, /--understanding/, 'the miss should point at the flag');

  const deep = run(['search-wcag', 'placeholder', '--understanding']);
  assert.match(deep, /Search Results for "placeholder"/);
  assert.match(deep, /matched in: /, 'says which section matched');
});

test('search-wcag --understanding keeps the multi-word query joined', () => {
  const out = run(['search-wcag', 'target', 'size', '--understanding']);
  assert.match(out, /Search Results for "target size"/);
});

// Every one of these returned zero results under the old substring search.
test('search-wcag matches on words, not one contiguous substring', () => {
  const forward = run(['search-wcag', 'keyboard', 'focus', '--understanding']);
  const reversed = run(['search-wcag', 'focus', 'keyboard', '--understanding']);
  const count = (out) => out.match(/\((\d+) found\)/)?.[1];
  assert.equal(count(forward), count(reversed), 'word order must not change recall');

  assert.match(run(['search-wcag', 'placeholders', '--understanding']), /found\)/);
  assert.match(run(['search-wcag', 'colour', '--understanding']), /found\)/);
  assert.match(run(['search-wcag', 'screenreader', '--understanding']), /found\)/);
});

test('search-wcag ranks a handle match above a prose mention', () => {
  const out = run(['search-wcag', 'keyboard']);
  const first = out.match(/^\*\*([0-9.]+) /m)?.[1];
  assert.equal(first, '2.1.1', 'the criterion actually named Keyboard should lead');
});

test('search-glossary is word-order independent too', () => {
  // The header echoes the query verbatim, so compare the matched terms rather
  // than the whole output.
  const terms = (out) => out.match(/^\*\*.+\*\*$/gm);
  assert.deepEqual(
    terms(run(['search-glossary', 'contrast', 'ratio'])),
    terms(run(['search-glossary', 'ratio', 'contrast']))
  );
});

// The CLI exits explicitly once its answer is flushed rather than waiting for
// the event loop to drain (an aborted refresh leaves its connection attempt
// holding the loop open long after the answer is ready). Exiting early is only
// safe if stdout is genuinely flushed first, so pin the largest output the CLI
// can produce, read through a pipe, byte for byte.
test('a large answer survives the pipe intact when the CLI exits', () => {
  const out = run(['list-techniques']);
  assert.ok(out.length > 30000, `expected a large answer, got ${out.length} bytes`);
  assert.match(out, /^# /, 'output must start at the beginning');
  assert.ok(out.endsWith('\n'), 'output must not be cut mid-write');
  assert.equal(out, run(['list-techniques']), 'and it must be the same every run');
});

// A token like `--foo` is consumed as a flag before any schema is known, so a
// user who meant it as a value used to see only "requires argument(s): term"
// and no indication of where their value went. Name the token.
test('a --value mistaken for a flag is named in the missing-argument error', () => {
  const r = runFail(['get-glossary-term', '--foo']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /requires argument\(s\): term/);
  assert.match(r.stderr, /--foo/, 'the swallowed token must be named');
  assert.match(r.stderr, /cannot begin with '--'/, 'and the cause explained');
});

test('several mistaken flags are all named', () => {
  const r = runFail(['get-glossary-term', '--foo', '--bar']);
  assert.match(r.stderr, /--foo/);
  assert.match(r.stderr, /--bar/);
});

// The hint must not appear when the flags are legitimate — a genuinely
// forgotten positional should still read as a plain missing argument.
test('a plain missing argument keeps the plain message', () => {
  const r = runFail(['get-criterion']);
  assert.match(r.stderr, /requires argument\(s\): ref_id/);
  assert.doesNotMatch(r.stderr, /read as a flag/);
});

// Single-dash values are positionals, not flags: only `--` is affected.
test('a positional beginning with a single dash is kept as a value', () => {
  const out = run(['get-glossary-term', '-foo']);
  assert.match(out, /-foo/);
  assert.doesNotMatch(out, /requires argument/);
});
