// Lookup helpers over the WCAG dataset.
//
// Ported from `wcag-guidelines-mcp`'s `src/data-helpers.js` (see README for
// attribution), with one structural change: upstream `require()`d its
// bundled wcag.json at import time and
// exported plain `principles`/`terms` arrays. Our dataset access layer
// (`src/data.js`) is async because it may consult an XDG cache and do a
// conditional GET, so every helper that touches the dataset is async here.
//
// The dataset is resolved at most ONCE per process: `dataset()` memoises the
// in-flight promise, so twenty helper calls inside one command invocation
// share a single snapshot and can never re-run TTL/network logic or observe
// two different versions of the data mid-render.
import { createRequire } from 'node:module';

import {
  loadDataset,
  loadUnderstanding,
  loadResource,
  bundledResource,
  versionCacheDir,
  CACHE_DIR,
} from './data.js';
import {
  DEFAULT_VERSION,
  wcagUrls,
  parseTechniqueIndex,
  parseTechnique,
  parseSpecExtras,
  parseErrata,
} from './w3c.js';

const require = createRequire(import.meta.url);

// ============================================================================
// DATASET ACCESS (memoised)
// ============================================================================

// Set once by bin/wcag.js before the first lookup, and passed straight through
// to the loaders: `{ refresh, noNetwork, version }`. All come from the CLI
// boundary — this layer reads no environment of its own.
let loadOptions = {};
let datasetPromise;
let techniquesPromise;
let techniqueIndexPromise;
let specPromise;
let errataPromise;
const understandingCache = new Map();
const localUnderstandingCache = new Map();
const techniqueBodyCache = new Map();
const localTechniqueBodyCache = new Map();

export function configureDataset(options = {}) {
  loadOptions = options;
  datasetPromise = undefined;
  techniquesPromise = undefined;
  techniqueIndexPromise = undefined;
  specPromise = undefined;
  errataPromise = undefined;
  understandingCache.clear();
  localUnderstandingCache.clear();
  techniqueBodyCache.clear();
  localTechniqueBodyCache.clear();
}

/** The WCAG version every lookup in this process answers for. */
export function getVersion() {
  return loadOptions.version ?? DEFAULT_VERSION;
}

/** The W3C URLs for that version. */
export function urls() {
  return wcagUrls(getVersion());
}

// Loader options with the version resolved, so every loader agrees on the
// cache directory without each caller re-deriving it. `cacheDir: null` from a
// test stays null (bundle only); an unset one follows the version.
function loaderOptions(overrides = {}) {
  const version = getVersion();
  const cacheDir = 'cacheDir' in loadOptions ? loadOptions.cacheDir : versionCacheDir(CACHE_DIR, version);
  return { ...loadOptions, version, cacheDir, ...overrides };
}

// Bulk readers (search, counts) must never fan out into hundreds of requests,
// so they use these: whatever is local -- runtime cache, then bundle.
const localOnly = { refresh: false, noNetwork: true };

// The bundle is 2.2 data, so it is only a floor for 2.2.
function bundledFloor(name) {
  return getVersion() === DEFAULT_VERSION ? bundledResource(name) : null;
}

/** Resolved `{ wcag, meta }` — one snapshot per process. */
export function dataset() {
  datasetPromise ??= loadDataset(loaderOptions());
  return datasetPromise;
}

export async function getPrinciples() {
  const { wcag } = await dataset();
  return wcag.principles ?? [];
}

export async function getTerms() {
  const { wcag } = await dataset();
  return wcag.terms ?? [];
}

export async function getMeta() {
  const { meta } = await dataset();
  return meta ?? null;
}

/**
 * `{ brief, intent, benefits, examples, resources }` for one criterion, or null.
 * Memoised per criterion so a render that asks twice pays once.
 */
export function getUnderstanding(num) {
  if (!understandingCache.has(num)) {
    understandingCache.set(num, loadUnderstandingFor(num, loaderOptions()));
  }
  return understandingCache.get(num);
}

// The Understanding page is named by the criterion's W3C id, which comes from
// the dataset actually loaded -- not the bundle -- so a `--wcag 2.1` lookup
// resolves against 2.1's own criteria.
async function loadUnderstandingFor(num, options) {
  const found = await findSuccessCriterion(num);
  return loadUnderstanding(num, { ...options, id: found?.sc.id });
}

