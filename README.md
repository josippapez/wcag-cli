# wcag-cli

A command-line interface for WCAG 2.2 guidelines, techniques, and glossary — powered by official W3C data.

**wcag-cli** is a zero-token-cost alternative to the WCAG MCP. It wraps the [`wcag-guidelines-mcp`](https://www.npmjs.com/package/wcag-guidelines-mcp) npm package to bring comprehensive WCAG 2.2 data to your terminal.

## Installation

```bash
# Global install
npm install -g wcag-cli

# Or run without install
npx wcag-cli <command>
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

- **`get-success-criteria-detail`** — Gets the normative success criterion requirements — just the title and exception details without Understanding documentation.

- **`get-criterion`** — Gets full details for a specific WCAG success criterion by its reference number.
  - Example: `wcag get-criterion 1.1.1`

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

- **`get-full-criterion-context`** — Gets comprehensive context for a success criterion including techniques, test rules, and related glossary terms.

- **`get-server-info`** — Returns information about this WCAG MCP server and data source.

## Usage

### Arguments

The CLI follows a simple argument convention:

- **Required arguments** are positional and must be provided in the order defined by the command's schema.
- **Optional arguments** are provided as `--flags` with values (e.g., `--include_lower`, `--principle 1`).

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

## Updating WCAG Data

WCAG data is shipped inside the pinned `wcag-guidelines-mcp` dependency. To update to newer WCAG data:

1. Bump the `wcag-guidelines-mcp` version in `package.json`
2. Run `npm install`
3. Republish `wcag-cli` to npm

## Attribution

WCAG data © W3C, from the W3C WCAG Repository (https://github.com/w3c/wcag), under the W3C Document License.

The CLI is a wrapper over the [`wcag-guidelines-mcp`](https://www.npmjs.com/package/wcag-guidelines-mcp) npm package by Joe Watkins.

## License

MIT — see [LICENSE](LICENSE) for details.
