// The 20 CLI commands. Each is `{ name, description, inputSchema, handler }`;
// bin/wcag.js dispatches by name, derives `--help` from `inputSchema`, and
// prints `handler(args).content[0].text`.
//
// Ported from the upstream WCAG MCP server's `src/tools.js` (see README for
// attribution). Output is byte-identical to
// that implementation except for the deviations marked "CHANGE" below, each of
// which is an intended fix recorded in
// .orchestration/own-wcag-data/issues/04-port-helpers-and-tools.md.
import { homedir } from 'node:os';

import { TTL_MS, CACHE_DIR } from './data.js';
import { WCAG_JSON_URL } from './w3c.js';
import {
  getPrinciples,
  getTerms,
  getMeta,
  getUnderstanding,
  packageVersion,
  stripHtml,
  htmlToText,
  truncate,
  getScUrl,
  getUnderstandingUrl,
  getQuickRefUrl,
  getTermUrl,
  REMOVED_LEVEL_LABEL,
  isRemoved,
  levelValue,
  levelTag,
  findPrinciple,
  findGuideline,
  findSuccessCriterion,
  getAllSuccessCriteria,
  getAllTechniques,
  findTechnique,
  techniqueNames,
  findTerm,
  searchTerms,
  relatedTerms,
  getNewInVersion,
  textResponse,
  getUnderstandingLocal,
  scoreFields,
  rankBy,
} from './helpers.js';

const NOT_FOUND_HINT = 'Use format like "1.1.1" or "2.4.7".';

