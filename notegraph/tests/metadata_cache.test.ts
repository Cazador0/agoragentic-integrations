import { describe, expect, test } from 'vitest';
import { MetadataCache, makeFileMetadata } from '../src/core/metadata_cache';
import type { FileMetadata } from '../src/shared/types';

function md(path: string, source: string): FileMetadata {
  return makeFileMetadata(path, source, { mtimeMs: 1000, size: source.length });
}

function attachment(path: string): FileMetadata {
  return makeFileMetadata(path, null, { mtimeMs: 1000, size: 0 });
}

describe('makeFileMetadata', () => {
  test('null source produces an attachment with empty tags and aliases', () => {
    const meta = attachment('assets/Photo.PNG');
    expect(meta.parsed).toBeNull();
    expect(meta.tags).toEqual([]);
    expect(meta.aliases).toEqual([]);
    expect(meta.basename).toBe('Photo');
    expect(meta.extension).toBe('png');
    expect(meta.isMarkdown).toBe(false);
    expect(meta.mtimeMs).toBe(1000);
    expect(meta.size).toBe(0);
  });

  test('markdown file is parsed and path parts derived', () => {
    const meta = md('projects/Roadmap.md', '# Roadmap\n');
    expect(meta.parsed).not.toBeNull();
    expect(meta.basename).toBe('Roadmap');
    expect(meta.extension).toBe('md');
    expect(meta.isMarkdown).toBe(true);
  });

  test('non-markdown source is not parsed', () => {
    const meta = makeFileMetadata('notes.txt', '[[Link]] #tag', { mtimeMs: 1, size: 13 });
    expect(meta.parsed).toBeNull();
    expect(meta.tags).toEqual([]);
  });

  test('extensionless and dotfile names', () => {
    expect(makeFileMetadata('Makefile', null, { mtimeMs: 1, size: 0 }).basename).toBe('Makefile');
    expect(makeFileMetadata('Makefile', null, { mtimeMs: 1, size: 0 }).extension).toBe('');
    expect(makeFileMetadata('a/.hidden', null, { mtimeMs: 1, size: 0 }).basename).toBe('.hidden');
    expect(makeFileMetadata('a/.hidden', null, { mtimeMs: 1, size: 0 }).extension).toBe('');
  });

  test('frontmatter tags as comma-separated string are split and trimmed', () => {
    const meta = md('n.md', '---\ntags: alpha, beta , gamma\n---\n');
    expect(meta.tags).toEqual(['alpha', 'beta', 'gamma']);
  });

  test('frontmatter tags as array accepts strings and numbers and strips leading #', () => {
    const meta = md('n.md', '---\ntags: ["#work", 2024, "  spaced  "]\n---\n');
    expect(meta.tags).toEqual(['work', '2024', 'spaced']);
  });

  test("singular 'tag' key is honored", () => {
    const meta = md('n.md', '---\ntag: solo\n---\n');
    expect(meta.tags).toEqual(['solo']);
  });

  test('body tags come first, then frontmatter, deduplicated case-insensitively keeping first casing', () => {
    const meta = md('n.md', '---\ntags: [Alpha, beta, ZETA]\n---\n#zeta #Beta text\n');
    expect(meta.tags).toEqual(['zeta', 'Beta', 'Alpha']);
  });

  test('malformed frontmatter tag values never throw and are ignored', () => {
    const meta = md('n.md', '---\ntags: { nested: true }\n---\n#ok\n');
    expect(meta.tags).toEqual(['ok']);
  });

  test('aliases accept string, comma string, array, and singular key without # handling', () => {
    expect(md('n.md', '---\naliases: One, Two\n---\n').aliases).toEqual(['One', 'Two']);
    expect(md('n.md', '---\naliases: ["#keep-hash", 7]\n---\n').aliases).toEqual(['#keep-hash', '7']);
    expect(md('n.md', '---\nalias: Solo\n---\n').aliases).toEqual(['Solo']);
    expect(md('n.md', 'no frontmatter').aliases).toEqual([]);
  });
});

