#!/usr/bin/env node
// debt: imports the dependency's internal src/tools.js — safe while
// wcag-guidelines-mcp has no "exports" map and is pinned by exact version.
// If upstream adds an exports map, vendor data/wcag.json + reimplement helpers.
import { tools } from 'wcag-guidelines-mcp/src/tools.js';
import { parseArgv, buildToolArgs } from '../src/argparse.js';

function printCommandList() {
  const lines = tools.map((t) => `  ${t.name.padEnd(30)} ${t.description}`);
  process.stdout.write(
    `wcag — WCAG 2.2 guidelines CLI\n\nUsage: wcag <command> [args] [--flags]\n       wcag <command> --help\n\nCommands:\n${lines.join('\n')}\n`
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

async function main() {
  const { command, positionals, flags, help } = parseArgv(process.argv.slice(2));

  if (command === undefined) {
    printCommandList();
    return;
  }

  const tool = tools.find((t) => t.name === command);
  if (!tool) {
    process.stderr.write(`wcag: unknown command '${command}'. Run 'wcag --help' for the list.\n`);
    process.exit(1);
  }

  if (help) {
    printCommandHelp(tool);
    return;
  }

  const args = buildToolArgs(tool, positionals, flags);
  const res = await tool.handler(args);
  const text = res?.content?.[0]?.text ?? '';
  process.stdout.write(text.endsWith('\n') ? text : text + '\n');
}

main().catch((err) => {
  process.stderr.write(`wcag: ${err?.message ?? err}\n`);
  process.exit(1);
});
