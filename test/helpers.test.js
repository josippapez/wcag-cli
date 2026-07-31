import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  configureDataset,
  dataset,
  getPrinciples,
  getTerms,
  getMeta,
  getUnderstanding,
  getUnderstandingLocal,
  stem,
  tokenise,
  scoreFields,
  rankBy,
  getAllTechniques,
  findSuccessCriterion,
  findPrinciple,
  stripHtml,
  htmlToText,
  levelValue,
  levelTag,
  isRemoved,
  REMOVED_LEVEL_LABEL,
  relatedTerms,
  walkTechniques,
  techniqueNames,
} from '../src/helpers.js';

// --- fixtures -------------------------------------------------------------

// Every dataset-touching test reads the bundled `data/` floor with zero
// network: `cacheDir: null` makes src/data.js skip the XDG cache entirely
// (no real user cache is read or written) and `noNetwork` closes the refresh
// path, so these tests are deterministic regardless of wall-clock date, TTL
// state, or what happens to be in ~/.cache/wcag-cli.
function useBundledDataset() {
  configureDataset({ noNetwork: true, cacheDir: null });
}

// The `contrast ratio` definition, verbatim from W3C's wcag.json: one <p>, a
// <ul> of two <li>, and a <div class="note"> whose "Note N" label lives in a
// SIBLING element ahead of the note body. That sibling is what the naive
// single-line strip ran into the preceding sentence.
const CONTRAST_RATIO_DEFINITION =
  '<p>(L1 + 0.05) / (L2 + 0.05), where</p>\n   \n   <ul>\n      \n      <li>L1 is the <a href="https://www.w3.org/TR/WCAG22/#dfn-relative-luminance" title="x">relative luminance</a> of the lighter of the colors, and\n      </li>\n      \n      <li>L2 is the <a href="https://www.w3.org/TR/WCAG22/#dfn-relative-luminance" title="x">relative luminance</a> of the darker of the colors.\n      </li>\n      \n   </ul>\n   \n   <div class="note" role="note" id="issue-container-generatedID-91"><div class="note-title marker" id="h-note-91"><span>Note 1</span></div><p class="">Contrast ratios can range from 1 to 21 (commonly written 1:1 to 21:1).</p></div>\n   \n   <div class="note" role="note" id="issue-container-generatedID-92"><div class="note-title marker" id="h-note-92"><span>Note 2</span></div><p class="">Because authors do not have control over user settings.</p></div>';

// The `abbreviation` shape: a list item whose body is wrapped in its own <p>,
// which naively yields a bullet marker and its text as two separate blocks.
const LI_WRAPPED_P =
  '<p>shortened form of a word</p>\n   <ol>\n      <li>\n         <p><strong>initialisms</strong> are shortened forms</p>\n      </li>\n      <li>\n         <p>acronyms are words</p>\n      </li>\n   </ol>';

// --- htmlToText: note-block separation (the reported defect) ---------------

test('htmlToText rejoins a note label with the note body it labels', () => {
  const text = htmlToText(CONTRAST_RATIO_DEFINITION);

  assert.match(text, /^Note 1: Contrast ratios can range from 1 to 21 \(commonly written 1:1 to 21:1\)\.$/m);
  assert.match(text, /^Note 2: Because authors do not have control over user settings\.$/m);
});

test('htmlToText does not run a note label into the preceding block (regression: "21:1). Note 2Because")', () => {
  // The exact symptom: sentence-end, then a bare "Note N" label, then the
  // note body, all on one line with no separator.
  const RUN_TOGETHER = /21:1\)\.\s*Note 2Because/;

  // Guard that the fixture really does reproduce the bug under the naive
  // renderer, so this test can never silently pass because the fixture drifted.
  assert.match(stripHtml(CONTRAST_RATIO_DEFINITION), RUN_TOGETHER);

  const text = htmlToText(CONTRAST_RATIO_DEFINITION);
  assert.doesNotMatch(text, RUN_TOGETHER);
  // No "Note N" label anywhere is followed by anything other than ": ".
  assert.doesNotMatch(text, /Note \d(?!:)\S/);
});

test('htmlToText renders <li> as "- " bullets on consecutive lines', () => {
  const text = htmlToText(CONTRAST_RATIO_DEFINITION);

  assert.match(
    text,
    /^- L1 is the relative luminance of the lighter of the colors, and\n- L2 is the relative luminance of the darker of the colors\.$/m
  );
});

