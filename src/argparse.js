/**
 * Parse process.argv.slice(2) into command, positionals, flags, help.
 *
 * This runs before the tool's schema is known, so `--flag value` is always read
 * as a flag taking a value. When the flag later turns out to be a boolean, the
 * token it consumed was really a positional — so record the index it would have
 * occupied in `swallowedAt`, letting the caller put it back where the user typed
 * it rather than guessing.
 */
export function parseArgv(argv) {
  const out = { command: undefined, positionals: [], flags: {}, help: false, swallowedAt: {} };
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
          out.swallowedAt[body] = out.positionals.length;
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
  // An optional filter can also be typed as bare words when its property is
  // marked `positional: true` and nothing is required (`list-input-purposes tel`).
  const optionalPositional =
    required.length === 0 &&
    Object.keys(props).find((name) => props[name].positional && props[name].type === 'string');
  if (required.length === 1 && props[required[0]]?.type === 'string') {
    const name = required[0];
    if (positionals.length > 0) args[name] = coerce(props[name], positionals.join(' '));
  } else if (optionalPositional) {
    if (positionals.length > 0) args[optionalPositional] = coerce(props[optionalPositional], positionals.join(' '));
  } else {
    required.forEach((name, idx) => {
      if (positionals[idx] !== undefined) args[name] = coerce(props[name], positionals[idx]);
    });
  }
  for (const [k, v] of Object.entries(flags)) {
    if (props[k]) args[k] = coerce(props[k], v);
  }
  return args;
}
