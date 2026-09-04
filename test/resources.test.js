// The generic cached-resource loader behind the techniques index, technique
// pages, the Recommendation extras and the errata, plus the version handling
// that lets `--wcag 2.1` (or a future 2.x) reuse every loader unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadResource, loadDataset, loadUnderstanding, versionCacheDir, TTL_MS } from '../src/data.js';

const NOW = Date.parse('2026-09-04T12:00:00Z');
const FRESH = new Date(NOW - 1000).toISOString();
const STALE = new Date(NOW - TTL_MS - 1000).toISOString();

const tmp = () => mkdtempSync(join(tmpdir(), 'wcag-cli-resources-'));
const htmlResponse = (html, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  text: async () => html,
});
const spy = (response) => {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    if (response instanceof Error) throw response;
    return response;
  };
  return { impl, calls };
};

const TECHNIQUE_INDEX = {
  url: 'https://example.test/Techniques/',
  parse: (html) => [...html.matchAll(/data-id="(\w+)"/g)].map((m) => ({ id: m[1] })),
  validate: (data) => data.length > 0,
};

// --- loadResource -----------------------------------------------------------

test('loadResource: no cache -> fetches, parses, caches under <dir>/<name>.json', async () => {
  const dir = tmp();
  try {
    const { impl, calls } = spy(htmlResponse('<a data-id="H37"></a>'));
    const data = await loadResource('techniques-index', { ...TECHNIQUE_INDEX, cacheDir: dir, now: NOW, fetchImpl: impl });
    assert.deepEqual(data, [{ id: 'H37' }]);
    assert.deepEqual(calls, ['https://example.test/Techniques/']);
    const onDisk = JSON.parse(readFileSync(join(dir, 'techniques-index.json'), 'utf8'));
    assert.deepEqual(onDisk, { source: TECHNIQUE_INDEX.url, fetchedAt: new Date(NOW).toISOString(), data: [{ id: 'H37' }] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadResource: a fresh cache answers without touching the network', async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'techniques-index.json'), JSON.stringify({ source: 'x', fetchedAt: FRESH, data: [{ id: 'CACHED' }] }));
    const { impl, calls } = spy(htmlResponse('<a data-id="LIVE"></a>'));
    const data = await loadResource('techniques-index', { ...TECHNIQUE_INDEX, cacheDir: dir, now: NOW, fetchImpl: impl });
    assert.deepEqual(data, [{ id: 'CACHED' }]);
    assert.equal(calls.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadResource: stale cache + failed fetch -> the stale data, not an error', async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'techniques-index.json'), JSON.stringify({ source: 'x', fetchedAt: STALE, data: [{ id: 'OLD' }] }));
    const { impl, calls } = spy(new Error('ENOTFOUND'));
    const data = await loadResource('techniques-index', { ...TECHNIQUE_INDEX, cacheDir: dir, now: NOW, fetchImpl: impl });
    assert.deepEqual(data, [{ id: 'OLD' }]);
    assert.equal(calls.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadResource: a 200 that fails validation is not cached; the bundled floor answers', async () => {
  const dir = tmp();
  try {
    const { impl } = spy(htmlResponse('<html>WAF interstitial</html>'));
    const data = await loadResource('techniques-index', {
      ...TECHNIQUE_INDEX,
      bundled: () => [{ id: 'BUNDLED' }],
      cacheDir: dir,
      now: NOW,
      fetchImpl: impl,
    });
    assert.deepEqual(data, [{ id: 'BUNDLED' }]);
    assert.equal(existsSync(join(dir, 'techniques-index.json')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadResource: noNetwork with no cache and no bundle -> null, and fetch is never called', async () => {
  const dir = tmp();
  try {
    const { impl, calls } = spy(htmlResponse('<a data-id="LIVE"></a>'));
    const data = await loadResource('errata', { ...TECHNIQUE_INDEX, cacheDir: dir, now: NOW, fetchImpl: impl, noNetwork: true });
    assert.equal(data, null);
    assert.equal(calls.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadResource: --refresh ignores a fresh cache', async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'techniques-index.json'), JSON.stringify({ source: 'x', fetchedAt: FRESH, data: [{ id: 'CACHED' }] }));
    const { impl } = spy(htmlResponse('<a data-id="LIVE"></a>'));
    const data = await loadResource('techniques-index', { ...TECHNIQUE_INDEX, cacheDir: dir, now: NOW, fetchImpl: impl, refresh: true });
    assert.deepEqual(data, [{ id: 'LIVE' }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadResource: a slash in the name nests the cache file (techniques/H37.json)', async () => {
  const dir = tmp();
  try {
    const { impl } = spy(htmlResponse('<a data-id="H37"></a>'));
    await loadResource('techniques/H37', { ...TECHNIQUE_INDEX, cacheDir: dir, now: NOW, fetchImpl: impl });
    assert.equal(existsSync(join(dir, 'techniques', 'H37.json')), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadResource: refuses a name that would escape the cache directory', async () => {
  const dir = tmp();
  try {
    await assert.rejects(
      () => loadResource('../escape', { ...TECHNIQUE_INDEX, cacheDir: dir, now: NOW, fetchImpl: spy(htmlResponse('')).impl }),
      /name/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- versions ---------------------------------------------------------------

test('versionCacheDir: the default version keeps the historical directory, others get a subdirectory', () => {
  assert.equal(versionCacheDir('/c/wcag-cli', '2.2'), '/c/wcag-cli');
  assert.equal(versionCacheDir('/c/wcag-cli', '2.1'), '/c/wcag-cli/2.1');
  assert.equal(versionCacheDir(null, '2.1'), null);
});

test('loadDataset: version 2.1 fetches WCAG21/wcag.json and never falls back to the 2.2 bundle', async () => {
  const dir = tmp();
  try {
    const body = { principles: [{ guidelines: [{ successcriteria: [{ num: '1.1.1' }] }] }], terms: [] };
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, headers: init.headers });
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
    };
    const { wcag, meta } = await loadDataset({ version: '2.1', cacheDir: dir, now: NOW, fetchImpl });
    assert.deepEqual(wcag, body);
    assert.equal(meta.source, 'https://www.w3.org/WAI/WCAG21/wcag.json');
    assert.equal(calls[0].url, 'https://www.w3.org/WAI/WCAG21/wcag.json');
    // No validator: the bundle is 2.2 data and its ETag must not be sent for 2.1.
    assert.equal(calls[0].headers['If-None-Match'], undefined);
    assert.equal(calls[0].headers['If-Modified-Since'], undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadDataset: version 2.1 offline with no cache throws a clear error instead of serving 2.2 data', async () => {
  const dir = tmp();
  try {
    await assert.rejects(
      () => loadDataset({ version: '2.1', cacheDir: dir, now: NOW, noNetwork: true }),
      /WCAG 2\.1.*network/i
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadDataset: the default version still falls back to the bundle offline', async () => {
  const dir = tmp();
  try {
    const { wcag } = await loadDataset({ cacheDir: dir, now: NOW, noNetwork: true });
    assert.equal(wcag.principles.length, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadUnderstanding: version 2.1 uses the WCAG21 Understanding URL and the given criterion id', async () => {
  const dir = tmp();
  try {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      return htmlResponse('<section id="intent"><h2>Intent</h2><p>2.1 intent.</p></section>');
    };
    const entry = await loadUnderstanding('1.1.1', { version: '2.1', id: 'non-text-content', cacheDir: dir, now: NOW, fetchImpl });
    assert.equal(entry.intent, '2.1 intent.');
    assert.deepEqual(calls, ['https://www.w3.org/WAI/WCAG21/Understanding/non-text-content.html']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadUnderstanding: version 2.1 offline with no cache -> null, not the 2.2 bundled prose', async () => {
  const dir = tmp();
  try {
    const entry = await loadUnderstanding('1.1.1', { version: '2.1', id: 'non-text-content', cacheDir: dir, now: NOW, noNetwork: true });
    assert.equal(entry, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- request identity ---------------------------------------------------------

// Cloudflare in front of w3.org answered Node's default User-Agent ("node")
// with 429 on 2026-09-04 while the same requests with a descriptive agent got
// 200. Every fetch this CLI makes must identify itself.
test('every loader sends a wcag-cli User-Agent', async () => {
  const dir = tmp();
  try {
    const agents = [];
    const fetchImpl = async (url, init) => {
      agents.push(init?.headers?.['User-Agent']);
      if (url.endsWith('wcag.json')) {
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ principles: [{ guidelines: [{ successcriteria: [{ num: '1.1.1' }] }] }], terms: [] }) };
      }
      return htmlResponse('<section id="intent"><h2>Intent</h2><p>x</p></section><a data-id="X1"></a>');
    };
    await loadDataset({ version: '2.1', cacheDir: dir, now: NOW, fetchImpl });
    await loadUnderstanding('1.1.1', { version: '2.1', id: 'non-text-content', cacheDir: dir, now: NOW, fetchImpl });
    await loadResource('techniques-index', { ...TECHNIQUE_INDEX, cacheDir: dir, now: NOW, fetchImpl });
    assert.equal(agents.length, 3);
    for (const ua of agents) assert.match(ua ?? '', /^wcag-cli\/\d+\.\d+\.\d+ \(\+https:\/\/github\.com\/josippapez\/wcag-cli\)$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
