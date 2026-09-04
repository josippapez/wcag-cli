// The CLI commands. Each is `{ name, description, inputSchema, handler }`;
// bin/wcag.js dispatches by name, derives `--help` from `inputSchema`, and
// prints `handler(args).content[0].text` -- or, under `--json`, the structured
// `data` the text was rendered from.
//
// Ported from `wcag-guidelines-mcp`'s `src/tools.js` (see README for
// attribution). Output is byte-identical to
// that implementation except for the deviations marked "CHANGE" below, each of
// which is an intended fix recorded in
// .orchestration/own-wcag-data/issues/04-port-helpers-and-tools.md.
//
// Nothing here names a WCAG version: every "WCAG x.y" in the output and every
// w3.org link comes from the configured version, so `--wcag 2.1` (or a future
// 2.x) is served by the same code.
import { homedir } from 'node:os';

import { TTL_MS, CACHE_DIR, versionCacheDir } from './data.js';
import {
  getPrinciples,
  getTerms,
  getMeta,
  getUnderstanding,
  getUnderstandingLocal,
  getVersion,
  urls,
  packageVersion,
  stripHtml,
  htmlToText,
  truncate,
  getScUrl,
  getUnderstandingUrl,
  getQuickRefUrl,
  getTermUrl,
  removedLevelLabel,
  isRemoved,
  levelValue,
  levelTag,
  findPrinciple,
  findGuideline,
  findSuccessCriterion,
  getAllSuccessCriteria,
  getAllTechniques,
  findTechnique,
  getTechniqueBody,
  getTechniqueBodyLocal,
  getSpecExtras,
  getErrata,
  techniqueNames,
  findTerm,
  searchTerms,
  relatedTerms,
  getNewInVersion,
  getRemovedInVersion,
  textResponse,
  scoreFields,
  rankBy,
} from './helpers.js';

const NOT_FOUND_HINT = 'Use format like "1.1.1" or "2.4.7".';

const wcag = () => `WCAG ${getVersion()}`;

function pluralise(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

// ============================================================================
// SHARED RENDERERS AND PAYLOADS
// ============================================================================

/** The fields every list row and JSON summary of a criterion carries. */
function criterionSummary(sc) {
  return {
    num: sc.num,
    handle: sc.handle,
    id: sc.id,
    level: isRemoved(sc) ? null : sc.level,
    removed: isRemoved(sc),
    versions: sc.versions ?? [],
  };
}

function summaryWithGuideline(sc) {
  return {
    ...criterionSummary(sc),
    guideline: { num: sc.guideline_num, handle: sc.guideline_handle },
    principle: { num: sc.principle_num, handle: sc.principle_handle },
  };
}

/** The structured form of one criterion, as `--json` prints it. */
function criterionData({ principle, guideline, sc }, understanding) {
  return {
    version: getVersion(),
    ...criterionSummary(sc),
    principle: { num: principle.num, handle: principle.handle },
    guideline: { num: guideline.num, handle: guideline.handle },
    text: sc.title,
    details: sc.details ?? [],
    understanding: understanding
      ? {
          brief: understanding.brief ?? {},
          intent: understanding.intent ?? '',
          benefits: understanding.benefits ?? [],
          examples: understanding.examples ?? [],
          resources: understanding.resources ?? [],
        }
      : null,
    testRules: understanding?.testRules ?? [],
    links: { spec: getScUrl(sc), understanding: getUnderstandingUrl(sc), quickref: getQuickRefUrl(sc) },
  };
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

// ACT rules W3C lists for the criterion. Only rendered when there are some:
// most criteria have none, and an empty heading would be noise.
function renderTestRules(testRules, heading = '## Test Rules') {
  if (!testRules?.length) return '';
  let out = `${heading}\n\n`;
  for (const rule of testRules) {
    out += `- [${rule.title}](${rule.url})${rule.proposed ? ' (proposed)' : ''}\n`;
  }
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
async function renderCriterion(result, { normative }) {
  const { principle, guideline, sc } = result;
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

  output += renderTestRules(understanding?.testRules);

  output += renderLinks(sc);
  return textResponse(output, criterionData(result, understanding));
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
    'Lists all four WCAG principles: Perceivable, Operable, Understandable, and Robust.',
  inputSchema: { type: 'object', properties: {}, required: [] },
  handler: async () => {
    const principles = await getPrinciples();
    const rows = principles.map((p) => ({
      num: p.num,
      handle: p.handle,
      description: stripHtml(p.content),
      url: `${urls().spec}#${p.id}`,
    }));
    const output = rows
      .map((p) => `**${p.num}. ${p.handle}**\n${p.description}\nURL: ${p.url}`)
      .join('\n\n');
    return textResponse(`# ${wcag()} Principles\n\n${output}`, { version: getVersion(), principles: rows });
  },
};

const listGuidelines = {
  name: 'list-guidelines',
  description: 'Lists WCAG guidelines, optionally filtered by principle number (1-4).',
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
      return textResponse('No principles found matching your criteria.', {
        version: getVersion(),
        principles: [],
      });
    }

    const rows = targetPrinciples.map((p) => ({
      num: p.num,
      handle: p.handle,
      guidelines: p.guidelines.map((g) => ({
        num: g.num,
        handle: g.handle,
        description: stripHtml(g.content),
      })),
    }));

    const output = rows
      .map((p) => {
        const guidelines = p.guidelines
          .map((g) => `  **${g.num} ${g.handle}**\n  ${g.description}`)
          .join('\n\n');
        return `## Principle ${p.num}: ${p.handle}\n\n${guidelines}`;
      })
      .join('\n\n---\n\n');

    return textResponse(`# ${wcag()} Guidelines\n\n${output}`, { version: getVersion(), principles: rows });
  },
};

const listSuccessCriteria = {
  name: 'list-success-criteria',
  description:
    'Lists WCAG success criteria with optional filters by level (A, AA, AAA), guideline (e.g., "1.1"), or principle (1-4).',
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
    const filters = { level: args.level ?? null, guideline: args.guideline ?? null, principle: args.principle ?? null };
    const data = { version: getVersion(), filters, criteria: criteria.map(summaryWithGuideline) };

    if (criteria.length === 0) {
      return textResponse('No success criteria found matching your filters.', data);
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
      `# ${wcag()} Success Criteria (${criteria.length} found)\n${filterText}\n${output}`,
      data
    );
  },
};