describe('link resolution', () => {
  test('basename, name-with-extension, and vault-absolute lookups', () => {
    const cache = new MetadataCache();
    cache.setFile(md('Welcome.md', ''));
    cache.setFile(attachment('assets/Photo.PNG'));
    expect(cache.resolveLink('Welcome', 'x.md')).toBe('Welcome.md');
    expect(cache.resolveLink('Welcome.md', 'x.md')).toBe('Welcome.md');
    expect(cache.resolveLink('Photo', 'x.md')).toBe('assets/Photo.PNG');
    expect(cache.resolveLink('Photo.PNG', 'x.md')).toBe('assets/Photo.PNG');
    expect(cache.resolveLink('photo.png', 'x.md')).toBe('assets/Photo.PNG');
    expect(cache.resolveLink('assets/Photo.PNG', 'x.md')).toBe('assets/Photo.PNG');
    expect(cache.resolveLink('Nope', 'x.md')).toBeNull();
  });

  test('exact basename match beats a shorter case-insensitive match', () => {
    const cache = new MetadataCache();
    cache.setFile(md('note.md', ''));
    cache.setFile(md('folder/Note.md', ''));
    expect(cache.resolveLink('Note', 'x.md')).toBe('folder/Note.md');
    expect(cache.resolveLink('note', 'x.md')).toBe('note.md');
  });

  test('case-insensitive fallback ties break by shortest path then lexicographic', () => {
    const cache = new MetadataCache();
    cache.setFile(md('alphaville/note.md', ''));
    cache.setFile(md('beta/Note.md', ''));
    expect(cache.resolveLink('NOTE', 'x.md')).toBe('beta/Note.md');

    const cacheTwo = new MetadataCache();
    cacheTwo.setFile(md('b/Note.md', ''));
    cacheTwo.setFile(md('a/Note.md', ''));
    expect(cacheTwo.resolveLink('Note', 'x.md')).toBe('a/Note.md');
  });

  test('exact-tier ties prefer the shortest path', () => {
    const cache = new MetadataCache();
    cache.setFile(md('projects/Roadmap.md', ''));
    cache.setFile(md('Roadmap.md', ''));
    expect(cache.resolveLink('Roadmap', 'x.md')).toBe('Roadmap.md');
  });

  test('aliases participate at lowest priority', () => {
    const cache = new MetadataCache();
    cache.setFile(md('Ideas.md', '---\naliases: [Brainstorm, "The Plan"]\n---\n'));
    expect(cache.resolveLink('brainstorm', 'x.md')).toBe('Ideas.md');
    expect(cache.resolveLink('The Plan', 'x.md')).toBe('Ideas.md');

    cache.setFile(md('Brainstorm.md', ''));
    expect(cache.resolveLink('brainstorm', 'x.md')).toBe('Brainstorm.md');
  });

  test('vault-absolute, relative subfolder, and parent-relative links from a nested note', () => {
    const cache = new MetadataCache();
    cache.setFile(md('Welcome.md', ''));
    cache.setFile(md('projects/Roadmap.md', ''));
    cache.setFile(
      md('projects/Note.md', '[[Roadmap]] and [[projects/Roadmap]] and [[../Welcome]]'),
    );
    expect(cache.resolvedLinks.get('projects/Note.md')).toEqual(
      new Map([
        ['projects/Roadmap.md', 2],
        ['Welcome.md', 1],
      ]),
    );
    expect(cache.unresolvedLinks.has('projects/Note.md')).toBe(false);
  });

  test('slash links resolve relative to the source folder when not vault-absolute', () => {
    const cache = new MetadataCache();
    cache.setFile(md('projects/sub/Deep.md', ''));
    cache.setFile(md('projects/Note.md', '[[sub/Deep]]'));
    expect(cache.getRefs('projects/Note.md')[0]?.resolvedPath).toBe('projects/sub/Deep.md');
  });

  test('vault-absolute paths match case-insensitively with and without .md', () => {
    const cache = new MetadataCache();
    cache.setFile(md('projects/Roadmap.md', ''));
    expect(cache.resolveLink('PROJECTS/ROADMAP', 'x.md')).toBe('projects/Roadmap.md');
    expect(cache.resolveLink('Projects/Roadmap.MD', 'x.md')).toBe('projects/Roadmap.md');
  });

  test('.. escaping the vault root does not resolve', () => {
    const cache = new MetadataCache();
    cache.setFile(md('Welcome.md', ''));
    cache.setFile(md('Root.md', '[[../Welcome]]'));
    expect(cache.getRefs('Root.md')[0]?.resolvedPath).toBeNull();
    expect(cache.unresolvedLinks.get('Root.md')?.get('../Welcome')).toBe(1);
  });

  test('unresolved link text is stored as typed', () => {
    const cache = new MetadataCache();
    cache.setFile(md('A.md', '[[MISSING Page]]'));
    expect(cache.unresolvedLinks.get('A.md')?.get('MISSING Page')).toBe(1);
  });
});

