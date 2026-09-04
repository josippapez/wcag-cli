// Helpers added for the technique bodies, the W3C technique index, the
// Recommendation extras, the errata, key terms and version selection.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  configureDataset,
  getVersion,
  getAllTechniques,
  findTechnique,
  getTechniqueBody,
  getTechniqueBodyLocal,
  getSpecExtras,
  getErrata,
  relatedTerms,
  findSuccessCriterion,
  getNewInVersion,
  getRemovedInVersion,
  textResponse,
} from '../src/helpers.js';

function useBundledDataset(extra = {}) {
  configureDataset({ noNetwork: true, cacheDir: null, ...extra });
}

test('getVersion defaults to 2.2 and follows configureDataset', () => {
  useBundledDataset();
  assert.equal(getVersion(), '2.2');
  useBundledDataset({ version: '2.1' });
  assert.equal(getVersion(), '2.1');
  useBundledDataset();
});

test('getAllTechniques lists techniques no criterion references, from the W3C index', async () => {
  useBundledDataset();
  const all = await getAllTechniques();
  // F19 exists on w3.org but appears in no success criterion's technique tree.
  const f19 = all.find((t) => t.id === 'F19');
  assert.ok(f19, 'F19 missing');
  assert.equal(f19.technology, 'failures');
  assert.match(f19.title, /conforming version/i);
  assert.deepEqual(f19.criteria, []);
  assert.deepEqual(f19.types, []);
  assert.ok(all.length >= 432, `expected the full index, got ${all.length}`);
});

test('getAllTechniques keeps the criteria mapping for referenced techniques', async () => {
  useBundledDataset();
  const h37 = await findTechnique('h37');
  assert.equal(h37.id, 'H37');
  assert.ok(h37.criteria.includes('1.1.1'));
  assert.ok(h37.types.includes('sufficient'));
});

test('getTechniqueBody serves the bundled description, examples and tests offline', async () => {
  useBundledDataset();
  const body = await getTechniqueBody('H37');
  assert.ok(body.description.length >= 1);
  assert.ok(body.examples.length >= 2);
  assert.ok(body.tests.procedure.length >= 1);
  assert.ok(body.related.includes('G82'));
  assert.equal(await getTechniqueBody('NOPE1'), null);
});

test('getTechniqueBodyLocal never fetches, even when configured to refresh', async () => {
  let calls = 0;
  configureDataset({
    cacheDir: null,
    refresh: true,
    fetchImpl: async () => {
      calls++;
      throw new Error('must not be called');
    },
  });
  const body = await getTechniqueBodyLocal('H37');
  assert.ok(body.description.length >= 1);
  assert.equal(calls, 0);
  useBundledDataset();
});

test('getSpecExtras and getErrata come from the bundle offline', async () => {
  useBundledDataset();
  const spec = await getSpecExtras();
  assert.equal(spec.conformanceRequirements.length, 5);
  assert.equal(spec.conformanceRequirements[0].num, '5.2.1');
  assert.ok(spec.inputPurposes.some((p) => p.token === 'cc-number'));
  const errata = await getErrata();
  assert.ok(errata.length >= 28);
  assert.match(errata[0].date, /^\d{4}-\d{2}-\d{2}$/);
});

test('relatedTerms uses the Understanding Key Terms, so transitive terms appear', async () => {
  useBundledDataset();
  const { sc } = await findSuccessCriterion('2.5.8');
  const names = (await relatedTerms(sc)).map((t) => t.name);
  // Linked from the criterion text:
  assert.ok(names.includes('target'));
  // Only reachable through the definitions W3C lists under Key Terms:
  assert.ok(names.includes('assistive technology'), names.join(', '));
  assert.equal(names.length, 13);
});

test('getRemovedInVersion lists 4.1.1 for 2.2; getNewInVersion still lists the nine additions', async () => {
  useBundledDataset();
  const removed = await getRemovedInVersion('2.2');
  assert.deepEqual(removed.map((sc) => sc.num), ['4.1.1']);
  assert.equal((await getNewInVersion('2.2')).length, 9);
});

test('textResponse carries the structured payload alongside the text', () => {
  const res = textResponse('hello', { a: 1 });
  assert.equal(res.content[0].text, 'hello');
  assert.deepEqual(res.data, { a: 1 });
  assert.equal(textResponse('x').data, undefined);
});