/**
 * Same shape as `getUnderstanding`, but guaranteed local: the bundled snapshot
 * plus whatever the per-criterion cache already holds, never a fetch.
 *
 * Reading one criterion may refresh that criterion, which is fine. Sweeping all
 * 87 must not, or a single search would become 87 requests and break the
 * documented promise that no command ever pulls the whole corpus at once. So
 * bulk readers use this and accept possibly-stale prose over a fetch storm.
 */
export function getUnderstandingLocal(num) {
  if (!localUnderstandingCache.has(num)) {
    localUnderstandingCache.set(num, loadUnderstandingFor(num, loaderOptions(localOnly)));
  }
  return localUnderstandingCache.get(num);
}

/** This package's own version, read in a way that survives --omit=dev. */
export function packageVersion() {
  try {
    return require('../package.json').version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

// ============================================================================
// TEXT
// ============================================================================

/**
 * Flatten inline HTML to a single line. Used for the short, single-paragraph
 * fields (principle/guideline `content`, technique section titles) where the
 * source really is one run of prose.
 */
export function stripHtml(html) {
  return html?.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() || '';
}

// W3C ships glossary definitions as real block HTML: paragraphs, lists, and
// `<div class="note">` blocks whose title lives in its own element. Flattening
// that with stripHtml ran the blocks together and produced text like
// "...1:1 to 21:1). Note 2Because authors do not have control..." — 52 of the
// 101 terms carry at least one note block, so this was the norm, not an edge
// case. htmlToText keeps the block boundaries instead.
const BLOCK_END =
  /<\/(?:p|div|li|ul|ol|dl|dd|dt|aside|blockquote|table|tr|thead|tbody|section|figure|figcaption|pre|h[1-6])>/gi;

// A note/example block's label sits in its own element ahead of the body text,
// so it arrives as a standalone block; rejoin it to the block it labels.
const MARKER_RE = /^(?:Note|Example)(?:\s+\d+)?$/;

const ENTITIES = {
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
  '&nbsp;': ' ',
};

function decodeEntities(text) {
  let out = text;
  for (const [entity, char] of Object.entries(ENTITIES)) {
    out = out.split(entity).join(char);
  }
  // &amp; last, so "&amp;lt;" does not decode twice.
  return out.split('&amp;').join('&');
}

/** Render block-level HTML as markdown-ish plain text, preserving boundaries. */
export function htmlToText(html) {
  if (typeof html !== 'string' || html === '') return '';

  const flattened = decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, '\n\n')
      .replace(/<li[^>]*>/gi, '\n\n- ')
      .replace(BLOCK_END, '\n\n')
      .replace(/<[^>]*>/g, '')
  );

  const blocks = flattened
    .split(/\n{2,}/)
    .map((block) => block.replace(/\s+/g, ' ').trim())
    .filter((block) => block !== '');

  const out = [];
  for (let i = 0; i < blocks.length; i++) {
    let block = blocks[i];
    // `<li><p>text</p></li>` yields a bare bullet then its body; rejoin.
    if (block === '-' && blocks[i + 1] !== undefined) {
      block = `- ${blocks[++i]}`;
    } else if (MARKER_RE.test(block) && blocks[i + 1] !== undefined) {
      block = `${block}: ${blocks[++i]}`;
    }
    const prev = out[out.length - 1];
    if (block.startsWith('- ') && prev?.startsWith('- ')) {
      out[out.length - 1] = `${prev}\n${block}`;
    } else {
      out.push(block);
    }
  }
  return out.join('\n\n');
}

export function truncate(text, max) {
  return text.length > max ? `${text.substring(0, max)}...` : text;
}

// ============================================================================
// URLS
// ============================================================================

// All derived from the configured version, so `--wcag 2.1` links to 2.1 pages.
export function getScUrl(sc) {
  return `${urls().spec}#${sc.id}`;
}

export function getUnderstandingUrl(sc) {
  return urls().understanding(sc.id);
}

export function getQuickRefUrl(sc) {
  return `${urls().quickref}#${sc.id}`;
}

export function getTermUrl(term) {
  return `${urls().spec}#${term.id}`;
}

// ============================================================================
// LEVELS
// ============================================================================