test('htmlToText does not emit a bare "-" for <li><p>text</p></li>', () => {
  const lines = htmlToText(LI_WRAPPED_P).split('\n');

  assert.deepEqual(lines.filter((line) => line.trim() === '-'), []);
  assert.match(htmlToText(LI_WRAPPED_P), /^- initialisms are shortened forms\n- acronyms are words$/m);
});

test('htmlToText decodes entities without double-decoding &amp;', () => {
  assert.equal(htmlToText('<p>&lt;div&gt; &amp; &quot;q&quot;</p>'), '<div> & "q"');
  // "&amp;lt;" is a literal, escaped "&lt;" in the source: it must decode
  // exactly one level, to "&lt;", never all the way to "<".
  assert.equal(htmlToText('<p>&amp;lt;</p>'), '&lt;');
  assert.equal(htmlToText('<p>a&nbsp;b</p>'), 'a b');
});

test('htmlToText returns "" for empty, undefined and non-string input', () => {
  assert.equal(htmlToText(''), '');
  assert.equal(htmlToText(undefined), '');
  assert.equal(htmlToText(null), '');
  assert.equal(htmlToText(42), '');
});

test('htmlToText is byte-identical to stripHtml for a single-<p> definition', () => {
  const html = '<p>shortened form of a word, phrase, or name</p>';

  assert.equal(htmlToText(html), stripHtml(html));
  assert.equal(htmlToText(html), 'shortened form of a word, phrase, or name');
});

test('every real single-<p> glossary definition renders identically under both renderers', async () => {
  useBundledDataset();
  const terms = await getTerms();

  // Terms whose definition genuinely is one run of prose: no list, note or
  // second paragraph. These are the byte-parity floor -- the block-aware
  // renderer must not churn them.
  const singleParagraph = terms.filter((t) => {
    const blocks = t.definition.match(/<(p|ul|ol|div|li|dl|table|blockquote)\b/gi) ?? [];
    return blocks.length === 1 && blocks[0].toLowerCase() === '<p';
  });

  assert.ok(singleParagraph.length > 0, 'expected at least one single-paragraph term in the dataset');
  const drifted = singleParagraph
    .filter((t) => htmlToText(t.definition) !== stripHtml(t.definition))
    .map((t) => t.name);
  assert.deepEqual(drifted, []);
});

// --- stripHtml stays the naive single-line collapser -----------------------

test('stripHtml stays a naive single-line collapser (byte-parity-critical)', () => {
  // Byte parity for list-principles / list-guidelines / technique section
  // titles depends on stripHtml NOT gaining block awareness: no newline, no
  // bullets, no note labels, blocks collapsed to a single space.
  assert.equal(stripHtml('<p>alpha</p>\n<p>beta</p>'), 'alpha beta');
  // Tags are removed, not replaced by a separator: adjacent tags really do
  // butt their text together. That is the upstream behaviour byte parity is
  // pinned to, and the reason it must not be reused for block HTML.
  assert.equal(stripHtml('<ul><li>one</li><li>two</li></ul>'), 'onetwo');
  assert.doesNotMatch(stripHtml(CONTRAST_RATIO_DEFINITION), /\n/);
  assert.doesNotMatch(stripHtml(CONTRAST_RATIO_DEFINITION), /(^|\n)- /);
  assert.equal(stripHtml(''), '');
  assert.equal(stripHtml(undefined), '');
});

// --- levels: 4.1.1 was removed in WCAG 2.2 --------------------------------

test('the removed criterion 4.1.1 never renders an empty level', async () => {
  useBundledDataset();
  const found = await findSuccessCriterion('4.1.1');

  assert.ok(found, 'expected 4.1.1 in the dataset');
  // The upstream data really does carry an empty level for it; that empty
  // string is the input the renderers used to pass straight through.
  assert.equal(found.sc.level, '');
  assert.equal(isRemoved(found.sc), true);
  assert.equal(levelValue(found.sc), 'Removed in WCAG 2.2');
  assert.equal(levelTag(found.sc), 'Removed in WCAG 2.2');
  assert.equal(REMOVED_LEVEL_LABEL, 'Removed in WCAG 2.2');
});

test('a live criterion keeps its plain level and "Level X" tag', async () => {
  useBundledDataset();
  const { sc } = await findSuccessCriterion('1.4.3');

  assert.equal(isRemoved(sc), false);
  assert.equal(levelValue(sc), 'AA');
  assert.equal(levelTag(sc), 'Level AA');
});

