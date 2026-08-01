import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadDataset, loadUnderstanding, resolveCacheDir, TTL_MS } from '../src/data.js';

// --- fixtures -------------------------------------------------------------

const repoDataPath = (name) => fileURLToPath(new URL(`../data/${name}`, import.meta.url));
const bundledWcag = JSON.parse(readFileSync(repoDataPath('wcag.json'), 'utf8'));
const bundledUnderstanding = JSON.parse(readFileSync(repoDataPath('understanding.json'), 'utf8'));
const bundledMetaFixture = JSON.parse(readFileSync(repoDataPath('meta.json'), 'utf8'));

// NOW is pinned ~30 days after the bundle's own captured fetchedAt so the
// bundle itself reads as stale for every test in this file, regardless of
// wall-clock date. Without this, loadDataset/loadUnderstanding's "no
// refreshed cache yet -> honour the bundle's own TTL" seed would silently
// short-circuit tests that mean to exercise the network-attempt-then-cache
// (or -bundle) fallback path.
const NOW = new Date(bundledMetaFixture.fetchedAt).getTime() + 30 * 24 * 60 * 60 * 1000;

const FRESH_META = {
  source: 'https://www.w3.org/WAI/WCAG22/wcag.json',
  etag: 'W/"cached-etag"',
  lastModified: 'Thu, 01 Jan 2026 00:00:00 GMT',
  fetchedAt: new Date(NOW - 1 * 24 * 60 * 60 * 1000).toISOString(), // 1 day before NOW: within TTL
};
const STALE_META = {
  ...FRESH_META,
  fetchedAt: new Date(NOW - 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days before NOW: past TTL
};
const CACHED_BODY = { principles: [{ id: 'cached-principle', guidelines: [] }], terms: [] };

// Every loadDataset/loadUnderstanding call below pins `noNetwork` explicitly.
// Its production default reads WCAG_CLI_NO_NETWORK from the ambient
// environment, so a test that left it unset would exercise a different code
// path depending on the shell it ran in -- the injected `fetchImpl` is never
// reached when that variable happens to be set. The one deliberate exception
// is the test that asserts the env-var default itself, which sets and restores
// the variable inside its own body.
function makeTmpCacheDir() {
  return mkdtempSync(join(tmpdir(), 'wcag-cli-data-test-'));
}

function writeCache(dir, body, meta) {
  writeFileSync(join(dir, 'wcag.json'), JSON.stringify(body));
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta));
}

function throwingFetch() {
  throw new Error('fetch must not be called on this path');
}

function jsonResponse({ status, headers = {}, body }) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (key) => headers[key.toLowerCase()] ?? null },
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  };
}

// Counts invocations rather than relying on a thrown error being swallowed
// by the implementation's own network-failure catch: a fetch that merely
// throws cannot distinguish "the guard correctly never called me" from "the
// guard was removed, called me, and my throw was caught and papered over".
// Asserting `count() === 0` is sensitive to a deleted/bypassed guard either
// way.
function makeFetchSpy(response = jsonResponse({ status: 304 })) {
  let count = 0;
  const impl = async (...args) => {
    count++;
    return typeof response === 'function' ? response(...args) : response;
  };
  return { impl, count: () => count };
}

// A freshly fetched 200 body must actually carry success criteria to be
// accepted (the sanity-check guard against a lie-shaped 200) -- any body
// used to exercise a successful replace/refresh needs at least one.
function makeWcagBody(principleId = 'fresh-principle') {
  return {
    principles: [
      { id: principleId, guidelines: [{ id: 'g1', successcriteria: [{ id: 'sc1', num: '9.9.9' }] }] },
    ],
    terms: [],
  };
}

async function silencingStderr(fn) {
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  try {
    return await fn();
  } finally {
    process.stderr.write = original;
  }
}

// --- resolveCacheDir -------------------------------------------------------