function notFoundCriterion(refId, hint = ` ${NOT_FOUND_HINT}`) {
  return textResponse(`No success criterion found with number "${refId}".${hint}`, {
    version: getVersion(),
    error: 'not_found',
    ref_id: refId,
  });
}

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
    if (!result) return notFoundCriterion(args.ref_id);
    return renderCriterion(result, { normative: true });
  },
};

const getCriterion = {
  name: 'get-criterion',
  description:
    'Gets full details for a specific WCAG success criterion by its reference number (e.g., "1.1.1", "2.4.7", "4.1.2"), including complete Understanding documentation and its test rules. Pass --normative for the requirement and exceptions only.',
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
    if (!result) return notFoundCriterion(args.ref_id);
    return renderCriterion(result, { normative: args.normative === true });
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
        `No guideline found with number "${args.ref_id}". Use format like "1.1" or "2.4".`,
        { version: getVersion(), error: 'not_found', ref_id: args.ref_id }
      );
    }

    const { principle, guideline } = result;
    const url = `${urls().spec}#${guideline.id}`;

    let output = `# Guideline ${guideline.num}: ${guideline.handle}\n\n`;
    output += `**Principle:** ${principle.num} ${principle.handle}\n\n`;
    output += `## Description\n\n${stripHtml(guideline.content)}\n\n`;
    output += `**URL:** ${url}\n`;

    output += `\n## Success Criteria (${guideline.successcriteria.length})\n\n`;
    for (const sc of guideline.successcriteria) {
      output += `### ${sc.num} ${sc.handle} (${levelTag(sc)})\n`;
      output += `${truncate(sc.title, 200)}\n\n`;
    }

    return textResponse(output, {
      version: getVersion(),
      num: guideline.num,
      handle: guideline.handle,
      id: guideline.id,
      description: stripHtml(guideline.content),
      url,
      principle: { num: principle.num, handle: principle.handle },
      criteria: guideline.successcriteria.map((sc) => ({ ...criterionSummary(sc), text: sc.title })),
    });
  },
};

