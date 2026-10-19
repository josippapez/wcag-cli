#!/usr/bin/env node
// Rebuilds the bundled dataset from the authoritative W3C sources.
//
//   node scripts/fetch-data.mjs
//
// Writes data/wcag.json (criteria + glossary, the published W3C file verbatim),
// data/understanding.json (Intent/benefits/examples/resources/key terms/test
// rules parsed out of the 87 Understanding pages), data/techniques-index.json
// (every published technique, from the W3C index), data/techniques.json (the
// parsed body of each technique page, keyed by id), data/spec.json (the
// conformance requirements and input-purpose tokens from the Recommendation),
// data/errata.json (the errata page) and data/meta.json (validators, so the
// runtime refresh can ask "changed?" with a conditional request instead of a
// download).
//
// The bundled copy is only a floor. At runtime the CLI refreshes from the same
// URLs on a TTL, so this script exists for release-time snapshots and for
// regenerating after an upstream errata, not on a schedule.
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_VERSION,
  USER_AGENT,
  wcagUrls,
  parseUnderstanding,
  parseTechniqueIndex,
  parseTechnique,
  parseSpecExtras,
  parseErrata,
  parseObsolete,
  parseActTestcases,
  applyActRuleStatuses,
  parseActRuleStatuses,
  ACT_TESTCASES_URL,
  ACT_RULES_URL,
  ACT_FILES_BASE,
} from '../src/w3c.js';

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const urls = wcagUrls(DEFAULT_VERSION);
const WCAG_JSON_URL = urls.wcagJson;

// Where the ~520 Understanding and technique pages come from.
//
// w3.org is the default because it is the published version. GitHub Pages
// (https://w3c.github.io/wcag/) is faster and has no Cloudflare gate, but
// the WCAG repository rebuilds it in editors' mode on every push to main,
// so it carries edits w3.org has not published: on 2026-09-22 it differed
// from w3.org on 35 Understanding and technique pages. Only use it to preview
// upcoming changes, never to build data for a release. It is fetched 8 at a
// time with no gap (measured 2026-09-05: 8 workers cleared 48 pages in 0.81s,
// 16 were no faster). wcag.json, the Recommendation and the errata always
// come from w3.org.
//
//   node scripts/fetch-data.mjs                     # pages from w3.org, one at a time, paced
//   node scripts/fetch-data.mjs --pages-from github # editors' draft from GitHub Pages, 8 at a time
const pagesFrom = process.argv.includes('--pages-from')
  ? process.argv[process.argv.indexOf('--pages-from') + 1]
  : 'w3.org';
const PAGES = {
  github: {
    understanding: (id) => `https://w3c.github.io/wcag/understanding/${id}.html`,
    techniquesIndex: 'https://w3c.github.io/wcag/techniques/',
    technique: (technology, id) => `https://w3c.github.io/wcag/techniques/${technology}/${id}.html`,
    gapMs: 0,
    concurrency: 8,
  },
  'w3.org': {
    understanding: urls.understanding,
    techniquesIndex: urls.techniquesIndex,
    technique: urls.technique,
    // One at a time, paced 750ms apart: four in flight once drew a 429
    // after 92 pages, and back-to-back requests are what drew the
    // Cloudflare challenge that blocked the machine for the better part of
    // an hour on 2026-09-04.
    gapMs: 750,
    concurrency: 1,
  },
}[pagesFrom];
if (!PAGES) {
  process.stderr.write(`fetch-data: --pages-from must be "github" or "w3.org", got ${JSON.stringify(pagesFrom)}\n`);
  process.exit(2);
}

const RETRY_DELAYS_MS = [10000, 30000, 60000, 120000, 300000];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A 429 is the origin asking for a pause, not a missing page: honour
// Retry-After when it is sent, back off otherwise, and only give up after the
// schedule.
async function fetchOk(url) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (res.ok) return res;
    if (res.status !== 429 || attempt >= RETRY_DELAYS_MS.length) {
      throw new Error(`${url} responded ${res.status}`);
    }
    const retryAfter = Number(res.headers.get('retry-after'));
    const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : RETRY_DELAYS_MS[attempt];
    process.stderr.write(`\n  429 from ${url}; retrying in ${delay / 1000}s\n`);
    await sleep(delay);
  }
}