describe('self-links', () => {
  test('empty target resolves to the source and counts in resolvedLinks', () => {
    const cache = new MetadataCache();
    cache.setFile(md('S.md', 'see [[#Section]]'));
    expect(cache.resolvedLinks.get('S.md')?.get('S.md')).toBe(1);
    expect(cache.getRefs('S.md')).toEqual([
      { text: '', subpath: '#Section', embed: false, resolvedPath: 'S.md' },
    ]);
    expect(cache.getBacklinks('S.md')).toEqual(new Map([['S.md', 1]]));
  });
});

describe('promote on add', () => {
  test('adding a file resolves previously unresolved basename links', () => {
    const cache = new MetadataCache();
    cache.setFile(md('A.md', '[[Missing]] and [[missing]]'));
    expect(cache.unresolvedLinks.get('A.md')).toEqual(
      new Map([
        ['Missing', 1],
        ['missing', 1],
      ]),
    );

    cache.setFile(md('Missing.md', ''));
    expect(cache.unresolvedLinks.has('A.md')).toBe(false);
    expect(cache.resolvedLinks.get('A.md')?.get('Missing.md')).toBe(2);
    expect(cache.getRefs('A.md').map((ref) => ref.resolvedPath)).toEqual([
      'Missing.md',
      'Missing.md',
    ]);
  });

  test('adding a file with a matching alias promotes unresolved links', () => {
    const cache = new MetadataCache();
    cache.setFile(md('B.md', '[[nickname]]'));
    expect(cache.unresolvedLinks.get('B.md')?.get('nickname')).toBe(1);

    cache.setFile(md('C.md', '---\naliases: [Nickname]\n---\n'));
    expect(cache.resolvedLinks.get('B.md')?.get('C.md')).toBe(1);
    expect(cache.unresolvedLinks.has('B.md')).toBe(false);
  });

  test('adding a file promotes unresolved folder-relative links', () => {
    const cache = new MetadataCache();
    cache.setFile(md('projects/P.md', '[[sub/Thing]]'));
    expect(cache.unresolvedLinks.get('projects/P.md')?.get('sub/Thing')).toBe(1);

    cache.setFile(md('projects/sub/Thing.md', ''));
    expect(cache.resolvedLinks.get('projects/P.md')?.get('projects/sub/Thing.md')).toBe(1);
  });

  test('adding a file promotes unresolved parent-relative links', () => {
    const cache = new MetadataCache();
    cache.setFile(md('projects/P.md', '[[../Shared]]'));
    expect(cache.unresolvedLinks.get('projects/P.md')?.get('../Shared')).toBe(1);

    cache.setFile(md('Shared.md', ''));
    expect(cache.resolvedLinks.get('projects/P.md')?.get('Shared.md')).toBe(1);
    expect(cache.unresolvedLinks.has('projects/P.md')).toBe(false);
  });
});