function pluralise(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** Shared renderer for a criterion's normative `details` (exceptions, notes). */
function renderDetails(sc) {
  if (!sc.details || sc.details.length === 0) return '';
  let out = '## Details\n\n';
  for (const detail of sc.details) {
    if (detail.type === 'ulist' && detail.items) {
      for (const item of detail.items) {
        out += item.handle ? `- **${item.handle}:** ${item.text}\n` : `- ${item.text}\n`;
      }
      out += '\n';
    } else if (detail.type === 'note') {
      out += `> **${detail.handle}:** ${detail.text}\n\n`;
    } else if (detail.type === 'p') {
      out += `${detail.text}\n\n`;
    }
  }
  return out;
}

/** Shared renderer for the Understanding "In Brief" summary. */
function renderInBrief(understanding) {
  if (!understanding?.brief) return '';
  const brief = understanding.brief;
  let out = '## In Brief\n\n';
  if (brief.goal) out += `**Goal:** ${brief.goal}\n`;
  if (brief['what to do']) out += `**What to do:** ${brief['what to do']}\n`;
  if (brief["why it's important"]) out += `**Why it's important:** ${brief["why it's important"]}\n`;
  return `${out}\n`;
}

function renderLinks(sc) {
  return (
    '## Links\n\n' +
    `- [WCAG Specification](${getScUrl(sc)})\n` +
    `- [Understanding ${sc.num}](${getUnderstandingUrl(sc)})\n` +
    `- [How to Meet ${sc.num}](${getQuickRefUrl(sc)})\n`
  );
}

// CHANGE 2 + 3: one renderer for both the normative view (get-criterion
// --normative and its get-success-criteria-detail alias) and the full view
// (get-criterion), so the two can never drift. `**Level:**` goes through
// levelValue so 4.1.1 reads "Removed in WCAG 2.2" instead of blank.
async function renderCriterion({ principle, guideline, sc }, { normative }) {
  let output = `# ${sc.num} ${sc.handle}\n\n`;
  output += `**Level:** ${levelValue(sc)}\n`;
  output += `**Principle:** ${principle.num} ${principle.handle}\n`;
  output += `**Guideline:** ${guideline.num} ${guideline.handle}\n`;
  output += `**WCAG Versions:** ${sc.versions.join(', ')}\n\n`;

  const understanding = normative ? null : await getUnderstanding(sc.num);

  output += renderInBrief(understanding);

  output += normative
    ? `## Success Criterion\n\n${sc.title}\n\n`
    : `## Description\n\n${sc.title}\n\n`;

  output += renderDetails(sc);

  if (understanding?.intent) {
    output += `## Intent\n\n${understanding.intent}\n\n`;
  }

  if (understanding?.benefits?.length) {
    output += '## Benefits\n\n';
    for (const benefit of understanding.benefits) output += `- ${benefit}\n`;
    output += '\n';
  }

  if (understanding?.examples?.length) {
    output += '## Examples\n\n';
    let n = 0;
    for (const example of understanding.examples) {
      output += `### Example ${++n}\n\n${example}\n\n`;
    }
  }

  if (understanding?.resources?.length) {
    output += '## Resources\n\n';
    for (const resource of understanding.resources) {
      output += `- [${resource.title}](${resource.url})\n`;
    }
    output += '\n';
  }

  output += renderLinks(sc);
  return output;
}

const REF_ID_SCHEMA = {
  type: 'string',
  description: 'Success criterion reference number (e.g., "1.1.1", "2.4.7")',
};

// ============================================================================
// CORE WCAG TOOLS
// ============================================================================

const listPrinciples = {
  name: 'list-principles',
  description:
    'Lists all four WCAG 2.2 principles: Perceivable, Operable, Understandable, and Robust.',
  inputSchema: { type: 'object', properties: {}, required: [] },
  handler: async () => {
    const principles = await getPrinciples();
    const output = principles
      .map(
        (p) =>
          `**${p.num}. ${p.handle}**\n${stripHtml(p.content)}\nURL: https://www.w3.org/TR/WCAG22/#${p.id}`
      )
      .join('\n\n');
    return textResponse(`# WCAG 2.2 Principles\n\n${output}`);
  },
};

const listGuidelines = {
  name: 'list-guidelines',
  description: 'Lists WCAG 2.2 guidelines, optionally filtered by principle number (1-4).',
  inputSchema: {
    type: 'object',
    properties: {
      principle: {
        type: 'string',
        description:
          'Filter by principle number (1=Perceivable, 2=Operable, 3=Understandable, 4=Robust)',
        enum: ['1', '2', '3', '4'],
      },
    },
    required: [],
  },
  handler: async (args) => {
    let targetPrinciples = await getPrinciples();
    if (args.principle) {
      const p = await findPrinciple(args.principle);
      targetPrinciples = p ? [p] : [];
    }

    if (targetPrinciples.length === 0) {
      return textResponse('No principles found matching your criteria.');
    }

    const output = targetPrinciples
      .map((p) => {
        const guidelines = p.guidelines
          .map((g) => `  **${g.num} ${g.handle}**\n  ${stripHtml(g.content)}`)
          .join('\n\n');
        return `## Principle ${p.num}: ${p.handle}\n\n${guidelines}`;
      })
      .join('\n\n---\n\n');

    return textResponse(`# WCAG 2.2 Guidelines\n\n${output}`);
  },
};

const listSuccessCriteria = {
  name: 'list-success-criteria',
  description:
    'Lists WCAG 2.2 success criteria with optional filters by level (A, AA, AAA), guideline (e.g., "1.1"), or principle (1-4).',
  inputSchema: {
    type: 'object',
    properties: {
      level: { type: 'string', description: 'Filter by conformance level', enum: ['A', 'AA', 'AAA'] },
      guideline: {
        type: 'string',
        description: 'Filter by guideline number (e.g., "1.1", "2.4")',
      },
      principle: {
        type: 'string',
        description: 'Filter by principle number (1-4)',
        enum: ['1', '2', '3', '4'],
      },
    },
    required: [],
  },
  handler: async (args) => {
    const criteria = await getAllSuccessCriteria({
      level: args.level,
      guideline: args.guideline,
      principle: args.principle,
    });

    if (criteria.length === 0) {
      return textResponse('No success criteria found matching your filters.');
    }

    // CHANGE 3: levelTag, so a removed criterion is not listed as "(Level )".
    const output = criteria
      .map(
        (sc) =>
          `**${sc.num} ${sc.handle}** (${levelTag(sc)})\nGuideline: ${sc.guideline_num} ${sc.guideline_handle}`
      )
      .join('\n\n');

    const filterDesc = [];
    if (args.level) filterDesc.push(`Level: ${args.level}`);
    if (args.guideline) filterDesc.push(`Guideline: ${args.guideline}`);
    if (args.principle) filterDesc.push(`Principle: ${args.principle}`);
    const filterText = filterDesc.length > 0 ? `\nFilters: ${filterDesc.join(', ')}\n` : '';

    return textResponse(
      `# WCAG 2.2 Success Criteria (${criteria.length} found)\n${filterText}\n${output}`
    );
  },
};

// CHANGE 2: kept as a first-class tool (not folded into get-criterion) because
// bin/wcag.js dispatches on `tools.find(t => t.name === command)` and `--help`
// enumerates this array — a single tool with an internal branch would delete
// the alias and hide it from the command list.
const getSuccessCriteriaDetail = {
  name: 'get-success-criteria-detail',
  description:
    'Gets the normative success criterion requirements - just the title and exception details without Understanding documentation. Alias for "get-criterion --normative".',
  inputSchema: { type: 'object', properties: { ref_id: REF_ID_SCHEMA }, required: ['ref_id'] },
  handler: async (args) => {
    const result = await findSuccessCriterion(args.ref_id);
    if (!result) {
      return textResponse(
        `No success criterion found with number "${args.ref_id}". ${NOT_FOUND_HINT}`
      );
    }
    return textResponse(await renderCriterion(result, { normative: true }));
  },
};

const getCriterion = {
  name: 'get-criterion',
  description:
    'Gets full details for a specific WCAG success criterion by its reference number (e.g., "1.1.1", "2.4.7", "4.1.2"), including complete Understanding documentation. Pass --normative for the requirement and exceptions only.',
  inputSchema: {
    type: 'object',
    properties: {
      ref_id: REF_ID_SCHEMA,
      // Optional on purpose: src/argparse.js only joins multi-word positionals
      // when `required.length === 1`, so making this required would silently
      // break `get-criterion` for quoted/multi-word input.
      normative: {
        type: 'boolean',
        description:
          'Return only the normative requirement and its exceptions, without Understanding documentation',
      },
    },
    required: ['ref_id'],
  },
  handler: async (args) => {
    const result = await findSuccessCriterion(args.ref_id);
    if (!result) {
      return textResponse(
        `No success criterion found with number "${args.ref_id}". ${NOT_FOUND_HINT}`
      );
    }
    return textResponse(await renderCriterion(result, { normative: args.normative === true }));
  },
};

const getGuideline = {
  name: 'get-guideline',
  description: 'Gets full details for a specific WCAG guideline including all its success criteria.',
  inputSchema: {
    type: 'object',
    properties: {
      ref_id: {
        type: 'string',
        description: 'Guideline reference number (e.g., "1.1", "2.4", "4.1")',
      },
    },
    required: ['ref_id'],
  },
  handler: async (args) => {
    const result = await findGuideline(args.ref_id);
    if (!result) {
      return textResponse(
        `No guideline found with number "${args.ref_id}". Use format like "1.1" or "2.4".`
      );
    }

    const { principle, guideline } = result;

    let output = `# Guideline ${guideline.num}: ${guideline.handle}\n\n`;
    output += `**Principle:** ${principle.num} ${principle.handle}\n\n`;
    output += `## Description\n\n${stripHtml(guideline.content)}\n\n`;
    output += `**URL:** https://www.w3.org/TR/WCAG22/#${guideline.id}\n`;

    output += `\n## Success Criteria (${guideline.successcriteria.length})\n\n`;
    for (const sc of guideline.successcriteria) {
      output += `### ${sc.num} ${sc.handle} (${levelTag(sc)})\n`;
      output += `${truncate(sc.title, 200)}\n\n`;
    }

    return textResponse(output);
  },
};

const searchWcag = {
  name: 'search-wcag',
  description:
    'Searches WCAG 2.2 success criteria by keyword in titles and descriptions. Pass --understanding to also search the Understanding prose (intent, benefits, examples).',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query (searches titles and descriptions)' },
      level: {
        type: 'string',
        description: 'Optional: Filter results by conformance level',
        enum: ['A', 'AA', 'AAA'],
      },
      understanding: {
        type: 'boolean',
        description:
          'Also search the Understanding prose — intent, benefits and examples — and report which section matched',
      },
    },
    required: ['query'],
  },
  handler: async (args) => {
    const allCriteria = await getAllSuccessCriteria({ level: args.level });

    const understandingFields = async (sc) => {
      const u = await getUnderstandingLocal(sc.num);
      if (!u) return [];
      return [
        { label: 'In Brief', weight: 1, text: Object.values(u.brief ?? {}).join(' ') },
        { label: 'Intent', weight: 1, text: u.intent },
        { label: 'Benefits', weight: 1, text: u.benefits },
        { label: 'Examples', weight: 1, text: u.examples },
      ];
    };

    // Weighted so a term in the criterion's own handle outranks the same term
    // buried in an example, which is what makes ranking worth having at all.
    const scored = [];
    for (const [index, sc] of allCriteria.entries()) {
      const fields = [
        // The number is what people actually type when they know the criterion,
        // and it lived in no searched field: `search-wcag 1.4.3` found nothing.
        { label: 'Criterion', weight: 6, text: sc.num },
        { label: 'Criterion', weight: 5, text: sc.handle },
        { label: 'Criterion', weight: 3, text: `${sc.title} ${stripHtml(sc.content)}` },
        ...(args.understanding ? await understandingFields(sc) : []),
      ];
      const hit = scoreFields(args.query, fields);
      if (hit) scored.push({ sc, index, ...hit });
    }
    scored.sort((a, b) => b.score - a.score || a.index - b.index);

    if (scored.length === 0) {
      const hint = args.understanding
        ? ''
        : ' Try --understanding to search the Intent, Benefits and Examples prose as well.';
      return textResponse(
        `No success criteria found matching "${args.query}"${args.level ? ` at level ${args.level}` : ''}.${hint}`
      );
    }

    const output = scored
      .map(({ sc, labels }) => {
        const where = args.understanding ? `\nmatched in: ${labels.join(', ')}` : '';
        return `**${sc.num} ${sc.handle}** (${levelTag(sc)})\n${truncate(sc.title, 150)}${where}`;
      })
      .join('\n\n---\n\n');

    return textResponse(
      `# Search Results for "${args.query}" (${scored.length} found)\n\n${output}`
    );
  },
};