test('resolveCacheDir prefers XDG_CACHE_HOME and appends wcag-cli', () => {
  const original = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = '/tmp/xdg-example';
  try {
    assert.equal(resolveCacheDir(), '/tmp/xdg-example/wcag-cli');
  } finally {
    if (original === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = original;
  }
});

test('TTL_MS is one week', () => {
  assert.equal(TTL_MS, 7 * 24 * 60 * 60 * 1000);
});

// --- AC: fresh cache -> zero network requests -----------------------------

test('loadDataset: fresh cache serves cached data and never calls fetch', async () => {
  const dir = makeTmpCacheDir();
  try {
    writeCache(dir, CACHED_BODY, FRESH_META);
    const spy = makeFetchSpy();
    const { wcag, meta } = await loadDataset({
      cacheDir: dir,
      now: NOW,
      noNetwork: false,
      fetchImpl: spy.impl,
    });
    assert.deepEqual(wcag, CACHED_BODY);
    assert.deepEqual(meta, FRESH_META);
    assert.equal(spy.count(), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- AC: stale cache + 304 -> body unchanged, timestamp advanced ----------

test('loadDataset: stale cache + 304 keeps body byte-for-byte, only touches fetchedAt', async () => {
  const dir = makeTmpCacheDir();
  try {
    writeCache(dir, CACHED_BODY, STALE_META);
    const calls = [];
    const fetchImpl = async (url, opts) => {
      calls.push({ url, headers: opts.headers });
      return jsonResponse({ status: 304 });
    };
    const { wcag, meta } = await loadDataset({ cacheDir: dir, now: NOW, noNetwork: false, fetchImpl });

    assert.deepEqual(wcag, CACHED_BODY);
    assert.equal(meta.etag, STALE_META.etag);
    assert.equal(meta.fetchedAt, new Date(NOW).toISOString());
    assert.notEqual(meta.fetchedAt, STALE_META.fetchedAt);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].headers['If-None-Match'], STALE_META.etag);

    const onDiskBody = JSON.parse(readFileSync(join(dir, 'wcag.json'), 'utf8'));
    assert.deepEqual(onDiskBody, CACHED_BODY);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- AC: stale cache + 200 -> body and validators replaced ----------------

test('loadDataset: stale cache + 200 replaces body and validators', async () => {
  const dir = makeTmpCacheDir();
  try {
    writeCache(dir, CACHED_BODY, STALE_META);
    const newBody = makeWcagBody();
    const fetchImpl = async () =>
      jsonResponse({
        status: 200,
        headers: { etag: 'W/"new-etag"', 'last-modified': 'Fri, 31 Jul 2026 00:00:00 GMT' },
        body: newBody,
      });

    const { wcag, meta } = await loadDataset({ cacheDir: dir, now: NOW, noNetwork: false, fetchImpl });

    assert.deepEqual(wcag, newBody);
    assert.equal(meta.etag, 'W/"new-etag"');
    assert.equal(meta.lastModified, 'Fri, 31 Jul 2026 00:00:00 GMT');
    assert.equal(meta.fetchedAt, new Date(NOW).toISOString());

    const onDiskBody = JSON.parse(readFileSync(join(dir, 'wcag.json'), 'utf8'));
    const onDiskMeta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
    assert.deepEqual(onDiskBody, newBody);
    assert.equal(onDiskMeta.etag, 'W/"new-etag"');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadDataset: 200 with zero success criteria is rejected, cache is kept (lie-shaped 200 guard)', async () => {
  const dir = makeTmpCacheDir();
  try {
    writeCache(dir, CACHED_BODY, STALE_META);
    const fetchImpl = async () =>
      jsonResponse({ status: 200, body: { error: 'Too Many Requests' } });
    const { wcag, meta } = await silencingStderr(() =>
      loadDataset({ cacheDir: dir, now: NOW, noNetwork: false, fetchImpl })
    );
    assert.deepEqual(wcag, CACHED_BODY);
    assert.deepEqual(meta, STALE_META);

    const onDiskBody = JSON.parse(readFileSync(join(dir, 'wcag.json'), 'utf8'));
    assert.deepEqual(onDiskBody, CACHED_BODY, 'the bad 200 body must never be persisted');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadUnderstanding: 200 with no intent text is rejected, cache is kept (lie-shaped 200 guard)', async () => {
  const dir = makeTmpCacheDir();
  try {
    mkdirSync(join(dir, 'understanding'), { recursive: true });
    const stale = { brief: { goal: 'kept' }, intent: 'kept intent', benefits: [], resources: [], fetchedAt: STALE_META.fetchedAt };
    writeFileSync(join(dir, 'understanding', '1.1.1.json'), JSON.stringify(stale));

    // off-template HTML: parseUnderstanding degrades to empty shapes rather
    // than throwing, so this must be caught as an empty-intent 200, not as
    // a parse error.
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => '<html><body>not the expected template at all</body></html>',
    });

    const entry = await silencingStderr(() =>
      loadUnderstanding('1.1.1', { cacheDir: dir, now: NOW, noNetwork: false, fetchImpl })
    );
    assert.equal(entry.intent, 'kept intent');

    const onDisk = JSON.parse(readFileSync(join(dir, 'understanding', '1.1.1.json'), 'utf8'));
    assert.equal(onDisk.intent, 'kept intent', 'the empty-intent 200 must never be persisted');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- fetch is bounded: a lookup must not stall on a hung origin -----------

test('loadDataset: the conditional GET is issued with an AbortSignal timeout', async () => {
  const dir = makeTmpCacheDir();
  try {
    writeCache(dir, CACHED_BODY, STALE_META);
    let seenSignal;
    const fetchImpl = async (url, opts) => {
      seenSignal = opts.signal;
      return jsonResponse({ status: 304 });
    };
    await loadDataset({ cacheDir: dir, now: NOW, noNetwork: false, fetchImpl });
    assert.ok(seenSignal instanceof AbortSignal, 'fetch must be called with a bounding AbortSignal');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadUnderstanding: the refresh GET is issued with an AbortSignal timeout', async () => {
  const dir = makeTmpCacheDir();
  try {
    let seenSignal;
    const fetchImpl = async (url, opts) => {
      seenSignal = opts.signal;
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => '<section id="intent"><h2>Intent</h2><p>Timed.</p></section>',
      };
    };
    await loadUnderstanding('1.1.1', { cacheDir: dir, now: NOW, noNetwork: false, fetchImpl });
    assert.ok(seenSignal instanceof AbortSignal, 'fetch must be called with a bounding AbortSignal');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- conditional headers: If-Modified-Since fallback, none when no body --

test('loadDataset: sends If-Modified-Since when only lastModified is cached (no etag)', async () => {
  const dir = makeTmpCacheDir();
  try {
    const metaWithoutEtag = { ...STALE_META, etag: undefined };
    writeCache(dir, CACHED_BODY, metaWithoutEtag);
    const calls = [];
    const fetchImpl = async (url, opts) => {
      calls.push(opts.headers);
      return jsonResponse({ status: 304 });
    };
    await loadDataset({ cacheDir: dir, now: NOW, noNetwork: false, fetchImpl });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]['If-Modified-Since'], STALE_META.lastModified);
    assert.equal(calls[0]['If-None-Match'], undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A corrupt cached body must never be resurrected by a 304. It can still be
// validated *against the bundle*, though: the request carries the bundled
// validator, and a 304 means "what you have is current", which is true of
// the bundle and says nothing about the unreadable file next to it.
test('loadDataset: a corrupt cached body is validated against the bundle, never revived', async () => {
  const dir = makeTmpCacheDir();
  try {
    writeFileSync(join(dir, 'wcag.json'), '{not valid json');
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(STALE_META));
    const calls = [];
    const fetchImpl = async (url, opts) => {
      calls.push(opts.headers);
      return jsonResponse({ status: 304 });
    };
    const { wcag } = await loadDataset({ cacheDir: dir, now: NOW, noNetwork: false, fetchImpl });

    assert.equal(calls.length, 1);
    assert.equal(
      calls[0]['If-None-Match'],
      bundledMetaFixture.etag,
      'the corrupt cache must not supply the validator; the bundle must'
    );
    assert.deepEqual(wcag, bundledWcag);
    assert.notEqual(readFileSync(join(dir, 'wcag.json'), 'utf8'), '{not valid json');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadDataset: a corrupt cached body still recovers from a 200', async () => {
  const dir = makeTmpCacheDir();
  try {
    writeFileSync(join(dir, 'wcag.json'), '{not valid json');
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(STALE_META));
    const fetchImpl = async () => jsonResponse({ status: 200, body: makeWcagBody('recovered') });
    const { wcag } = await loadDataset({ cacheDir: dir, now: NOW, noNetwork: false, fetchImpl });
    assert.deepEqual(wcag, makeWcagBody('recovered'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- num is filesystem/URL input: reject anything not a bare criterion id -

test('loadUnderstanding: a non-criterion num is rejected before touching the filesystem or network', async () => {
  const dir = makeTmpCacheDir();
  try {
    const entry = await loadUnderstanding('../../etc/passwd', {
      cacheDir: dir,
      now: NOW,
      noNetwork: false,
      fetchImpl: throwingFetch,
    });
    assert.equal(entry, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- AC: network throws -> falls back to cache, then bundle ---------------

test('loadDataset: fetch throwing falls back to the stale cache (lookup still returns data)', async () => {
  const dir = makeTmpCacheDir();
  try {
    writeCache(dir, CACHED_BODY, STALE_META);
    const fetchImpl = async () => {
      throw new Error('ECONNRESET');
    };
    const { wcag, meta } = await silencingStderr(() =>
      loadDataset({ cacheDir: dir, now: NOW, noNetwork: false, fetchImpl })
    );
    assert.deepEqual(wcag, CACHED_BODY);
    assert.deepEqual(meta, STALE_META);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadDataset: fetch throwing with no cache at all falls back to the bundle', async () => {
  const dir = makeTmpCacheDir(); // empty, no cache files written
  try {
    const fetchImpl = async () => {
      throw new Error('ENOTFOUND');
    };
    const { wcag, meta } = await silencingStderr(() =>
      loadDataset({ cacheDir: dir, now: NOW, noNetwork: false, fetchImpl })
    );
    assert.deepEqual(wcag, bundledWcag);
    assert.ok(meta && meta.criteria === 87);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// treat a 429 exactly like any other non-2xx: keep cache, never retry
test('loadDataset: 429 keeps the existing cache and never retries', async () => {
  const dir = makeTmpCacheDir();
  try {
    writeCache(dir, CACHED_BODY, STALE_META);
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return jsonResponse({ status: 429 });
    };
    const { wcag, meta } = await silencingStderr(() =>
      loadDataset({ cacheDir: dir, now: NOW, noNetwork: false, fetchImpl })
    );
    assert.deepEqual(wcag, CACHED_BODY);
    assert.deepEqual(meta, STALE_META);
    assert.equal(calls, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- AC: WCAG_CLI_NO_NETWORK=1 -> zero requests even with --refresh -------

test('loadDataset: noNetwork wins over refresh, even on a fresh cache', async () => {
  const dir = makeTmpCacheDir();
  try {
    writeCache(dir, CACHED_BODY, FRESH_META);
    const spy = makeFetchSpy();
    const { wcag, meta } = await loadDataset({
      cacheDir: dir,
      now: NOW,
      refresh: true,
      noNetwork: true,
      fetchImpl: spy.impl,
    });
    assert.deepEqual(wcag, CACHED_BODY);
    assert.deepEqual(meta, FRESH_META);
    assert.equal(spy.count(), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadDataset: noNetwork is an explicit argument, not an ambient env read', async () => {
  const dir = makeTmpCacheDir();
  const original = process.env.WCAG_CLI_NO_NETWORK;
  process.env.WCAG_CLI_NO_NETWORK = '1';
  try {
    // The env var is the CLI's to interpret (see test/cli.test.js). This layer
    // must ignore it entirely, so a stale cache still refreshes here even
    // though the ambient variable says otherwise.
    writeCache(dir, CACHED_BODY, STALE_META);
    const spy = makeFetchSpy();
    await loadDataset({ cacheDir: dir, now: NOW, refresh: true, fetchImpl: spy.impl });
    assert.equal(spy.count(), 1);
  } finally {
    if (original === undefined) delete process.env.WCAG_CLI_NO_NETWORK;
    else process.env.WCAG_CLI_NO_NETWORK = original;
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- AC: no cache present, no network -> bundled floor serves both -------

test('loadDataset: no cache, no network -> bundled wcag.json floor serves criteria', async () => {
  const dir = makeTmpCacheDir();
  try {
    const { wcag, meta } = await loadDataset({
      cacheDir: dir,
      now: NOW,
      noNetwork: true,
      fetchImpl: throwingFetch,
    });
    assert.deepEqual(wcag, bundledWcag);
    assert.equal(meta.criteria, 87);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadUnderstanding: no cache, no network -> bundled Understanding floor serves the criterion', async () => {
  const dir = makeTmpCacheDir();
  try {
    const entry = await loadUnderstanding('1.1.1', {
      cacheDir: dir,
      now: NOW,
      noNetwork: true,
      fetchImpl: throwingFetch,
    });
    assert.deepEqual(entry, bundledUnderstanding['1.1.1']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- AC: corrupt cache file -> discarded silently, bundle used -----------

test('loadDataset: corrupt cache body is discarded and the bundle is used', async () => {
  const dir = makeTmpCacheDir();
  try {
    writeFileSync(join(dir, 'wcag.json'), '{not valid json');
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(STALE_META));
    const { wcag } = await loadDataset({
      cacheDir: dir,
      now: NOW,
      noNetwork: true,
      fetchImpl: throwingFetch,
    });
    assert.deepEqual(wcag, bundledWcag);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadDataset: empty cache file is discarded and the bundle is used', async () => {
  const dir = makeTmpCacheDir();
  try {
    writeFileSync(join(dir, 'wcag.json'), '');
    writeFileSync(join(dir, 'meta.json'), '');
    const { wcag } = await loadDataset({
      cacheDir: dir,
      now: NOW,
      noNetwork: true,
      fetchImpl: throwingFetch,
    });
    assert.deepEqual(wcag, bundledWcag);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadUnderstanding: corrupt per-criterion cache is discarded and the bundle is used', async () => {
  const dir = makeTmpCacheDir();
  try {
    mkdirSync(join(dir, 'understanding'), { recursive: true });
    writeFileSync(join(dir, 'understanding', '1.1.1.json'), '{ broken');
    const entry = await loadUnderstanding('1.1.1', {
      cacheDir: dir,
      now: NOW,
      noNetwork: true,
      fetchImpl: throwingFetch,
    });
    assert.deepEqual(entry, bundledUnderstanding['1.1.1']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- AC: nothing is ever written into the package directory --------------

test('loadDataset: a refresh never writes into the installed package directory', async () => {
  const dir = makeTmpCacheDir();
  const beforeWcag = readFileSync(repoDataPath('wcag.json'));
  const beforeUnderstanding = readFileSync(repoDataPath('understanding.json'));
  const beforeMeta = readFileSync(repoDataPath('meta.json'));
  try {
    writeCache(dir, CACHED_BODY, STALE_META);
    const fetchImpl = async () =>
      jsonResponse({
        status: 200,
        headers: { etag: 'W/"another"', 'last-modified': 'Sat, 01 Aug 2026 00:00:00 GMT' },
        body: makeWcagBody('another-principle'),
      });
    await loadDataset({ cacheDir: dir, now: NOW, noNetwork: false, fetchImpl });
    await loadUnderstanding('1.1.1', {
      cacheDir: dir,
      now: NOW,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => '<section id="intent"><h2>Intent</h2><p>x</p></section>',
      }),
    });

    assert.deepEqual(readFileSync(repoDataPath('wcag.json')), beforeWcag);
    assert.deepEqual(readFileSync(repoDataPath('understanding.json')), beforeUnderstanding);
    assert.deepEqual(readFileSync(repoDataPath('meta.json')), beforeMeta);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Understanding: lazy per-criterion refresh, independent timestamp ----

test('loadUnderstanding: fresh per-criterion cache serves cached data and never calls fetch', async () => {
  const dir = makeTmpCacheDir();
  try {
    mkdirSync(join(dir, 'understanding'), { recursive: true });
    const cached = { brief: { goal: 'cached' }, intent: 'x', benefits: [], resources: [], fetchedAt: FRESH_META.fetchedAt };
    writeFileSync(join(dir, 'understanding', '1.1.1.json'), JSON.stringify(cached));

    const spy = makeFetchSpy({ ok: true, status: 200, headers: { get: () => null }, text: async () => '' });
    const entry = await loadUnderstanding('1.1.1', { cacheDir: dir, now: NOW, noNetwork: false, fetchImpl: spy.impl });
    assert.equal(entry.brief.goal, 'cached');
    assert.equal(entry.fetchedAt, undefined);
    assert.equal(spy.count(), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadUnderstanding: stale per-criterion cache refreshes only that criterion', async () => {
  const dir = makeTmpCacheDir();
  try {
    mkdirSync(join(dir, 'understanding'), { recursive: true });
    const stale = { brief: { goal: 'old' }, intent: 'old', benefits: [], resources: [], fetchedAt: STALE_META.fetchedAt };
    writeFileSync(join(dir, 'understanding', '1.1.1.json'), JSON.stringify(stale));

    const html = '<section id="intent"><h2>Intent</h2><p>The refreshed intent.</p></section>';
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => html };
    };

    const entry = await loadUnderstanding('1.1.1', { cacheDir: dir, now: NOW, noNetwork: false, fetchImpl });
    assert.equal(entry.intent, 'The refreshed intent.');
    assert.equal(calls.length, 1);
    assert.match(calls[0], /Understanding\/non-text-content\.html$/);

    const onDisk = JSON.parse(readFileSync(join(dir, 'understanding', '1.1.1.json'), 'utf8'));
    assert.equal(onDisk.fetchedAt, new Date(NOW).toISOString());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadUnderstanding: refreshing 1.1.1 does not touch a sibling criterion cache file/timestamp', async () => {
  const dir = makeTmpCacheDir();
  try {
    mkdirSync(join(dir, 'understanding'), { recursive: true });
    const sibling = { brief: { goal: 'untouched' }, intent: 'x', benefits: [], resources: [], fetchedAt: STALE_META.fetchedAt };
    writeFileSync(join(dir, 'understanding', '1.4.3.json'), JSON.stringify(sibling));
    const stale = { brief: { goal: 'old' }, intent: 'old', benefits: [], resources: [], fetchedAt: STALE_META.fetchedAt };
    writeFileSync(join(dir, 'understanding', '1.1.1.json'), JSON.stringify(stale));

    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => '<section id="intent"><h2>Intent</h2><p>Refreshed.</p></section>',
    });
    await loadUnderstanding('1.1.1', { cacheDir: dir, now: NOW, noNetwork: false, fetchImpl });

    const siblingOnDisk = JSON.parse(readFileSync(join(dir, 'understanding', '1.4.3.json'), 'utf8'));
    assert.equal(siblingOnDisk.fetchedAt, STALE_META.fetchedAt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadUnderstanding: fetch throwing falls back to stale cache, then bundle', async () => {
  const dir = makeTmpCacheDir();
  try {
    const throwingImpl = async () => {
      throw new Error('network unreachable');
    };
    const entryFromBundle = await silencingStderr(() =>
      loadUnderstanding('1.1.1', { cacheDir: dir, now: NOW, fetchImpl: throwingImpl })
    );
    assert.deepEqual(entryFromBundle, bundledUnderstanding['1.1.1']);

    mkdirSync(join(dir, 'understanding'), { recursive: true });
    const stale = { brief: { goal: 'kept' }, intent: 'x', benefits: [], resources: [], fetchedAt: STALE_META.fetchedAt };
    writeFileSync(join(dir, 'understanding', '1.1.1.json'), JSON.stringify(stale));
    const entryFromCache = await silencingStderr(() =>
      loadUnderstanding('1.1.1', { cacheDir: dir, now: NOW, fetchImpl: throwingImpl })
    );
    assert.equal(entryFromCache.brief.goal, 'kept');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- first run (no runtime cache) still gets to use a validator -----------
//
// The bundled snapshot ships with the ETag/Last-Modified it was captured
// under, so an install older than the TTL has a perfectly good validator on
// disk before it has ever written a cache. Sending it turns the common
// "W3C hasn't republished" case into an empty 304 instead of a ~500K body.

test('loadDataset: with no runtime cache, the conditional GET carries the bundled validator', async () => {
  const dir = makeTmpCacheDir(); // empty: nothing has ever been cached
  try {
    const calls = [];
    const fetchImpl = async (url, opts) => {
      calls.push(opts.headers);
      return jsonResponse({ status: 304 });
    };
    await loadDataset({ cacheDir: dir, now: NOW, noNetwork: false, fetchImpl });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]['If-None-Match'], bundledMetaFixture.etag);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadDataset: a 304 against the bundled validator serves the bundle and seeds the cache', async () => {
  const dir = makeTmpCacheDir();
  try {
    const first = makeFetchSpy(jsonResponse({ status: 304 }));
    const { wcag, meta } = await loadDataset({
      cacheDir: dir,
      now: NOW,
      noNetwork: false,
      fetchImpl: first.impl,
    });

    assert.deepEqual(wcag, bundledWcag);
    assert.equal(meta.etag, bundledMetaFixture.etag);
    assert.equal(meta.fetchedAt, new Date(NOW).toISOString());

    // Seeding the body too is what makes the 304 worth anything: without it
    // the next invocation still has no cached body, reads the bundle's own
    // stale fetchedAt, and goes back to the network every single time.
    const second = makeFetchSpy();
    const again = await loadDataset({
      cacheDir: dir,
      now: NOW + 1000,
      noNetwork: false,
      fetchImpl: second.impl,
    });
    assert.equal(second.count(), 0, 'the seeded cache must be fresh enough to skip the network');
    assert.deepEqual(again.wcag, bundledWcag);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadDataset: the cache seeded by a bundled-validator 304 is byte-for-byte the bundle', async () => {
  const dir = makeTmpCacheDir();
  try {
    await loadDataset({
      cacheDir: dir,
      now: NOW,
      noNetwork: false,
      fetchImpl: async () => jsonResponse({ status: 304 }),
    });

    const onDisk = readFileSync(join(dir, 'wcag.json'), 'utf8');
    assert.equal(onDisk, readFileSync(repoDataPath('wcag.json'), 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the cache holds what the origin served, not a re-serialisation -------

test('loadDataset: a 200 body is cached byte-for-byte', async () => {
  const dir = makeTmpCacheDir();
  try {
    writeCache(dir, CACHED_BODY, STALE_META);
    // Pretty-printed, like the real w3.org file: re-serialising the parsed
    // object would silently drop this whitespace and change the digest.
    const wireText = JSON.stringify(makeWcagBody(), null, 2);
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => wireText,
    });

    await loadDataset({ cacheDir: dir, now: NOW, noNetwork: false, fetchImpl });

    const onDisk = readFileSync(join(dir, 'wcag.json'), 'utf8');
    assert.equal(onDisk, wireText, 'the cached file must be the bytes the origin served');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


// --- first run refreshes and builds the cache -----------------------------
//
// The lifecycle is uniform: no cache or a stale one means refresh, and the
// answer is written to the cache. The bundle is the baseline that makes the
// package useful the moment it is installed and the floor a failed refresh
// falls back to -- it is not a reason to skip the first refresh, so a fresh
// bundle does not suppress it.

const NOW_FRESH_BUNDLE = new Date(bundledMetaFixture.fetchedAt).getTime() + 24 * 60 * 60 * 1000;

test('loadDataset: first run refreshes and builds the cache even when the bundle is fresh', async () => {
  const dir = makeTmpCacheDir();
  try {
    const spy = makeFetchSpy(jsonResponse({ status: 304 }));
    const { wcag, meta } = await loadDataset({
      cacheDir: dir,
      now: NOW_FRESH_BUNDLE,
      noNetwork: false,
      fetchImpl: spy.impl,
    });

    assert.equal(spy.count(), 1, 'a missing cache must be built, not skipped because the bundle is new');
    assert.deepEqual(wcag, bundledWcag);
    assert.equal(meta.fetchedAt, new Date(NOW_FRESH_BUNDLE).toISOString());
    assert.equal(
      readFileSync(join(dir, 'wcag.json'), 'utf8'),
      readFileSync(repoDataPath('wcag.json'), 'utf8')
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadDataset: the cache the first run builds is then honoured for the full TTL', async () => {
  const dir = makeTmpCacheDir();
  try {
    await loadDataset({
      cacheDir: dir,
      now: NOW_FRESH_BUNDLE,
      noNetwork: false,
      fetchImpl: async () => jsonResponse({ status: 304 }),
    });

    const spy = makeFetchSpy();
    await loadDataset({
      cacheDir: dir,
      now: NOW_FRESH_BUNDLE + TTL_MS - 1000,
      noNetwork: false,
      fetchImpl: spy.impl,
    });
    assert.equal(spy.count(), 0, 'the TTL now runs from the cache, not from the bundle');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadDataset: with no network the fresh bundle still answers without a cache', async () => {
  const dir = makeTmpCacheDir();
  try {
    const { wcag } = await loadDataset({
      cacheDir: dir,
      now: NOW_FRESH_BUNDLE,
      noNetwork: true,
      fetchImpl: throwingFetch,
    });
    assert.deepEqual(wcag, bundledWcag, 'the baseline must still work on a first run that cannot refresh');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadUnderstanding: first look at a criterion refreshes and caches it, fresh bundle or not', async () => {
  const dir = makeTmpCacheDir();
  try {
    const html = '<section id="intent"><h2>Intent</h2><p>Refreshed prose.</p></section>';
    const spy = makeFetchSpy({ ok: true, status: 200, headers: { get: () => null }, text: async () => html });
    const entry = await loadUnderstanding('1.1.1', {
      cacheDir: dir,
      now: NOW_FRESH_BUNDLE,
      noNetwork: false,
      fetchImpl: spy.impl,
    });

    assert.equal(spy.count(), 1);
    assert.equal(entry.intent, 'Refreshed prose.');
    const onDisk = JSON.parse(readFileSync(join(dir, 'understanding', '1.1.1.json'), 'utf8'));
    assert.equal(onDisk.fetchedAt, new Date(NOW_FRESH_BUNDLE).toISOString());

    // Only the criterion actually asked for -- a first run must not turn into
    // 87 requests.
    assert.deepEqual(readdirSync(join(dir, 'understanding')), ['1.1.1.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