// --- relatedTerms ---------------------------------------------------------

test('relatedTerms resolves #dfn- anchors in first-mention order, de-duplicated', async () => {
  useBundledDataset();
  const terms = await getTerms();
  const [first, second] = terms;

  const sc = {
    content: `<p>See <a href="https://www.w3.org/TR/WCAG22/#${second.id}">b</a> then
      <a href="https://www.w3.org/TR/WCAG22/#${first.id}">a</a> then
      <a href="https://www.w3.org/TR/WCAG22/#${second.id}">b again</a>.</p>`,
  };

  const related = await relatedTerms(sc);
  assert.deepEqual(
    related.map((t) => t.id),
    [second.id, first.id]
  );
});

test('relatedTerms never returns a term that does not exist', async () => {
  useBundledDataset();
  const terms = await getTerms();
  const known = terms[0];

  const sc = {
    content: `<p><a href="#dfn-not-a-real-term">x</a> <a href="#${known.id}">y</a> <a href="#dfn-also-fake">z</a></p>`,
  };

  const related = await relatedTerms(sc);
  assert.deepEqual(
    related.map((t) => t.id),
    [known.id]
  );
});

test('relatedTerms also reads a criterion\'s details HTML, and yields real terms for 1.1.1', async () => {
  useBundledDataset();
  const terms = await getTerms();
  const byId = new Map(terms.map((t) => [t.id, t]));

  const { sc } = await findSuccessCriterion('1.1.1');
  const related = await relatedTerms(sc);

  assert.ok(related.length > 0, 'expected 1.1.1 to reference glossary terms');
  for (const term of related) assert.equal(byId.get(term.id), term);
  assert.equal(new Set(related.map((t) => t.id)).size, related.length);
  // At least one of these comes from `details`, not `content`.
  assert.ok(related.some((t) => t.id === 'dfn-captcha'), 'expected dfn-captcha via details');
});

test('relatedTerms returns [] for a criterion with no anchors', async () => {
  useBundledDataset();
  assert.deepEqual(await relatedTerms({}), []);
  assert.deepEqual(await relatedTerms({ content: '<p>plain prose</p>', details: [] }), []);
});

// --- walkTechniques / techniqueNames --------------------------------------

// All four nesting shapes W3C uses, in one tree: a flat entry, a `techniques`
// wrapper, a `groups[].techniques` wrapper, `using`, and `and`. T1 appears
// three times so de-duplication is observable.
const NESTED_TECHNIQUES = [
  { id: 'T1', title: 'flat one', technology: 'html' },
  {
    techniques: [{ id: 'T2', title: 'nested via techniques', technology: 'css' }],
    groups: [
      {
        techniques: [
          { id: 'T3', title: 'nested via groups', technology: 'aria' },
          { id: 'T1', title: 'flat one', technology: 'html' },
        ],
      },
    ],
  },
  {
    id: 'T4',
    title: 'has using',
    technology: 'html',
    using: [{ id: 'T5', title: 'nested via using', technology: 'html' }],
  },
  {
    and: [
      { id: 'T6', title: 'nested via and', technology: 'html' },
      { id: 'T1', title: 'flat one', technology: 'html' },
    ],
  },
];