describe('demote on delete', () => {
  test('deleting a target demotes exactly its inbound refs to unresolved', () => {
    const cache = new MetadataCache();
    cache.setFile(md('B.md', ''));
    cache.setFile(md('Other.md', ''));
    cache.setFile(md('A.md', '[[B]] [[Other]]'));
    expect(cache.resolvedLinks.get('A.md')?.get('B.md')).toBe(1);

    cache.deleteFile('B.md');
    expect(cache.getFile('B.md')).toBeUndefined();
    expect(cache.unresolvedLinks.get('A.md')?.get('B')).toBe(1);
    expect(cache.resolvedLinks.get('A.md')).toEqual(new Map([['Other.md', 1]]));
    expect(cache.getBacklinks('B.md')).toEqual(new Map());
  });

  test('deleting one candidate re-resolves inbound links to the remaining one', () => {
    const cache = new MetadataCache();
    cache.setFile(md('x/Note.md', ''));
    cache.setFile(md('y/Note.md', ''));
    cache.setFile(md('A.md', '[[Note]]'));
    expect(cache.resolvedLinks.get('A.md')?.get('x/Note.md')).toBe(1);

    cache.deleteFile('x/Note.md');
    expect(cache.resolvedLinks.get('A.md')?.get('y/Note.md')).toBe(1);
    expect(cache.unresolvedLinks.has('A.md')).toBe(false);
  });

  test('deleting an unknown path is a no-op', () => {
    const cache = new MetadataCache();
    cache.setFile(md('A.md', ''));
    cache.deleteFile('ghost.md');
    expect(cache.size).toBe(1);
  });
});

describe('renameFile', () => {
  test('rename with same basename rewires inbound links to the new path', () => {
    const cache = new MetadataCache();
    cache.setFile(md('Target.md', ''));
    cache.setFile(md('A.md', '[[Target]]'));

    cache.renameFile('Target.md', 'archive/Target.md');
    expect(cache.getFile('Target.md')).toBeUndefined();
    expect(cache.getFile('archive/Target.md')?.basename).toBe('Target');
    expect(cache.resolvedLinks.get('A.md')?.get('archive/Target.md')).toBe(1);
    expect(cache.getBacklinks('archive/Target.md')).toEqual(new Map([['A.md', 1]]));
    expect(cache.getBacklinks('Target.md')).toEqual(new Map());
  });

  test('rename to a new basename demotes old inbound links and promotes matching unresolved ones', () => {
    const cache = new MetadataCache();
    cache.setFile(md('Old.md', ''));
    cache.setFile(md('A.md', '[[Old]]'));
    cache.setFile(md('C.md', '[[New]]'));
    expect(cache.unresolvedLinks.get('C.md')?.get('New')).toBe(1);

    cache.renameFile('Old.md', 'New.md');
    expect(cache.unresolvedLinks.get('A.md')?.get('Old')).toBe(1);
    expect(cache.resolvedLinks.has('A.md')).toBe(false);
    expect(cache.resolvedLinks.get('C.md')?.get('New.md')).toBe(1);
    expect(cache.unresolvedLinks.has('C.md')).toBe(false);
  });

  test('the moved file own relative refs are re-resolved from the new folder', () => {
    const cache = new MetadataCache();
    cache.setFile(md('Welcome.md', ''));
    cache.setFile(md('projects/Note.md', '[[../Welcome]]'));
    expect(cache.resolvedLinks.get('projects/Note.md')?.get('Welcome.md')).toBe(1);

    cache.renameFile('projects/Note.md', 'a/b/Note.md');
    expect(cache.resolvedLinks.has('a/b/Note.md')).toBe(false);
    expect(cache.unresolvedLinks.get('a/b/Note.md')?.get('../Welcome')).toBe(1);
    expect(cache.resolvedLinks.has('projects/Note.md')).toBe(false);
    expect(cache.getBacklinks('Welcome.md')).toEqual(new Map());
  });

  test('self refs follow the rename', () => {
    const cache = new MetadataCache();
    cache.setFile(md('S.md', '[[#top]]'));
    cache.renameFile('S.md', 'T.md');
    expect(cache.resolvedLinks.get('T.md')?.get('T.md')).toBe(1);
    expect(cache.resolvedLinks.has('S.md')).toBe(false);
    expect(cache.getRefs('S.md')).toEqual([]);
    expect(cache.getRefs('T.md')[0]?.resolvedPath).toBe('T.md');
  });

  test('renaming an unknown path or to the same path is a no-op', () => {
    const cache = new MetadataCache();
    cache.setFile(md('A.md', ''));
    let fired = 0;
    cache.onChange(() => {
      fired += 1;
    });
    cache.renameFile('ghost.md', 'x.md');
    cache.renameFile('A.md', 'A.md');
    expect(fired).toBe(0);
    expect(cache.size).toBe(1);
  });
});

