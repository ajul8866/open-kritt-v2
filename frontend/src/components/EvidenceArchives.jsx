import { Fragment, useState } from 'react';
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
  'Workspace copies and harness transcripts saved before the engine deletes a job workspace. Downloads remain available until the retention window expires. Treat every archive as sensitive.';

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
    <section className="panel" style={{ marginBottom: 'var(--space-8)' }}>
      <div className="panel-head">
        <div>
          <h3 className="panel-title">{title}</h3>
          <div className="panel-note">{description || DEFAULT_DESCRIPTION}</div>
        </div>
        <Button variant="ghost" onClick={reload} disabled={loading} style={{ flex: 'none' }}>
          Refresh
        </Button>
      </div>

      {loading && !data && (
        <div style={{ padding: 'var(--space-5)' }}>
          <Spinner label="Loading archives…" />
        </div>
      )}
      {error && (
        <div style={{ padding: 'var(--space-5)' }}>
          <ErrorState error={error} onRetry={reload} />
        </div>
      )}
      {!loading && !error && archives.length === 0 && (
        <div
          style={{
            padding: 'var(--space-5)',
            color: 'var(--text-3)',
            fontSize: 'var(--text-xs)',
            lineHeight: 'var(--leading-base)',
          }}
        >
          No evidence archives yet. New jobs store a workspace snapshot and harness transcript before cleanup.
        </div>
      )}

      {archives.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Archive</th>
                <th>Archived</th>
                <th className="cell-num">Size</th>
                <th className="cell-num">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {archives.map((entry) => {
                const sessions = archiveSessionPaths(entry);
                const expandedEntry = expanded === entry.id;
                return (
                  <Fragment key={entry.id}>
                    <tr>
                      <td>
                        <span className="cell-main">{archiveEntryLabel(entry)}</span>
                        <span className="cell-sub mono">{entry.id}</span>
                        {entry.incomplete && <span className="cell-sub">Incomplete manifest</span>}
                        {entry.workspaceMode === 'image' && (
                          <span className="cell-sub" style={{ color: 'var(--pend)', whiteSpace: 'normal' }}>
                            Image workspace mode: agent-written files stay in the disposable runner; this archive
                            contains the wrapper workspace and transcript.
                          </span>
                        )}
                      </td>
                      <td className="cell-muted">{formatArchiveTime(entry.archivedAt)}</td>
                      <td className="cell-num mono">{formatArchiveBytes(entry.bytes)}</td>
                      <td>
                        <div className="cell-actions">
                          <Button
                            variant="subtle"
                            onClick={() => download(entry, 'workspace.tar.gz')}
                            disabled={Boolean(downloading)}
                          >
                            {downloading === `${entry.id}:workspace.tar.gz` ? 'Downloading…' : 'Workspace (.tar.gz)'}
                          </Button>
                          <Button
                            variant="ghost"
                            onClick={() => download(entry, 'manifest.json')}
                            disabled={Boolean(downloading)}
                          >
                            {downloading === `${entry.id}:manifest.json` ? 'Downloading…' : 'Manifest'}
                          </Button>
                          {sessions.length > 0 && (
                            <Button
                              variant="ghost"
                              onClick={() => setExpanded(expandedEntry ? null : entry.id)}
                              aria-expanded={expandedEntry}
                              aria-controls={`sessions-${entry.id}`}
                            >
                              {expandedEntry ? 'Hide sessions' : `Sessions (${sessions.length})`}
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {expandedEntry && sessions.length > 0 && (
                      <tr className="scan-detail-row">
                        <td colSpan={4} className="table-detail" id={`sessions-${entry.id}`}>
                          {sessions.map((file) => (
                            <div
                              key={file}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 'var(--space-4)',
                                padding: 'var(--space-2) 0',
                              }}
                            >
                              <span
                                className="mono"
                                style={{
                                  flex: 1,
                                  color: 'var(--text-2)',
                                  fontSize: 'var(--text-2xs)',
                                  overflowWrap: 'anywhere',
                                }}
                              >
                                {file}
                              </span>
                              <Button
                                variant="ghost"
                                onClick={() => download(entry, file)}
                                disabled={Boolean(downloading)}
                              >
                                {downloading === `${entry.id}:${file}` ? 'Downloading…' : 'Download'}
                              </Button>
                            </div>
                          ))}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {downloadError && (
        <div
          role="alert"
          style={{
            padding: 'var(--space-3) var(--space-5)',
            borderTop: '1px solid var(--border-2)',
            color: 'var(--fail)',
            fontSize: 'var(--text-xs)',
          }}
        >
          {downloadError.message || 'The archive download failed.'}
        </div>
      )}
    </section>
  );
}
