// Dataset access layer: bundled floor, XDG cache, TTL refresh.
//
// Resolution order per lookup: fresh cache -> bundled `data/` floor. The
// bundle already contains Understanding, so a first run with no network is
// fully functional. See
// .orchestration/own-wcag-data/issues/03-dataset-access-layer.md for the
// accepted decision to hand-roll this with zero dependencies (fetch/fs/os/
// path are the only primitives needed, and undici does no implicit HTTP
// caching, so all TTL/etag bookkeeping here is load-bearing).
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WCAG_JSON_URL, understandingUrl, parseUnderstanding } from './w3c.js';

export const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 1 week

// A lookup must not stall: bound every network attempt so a blackholed
// socket or hung origin can't hold a CLI invocation open while the bundled
// floor sits on disk unread. AbortSignal.timeout is native (Node 17.3+).
const FETCH_TIMEOUT_MS = 5000;

const CRITERION_NUM_RE = /^\d+\.\d+\.\d+$/;

const bundledPath = (name) => fileURLToPath(new URL(`../data/${name}`, import.meta.url));

// os.homedir() can throw (or return an empty value) in odd containers, and
// there is no native XDG resolution in Node — degrade to null (bundle-only)
// rather than let a lookup throw over a cache-path problem.
export function resolveCacheDir() {
  try {
    const home = homedir();
    if (!home) return null;
    const base = process.env.XDG_CACHE_HOME || join(home, '.cache');
    return join(base, 'wcag-cli');
  } catch {
    return null;
  }
}

// Resolved once at import time from the process's current environment. The
// CLI sets any env overrides before requiring this module, so this is safe;
// tests that need a different cache location pass `cacheDir` explicitly to
// loadDataset/loadUnderstanding instead of relying on this constant.
export const CACHE_DIR = resolveCacheDir();

function readNoNetworkEnv() {
  return process.env.WCAG_CLI_NO_NETWORK === '1';
}

function note(message) {
  process.stderr.write(`${message}\n`);
}

function isStale(fetchedAt, now) {
  if (!fetchedAt) return true;
  const t = new Date(fetchedAt).getTime();
  if (Number.isNaN(t)) return true;
  return now - t >= TTL_MS;
}

// Any cache-read failure (missing, empty, EACCES, malformed JSON, wrong
// shape) is treated identically as "no cache" and falls through to the
// bundle -- never thrown.
function readJsonSafe(filePath) {
  try {
    const raw = readFileSync(filePath, 'utf8');
    if (raw === '') return null;
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

// Torn-write strategy: write to a temp file in the same directory, then
// rename (atomic on the same filesystem). Each file is written atomically;
// the wcag.json body + meta.json pair is NOT a cross-file transaction, so a
// crash between the two writes is possible. That is an accepted, bounded
// risk: at worst it leaves fetchedAt slightly out of sync with the body,
// which self-heals on the next stale check (an extra conditional GET), it
// never corrupts a read (readJsonSafe treats a half-written temp file as
// "no cache" since the rename only ever exposes a complete write).
function writeJsonSafe(filePath, data) {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, filePath);
    return true;
  } catch (err) {
    note(`wcag-cli: cache write failed (${err.message})`);
    return false;
  }
}

function wcagCachePaths(cacheDir) {
  return { wcag: join(cacheDir, 'wcag.json'), meta: join(cacheDir, 'meta.json') };
}

function understandingCachePath(cacheDir, num) {
  return join(cacheDir, 'understanding', `${num}.json`);
}

let bundledWcagCache;
function readBundledWcag() {
  if (bundledWcagCache === undefined) {
    bundledWcagCache = JSON.parse(readFileSync(bundledPath('wcag.json'), 'utf8'));
  }
  return bundledWcagCache;
}

let bundledMetaCache;
function bundledMeta() {
  if (bundledMetaCache === undefined) {
    bundledMetaCache = readJsonSafe(bundledPath('meta.json'));
  }
  return bundledMetaCache;
}

