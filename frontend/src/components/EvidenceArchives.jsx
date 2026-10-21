import { useState } from 'react';
import { api } from '../api/client.js';
import { useFetch } from '../lib/useFetch.js';
import { saveBrowserDownload } from '../lib/download.js';
import {
  archiveDownloadFilename,
  archiveEntryLabel,
  archiveSessionPaths,
  formatArchiveBytes,
  formatArchiveTime,
} from '../lib/evidenceArchives.js';
import { Button, ErrorState, Spinner } from './ui.jsx';

const DEFAULT_DESCRIPTION =
  'Workspace copies and harness transcripts saved before the engine deletes a job workspace. Downloads remain available until the retention window expires.';

export default function EvidenceArchives({ scanId, vulnerabilityId, title = 'Evidence archives', description }) {
  const { data, loading, error, reload } = useFetch(
    () => (vulnerabilityId ? api.vulnerabilityArchives(vulnerabilityId) : api.scanArchives(scanId)),
    [scanId, vulnerabilityId]
  );
  const [expanded, setExpanded] = useState(null);
  const [downloading, setDownloading] = useState('');
  const [downloadError, setDownloadError] = useState(null);
  const archives = Array.isArray(data?.archives) ? data.archives : [];

  const download = async (entry, relativePath) => {
    const targetScanId = entry.scanId ?? scanId;
    const key = `${entry.id}:${relativePath}`;
    if (downloading) return;
    if (!targetScanId) {
      setDownloadError(new Error('The scan identifier is missing for this archive.'));
      return;
    }
    setDownloading(key);
    setDownloadError(null);
    try {
      const file = await api.downloadArchiveFile(targetScanId, entry.id, relativePath);
      saveBrowserDownload({ blob: file.blob, filename: archiveDownloadFilename(entry.id, relativePath) });
    } catch (downloadFailure) {
      setDownloadError(downloadFailure);
    } finally {
      setDownloading('');
    }
  };

  return (
    <section
      style={{
        border: '1px solid var(--border)',
        borderRadius: 12,
        background: 'var(--surface)',
        padding: '14px 16px',
        marginBottom: 24,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 14 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>{title}</div>
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4, lineHeight: 1.5 }}>
            {description || DEFAULT_DESCRIPTION}
          </div>
        </div>
        <Button
          variant="ghost"
          onClick={reload}
          disabled={loading}
          style={{ height: 30, padding: '0 12px', fontSize: 12, flex: 'none' }}
        >
          Refresh
        </Button>
      </div>

      {loading && !data && (
        <div style={{ padding: '14px 0' }}>
          <Spinner label="Loading archives…" />
        </div>
      )}
      {error && (
        <div style={{ marginTop: 12 }}>
          <ErrorState error={error} onRetry={reload} />
        </div>
      )}
      {!loading && !error && archives.length === 0 && (
        <div style={{ fontSize: 12.5, color: 'var(--text-3)', marginTop: 12 }}>
          No evidence archives yet. New jobs store a workspace snapshot and harness transcript before cleanup.
        </div>
      )}

      {archives.map((entry) => {
        const sessions = archiveSessionPaths(entry);
        const expandedEntry = expanded === entry.id;
        return (
          <div key={entry.id} style={{ borderTop: '1px solid var(--border-2)', marginTop: 12, paddingTop: 12 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
              <div style={{ flex: '1 1 260px', minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{archiveEntryLabel(entry)}</div>
                <div
                  className="mono"
                  style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 3, overflowWrap: 'anywhere' }}
                >
                  {entry.id} · {formatArchiveTime(entry.archivedAt)} · {formatArchiveBytes(entry.bytes)}
                  {entry.incomplete ? ' · incomplete manifest' : ''}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Button
                  variant="subtle"
                  onClick={() => download(entry, 'workspace.tar.gz')}
                  disabled={Boolean(downloading)}
                  style={{ height: 30, padding: '0 11px', fontSize: 12 }}
                >
                  {downloading === `${entry.id}:workspace.tar.gz` ? 'Downloading…' : 'Workspace (.tar.gz)'}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => download(entry, 'manifest.json')}
                  disabled={Boolean(downloading)}
                  style={{ height: 30, padding: '0 11px', fontSize: 12 }}
                >
                  {downloading === `${entry.id}:manifest.json` ? 'Downloading…' : 'Manifest'}
                </Button>
                {sessions.length > 0 && (
                  <Button
                    variant="ghost"
                    onClick={() => setExpanded(expandedEntry ? null : entry.id)}
                    style={{ height: 30, padding: '0 11px', fontSize: 12 }}
                  >
                    {expandedEntry ? 'Hide sessions' : `Sessions (${sessions.length})`}
                  </Button>
                )}
              </div>
            </div>
            {expandedEntry && sessions.length > 0 && (
              <div style={{ marginTop: 10, paddingLeft: 12, borderLeft: '2px solid var(--border)' }}>
                {sessions.map((file) => (
                  <div key={file} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 0' }}>
                    <span
                      className="mono"
                      style={{ flex: 1, fontSize: 11.5, color: 'var(--text-2)', overflowWrap: 'anywhere' }}
                    >
                      {file}
                    </span>
                    <Button
                      variant="ghost"
                      onClick={() => download(entry, file)}
                      disabled={Boolean(downloading)}
                      style={{ height: 26, padding: '0 9px', fontSize: 11.5 }}
                    >
                      {downloading === `${entry.id}:${file}` ? 'Downloading…' : 'Download'}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {downloadError && (
        <div style={{ marginTop: 10, fontSize: 12, color: 'var(--fail)' }}>
          {downloadError.message || 'The archive download failed.'}
        </div>
      )}
    </section>
  );
}
