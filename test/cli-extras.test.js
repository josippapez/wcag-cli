// End-to-end coverage for the command-surface additions: --json, --wcag,
// technique bodies, test rules, conformance, input purposes, errata, and the
// version-generic whats-new.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/wcag.js', import.meta.url));
const ENV = {
  ...process.env,
  WCAG_CLI_NO_NETWORK: '1',
  XDG_CACHE_HOME: mkdtempSync(join(tmpdir(), 'wcag-cli-extras-')),
};
delete ENV.WCAG_CLI_VERSION;
const run = (args, env = ENV) => execFileSync('node', [BIN, ...args], { encoding: 'utf8', env });
const runFail = (args, env = ENV) => {
  try {
    execFileSync('node', [BIN, ...args], { encoding: 'utf8', stdio: 'pipe', env });
    return { code: 0, stderr: '' };
  } catch (e) {
    return { code: e.status, stderr: (e.stderr || '').toString() };
  }
};

// --- --json -------------------------------------------------------------------

test('--json prints the structured payload for a criterion', () => {
  const out = JSON.parse(run(['get-criterion', '1.4.3', '--json']));
  assert.equal(out.num, '1.4.3');
  assert.equal(out.handle, 'Contrast (Minimum)');
  assert.equal(out.level, 'AA');
  assert.equal(out.guideline.num, '1.4');
  assert.ok(out.understanding.intent.length > 100);
  assert.ok(Array.isArray(out.testRules));
});

test('--json position does not matter and it never mixes Markdown into the output', () => {
  const a = run(['--json', 'search-wcag', 'keyboard']);
  const b = run(['search-wcag', 'keyboard', '--json']);
  assert.equal(a, b);
  const parsed = JSON.parse(a);
  assert.equal(parsed.query, 'keyboard');
  assert.ok(parsed.results.length > 0);
  assert.ok(parsed.results.every((r) => typeof r.num === 'string' && typeof r.score === 'number'));
});

test('--json on list-techniques carries id, technology, title and criteria', () => {
  const { techniques } = JSON.parse(run(['list-techniques', '--technology', 'aria', '--json']));
  const aria1 = techniques.find((t) => t.id === 'ARIA1');
  assert.ok(aria1);
  assert.equal(aria1.technology, 'aria');
  assert.ok(aria1.criteria.length > 0);
});

// --- --wcag / WCAG_CLI_VERSION -------------------------------------------------

test('--wcag with a version that has no local data fails clearly offline', () => {
  const { code, stderr } = runFail(['--wcag', '2.1', 'get-criterion', '1.1.1']);
  assert.equal(code, 1);
  assert.match(stderr, /WCAG 2\.1/);
  assert.match(stderr, /network/);
});

test('--wcag rejects a malformed version before doing anything', () => {
  const { code, stderr } = runFail(['--wcag', '22', 'list-principles']);
  assert.equal(code, 1);
  assert.match(stderr, /version/i);
});

