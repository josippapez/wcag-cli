# wcag-cli

A command-line interface for WCAG guidelines, techniques, and glossary — powered by official W3C data.

**wcag-cli** answers WCAG questions from your terminal — nothing to run, nothing to sign up for, and no round-trip before you get an answer. It owns its data end to end: the WCAG 2.2 dataset, the parsed Understanding documentation, every technique page, the conformance section and the errata are built straight from official W3C sources and bundled with the package, with no runtime dependencies. Another WCAG version, including a future one, is a flag away: `--wcag 2.1` fetches that version's data from w3.org and caches it, with no new release of this package.

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

# Read a technique: description, examples, test procedure
wcag get-technique H37

# List all techniques for a criterion
wcag get-techniques-for-criterion 2.4.7

# Get all AA-level criteria (including A)
wcag get-criteria-by-level AA --include_lower

# Find failure techniques for a criterion
wcag get-failures-for-criterion 1.4.3

# The ACT test rules W3C lists for a criterion
wcag get-test-rules-for-criterion 1.1.1

# See what a version added and removed
wcag whats-new

# Structured output for scripts and agents
wcag get-criterion 1.4.3 --json

# Another WCAG version
wcag --wcag 2.1 list-success-criteria --level AA
```

## Commands

### Core Commands

- **`list-principles`** — Lists the four WCAG principles: Perceivable, Operable, Understandable, and Robust.

- **`list-guidelines`** — Lists WCAG guidelines, optionally filtered by principle number (1-4).

- **`list-success-criteria`** — Lists WCAG success criteria with optional filters by level (A, AA, AAA), guideline (e.g., "1.1"), or principle (1-4).

- **`get-criterion`** — Gets full details for a specific WCAG success criterion by its reference number, including the complete Understanding documentation (Intent, Benefits, Examples, Resources) and the ACT test rules W3C lists for it.
  - Example: `wcag get-criterion 1.1.1`
  - `--normative` trims the output to the normative requirement and its exceptions, dropping the Understanding sections.
  - Example: `wcag get-criterion 1.4.3 --normative`

- **`get-success-criteria-detail`** — Alias for `get-criterion --normative`: the normative requirement and exception details, without Understanding documentation. The two produce byte-identical output; the alias exists so scripts written against the older command surface keep working.
  - Example: `wcag get-success-criteria-detail 1.4.3`

- **`get-guideline`** — Gets full details for a specific WCAG guideline including all its success criteria.

- **`search-wcag`** — Searches WCAG success criteria by keyword in titles and descriptions.
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

- **`list-techniques`** — Lists every published WCAG technique (432 for WCAG 2.2, from the W3C techniques index — including the ten no success criterion references), optionally filtered by technology (html, aria, css, pdf, general, etc.) or type (sufficient, advisory, failure).

- **`get-technique`** — Gets a technique by ID: what it applies to, its full description, its examples with code samples, the test procedure and expected results, related techniques and resources.
  - Example: `wcag get-technique H37`
  - `--brief` drops the examples and resources and keeps the description, tests and related techniques. Examples are the one section that gets large (a typical page is 3 KB, a third of it examples; the largest is 12.6 KB), so this is the flag for a reader who wants the procedure without the samples.
  - Example: `wcag get-technique H37 --brief`

- **`get-techniques-for-criterion`** — Gets all techniques (sufficient, advisory, and failures) for a specific success criterion.
  - Example: `wcag get-techniques-for-criterion 2.4.7`

- **`search-techniques`** — Searches techniques by keyword in titles.
  - `--description` also searches each technique's description, examples and tests, and reports which section matched. Local only, like `--understanding`.
  - Example: `wcag search-techniques "newsletter" --description`

- **`get-failures-for-criterion`** — Gets failure techniques (common mistakes) for a specific success criterion.
  - Example: `wcag get-failures-for-criterion 1.4.3`

### Glossary Commands

- **`get-glossary-term`** — Gets the definition of a WCAG glossary term.

- **`list-glossary-terms`** — Lists all WCAG glossary terms.

- **`search-glossary`** — Searches the WCAG glossary by keyword.

### Test Rules, Conformance, Errata

- **`get-test-rules-for-criterion`** — Lists the W3C-approved ACT test rules for a success criterion, with a link to each rule. Rules still awaiting approval are marked (proposed).
  - Example: `wcag get-test-rules-for-criterion 1.1.1`

- **`get-conformance-requirements`** — The five conformance requirements from section 5 of the Recommendation: conformance level, full pages, complete processes, accessibility-supported ways of using technologies, non-interference.

- **`list-input-purposes`** — The input purposes for user interface components from section 7 of the Recommendation: the 53 tokens (`name`, `email`, `cc-number`, ...) that 1.3.5 Identify Input Purpose requires to be programmatically determinable. Optionally filtered by keyword.
  - Example: `wcag list-input-purposes tel`

- **`list-errata`** — The published errata, newest first, grouped by the publication they amend, each with the pull request behind it.

### Enhanced Commands

- **`whats-new`** — Lists the success criteria the selected version added, and the ones it removed (for WCAG 2.2: nine added, 4.1.1 Parsing removed).
  - Example: `wcag whats-new`, `wcag --wcag 2.1 whats-new`

- **`whats-new-in-wcag22`** — Alias for `whats-new`, kept for existing scripts.

- **`get-full-criterion-context`** — Everything known about one criterion in a single answer: the overview, the "In Brief" summary, its exceptions, every sufficient/advisory/failure technique listed by ID *and* title, the glossary terms W3C lists as its Key Terms, and its test rules.
  - Example: `wcag get-full-criterion-context 1.1.1`

- **`get-server-info`** — Reports the CLI version, the WCAG version in use, the dataset snapshot (source URL, ETag, Last-Modified, fetch timestamp), where the runtime cache lives, and dataset statistics.
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

### Global flags

- **`--json`** — Print the structured data the answer was rendered from, as JSON, instead of Markdown. Every command has a payload; the shape follows the Markdown (a criterion has `num`, `handle`, `level`, `principle`, `guideline`, `text`, `details`, `understanding`, `testRules`, `links`; a search has `query` and ranked `results` with `score` and `matchedIn`). Valid anywhere on the command line.
  - Example: `wcag search-wcag keyboard --json | jq '.results[].num'`

- **`--wcag <version>`** — Answer for another WCAG version. Every w3.org URL is derived from the version, so this also works for a version published after this package was: `--wcag 2.1` today, `--wcag 2.3` the day W3C publishes it at the same paths. The first run for a version fetches its `wcag.json` (and, lazily, its Understanding and technique pages) into the cache; only WCAG 2.2 is bundled, so that first run needs network access and says so if it has none. `WCAG_CLI_VERSION=2.1` sets the default.

- **`--refresh`** — Re-fetch from w3.org before answering, ignoring the cache's age.

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

`search-wcag`, `search-techniques`, `search-glossary` and `list-input-purposes` share one matcher. It is
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
a corpus of 87 criteria, 432 techniques and a few megabytes of prose, that trade buys a
zero-dependency, offline, deterministic tool, and the results stay explainable.

## Data Freshness

The CLI never depends on the network to answer a question, but it will quietly keep itself current when it can.

- **Bundled baseline.** A complete WCAG 2.2 dataset ships in the package's `data/` directory — `wcag.json` as W3C publishes it, the parsed Understanding pages, the techniques index and every technique page, the conformance and input-purpose sections of the Recommendation, and the errata — so the very first command answers immediately, and every command keeps working with no cache and no network. It is also the floor a failed refresh falls back to — always at least as complete as the version you installed.
- **First run builds the cache.** The first command on a new install refreshes and writes the result to an XDG cache directory: `$XDG_CACHE_HOME/wcag-cli`, or `~/.cache/wcag-cli` when `XDG_CACHE_HOME` is unset (other versions live in a subdirectory, e.g. `~/.cache/wcag-cli/2.1`). `wcag get-server-info` prints the resolved path. Freshness then runs from your own first use rather than from the package's publish date.
- **One-week TTL.** A cached dataset is considered fresh for 7 days. Inside that window, no request is made at all.
- **Conditional refresh.** Once the TTL lapses, the next command issues a single conditional `GET` for `wcag.json`, sending the stored `ETag` as `If-None-Match` (or the stored `Last-Modified` as `If-Modified-Since`). A `304 Not Modified` touches only the fetch timestamp — the cached body is left exactly as it is, so the next week is free again. Only a `200` rewrites the data.
- **The first refresh is conditional too.** The bundle carries the `ETag` and `Last-Modified` it was captured under, so that first request already has a validator to send. If W3C has not republished since the package was built, it comes back `304` with an empty body and the bundle is promoted into the cache — no ~500K download to re-fetch data you already installed.
- **The cache is byte-for-byte what w3.org served.** The response body is stored verbatim rather than re-serialised, so the cached file is exactly the file the origin sent.
- **Understanding and technique pages refresh lazily, one page at a time.** The Intent/Benefits/Examples prose behind `get-criterion` and the body behind `get-technique` are cached and TTL-tracked *per page*, with their own timestamps independent of `wcag.json`'s. The first time you read a criterion or a technique, that one page is fetched and cached; after that it is reused until its own week is up. Only the page you asked for is ever fetched — bulk readers such as `search-wcag --understanding` and `search-techniques --description` stay entirely local, so no command ever pulls 87 or 432 pages at once.
- **The techniques index, the conformance section and the errata refresh weekly too**, each as a single request, so a technique W3C publishes tomorrow appears in `list-techniques` without a new release of this package.
- **Every request identifies itself** with a `wcag-cli/<version>` User-Agent.
- **Never hard-fails.** A refresh that cannot complete — offline, DNS failure, a `5xx`, a rate limit, an empty or malformed response — prints a note to stderr and answers from the cache or the bundled floor. A network problem never turns a lookup into an error. The one exception is the first run for a version that is not bundled (`--wcag 2.1` with no cache and no network), which has nothing to answer from and says so.

Two escape hatches:

```bash
# Force a refresh now, ignoring the TTL. Valid before or after the command.
wcag get-criterion 1.4.3 --refresh
wcag --refresh get-criterion 1.4.3

# Disable all network access for this invocation: answer from cache or bundle only.
WCAG_CLI_NO_NETWORK=1 wcag get-criterion 1.4.3
```

`WCAG_CLI_NO_NETWORK=1` wins over `--refresh` — set it in CI or in a test harness and the run is guaranteed offline and reproducible.

To move the *bundled* baseline forward (a maintainer task, followed by a republish), run the build script and commit the regenerated `data/`. It takes `wcag.json`, the Recommendation and the errata from w3.org, and the ~520 Understanding and technique pages from the WCAG Working Group's own GitHub Pages deployment of the same repository (`w3c.github.io/wcag`), one at a time: w3.org's Cloudflare front answers a burst of page requests with challenges that then block the machine for a long while, and the GitHub copy of those generated pages parses identically. `--pages-from w3.org` fetches the pages from w3.org instead, paced:

```bash
node scripts/fetch-data.mjs
node scripts/fetch-data.mjs --pages-from w3.org
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
