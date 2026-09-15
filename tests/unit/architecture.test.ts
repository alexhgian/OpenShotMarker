import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * CLAUDE.md: "core/ must build and test with zero platform dependencies. If a core/
 * file imports from platform/ or ui/, that is a bug." This is that rule, enforced.
 */

const SRC = new URL('../../src/', import.meta.url).pathname;

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? filesUnder(full) : full.endsWith('.ts') ? [full] : [];
  });
}

/** Strip comments, so a rule is never tripped by a comment stating the rule. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Import specifiers only — not words that merely appear in prose or identifiers. */
function importsOf(raw: string): string[] {
  const source = stripComments(raw);
  const specs: string[] = [];
  const re = /(?:^|\n)\s*import\s[^;]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    specs.push((m[1] ?? m[2])!);
  }
  return specs;
}

describe('layout rules', () => {
  const coreFiles = filesUnder(join(SRC, 'core'));

  it('has core files to check', () => {
    expect(coreFiles.length).toBeGreaterThan(5);
  });

  it('core/ imports nothing from platform/ or ui/', () => {
    const offenders: string[] = [];
    for (const file of coreFiles) {
      for (const spec of importsOf(readFileSync(file, 'utf8'))) {
        if (/(^|\/)(platform|ui)\//.test(spec)) offenders.push(`${file} -> ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('core/ imports no React, no Capacitor and no DOM-only package', () => {
    const banned = /^(react|react-dom|@capacitor|sql\.js)/;
    const offenders: string[] = [];
    for (const file of coreFiles) {
      for (const spec of importsOf(readFileSync(file, 'utf8'))) {
        if (banned.test(spec)) offenders.push(`${file} -> ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('core/ reaches outside itself only for node type-only imports, if at all', () => {
    for (const file of coreFiles) {
      for (const spec of importsOf(readFileSync(file, 'utf8'))) {
        // Relative imports inside core, and nothing else.
        expect(spec.startsWith('.'), `${file} imports ${spec}`).toBe(true);
      }
    }
  });

  it('core/ never uses Date.now() where the value could become a timecode (§3.3)', () => {
    // Date.now is allowed only in markers.ts/ulid.ts, for created_at and row ordering,
    // and is documented there. It must never appear in timecode.ts or clock.ts.
    for (const name of ['timecode.ts', 'clock.ts']) {
      const src = stripComments(readFileSync(join(SRC, 'core', name), 'utf8'));
      expect(src, `${name} must not read a wall clock`).not.toMatch(/Date\.now\(/);
      expect(src).not.toMatch(/new Date\(/);
    }
  });
});