// 4.1.1 Parsing carries `level: ""` in the W3C data because it was removed in
// WCAG 2.2. Rendering that raw produced an empty "**Level:** " line and a
// "**Level **: 1" count bucket; both now say so explicitly. The label follows
// the configured version so a criterion a later version drops reads correctly.
export function removedLevelLabel() {
  return `Removed in WCAG ${getVersion()}`;
}
export const REMOVED_LEVEL_LABEL = 'Removed in WCAG 2.2';

export function isRemoved(sc) {
  return !sc.level;
}

/** The value for a "**Level:**" field. */
export function levelValue(sc) {
  return isRemoved(sc) ? removedLevelLabel() : sc.level;
}

/** The parenthesised label used in list rows, e.g. "(Level AA)". */
export function levelTag(sc) {
  return isRemoved(sc) ? removedLevelLabel() : `Level ${sc.level}`;
}

// ============================================================================
// LOOKUPS
// ============================================================================

export async function findPrinciple(num) {
  const principles = await getPrinciples();
  return principles.find((p) => p.num === String(num));
}

export async function findGuideline(num) {
  for (const principle of await getPrinciples()) {
    const guideline = (principle.guidelines ?? []).find((g) => g.num === num);
    if (guideline) return { principle, guideline };
  }
  return null;
}

export async function findSuccessCriterion(num) {
  for (const principle of await getPrinciples()) {
    for (const guideline of principle.guidelines ?? []) {
      const sc = (guideline.successcriteria ?? []).find((s) => s.num === num);
      if (sc) return { principle, guideline, sc };
    }
  }
  return null;
}

export async function getAllSuccessCriteria(filters = {}) {
  const results = [];

  for (const principle of await getPrinciples()) {
    if (filters.principle && principle.num !== String(filters.principle)) continue;

    for (const guideline of principle.guidelines ?? []) {
      if (filters.guideline && guideline.num !== filters.guideline) continue;

      for (const sc of guideline.successcriteria ?? []) {
        if (filters.level && sc.level !== filters.level) continue;
        if (filters.levels && !filters.levels.includes(sc.level)) continue;
        if (filters.version && !(sc.versions ?? []).includes(filters.version)) continue;

        results.push({
          ...sc,
          principle_num: principle.num,
          principle_handle: principle.handle,
          guideline_num: guideline.num,
          guideline_handle: guideline.handle,
        });
      }
    }
  }

  return results;
}

// ============================================================================
// TECHNIQUES
// ============================================================================

/**
 * Walk one technique tree, invoking `visit` for every entry that has an id.
 * The W3C shape nests four different ways (`techniques`, `groups[].techniques`,
 * `using`, `and`), so every consumer that needs to flatten it — the unique
 * index, the counts, the name lists — goes through here rather than
 * re-implementing the walk with subtly different coverage.
 */
export function walkTechniques(items, visit) {
  if (!items) return;
  for (const item of items) {
    if (item.techniques) {
      walkTechniques(item.techniques, visit);
      for (const group of item.groups ?? []) walkTechniques(group.techniques, visit);
    }
    if (item.id && item.title) visit(item);
    if (item.using) walkTechniques(item.using, visit);
    if (item.and) walkTechniques(item.and, visit);
  }
}

export async function getAllTechniques() {
  techniquesPromise ??= (async () => {
    const techniquesMap = new Map();

    for (const principle of await getPrinciples()) {
      for (const guideline of principle.guidelines ?? []) {
        for (const sc of guideline.successcriteria ?? []) {
          if (!sc.techniques) continue;

          for (const type of ['sufficient', 'advisory', 'failure']) {
            walkTechniques(sc.techniques[type], (item) => {
              const existing = techniquesMap.get(item.id);
              if (existing) {
                existing.types.add(type);
                existing.criteria.add(sc.num);
              } else {
                techniquesMap.set(item.id, {
                  id: item.id,
                  technology: item.technology,
                  title: item.title,
                  types: new Set([type]),
                  criteria: new Set([sc.num]),
                });
              }
            });
          }
        }
      }
    }

    // The W3C index is the authority on what exists: it also lists techniques
    // no criterion references (10 of 432 on 2026-09-04), which the walk above
    // cannot see. Merge it in with empty type/criteria sets; when the index is
    // unavailable the walk alone still answers, as it always did.
    for (const entry of (await getTechniqueIndex()) ?? []) {
      if (!techniquesMap.has(entry.id)) {
        techniquesMap.set(entry.id, { ...entry, types: new Set(), criteria: new Set() });
      }
    }

    return Array.from(techniquesMap.values()).map((t) => ({
      ...t,
      types: Array.from(t.types),
      criteria: Array.from(t.criteria),
    }));
  })();
  return techniquesPromise;
}

