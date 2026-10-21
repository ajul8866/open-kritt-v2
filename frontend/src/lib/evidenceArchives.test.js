import { describe, expect, it } from 'vitest';

import {
  archiveDownloadFilename,
  archiveEntryLabel,
  archiveFileLabel,
  archiveKindLabel,
  archiveSessionPaths,
  formatArchiveBytes,
  formatArchiveTime,
} from './evidenceArchives.js';

describe('formatArchiveBytes', () => {
  it('renders byte, KiB, MiB and invalid values', () => {
    expect(formatArchiveBytes(0)).toBe('0 B');
    expect(formatArchiveBytes(1023)).toBe('1023 B');
    expect(formatArchiveBytes(1024)).toBe('1.0 KiB');
    expect(formatArchiveBytes(1536 * 1024)).toBe('1.5 MiB');
    expect(formatArchiveBytes(-1)).toBe('—');
    expect(formatArchiveBytes(null)).toBe('—');
  });
});

describe('archive labels', () => {
  it('maps engine job kinds', () => {
    expect(archiveKindLabel('supplemental_post_script')).toBe('Supplemental post-script');
    expect(archiveKindLabel('step')).toBe('Scan step');
    expect(archiveKindLabel('custom_kind')).toBe('Custom kind');
    expect(archiveKindLabel('__proto__')).toBe('Proto');
    expect(archiveKindLabel(null)).toBe('Job');
  });

  it('combines kind, post-script and finding context', () => {
    expect(archiveEntryLabel({ kind: 'post_script', postScriptName: 'PoC Creator', vulnerabilityId: 829 })).toBe(
      'Post-script · PoC Creator · finding #829'
    );
    expect(archiveEntryLabel({ kind: 'step', stepId: 4 })).toBe('Scan step · step 4');
  });

  it('names downloadable files', () => {
    expect(archiveFileLabel('workspace.tar.gz')).toBe('Workspace archive (.tar.gz)');
    expect(archiveFileLabel('sessions/.codex/sessions/rollout.jsonl')).toBe('rollout.jsonl');
    expect(archiveDownloadFilename('metadata-1-20261021T090000Z', 'workspace.tar.gz')).toBe(
      'metadata-1-20261021T090000Z-workspace.tar.gz'
    );
    expect(archiveDownloadFilename('metadata/../x', 'sessions/.codex/rollout.jsonl')).toBe(
      'metadata-..-x-rollout.jsonl'
    );
  });
});

describe('archiveSessionPaths', () => {
  it('keeps only session transcripts', () => {
    expect(
      archiveSessionPaths({
        sessionFiles: ['sessions/.codex/sessions/a.jsonl', 'sessions/a.txt', '../a.jsonl', 42],
      })
    ).toEqual(['sessions/.codex/sessions/a.jsonl']);
    expect(archiveSessionPaths({})).toEqual([]);
  });
});

describe('formatArchiveTime', () => {
  it('formats valid timestamps and hides invalid ones', () => {
    expect(formatArchiveTime('2026-10-21T09:00:00Z')).toContain('2026');
    expect(formatArchiveTime('not-a-date')).toBe('—');
    expect(formatArchiveTime(null)).toBe('—');
  });
});