const searchWcag = {
  name: 'search-wcag',
  description:
    'Searches WCAG success criteria by keyword in titles and descriptions. Pass --understanding to also search the Understanding prose (intent, benefits, examples).',
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

    const data = {
      version: getVersion(),
      query: args.query,
      level: args.level ?? null,
      understanding: args.understanding === true,
      results: scored.map(({ sc, score, labels }) => ({
        ...summaryWithGuideline(sc),
        text: sc.title,
        score,
        matchedIn: labels,
      })),
    };

    if (scored.length === 0) {
      const hint = args.understanding
        ? ''
        : ' Try --understanding to search the Intent, Benefits and Examples prose as well.';
      return textResponse(
        `No success criteria found matching "${args.query}"${args.level ? ` at level ${args.level}` : ''}.${hint}`,
        data
      );
    }

    const output = scored
      .map(({ sc, labels }) => {
        const where = args.understanding ? `\nmatched in: ${labels.join(', ')}` : '';
        return `**${sc.num} ${sc.handle}** (${levelTag(sc)})\n${truncate(sc.title, 150)}${where}`;
      })
      .join('\n\n---\n\n');

    return textResponse(
      `# Search Results for "${args.query}" (${scored.length} found)\n\n${output}`,
      data
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

    const grouped = {};
    for (const sc of criteria) {
      (grouped[sc.level] ??= []).push(sc);
    }
    const data = {
      version: getVersion(),
      level: args.level,
      includeLower: args.include_lower === true,
      total: criteria.length,
      byLevel: Object.fromEntries(
        levels.map((level) => [level, (grouped[level] ?? []).map(summaryWithGuideline)])
      ),
    };

    if (criteria.length === 0) {
      return textResponse(`No success criteria found for level ${args.level}.`, data);
    }

    let output = `# ${wcag()} Level ${args.level}${args.include_lower ? ' (including lower levels)' : ''}\n\n`;
    output += `Total: ${criteria.length} success criteria\n\n`;

    for (const level of levels) {
      if (grouped[level]) {
        output += `## Level ${level} (${grouped[level].length} criteria)\n\n`;
        for (const sc of grouped[level]) output += `- **${sc.num}** ${sc.handle}\n`;
        output += '\n';
      }
    }

    return textResponse(output, data);
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

    const sorted = Object.entries(counts).sort((a, b) => a[0].localeCompare(b[0]));
    const output = sorted.map(([key, count]) => `- **${key}**: ${count}`).join('\n');

    const heading = args.group_by.charAt(0).toUpperCase() + args.group_by.slice(1);
    return textResponse(
      `# ${wcag()} Success Criteria by ${heading}\n\nTotal: ${allCriteria.length} success criteria\n\n${output}`,
      { version: getVersion(), groupBy: args.group_by, total: allCriteria.length, counts: Object.fromEntries(sorted) }
    );
  },
};

// ============================================================================
// TECHNIQUE TOOLS
// ============================================================================

function techniqueSummary(t) {
  return { id: t.id, technology: t.technology, title: t.title, types: t.types, criteria: t.criteria };
}

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

    const data = {
      version: getVersion(),
      filters: { technology: args.technology ?? null, type: args.type ?? null },
      techniques: techniques.map(techniqueSummary),
    };

    if (techniques.length === 0) {
      return textResponse('No techniques found matching your filters.', data);
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

    return textResponse(output, data);
  },
};

// Prose blocks and `{ code, lang }` blocks, as the technique parser yields them.
function renderBlocks(blocks) {
  let out = '';
  for (const block of blocks) {
    if (typeof block === 'string') out += `${block}\n\n`;
    else out += `\`\`\`${block.lang ?? ''}\n${block.code}\n\`\`\`\n\n`;
  }
  return out;
}

