// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StatusGlyph } from './ui/status-glyph.jsx';

let reducedMotion = false;
let frameCallbacks = [];

function flushFrame(time) {
  const queued = frameCallbacks;
  frameCallbacks = [];
  queued.forEach(({ callback }) => callback(time));
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  reducedMotion = false;
  frameCallbacks = [];
  vi.stubGlobal('matchMedia', () => ({
    matches: reducedMotion,
    media: '(prefers-reduced-motion: reduce)',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback) {
        this.callback = callback;
      }
      observe() {
        this.callback([{ isIntersecting: true }]);
      }
      disconnect() {}
      takeRecords() {
        return [];
      }
    }
  );
  vi.stubGlobal('requestAnimationFrame', (callback) => {
    frameCallbacks.push({ callback });
    return frameCallbacks.length;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<StatusGlyph activity="running" />);
  });
  return { container, root };
}

describe('StatusGlyph motion', () => {
  it('animates visible glyphs when motion is allowed', async () => {
    const { container, root } = await mount();
    const circle = container.querySelector('circle');

    expect(circle.getAttribute('cx')).toBe('8');
    expect(frameCallbacks).toHaveLength(1);

    await act(async () => {
      flushFrame(100_000);
    });

    expect(circle.getAttribute('cx')).not.toBe('8');
    expect(circle.getAttribute('cx')).toMatch(/^\d+\.\d{2}$/);
    expect(frameCallbacks.length).toBeGreaterThan(0);

    await act(async () => {
      root.unmount();
    });
  });

  it('holds the opening pose without scheduling frames when reduced motion is requested', async () => {
    reducedMotion = true;
    const { container, root } = await mount();
    const circle = container.querySelector('circle');

    expect(circle.getAttribute('cx')).toBe('3.50');
    expect(frameCallbacks).toHaveLength(0);

    await act(async () => {
      root.unmount();
    });
  });
});