describe('counts and backlinks', () => {
  test('duplicate links to the same target accumulate', () => {
    const cache = new MetadataCache();
    cache.setFile(md('B.md', ''));
    cache.setFile(md('A.md', '[[B]] then [[B|alias]] then ![[B]]'));
    expect(cache.resolvedLinks.get('A.md')?.get('B.md')).toBe(3);
    expect(cache.getBacklinks('B.md')).toEqual(new Map([['A.md', 3]]));
  });

  test('getBacklinks merges multiple sources with their counts', () => {
    const cache = new MetadataCache();
    cache.setFile(md('Hub.md', ''));
    cache.setFile(md('X.md', '[[Hub]] [[Hub]]'));
    cache.setFile(md('Y.md', '[[Hub]]'));
    expect(cache.getBacklinks('Hub.md')).toEqual(
      new Map([
        ['X.md', 2],
        ['Y.md', 1],
      ]),
    );
    expect(cache.getBacklinks('X.md')).toEqual(new Map());
  });
});

describe('getRefs', () => {
  test('preserves order, embed flags, subpath, and raw text', () => {
    const cache = new MetadataCache();
    cache.setFile(attachment('img.png'));
    cache.setFile(md('R.md', '[[Note#Section|Alias]] ![[img.png]] [guide](docs/guide%20one.md)'));
    expect(cache.getRefs('R.md')).toEqual([
      { text: 'Note', subpath: '#Section', embed: false, resolvedPath: null },
      { text: 'img.png', subpath: undefined, embed: true, resolvedPath: 'img.png' },
      { text: 'docs/guide one.md', subpath: undefined, embed: false, resolvedPath: null },
    ]);
  });

  test('returns an empty list for attachments and unknown paths', () => {
    const cache = new MetadataCache();
    cache.setFile(attachment('img.png'));
    expect(cache.getRefs('img.png')).toEqual([]);
    expect(cache.getRefs('nowhere.md')).toEqual([]);
  });
});

describe('setFile modify', () => {
  test('re-diffs old contributions before adding new ones', () => {
    const cache = new MetadataCache();
    cache.setFile(md('B.md', ''));
    cache.setFile(md('A.md', '[[B]] [[B]]'));
    expect(cache.resolvedLinks.get('A.md')?.get('B.md')).toBe(2);

    cache.setFile(md('A.md', '[[B]] [[Gone]]'));
    expect(cache.resolvedLinks.get('A.md')?.get('B.md')).toBe(1);
    expect(cache.unresolvedLinks.get('A.md')?.get('Gone')).toBe(1);
    expect(cache.getBacklinks('B.md')).toEqual(new Map([['A.md', 1]]));
  });

  test('removing an alias demotes links that resolved through it', () => {
    const cache = new MetadataCache();
    cache.setFile(md('Ideas.md', '---\naliases: [Brainstorm]\n---\n'));
    cache.setFile(md('A.md', '[[Brainstorm]]'));
    expect(cache.resolvedLinks.get('A.md')?.get('Ideas.md')).toBe(1);

    cache.setFile(md('Ideas.md', 'no aliases now'));
    expect(cache.resolvedLinks.has('A.md')).toBe(false);
    expect(cache.unresolvedLinks.get('A.md')?.get('Brainstorm')).toBe(1);
  });

  test('adding an alias in a modify promotes matching unresolved links', () => {
    const cache = new MetadataCache();
    cache.setFile(md('Ideas.md', ''));
    cache.setFile(md('A.md', '[[Brainstorm]]'));
    expect(cache.unresolvedLinks.get('A.md')?.get('Brainstorm')).toBe(1);

    cache.setFile(md('Ideas.md', '---\naliases: [Brainstorm]\n---\n'));
    expect(cache.resolvedLinks.get('A.md')?.get('Ideas.md')).toBe(1);
  });
});