const getTechnique = {
  name: 'get-technique',
  description:
    'Gets a technique by ID (e.g., "H37", "ARIA1", "G94", "F65"): what it applies to, its description, examples, test procedure and expected results, related techniques and resources.',
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
      return textResponse(`No technique found with ID "${args.id}".`, {
        version: getVersion(),
        error: 'not_found',
        id: args.id,
      });
    }

    const [body, all] = await Promise.all([getTechniqueBody(technique.id), getAllTechniques()]);
    const byId = new Map(all.map((t) => [t.id, t]));
    const url = urls().technique(technique.technology, technique.id);

    let output = `# ${technique.id}: ${technique.title}\n\n`;
    output += `**Technology:** ${technique.technology}\n`;
    output += `**Types:** ${technique.types.length ? technique.types.join(', ') : 'none (not referenced by any success criterion)'}\n`;
    output += `**Applies to:** ${
      technique.criteria.length
        ? pluralise(technique.criteria.length, 'success criterion', 'success criteria')
        : 'Not referenced by any success criterion'
    }\n`;
    if (body?.applicability) output += `**Applicability:** ${body.applicability}\n`;
    output += '\n';

    // Copy before sorting: `technique` comes from the memoised getAllTechniques
    // index, so an in-place sort would mutate shared state.
    const criteria = [];
    for (const scNum of [...technique.criteria].sort()) {
      const result = await findSuccessCriterion(scNum);
      if (result) criteria.push(result.sc);
    }
    if (criteria.length) {
      output += '## Related Success Criteria\n\n';
      for (const sc of criteria) output += `- **${sc.num}** ${sc.handle} (${levelTag(sc)})\n`;
      output += '\n';
    }

    if (body?.description?.length) {
      output += `## Description\n\n${renderBlocks(body.description)}`;
    }

    if (body?.examples?.length) {
      output += '## Examples\n\n';
      for (const example of body.examples) {
        output += `### ${example.title}\n\n${renderBlocks(example.blocks)}`;
      }
    }

    if (body?.tests && (body.tests.procedure.length || body.tests.expectedResults.length)) {
      output += '## Tests\n\n';
      if (body.tests.procedure.length) {
        output += '### Procedure\n\n';
        let n = 0;
        for (const step of body.tests.procedure) {
          output += typeof step === 'string' ? `${++n}. ${step}\n` : renderBlocks([step]);
        }
        output += '\n';
      }
      if (body.tests.expectedResults.length) {
        output += `### Expected Results\n\n${renderBlocks(body.tests.expectedResults)}`;
      }
    }

    const related = (body?.related ?? []).map((id) => ({ id, title: byId.get(id)?.title ?? null }));
    if (related.length) {
      output += '## Related Techniques\n\n';
      for (const r of related) output += r.title ? `- **${r.id}**: ${r.title}\n` : `- **${r.id}**\n`;
      output += '\n';
    }

    if (body?.resources?.length) {
      output += '## Resources\n\n';
      for (const r of body.resources) output += `- [${r.title}](${r.url})\n`;
      output += '\n';
    }

    if (!body) {
      output += '_Full technique text is not available locally; see the documentation link below._\n\n';
    }

    output += '## Links\n\n';
    output += `- [Full Technique Documentation](${url})\n`;

    return textResponse(output, {
      version: getVersion(),
      ...techniqueSummary(technique),
      criteria: criteria.map(criterionSummary),
      url,
      applicability: body?.applicability ?? '',
      description: body?.description ?? [],
      examples: body?.examples ?? [],
      tests: body?.tests ?? { procedure: [], expectedResults: [] },
      related,
      resources: body?.resources ?? [],
    });
  },
};

const getTechniquesForCriterionTool = {
  name: 'get-techniques-for-criterion',
  description:
    'Gets all techniques (sufficient, advisory, and failures) for a specific success criterion.',
  inputSchema: { type: 'object', properties: { ref_id: REF_ID_SCHEMA }, required: ['ref_id'] },
  handler: async (args) => {
    const result = await findSuccessCriterion(args.ref_id);

    if (!result) return notFoundCriterion(args.ref_id, '');

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

    return textResponse(output, {
      version: getVersion(),
      criterion: criterionSummary(sc),
      // The W3C tree as published: situations, groups, "using" and "and"
      // nestings are meaningful and are not flattened here.
      techniques: {
        sufficient: techniques.sufficient ?? [],
        advisory: techniques.advisory ?? [],
        failure: techniques.failure ?? [],
      },
    });
  },
};

