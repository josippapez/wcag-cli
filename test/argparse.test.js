import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgv, buildToolArgs } from '../src/argparse.js';

test('parseArgv: command + positional', () => {
  const r = parseArgv(['get-criterion', '1.1.1']);
  assert.equal(r.command, 'get-criterion');
  assert.deepEqual(r.positionals, ['1.1.1']);
  assert.equal(r.help, false);
});

test('parseArgv: --key value and --key=value', () => {
  const r = parseArgv(['search-wcag', 'keyboard', '--level', 'AA', '--x=1']);
  assert.equal(r.command, 'search-wcag');
  assert.deepEqual(r.positionals, ['keyboard']);
  assert.deepEqual(r.flags, { level: 'AA', x: '1' });
});

test('parseArgv: bare boolean flag', () => {
  const r = parseArgv(['get-criteria-by-level', 'AA', '--include_lower']);
  assert.equal(r.flags.include_lower, true);
});

test('parseArgv: --help detected and not stored', () => {
  const r = parseArgv(['get-criterion', '--help']);
  assert.equal(r.help, true);
  assert.deepEqual(r.flags, {});
});

test('parseArgv: no args', () => {
  const r = parseArgv([]);
  assert.equal(r.command, undefined);
  assert.equal(r.help, false);
});

const levelTool = {
  inputSchema: {
    properties: {
      level: { type: 'string', enum: ['A', 'AA', 'AAA'] },
      include_lower: { type: 'boolean' }
    },
    required: ['level']
  }
};

test('buildToolArgs: positional fills required', () => {
  const args = buildToolArgs(levelTool, ['AA'], {});
  assert.deepEqual(args, { level: 'AA' });
});

test('buildToolArgs: boolean flag coerced', () => {
  const args = buildToolArgs(levelTool, ['AA'], { include_lower: true });
  assert.deepEqual(args, { level: 'AA', include_lower: true });
});

test('buildToolArgs: undeclared flag ignored', () => {
  const args = buildToolArgs(levelTool, ['AA'], { bogus: 'x' });
  assert.deepEqual(args, { level: 'AA' });
});

const termTool = {
  inputSchema: {
    properties: {
      term: { type: 'string' }
    },
    required: ['term']
  }
};

test('buildToolArgs: single required string param joins multi-word positionals', () => {
  const args = buildToolArgs(termTool, ['contrast', 'ratio'], {});
  assert.deepEqual(args, { term: 'contrast ratio' });
});

test('buildToolArgs: single required string param still works with one positional', () => {
  const args = buildToolArgs(termTool, ['contrast'], {});
  assert.deepEqual(args, { term: 'contrast' });
});

const twoRequiredTool = {
  inputSchema: {
    properties: {
      a: { type: 'string' },
      b: { type: 'string' }
    },
    required: ['a', 'b']
  }
};

test('buildToolArgs: 2+ required params still receive separate positional values', () => {
  const args = buildToolArgs(twoRequiredTool, ['foo', 'bar'], {});
  assert.deepEqual(args, { a: 'foo', b: 'bar' });
});

const numericSingleRequiredTool = {
  inputSchema: {
    properties: {
      count: { type: 'number' }
    },
    required: ['count']
  }
};

test('buildToolArgs: single required non-string param is not joined', () => {
  const args = buildToolArgs(numericSingleRequiredTool, ['1', '2'], {});
  assert.deepEqual(args, { count: 1 });
});