let bundledUnderstandingCache;
function readBundledUnderstanding(num) {
  if (bundledUnderstandingCache === undefined) {
    bundledUnderstandingCache = JSON.parse(readFileSync(bundledPath('understanding.json'), 'utf8'));
  }
  // `num` reaches here straight from CLI argv, so a plain property read also
  // resolves inherited keys: `__proto__` returned Object.prototype and
  // `constructor` returned a Function, either of which a formatter expecting
  // {brief, intent, benefits, examples, resources} would crash on or render as nonsense.
  return Object.hasOwn(bundledUnderstandingCache, num)
    ? bundledUnderstandingCache[num]
    : null;
}

function findCriterion(num) {
  const wcag = readBundledWcag();
  for (const principle of wcag.principles ?? []) {
    for (const guideline of principle.guidelines ?? []) {
      for (const sc of guideline.successcriteria ?? []) {
        if (sc.num === num) return sc;
      }
    }
  }
  return null;
}

// A 200 response is not automatically a good response: a W3C template
// change, an error page, or a WAF interstitial can all return status 200
// with a body that parses fine but carries none of the expected data. Same
// guard `scripts/fetch-data.mjs` already applies at build time -- "fail
// loudly rather than shipping a thinner dataset" -- applied here at refresh
// time: reject and fall back rather than caching and serving a lie-shaped
// 200 for a full TTL week.
function countCriteria(wcag) {
  let count = 0;
  for (const principle of wcag?.principles ?? []) {
    for (const guideline of principle.guidelines ?? []) {
      count += (guideline.successcriteria ?? []).length;
    }
  }
  return count;
}

function stripFetchedAt({ fetchedAt, ...rest }) {
  return rest;
}

