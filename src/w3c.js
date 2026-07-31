// W3C source URLs and the HTML extraction for the "Understanding" pages.
//
// Zero runtime dependencies by design: a single stable W3C template, 87
// known non-adversarial pages, build-time-only execution. See
// .orchestration/own-wcag-data/issues/01-w3c-source-and-data-build.md for
// the accepted decision against pulling in an HTML-parsing dependency.

export const WCAG_JSON_URL = 'https://www.w3.org/WAI/WCAG22/wcag.json';

export function understandingUrl(id) {
  return `https://www.w3.org/WAI/WCAG22/Understanding/${id}.html`;
}

// A small fixed table for the named entities that show up in W3C prose.
// Anything not in the table (and not a numeric reference) is left as-is
// rather than thrown on — the source is body text, not markup, so an
// unrecognised entity is not a parse failure.
const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  copy: '©',
  reg: '®',
  trade: '™',
};

function decodeEntities(str) {
  return str
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => (name in NAMED_ENTITIES ? NAMED_ENTITIES[name] : m));
}

// Unwrap <abbr title="...">TEXT</abbr> down to TEXT. Done as its own pass,
// before the generic tag stripper, so the abbreviated text itself survives
// rather than being deleted along with the tag.
function unwrapAbbr(html) {
  return html.replace(/<abbr\b[^>]*>([\s\S]*?)<\/abbr>/gi, '$1');
}

// The one shared, single-pass tag stripper. Deliberately generic (matches
// any `<...>`) rather than a set of per-tag replace() calls: a set of
// per-tag rules compounds badly on nested or malformed markup, one greedy
// bracket-match does not.
function stripTags(html) {
  return html.replace(/<[^>]+>/g, '');
}

function collapseSpace(str) {
  return str.replace(/\s+/g, ' ').trim();
}

// Cleans a single fragment (a list item, a <dt>/<dd> value, a link title)
// down to plain, single-line text. Tags are stripped both before AND after
// entity decoding: a handful of Understanding pages show inline code
// examples as HTML-escaped text (e.g. "&lt;input type=\"tel\"&gt;"), which
// decoding reconstitutes into literal angle brackets that read exactly like
// markup once flattened into prose. The second pass removes that residue
// too, so no `<...>` survives in the bundled strings.
function stringify(html) {
  return collapseSpace(stripTags(decodeEntities(stripTags(unwrapAbbr(html)))));
}

// Cleans a multi-paragraph section into an array of paragraph-level blocks.
// Block boundaries (`</p>`, `</li>`, `</dt>`, `</dd>`, and any `<h2>`/`<h3>`
// heading) are marked with a NUL sentinel before the generic tag strip runs,
// so a nested "Note on ..." subsection becomes its own block instead of
// being glued onto the preceding sentence once everything is flattened.
function stringifyBlocks(html) {
  const marked = unwrapAbbr(html)
    // W3C marks a note's label with `<p class="note-title marker">Note</p>`
    // (sometimes `Note 1`). Flattened, that leaves the bare word on its own
    // line with nothing to identify it as a label, so emphasise it in place.
    .replace(
      /<p\b[^>]*class="[^"]*note-title[^"]*"[^>]*>([\s\S]*?)<\/p>/gi,
      (_, label) => `<p>**${collapseSpace(stripTags(label))}**</p>`
    )
    .replace(/<h[23]\b[^>]*>/gi, '\0')
    .replace(/<\/(p|li|dt|dd|h2|h3)>/gi, '$&\0');
  const blocks = stripTags(decodeEntities(stripTags(marked))).split('\0');
  return blocks.map(collapseSpace).filter(Boolean);
}

// Extracts the raw inner HTML of `<section id="ID">...</section>`, tracking
// nesting depth so a section that itself contains nested `<section>` blocks
// (the Understanding "Note on ..." asides) is not truncated at the first
// closing tag. Returns null if the section is absent — callers degrade to
// an empty result rather than throwing.
function extractSection(html, id) {
  const startRe = new RegExp(`<section\\b[^>]*\\bid=["']${id}["'][^>]*>`, 'i');
  const m = startRe.exec(html);
  if (!m) return null;

  let depth = 1;
  let pos = m.index + m[0].length;
  const start = pos;
  while (depth > 0) {
    const nextOpen = html.indexOf('<section', pos);
    const nextClose = html.indexOf('</section>', pos);
    if (nextClose === -1) return null; // malformed/truncated document
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth += 1;
      pos = nextOpen + '<section'.length;
    } else {
      depth -= 1;
      pos = nextClose + '</section>'.length;
    }
  }
  return html.slice(start, pos - '</section>'.length);
}

// The Understanding "Intent" section opens with an `<h2>` that is either
// just "Intent" (current template) or, in the older template the bundled
// data was generated against, "Intent of <handle>" — measured 76 of 87
// times. Either way it is a heading, not prose, so drop it as the first
// block rather than requiring an exact handle match.
function extractIntent(sectionHtml) {
  const blocks = stringifyBlocks(sectionHtml);
  if (blocks.length && /^Intent(\s+of\s+.+)?$/i.test(blocks[0])) blocks.shift();
  return blocks.join('\n\n');
}

