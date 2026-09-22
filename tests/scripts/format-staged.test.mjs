import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const config = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))['lint-staged'];
const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';

test('staged formatting fixes and stages changes while preserving unstaged edits; parser errors roll back', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'format-staged-'));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  const format = () =>
    spawnSync(
      process.execPath,
      [join(root, 'node_modules/lint-staged/bin/lint-staged.js'), '--quiet'],
      {
        cwd,
        encoding: 'utf8',
        env: {
          ...process.env,
          [pathKey]: join(root, 'node_modules/.bin') + delimiter + process.env[pathKey],
        },
      },
    );
  const file = join(cwd, 'file with spaces.js');
  try {
    git('init', '--quiet');
    git('config', 'core.autocrlf', 'false');
    git('config', 'core.hooksPath', '.unused-hooks');
    git('config', 'user.name', 'Format test');
    git('config', 'user.email', 'format-test@example.invalid');
    writeFileSync(
      join(cwd, 'package.json'),
      JSON.stringify({ 'lint-staged': config }, null, 2) + '\n',
    );
    writeFileSync(join(cwd, '.prettierignore'), 'ignored.js\n');
    writeFileSync(
      file,
      'const value = 0;\n\n// Keep this separate from the first line.\nconst local = 0;\n',
    );
    git('add', '.');
    git(
      'commit',
      '--quiet',
      '-m',
      'test: seed formatting fixture\n\nCo-authored-by: Codex <codex@openai.com>',
    );
    writeFileSync(
      file,
      'const value=1\n\n// Keep this separate from the first line.\nconst local = 0;\n',
    );
    git('add', '--', 'file with spaces.js');
    writeFileSync(
      file,
      'const value=1\n\n// Keep this separate from the first line.\nconst local = 2;\n',
    );
    writeFileSync(join(cwd, 'ignored.js'), 'not javascript {');
    writeFileSync(join(cwd, 'asset.bin'), Buffer.from([0, 255]));
    git('add', '--', 'ignored.js', 'asset.bin');
    const result = format();
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(
      git('show', ':file with spaces.js'),
      'const value = 1;\n\n// Keep this separate from the first line.\nconst local = 0;\n',
    );
    assert.equal(
      readFileSync(file, 'utf8'),
      'const value = 1;\n\n// Keep this separate from the first line.\nconst local = 2;\n',
    );
    assert.equal(git('show', ':ignored.js'), 'not javascript {');
    assert.equal(git('stash', 'list'), '');
    writeFileSync(join(cwd, 'broken.js'), 'const = {');
    git('add', '--', 'broken.js');
    const staged = git('diff', '--cached');
    const unstaged = git('diff');
    assert.notEqual(format().status, 0);
    assert.equal(git('diff', '--cached'), staged);
    assert.equal(git('diff'), unstaged);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