const searchTechniques = {
  name: 'search-techniques',
  description:
    'Searches techniques by keyword in titles. Pass --description to also search each technique\'s description, examples and tests, and report which section matched.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      description: {
        type: 'boolean',
        description:
          'Also search the technique bodies — description, examples and tests — and report which section matched',
      },
    },
    required: ['query'],
  },
  handler: async (args) => {
    const all = await getAllTechniques();

    // Bodies are read locally only (bundle plus cache): a search must never
    // turn into one request per technique.
    const flatten = (blocks) =>
      (blocks ?? []).map((b) => (typeof b === 'string' ? b : b.code ?? '')).join(' ');
    const bodyFields = async (t) => {
      const body = await getTechniqueBodyLocal(t.id);
      if (!body) return [];
      return [
        { label: 'Description', weight: 2, text: flatten(body.description) },
        { label: 'Examples', weight: 1, text: body.examples.map((e) => `${e.title} ${flatten(e.blocks)}`) },
        { label: 'Tests', weight: 1, text: flatten([...body.tests.procedure, ...body.tests.expectedResults]) },
      ];
    };

    const scored = [];
    for (const [index, t] of all.entries()) {
      const fields = [
        { label: 'Id', weight: 5, text: t.id },
        { label: 'Title', weight: 3, text: t.title },
        ...(args.description ? await bodyFields(t) : []),
      ];
      const hit = scoreFields(args.query, fields);
      if (hit) scored.push({ item: t, index, ...hit });
    }
    scored.sort((a, b) => b.score - a.score || a.index - b.index);

    const data = {
      version: getVersion(),
      query: args.query,
      description: args.description === true,
      results: scored.map(({ item, score, labels }) => ({ ...techniqueSummary(item), score, matchedIn: labels })),
    };

    if (scored.length === 0) {
      const hint = args.description
        ? ''
        : ' Try --description to search the technique descriptions, examples and tests as well.';
      return textResponse(`No techniques found matching "${args.query}".${hint}`, data);
    }

    const output = scored
      .map(({ item: t, labels }) => {
        const where = args.description ? `\nmatched in: ${labels.join(', ')}` : '';
        return `**${t.id}** (${t.technology}): ${t.title}${where}`;
      })
      .join(args.description ? '\n\n' : '\n');

    return textResponse(
      `# Technique Search Results for "${args.query}" (${scored.length} found)\n\n${output}`,
      data
    );
  },
};

const getFailuresForCriterion = {
  name: 'get-failures-for-criterion',
  description: 'Gets failure techniques (common mistakes) for a specific success criterion.',
  inputSchema: { type: 'object', properties: { ref_id: REF_ID_SCHEMA }, required: ['ref_id'] },
  handler: async (args) => {
    const result = await findSuccessCriterion(args.ref_id);

    if (!result) return notFoundCriterion(args.ref_id, '');

    const { sc } = result;
    const failures = (sc.techniques?.failure || []).filter((item) => item.id);
    const data = {
      version: getVersion(),
      criterion: criterionSummary(sc),
      failures: failures.map((f) => ({ id: f.id, technology: f.technology, title: f.title })),
    };

    if (failures.length === 0) {
      return textResponse(`No documented failure techniques for ${sc.num} ${sc.handle}.`, data);
    }

    let output = `# Failure Techniques for ${sc.num} ${sc.handle}\n\n`;
    output += 'These are common mistakes that would cause this success criterion to fail:\n\n';

    for (const item of failures) {
      output += `- **${item.id}**: ${item.title}\n`;
    }

    return textResponse(output, data);
  },
};

// ============================================================================
// GLOSSARY TOOLS
// ============================================================================

function termData(term) {
  return { id: term.id, name: term.name, definition: htmlToText(term.definition), url: getTermUrl(term) };
}

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
      const data = { version: getVersion(), error: 'not_found', term: args.term, suggestions: similar.map((t) => t.name) };
      if (similar.length > 0) {
        const suggestions = similar.map((t) => `- ${t.name}`).join('\n');
        return textResponse(`Term "${args.term}" not found. Did you mean:\n\n${suggestions}`, data);
      }
      return textResponse(`Term "${args.term}" not found in the WCAG glossary.`, data);
    }

    // CHANGE 5: htmlToText, not stripHtml — W3C definitions are block HTML and
    // flattening them ran notes into the preceding sentence.
    let output = `# ${term.name}\n\n`;
    output += `${htmlToText(term.definition)}\n\n`;
    output += `[View in ${wcag()} Glossary](${getTermUrl(term)})`;

    return textResponse(output, { version: getVersion(), ...termData(term) });
  },
};

