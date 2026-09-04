// Parsers for the W3C sources beyond wcag.json and the Understanding Intent:
// the technique index and technique pages, the Understanding Key Terms and
// Test Rules sections, the TR's conformance and input-purpose sections, and
// the errata page. Snippets mirror the live markup as fetched on 2026-09-04.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  wcagUrls,
  parseUnderstanding,
  parseTechniqueIndex,
  parseTechnique,
  parseSpecExtras,
  parseErrata,
} from '../src/w3c.js';

// --- URLs are derived from the version, so a future WCAG 2.x needs no code ---

test('wcagUrls: 2.2 reproduces the URLs the CLI always used', () => {
  const u = wcagUrls('2.2');
  assert.equal(u.wcagJson, 'https://www.w3.org/WAI/WCAG22/wcag.json');
  assert.equal(u.understanding('non-text-content'), 'https://www.w3.org/WAI/WCAG22/Understanding/non-text-content.html');
  assert.equal(u.technique('html', 'H37'), 'https://www.w3.org/WAI/WCAG22/Techniques/html/H37');
  assert.equal(u.techniquesIndex, 'https://www.w3.org/WAI/WCAG22/Techniques/');
  assert.equal(u.quickref, 'https://www.w3.org/WAI/WCAG22/quickref/');
  assert.equal(u.spec, 'https://www.w3.org/TR/WCAG22/');
  assert.equal(u.errata, 'https://www.w3.org/WAI/WCAG22/errata/');
});

test('wcagUrls: another version only changes the version segment', () => {
  const u = wcagUrls('2.1');
  assert.equal(u.wcagJson, 'https://www.w3.org/WAI/WCAG21/wcag.json');
  assert.equal(u.spec, 'https://www.w3.org/TR/WCAG21/');
});

test('wcagUrls: rejects anything that is not a dotted version', () => {
  for (const bad of ['22', '2.2/../x', 'latest', '', undefined]) {
    assert.throws(() => wcagUrls(bad), /version/i, `accepted ${JSON.stringify(bad)}`);
  }
});

// --- Understanding: Key Terms and Test Rules --------------------------------

test('parseUnderstanding: keyTerms come from the Key Terms <dt id="dfn-..."> list', () => {
  const html = `
    <section id="intent"><h2>Intent</h2><p>Some intent.</p></section>
    <section id="key-terms"><h2>Key Terms</h2>
      <dl>
        <dt id="dfn-assistive-technology">assistive technology</dt><dd>hardware and/or software ...</dd>
        <dt id="dfn-css-pixel"><abbr title="Cascading Style Sheets">CSS</abbr> pixel</dt><dd>visual angle ...</dd>
      </dl>
    </section>`;
  const { keyTerms } = parseUnderstanding(html);
  assert.deepEqual(keyTerms, [
    { id: 'dfn-assistive-technology', name: 'assistive technology' },
    { id: 'dfn-css-pixel', name: 'CSS pixel' },
  ]);
});

test('parseUnderstanding: testRules carry id, title, url and the proposed flag', () => {
  const html = `
    <section id="intent"><h2>Intent</h2><p>Some intent.</p></section>
    <section id="test-rules"><h2>Test Rules</h2>
      <p>The following are Test Rules ...</p>
      <ul>
        <li><a href="/WAI/standards-guidelines/act/rules/23a2a8/">Image has non-empty accessible name</a></li>
        <li><a href="/WAI/standards-guidelines/act/rules/9eb3f6/proposed/">Image filename is accessible name for image</a></li>
      </ul>
    </section>`;
  const { testRules } = parseUnderstanding(html);
  assert.deepEqual(testRules, [
    {
      id: '23a2a8',
      title: 'Image has non-empty accessible name',
      url: 'https://www.w3.org/WAI/standards-guidelines/act/rules/23a2a8/',
      proposed: false,
    },
    {
      id: '9eb3f6',
      title: 'Image filename is accessible name for image',
      url: 'https://www.w3.org/WAI/standards-guidelines/act/rules/9eb3f6/proposed/',
      proposed: true,
    },
  ]);
});

