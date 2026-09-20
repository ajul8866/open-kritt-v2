// Canonical severity normalization for every consumer of a finding's severity:
// the scan list and detail views, the share card, and the ZIP export.
//
// Severity arrives as free text because post-scripts are user-authored prompts and
// their output format declares `severity` as a plain string. Historically three
// separate hand-written maps interpreted that text, and they disagreed — the same
// finding could render as "Critical" in the UI, "Critical" in finding.md, and as no
// severity at all on the share card. This module is the single interpretation.
//
// Everything here is deterministic and offline: it runs on every render and every
// export, so it must never depend on a network call or a model.

export const CANONICAL_SEVERITY_LEVELS = ['critical', 'high', 'medium', 'low', 'informational'];

export const SEVERITY_COLORS = {
  critical: 'var(--fail)',
  high: 'var(--fail)',
  medium: 'var(--pend)',
  low: 'var(--run)',
  informational: 'var(--text-3)',
  unrated: 'var(--text-3)',
};

export const SEVERITY_DISPLAY_LABELS = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  informational: 'Informational',
  unrated: 'Unrated',
};

// Only these four are publishable on a share card. Informational and unrated carry
// no claim worth broadcasting, and a share card must never overstate a finding.
const SHAREABLE_LEVELS = ['critical', 'high', 'medium', 'low'];

// The product's own vocabulary for each level, including the spellings that reach
// the UI from post-scripts. Longer phrases are matched before shorter ones.
const LEVEL_PHRASES = {
  informational: ['informational', 'info', 'not exploitable', 'no security impact', 'hardening'],
  critical: ['critical', 'p0', 'p1', 'sev-critical', 'sev-crit'],
  high: ['high', 'p2', 'sev-high'],
  medium: ['medium', 'moderate', 'p3', 'sev-medium', 'sev-med'],
  low: ['low', 'p4', 'sev-low'],
};

// CVSS v3.1 qualitative bands. A bare score is arithmetic, so it is computed here
// rather than interpreted: "7.5" must never be read as an arbitrary token.
const CVSS_BANDS = [
  { minimum: 9.0, level: 'critical' },
  { minimum: 7.0, level: 'high' },
  { minimum: 4.0, level: 'medium' },
  { minimum: 0.1, level: 'low' },
  { minimum: 0.0, level: 'informational' },
];

const CVSS_SCORE_RE = /\b(\d{1,2}(?:\.\d)?)\s*(?:\/\s*10)?\b/;
const CVSS_VECTOR_RE = /\bCVSS:3\.[01]\//i;

// A severity word only counts when it stands on its own, so "highlighted" and
// "lowest" are not read as severities.
const WORD_BOUNDARY = '[^a-z0-9]';

function bandForCvss(score) {
  for (const band of CVSS_BANDS) {
    if (score >= band.minimum) return band.level;
  }
  return null;
}

// Impact of a CVSS v3.1 vector, derived from its C/I/A metrics. This is a fixed
// lookup, not a judgment: scope-changed vectors are treated as critical because
// their impact subscore is unbounded.
function bandForCvssVector(vector) {
  const metrics = Object.fromEntries(
    vector
      .toUpperCase()
      .split('/')
      .slice(1)
      .map((part) => part.split(':'))
      .filter(([key]) => key)
  );
  const weight = (value) => ({ H: 1, L: 0.5, N: 0 })[value] ?? 0;
  const impact = 1 - (1 - weight(metrics.C)) * (1 - weight(metrics.I)) * (1 - weight(metrics.A));
  if (metrics.S === 'C' && impact > 0) return 'critical';
  if (impact >= 0.7) return 'critical';
  if (impact >= 0.5) return 'high';
  if (impact >= 0.3) return 'medium';
  if (impact > 0) return 'low';
  return 'informational';
}

/**
 * Normalize a free-text severity into one canonical level, or null when no
 * severity is actually stated.
 *
 * @param {unknown} value severity text from a post-script, ranker, or CVSS field
 * @returns {'critical'|'high'|'medium'|'low'|'informational'|null}
 */
export function severityLevel(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  if (!text) return null;

  // A CVSS vector names its own metrics, so it is more specific than a word.
  if (CVSS_VECTOR_RE.test(value)) return bandForCvssVector(value);

  for (const [level, phrases] of Object.entries(LEVEL_PHRASES)) {
    for (const phrase of phrases) {
      const pattern = new RegExp(`${WORD_BOUNDARY}${phrase}${WORD_BOUNDARY}`);
      if (pattern.test(` ${text} `)) return level;
    }
  }

  // Only after the vocabulary fails: a bare score such as "7.5" or "9.8/10".
  const score = text.match(CVSS_SCORE_RE);
  if (score) {
    const parsed = Number.parseFloat(score[1]);
    if (Number.isFinite(parsed) && parsed <= 10) return bandForCvss(parsed);
  }
  return null;
}

/**
 * Map a severity to its display color. Unstated severity renders neutral, which is
 * distinct from every real level — including informational.
 */
export function severityColor(value) {
  const level = severityLevel(value);
  return level ? SEVERITY_COLORS[level] : SEVERITY_COLORS.unrated;
}

/**
 * Map a canonical level to the label a share card may publish, or null when the
 * level must not be broadcast.
 */
export function severityShareLabel(level) {
  if (!SHAREABLE_LEVELS.includes(level)) return null;
  return SEVERITY_DISPLAY_LABELS[level];
}