test('WCAG_CLI_VERSION selects the version like --wcag does, and --wcag wins', () => {
  const env = { ...ENV, WCAG_CLI_VERSION: '2.1' };
  assert.equal(runFail(['list-principles'], env).code, 1);
  assert.match(run(['--wcag', '2.2', 'list-principles'], env), /# WCAG 2\.2 Principles/);
});

test('the version shows up in get-server-info', () => {
  assert.match(run(['get-server-info']), /\*\*WCAG version:\*\* 2\.2/);
});

// --- techniques ----------------------------------------------------------------

test('get-technique renders the description, examples with code, tests and related techniques', () => {
  const out = run(['get-technique', 'H37']);
  assert.match(out, /^## Description$/m);
  assert.match(out, /^## Examples$/m);
  assert.match(out, /```html\n<img src="newsletter\.gif"/m);
  assert.match(out, /^### Procedure$/m);
  assert.match(out, /^### Expected Results$/m);
  assert.match(out, /^## Related Techniques$/m);
  assert.match(out, /\*\*G82\*\*: Providing a text alternative/);
});

test('get-technique finds a technique no criterion references', () => {
  const out = run(['get-technique', 'F19']);
  assert.match(out, /^# F19: Failure of Conformance Requirement 1/m);
  assert.match(out, /Not referenced by any success criterion/);
});

test('list-techniques counts every published technique, not just referenced ones', () => {
  assert.match(run(['list-techniques']), /^# WCAG Techniques \(43[2-9]|4[4-9]\d found\)/);
});

test('search-techniques --description searches technique bodies and says where it matched', () => {
  const plain = run(['search-techniques', 'newsletter']);
  const deep = run(['search-techniques', 'newsletter', '--description']);
  assert.match(plain, /No techniques found/);
  assert.match(deep, /\*\*H37\*\*/);
  assert.match(deep, /matched in: .*Examples/);
});

// --- test rules ----------------------------------------------------------------

test('get-test-rules-for-criterion lists the ACT rules with their W3C URLs', () => {
  const out = run(['get-test-rules-for-criterion', '1.1.1']);
  assert.match(out, /^# Test Rules for 1\.1\.1 Non-text Content/m);
  assert.match(out, /\[Image has non-empty accessible name\]\(https:\/\/www\.w3\.org\/WAI\/standards-guidelines\/act\/rules\/23a2a8\/\)/);
  assert.match(out, /\(proposed\)/);
});

test('get-test-rules-for-criterion says so when a criterion has none', () => {
  assert.match(run(['get-test-rules-for-criterion', '2.5.8']), /No test rules/i);
});

test('get-full-criterion-context and get-criterion include the Test Rules section', () => {
  assert.match(run(['get-full-criterion-context', '1.1.1']), /^## Test Rules \(\d+\)$/m);
  assert.match(run(['get-criterion', '1.1.1']), /^## Test Rules$/m);
  assert.doesNotMatch(run(['get-criterion', '1.1.1', '--normative']), /^## Test Rules$/m);
});

// --- conformance / input purposes / errata ----------------------------------------

test('get-conformance-requirements renders the five requirements from the Recommendation', () => {
  const out = run(['get-conformance-requirements']);
  assert.match(out, /^## 5\.2\.1 Conformance Level$/m);
  assert.match(out, /^## 5\.2\.5 Non-Interference$/m);
  assert.match(out, /^\*\*Note 1\*\*$/m);
});

test('list-input-purposes lists the 1.3.5 tokens and can filter them', () => {
  const all = run(['list-input-purposes']);
  assert.match(all, /^- `cc-number` /m);
  assert.match(all, /53 input purposes/);
  const filtered = run(['list-input-purposes', 'tel']);
  assert.match(filtered, /`tel`/);
  assert.doesNotMatch(filtered, /`cc-number`/);
});

test('list-errata renders dated entries with their pull requests, grouped by publication', () => {
  const out = run(['list-errata']);
  assert.match(out, /^## Errata since Current Publication$/m);
  assert.match(out, /^- \*\*2026-08-17\*\* .*touchscreen.*\(\[#5038\]\(https:\/\/github\.com\/w3c\/wcag\/pull\/5038\)\)/m);
});

// --- whats-new -----------------------------------------------------------------

test('whats-new is version generic and also reports removals; the wcag22 alias is identical', () => {
  const out = run(['whats-new']);
  assert.match(out, /^# What's New in WCAG 2\.2$/m);
  assert.match(out, /^## Removed$/m);
  assert.match(out, /4\.1\.1 Parsing/);
  assert.equal(out, run(['whats-new-in-wcag22']));
});

// --- --brief -------------------------------------------------------------------

// Examples are the one technique section that gets large (8.9 KB at most,
// about a third of a typical page); the description and the test procedure
// are what a reader asking by id nearly always wants. --brief keeps those.
test('get-technique --brief keeps description, tests and related techniques, drops examples and resources', () => {
  const full = run(['get-technique', 'H37']);
  const brief = run(['get-technique', 'H37', '--brief']);
  assert.equal(brief, run(['get-technique', '--brief', 'H37']));
  assert.match(brief, /^## Description$/m);
  assert.match(brief, /^### Procedure$/m);
  assert.match(brief, /^## Related Techniques$/m);
  assert.doesNotMatch(brief, /^## Examples$/m);
  assert.doesNotMatch(brief, /^## Resources$/m);
  assert.ok(brief.length < full.length);
  assert.deepEqual(JSON.parse(run(['get-technique', 'H37', '--brief', '--json'])).examples, []);
});

// --- get-techniques-for-criterion ----------------------------------------------

test('get-techniques-for-criterion prints every technique in the W3C tree', () => {
  const ids = (items, out = []) => {
    for (const item of items ?? []) {
      if (item.id) out.push(item.id);
      ids(item.techniques, out);
      for (const group of item.groups ?? []) ids(group.techniques, out);
      ids(item.using, out);
      ids(item.and, out);
    }
    return out;
  };
  for (const num of ['1.3.1', '2.4.4', '1.2.4']) {
    const { techniques } = JSON.parse(run(['get-techniques-for-criterion', num, '--json']));
    const text = run(['get-techniques-for-criterion', num]);
    const all = ids([...techniques.sufficient, ...techniques.advisory, ...techniques.failure]);
    const missing = all.filter((id) => !text.includes(`**${id}**`));
    assert.deepEqual(missing, [], `${num} text output is missing ${missing.join(', ')}`);
  }
});

test('criterion details carry no HTML markup, in text or --json', () => {
  for (const num of ['1.4.13', '2.4.11', '2.4.13', '3.3.8', '4.1.1', '4.1.2']) {
    assert.doesNotMatch(run(['get-criterion', num, '--normative']), /<\/?(abbr|em|cite|ul|li)\b/, num);
    assert.doesNotMatch(JSON.stringify(JSON.parse(run(['get-criterion', num, '--json'])).details), /<\/?(abbr|em|cite|ul|li)\b/, num);
  }
});

test('related success criteria are listed in numeric order', () => {
  const text = run(['get-technique', 'G174']);
  assert.ok(text.indexOf('**1.4.3**') < text.indexOf('**1.4.11**'));
});

test('an empty WCAG_CLI_VERSION falls back to the default version', () => {
  assert.match(run(['list-principles'], { ...ENV, WCAG_CLI_VERSION: '' }), /WCAG 2\.2/);
});

test('whats-new-in-wcag22 answers for 2.2 whatever --wcag says', () => {
  assert.equal(run(['--wcag', '2.1', 'whats-new-in-wcag22']), run(['whats-new-in-wcag22']));
});

test('get-server-info --json keeps one dataset shape: the technique count lives in statistics', () => {
  const out = JSON.parse(run(['get-server-info', '--json']));
  assert.equal('techniques' in out.dataset, false);
  assert.equal(out.statistics.techniques, 432);
});

// --- obsolete techniques, ACT test cases, element lookup, changes -------------

test('get-technique serves a retired technique with its obsolete notice, outside the published list', () => {
  const text = run(['get-technique', 'F70']);
  assert.match(text, /^# F70: Failure of Success Criterion 4\.1\.1/);
  assert.match(text, /> \*\*Obsolete:\*\* This failure relates to 4\.1\.1 Parsing/);
  assert.match(JSON.parse(run(['get-technique', 'f70', '--json'])).obsolete, /4\.1\.1 Parsing/);
  assert.equal(JSON.parse(run(['list-techniques', '--json'])).techniques.length, 432);
});

test('get-test-cases shows the ACT examples for a criterion, filtered by outcome', () => {
  const { rules } = JSON.parse(run(['get-test-cases', '1.1.1', '--expected', 'failed', '--json']));
  assert.ok(rules.some((r) => r.id === '23a2a8'));
  const cases = rules.flatMap((r) => r.testcases);
  assert.ok(cases.length > 0);
  assert.ok(cases.every((tc) => tc.expected === 'failed' && tc.html.includes('<')));
  assert.match(run(['get-test-cases', '1.1.1']), /### Failed Example 1\n\n```html\n<!DOCTYPE html>/i);
});

test('get-test-cases takes an ACT rule id too', () => {
  const text = run(['get-test-cases', '23a2a8']);
  assert.match(text, /^# ACT Test Cases for Image has non-empty accessible name \(23a2a8\)/);
});

test('get-techniques-for-element finds the techniques about an element and the criteria they serve', () => {
  const out = JSON.parse(run(['get-techniques-for-element', '<img>', '--json']));
  assert.deepEqual(out.about.map((t) => t.id).sort(), ['F65', 'H37', 'H67']);
  assert.deepEqual(out.criteria.map((c) => c.num), ['1.1.1']);
  assert.ok(out.usedInExamples.length > 0);
  assert.ok(JSON.parse(run(['get-techniques-for-element', 'a', '--json'])).about.some((t) => t.id === 'H30'));
});

test('list-changes lists the recorded w3.org publishes and filters by date', () => {
  const { changes } = JSON.parse(run(['list-changes', '--json']));
  const oct = changes.find((c) => c.published === '2026-10-01');
  assert.ok(oct.understanding.some((u) => u.num === '1.3.5' && u.sections.includes('intent')));
  assert.ok(oct.techniques.some((t) => t.id === 'F86'));
  assert.equal(JSON.parse(run(['list-changes', '--since', '2099-01-01', '--json'])).changes.length, 0);
  assert.equal(runFail(['list-changes', '--since', 'yesterday']).code, 1);
});

test('get-test-cases reports an approved rule as approved, with the page the Understanding docs cite', () => {
  const { rules } = JSON.parse(run(['get-test-cases', '59796f', '--json']));
  assert.equal(rules[0].status, 'approved');
  assert.equal(rules[0].url, 'https://www.w3.org/WAI/standards-guidelines/act/rules/59796f/');
});