test('parseUnderstanding: pages without those sections yield empty arrays', () => {
  const { keyTerms, testRules } = parseUnderstanding('<section id="intent"><p>x</p></section>');
  assert.deepEqual(keyTerms, []);
  assert.deepEqual(testRules, []);
});

// --- Techniques index -------------------------------------------------------

test('parseTechniqueIndex: one entry per technique link, id and technology from the href', () => {
  const html = `
    <h2>HTML Techniques</h2>
    <ul>
      <li><a href="html/H37">H37: Using <code>alt</code> attributes on <code>img</code> elements</a></li>
      <li><a href="html/H39">H39: Using caption elements to associate data table captions with data tables</a></li>
    </ul>
    <h2>Common Failures</h2>
    <ul><li><a href="failures/F19">F19: Failure of Conformance Requirement 1 due to not providing a method for the user to find the alternate conforming version</a></li></ul>
    <h2>Change Log</h2>
    <ul><li><a href="https://github.com/w3c/wcag/commits">commits</a></li></ul>`;
  assert.deepEqual(parseTechniqueIndex(html), [
    { id: 'H37', technology: 'html', title: 'Using alt attributes on img elements' },
    { id: 'H39', technology: 'html', title: 'Using caption elements to associate data table captions with data tables' },
    {
      id: 'F19',
      technology: 'failures',
      title: 'Failure of Conformance Requirement 1 due to not providing a method for the user to find the alternate conforming version',
    },
  ]);
});

// --- Technique page ---------------------------------------------------------

const TECHNIQUE_HTML = `
<h1><span>Technique H37:</span>Using <code>alt</code> attributes on <code>img</code> elements</h1>
<section id="technique" class="box">
  <h2 class="box-h box-h-icon">About this Technique</h2>
  <div class="box-i">
    <p> This technique relates to <a href="https://www.w3.org/WAI/WCAG22/Understanding/non-text-content">1.1.1 Non-text Content</a> (<strong>Sufficient</strong>).</p>
    <p>This technique applies to images used within <abbr title="HyperText Markup Language">HTML</abbr> documents.</p>
  </div>
</section>
<section id="description">
  <h2>Description</h2>
  <p>When using the <code>img</code> element, specify a short text alternative with the <code>alt</code> attribute.</p>
  <p>Second paragraph.</p>
</section>
<section id="examples">
  <h2>Examples</h2>
  <section class="example" id="example-1"><h3>Example 1</h3>
    <p>An image provides a link to a free newsletter.</p>
    <pre><code class="language-html hljs"><span class="hljs-tag">&lt;<span class="hljs-name">img</span> <span class="hljs-attr">src</span>=<span class="hljs-string">"newsletter.gif"</span>
  <span class="hljs-attr">alt</span>=<span class="hljs-string">"Free newsletter."</span>&gt;</span></code></pre>
  </section>
  <section class="example" id="example-2"><h3>Example 2: A floor plan</h3>
    <p>An image depicts the floor plan of a building.</p>
  </section>
</section>
<section id="tests">
  <h2>Tests</h2>
  <section class="procedure" id="procedure">
    <h3>Procedure</h3>
    <ol>
      <li>Examine each <code>img</code> element in the content.</li>
      <li>Check that each <code>img</code> element which conveys meaning contains an <code>alt</code> attribute.</li>
    </ol>
  </section>
  <section class="results" id="expected-results">
    <h3>Expected Results</h3>
    <p>Checks #2 and #3 are true.</p>
  </section>
</section>
<section id="related">
  <h2>Related Techniques</h2>
  <ul>
    <li><a href="../general/G82">G82: Providing a text alternative that identifies the purpose of interactive non-text content</a></li>
    <li><a href="../html/H2">H2: Combining adjacent image and text links for the same resource</a></li>
  </ul>
</section>
<section id="resources">
  <h2>Related Resources</h2>
  <p><em><small>No endorsement implied.</small></em></p>
  <ul>
    <li><a href="https://html.spec.whatwg.org/multipage/embedded-content.html#the-img-element">HTML - <code>img</code> element</a>.</li>
  </ul>
</section>`;