const getCriteriaByLevel = {
  name: 'get-criteria-by-level',
  description:
    'Gets all success criteria for a specific conformance level. Optionally includes lower levels (e.g., AA includes A).',
  inputSchema: {
    type: 'object',
    properties: {
      level: { type: 'string', description: 'Conformance level to retrieve', enum: ['A', 'AA', 'AAA'] },
      include_lower: {
        type: 'boolean',
        description:
          'If true, includes criteria from lower levels (e.g., AA query returns both A and AA criteria)',
      },
    },
    required: ['level'],
  },
  handler: async (args) => {
    const levelHierarchy = { A: ['A'], AA: ['A', 'AA'], AAA: ['A', 'AA', 'AAA'] };
    const levels = args.include_lower ? levelHierarchy[args.level] : [args.level];

    const criteria = await getAllSuccessCriteria({ levels });

    if (criteria.length === 0) {
      return textResponse(`No success criteria found for level ${args.level}.`);
    }

    const grouped = {};
    for (const sc of criteria) {
      (grouped[sc.level] ??= []).push(sc);
    }

    let output = `# WCAG 2.2 Level ${args.level}${args.include_lower ? ' (including lower levels)' : ''}\n\n`;
    output += `Total: ${criteria.length} success criteria\n\n`;

    for (const level of levels) {
      if (grouped[level]) {
        output += `## Level ${level} (${grouped[level].length} criteria)\n\n`;
        for (const sc of grouped[level]) output += `- **${sc.num}** ${sc.handle}\n`;
        output += '\n';
      }
    }

    return textResponse(output);
  },
};