describe('onChange', () => {
  test('fires synchronously once per mutating call and supports unsubscribe', () => {
    const cache = new MetadataCache();
    let fired = 0;
    const unsubscribe = cache.onChange(() => {
      fired += 1;
    });

    cache.setFile(md('A.md', '[[B]]'));
    expect(fired).toBe(1);

    cache.setFile(md('B.md', ''));
    expect(fired).toBe(2);

    cache.deleteFile('missing.md');
    expect(fired).toBe(2);

    cache.renameFile('B.md', 'C.md');
    expect(fired).toBe(3);

    cache.deleteFile('C.md');
    expect(fired).toBe(4);

    unsubscribe();
    cache.setFile(md('D.md', ''));
    expect(fired).toBe(4);
  });
});

describe('cache basics', () => {
  test('size, files, and getFile reflect the current contents', () => {
    const cache = new MetadataCache();
    expect(cache.size).toBe(0);
    cache.setFile(md('A.md', ''));
    cache.setFile(attachment('img.png'));
    expect(cache.size).toBe(2);
    expect(cache.files().map((file) => file.path).sort()).toEqual(['A.md', 'img.png']);
    expect(cache.getFile('A.md')?.isMarkdown).toBe(true);
    expect(cache.getFile('img.png')?.isMarkdown).toBe(false);
    cache.deleteFile('A.md');
    expect(cache.size).toBe(1);
  });
});

describe('resolved links follow better candidates (order independence)', () => {
  test('a shorter-path duplicate basename rewires existing resolved links', () => {
    const cache = new MetadataCache();
    cache.setFile(md('a/Note.md', ''));
    cache.setFile(md('S.md', '[[Note]]'));
    expect(cache.getRefs('S.md')[0]?.resolvedPath).toBe('a/Note.md');

    cache.setFile(md('Note.md', ''));
    expect(cache.getRefs('S.md')[0]?.resolvedPath).toBe('Note.md');
    expect(cache.resolvedLinks.get('S.md')).toEqual(new Map([['Note.md', 1]]));
    expect(cache.getBacklinks('Note.md')).toEqual(new Map([['S.md', 1]]));
    expect(cache.getBacklinks('a/Note.md').size).toBe(0);
  });

  test('insertion order does not change the final resolution', () => {
    const orders: Array<Array<[string, string]>> = [
      [
        ['a/Note.md', ''],
        ['S.md', '[[Note]]'],
        ['Note.md', ''],
      ],
      [
        ['Note.md', ''],
        ['a/Note.md', ''],
        ['S.md', '[[Note]]'],
      ],
      [
        ['S.md', '[[Note]]'],
        ['Note.md', ''],
        ['a/Note.md', ''],
      ],
    ];
    const outcomes = orders.map((order) => {
      const cache = new MetadataCache();
      for (const [path, source] of order) {
        cache.setFile(md(path, source));
      }
      return cache.getRefs('S.md')[0]?.resolvedPath;
    });
    expect(outcomes).toEqual(['Note.md', 'Note.md', 'Note.md']);
  });

  test('an alias-resolved link is displaced by a real file with that basename', () => {
    const cache = new MetadataCache();
    cache.setFile(md('A.md', '---\naliases: [Nick]\n---\n'));
    cache.setFile(md('S.md', '[[Nick]]'));
    expect(cache.getRefs('S.md')[0]?.resolvedPath).toBe('A.md');

    cache.setFile(md('Nick.md', ''));
    expect(cache.getRefs('S.md')[0]?.resolvedPath).toBe('Nick.md');
    expect(cache.getBacklinks('A.md').size).toBe(0);
  });

  test('a case-insensitive match is displaced by an exact-case file', () => {
    const cache = new MetadataCache();
    cache.setFile(md('NOTE.md', ''));
    cache.setFile(md('S.md', '[[note]]'));
    expect(cache.getRefs('S.md')[0]?.resolvedPath).toBe('NOTE.md');

    cache.setFile(md('note.md', ''));
    expect(cache.getRefs('S.md')[0]?.resolvedPath).toBe('note.md');
  });

  test('renameFile into a shadowing position rewires existing resolved links', () => {
    const cache = new MetadataCache();
    cache.setFile(md('a/Note.md', ''));
    cache.setFile(md('Other.md', ''));
    cache.setFile(md('S.md', '[[Note]]'));
    expect(cache.getRefs('S.md')[0]?.resolvedPath).toBe('a/Note.md');

    cache.renameFile('Other.md', 'Note.md');
    expect(cache.getRefs('S.md')[0]?.resolvedPath).toBe('Note.md');
  });
});