test('parseTechnique: applicability, description paragraphs, related ids and resources', () => {
  const t = parseTechnique(TECHNIQUE_HTML);
  assert.equal(t.applicability, 'This technique applies to images used within HTML documents.');
  assert.deepEqual(t.description, [
    'When using the img element, specify a short text alternative with the alt attribute.',
    'Second paragraph.',
  ]);
  assert.deepEqual(t.related, ['G82', 'H2']);
  assert.deepEqual(t.resources, [
    { title: 'HTML - img element', url: 'https://html.spec.whatwg.org/multipage/embedded-content.html#the-img-element' },
  ]);
});

test('parseTechnique: examples keep their heading and render code blocks verbatim with line breaks', () => {
  const { examples } = parseTechnique(TECHNIQUE_HTML);
  assert.equal(examples.length, 2);
  assert.equal(examples[0].title, 'Example 1');
  assert.deepEqual(examples[0].blocks, [
    'An image provides a link to a free newsletter.',
    { code: '<img src="newsletter.gif"\n  alt="Free newsletter.">', lang: 'html' },
  ]);
  assert.equal(examples[1].title, 'Example 2: A floor plan');
  assert.deepEqual(examples[1].blocks, ['An image depicts the floor plan of a building.']);
});

test('parseTechnique: tests split into procedure steps and expected results', () => {
  const { tests } = parseTechnique(TECHNIQUE_HTML);
  assert.deepEqual(tests.procedure, [
    'Examine each img element in the content.',
    'Check that each img element which conveys meaning contains an alt attribute.',
  ]);
  assert.deepEqual(tests.expectedResults, ['Checks #2 and #3 are true.']);
});

test('parseTechnique: a page with none of the sections degrades to empty shapes', () => {
  const t = parseTechnique('<h1>nothing</h1>');
  assert.deepEqual(t, {
    applicability: '',
    description: [],
    examples: [],
    tests: { procedure: [], expectedResults: [] },
    related: [],
    resources: [],
  });
});

// --- TR: conformance requirements and input purposes ------------------------

const SPEC_HTML = `
<section id="conformance-reqs">
  <div class="header-wrapper"><h3 id="x5-2"><bdi class="secno">5.2 </bdi>Conformance Requirements</h3></div>
  <p>In order for a web page to conform to WCAG 2.2, all of the following conformance requirements must be satisfied:</p>
  <section id="cc1"><div class="header-wrapper"><h4><bdi class="secno">5.2.1 </bdi>Conformance Level</h4></div>
    <p>One of the following levels of conformance is met in full.</p>
    <ul>
      <li id="cc1_A">For Level A conformance (the minimum level of conformance), the <a href="#dfn-web-page-s">web page</a> satisfies all the Level A success criteria.</li>
      <li id="cc1_AA">For Level AA conformance, the web page satisfies all the Level A and Level AA success criteria.</li>
    </ul>
    <div class="note" role="note"><div role="heading" class="note-title marker"><span>Note 1</span></div><p class="">Authors are encouraged to report progress.</p></div>
  </section>
  <section id="cc2"><div class="header-wrapper"><h4><bdi class="secno">5.2.2 </bdi>Full pages</h4></div>
    <p>Conformance (and conformance level) is for full web page(s) only.</p>
  </section>
</section>
<section id="input-purposes">
  <div class="header-wrapper"><h2><bdi class="secno">7. </bdi>Input Purposes for User Interface Components</h2></div>
  <p>This section contains a listing of common user interface component input purposes.</p>
  <ul>
    <li><code class="language-html">name</code> - Full name</li>
    <li><code class="language-html">honorific-prefix</code> - Prefix or title (e.g., "Mr.", "Ms.", "Dr.", "M<sup>lle</sup>")</li>
    <li><code class="language-html">given-name</code> - Given name (in some Western cultures, also known as the <i>first name</i>)</li>
  </ul>
</section>
<section id="changelog"><ul><li>2023-06-05: Added privacy and security sections within conformance.</li></ul></section>`;

