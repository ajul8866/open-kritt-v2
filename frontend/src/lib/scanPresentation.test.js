import { describe, expect, it } from 'vitest';

import { defaultRankerIds, defaultWorkflowId, isScanDeletable, postOutputSummary } from './scanPresentation.js';

describe('defaultWorkflowId', () => {
  const workflows = [
    { id: '99', name: 'test replay' },
    { id: '2', name: 'external-flow-analysis', isDefault: true },
  ];

  it('uses an explicitly requested workflow', () => {
    expect(defaultWorkflowId(workflows, '99')).toBe('99');
  });

  it('prefers the stable built-in and otherwise requires explicit selection', () => {
    expect(defaultWorkflowId(workflows)).toBe('2');
    expect(defaultWorkflowId([{ id: '99', name: 'test replay' }])).toBe('');
  });
});

describe('postOutputSummary', () => {
  it('surfaces primary output even when no _chip field was emitted', () => {
    expect(postOutputSummary({ postScriptAnswer: { severity: 'Critical', explanation: 'reachable' } })).toEqual({
      label: 'severity',
      value: 'Critical',
    });
  });

  it('falls back to enrichment output', () => {
    expect(postOutputSummary({ enrichments: [{ result: { patched: false } }] })).toEqual({
      label: 'patched',
      value: 'false',
    });
  });

  // database/init/021_refresh_default_triage_artifacts.sql renamed the bundled
  // post-script keys to their _chip_ forms, so the shipped output no longer
  // contains "patched" or "ease_of_exploitability".
  it('surfaces the shipped chip key instead of an incidental boolean', () => {
    expect(
      postOutputSummary({
        postScriptAnswer: {
          _chip_patched: false,
          needs_manual_review: false,
          confidence: 0.9,
          summary_result: 'Behavior still present',
        },
      })
    ).toEqual({ label: '_chip_patched', value: 'false' });
  });

  it('surfaces a shipped ease-of-exploitability chip', () => {
    expect(postOutputSummary({ postScriptAnswer: { _chip_ease_of_exploitability: 8, reasoning: 'trivial' } })).toEqual({
      label: '_chip_ease_of_exploitability',
      value: '8',
    });
  });

  it('never surfaces needs_manual_review as the summary, which reads inverted', () => {
    const summary = postOutputSummary({
      postScriptAnswer: {
        needs_manual_review: false,
        confidence: 0.9,
        summary_result: 'Behavior still present',
      },
    });
    expect(summary.label).not.toBe('needs_manual_review');
  });

  it('prefers a declared output format over insertion order', () => {
    expect(
      postOutputSummary({
        postScriptAnswer: { reasoning: 'because', _chip_patched: true },
        outputFormat: { _chip_patched: 'boolean', reasoning: 'string' },
      })
    ).toEqual({ label: '_chip_patched', value: 'true' });
  });
});

describe('defaultRankerIds', () => {
  it('selects API-marked defaults without replacing an existing choice', () => {
    const rankers = [
      { id: '1', isDefault: false },
      { id: '2', isDefault: true },
    ];
    expect(defaultRankerIds(rankers)).toEqual(['2']);
    expect(defaultRankerIds(rankers, ['1'])).toEqual(['1']);
  });
});

describe('isScanDeletable', () => {
  it('allows paused and terminal scans to be deleted', () => {
    expect(['paused', 'failed', 'stopped', 'completed'].every(isScanDeletable)).toBe(true);
  });

  it('keeps active and waiting scans from being deleted', () => {
    expect(
      ['queued', 'pending', 'prewarming_cache', 'running', 'rate_limited', 'post_processing'].some(isScanDeletable)
    ).toBe(false);
  });
});
