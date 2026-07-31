# wcag-cli

A command-line interface for WCAG 2.2 guidelines, techniques, and glossary — powered by official W3C data.

**wcag-cli** is a zero-token-cost alternative to a WCAG MCP server: the same lookups, answered by a local command instead of a model round-trip. It owns its data end to end — the WCAG 2.2 dataset and the parsed Understanding documentation are built straight from W3C sources and bundled with the package, with no runtime dependencies.

## Installation

```bash
# Global install
npm install -g @rawwee/wcag-cli

# Or run without install
npx @rawwee/wcag-cli <command>
```

**Requirements**: Node.js ≥ 18.0.0

## Quick Start

```bash
# Get details for a specific criterion
wcag get-criterion 1.1.1

# Search for criteria by keyword
wcag search-wcag "keyboard"

# List all techniques for a criterion
wcag get-techniques-for-criterion 2.4.7

# Get all AA-level criteria (including A)
wcag get-criteria-by-level AA --include_lower

# Find failure techniques for a criterion
wcag get-failures-for-criterion 1.4.3

# See what's new in WCAG 2.2
wcag whats-new-in-wcag22
```

## Commands

### Core Commands

- **`list-principles`** — Lists all four WCAG 2.2 principles: Perceivable, Operable, Understandable, and Robust.

- **`list-guidelines`** — Lists WCAG 2.2 guidelines, optionally filtered by principle number (1-4).

- **`list-success-criteria`** — Lists WCAG 2.2 success criteria with optional filters by level (A, AA, AAA), guideline (e.g., "1.1"), or principle (1-4).

- **`get-criterion`** — Gets full details for a specific WCAG success criterion by its reference number, including the complete Understanding documentation (Intent, Benefits, Examples, Resources).
  - Example: `wcag get-criterion 1.1.1`
  - `--normative` trims the output to the normative requirement and its exceptions, dropping the Understanding sections.
  - Example: `wcag get-criterion 1.4.3 --normative`

- **`get-success-criteria-detail`** — Alias for `get-criterion --normative`: the normative requirement and exception details, without Understanding documentation. The two produce byte-identical output; the alias exists so scripts written against the older command surface keep working.
  - Example: `wcag get-success-criteria-detail 1.4.3`

- **`get-guideline`** — Gets full details for a specific WCAG guideline including all its success criteria.

- **`search-wcag`** — Searches WCAG 2.2 success criteria by keyword in titles and descriptions.
  - Example: `wcag search-wcag "keyboard"`

- **`get-criteria-by-level`** — Gets all success criteria for a specific conformance level. Optionally includes lower levels (e.g., AA includes A).
  - Example: `wcag get-criteria-by-level AA --include_lower`

- **`count-criteria`** — Returns counts of success criteria grouped by level, principle, or guideline.

### Techniques Commands

- **`list-techniques`** — Lists WCAG techniques, optionally filtered by technology (html, aria, css, pdf, general, etc.) or type (sufficient, advisory, failure).

- **`get-technique`** — Gets details for a specific technique by ID.
  - Example: `wcag get-technique H37`

- **`get-techniques-for-criterion`** — Gets all techniques (sufficient, advisory, and failures) for a specific success criterion.
  - Example: `wcag get-techniques-for-criterion 2.4.7`

- **`search-techniques`** — Searches techniques by keyword in titles.

- **`get-failures-for-criterion`** — Gets failure techniques (common mistakes) for a specific success criterion.
  - Example: `wcag get-failures-for-criterion 1.4.3`

### Glossary Commands

- **`get-glossary-term`** — Gets the definition of a WCAG glossary term.

- **`list-glossary-terms`** — Lists all WCAG glossary terms.

- **`search-glossary`** — Searches the WCAG glossary by keyword.

### Enhanced Commands

- **`whats-new-in-wcag22`** — Lists all success criteria that were added in WCAG 2.2.
  - Example: `wcag whats-new-in-wcag22`

- **`get-full-criterion-context`** — Everything known about one criterion in a single answer: the overview, the "In Brief" summary, its exceptions, every sufficient/advisory/failure technique listed by ID *and* title, and the glossary terms the criterion's text references.
  - Example: `wcag get-full-criterion-context 1.1.1`