const countCriteria = {
  name: 'count-criteria',
  description: 'Returns counts of success criteria grouped by level, principle, or guideline.',
  inputSchema: {
    type: 'object',
    properties: {
      group_by: {
        type: 'string',
        description: 'How to group the counts',
        enum: ['level', 'principle', 'guideline'],
      },
    },
    required: ['group_by'],
  },
  handler: async (args) => {
    const allCriteria = await getAllSuccessCriteria();
    const counts = {};

    for (const sc of allCriteria) {
      let key;
      switch (args.group_by) {
        case 'level':
          // CHANGE 3: was `Level ${sc.level}`, which produced "**Level **: 1"
          // for the criterion removed in WCAG 2.2. The four buckets still sum
          // to the printed total.
          key = levelTag(sc);
          break;
        case 'principle':
          key = `${sc.principle_num}. ${sc.principle_handle}`;
          break;
        case 'guideline':
          key = `${sc.guideline_num} ${sc.guideline_handle}`;
          break;
      }
      counts[key] = (counts[key] || 0) + 1;
    }

    const output = Object.entries(counts)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, count]) => `- **${key}**: ${count}`)
      .join('\n');

    const heading = args.group_by.charAt(0).toUpperCase() + args.group_by.slice(1);
    return textResponse(
      `# WCAG 2.2 Success Criteria by ${heading}\n\nTotal: ${allCriteria.length} success criteria\n\n${output}`
    );
  },
};

// ============================================================================
// TECHNIQUE TOOLS
// ============================================================================