/** `[{ id, technology, title }]` for every published technique, or null. */
export function getTechniqueIndex() {
  techniqueIndexPromise ??= loadResource('techniques-index', {
    ...loaderOptions(),
    url: urls().techniquesIndex,
    parse: parseTechniqueIndex,
    validate: (list) => list.length > 0,
    bundled: () => bundledFloor('techniques-index'),
  });
  return techniqueIndexPromise;
}

export async function findTechnique(id) {
  const all = await getAllTechniques();
  return all.find((t) => t.id.toLowerCase() === id.toLowerCase());
}

// The body of one technique page: `{ applicability, description, examples,
// tests, related, resources }`, or null. Lazy and per technique, like the
// Understanding pages: only the technique asked for is ever fetched.
function loadTechniqueBody(id, options) {
  return (async () => {
    const technique = await findTechnique(id);
    if (!technique) return null;
    return loadResource(`techniques/${technique.id}`, {
      ...options,
      url: urls().technique(technique.technology, technique.id),
      parse: parseTechnique,
      validate: (body) => body.description.length > 0 || body.examples.length > 0,
      bundled: () => bundledFloor('techniques')?.[technique.id] ?? null,
    });
  })();
}

export function getTechniqueBody(id) {
  const key = id.toUpperCase();
  if (!techniqueBodyCache.has(key)) techniqueBodyCache.set(key, loadTechniqueBody(id, loaderOptions()));
  return techniqueBodyCache.get(key);
}

/** Same shape, guaranteed local: bulk readers use this so a search over 432
 * techniques can never become 432 requests. */
export function getTechniqueBodyLocal(id) {
  const key = id.toUpperCase();
  if (!localTechniqueBodyCache.has(key)) {
    localTechniqueBodyCache.set(key, loadTechniqueBody(id, loaderOptions(localOnly)));
  }
  return localTechniqueBodyCache.get(key);
}

// ============================================================================
// THE RECOMMENDATION AND ITS ERRATA
// ============================================================================

/** `{ conformanceRequirements, inputPurposes }` from the Recommendation, or null. */
export function getSpecExtras() {
  specPromise ??= loadResource('spec', {
    ...loaderOptions(),
    url: urls().spec,
    parse: parseSpecExtras,
    validate: (spec) => spec.conformanceRequirements.length > 0,
    bundled: () => bundledFloor('spec'),
  });
  return specPromise;
}

/** The errata list, newest first as W3C publishes it, or null. */
export function getErrata() {
  errataPromise ??= loadResource('errata', {
    ...loaderOptions(),
    url: urls().errata,
    parse: parseErrata,
    validate: Array.isArray,
    bundled: () => bundledFloor('errata'),
  });
  return errataPromise;
}

/** Flat, de-duplicated `{id, title, technology}` list for one technique type. */
export function techniqueNames(items) {
  const seen = new Map();
  walkTechniques(items, (item) => {
    if (!seen.has(item.id)) {
      seen.set(item.id, { id: item.id, title: item.title, technology: item.technology });
    }
  });
  return Array.from(seen.values());
}

// ============================================================================
// GLOSSARY
// ============================================================================

export async function findTerm(name) {
  const searchName = name.toLowerCase();
  const terms = await getTerms();
  return terms.find(
    (t) =>
      t.name.toLowerCase() === searchName ||
      t.id.toLowerCase() === `dfn-${searchName.replace(/\s+/g, '-')}`
  );
}

export async function searchTerms(query) {
  const terms = await getTerms();
  return rankBy(terms, (t) =>
    scoreFields(query, [
      { label: 'Name', weight: 5, text: t.name },
      { label: 'Definition', weight: 2, text: htmlToText(t.definition) },
    ])
  ).map(({ item }) => item);
}