- **`get-server-info`** — Reports the CLI version, the dataset snapshot in use (source URL, ETag, Last-Modified, fetch timestamp, SHA-256), where the runtime cache lives, and dataset statistics.
  - Example: `wcag get-server-info`

## Usage

### Arguments

The CLI follows a simple argument convention:

- **Required arguments** are positional and must be provided in the order defined by the command's schema.
- **Optional arguments** are provided as `--flags` with values (e.g., `--include_lower`, `--principle 1`).

Flag order does not matter for the common cases: `wcag get-criterion --normative 1.4.3` and `wcag get-criterion 1.4.3 --normative` are equivalent.

**Known limitations**:
- A command's own boolean flag wedged *between the words* of one multi-word positional reorders them — `wcag get-criterion contrast --normative ratio` looks up `ratio contrast`. Put the flag before or after the whole value, not inside it. (The global `--refresh` is unaffected.)
- Positional values starting with `-` or `--` are parsed as flags, not positionals, and are not supported.

### Getting Help

```bash
# List all available commands
wcag
wcag --help

# Get help for a specific command
wcag <command> --help

# Examples:
wcag get-criterion --help
wcag search-wcag --help
wcag get-criteria-by-level --help
```

## Data Freshness

The CLI never depends on the network to answer a question, but it will quietly keep itself current when it can.

- **Bundled floor.** A complete WCAG 2.2 dataset ships in the package's `data/` directory. If there is no cache and no network, every command still answers from it. This is a floor, not a fallback of last resort — it is always at least as complete as the version you installed.
- **Runtime cache.** Refreshed data is written to an XDG cache directory: `$XDG_CACHE_HOME/wcag-cli`, or `~/.cache/wcag-cli` when `XDG_CACHE_HOME` is unset. `wcag get-server-info` prints the resolved path.
- **One-week TTL.** A cached dataset is considered fresh for 7 days. Inside that window, no request is made at all.
- **Conditional refresh.** Once the TTL lapses, the next command issues a single conditional `GET` for `wcag.json`, sending the stored `ETag` as `If-None-Match` (or the stored `Last-Modified` as `If-Modified-Since`). A `304 Not Modified` touches only the fetch timestamp — the cached body is left exactly as it is, so the next week is free again. Only a `200` rewrites the data.
- **Understanding pages refresh lazily, one criterion at a time.** The Intent/Benefits/Examples prose behind `get-criterion` is cached and TTL-tracked *per criterion*, with its own timestamp independent of `wcag.json`'s — so refreshing `wcag.json` does not invalidate all 87 pages. When one criterion's entry goes stale, only that page is fetched, and unconditionally rather than with a validator. No command ever pulls all 87 at once.
- **Never hard-fails.** A refresh that cannot complete — offline, DNS failure, a `5xx`, an empty or malformed response — prints a note to stderr and answers from the cache or the bundled floor. A network problem never turns a lookup into an error.

Two escape hatches:

```bash
# Force a refresh now, ignoring the TTL. Valid before or after the command.
wcag get-criterion 1.4.3 --refresh
wcag --refresh get-criterion 1.4.3

# Disable all network access for this invocation: answer from cache or bundle only.
WCAG_CLI_NO_NETWORK=1 wcag get-criterion 1.4.3
```

`WCAG_CLI_NO_NETWORK=1` wins over `--refresh` — set it in CI or in a test harness and the run is guaranteed offline and reproducible.

To move the *bundled* floor forward (a maintainer task, followed by a republish), run the build script and commit the regenerated `data/`:

```bash
node scripts/fetch-data.mjs
```

## Attribution

WCAG data © W3C, from the [W3C WCAG Repository](https://github.com/w3c/wcag), under the [W3C Document License](https://www.w3.org/copyright/document-license/).

`src/helpers.js` and `src/tools.js` are ports of the corresponding modules from [`wcag-guidelines-mcp`](https://www.npmjs.com/package/wcag-guidelines-mcp) 2.0.0 by Joe Watkins, used under the MIT License. The dataset those modules read is no longer that package's — it is built from W3C sources by `scripts/fetch-data.mjs` — but the output formatting and command surface derive from that work.

## License

MIT — see [LICENSE](LICENSE) for details.
