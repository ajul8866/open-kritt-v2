const KIND_LABELS = {
  dedupe: 'Dedupe',
  post_script: 'Post-script',
  ranker: 'Ranker',
  step: 'Scan step',
  supplemental_post_script: 'Supplemental post-script',
};

export function formatArchiveBytes(value) {
  if (value === null || value === undefined || value === '') return '—';
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let size = bytes / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
}

export function archiveKindLabel(kind) {
  const key = `${kind ?? ''}`.trim();
  if (!key) return 'Job';
  if (Object.prototype.hasOwnProperty.call(KIND_LABELS, key)) return KIND_LABELS[key];
  const words = key.replace(/_/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Job';
}

export function archiveEntryLabel(entry = {}) {
  const parts = [archiveKindLabel(entry.kind)];
  if (entry.postScriptName) parts.push(entry.postScriptName);
  else if (entry.stepId !== null && entry.stepId !== undefined) parts.push(`step ${entry.stepId}`);
  if (entry.vulnerabilityId !== null && entry.vulnerabilityId !== undefined) {
    parts.push(`finding #${entry.vulnerabilityId}`);
  }
  return parts.join(' · ');
}

export function archiveFileLabel(relativePath) {
  if (relativePath === 'workspace.tar.gz') return 'Workspace archive (.tar.gz)';
  if (relativePath === 'manifest.json') return 'Manifest (JSON)';
  if (relativePath === 'README.txt') return 'README';
  return `${relativePath ?? ''}`.split('/').pop() || 'File';
}

export function archiveSessionPaths(entry = {}) {
  const files = Array.isArray(entry.sessionFiles) ? entry.sessionFiles : [];
  return files.filter(
    (value) => typeof value === 'string' && value.startsWith('sessions/') && value.endsWith('.jsonl')
  );
}

export function archiveDownloadFilename(entryId, relativePath) {
  const entryToken = `${entryId ?? 'archive'}`.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'archive';
  const fileToken =
    `${relativePath ?? 'workspace.tar.gz'}`
      .split('/')
      .pop()
      .replace(/[^A-Za-z0-9._-]+/g, '-') || 'download';
  return `${entryToken}-${fileToken}`;
}

export function formatArchiveTime(value) {
  if (!value) return '—';
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return '—';
  return new Date(parsed).toLocaleString();
}
