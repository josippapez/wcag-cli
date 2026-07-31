#!/usr/bin/env node
import { tools } from '../src/tools.js';
import { configureDataset } from '../src/helpers.js';
import { parseArgv, buildToolArgs } from '../src/argparse.js';

// `--refresh` is owned by the CLI, not by any command's inputSchema, so it is
// lifted out of argv BEFORE parseArgv runs. That is the root fix rather than a
// patch-up afterwards: parseArgv cannot tell `--refresh` (boolean) from
// `--level AA` (valued), so left in place it swallowed the following token —
// `wcag --refresh get-criterion 1.4.3` parsed the command as "1.4.3", and no
// post-hoc repair could recover it because dispatch had already failed. Lifting
// it also keeps multi-word positionals in their original order wherever the
// flag was written.
function extractGlobalFlags(argv) {
  const globals = { refresh: false };
  const rest = [];
  for (const tok of argv) {
    if (tok === '--refresh') {
      globals.refresh = true;
    } else if (tok.startsWith('--refresh=')) {
      globals.refresh = tok.slice('--refresh='.length) !== 'false';
    } else {
      rest.push(tok);
    }
  }
  return { globals, rest };
}

function printCommandList() {
  const lines = tools.map((t) => `  ${t.name.padEnd(30)} ${t.description}`);
  process.stdout.write(
    `wcag — WCAG 2.2 guidelines CLI\n\nUsage: wcag <command> [args] [--flags]\n       wcag <command> --help\n\nCommands:\n${lines.join('\n')}\n\nGlobal flags:\n  --refresh                      Re-fetch the WCAG dataset from w3.org before answering\n\nEnvironment:\n  WCAG_CLI_NO_NETWORK=1          Never touch the network; answer from cache or the bundled data\n`
  );
}

function printCommandHelp(tool) {
  const props = tool.inputSchema?.properties ?? {};
  const required = tool.inputSchema?.required ?? [];
  let out = `wcag ${tool.name}\n\n${tool.description}\n\n`;
  const names = Object.keys(props);
  if (names.length === 0) {
    out += 'No parameters.\n';
  } else {
    out += 'Parameters:\n';
    for (const name of names) {
      const p = props[name];
      const req = required.includes(name) ? ' (required, positional)' : ' (optional, --flag)';
      const en = p.enum ? ` [${p.enum.join('|')}]` : '';
      out += `  ${name}${req}${en} — ${p.description ?? ''}\n`;
    }
  }
  process.stdout.write(out);
}

// `--flag value` is indistinguishable from `--flag` at parse time, so argparse
// eagerly consumes the next token as the flag's value. For a boolean flag that
// silently swallows a positional: `wcag get-criterion --normative 1.4.3` lost
// the ref_id entirely and failed as a missing argument. Give it back.
//
// Only schema-declared booleans reach here (`--normative`, `--include_lower`);
// `--refresh` is already gone, lifted by extractGlobalFlags. The reclaimed token
// goes to the FRONT, which is right for the natural `--flag <value...>` writing.
// A flag wedged between the words of one positional (`contrast --normative
// ratio`) still comes back swapped: restoring true order needs the swallowed
// token's index, which only parseArgv knows, and src/argparse.js is owned by
// another chunk. So this is the better of the two approximations available here,
// not a full fix.
function reclaimBooleanFlagValues(tool, positionals, flags) {
  const props = tool.inputSchema?.properties ?? {};
  for (const [name, value] of Object.entries(flags)) {
    if (props[name]?.type === 'boolean' && typeof value === 'string' && value !== 'true' && value !== 'false') {
      positionals.unshift(value);
      flags[name] = true;
    }
  }
}

async function main() {
  const { globals, rest } = extractGlobalFlags(process.argv.slice(2));
  const { command, positionals, flags, help } = parseArgv(rest);

  if (command === undefined) {
    printCommandList();
    return;
  }

  const tool = tools.find((t) => t.name === command);
  if (!tool) {
    process.stderr.write(`wcag: unknown command '${command}'. Run 'wcag --help' for the list.\n`);
    process.exit(1);
    return;
  }

  if (help) {
    printCommandHelp(tool);
    return;
  }

  reclaimBooleanFlagValues(tool, positionals, flags);

  const args = buildToolArgs(tool, positionals, flags);
  const missing = (tool.inputSchema?.required ?? []).filter((name) => !(name in args));
  if (missing.length > 0) {
    process.stderr.write(
      `wcag: '${command}' requires argument(s): ${missing.join(', ')}. Run 'wcag ${command} --help'.\n`
    );
    process.exit(1);
    return;
  }

  // Must happen before the first lookup: it fixes the single dataset snapshot
  // every helper in this invocation will read. WCAG_CLI_NO_NETWORK is read by
  // src/data.js itself, so it is deliberately not threaded through here.
  configureDataset({ refresh: globals.refresh });

  const res = await tool.handler(args);
  const text = res?.content?.[0]?.text ?? '';
  process.stdout.write(text.endsWith('\n') ? text : text + '\n');
}

main().catch((err) => {
  process.stderr.write(`wcag: ${err?.message ?? err}\n`);
  process.exit(1);
});