const listTechniques = {
  name: 'list-techniques',
  description:
    'Lists WCAG techniques, optionally filtered by technology (html, aria, css, pdf, general, etc.) or type (sufficient, advisory, failure).',
  inputSchema: {
    type: 'object',
    properties: {
      technology: {
        type: 'string',
        description: 'Filter by technology',
        enum: [
          'html',
          'aria',
          'css',
          'pdf',
          'general',
          'client-side-script',
          'server-side-script',
          'smil',
          'text',
          'failures',
        ],
      },
      type: {
        type: 'string',
        description: 'Filter by technique type',
        enum: ['sufficient', 'advisory', 'failure'],
      },
    },
    required: [],
  },
  handler: async (args) => {
    let techniques = await getAllTechniques();

    if (args.technology) {
      techniques = techniques.filter((t) => t.technology === args.technology);
    }

    if (args.type) {
      techniques = techniques.filter((t) => t.types.includes(args.type));
    }

    if (techniques.length === 0) {
      return textResponse('No techniques found matching your filters.');
    }

    const grouped = {};
    for (const t of techniques) {
      (grouped[t.technology || 'other'] ??= []).push(t);
    }

    let output = `# WCAG Techniques (${techniques.length} found)\n\n`;

    for (const [tech, techs] of Object.entries(grouped).sort()) {
      output += `## ${tech.toUpperCase()} (${techs.length})\n\n`;
      for (const t of techs.sort((a, b) => a.id.localeCompare(b.id))) {
        output += `- **${t.id}**: ${t.title}\n`;
      }
      output += '\n';
    }

    return textResponse(output);
  },
};

const getTechnique = {
  name: 'get-technique',
  description: 'Gets details for a specific technique by ID (e.g., "H37", "ARIA1", "G94", "F65").',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Technique ID (e.g., "H37", "ARIA1", "G94", "F65")' },
    },
    required: ['id'],
  },
  handler: async (args) => {
    const technique = await findTechnique(args.id);

    if (!technique) {
      return textResponse(`No technique found with ID "${args.id}".`);
    }

    let output = `# ${technique.id}: ${technique.title}\n\n`;
    output += `**Technology:** ${technique.technology}\n`;
    output += `**Types:** ${technique.types.join(', ')}\n`;
    output += `**Applies to:** ${technique.criteria.length} success criteria\n\n`;

    output += '## Related Success Criteria\n\n';
    // Copy before sorting: `technique` comes from the memoised getAllTechniques
    // index, so an in-place sort would mutate shared state.
    for (const scNum of [...technique.criteria].sort()) {
      const result = await findSuccessCriterion(scNum);
      if (result) {
        output += `- **${scNum}** ${result.sc.handle} (${levelTag(result.sc)})\n`;
      }
    }

    output += '\n## Links\n\n';
    output += `- [Full Technique Documentation](https://www.w3.org/WAI/WCAG22/Techniques/${technique.technology}/${technique.id})\n`;

    return textResponse(output);
  },
};

const getTechniquesForCriterionTool = {
  name: 'get-techniques-for-criterion',
  description:
    'Gets all techniques (sufficient, advisory, and failures) for a specific success criterion.',
  inputSchema: { type: 'object', properties: { ref_id: REF_ID_SCHEMA }, required: ['ref_id'] },
  handler: async (args) => {
    const result = await findSuccessCriterion(args.ref_id);

    if (!result) {
      return textResponse(`No success criterion found with number "${args.ref_id}".`);
    }

    const { sc } = result;
    const techniques = sc.techniques || {};

    let output = `# Techniques for ${sc.num} ${sc.handle}\n\n`;

    const formatTechniques = (items, indent = '') => {
      let text = '';
      if (!items) return text;

      for (const item of items) {
        if (item.title && !item.id) {
          // An id-less entry is a "Situation X:" grouping header when it has
          // children, but W3C also lists techniques it has not published yet
          // ("... (future link)"). Those are leaves, and rendering them bold
          // put them in the list as if they were headings for the bullets
          // beneath them.
          const isGrouping =
            (item.techniques?.length ?? 0) > 0 || (item.groups?.length ?? 0) > 0;
          if (!isGrouping) {
            text += `${indent}- ${stripHtml(item.title)}\n`;
            continue;
          }
          text += `${indent}**${stripHtml(item.title)}**\n`;
          if (item.techniques) text += formatTechniques(item.techniques, `${indent}  `);
          for (const group of item.groups ?? []) {
            text += `${indent}  *${group.title}*\n`;
            text += formatTechniques(group.techniques, `${indent}    `);
          }
        } else if (item.id) {
          text += `${indent}- **${item.id}**: ${item.title}\n`;
          if (item.using) text += formatTechniques(item.using, `${indent}  `);
        } else if (item.and) {
          text += `${indent}- Combined techniques:\n`;
          for (const andItem of item.and) {
            if (andItem.id) text += `${indent}  - **${andItem.id}**: ${andItem.title}\n`;
          }
        }
      }
      return text;
    };

    for (const [type, heading] of [
      ['sufficient', 'Sufficient Techniques'],
      ['advisory', 'Advisory Techniques'],
      ['failure', 'Failure Techniques'],
    ]) {
      if (techniques[type]) {
        output += `## ${heading}\n\n`;
        output += formatTechniques(techniques[type]);
        output += '\n';
      }
    }

    return textResponse(output);
  },
};

