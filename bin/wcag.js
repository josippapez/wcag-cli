#!/usr/bin/env node
import { tools } from '../src/tools.js';
import { configureDataset } from '../src/helpers.js';
import { parseArgv, buildToolArgs } from '../src/argparse.js';
import { DEFAULT_VERSION, wcagUrls } from '../src/w3c.js';

// `--refresh` is owned by the CLI, not by any command's inputSchema, so it is
// lifted out of argv BEFORE parseArgv runs. That is the root fix rather than a
// patch-up afterwards: parseArgv cannot tell `--refresh` (boolean) from
// `--level AA` (valued), so left in place it swallowed the following token —
// `wcag --refresh get-criterion 1.4.3` parsed the command as "1.4.3", and no
// post-hoc repair could recover it because dispatch had already failed. Lifting
// it also keeps multi-word positionals in their original order wherever the
// flag was written.
//
// `--json` and `--wcag <version>` are lifted the same way and for the same
// reason. `--wcag` is the one global that takes a value, so it consumes the
// next token (or `--wcag=2.1`).
function extractGlobalFlags(argv) {
  const globals = { refresh: false, json: false, version: undefined };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--refresh') {
      globals.refresh = true;
    } else if (tok.startsWith('--refresh=')) {
      globals.refresh = tok.slice('--refresh='.length) !== 'false';
    } else if (tok === '--json') {
      globals.json = true;
    } else if (tok === '--wcag') {
      globals.version = argv[++i] ?? '';
    } else if (tok.startsWith('--wcag=')) {
      globals.version = tok.slice('--wcag='.length);
    } else {
      rest.push(tok);
    }
  }
  return { globals, rest };
}

function printCommandList() {
  const lines = tools.map((t) => `  ${t.name.padEnd(30)} ${t.description}`);
  process.stdout.write(
    `wcag — WCAG guidelines CLI (WCAG ${DEFAULT_VERSION} by default)\n\nUsage: wcag <command> [args] [--flags]\n       wcag <command> --help\n\nCommands:\n${lines.join('\n')}\n\nGlobal flags:\n  --json                         Print the structured data behind the answer as JSON instead of Markdown\n  --wcag <version>               Answer for another WCAG version, e.g. --wcag 2.1 (fetched from w3.org on first use)\n  --refresh                      Re-fetch the WCAG dataset from w3.org before answering\n\nEnvironment:\n  WCAG_CLI_VERSION=2.1           Default for --wcag\n  WCAG_CLI_NO_NETWORK=1          Never touch the network; answer from cache or the bundled data\n`
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
      const req = required.includes(name)
        ? ' (required, positional)'
        : p.positional
          ? ' (optional, positional or --flag)'
          : ' (optional, --flag)';
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
// `--refresh` is already gone, lifted by extractGlobalFlags. parseArgv could not
// know the flag was a boolean, so it consumed the following token as the flag's
// value; `swallowedAt` says which positional index that token came from, so it
// goes back exactly there. Reclaiming right-to-left keeps those indices valid
// when more than one boolean swallowed a token.
function reclaimBooleanFlagValues(tool, positionals, flags, swallowedAt = {}) {
  const props = tool.inputSchema?.properties ?? {};
  const reclaimed = Object.entries(flags)
    .filter(
      ([name, value]) =>
        props[name]?.type === 'boolean' &&
        typeof value === 'string' &&
        value !== 'true' &&
        value !== 'false'
    )
    .sort(([a], [b]) => (swallowedAt[b] ?? 0) - (swallowedAt[a] ?? 0));

  for (const [name, value] of reclaimed) {
    positionals.splice(swallowedAt[name] ?? 0, 0, value);
    flags[name] = true;
  }
}

async function main() {
  const { globals, rest } = extractGlobalFlags(process.argv.slice(2));
  const { command, positionals, flags, help, swallowedAt } = parseArgv(rest);

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

  reclaimBooleanFlagValues(tool, positionals, flags, swallowedAt);

  const args = buildToolArgs(tool, positionals, flags);
  const missing = (tool.inputSchema?.required ?? []).filter((name) => !(name in args));
  if (missing.length > 0) {
    // parseArgv runs before the schema is known, so any `--token` is read as a
    // flag. When a required positional is also missing, the likeliest reason is
    // that the token WAS the value -- say so, instead of reporting the missing
    // argument and leaving the user to work out where their value went. Only
    // tokens the command doesn't declare are called out; a real flag alongside
    // a genuinely forgotten positional still gets the plain message.
    const props = tool.inputSchema?.properties ?? {};
    const stray = Object.keys(flags).filter((name) => !props[name]).map((name) => `--${name}`);
    const hint = stray.length
      ? ` — ${stray.join(', ')} ${stray.length > 1 ? 'were read as flags, not values' : 'was read as a flag, not a value'}` +
        ` (positional values cannot begin with '--')`
      : '';
    process.stderr.write(
      `wcag: '${command}' requires argument(s): ${missing.join(', ')}${hint}. Run 'wcag ${command} --help'.\n`
    );
    process.exit(1);
    return;
  }

  // Must happen before the first lookup: it fixes the single dataset snapshot
  // every helper in this invocation will read. The CLI is the one place that
  // reads WCAG_CLI_NO_NETWORK, so the data layer has no ambient behaviour of
  // its own — that ambient read is exactly what made the loader tests depend on
  // the shell they ran in.
  //
  // The version is validated here, before any lookup, so a typo like
  // `--wcag 22` is a usage error and not a failed fetch of a URL that never
  // existed. The flag wins over WCAG_CLI_VERSION, which wins over the default.
  const version = globals.version ?? process.env.WCAG_CLI_VERSION ?? DEFAULT_VERSION;
  try {
    wcagUrls(version);
  } catch (err) {
    process.stderr.write(`wcag: ${err.message}\n`);
    process.exit(1);
    return;
  }
  configureDataset({
    refresh: globals.refresh,
    noNetwork: process.env.WCAG_CLI_NO_NETWORK === '1',
    version,
  });

  const res = await tool.handler(args);
  if (globals.json) {
    // Every command carries the structured payload its text was rendered
    // from; the text itself is the fallback for any that does not.
    const payload = res?.data ?? { text: res?.content?.[0]?.text ?? '' };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  const text = res?.content?.[0]?.text ?? '';
  process.stdout.write(text.endsWith('\n') ? text : text + '\n');
}

// `AbortSignal.timeout` rejects the fetch promise but does not tear down the
// connection attempt behind it: against a blackholed origin the refresh gives
// up at 5s, the answer prints, and the process then sits for ~5s more holding
// a socket nobody will ever read. That doubles the cost of exactly the case
// FETCH_TIMEOUT_MS exists to bound. Nothing is outstanding by the time main()
// resolves -- every cache write in the data layer is synchronous -- so the
// only thing left is to flush and leave.
//
// The flush is the whole safety condition, and it is not optional: stdout to a
// pipe is asynchronous, so a bare process.exit() here would truncate a large
// answer mid-write. The empty write's callback runs after every write already
// queued ahead of it, which is precisely "the answer is on its way out".
function exitWhenFlushed(code) {
  process.stdout.write('', () => process.exit(code));
}

main()
  .then(() => exitWhenFlushed(process.exitCode ?? 0))
  .catch((err) => {
    process.stderr.write(`wcag: ${err?.message ?? err}\n`);
    process.exit(1);
  });