const listGlossaryTerms = {
  name: 'list-glossary-terms',
  description: 'Lists all WCAG glossary terms.',
  inputSchema: { type: 'object', properties: {}, required: [] },
  handler: async () => {
    const terms = await getTerms();
    const sortedTerms = [...terms].sort((a, b) => a.name.localeCompare(b.name));

    let output = `# ${wcag()} Glossary (${sortedTerms.length} terms)\n\n`;

    const grouped = {};
    for (const t of sortedTerms) {
      (grouped[t.name[0].toUpperCase()] ??= []).push(t);
    }

    for (const [letter, letterTerms] of Object.entries(grouped).sort()) {
      output += `## ${letter}\n\n`;
      for (const t of letterTerms) output += `- **${t.name}**\n`;
      output += '\n';
    }

    return textResponse(output, {
      version: getVersion(),
      terms: sortedTerms.map((t) => ({ id: t.id, name: t.name, url: getTermUrl(t) })),
    });
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
    const data = { version: getVersion(), query: args.query, results: matches.map(termData) };

    if (matches.length === 0) {
      return textResponse(`No glossary terms found matching "${args.query}".`, data);
    }

    const output = matches
      .map((t) => `**${t.name}**\n${truncate(htmlToText(t.definition), 150)}`)
      .join('\n\n---\n\n');

    return textResponse(
      `# Glossary Search Results for "${args.query}" (${matches.length} found)\n\n${output}`,
      data
    );
  },
};

// ============================================================================
// ENHANCED CONTEXT TOOLS
// ============================================================================