test('parseSpecExtras: one conformance requirement per cc section, with number, title and blocks', () => {
  const { conformanceRequirements } = parseSpecExtras(SPEC_HTML);
  assert.equal(conformanceRequirements.length, 2);
  assert.deepEqual(conformanceRequirements[0], {
    id: 'cc1',
    num: '5.2.1',
    title: 'Conformance Level',
    blocks: [
      'One of the following levels of conformance is met in full.',
      'For Level A conformance (the minimum level of conformance), the web page satisfies all the Level A success criteria.',
      'For Level AA conformance, the web page satisfies all the Level A and Level AA success criteria.',
      '**Note 1**',
      'Authors are encouraged to report progress.',
    ],
  });
  assert.equal(conformanceRequirements[1].num, '5.2.2');
  assert.equal(conformanceRequirements[1].title, 'Full pages');
});

test('parseSpecExtras: input purposes are token/description pairs, only from that section', () => {
  const { inputPurposes } = parseSpecExtras(SPEC_HTML);
  assert.deepEqual(inputPurposes, [
    { token: 'name', description: 'Full name' },
    { token: 'honorific-prefix', description: 'Prefix or title (e.g., "Mr.", "Ms.", "Dr.", "Mlle")' },
    { token: 'given-name', description: 'Given name (in some Western cultures, also known as the first name)' },
  ]);
});

// --- Errata -----------------------------------------------------------------

const ERRATA_HTML = `
<nav><ul><li><a href="#since-2023-10-05">Errata since 05 October 2023 Publication</a></li></ul></nav>
<h2>Errata since <a href="https://www.w3.org/TR/WCAG22/">Current Publication</a></h2>
<h3>Editorial Errata</h3>
<ul>
  <li> 2026-08-17: In the definition for <a href="https://www.w3.org/TR/WCAG22/#dfn-single-pointer">single pointer</a>, changing "touch screen" to "touchscreen" for consistency (<a href="https://github.com/w3c/wcag/pull/5038" aria-label="pull request 5038">#5038</a>) </li>
  <li> 2025-10-28: Changing occurrences of "e-mail" to "email" (<a href="https://github.com/w3c/wcag/pull/4385">#4385</a>) </li>
</ul>
<h2>Errata since <a href="https://www.w3.org/TR/2023/REC-WCAG22-20231005/">05 October 2023 Publication</a></h2>
<h3>Editorial Errata</h3>
<ul>
  <li> 2024-11-22: Modifying visual presentation for content identified as New (<a href="https://github.com/w3c/wcag/pull/1481">#1481</a>, <a href="https://github.com/w3c/wcag/pull/4145">#4145</a>) </li>
</ul>`;

test('parseErrata: each dated item carries its date, text, PR links and the publication it amends', () => {
  const errata = parseErrata(ERRATA_HTML);
  assert.equal(errata.length, 3);
  assert.deepEqual(errata[0], {
    date: '2026-08-17',
    kind: 'Editorial Errata',
    since: 'Current Publication',
    text: 'In the definition for single pointer, changing "touch screen" to "touchscreen" for consistency',
    changes: ['https://github.com/w3c/wcag/pull/5038'],
  });
  assert.equal(errata[1].date, '2025-10-28');
  assert.deepEqual(errata[2], {
    date: '2024-11-22',
    kind: 'Editorial Errata',
    since: '05 October 2023 Publication',
    text: 'Modifying visual presentation for content identified as New',
    changes: ['https://github.com/w3c/wcag/pull/1481', 'https://github.com/w3c/wcag/pull/4145'],
  });
});

test('parseErrata: the table-of-contents links are not errata', () => {
  assert.deepEqual(parseErrata('<nav><ul><li><a href="#x">Errata since X</a></li></ul></nav>'), []);
});