describe('relative link promotion', () => {
  test("a './'-prefixed markdown link is promoted when its target appears", () => {
    const cache = new MetadataCache();
    cache.setFile(md('sub/a.md', '[sibling](./note.md)'));
    expect(cache.getRefs('sub/a.md')[0]?.resolvedPath).toBeNull();

    cache.setFile(md('sub/note.md', ''));
    expect(cache.getRefs('sub/a.md')[0]?.resolvedPath).toBe('sub/note.md');
    expect(cache.unresolvedLinks.has('sub/a.md')).toBe(false);
  });

  test("a '[[./sub/Thing]]' wikilink from a folder is promoted on target add", () => {
    const cache = new MetadataCache();
    cache.setFile(md('projects/plan.md', '[[./sub/Thing]]'));
    expect(cache.getRefs('projects/plan.md')[0]?.resolvedPath).toBeNull();

    cache.setFile(md('projects/sub/Thing.md', ''));
    expect(cache.getRefs('projects/plan.md')[0]?.resolvedPath).toBe('projects/sub/Thing.md');
  });

  test("a '../sibling/target' link is still promoted when the target file appears", () => {
    const cache = new MetadataCache();
    cache.setFile(md('a/deep/s.md', '[up](../sibling/target.md)'));
    expect(cache.getRefs('a/deep/s.md')[0]?.resolvedPath).toBeNull();

    cache.setFile(md('a/sibling/target.md', ''));
    expect(cache.getRefs('a/deep/s.md')[0]?.resolvedPath).toBe('a/sibling/target.md');
    expect(cache.unresolvedLinks.has('a/deep/s.md')).toBe(false);
  });

  test("a vault-root relative link ('../x' joining to the root) is promoted", () => {
    const cache = new MetadataCache();
    cache.setFile(md('folder/s.md', '[[../Top]]'));
    expect(cache.getRefs('folder/s.md')[0]?.resolvedPath).toBeNull();

    cache.setFile(md('Top.md', ''));
    expect(cache.getRefs('folder/s.md')[0]?.resolvedPath).toBe('Top.md');
  });
});

describe('renameFile onto an existing path', () => {
  test("re-resolves links that reached the overwritten file through its alias", () => {
    const cache = new MetadataCache();
    cache.setFile(md('A.md', '---\naliases: [Nick]\n---\n'));
    cache.setFile(md('S.md', '[[Nick]]'));
    cache.setFile(md('B.md', ''));
    expect(cache.getRefs('S.md')[0]?.resolvedPath).toBe('A.md');

    cache.renameFile('B.md', 'A.md');
    expect(cache.getRefs('S.md')[0]?.resolvedPath).toBeNull();
    expect(cache.unresolvedLinks.get('S.md')?.get('Nick')).toBe(1);
    expect(cache.getBacklinks('A.md').size).toBe(0);
  });
});

describe('BOM tolerance', () => {
  test('frontmatter tags and aliases survive a leading UTF-8 BOM', () => {
    const cache = new MetadataCache();
    cache.setFile(md('Bommed.md', '﻿---\ntags: [alpha]\naliases: [Nick]\n---\nBody\n'));
    const meta = cache.getFile('Bommed.md');
    expect(meta?.tags).toEqual(['alpha']);
    expect(meta?.aliases).toEqual(['Nick']);

    cache.setFile(md('S.md', '[[Nick]]'));
    expect(cache.getRefs('S.md')[0]?.resolvedPath).toBe('Bommed.md');
  });
});
