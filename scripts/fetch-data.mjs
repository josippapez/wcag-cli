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
import { writeFile, mkdir } from 'node:fs/promises';
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
} from '../src/w3c.js';

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const urls = wcagUrls(DEFAULT_VERSION);
const WCAG_JSON_URL = urls.wcagJson;

// Where the ~520 Understanding and technique pages come from.
//
// w3.org sits behind Cloudflare, which on 2026-09-04 answered this script's
// back-to-back page requests with 429 "Just a moment..." challenges that then
// applied to every request from the machine for the better part of an hour.
// The WCAG Working Group publishes the same generated pages from the same
// repository on GitHub Pages (https://w3c.github.io/wcag/), served by GitHub
// with no such gate; parsed, H37, 1.1.1 and the 432-entry techniques index
// came out byte-identical to w3.org's on that date. That mirror is the
// default for the bulk pages, fetched 8 at a time with no gap (measured
// 2026-09-05: 8 workers cleared 48 pages in 0.81s on a cold edge, all 200
// and parseable; 16 workers were no faster, so 8 is the pool size, not a
// round number). wcag.json, the Recommendation and the errata have no
// mirror (the GitHub copy of the guidelines is the editors' draft and its
// input-purpose list already differs), so those three requests always go
// to w3.org.
//
//   node scripts/fetch-data.mjs                     # pages from GitHub Pages, 8 at a time
//   node scripts/fetch-data.mjs --pages-from w3.org # pages from w3.org, one at a time, paced
const pagesFrom = process.argv.includes('--pages-from')
  ? process.argv[process.argv.indexOf('--pages-from') + 1]
  : 'github';
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

const fetchPage = (url) => fetchText(url, PAGES.gapMs);

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

  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, 'wcag.json'), body);
  await writeFile(join(dataDir, 'understanding.json'), JSON.stringify(understanding));
  await writeFile(join(dataDir, 'techniques-index.json'), JSON.stringify(techniqueIndex));
  await writeFile(join(dataDir, 'techniques.json'), JSON.stringify(techniques));
  await writeFile(join(dataDir, 'spec.json'), JSON.stringify(spec));
  await writeFile(join(dataDir, 'errata.json'), JSON.stringify(errata));
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