const searchTechniques = {
  name: 'search-techniques',
  description: 'Searches techniques by keyword in titles.',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string', description: 'Search query' } },
    required: ['query'],
  },
  handler: async (args) => {
    const all = await getAllTechniques();
    const techniques = rankBy(all, (t) =>
      scoreFields(args.query, [
        { label: 'Id', weight: 5, text: t.id },
        { label: 'Title', weight: 3, text: t.title },
      ])
    ).map(({ item }) => item);

    if (techniques.length === 0) {
      return textResponse(`No techniques found matching "${args.query}".`);
    }

    const output = techniques.map((t) => `**${t.id}** (${t.technology}): ${t.title}`).join('\n');

    return textResponse(
      `# Technique Search Results for "${args.query}" (${techniques.length} found)\n\n${output}`
    );
  },
};

const getFailuresForCriterion = {
  name: 'get-failures-for-criterion',
  description: 'Gets failure techniques (common mistakes) for a specific success criterion.',
  inputSchema: { type: 'object', properties: { ref_id: REF_ID_SCHEMA }, required: ['ref_id'] },
  handler: async (args) => {
    const result = await findSuccessCriterion(args.ref_id);

    if (!result) {
      return textResponse(`No success criterion found with number "${args.ref_id}".`);
    }

    const { sc } = result;
    const failures = sc.techniques?.failure || [];

    if (failures.length === 0) {
      return textResponse(`No documented failure techniques for ${sc.num} ${sc.handle}.`);
    }

    let output = `# Failure Techniques for ${sc.num} ${sc.handle}\n\n`;
    output += 'These are common mistakes that would cause this success criterion to fail:\n\n';

    for (const item of failures) {
      if (item.id) output += `- **${item.id}**: ${item.title}\n`;
    }

    return textResponse(output);
  },
};

// ============================================================================
// GLOSSARY TOOLS
// ============================================================================

const getGlossaryTerm = {
  name: 'get-glossary-term',
  description: 'Gets the definition of a WCAG glossary term.',
  inputSchema: {
    type: 'object',
    properties: {
      term: {
        type: 'string',
        description:
          'The term to look up (e.g., "programmatically determined", "text alternative")',
      },
    },
    required: ['term'],
  },
  handler: async (args) => {
    const term = await findTerm(args.term);

    if (!term) {
      const similar = (await searchTerms(args.term)).slice(0, 5);
      if (similar.length > 0) {
        const suggestions = similar.map((t) => `- ${t.name}`).join('\n');
        return textResponse(`Term "${args.term}" not found. Did you mean:\n\n${suggestions}`);
      }
      return textResponse(`Term "${args.term}" not found in the WCAG glossary.`);
    }

    // CHANGE 5: htmlToText, not stripHtml — W3C definitions are block HTML and
    // flattening them ran notes into the preceding sentence.
    let output = `# ${term.name}\n\n`;
    output += `${htmlToText(term.definition)}\n\n`;
    output += `[View in WCAG 2.2 Glossary](${getTermUrl(term)})`;

    return textResponse(output);
  },
};

const listGlossaryTerms = {
  name: 'list-glossary-terms',
  description: 'Lists all WCAG glossary terms.',
  inputSchema: { type: 'object', properties: {}, required: [] },
  handler: async () => {
    const terms = await getTerms();
    const sortedTerms = [...terms].sort((a, b) => a.name.localeCompare(b.name));

    let output = `# WCAG 2.2 Glossary (${sortedTerms.length} terms)\n\n`;

    const grouped = {};
    for (const t of sortedTerms) {
      (grouped[t.name[0].toUpperCase()] ??= []).push(t);
    }

    for (const [letter, letterTerms] of Object.entries(grouped).sort()) {
      output += `## ${letter}\n\n`;
      for (const t of letterTerms) output += `- **${t.name}**\n`;
      output += '\n';
    }

    return textResponse(output);
  },
};

