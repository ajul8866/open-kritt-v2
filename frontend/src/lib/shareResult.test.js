import { describe, expect, it, vi } from 'vitest';
import {
  GITHUB_DESTINATION,
  X_DESTINATION,
  X_HANDLE,
  buildCommunityShareArtifact,
  buildShareArtifact,
  copyShareText,
  normalizeShareSeverity,
  shareWithChannel,
  xIntentUrl,
} from './shareResult.js';

describe('share artifact privacy', () => {
  it('defaults to generic copy and keeps channel attribution separate', () => {
    const x = buildShareArtifact({ channel: 'x' });
    const elsewhere = buildShareArtifact({ channel: 'elsewhere' });

    expect(x.cardText).toBe('I found a vulnerability using open·kritt.');
    expect(x.caption).toContain(X_HANDLE);
    expect(x.caption).toContain(X_DESTINATION);
    expect(x.caption).not.toContain(GITHUB_DESTINATION);

    expect(elsewhere.caption).toContain(GITHUB_DESTINATION);
    expect(elsewhere.caption).not.toContain(X_HANDLE);
    expect(elsewhere.caption).not.toContain(X_DESTINATION);
  });

  it('allows only recognized normalized severities into the card', () => {
    expect(normalizeShareSeverity(' Critical ')).toBe('critical');
    expect(normalizeShareSeverity('informational')).toBeNull();

    expect(buildShareArtifact({ includeSeverity: true, severity: 'high' }).cardText).toContain('a High vulnerability');
    const unsafe = buildShareArtifact({
      includeSeverity: true,
      severity: 'Critical — secret/repository src/auth.js',
      repoFull: 'secret/repository',
      summary: 'private finding',
    });
    // The level is broadcast; the text it was embedded in never is. Every share
    // label comes from a fixed list, so no input text can reach the card.
    expect(unsafe.cardText).toBe('I found a Critical vulnerability using open·kritt.');
    expect(JSON.stringify(unsafe)).not.toContain('secret');
    expect(JSON.stringify(unsafe)).not.toContain('private');
    expect(JSON.stringify(unsafe)).not.toContain('repository');
    expect(JSON.stringify(unsafe)).not.toContain('src/auth.js');
  });

  it('never publishes text from a severity label, only a fixed level name', () => {
    for (const label of [
      'Critical — secret/repository src/auth.js',
      'High severity, but only exploitable on testnet',
      'Severity: Medium',
      'CVSS 9.8 (Critical)',
      'not exploitable — informational',
    ]) {
      const artifact = buildShareArtifact({ includeSeverity: true, severity: label });
      // The published claim must be one of the fixed phrases, never a slice of input.
      expect(artifact.cardText).toMatch(/^I found a (Critical|High|Medium|Low)? ?vulnerability using open·kritt\.$/);
      expect(artifact.cardText).not.toContain('secret');
      expect(artifact.cardText).not.toContain('testnet');
      expect(artifact.cardText).not.toContain('CVSS');
      expect(artifact.cardText).not.toContain('9.8');
    }
  });

  it('builds a scan-free community artifact with channel-specific attribution', () => {
    const x = buildCommunityShareArtifact({ channel: 'x' });
    const elsewhere = buildCommunityShareArtifact({ channel: 'elsewhere' });

    expect(x.cardText).toContain('Open-source security');
    expect(x.caption).toContain(X_HANDLE);
    expect(x.caption).toContain(X_DESTINATION);
    expect(x.caption).not.toContain(GITHUB_DESTINATION);
    expect(elsewhere.caption).toContain(GITHUB_DESTINATION);
    expect(elsewhere.caption).not.toContain(X_HANDLE);
  });
});

describe('channel sharing', () => {
  it('uses native file sharing for non-X channels when supported', async () => {
    const share = vi.fn(async () => {});
    const file = { name: 'finding.png' };
    const artifact = buildShareArtifact({ channel: 'elsewhere' });

    await expect(
      shareWithChannel({
        artifact,
        file,
        navigatorObject: { canShare: () => true, share },
        downloadFile: vi.fn(),
        openWindow: vi.fn(),
      })
    ).resolves.toEqual({ kind: 'file-shared' });
    expect(share).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining(GITHUB_DESTINATION), files: [file] })
    );
  });

  it('always downloads the image and opens a tagged X composer', async () => {
    const downloadFile = vi.fn();
    const openWindow = vi.fn();
    const share = vi.fn();
    const artifact = buildShareArtifact({ channel: 'x' });
    const blob = { type: 'image/png' };

    await expect(
      shareWithChannel({
        artifact,
        file: { name: 'finding.png' },
        blob,
        navigatorObject: { canShare: () => true, share },
        downloadFile,
        openWindow,
      })
    ).resolves.toEqual({ kind: 'x-fallback' });
    expect(share).not.toHaveBeenCalled();
    expect(downloadFile).toHaveBeenCalledWith(blob, 'open-kritt-security-finding.png');
    expect(decodeURIComponent(openWindow.mock.calls[0][0])).toContain(X_HANDLE);
    expect(decodeURIComponent(openWindow.mock.calls[0][0])).toContain(X_DESTINATION);
    expect(openWindow.mock.calls[0][0]).toBe(xIntentUrl(artifact.caption));
  });

  it('falls back from image sharing to a GitHub-linked native text share elsewhere', async () => {
    const share = vi.fn(async () => {});
    const artifact = buildShareArtifact({ channel: 'elsewhere' });

    await expect(
      shareWithChannel({
        artifact,
        file: { name: 'finding.png' },
        navigatorObject: { canShare: () => false, share },
      })
    ).resolves.toEqual({ kind: 'text-shared' });
    expect(share).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining(GITHUB_DESTINATION) }));
    expect(share.mock.calls[0][0]).not.toHaveProperty('files');
  });

  it('reports unsupported sharing and can copy the GitHub post independently', async () => {
    const artifact = buildShareArtifact({ channel: 'elsewhere' });
    await expect(shareWithChannel({ artifact, navigatorObject: {} })).resolves.toEqual({ kind: 'unsupported' });

    const writeText = vi.fn(async () => {});
    await copyShareText(artifact.caption, { navigatorObject: { clipboard: { writeText } } });
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining(GITHUB_DESTINATION));
  });
});
