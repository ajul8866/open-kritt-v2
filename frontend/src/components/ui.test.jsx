import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { Button, CardLinkOverlay, StatusBadge } from './ui.jsx';

describe('status badge', () => {
  it('shows the Solid Glass activity glyph while work is in progress', () => {
    const html = renderToStaticMarkup(<StatusBadge status="running" />);

    expect(html).toContain('data-slot="status-glyph"');
    expect(html).toContain('size-3');
    expect(html).not.toContain('size-4');
    expect(html).toContain('Running');
  });

  it('keeps the static dot for states that are only waiting or finished', () => {
    const html = renderToStaticMarkup(<StatusBadge status="completed" />);

    expect(html).not.toContain('data-slot="status-glyph"');
    expect(html).toContain('Completed');
  });
});

describe('navigation UI', () => {
  it('renders navigation buttons as native links', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <Button to="/workflows/new">New workflow</Button>
      </MemoryRouter>
    );

    expect(html).toContain('<a');
    expect(html).toContain('href="/workflows/new"');
    expect(html).not.toContain('<button');
  });

  it('keeps disabled destination buttons non-navigable', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <Button to="/workflows/new" disabled>
          New workflow
        </Button>
      </MemoryRouter>
    );

    expect(html).toContain('<button');
    expect(html).not.toContain('href=');
  });

  it('renders card overlays as labeled native links', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <div style={{ position: 'relative' }}>
          <CardLinkOverlay to="/scans/12" label="Open scan 12" />
        </div>
      </MemoryRouter>
    );

    expect(html).toContain('href="/scans/12"');
    expect(html).toContain('aria-label="Open scan 12"');
  });
});
