# wcag-cli

A command-line interface for WCAG 2.2 guidelines, techniques, and glossary — powered by official W3C data.

**wcag-cli** answers WCAG questions from your terminal — nothing to run, nothing to sign up for, and no round-trip before you get an answer. It owns its data end to end: the WCAG 2.2 dataset and the parsed Understanding documentation are built straight from official W3C sources and bundled with the package, with no runtime dependencies.

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
  - `--understanding` also searches the Understanding prose — In Brief, Intent,
    Benefits and Examples — and reports which section matched. Much of WCAG's
    practical guidance lives there rather than in the normative text, so a term
    like `placeholder` appears in no criterion title yet is discussed in several
    Intents. Bulk reads are always local (bundled snapshot plus existing cache),
    never a fetch, so one search cannot turn into 87 requests.
  - Example: `wcag search-wcag "placeholder" --understanding`

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

- **`get-server-info`** — Reports the CLI version, the dataset snapshot in use (source URL, ETag, Last-Modified, fetch timestamp), where the runtime cache lives, and dataset statistics.
  - Example: `wcag get-server-info`

## Usage

### Arguments

The CLI follows a simple argument convention:

- **Required arguments** are positional and must be provided in the order defined by the command's schema.
- **Optional arguments** are provided as `--flags` with values (e.g., `--include_lower`, `--principle 1`).

Flag order does not matter for the common cases: `wcag get-criterion --normative 1.4.3` and `wcag get-criterion 1.4.3 --normative` are equivalent.

Flag *position* does not matter either. A boolean flag written between the words
of a multi-word value is put back where you typed it, so
`wcag search-wcag contrast --understanding ratio` searches `contrast ratio`.

**Known limitation**: a positional value starting with `--` is parsed as a flag,
not a value, and is not supported — the CLI says so when it happens. A single
leading `-` is fine: `wcag search-wcag -webkit` searches for `-webkit`.

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

## How Searching Works

`search-wcag`, `search-techniques` and `search-glossary` share one matcher. It is
deliberately **lexical, not semantic** — no embeddings, no model, no network:

- **Word set, not substring.** Every query word must appear somewhere, in any
  order, so `focus keyboard` and `keyboard focus` return the same criteria. An
  extra word narrows the result rather than breaking it.
- **Light stemming.** `placeholders` finds `placeholder`, `pages` finds `page`.
  The stemmer is intentionally shy: it will not strip a suffix when the remainder
  would be too short to be meaningful.
- **Prefix matching.** `keyb` finds `keyboard`, `focus` finds `focusable`. Terms
  of one or two characters must match exactly.
- **Spelling and compound folding.** `colour`/`color` and
  `screenreader`/`screen reader` are treated as the same query, applied to both
  the query and the corpus.
- **Whole terms stay whole.** `1.4.3` and `aria-labelledby` are single tokens and
  are not split into their parts. Criterion numbers are searchable, so
  `search-wcag 1.4.3` finds that criterion and `search-wcag 2.4` finds all
  thirteen criteria under guideline 2.4.
- **Relevance ranked.** A hit in a criterion's name outranks the same word buried
  in an example. Equal scores keep dataset order, so output is byte-stable.

It has no idea what words *mean*. `alt text` will not find `text alternative`
by concept — only the small folding list above bridges wording differences. For
a corpus of 87 criteria and about a megabyte of prose, that trade buys a
zero-dependency, offline, deterministic tool, and the results stay explainable.

## Data Freshness

The CLI never depends on the network to answer a question, but it will quietly keep itself current when it can.

- **Bundled baseline.** A complete WCAG 2.2 dataset ships in the package's `data/` directory, so the very first command answers immediately, and every command keeps working with no cache and no network. It is also the floor a failed refresh falls back to — always at least as complete as the version you installed.
- **First run builds the cache.** The first command on a new install refreshes and writes the result to an XDG cache directory: `$XDG_CACHE_HOME/wcag-cli`, or `~/.cache/wcag-cli` when `XDG_CACHE_HOME` is unset. `wcag get-server-info` prints the resolved path. Freshness then runs from your own first use rather than from the package's publish date.
- **One-week TTL.** A cached dataset is considered fresh for 7 days. Inside that window, no request is made at all.
- **Conditional refresh.** Once the TTL lapses, the next command issues a single conditional `GET` for `wcag.json`, sending the stored `ETag` as `If-None-Match` (or the stored `Last-Modified` as `If-Modified-Since`). A `304 Not Modified` touches only the fetch timestamp — the cached body is left exactly as it is, so the next week is free again. Only a `200` rewrites the data.
- **The first refresh is conditional too.** The bundle carries the `ETag` and `Last-Modified` it was captured under, so that first request already has a validator to send. If W3C has not republished since the package was built, it comes back `304` with an empty body and the bundle is promoted into the cache — no ~500K download to re-fetch data you already installed.
- **The cache is byte-for-byte what w3.org served.** The response body is stored verbatim rather than re-serialised, so the cached file is exactly the file the origin sent.
- **Understanding pages refresh lazily, one criterion at a time.** The Intent/Benefits/Examples prose behind `get-criterion` is cached and TTL-tracked *per criterion*, with its own timestamp independent of `wcag.json`'s — so refreshing `wcag.json` does not invalidate all 87 pages. The first time you read a criterion, that one page is fetched and cached; after that it is reused until its own week is up. Only the criterion you asked for is ever fetched — bulk readers such as `search-wcag --understanding` stay entirely local, so no command ever pulls all 87 at once.
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

To move the *bundled* baseline forward (a maintainer task, followed by a republish), run the build script and commit the regenerated `data/`:

```bash
node scripts/fetch-data.mjs
```

To check a release against the ones before it, run the same command matrix over
several published versions and see where the output moved:

```bash
node scripts/compare-versions.mjs                    # 0.1.0, 0.2.0, latest
node scripts/compare-versions.mjs --local 0.2.0      # working tree vs 0.2.0
node scripts/compare-versions.mjs --show get-server-info
```

Each version is installed into a throwaway directory and run offline with a
scratch cache, so it compares code rather than data drift. It exits non-zero
only if the newest version fails a command an older one handled.

## Attribution

WCAG data © W3C, from the [W3C WCAG Repository](https://github.com/w3c/wcag), under the [W3C Document License](https://www.w3.org/copyright/document-license/).

`src/helpers.js` and `src/tools.js` are ports of the corresponding modules from [`wcag-guidelines-mcp`](https://www.npmjs.com/package/wcag-guidelines-mcp) 2.0.0 by Joe Watkins, used under the MIT License. The dataset those modules read is no longer that package's — it is built from W3C sources by `scripts/fetch-data.mjs` — but the output formatting and command surface derive from that work.

## License

MIT — see [LICENSE](LICENSE) for details.