async function fetchText(url, gapMs = 0) {
  const text = await (await fetchOk(url)).text();
  if (gapMs) await sleep(gapMs);
  return text;
}

// The newest Last-Modified among the pages that changed is the w3.org publish
// date recorded in data/changes.json.
const lastModified = new Map();
async function fetchPage(url) {
  const res = await fetchOk(url);
  const text = await res.text();
  lastModified.set(url, res.headers.get('last-modified'));
  if (PAGES.gapMs) await sleep(PAGES.gapMs);
  return text;
}


// The techniques index leaves out the ones W3C retired. The WCAG repository
// is the only list of them, so it names the candidates and w3.org serves each
// page; a page not marked obsolete there (not yet published) is skipped.
const REPO_TECHNIQUES_API = 'https://api.github.com/repos/w3c/wcag/contents/techniques';

async function fetchJson(url) {
  return JSON.parse(await fetchText(url));
}

async function listRepoTechniques() {
  const dirs = (await fetchJson(REPO_TECHNIQUES_API)).filter((e) => e.type === 'dir');
  const out = [];
  for (const dir of dirs) {
    for (const file of await fetchJson(`${REPO_TECHNIQUES_API}/${dir.name}`)) {
      const m = /^([A-Z]+\d+)\.html$/.exec(file.name);
      if (m) out.push({ id: m[1], technology: dir.name });
    }
  }
  return out;
}

// Which top-level sections of each entry differ from the previous bundle.
function changedSections(before, after) {
  const out = [];
  for (const [key, value] of Object.entries(after)) {
    if (!before || !(key in before)) {
      out.push({ key, sections: ['new'] });
      continue;
    }
    const sections = Object.keys(value).filter(
      (section) => JSON.stringify(value[section]) !== JSON.stringify(before[key][section])
    );
    if (sections.length) out.push({ key, sections });
  }
  return out;
}

async function readPrevious(name, fallback) {
  try {
    return JSON.parse(await readFile(join(dataDir, name), 'utf8'));
  } catch {
    return fallback;
  }
}

async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    })
  );
  return results;
}


// See the aggregate check in main(): measured 81 of 87 on the current dataset,
// less headroom for genuine W3C page edits.
const EXAMPLES_FLOOR = 75;

