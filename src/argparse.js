/** Parse process.argv.slice(2) into command, positionals, flags, help. */
export function parseArgv(argv) {
  const out = { command: undefined, positionals: [], flags: {}, help: false };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--help' || tok === '-h') {
      out.help = true;
      continue;
    }
    if (tok.startsWith('--')) {
      const body = tok.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        out.flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          out.flags[body] = next;
          i++;
        } else {
          out.flags[body] = true;
        }
      }
      continue;
    }
    if (out.command === undefined) out.command = tok;
    else out.positionals.push(tok);
  }
  return out;
}

/** Build the handler args object from a tool's inputSchema. */
export function buildToolArgs(tool, positionals, flags) {
  const props = tool.inputSchema?.properties ?? {};
  const required = tool.inputSchema?.required ?? [];
  const args = {};
  const coerce = (prop, v) => {
    const t = prop?.type;
    if (t === 'boolean') return v === true || v === 'true';
    if (t === 'number' || t === 'integer') return Number(v);
    return String(v);
  };
  required.forEach((name, idx) => {
    if (positionals[idx] !== undefined) args[name] = coerce(props[name], positionals[idx]);
  });
  for (const [k, v] of Object.entries(flags)) {
    if (props[k]) args[k] = coerce(props[k], v);
  }
  return args;
}