/**
 * Glossary terms a criterion actually references. There is no cross-reference
 * field, but the criterion's own `content` HTML links every defined term it
 * uses as `.../#dfn-<slug>`, which is the same anchor as `term.id` — a real
 * signal, so no keyword guessing is involved. Returned in first-mention order.
 */
export async function relatedTerms(sc) {
  const terms = await getTerms();
  const byId = new Map(terms.map((t) => [t.id, t]));
  const byName = new Map(terms.map((t) => [t.name.toLowerCase(), t]));
  const html = [sc.content ?? '', ...(sc.details ?? []).flatMap(detailHtml)].join(' ');

  const found = [];
  const seen = new Set();
  const add = (term) => {
    if (!term || seen.has(term.id)) return;
    seen.add(term.id);
    found.push(term);
  };
  for (const match of html.matchAll(/#(dfn-[a-z0-9-]+)/gi)) add(byId.get(match[1].toLowerCase()));
  // W3C's Key Terms list is the transitive closure (terms used inside the
  // definitions of linked terms), so it extends the direct anchors above --
  // 13 for 2.5.8 where the criterion text alone links 7. The Understanding
  // page keys them by a singular anchor (`dfn-assistive-technology`) where
  // wcag.json uses the plural (`dfn-assistive-technologies`), so fall back to
  // the displayed name. Local only: this is called from bulk paths and must
  // not trigger a page fetch.
  const understanding = await getUnderstandingLocal(sc.num);
  for (const term of understanding?.keyTerms ?? []) {
    add(byId.get(term.id.toLowerCase()) ?? byName.get(term.name.toLowerCase()));
  }
  return found;
}

function detailHtml(detail) {
  const parts = [detail.text ?? ''];
  for (const item of detail.items ?? []) parts.push(item.text ?? '');
  return parts;
}

// ============================================================================
// VERSIONS
// ============================================================================

export async function getNewInVersion(version) {
  const versionStr = version.includes('.') ? version : `2.${version.replace('2', '')}`;
  const all = await getAllSuccessCriteria();
  return all.filter((sc) => {
    const versions = sc.versions || [];
    const earlierVersions = versions.filter((v) => v < versionStr);
    return versions.includes(versionStr) && earlierVersions.length === 0;
  });
}

/**
 * Criteria a version dropped. W3C keeps a removed criterion in the list with
 * an empty level, its old number, and `versions` stopping before the version
 * that dropped it (4.1.1 Parsing: level "", versions 2.0 and 2.1) -- the same
 * signal `isRemoved` renders.
 */
export async function getRemovedInVersion(version) {
  const all = await getAllSuccessCriteria();
  return all.filter((sc) => isRemoved(sc) && !(sc.versions ?? []).includes(version));
}

// ============================================================================
// RESPONSE
// ============================================================================

// `data` is the structured payload the text was rendered from; `--json`
// prints it instead of the Markdown. Undefined when a command has nothing
// beyond the text (the CLI then wraps the text itself).
export function textResponse(text, data) {
  const res = { content: [{ type: 'text', text }] };
  if (data !== undefined) res.data = data;
  return res;
}

// ============================================================================
// KEYWORD MATCHING
// ============================================================================
//
// The three search commands used `text.toLowerCase().includes(query)`, i.e. one
// contiguous substring. That failed on ordinary spelling rather than on meaning:
// "placeholders" missed prose saying "placeholder", "focus keyboard" missed
// everything while "keyboard focus" found nine, "colour" found nothing where
// "color" found sixteen, and "screenreader" nothing where "screen reader" found
// twenty-five. All four are tokenisation problems, so the fix is tokenisation —
// not embeddings, which would trade a 1 MB offline package for a ~400 MB runtime
// to answer keyword lookups over 87 criteria.
//
// Every step here is deterministic, so the golden harness still pins the output.

// Keep dotted and hyphenated runs whole: "1.4.3" and "aria-live" are single
// terms, and splitting them would match far too much ("1", "4", "3").
const TOKEN_RE = /[a-z0-9][a-z0-9.'-]*/g;

// One token in, one or more out. Spelling and compounding variants only — this
// is not a thesaurus, and it is applied to BOTH the query and the corpus so the
// two meet in the middle regardless of which spelling either uses.
const VARIANTS = new Map([
  ['colour', ['color']],
  ['colours', ['color']],
  ['behaviour', ['behavior']],
  ['screenreader', ['screen', 'reader']],
  ['screenreaders', ['screen', 'reader']],
  ['keypress', ['key', 'press']],
  ['runtime', ['run', 'time']],
]);

// Query-side only: a term the author may type instead of WCAG's own wording.
const QUERY_SYNONYMS = new Map([
  ['alt', ['alt', 'alternative']],
  ['a11y', ['accessibility']],
]);

/**
 * Crude, deliberate suffix stemmer: enough to make plurals and common verb
 * forms agree, and short enough to reason about. A real Porter stemmer would
 * conflate more aggressively, which costs precision — and in a compliance tool
 * a wrong criterion is worse than a missed one.
 */
export function stem(token) {
  if (token.length <= 3) return token;
  // The guard is on the length of what REMAINS, not of the input: guarding by
  // input length turned "used" into "us" and "need" into "ne", and under prefix
  // matching a two-letter stem hits a large slice of the corpus. A rule whose
  // base comes out too short is skipped and the next rule gets a turn — which is
  // how "pages" reaches "page" through the plural rule once "es" is rejected.
  for (const [suffix, minBase, replacement] of [
    ['ies', 3, 'y'],
    ['ing', 4, ''],
    ['ed', 4, ''],
    ['es', 4, ''],
    ['s', 3, ''],
  ]) {
    if (!token.endsWith(suffix)) continue;
    const base = token.slice(0, -suffix.length);
    if (base.length >= minBase) return `${base}${replacement}`;
  }
  return token;
}

/** Lowercase text into a deduplicated set of stemmed tokens. */
export function tokenise(text) {
  const out = new Set();
  for (const raw of String(text ?? '').toLowerCase().match(TOKEN_RE) ?? []) {
    for (const token of VARIANTS.get(raw) ?? [raw]) out.add(stem(token));
  }
  return out;
}

/** The query as a list of alternative-sets: every entry must match something. */
export function queryTerms(query) {
  const terms = [];
  for (const raw of String(query ?? '').toLowerCase().match(TOKEN_RE) ?? []) {
    const expanded = VARIANTS.get(raw) ?? QUERY_SYNONYMS.get(raw) ?? [raw];
    // A multi-token expansion ("screenreader" -> screen, reader) is a
    // conjunction: both halves must appear. A synonym list is a disjunction.
    if (VARIANTS.has(raw)) {
      for (const token of expanded) terms.push([stem(token)]);
    } else {
      terms.push(expanded.map(stem));
    }
  }
  return terms;
}

// A query term matches a corpus token on stem equality or as a prefix, so
// "keyb" finds "keyboard" and "focus" finds "focusable". Very short terms must
// match exactly, or "a" would hit everything.
function termMatches(alternatives, tokens) {
  return alternatives.some((alt) =>
    alt.length <= 2 ? tokens.has(alt) : [...tokens].some((token) => token.startsWith(alt))
  );
}

/**
 * Score one record against a query. `fields` is `[{ label, weight, text }]`.
 *
 * Returns `{ score, labels }`, or null when any query term is missing from
 * every field — matching is AND across terms, so word order stops mattering
 * while an extra word still narrows the result.
 */
export function scoreFields(query, fields) {
  const terms = queryTerms(query);
  if (terms.length === 0) return null;

  const prepared = fields.map((field) => ({
    ...field,
    tokens: tokenise(Array.isArray(field.text) ? field.text.join(' ') : field.text),
  }));

  let score = 0;
  const labels = new Set();
  for (const term of terms) {
    let found = false;
    for (const field of prepared) {
      if (termMatches(term, field.tokens)) {
        score += field.weight;
        labels.add(field.label);
        found = true;
      }
    }
    if (!found) return null;
  }
  return { score, labels: [...labels] };
}

/**
 * Score every candidate, drop the misses, and sort by score.
 *
 * The tie-break is the candidate's original position, so equal scores keep
 * corpus order and the output stays byte-stable for the golden harness — a
 * relevance sort that reordered ties run to run would make those tests useless.
 */
export function rankBy(items, score) {
  return items
    .map((item, index) => ({ item, index, ...(score(item) ?? {}) }))
    .filter((row) => row.score !== undefined)
    .sort((a, b) => b.score - a.score || a.index - b.index);
}