function extractBrief(sectionHtml) {
  const brief = {};
  const dtRe = /<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi;
  let m;
  while ((m = dtRe.exec(sectionHtml))) {
    const key = stringify(m[1]).toLowerCase();
    const value = stringify(m[2]);
    if (key) brief[key] = value;
  }
  return brief;
}

// Top-level <li> items only (non-nested lists in Benefits are flat in the
// W3C template, so a single non-greedy regex is sufficient).
function extractListItems(sectionHtml) {
  const items = [];
  const liRe = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = liRe.exec(sectionHtml))) {
    const text = stringify(m[1]);
    if (text) items.push(text);
  }
  return items;
}

// Block-level tags that occur inside the Examples sections, censused across all
// 87 pages rather than guessed (`blockquote` was in an earlier draft of this list
// and appears zero times, so it is not here). Deliberately NOT shared with
// `stringifyBlocks` above: that list drives paragraph splitting for Intent and
// is intentionally narrower, and widening it would rewrite already-shipped
// `intent`/`brief` strings.
const EXAMPLE_BLOCK_TAG_RE = /<\/?(?:p|div|dl|dd|dt|ul|ol|li|figure|figcaption|pre|br)\b[^>]*>/gi;

// The Examples section takes one of three shapes across the 87 pages: a flat
// `<ul>` of items (2.5.8), a `<dl>` of "<dt>title</dt><dd>prose</dd>" pairs
// (1.1.1), or `<section class="example">` subsections that themselves wrap
// either a `<ul>` or bare paragraphs (2.1.4, 4.1.3). One alternation scanned
// in document order covers all three: whichever pattern opens first consumes
// its whole span, so a `<p>` nested inside an `<li>` or a `<dd>` is not also
// emitted as an example of its own. Headings are dropped first so a
// subsection title never surfaces as an example body.
function extractExamples(sectionHtml) {
  const body = sectionHtml
    .replace(/<h[1-6]\b[^>]*>[\s\S]*?<\/h[1-6]>/gi, '')
    // An example unit can wrap several block children (a `<li>` holding four
    // `<p>`s in 1.2.2). `stringify` deletes tags without substituting anything,
    // so two adjacent blocks would run together into "...knot.The captions...".
    // Today's pages happen to carry newlines between those blocks that collapse
    // into the needed space by luck; inserting one explicitly makes it not luck.
    // Both sides of the tag, so prose butted against an *opening* block tag
    // (`<dd>Intro:<ul>...`) is covered too and not just a closing one. A no-op on
    // the current pages -- the added space collapses with the whitespace already
    // there, so no bundled string changes. The `\s*` between the <dt>/<dd> pair
    // below absorbs a space inserted before the <dd>.
    .replace(EXAMPLE_BLOCK_TAG_RE, ' $&');
  const examples = [];
  // Constructed per call rather than hoisted to module scope: a /g regex
  // carries mutable lastIndex, and a shared one would desynchronise if a
  // caller ever bailed out of the loop early.
  const re =
    /<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>|<li\b[^>]*>([\s\S]*?)<\/li>|<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = re.exec(body))) {
    let text;
    if (m[1] !== undefined) {
      // definition-list shape: the <dt> is the example's title, the <dd> its prose
      const title = stringify(m[1]);
      const desc = stringify(m[2]);
      text = title && desc ? `${title}: ${desc}` : title || desc;
    } else {
      text = stringify(m[3] ?? m[4]);
    }
    if (text) examples.push(text);
  }
  return examples;
}

function extractResources(sectionHtml) {
  const resources = [];
  const liRe = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
  let li;
  while ((li = liRe.exec(sectionHtml))) {
    const aMatch = /<a\s+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i.exec(li[1]);
    if (!aMatch) continue;
    // href attribute values are HTML-attribute-encoded (a query string's
    // `&` shows up as `&amp;`); decode, but don't tag-strip — a URL can't
    // contain a "<...>" tag, so there is nothing else to clean here.
    const url = decodeEntities(aMatch[1]);
    const title = stringify(aMatch[2]);
    if (title && url) resources.push({ title, url });
  }
  return resources;
}

// Parses one Understanding page into { brief, intent, benefits, examples, resources }.
// Must never throw on unexpected HTML: each section is independently
// optional and degrades to its empty shape ({} / '' / [] / [] / []) so the
// caller's own fail-loud check (no Intent parsed) is what decides whether
// the build should abort, not an exception from here.
export function parseUnderstanding(html, handle) {
  void handle; // kept for contract parity with fetch-data.mjs; heading strip is template-based, not handle-keyed

  let brief = {};
  const briefHtml = extractSection(html, 'brief');
  if (briefHtml) brief = extractBrief(briefHtml);

  let intent = '';
  const intentHtml = extractSection(html, 'intent');
  if (intentHtml) intent = extractIntent(intentHtml);

  let benefits = [];
  const benefitsHtml = extractSection(html, 'benefits');
  if (benefitsHtml) benefits = extractListItems(benefitsHtml);

  let examples = [];
  const examplesHtml = extractSection(html, 'examples');
  if (examplesHtml) examples = extractExamples(examplesHtml);

  let resources = [];
  const resourcesHtml = extractSection(html, 'resources');
  if (resourcesHtml) resources = extractResources(resourcesHtml);

  return { brief, intent, benefits, examples, resources };
}