test('walkTechniques visits all four nesting shapes', () => {
  const visited = [];
  walkTechniques(NESTED_TECHNIQUES, (item) => visited.push(item.id));

  assert.deepEqual(visited.sort(), ['T1', 'T1', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6']);
});

test('walkTechniques tolerates undefined and empty trees', () => {
  const visited = [];
  walkTechniques(undefined, (item) => visited.push(item.id));
  walkTechniques([], (item) => visited.push(item.id));
  walkTechniques([{ techniques: [] }, { using: [] }, { and: [] }], (item) => visited.push(item.id));

  assert.deepEqual(visited, []);
});

test('techniqueNames de-duplicates by id and keeps {id,title,technology}', () => {
  const names = techniqueNames(NESTED_TECHNIQUES);

  assert.equal(names.length, 6, 'T1 occurs three times but must be listed once');
  assert.deepEqual(new Set(names.map((t) => t.id)).size, 6);
  assert.deepEqual(names.filter((t) => t.id === 'T1'), [
    { id: 'T1', title: 'flat one', technology: 'html' },
  ]);
  for (const name of names) assert.deepEqual(Object.keys(name).sort(), ['id', 'technology', 'title']);
});

test('techniqueNames on the real dataset lists each id at most once', async () => {
  useBundledDataset();
  const { sc } = await findSuccessCriterion('1.1.1');
  const names = techniqueNames(sc.techniques.sufficient);

  assert.ok(names.length > 0);
  assert.equal(new Set(names.map((t) => t.id)).size, names.length);
});

// --- async memoisation ----------------------------------------------------

test('dataset() memoises the in-flight promise, so concurrent helpers share one snapshot', async () => {
  useBundledDataset();

  const first = dataset();
  const second = dataset();
  assert.equal(first, second, 'dataset() must return the identical promise, not a fresh load');

  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b);
  assert.equal(a, await dataset());
});

test('configureDataset resets the memo so a new snapshot can be taken', async () => {
  useBundledDataset();
  const before = await dataset();

  useBundledDataset();
  const after = await dataset();

  assert.notEqual(before, after, 'configureDataset must clear the memo');
  assert.deepEqual(before.meta, after.meta);
});

test('the loader runs exactly once even when many helpers await concurrently', async (t) => {
  // Counting the loader's own network attempt is the sensitive signal: the
  // cache is deliberately stale, so ONE loadDataset call means one conditional
  // GET. Without the promise memo each of the seven helpers below would drive
  // its own load, and the count would be 7.
  const cacheDir = mkdtempSync(join(tmpdir(), 'wcag-cli-helpers-test-'));
  t.after(() => rmSync(cacheDir, { recursive: true, force: true }));

  const now = Date.UTC(2026, 0, 15);
  const cachedBody = {
    principles: [
      {
        num: '1',
        handle: 'Perceivable',
        guidelines: [
          {
            num: '1.1',
            handle: 'Text Alternatives',
            successcriteria: [
              {
                id: 'sc-1-1-1',
                num: '1.1.1',
                level: 'A',
                content: '<p>x</p>',
                techniques: { sufficient: [{ id: 'T1', title: 'one', technology: 'html' }] },
              },
            ],
          },
        ],
      },
    ],
    terms: [{ id: 'dfn-thing', name: 'thing', definition: '<p>a thing</p>' }],
  };
  const cachedMeta = {
    source: 'https://www.w3.org/WAI/WCAG22/wcag.json',
    etag: 'W/"stale"',
    lastModified: null,
    // 30 days before `now`: past the 1-week TTL, so the loader must attempt
    // exactly one conditional GET per load.
    fetchedAt: new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString(),
  };
  writeFileSync(join(cacheDir, 'wcag.json'), JSON.stringify(cachedBody));
  writeFileSync(join(cacheDir, 'meta.json'), JSON.stringify(cachedMeta));

  let fetchCount = 0;
  const fetchImpl = async () => {
    fetchCount++;
    return { status: 304, ok: false, headers: { get: () => null }, text: async () => '' };
  };

  configureDataset({ cacheDir, now, noNetwork: false, fetchImpl });

  const [principles, terms, meta, principle, criterion, techniquesA, techniquesB] = await Promise.all([
    getPrinciples(),
    getTerms(),
    getMeta(),
    findPrinciple('1'),
    findSuccessCriterion('1.1.1'),
    getAllTechniques(),
    getAllTechniques(),
  ]);

  assert.equal(fetchCount, 1, `expected exactly one load, got ${fetchCount}`);
  assert.equal(principles[0].handle, 'Perceivable');
  assert.equal(terms[0].name, 'thing');
  assert.equal(meta.etag, 'W/"stale"');
  assert.equal(principle.num, '1');
  assert.equal(criterion.sc.num, '1.1.1');

  // One index for the whole process, built once: the identical array instance.
  assert.equal(techniquesA, techniquesB);
  assert.equal(techniquesA, await getAllTechniques());
  assert.deepEqual(techniquesA.map((tech) => tech.id), ['T1']);
  assert.equal(fetchCount, 1, 'a later getAllTechniques() must not re-load the dataset');

  // Restore the default (bundled, offline) configuration for later tests.
  useBundledDataset();
});

test('getAllTechniques builds its index once over the real dataset', async () => {
  useBundledDataset();

  const [a, b] = await Promise.all([getAllTechniques(), getAllTechniques()]);
  assert.equal(a, b, 'the technique index must be built once, not per call');
  assert.equal(a, await getAllTechniques());
  assert.ok(a.length > 100, `expected a populated technique index, got ${a.length}`);
  assert.equal(new Set(a.map((tech) => tech.id)).size, a.length, 'index must be de-duplicated by id');
});

test('getUnderstanding memoises per criterion', async () => {
  useBundledDataset();

  const first = getUnderstanding('1.4.3');
  assert.equal(getUnderstanding('1.4.3'), first, 'same criterion must reuse one promise');
  assert.notEqual(getUnderstanding('1.4.11'), first);

  const resolved = await first;
  assert.ok(resolved?.intent, 'expected bundled understanding for 1.4.3');
});

// A corpus-wide search reads all 87 Understanding entries. If those reads could
// fetch, one search would become 87 requests — so getUnderstandingLocal must
// pin noNetwork regardless of what the CLI configured, and must ignore refresh.
test('getUnderstandingLocal never fetches, even when configured to refresh', async () => {
  let calls = 0;
  const fetchImpl = () => {
    calls += 1;
    throw new Error('a bulk read must not reach the network');
  };
  configureDataset({ cacheDir: null, refresh: true, fetchImpl });
  const u = await getUnderstandingLocal('1.4.3');
  assert.equal(calls, 0);
  assert.ok(u?.intent, 'still served the bundled prose');
});

test('getUnderstandingLocal memoises per criterion', async () => {
  configureDataset({ noNetwork: true, cacheDir: null });
  const a = getUnderstandingLocal('1.4.3');
  const b = getUnderstandingLocal('1.4.3');
  assert.equal(a, b, 'same in-flight promise, so one read');
});

// --- keyword matching -------------------------------------------------------

test('stem guards on the REMAINING length, so short words survive', () => {
  // The first cut guarded on input length and produced "us" from "used" and
  // "ne" from "need"; under prefix matching a two-letter stem matches a large
  // slice of the corpus, so these are the regression cases.
  assert.equal(stem('used'), 'used');
  assert.equal(stem('need'), 'need');
  assert.equal(stem('placeholders'), 'placeholder');
  assert.equal(stem('placeholder'), 'placeholder');
  assert.equal(stem('focusing'), 'focus');
  assert.equal(stem('policies'), 'policy');
  assert.equal(stem('pages'), 'page');
});

test('tokenise keeps dotted and hyphenated terms whole', () => {
  const tokens = tokenise('See 1.4.3 and aria-live regions');
  assert.ok(tokens.has('1.4.3'), 'a criterion number must not split into 1, 4, 3');
  assert.ok(tokens.has('aria-live'));
});

test('tokenise folds spelling and compound variants', () => {
  assert.deepEqual([...tokenise('colour')], ['color']);
  assert.deepEqual([...tokenise('colours')], ['color']);
  assert.deepEqual([...tokenise('screenreader')].sort(), ['reader', 'screen']);
});

test('scoreFields is AND across terms, so word order stops mattering', () => {
  const fields = [{ label: 'Text', weight: 1, text: 'Focus order follows the keyboard sequence' }];
  assert.ok(scoreFields('keyboard focus', fields));
  assert.ok(scoreFields('focus keyboard', fields), 'reversed order must match too');
  assert.equal(scoreFields('keyboard elephant', fields), null, 'every term must appear');
});

test('scoreFields weights fields and reports which ones matched', () => {
  const strong = scoreFields('contrast', [
    { label: 'Name', weight: 5, text: 'contrast ratio' },
    { label: 'Body', weight: 1, text: 'unrelated' },
  ]);
  const weak = scoreFields('contrast', [
    { label: 'Name', weight: 5, text: 'unrelated' },
    { label: 'Body', weight: 1, text: 'mentions contrast in passing' },
  ]);
  assert.ok(strong.score > weak.score);
  assert.deepEqual(strong.labels, ['Name']);
  assert.deepEqual(weak.labels, ['Body']);
});

test('rankBy sorts by score and breaks ties on corpus order', () => {
  const items = [{ n: 'a' }, { n: 'b' }, { n: 'c' }];
  const ranked = rankBy(items, (i) => (i.n === 'c' ? { score: 9 } : { score: 1 }));
  assert.deepEqual(ranked.map((r) => r.item.n), ['c', 'a', 'b'], 'ties keep original order');
});
