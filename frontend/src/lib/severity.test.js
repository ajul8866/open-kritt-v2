import { describe, expect, it } from 'vitest';

import {
  CANONICAL_SEVERITY_LEVELS,
  SEVERITY_COLORS,
  SEVERITY_DISPLAY_LABELS,
  severityColor,
  severityLevel,
  severityShareLabel,
} from './severity.js';

describe('severityLevel', () => {
  it('maps the plain labels a post-script emits', () => {
    expect(severityLevel('Critical')).toBe('critical');
    expect(severityLevel('High')).toBe('high');
    expect(severityLevel('Medium')).toBe('medium');
    expect(severityLevel('Low')).toBe('low');
  });

  it('trims surrounding whitespace', () => {
    expect(severityLevel(' Critical ')).toBe('critical');
    expect(severityLevel('Critical ')).toBe('critical');
    expect(severityLevel('  high')).toBe('high');
  });

  it('accepts the informational spellings the product uses', () => {
    expect(severityLevel('Info')).toBe('informational');
    expect(severityLevel('info')).toBe('informational');
    expect(severityLevel('Informational')).toBe('informational');
  });

  it('reads a severity embedded in a longer sentence', () => {
    expect(severityLevel('Critical — secret/repository src/auth.js')).toBe('critical');
    expect(severityLevel('CVSS 9.8 (Critical)')).toBe('critical');
    expect(severityLevel('Severity: Medium')).toBe('medium');
    expect(severityLevel('High severity, but only exploitable on testnet')).toBe('high');
  });

  it('derives the band from a bare CVSS score instead of guessing', () => {
    expect(severityLevel('7.5')).toBe('high');
    expect(severityLevel('9.8')).toBe('critical');
    expect(severityLevel('5.0')).toBe('medium');
    expect(severityLevel('2.1')).toBe('low');
    expect(severityLevel('0.0')).toBe('informational');
  });

  it('reads a CVSS vector string', () => {
    expect(severityLevel('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H')).toBe('critical');
  });

  it('treats an explicit non-finding as informational', () => {
    expect(severityLevel('Not exploitable — informational')).toBe('informational');
  });

  it('returns null when no severity is actually stated', () => {
    expect(severityLevel('unknown')).toBeNull();
    expect(severityLevel('N/A')).toBeNull();
    expect(severityLevel('')).toBeNull();
    expect(severityLevel(null)).toBeNull();
    expect(severityLevel(undefined)).toBeNull();
    expect(severityLevel(42)).toBeNull();
  });

  it('does not read a severity out of an unrelated word', () => {
    expect(severityLevel('highlighted')).toBeNull();
    expect(severityLevel('lowest priority cleanup')).toBeNull();
  });

  it('exposes the canonical level list', () => {
    expect(CANONICAL_SEVERITY_LEVELS).toEqual(['critical', 'high', 'medium', 'low', 'informational']);
  });
});

describe('severityColor', () => {
  it('gives every canonical level a distinct role', () => {
    expect(severityColor('critical')).toBe(SEVERITY_COLORS.critical);
    expect(severityColor('Critical ')).toBe(SEVERITY_COLORS.critical);
    expect(severityColor('Info')).toBe(SEVERITY_COLORS.informational);
    expect(severityColor('CVSS 9.8 (Critical)')).toBe(SEVERITY_COLORS.critical);
  });

  it('renders an unstated severity as neutral', () => {
    expect(severityColor('unknown')).toBe(SEVERITY_COLORS.unrated);
    expect(severityColor(null)).toBe(SEVERITY_COLORS.unrated);
  });
});

describe('severityShareLabel', () => {
  it('names the four shareable levels', () => {
    expect(severityShareLabel('critical')).toBe('Critical');
    expect(severityShareLabel('high')).toBe('High');
    expect(severityShareLabel('medium')).toBe('Medium');
    expect(severityShareLabel('low')).toBe('Low');
  });

  it('has no share label for informational or unrated', () => {
    expect(severityShareLabel('informational')).toBeNull();
    expect(severityShareLabel(null)).toBeNull();
  });

  it('exposes display labels for every canonical level', () => {
    expect(SEVERITY_DISPLAY_LABELS.informational).toBe('Informational');
  });
});
