import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/wcag.js', import.meta.url));
const GOLDEN_DIR = fileURLToPath(new URL('./golden/', import.meta.url));

// Every golden is captured offline from the bundled data/ floor:
//   WCAG_CLI_NO_NETWORK=1 keeps the subprocess off w3.org, and a throwaway
//   XDG_CACHE_HOME keeps it out of the developer's real ~/.cache/wcag-cli — a
//   warm cache there was demonstrated to move get-server-info's Fetched line.
const ENV = {
  ...process.env,
  WCAG_CLI_NO_NETWORK: '1',
  XDG_CACHE_HOME: mkdtempSync(join(tmpdir(), 'wcag-cli-golden-')),
};

// Filename convention: the command line with spaces written as `_`.
// `list-techniques_--technology_aria.txt` → `wcag list-techniques --technology aria`
const argvFor = (name) => name.split('_');

// get-server-info is the one case whose output is legitimately not fixed: the
// dataset provenance rotates whenever scripts/fetch-data.mjs runs, and the cache
// directory is per-machine. Normalising exactly those four value fields keeps the
// case in the harness — it is the command this epic rewrote most, so its
// headings, sections and statistics are worth locking — while dropping only the
// values no formatter change can be inferred from. Labels and line shape are
// still compared, so renaming or dropping a field still fails.
//
// The stored golden holds `<normalised>` in those four slots rather than one
// machine's real values, so the checked-in file never encodes a developer's
// cache path. Normalising is idempotent, so applying it to both sides is safe.
// The package version belongs in the same set: it changes on every release, so
// leaving it literal made a routine `npm version` bump fail this test for no
// behavioural reason. The `**wcag** v` label is still compared, so dropping the
// version line entirely would still fail.
const VOLATILE = /^(- \*\*(?:ETag|Last-Modified|Fetched|Directory):\*\* ).*$/gm;
// Anchored to a semver on purpose: `/^(\*\*wcag\*\* v).*$/` also matched the
// prefix of "**wcag** version 0.2.0", so renaming the label was normalised away
// instead of failing. Requiring digits after the `v` keeps the label compared.
const VERSION_LINE = /^(\*\*wcag\*\* v)\d+\.\d+\.\d+.*$/gm;
const normalise = (text) =>
  text.replace(VOLATILE, '$1<normalised>').replace(VERSION_LINE, '$1<normalised>');

const files = readdirSync(GOLDEN_DIR)
  .filter((n) => n.endsWith('.txt'))
  .sort();

// The case list is derived from the directory, so a deleted golden would
// silently shrink coverage instead of failing. Assert the count: adding a case
// is a deliberate one-line bump here, losing one is a test failure.
test('the golden corpus is complete', () => {
  assert.equal(files.length, 23, 'a golden was added or removed — update this count on purpose');
});

for (const file of files) {
  const name = file.slice(0, -4);

  test(`golden: wcag ${argvFor(name).join(' ')}`, () => {
    const actual = execFileSync('node', [BIN, ...argvFor(name)], {
      encoding: 'utf8',
      env: ENV,
    });
    const expected = readFileSync(join(GOLDEN_DIR, file), 'utf8');

    assert.equal(
      normalise(actual),
      normalise(expected),
      `output of \`wcag ${argvFor(name).join(' ')}\` drifted from test/golden/${file}. ` +
        `If the change is intended, re-capture that one golden and say why in the commit.`
    );
  });
}
