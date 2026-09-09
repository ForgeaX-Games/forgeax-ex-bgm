import { expect, test } from 'bun:test';
import { posix, win32 } from 'node:path';
import { catalogRelativePath } from './build-starter-library.ts';

test('Windows disk paths match the canonical catalog and SFX manifest keys', () => {
  const root = String.raw`C:\runner workspace\library\starter`;
  const file = String.raw`C:\runner workspace\library\starter\sfx\ui sounds\click.mp3`;
  const catalogFile = 'sfx/ui sounds/click.mp3';
  expect(win32.relative(root, file)).not.toBe(catalogFile);
  const onDisk = new Set([catalogRelativePath(root, file, win32)]);
  expect(onDisk.delete(catalogFile)).toBe(true);
  expect(onDisk.size).toBe(0);
  expect(catalogRelativePath(root, file, win32).split('/')).toEqual([
    'sfx', 'ui sounds', 'click.mp3',
  ]);
});

test('POSIX catalog paths retain spaces and literal backslashes in filenames', () => {
  expect(catalogRelativePath('/library/starter', '/library/starter/bgm/quiet bed.ogg', posix))
    .toBe('bgm/quiet bed.ogg');
  expect(catalogRelativePath('/library', String.raw`/library/sfx/a\b.mp3`, posix))
    .toBe(String.raw`sfx/a\b.mp3`);
});
