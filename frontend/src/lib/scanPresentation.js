export function defaultWorkflowId(workflows, requestedId = '') {
  const items = Array.isArray(workflows) ? workflows : [];
  if (requestedId && items.some((workflow) => workflow.id === requestedId)) return requestedId;
  return items.find((workflow) => workflow.isDefault)?.id || '';
}

export function defaultRankerIds(rankers, currentIds = []) {
  if (Array.isArray(currentIds) && currentIds.length) return currentIds;
  return (Array.isArray(rankers) ? rankers : []).filter((ranker) => ranker.isDefault).map((ranker) => ranker.id);
}

const DELETABLE_SCAN_STATUSES = new Set(['paused', 'failed', 'stopped', 'completed']);

export function isScanDeletable(status) {
  return DELETABLE_SCAN_STATUSES.has(status);
}

function resultSources(vulnerability) {
  const sources = [];
  const primary = vulnerability?.postScriptAnswer;
  if (primary && typeof primary === 'object' && Object.keys(primary).length) sources.push(primary);
  for (const enrichment of vulnerability?.enrichments || []) {
    const result = enrichment?.result;
    if (result && typeof result === 'object' && Object.keys(result).length) sources.push(result);
  }
  return sources;
}

// Keys whose value reads as a summary of the post-script's verdict. The bundled
// triage artifacts emit the _chip_ forms (see 021_refresh_default_triage_artifacts.sql);
// the bare names stay for older scans and custom post-scripts.
const PREFERRED_OUTPUT_KEYS = [
  '_chip_patched',
  '_chip_ease_of_exploitability',
  '_chip_severity',
  'severity',
  'patched',
  'ease_of_exploitability',
  'resource_exhaustion',
];

// These read inverted on a scan card: "needs_manual_review: false" next to a clean
// finding looks like it was never reviewed. Only used when nothing better exists.
const INVERTED_READING_KEYS = new Set(['needs_manual_review', 'missing_from_prompt']);

function summarizableValue(value) {
  return ['string', 'number', 'boolean'].includes(typeof value);
}

export function postOutputSummary(vulnerability) {
  const sources = resultSources(vulnerability);
  // A post-script that declares its output format gives the authoritative order.
  const declared = Object.keys(vulnerability?.outputFormat || {});
  const ordered = [...declared.filter((key) => PREFERRED_OUTPUT_KEYS.includes(key)), ...PREFERRED_OUTPUT_KEYS];

  for (const key of ordered) {
    for (const result of sources) {
      const value = result[key];
      if (summarizableValue(value)) return { label: key, value: String(value) };
    }
  }
  for (const result of sources) {
    for (const [key, value] of Object.entries(result)) {
      if (key.startsWith('_reserved_')) continue;
      if (INVERTED_READING_KEYS.has(key)) continue;
      if (summarizableValue(value)) return { label: key, value: String(value) };
    }
  }
  return sources.length
    ? { label: 'post-script', value: `${sources.length} output${sources.length === 1 ? '' : 's'}` }
    : null;
}
