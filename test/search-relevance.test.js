import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/wcag.js', import.meta.url));
const ENV = { ...process.env, WCAG_CLI_NO_NETWORK: '1' };

// Plain-language questions, each with the criteria a reviewer would accept as
// the answer. Before the closest-match fallback, 30 of these returned nothing
// and 4 had a right answer in the top 3.
const QUERIES = [
  ["video captions", ["1.2.2", "1.2.4"]],
  ["session timeout", ["2.2.1", "2.2.6"]],
  ["button too small to tap", ["2.5.8", "2.5.5"]],
  ["cannot see focus", ["2.4.7", "2.4.11", "2.4.13"]],
  ["low contrast text", ["1.4.3", "1.4.6"]],
  ["image without alt text", ["1.1.1"]],
  ["keyboard trap", ["2.1.2"]],
  ["autoplaying audio", ["1.4.2"]],
  ["flashing content seizures", ["2.3.1", "2.3.2"]],
  ["form error messages", ["3.3.1", "3.3.3"]],
  ["form field labels", ["3.3.2", "1.3.1", "2.4.6", "2.5.3"]],
  ["zoom text to 200 percent", ["1.4.4"]],
  ["horizontal scrolling on mobile", ["1.4.10"]],
  ["page title", ["2.4.2"]],
  ["skip to main content link", ["2.4.1"]],
  ["link text that makes sense", ["2.4.4", "2.4.9"]],
  ["language of the page", ["3.1.1"]],
  ["screen orientation lock", ["1.3.4"]],
  ["drag and drop alternative", ["2.5.7"]],
  ["content shown on hover", ["1.4.13"]],
  ["pause a moving carousel", ["2.2.2"]],
  ["heading structure", ["1.3.1", "2.4.6", "2.4.10"]],
  ["sign language video", ["1.2.6"]],
  ["audio description", ["1.2.3", "1.2.5", "1.2.7"]],
  ["login without remembering a password", ["3.3.8", "3.3.9"]],
  ["typing the same information twice", ["3.3.7"]],
  ["help link in the same place", ["3.2.6"]],
  ["sticky header hides the focused element", ["2.4.11", "2.4.12"]],
  ["color alone to show an error", ["1.4.1"]],
  ["icon contrast", ["1.4.11"]],
  ["text spacing", ["1.4.12"]],
  ["shake to undo", ["2.5.4"]],
  ["status message for screen reader", ["4.1.3"]],
  ["custom control name and role", ["4.1.2"]],
  ["autocomplete on inputs", ["1.3.5"]],
];

test('search-wcag answers plain-language questions with the right criterion near the top', () => {
  const misses = [];
  for (const [query, accepted] of QUERIES) {
    const out = execFileSync('node', [BIN, 'search-wcag', query, '--json'], { encoding: 'utf8', env: ENV });
    const top3 = JSON.parse(out).results.slice(0, 3).map((r) => r.num);
    if (!top3.some((num) => accepted.includes(num))) misses.push(`${query} -> ${top3.join(', ') || 'nothing'}`);
  }
  assert.deepEqual(misses, []);
});

const OFF_TOPIC = [
  'best pizza in new york',
  'kubernetes pod restart',
  'sqlalchemy session commit',
  'pandas dataframe merge',
  'docker compose volume',
  'stock market prices',
  'football world cup results',
  'how to bake bread',
  'git rebase conflict',
  'react useEffect cleanup',
];

// Before the coverage bar every one of these listed ten criteria. Two still get
// a short list, and fairly: 2.2.2's examples are about scrolling stock tickers.
test('search-wcag finds nothing for most off-topic queries', () => {
  const answered = OFF_TOPIC.filter((query) => {
    const out = execFileSync('node', [BIN, 'search-wcag', query, '--json'], { encoding: 'utf8', env: ENV });
    return JSON.parse(out).results.length > 0;
  });
  assert.ok(answered.length <= 2, `answered: ${answered.join(', ')}`);
});
