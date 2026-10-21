import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import EvidenceArchives from './EvidenceArchives.jsx';

describe('EvidenceArchives', () => {
  it('renders the archive panel header and loading state', () => {
    const html = renderToStaticMarkup(<EvidenceArchives scanId="381" title="PoC evidence archives" />);

    expect(html).toContain('PoC evidence archives');
    expect(html).toContain('Loading archives');
    expect(html).toContain('Refresh');
  });

  it('uses the built-in explanation when none is supplied', () => {
    const html = renderToStaticMarkup(<EvidenceArchives scanId="381" />);

    expect(html).toContain('Evidence archives');
    expect(html).toContain('Workspace copies and harness transcripts saved');
  });
});
