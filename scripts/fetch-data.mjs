#!/usr/bin/env node
// Rebuilds the bundled dataset from the authoritative W3C sources.
//
//   node scripts/fetch-data.mjs
//
// Writes data/wcag.json (criteria + glossary, the published W3C file verbatim),
// data/understanding.json (Intent/benefits/examples/resources parsed out of the 87
// Understanding pages) and data/meta.json (validators, so the runtime refresh
// can ask "changed?" with a conditional request instead of a download).
//
// The bundled copy is only a floor. At runtime the CLI refreshes from the same
// URLs on a TTL, so this script exists for release-time snapshots and for
// regenerating after an upstream errata, not on a schedule.
import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WCAG_JSON_URL, understandingUrl, parseUnderstanding } from '../src/w3c.js';

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');


// See the aggregate check in main(): measured 81 of 87 on the current dataset,
// less headroom for genuine W3C page edits.
const EXAMPLES_FLOOR = 75;

async function main() {
  process.stderr.write(`fetching ${WCAG_JSON_URL}\n`);
  const res = await fetch(WCAG_JSON_URL);
  if (!res.ok) throw new Error(`wcag.json responded ${res.status}`);
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

  // Understanding pages are fetched serially on purpose: 87 requests against
  // w3.org is not worth parallelising, and a burst risks being throttled.
  const understanding = {};
  const empty = [];
  for (const criterion of criteria) {
    const url = understandingUrl(criterion.id);
    const page = await fetch(url);
    if (!page.ok) {
      empty.push(`${criterion.num} (HTTP ${page.status})`);
      continue;
    }
    const parsed = parseUnderstanding(await page.text(), criterion.handle);
    if (!parsed.intent) empty.push(`${criterion.num} (no intent parsed)`);
    understanding[criterion.num] = parsed;
    process.stderr.write(`\r  understanding ${Object.keys(understanding).length}/${criteria.length}`);
  }
  process.stderr.write('\n');

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

  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, 'wcag.json'), body);
  await writeFile(join(dataDir, 'understanding.json'), JSON.stringify(understanding));
  await writeFile(
    join(dataDir, 'meta.json'),
    JSON.stringify(
      {
        source: WCAG_JSON_URL,
        etag: res.headers.get('etag'),
        lastModified: res.headers.get('last-modified'),
        criteria: criteria.length,
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