// Version-generic: the additions AND the removals of the configured version.
// The previous `whats-new-in-wcag22` only listed additions, so the one thing
// 2.2 took away (4.1.1 Parsing) was invisible here.
async function renderWhatsNew() {
  const version = getVersion();
  const [added, removed] = await Promise.all([getNewInVersion(version), getRemovedInVersion(version)]);

  let output = `# What's New in WCAG ${version}\n\n`;
  output += `WCAG ${version} added ${added.length} new success criteria:\n\n`;

  const byLevel = { A: [], AA: [], AAA: [] };
  for (const sc of added) {
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

  if (removed.length > 0) {
    output += '## Removed\n\n';
    output += `WCAG ${version} removed ${pluralise(removed.length, 'success criterion', 'success criteria')}; the number stays reserved:\n\n`;
    for (const sc of removed) {
      output += `### ${sc.num} ${sc.handle}\n`;
      output += `${truncate(sc.title, 200)}\n\n`;
    }
  }

  return textResponse(output, {
    version,
    added: added.map(summaryWithGuideline),
    removed: removed.map(summaryWithGuideline),
  });
}

const whatsNew = {
  name: 'whats-new',
  description:
    'Lists the success criteria the selected WCAG version added and the ones it removed (use --wcag to select the version).',
  inputSchema: { type: 'object', properties: {}, required: [] },
  handler: renderWhatsNew,
};

// Kept as an alias so scripts written against the older command keep working.
const whatsNewInWcag22 = {
  name: 'whats-new-in-wcag22',
  description: 'Alias for "whats-new": lists what WCAG 2.2 added and removed.',
  inputSchema: { type: 'object', properties: {}, required: [] },
  handler: renderWhatsNew,
};

const getTestRulesForCriterion = {
  name: 'get-test-rules-for-criterion',
  description:
    'Lists the W3C-approved ACT test rules for a success criterion, with links to each rule.',
  inputSchema: { type: 'object', properties: { ref_id: REF_ID_SCHEMA }, required: ['ref_id'] },
  handler: async (args) => {
    const result = await findSuccessCriterion(args.ref_id);
    if (!result) return notFoundCriterion(args.ref_id, '');
    const { sc } = result;
    const understanding = await getUnderstanding(sc.num);
    const testRules = understanding?.testRules ?? [];
    const data = { version: getVersion(), criterion: criterionSummary(sc), testRules };

    if (testRules.length === 0) {
      return textResponse(
        `No test rules are listed for ${sc.num} ${sc.handle}. Test rules are optional, approved test methods; ` +
          'a criterion without any is checked by the techniques and failures instead.',
        data
      );
    }

    let output = `# Test Rules for ${sc.num} ${sc.handle}\n\n`;
    output +=
      'Approved ACT test rules for aspects of this success criterion. Using them is not required for conformance; ' +
      'a rule marked (proposed) is still awaiting approval.\n\n';
    for (const rule of testRules) {
      output += `- [${rule.title}](${rule.url})${rule.proposed ? ' (proposed)' : ''}\n`;
    }
    return textResponse(output, data);
  },
};

// CHANGE 1: upstream returned 687 bytes of counts only, while promising
// "techniques, test rules, and related glossary terms". It now delivers the
// overview, the technique NAMES per type, the glossary terms the criterion
// actually links to, and the ACT test rules from the Understanding page.
const getFullCriterionContext = {
  name: 'get-full-criterion-context',
  description:
    'Gets comprehensive context for a success criterion: overview, In Brief summary, exceptions, every sufficient/advisory/failure technique by name, the glossary terms it references, and its test rules.',
  inputSchema: { type: 'object', properties: { ref_id: REF_ID_SCHEMA }, required: ['ref_id'] },
  handler: async (args) => {
    const result = await findSuccessCriterion(args.ref_id);

    if (!result) return notFoundCriterion(args.ref_id, '');

    const { principle, guideline, sc } = result;

    let output = `# Complete Context: ${sc.num} ${sc.handle}\n\n`;

    output += '## Overview\n\n';
    output += `**Level:** ${levelValue(sc)}\n`;
    output += `**Principle:** ${principle.num} ${principle.handle}\n`;
    output += `**Guideline:** ${guideline.num} ${guideline.handle}\n`;
    output += `**WCAG Versions:** ${sc.versions.join(', ')}\n\n`;
    output += `${sc.title}\n\n`;

    const understanding = await getUnderstanding(sc.num);
    output += renderInBrief(understanding);

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

    const testRules = understanding?.testRules ?? [];
    output += renderTestRules(testRules, `## Test Rules (${testRules.length})`);

    output += renderLinks(sc);

    return textResponse(output, {
      ...criterionData(result, understanding),
      techniques: byType,
      relatedTerms: related.map(termData),
    });
  },
};

// ============================================================================
// THE RECOMMENDATION: CONFORMANCE, INPUT PURPOSES, ERRATA
// ============================================================================

const getConformanceRequirements = {
  name: 'get-conformance-requirements',
  description:
    'Gets the five conformance requirements from the WCAG Recommendation (conformance level, full pages, complete processes, accessibility-supported technologies, non-interference).',
  inputSchema: { type: 'object', properties: {}, required: [] },
  handler: async () => {
    const spec = await getSpecExtras();
    const url = `${urls().spec}#conformance-reqs`;
    const requirements = spec?.conformanceRequirements ?? [];
    const data = { version: getVersion(), url, requirements };

    if (requirements.length === 0) {
      return textResponse(
        `The conformance requirements for ${wcag()} are not available locally; see ${url}`,
        data
      );
    }

    let output = `# ${wcag()} Conformance Requirements\n\n`;
    output += `In order for a web page to conform to ${wcag()}, all of the following must be satisfied:\n\n`;
    for (const req of requirements) {
      output += `## ${req.num} ${req.title}\n\n`;
      for (const block of req.blocks) output += `${block}\n\n`;
    }
    output += `[Read in the Recommendation](${url})\n`;
    return textResponse(output, data);
  },
};

const listInputPurposes = {
  name: 'list-input-purposes',
  description:
    'Lists the input purposes for user interface components (the autocomplete tokens behind 1.3.5 Identify Input Purpose), optionally filtered by keyword.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        positional: true,
        description: 'Optional keyword to filter tokens and descriptions',
      },
    },
    required: [],
  },
  handler: async (args) => {
    const spec = await getSpecExtras();
    const url = `${urls().spec}#input-purposes`;
    let purposes = spec?.inputPurposes ?? [];
    if (args.query) {
      purposes = rankBy(purposes, (p) =>
        scoreFields(args.query, [
          { label: 'Token', weight: 5, text: p.token },
          { label: 'Description', weight: 2, text: p.description },
        ])
      ).map(({ item }) => item);
    }
    const data = { version: getVersion(), url, query: args.query ?? null, purposes };

    if (purposes.length === 0) {
      return textResponse(
        args.query
          ? `No input purposes match "${args.query}".`
          : `The input purposes for ${wcag()} are not available locally; see ${url}`,
        data
      );
    }

    let output = `# Input Purposes for User Interface Components (${pluralise(purposes.length, 'input purpose')})\n\n`;
    output +=
      'Purposes 1.3.5 Identify Input Purpose requires to be programmatically determinable; in HTML they are the `autocomplete` tokens.\n\n';
    for (const p of purposes) output += `- \`${p.token}\` ${p.description}\n`;
    output += `\n[Read in the Recommendation](${url})\n`;
    return textResponse(output, data);
  },
};