// One conditional GET for wcag.json. Branch on `status === 304` FIRST --
// never on `res.ok`, which is false for a 304. Only touch the meta
// (fetchedAt) on a 304; never rewrite the body file. `res.text()` resolves
// to '' on a 304 without throwing, but JSON.parse('') throws, so the body is
// only ever read on a genuine 200.
async function tryFetchWcag({ fetchImpl, condMeta, cachedBody, paths, now }) {
  try {
    const headers = {};
    if (condMeta?.etag) headers['If-None-Match'] = condMeta.etag;
    else if (condMeta?.lastModified) headers['If-Modified-Since'] = condMeta.lastModified;

    const res = await fetchImpl(WCAG_JSON_URL, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

    if (res.status === 304) {
      if (!condMeta) return null;
      const touched = { ...condMeta, fetchedAt: new Date(now).toISOString() };
      writeJsonSafe(paths.meta, touched);
      return { wcag: cachedBody, meta: touched };
    }

    if (!res.ok) {
      note(`wcag-cli: dataset refresh failed (HTTP ${res.status}); using cached data`);
      return null;
    }

    const text = await res.text();
    const body = JSON.parse(text);
    if (countCriteria(body) === 0) {
      note('wcag-cli: dataset refresh returned no success criteria; using cached data');
      return null;
    }
    // `sha256` and `criteria` are carried too, so a refreshed cache's meta has
    // the same shape as the bundled `data/meta.json`. Without them
    // get-server-info would report a complete dataset before the first refresh
    // and a partial one after it.
    const meta = {
      source: WCAG_JSON_URL,
      etag: res.headers.get('etag') ?? null,
      lastModified: res.headers.get('last-modified') ?? null,
      sha256: createHash('sha256').update(text).digest('hex'),
      criteria: countCriteria(body),
      fetchedAt: new Date(now).toISOString(),
    };
    writeJsonSafe(paths.wcag, body);
    writeJsonSafe(paths.meta, meta);
    return { wcag: body, meta };
  } catch (err) {
    note(`wcag-cli: dataset refresh failed (${err.message}); using cached data`);
    return null;
  }
}

async function tryFetchUnderstanding({ fetchImpl, num, path, now }) {
  const criterion = findCriterion(num);
  if (!criterion) return null;
  try {
    const res = await fetchImpl(understandingUrl(criterion.id), {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      note(`wcag-cli: understanding refresh failed for ${num} (HTTP ${res.status}); using cached data`);
      return null;
    }

    const html = await res.text();
    const parsed = parseUnderstanding(html, criterion.handle);
    if (!parsed.intent) {
      note(`wcag-cli: understanding refresh for ${num} returned no intent text; using cached data`);
      return null;
    }
    const entry = { ...parsed, fetchedAt: new Date(now).toISOString() };
    writeJsonSafe(path, entry);
    return stripFetchedAt(entry);
  } catch (err) {
    note(`wcag-cli: understanding refresh failed for ${num} (${err.message}); using cached data`);
    return null;
  }
}

/**
 * Returns `{ wcag, meta }`. `wcag` is the parsed wcag.json body (principles +
 * terms); `meta` is `{ source, etag, lastModified, fetchedAt, ... }`.
 *
 * The TTL guard is an early return BEFORE any reference to `fetchImpl` --
 * within TTL, `fetchImpl` is never called (zero network requests). Past TTL,
 * `WCAG_CLI_NO_NETWORK=1` and `--refresh` are both folded into a single
 * decision before fetch is ever touched; no-network wins over refresh.
 */
export async function loadDataset({
  fetchImpl = fetch,
  now = Date.now(),
  refresh = false,
  noNetwork = readNoNetworkEnv(),
  cacheDir = CACHE_DIR,
} = {}) {
  const paths = cacheDir ? wcagCachePaths(cacheDir) : null;
  const cachedMeta = paths ? readJsonSafe(paths.meta) : null;
  const cachedBody = paths ? readJsonSafe(paths.wcag) : null;

  if (cachedMeta && cachedBody && !refresh && !isStale(cachedMeta.fetchedAt, now)) {
    return { wcag: cachedBody, meta: cachedMeta };
  }

  // No refresh cache yet: the bundle itself was captured at build time and
  // carries its own fetchedAt (data/meta.json). Honour that TTL too, so a
  // freshly installed CLI still makes zero requests on the common in-TTL
  // path instead of refetching on every single lookup.
  if (!cachedMeta || !cachedBody) {
    const bmeta = bundledMeta();
    if (bmeta && !refresh && !isStale(bmeta.fetchedAt, now)) {
      return { wcag: readBundledWcag(), meta: bmeta };
    }
  }

  if (!noNetwork && paths) {
    // Only send conditional headers when we actually have a body to reuse on
    // a 304 -- a corrupt/missing body must always force a full 200 refetch.
    const condMeta = cachedBody ? cachedMeta : null;
    const fetched = await tryFetchWcag({ fetchImpl, condMeta, cachedBody, paths, now });
    if (fetched && fetched.wcag) return fetched;
  }

  if (cachedBody && cachedMeta) {
    return { wcag: cachedBody, meta: cachedMeta };
  }

  return { wcag: readBundledWcag(), meta: bundledMeta() };
}

/**
 * Returns `{ brief, intent, benefits, examples, resources }` for one criterion `num`
 * (e.g. "1.4.3"), preferring fresh per-criterion cache, then the bundle.
 * Understanding refresh is lazy and per criterion: it never fetches all 87
 * at once, and it tracks its own fetchedAt per entry, independent of
 * wcag.json's timestamp (a shared timestamp would invalidate every
 * Understanding entry whenever wcag.json refreshes).
 */
export async function loadUnderstanding(num, {
  fetchImpl = fetch,
  now = Date.now(),
  refresh = false,
  noNetwork = readNoNetworkEnv(),
  cacheDir = CACHE_DIR,
} = {}) {
  // `num` ends up in a cache file path -- reject anything that isn't a
  // dotted-numeric criterion id before it ever reaches the filesystem or a
  // URL, rather than trusting the caller.
  if (typeof num !== 'string' || !CRITERION_NUM_RE.test(num)) {
    return readBundledUnderstanding(num);
  }

  const path = cacheDir ? understandingCachePath(cacheDir, num) : null;
  const cached = path ? readJsonSafe(path) : null;

  if (cached && !refresh && !isStale(cached.fetchedAt, now)) {
    return stripFetchedAt(cached);
  }

  // No per-criterion cache yet: fall back to the bundle's own TTL (it was
  // captured at the same build time as data/meta.json) before making a
  // request, for the same reason as loadDataset's bundled-floor TTL check.
  if (!cached) {
    const bmeta = bundledMeta();
    if (bmeta && !refresh && !isStale(bmeta.fetchedAt, now)) {
      return readBundledUnderstanding(num);
    }
  }

  if (!noNetwork && path) {
    const fetched = await tryFetchUnderstanding({ fetchImpl, num, path, now });
    if (fetched) return fetched;
  }

  if (cached) return stripFetchedAt(cached);

  return readBundledUnderstanding(num);
}