const searchGlossary = {
  name: 'search-glossary',
  description: 'Searches the WCAG glossary by keyword.',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string', description: 'Search query' } },
    required: ['query'],
  },
  handler: async (args) => {
    const matches = await searchTerms(args.query);

    if (matches.length === 0) {
      return textResponse(`No glossary terms found matching "${args.query}".`);
    }

    const output = matches
      .map((t) => `**${t.name}**\n${truncate(htmlToText(t.definition), 150)}`)
      .join('\n\n---\n\n');

    return textResponse(
      `# Glossary Search Results for "${args.query}" (${matches.length} found)\n\n${output}`
    );
  },
};

// ============================================================================
// ENHANCED CONTEXT TOOLS
// ============================================================================

const whatsNewInWcag22 = {
  name: 'whats-new-in-wcag22',
  description: 'Lists all success criteria that were added in WCAG 2.2.',
  inputSchema: { type: 'object', properties: {}, required: [] },
  handler: async () => {
    const newCriteria = await getNewInVersion('2.2');

    let output = "# What's New in WCAG 2.2\n\n";
    output += `WCAG 2.2 added ${newCriteria.length} new success criteria:\n\n`;

    const byLevel = { A: [], AA: [], AAA: [] };
    for (const sc of newCriteria) {
      byLevel[sc.level]?.push(sc);
    }

    for (const level of ['A', 'AA', 'AAA']) {
      if (byLevel[level].length > 0) {
        output += `## Level ${level}\n\n`;
        for (const sc of byLevel[level]) {
          output += `### ${sc.num} ${sc.handle}\n`;
          output += `${truncate(sc.title, 200)}\n\n`;
        }
      }
    }

    return textResponse(output);
  },
};

// CHANGE 1: upstream returned 687 bytes of counts only, while promising
// "techniques, test rules, and related glossary terms". It now delivers the
// overview, the technique NAMES per type, and the glossary terms the criterion
// actually links to. "Test rules" is dropped from the description: the W3C
// wcag.json we serve carries no ACT rule data, so the claim was unfulfillable.
const getFullCriterionContext = {
  name: 'get-full-criterion-context',
  description:
    'Gets comprehensive context for a success criterion: overview, In Brief summary, exceptions, every sufficient/advisory/failure technique by name, and the glossary terms it references.',
  inputSchema: { type: 'object', properties: { ref_id: REF_ID_SCHEMA }, required: ['ref_id'] },
  handler: async (args) => {
    const result = await findSuccessCriterion(args.ref_id);

    if (!result) {
      return textResponse(`No success criterion found with number "${args.ref_id}".`);
    }

    const { principle, guideline, sc } = result;

    let output = `# Complete Context: ${sc.num} ${sc.handle}\n\n`;

    output += '## Overview\n\n';
    output += `**Level:** ${levelValue(sc)}\n`;
    output += `**Principle:** ${principle.num} ${principle.handle}\n`;
    output += `**Guideline:** ${guideline.num} ${guideline.handle}\n`;
    output += `**WCAG Versions:** ${sc.versions.join(', ')}\n\n`;
    output += `${sc.title}\n\n`;

    output += renderInBrief(await getUnderstanding(sc.num));

    output += renderDetails(sc);

    const techniques = sc.techniques || {};
    const byType = {
      sufficient: techniqueNames(techniques.sufficient),
      advisory: techniqueNames(techniques.advisory),
      failure: techniqueNames(techniques.failure),
    };

    output += '## Techniques Summary\n\n';
    // CHANGE 1: "1 techniques" was a pluralisation bug.
    output += `- **Sufficient:** ${pluralise(byType.sufficient.length, 'technique')}\n`;
    output += `- **Advisory:** ${pluralise(byType.advisory.length, 'technique')}\n`;
    output += `- **Failure:** ${pluralise(byType.failure.length, 'technique')}\n\n`;

    for (const [type, heading] of [
      ['sufficient', 'Sufficient Techniques'],
      ['advisory', 'Advisory Techniques'],
      ['failure', 'Failure Techniques'],
    ]) {
      const list = byType[type];
      if (list.length === 0) continue;
      output += `## ${heading} (${list.length})\n\n`;
      for (const t of list) {
        output += `- **${t.id}**${t.technology ? ` (${t.technology})` : ''}: ${t.title}\n`;
      }
      output += '\n';
    }

    const related = await relatedTerms(sc);
    if (related.length > 0) {
      output += `## Related Glossary Terms (${related.length})\n\n`;
      for (const term of related) {
        // Lead paragraph only: a term's notes and examples are separate blocks
        // and would break out of this one-line-per-term list.
        const lead = htmlToText(term.definition).split('\n\n')[0];
        output += `- **${term.name}** — ${truncate(lead, 150)}\n`;
      }
      output += '\n';
    }

    output += renderLinks(sc);

    return textResponse(output);
  },
};

