import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import LoopProgress from './LoopProgress.jsx';
import ReviewForm, { initialFeedback, reviewIsValid } from './ReviewForm.jsx';

const snapshot = {
  scan_id: '10',
  source_fingerprint: `git:${'a'.repeat(40)}`,
  findings: [{ id: '1', summary: 'Access boundary' }],
  feedback: null,
};
const loop = {
  id: 'loop',
  state: 'awaiting_approval',
  config: { max_loops: 2, metric: 'validated_high_critical' },
  iterations: 1,
  runs: [],
  best_scan_id: '10',
  best_workflow_id: '1',
  proposal: { description: 'Analyze failures' },
  diff: '+ <script>alert(1)</script>',
  scan_request: { repo_full: 'example/project', commit_sha: 'a'.repeat(40) },
  approval_digest: 'b'.repeat(64),
  reviews: [snapshot],
};

function html(component, props) {
  return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(component, props)));
}

describe('workflow improvement web controls', () => {
  it('does not prevalidate findings or credit model-generated confidence', () => {
    const feedback = initialFeedback(snapshot);
    expect(feedback.findings[0].verdict).toBe('unverified');
    expect(feedback.findings[0].confidence).toBe(0);
    expect(reviewIsValid(feedback, 'reviewer')).toBe(false);
    feedback.findings[0].case_key = 'authorization-root-cause';
    feedback.findings[0].evidence = 'Independently reproduced';
    expect(reviewIsValid(feedback, 'reviewer')).toBe(true);
    expect(reviewIsValid(feedback, '')).toBe(false);
    feedback.findings[0].confidence = 2;
    expect(reviewIsValid(feedback, 'reviewer')).toBe(false);
  });

  it('shows the diff and exact target while keeping approval disabled until human review', () => {
    const rendered = html(LoopProgress, { loop, busy: false });
    expect(rendered).toContain('Human approval required');
    expect(rendered).toContain('example/project');
    expect(rendered).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(rendered).not.toContain('<script>alert(1)</script>');
    expect(rendered).toMatch(/<button[^>]*disabled=""[^>]*>Approve this version and queue rerun/);
    expect(rendered).toContain('I reviewed this workflow diff and target settings');
  });

  it('allows review of an empty baseline and explains stable root-cause keys', () => {
    const rendered = html(ReviewForm, { snapshot: { ...snapshot, findings: [] }, reviewer: 'operator' });
    expect(rendered).toContain('Save an empty review');
    expect(rendered).toContain('same root-cause key');
    expect(rendered).toContain('Save review for scan #10');
  });

  it('shows regressions and preserved best versions without offering another approval', () => {
    const done = {
      ...loop,
      state: 'completed',
      reviews: [],
      runs: [
        {
          iteration: 1,
          evaluation: {
            better: false,
            baseline: { validated_high_critical: 1 },
            candidate: { validated_high_critical: 0 },
            delta: -1,
            reasons: ['Previously validated cases were lost'],
          },
        },
      ],
    };
    const rendered = html(LoopProgress, { loop: done });
    expect(rendered).toContain('Previously validated cases were lost');
    expect(rendered).toContain('/workflows/1');
    expect(rendered).not.toContain('Approve this version and queue rerun');
  });

  it('shows automatic recovery from a temporary API read failure', () => {
    const rendered = html(LoopProgress, {
      loop: {
        ...loop,
        state: 'waiting_generation',
        read_retry: { attempts: 1, error: 'GET /generations/1 returned HTTP 503' },
      },
      busy: false,
    });
    expect(rendered).toContain('Retrying automatically without creating another job');
    expect(rendered).toContain('HTTP 503');
  });

  it('shows rejected input contracts and explains why the model must revise the workflow', () => {
    const issue = {
      field: 'levels[depth=1].steps[0].content',
      message: 'Missing {{model_invariant_id}} value placeholder.',
    };
    const rendered = html(LoopProgress, {
      loop: {
        ...loop,
        proposal_validation_errors: [issue],
        runs: [{ iteration: 1, failure: { kind: 'invalid_handoff', validation_errors: [issue] } }],
      },
      busy: false,
    });
    expect(rendered).toContain('This version cannot be approved or promoted');
    expect(rendered).toContain('Missing {{model_invariant_id}}');
    expect(rendered).toContain('rejected and returned to the model');
  });
});
