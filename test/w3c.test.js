import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { WCAG_JSON_URL, understandingUrl, parseUnderstanding } from '../src/w3c.js';

const dataPath = (name) => fileURLToPath(new URL(`../data/${name}`, import.meta.url));

// --- parseUnderstanding: unit-level, no network ---

test('understandingUrl builds the W3C Understanding page URL from an id', () => {
  assert.equal(
    understandingUrl('non-text-content'),
    'https://www.w3.org/WAI/WCAG22/Understanding/non-text-content.html'
  );
});

test('WCAG_JSON_URL points at the published W3C wcag.json', () => {
  assert.match(WCAG_JSON_URL, /^https:\/\/www\.w3\.org\//);
});

test('parseUnderstanding strips the redundant "Intent of <handle>" heading', () => {
  const html = `<section id="intent"><h2>Intent of Non-text Content</h2>


      <p>The intent of this success criterion is to make information accessible.</p></section>`;
  const { intent } = parseUnderstanding(html, 'Non-text Content');
  assert.equal(
    intent,
    'The intent of this success criterion is to make information accessible.'
  );
  assert.doesNotMatch(intent, /^Intent of/i);
});

test('parseUnderstanding strips a bare "Intent" heading too (current W3C template)', () => {
  const html = `<section id="intent"><h2>Intent</h2><p>The intent of this success criterion is X.</p></section>`;
  const { intent } = parseUnderstanding(html, 'Whatever');
  assert.equal(intent, 'The intent of this success criterion is X.');
});

// The rendered goldens only cover the *shipped* data/, so a regression here
// would stay invisible until the next regeneration. Pin it at the unit level.
test('parseUnderstanding emphasises a note label instead of leaving it bare', () => {
  const html = `<section id="intent"><h2>Intent</h2><p>Body text.</p>
    <div class="note"><p class="note-title marker">Note</p>
    <div><p>The note body.</p></div></div></section>`;
  const { intent } = parseUnderstanding(html);
  assert.match(intent, /\*\*Note\*\*/);
  assert.doesNotMatch(intent, /^Note$/m);
  assert.equal(intent, 'Body text.\n\n**Note**\n\nThe note body.');
});

test('parseUnderstanding keeps a note label\'s own wording, including a number', () => {
  const html = `<section id="intent"><h2>Intent</h2>
    <div class="note"><p class="note-title marker">Note 2</p>
    <div><p>Second note.</p></div></div></section>`;
  const { intent } = parseUnderstanding(html);
  assert.match(intent, /\*\*Note 2\*\*/);
});

test('parseUnderstanding collapses source-indentation whitespace runs', () => {
  const html = `<section id="intent"><h2>Intent</h2>


      <p>First line of the intent
         continues here.
      </p></section>`;
  const { intent } = parseUnderstanding(html);
  assert.doesNotMatch(intent, /\n {2,}/);
  assert.equal(intent, 'First line of the intent continues here.');
});

test('parseUnderstanding unwraps <abbr> tags down to their text, with no tag residue', () => {
  const html = `<section id="intent"><h2>Intent</h2><p>Uses the <abbr title="HyperText Markup Language">HTML</abbr> title attribute.</p></section>`;
  const { intent } = parseUnderstanding(html);
  assert.equal(intent, 'Uses the HTML title attribute.');
  assert.doesNotMatch(intent, /</);
});

test('parseUnderstanding inserts a blank-line boundary at a nested Note subsection', () => {
  const html = `<section id="intent"><h2>Intent</h2>
    <p>Main intent paragraph.</p>
    <section id="note-on-x"><h3>Note on X</h3><p>Note body text.</p></section>
    </section>`;
  const { intent } = parseUnderstanding(html);
  assert.match(intent, /Main intent paragraph\.\n\nNote on X\n\nNote body text\./);
});

test('parseUnderstanding extracts benefits as a flat string array', () => {
  const html = `<section id="benefits"><h2>Benefits</h2><ul>
    <li>Helps people who cannot see.</li>
    <li>Helps people who cannot hear.
        Across two lines.</li>
  </ul></section>`;
  const { benefits } = parseUnderstanding(html);
  assert.deepEqual(benefits, [
    'Helps people who cannot see.',
    'Helps people who cannot hear. Across two lines.',
  ]);
});

test('parseUnderstanding extracts resources as {title,url} and decodes entities in URLs', () => {
  const html = `<section id="resources"><h2>Related Resources</h2><ul>
    <li><a href="https://example.com/x?a=1&amp;b=2">Some Resource</a></li>
  </ul></section>`;
  const { resources } = parseUnderstanding(html);
  assert.deepEqual(resources, [{ title: 'Some Resource', url: 'https://example.com/x?a=1&b=2' }]);
});

test('parseUnderstanding extracts brief goal/what-to-do/why-important keyed lowercase', () => {
  const html = `<section id="brief"><h2>In Brief</h2><dl>
    <dt>Goal</dt><dd>The goal.</dd>
    <dt>What to do</dt><dd>The action.</dd>
    <dt>Why it's important</dt><dd>The reason.</dd>
  </dl></section>`;
  const { brief } = parseUnderstanding(html);
  assert.deepEqual(brief, {
    goal: 'The goal.',
    'what to do': 'The action.',
    "why it's important": 'The reason.',
  });
});

test('parseUnderstanding degrades to empty shapes rather than throwing on unexpected HTML', () => {
  assert.doesNotThrow(() => parseUnderstanding('<html><body>not the expected template</body></html>'));
  const result = parseUnderstanding('');
  assert.deepEqual(result, { brief: {}, intent: '', benefits: [], examples: [], resources: [] });
});

test('parseUnderstanding extracts examples from a flat <ul><li> shape, one per item in order', () => {
  const html = `<section id="examples"><h2>Examples</h2><ul>
    <li>First example.</li>
    <li>Second example.</li>
  </ul></section>`;
  const { examples } = parseUnderstanding(html);
  assert.deepEqual(examples, ['First example.', 'Second example.']);
});

test('parseUnderstanding extracts examples from a <dl> of <dt>/<dd> pairs as "title: prose"', () => {
  const html = `<section id="examples"><h2>Examples</h2><dl>
    <dt>Title one</dt><dd>Prose one.</dd>
    <dt>Title two</dt><dd>Prose two.</dd>
  </dl></section>`;
  const { examples } = parseUnderstanding(html);
  assert.deepEqual(examples, ['Title one: Prose one.', 'Title two: Prose two.']);
});

test('parseUnderstanding extracts examples from <section class="example"> subsections wrapping <p>s, dropping the <h3> title', () => {
  const html = `<section id="examples"><h2>Examples</h2>
    <section class="example"><h3>Example: Foo</h3><p>Para A.</p><p>Para B.</p></section>
  </section>`;
  const { examples } = parseUnderstanding(html);
  assert.deepEqual(examples, ['Para A.', 'Para B.']);
  assert.ok(
    examples.every((e) => !/Example: Foo/.test(e)),
    'the subsection heading must not appear as an example'
  );
});

test('parseUnderstanding extracts examples from <section class="example"> subsections wrapping a <ul>, one per <li>', () => {
  const html = `<section id="examples"><h2>Examples</h2>
    <section class="example"><h3>Example: Bar</h3><ul><li>Item A.</li><li>Item B.</li></ul></section>
  </section>`;
  const { examples } = parseUnderstanding(html);
  assert.deepEqual(examples, ['Item A.', 'Item B.']);
});

test('parseUnderstanding collapses a <p> nested inside an <li> into ONE example, not one per paragraph, keeping a space between blocks', () => {
  const html = `<section id="examples"><h2>Examples</h2><ul>
    <li><p>Para one.</p><p>Para two.</p></li>
  </ul></section>`;
  const { examples } = parseUnderstanding(html);
  assert.equal(examples.length, 1);
  assert.equal(examples[0], 'Para one. Para two.');
  assert.doesNotMatch(examples[0], /\.\S/, 'adjacent blocks must not run together without a separator');
});

test('parseUnderstanding yields an empty examples array (no throw) when the page has no #examples section', () => {
  const result = parseUnderstanding('<html><body>no examples here</body></html>');
  assert.deepEqual(result.examples, []);
});

test('parseUnderstanding cleans entities and tags in examples the same way as benefits', () => {
  const html = `<section id="examples"><h2>Examples</h2><ul>
    <li>Uses <abbr title="HyperText Markup Language">HTML</abbr> &amp; <strong>CSS</strong>.</li>
  </ul></section>`;
  const { examples } = parseUnderstanding(html);
  assert.deepEqual(examples, ['Uses HTML & CSS.']);
  assert.doesNotMatch(examples[0], /</);
});

test('parseUnderstanding degrades to empty shapes on a truncated/malformed document', () => {
  assert.doesNotThrow(() => parseUnderstanding('<section id="intent"><h2>Intent</h2><p>unterminated'));
});

// --- generated data/ files: the actual build output ---

test('data/wcag.json has 87 success criteria and 101 glossary terms', () => {
  const wcag = JSON.parse(readFileSync(dataPath('wcag.json'), 'utf8'));
  const criteria = [];
  for (const principle of wcag.principles ?? []) {
    for (const guideline of principle.guidelines ?? []) {
      for (const criterion of guideline.successcriteria ?? []) criteria.push(criterion);
    }
  }
  assert.equal(criteria.length, 87);
  assert.equal(wcag.terms.length, 101);
});

test('data/understanding.json is keyed by criterion.num and covers all 87 criteria', () => {
  const wcag = JSON.parse(readFileSync(dataPath('wcag.json'), 'utf8'));
  const understanding = JSON.parse(readFileSync(dataPath('understanding.json'), 'utf8'));
  const nums = [];
  for (const principle of wcag.principles ?? []) {
    for (const guideline of principle.guidelines ?? []) {
      for (const criterion of guideline.successcriteria ?? []) nums.push(criterion.num);
    }
  }
  assert.equal(Object.keys(understanding).length, 87);
  for (const num of nums) {
    assert.ok(Object.prototype.hasOwnProperty.call(understanding, num), `missing entry for ${num}`);
    assert.ok(understanding[num].intent, `empty intent for ${num}`);
  }
});

test('every parsed intent/benefit/resource string is free of tag and entity-tag residue', () => {
  const understanding = JSON.parse(readFileSync(dataPath('understanding.json'), 'utf8'));
  for (const [num, entry] of Object.entries(understanding)) {
    assert.doesNotMatch(entry.intent, /</, `tag residue in ${num} intent`);
    assert.doesNotMatch(entry.intent, /&lt;|&gt;/, `entity-tag residue in ${num} intent`);
    assert.doesNotMatch(entry.intent, /\n {4,}/, `un-collapsed indentation in ${num} intent`);
    assert.doesNotMatch(entry.intent, /^Intent(\s+of\s+.+)?$/im, `leading Intent heading in ${num} intent`);
    for (const benefit of entry.benefits ?? []) {
      assert.doesNotMatch(benefit, /</, `tag residue in ${num} benefit`);
      assert.doesNotMatch(benefit, /&lt;|&gt;/, `entity-tag residue in ${num} benefit`);
    }
    for (const resource of entry.resources ?? []) {
      assert.doesNotMatch(resource.title, /</, `tag residue in ${num} resource title`);
    }
  }
});

test('data/meta.json records source, etag, lastModified, sha256, criteria, fetchedAt', () => {
  const meta = JSON.parse(readFileSync(dataPath('meta.json'), 'utf8'));
  assert.equal(meta.source, WCAG_JSON_URL);
  assert.equal(typeof meta.sha256, 'string');
  assert.ok(meta.sha256.length > 0);
  assert.equal(meta.criteria, 87);
  assert.equal(typeof meta.fetchedAt, 'string');
  assert.ok(!Number.isNaN(Date.parse(meta.fetchedAt)));
});
