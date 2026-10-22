import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (name) => readFileSync(new URL(name, import.meta.url), 'utf8');

// Pull one rule block out by selector, counting braces so nested rules survive.
function block(css, selector) {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`missing ${selector}`);
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(start, i + 1);
    }
  }
  throw new Error(`unclosed ${selector}`);
}

const SHARED = ['--border', '--accent', '--hover', '--sidebar'];

describe('Solid Glass token scope', () => {
  it('mirrors the four tokens shared with the app palette in both themes', () => {
    const theme = read('./solid-glass.css');
    const scope = read('./solid-glass-scope.css');

    for (const [themeSelector, scopeSelector] of [
      [':root', '.solid-glass'],
      ['.dark', '.dark .solid-glass'],
    ]) {
      const source = block(theme, themeSelector);
      const target = block(scope, scopeSelector);

      for (const name of SHARED) {
        const match = source.match(new RegExp(`${name}:\\s*([^;]+);`));
        expect(match, `${name} missing from ${themeSelector}`).not.toBeNull();
        expect(target).toContain(`${name}: ${match[1].trim()};`);
      }
    }
  });
});