// CHANGE 4: rewritten for a CLI. The old text self-described as an MCP server,
// hard-coded v2.0.0, and cited the dependency this package no longer has.
// Reports what a CLI user actually needs: which version they run, which dataset
// snapshot answers their lookups, and where/when it refreshes.
function displayPath(path) {
  if (!path) return '(unavailable)';
  try {
    const home = homedir();
    return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
  } catch {
    return path;
  }
}

const getServerInfo = {
  name: 'get-server-info',
  description: 'Returns the CLI version, the WCAG dataset snapshot in use, and dataset statistics.',
  inputSchema: { type: 'object', properties: {}, required: [] },
  handler: async () => {
    const [principles, terms, meta, allCriteria, allTechniques] = await Promise.all([
      getPrinciples(),
      getTerms(),
      getMeta(),
      getAllSuccessCriteria(),
      getAllTechniques(),
    ]);

    const levelCounts = { A: 0, AA: 0, AAA: 0, removed: 0 };
    for (const sc of allCriteria) {
      if (isRemoved(sc)) levelCounts.removed++;
      else levelCounts[sc.level]++;
    }

    const ttlDays = Math.round(TTL_MS / 86400000);

    let output = `**wcag** v${packageVersion()}\n\n`;
    output +=
      'Command-line lookup for WCAG 2.2 success criteria, techniques and glossary, served from official W3C data bundled with this package and refreshed from w3.org on demand.\n\n';

    output += '## Dataset\n\n';
    output += `- **Source:** ${meta?.source ?? WCAG_JSON_URL}\n`;
    output += `- **ETag:** ${meta?.etag ?? '(none)'}\n`;
    output += `- **Last-Modified:** ${meta?.lastModified ?? '(none)'}\n`;
    output += `- **Fetched:** ${meta?.fetchedAt ?? '(unknown)'}\n`;
    output += `- **SHA-256:** ${meta?.sha256 ?? '(unknown)'}\n`;
    output += '- **Understanding docs:** parsed from the official W3C Understanding HTML pages\n';
    output += '- **WCAG version:** 2.2\n\n';

    output += '## Cache\n\n';
    output += `- **Directory:** ${displayPath(CACHE_DIR)}\n`;
    output += `- **Refresh interval:** ${pluralise(ttlDays, 'day')}\n`;
    output += '- **Force a refresh:** `wcag <command> --refresh`\n';
    output += '- **Stay offline:** set `WCAG_CLI_NO_NETWORK=1`\n\n';

    output += '## Statistics\n\n';
    output += `- **Principles:** ${principles.length}\n`;
    output += `- **Guidelines:** ${principles.reduce((sum, p) => sum + p.guidelines.length, 0)}\n`;
    output += `- **Success Criteria:** ${allCriteria.length} (Level A: ${levelCounts.A}, AA: ${levelCounts.AA}, AAA: ${levelCounts.AAA}, ${REMOVED_LEVEL_LABEL}: ${levelCounts.removed})\n`;
    output += `- **Techniques:** ${allTechniques.length}\n`;
    output += `- **Glossary Terms:** ${terms.length}\n\n`;

    output += '## Attribution\n\n';
    output +=
      'WCAG data from the [W3C WCAG Repository](https://github.com/w3c/wcag) ([W3C Document License](https://www.w3.org/copyright/document-license/)).\n\n';
    output +=
      'This software includes material copied from or derived from Web Content Accessibility Guidelines (WCAG) 2.2. Copyright © 2023 W3C® (MIT, ERCIM, Keio, Beihang).';

    return textResponse(output);
  },
};

// ============================================================================
// EXPORT ALL TOOLS
// ============================================================================

export const tools = [
  // Core WCAG tools
  listPrinciples,
  listGuidelines,
  listSuccessCriteria,
  getSuccessCriteriaDetail,
  getCriterion,
  getGuideline,
  searchWcag,
  getCriteriaByLevel,
  countCriteria,

  // Technique tools
  listTechniques,
  getTechnique,
  getTechniquesForCriterionTool,
  searchTechniques,
  getFailuresForCriterion,

  // Glossary tools
  getGlossaryTerm,
  listGlossaryTerms,
  searchGlossary,

  // Enhanced context tools
  whatsNewInWcag22,
  getFullCriterionContext,

  // Server info
  getServerInfo,
];
