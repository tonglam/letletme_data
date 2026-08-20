import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const gitignore = readFileSync('.gitignore', 'utf8');
const gitleaks = readFileSync('.gitleaks.toml', 'utf8');

describe('tracked secret configuration', () => {
  test('ignores arbitrary dotenv files while allowing only examples', () => {
    expect(gitignore).toContain('.env.*');
    for (const example of ['.env.example', '.env.deploy.example', '.env.migrate.example']) {
      expect(gitignore).toContain(`!${example}`);
    }
    expect(gitignore).not.toContain('!.env.production');
  });

  test('uses placeholder regexes without dotenv path exemptions', () => {
    expect(gitleaks).toContain('useDefault = true');
    expect(gitleaks).toContain('regexes =');
    expect(gitleaks).not.toMatch(/paths\s*=.*\.env/i);
    expect(gitleaks).not.toMatch(/\.env\*/i);
  });
});