async function main() {
  process.stderr.write(`fetching ${WCAG_JSON_URL}\n`);
  const res = await fetchOk(WCAG_JSON_URL);
  const body = await res.text();
  const wcag = JSON.parse(body);

  const criteria = [];
  for (const principle of wcag.principles ?? []) {
    for (const guideline of principle.guidelines ?? []) {
      for (const criterion of guideline.successcriteria ?? []) criteria.push(criterion);
    }
  }
  if (criteria.length === 0) throw new Error('wcag.json parsed to zero success criteria');
  process.stderr.write(`  ${criteria.length} success criteria, ${wcag.terms?.length ?? 0} glossary terms\n`);

  // Same pool as techniques, at PAGES.concurrency. Completions arrive out of
  // order once more than one page is in flight, so the progress counter
  // increments per completion rather than per criterion index — but
  // mapPool's own result array stays in criteria order regardless of
  // completion order, so building `understanding` from it afterwards keeps
  // JSON.stringify's key order (and so the written bytes) stable across
  // runs instead of following whichever request race won.
  const empty = [];
  let understandingDone = 0;
  const understandingResults = await mapPool(criteria, PAGES.concurrency, async (criterion) => {
    const parsed = parseUnderstanding(await fetchPage(PAGES.understanding(criterion.id)));
    if (!parsed.intent) empty.push(`${criterion.num} (no intent parsed)`);
    process.stderr.write(`\r  understanding ${++understandingDone}/${criteria.length}`);
    return parsed;
  });
  process.stderr.write('\n');
  const understanding = {};
  criteria.forEach((criterion, i) => {
    understanding[criterion.num] = understandingResults[i];
  });

  // Fail loudly rather than shipping a thinner dataset: a W3C template change
  // would otherwise degrade silently into criteria with no Intent text.
  if (empty.length > 0) {
    throw new Error(`Understanding parse failed for ${empty.length} criteria: ${empty.join(', ')}`);
  }

  // Examples is the one section that is genuinely absent from some pages, so it
  // cannot be checked per-criterion the way Intent is — only in aggregate. The
  // floor is what this parser actually yields (81 of 87), minus headroom for
  // real upstream page edits — the dependency this dataset replaced managed 41,
  // a strict subset, so anchoring on that would leave enough slack for a silent
  // halving to pass. Print the count unconditionally: a quiet drop is exactly
  // the regression this gate exists to catch.
  const withExamples = Object.values(understanding).filter((u) => u.examples.length > 0).length;
  process.stderr.write(`  ${withExamples}/${criteria.length} criteria carry Examples\n`);
  if (withExamples < EXAMPLES_FLOOR) {
    throw new Error(
      `only ${withExamples} of ${criteria.length} criteria yielded Understanding examples, ` +
        `below the floor of ${EXAMPLES_FLOOR} — the Examples selector has likely broken`
    );
  }

  // Techniques: the index is the authority on what exists (it lists techniques
  // no criterion references), each page supplies the body.
  process.stderr.write(`fetching ${PAGES.techniquesIndex} (pages from ${pagesFrom})\n`);
  const techniqueIndex = parseTechniqueIndex(await fetchPage(PAGES.techniquesIndex));
  if (techniqueIndex.length === 0) throw new Error('techniques index parsed to zero techniques');
  const thin = [];
  let done = 0;
  const techniqueResults = await mapPool(techniqueIndex, PAGES.concurrency, async (t) => {
    const parsed = parseTechnique(await fetchPage(PAGES.technique(t.technology, t.id)));
    if (parsed.description.length === 0 && parsed.examples.length === 0) thin.push(t.id);
    process.stderr.write(`\r  techniques ${++done}/${techniqueIndex.length}`);
    return parsed;
  });
  process.stderr.write('\n');
  const techniques = {};
  techniqueIndex.forEach((t, i) => {
    techniques[t.id] = techniqueResults[i];
  });
  // Every technique page has a Description; a page that yields neither that
  // nor an example is the template having moved, not a thin technique.
  if (thin.length > 0) {
    throw new Error(`Technique parse yielded nothing for ${thin.length} pages: ${thin.join(', ')}`);
  }

  process.stderr.write('listing retired techniques in the WCAG repository\n');
  const published = new Set(techniqueIndex.map((t) => t.id));
  const candidates = (await listRepoTechniques()).filter((t) => !published.has(t.id));
  const obsolete = [];
  let checked = 0;
  for (const t of candidates) {
    const url = PAGES.technique(t.technology, t.id);
    let html;
    try {
      html = await fetchPage(url);
    } catch (err) {
      if (!/responded 404$/.test(err.message)) throw err;
    }
    process.stderr.write(`\r  obsolete ${++checked}/${candidates.length}`);
    const marked = html && parseObsolete(html);
    if (!marked) continue;
    obsolete.push({ id: t.id, technology: t.technology, title: marked.title, obsolete: marked.message });
    techniques[t.id] = parseTechnique(html);
  }
  process.stderr.write(`\n  ${obsolete.length} obsolete techniques\n`);
  if (obsolete.length === 0) throw new Error('found no obsolete technique pages; the obsolete marker has likely moved');

  process.stderr.write(`fetching ${ACT_TESTCASES_URL}\n`);
  const actRules = applyActRuleStatuses(
    parseActTestcases(JSON.parse(await fetchText(ACT_TESTCASES_URL))),
    parseActRuleStatuses(await fetchText(ACT_RULES_URL))
  );
  const unrated = Object.values(actRules).filter((r) => !r.status).map((r) => r.id);
  if (unrated.length) throw new Error(`no status on the ACT rules list for ${unrated.join(', ')}`);
  const actCases = Object.values(actRules).flatMap((rule) => rule.testcases);
  let actDone = 0;
  await mapPool(actCases, 8, async (tc) => {
    tc.html = await fetchText(`${ACT_FILES_BASE}${tc.path}`);
    process.stderr.write(`\r  ACT examples ${++actDone}/${actCases.length}`);
  });
  process.stderr.write(`\n  ${Object.keys(actRules).length} ACT rules\n`);

  process.stderr.write(`fetching ${urls.spec}\n`);
  const spec = parseSpecExtras(await fetchText(urls.spec));
  if (spec.conformanceRequirements.length === 0 || spec.inputPurposes.length === 0) {
    throw new Error(
      `Recommendation parse yielded ${spec.conformanceRequirements.length} conformance requirements ` +
        `and ${spec.inputPurposes.length} input purposes`
    );
  }
  process.stderr.write(
    `  ${spec.conformanceRequirements.length} conformance requirements, ${spec.inputPurposes.length} input purposes\n`
  );

  process.stderr.write(`fetching ${urls.errata}\n`);
  const errata = parseErrata(await fetchText(urls.errata));
  process.stderr.write(`  ${errata.length} errata\n`);

  // A rebuild that changed nothing adds nothing; otherwise it records which
  // pages moved, dated by w3.org's own Last-Modified for them.
  const changes = await readPrevious('changes.json', []);
  const understandingChanged = changedSections(await readPrevious('understanding.json', null), understanding);
  // An obsolete page this package had not bundled before is new to us, not
  // a W3C change; a technique W3C retires was already bundled from the index.
  const obsoleteIds = new Set(obsolete.map((t) => t.id));
  const techniquesChanged = changedSections(await readPrevious('techniques.json', null), techniques).filter(
    ({ key, sections }) => !(sections[0] === 'new' && obsoleteIds.has(key))
  );
  if (understandingChanged.length || techniquesChanged.length) {
    const changedUrls = [
      ...understandingChanged.map(({ key }) => PAGES.understanding(criteria.find((c) => c.num === key).id)),
      ...techniquesChanged.map(({ key }) => {
        const t = techniqueIndex.find((x) => x.id === key) ?? obsolete.find((x) => x.id === key);
        return PAGES.technique(t.technology, t.id);
      }),
    ];
    const dates = changedUrls.map((u) => Date.parse(lastModified.get(u))).filter(Number.isFinite);
    changes.unshift({
      published: dates.length ? new Date(Math.max(...dates)).toISOString().slice(0, 10) : null,
      fetchedAt: new Date().toISOString(),
      understanding: understandingChanged.map(({ key, sections }) => ({ num: key, sections })),
      techniques: techniquesChanged.map(({ key, sections }) => ({ id: key, sections })),
    });
  }

  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, 'wcag.json'), body);
  await writeFile(join(dataDir, 'understanding.json'), JSON.stringify(understanding));
  await writeFile(join(dataDir, 'techniques-index.json'), JSON.stringify(techniqueIndex));
  await writeFile(join(dataDir, 'techniques.json'), JSON.stringify(techniques));
  await writeFile(join(dataDir, 'spec.json'), JSON.stringify(spec));
  await writeFile(join(dataDir, 'errata.json'), JSON.stringify(errata));
  await writeFile(join(dataDir, 'techniques-obsolete.json'), JSON.stringify(obsolete));
  await writeFile(join(dataDir, 'act.json'), JSON.stringify(actRules));
  await writeFile(join(dataDir, 'changes.json'), JSON.stringify(changes));
  await writeFile(
    join(dataDir, 'meta.json'),
    JSON.stringify(
      {
        source: WCAG_JSON_URL,
        etag: res.headers.get('etag'),
        lastModified: res.headers.get('last-modified'),
        criteria: criteria.length,
        techniques: techniqueIndex.length,
        fetchedAt: new Date().toISOString(),
      },
      null,
      2
    ) + '\n'
  );
  process.stderr.write(`wrote data/ (${criteria.length} criteria)\n`);
}

main().catch((err) => {
  process.stderr.write(`fetch-data: ${err?.message ?? err}\n`);
  process.exit(1);
});