const listErrata = {
  name: 'list-errata',
  description:
    'Lists the published errata for the WCAG Recommendation, newest first, with the pull request behind each change.',
  inputSchema: { type: 'object', properties: {}, required: [] },
  handler: async () => {
    const errata = await getErrata();
    const url = urls().errata;
    const data = { version: getVersion(), url, errata: errata ?? [] };

    if (!errata) {
      return textResponse(`The errata for ${wcag()} are not available locally; see ${url}`, data);
    }
    if (errata.length === 0) {
      return textResponse(`No errata have been published for ${wcag()}. ${url}`, data);
    }

    let output = `# ${wcag()} Errata (${errata.length})\n\n`;
    let since = null;
    let kind = null;
    for (const e of errata) {
      if (e.since !== since) {
        since = e.since;
        kind = null;
        output += `## Errata since ${since}\n\n`;
      }
      if (e.kind && e.kind !== kind) {
        kind = e.kind;
        output += `### ${kind}\n\n`;
      }
      const changes = e.changes.map((c) => `[#${c.split('/').pop()}](${c})`).join(', ');
      output += `- **${e.date}** ${e.text}${changes ? ` (${changes})` : ''}\n`;
    }
    output += `\n[Errata page](${url})\n`;
    return textResponse(output, data);
  },
};

// CHANGE 4: rewritten for a CLI. The upstream text described a server rather
// than a command, hard-coded v2.0.0, and cited the dependency this package no
// longer has.
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
    const cacheDir = versionCacheDir(CACHE_DIR, getVersion());
    const guidelines = principles.reduce((sum, p) => sum + p.guidelines.length, 0);

    let output = `**wcag** v${packageVersion()}\n\n`;
    output +=
      `Command-line lookup for ${wcag()} success criteria, techniques and glossary, served from official W3C data bundled with this package and refreshed from w3.org on demand.\n\n`;

    output += '## Dataset\n\n';
    output += `- **Source:** ${meta?.source ?? urls().wcagJson}\n`;
    output += `- **ETag:** ${meta?.etag ?? '(none)'}\n`;
    output += `- **Last-Modified:** ${meta?.lastModified ?? '(none)'}\n`;
    output += `- **Fetched:** ${meta?.fetchedAt ?? '(unknown)'}\n`;
    output += '- **Understanding docs:** parsed from the official W3C Understanding HTML pages\n';
    output += `- **WCAG version:** ${getVersion()}\n\n`;

    output += '## Cache\n\n';
    output += `- **Directory:** ${displayPath(cacheDir)}\n`;
    output += `- **Refresh interval:** ${pluralise(ttlDays, 'day')}\n`;
    output += '- **Force a refresh:** `wcag <command> --refresh`\n';
    output += '- **Stay offline:** set `WCAG_CLI_NO_NETWORK=1`\n';
    output += '- **Another version:** `wcag --wcag 2.1 <command>` or `WCAG_CLI_VERSION=2.1`\n\n';

    output += '## Statistics\n\n';
    output += `- **Principles:** ${principles.length}\n`;
    output += `- **Guidelines:** ${guidelines}\n`;
    output += `- **Success Criteria:** ${allCriteria.length} (Level A: ${levelCounts.A}, AA: ${levelCounts.AA}, AAA: ${levelCounts.AAA}, ${removedLevelLabel()}: ${levelCounts.removed})\n`;
    output += `- **Techniques:** ${allTechniques.length}\n`;
    output += `- **Glossary Terms:** ${terms.length}\n\n`;

    output += '## Attribution\n\n';
    output +=
      'WCAG data from the [W3C WCAG Repository](https://github.com/w3c/wcag) ([W3C Document License](https://www.w3.org/copyright/document-license/)).\n\n';
    output +=
      `This software includes material copied from or derived from Web Content Accessibility Guidelines (WCAG) ${getVersion()}. Copyright © World Wide Web Consortium. W3C® liability, trademark and document use rules apply.`;

    return textResponse(output, {
      cli: packageVersion(),
      version: getVersion(),
      dataset: meta ?? null,
      cache: { directory: cacheDir, ttlDays },
      statistics: {
        principles: principles.length,
        guidelines,
        criteria: { total: allCriteria.length, ...levelCounts },
        techniques: allTechniques.length,
        glossaryTerms: terms.length,
      },
    });
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
  whatsNew,
  whatsNewInWcag22,
  getTestRulesForCriterion,
  getFullCriterionContext,

  // The Recommendation beyond wcag.json
  getConformanceRequirements,
  listInputPurposes,
  listErrata,

  // Server info
  getServerInfo,
];
