import { describe, expect, test } from 'vitest';
import { parseMarkdown, slugifyHeading } from '../src/core/markdown/parser';
import type { Pos, Span } from '../src/shared/types';

function pos(line: number, col: number, offset: number): Pos {
  return { line, col, offset };
}

function span(start: Pos, end: Pos): Span {
  return { start, end };
}

describe('frontmatter', () => {
  test('parses valid frontmatter and excludes it from body scanning', () => {
    const note = parseMarkdown('---\ntitle: Hello\ntags: [a, b]\n---\n\n#body-tag\n');
    expect(note.frontmatter).toEqual({ title: 'Hello', tags: ['a', 'b'] });
    expect(note.frontmatterSpan).toEqual(span(pos(0, 0, 0), pos(3, 3, 33)));
    expect(note.tags.map((t) => t.tag)).toEqual(['body-tag']);
  });

  test('invalid YAML yields null frontmatter but the block is still excluded', () => {
    const note = parseMarkdown('---\n#inside\ntitle: [unclosed\n---\n#after\n');
    expect(note.frontmatter).toBeNull();
    expect(note.frontmatterSpan).not.toBeNull();
    expect(note.tags.map((t) => t.tag)).toEqual(['after']);
  });

  test('non-plain-object YAML yields null frontmatter but the block is still excluded', () => {
    const note = parseMarkdown('---\n- one\n- two\n---\n#after\n');
    expect(note.frontmatter).toBeNull();
    expect(note.frontmatterSpan).not.toBeNull();
    expect(note.tags.map((t) => t.tag)).toEqual(['after']);
  });

  test('missing closing delimiter means no frontmatter and the text is scanned as body', () => {
    const note = parseMarkdown('---\ntitle: x\n\n#tag here\n');
    expect(note.frontmatter).toBeNull();
    expect(note.frontmatterSpan).toBeNull();
    expect(note.tags.map((t) => t.tag)).toEqual(['tag']);
  });

  test("'...' also closes the frontmatter block", () => {
    const note = parseMarkdown('---\na: 1\n...\n#t\n');
    expect(note.frontmatter).toEqual({ a: 1 });
    expect(note.tags.map((t) => t.tag)).toEqual(['t']);
  });

  test('frontmatter is only recognized when line 0 is exactly ---', () => {
    const note = parseMarkdown('\n---\na: 1\n---\n');
    expect(note.frontmatter).toBeNull();
    expect(note.frontmatterSpan).toBeNull();
  });

  test('a longer dash run on line 0 is not a frontmatter opener', () => {
    const note = parseMarkdown('----\na: 1\n---\n#tag\n');
    expect(note.frontmatter).toBeNull();
    expect(note.frontmatterSpan).toBeNull();
    expect(note.tags.map((t) => t.tag)).toEqual(['tag']);
  });

  test('tag values pass through unparsed (merging happens in the metadata cache)', () => {
    const commaSeparated = parseMarkdown('---\ntags: one, two\n---\n');
    expect(commaSeparated.frontmatter?.['tags']).toBe('one, two');

    const asArray = parseMarkdown('---\ntags:\n  - one\n  - two\n---\n');
    expect(asArray.frontmatter?.['tags']).toEqual(['one', 'two']);

    const asString = parseMarkdown('---\ntags: solo\n---\n');
    expect(asString.frontmatter?.['tags']).toBe('solo');
  });

  test('CRLF frontmatter: offsets count the CR, extracted values do not include it', () => {
    const note = parseMarkdown('---\r\ntitle: x\r\n---\r\n#tag\r\n');
    expect(note.frontmatter).toEqual({ title: 'x' });
    expect(note.frontmatterSpan).toEqual(span(pos(0, 0, 0), pos(2, 3, 18)));
    expect(note.tags).toEqual([{ tag: 'tag', span: span(pos(3, 0, 20), pos(3, 4, 24)) }]);
  });
});

describe('wikilinks', () => {
  test('plain wikilink', () => {
    const note = parseMarkdown('[[Note]]');
    expect(note.links).toHaveLength(1);
    const link = note.links[0];
    expect(link?.raw).toBe('[[Note]]');
    expect(link?.target).toBe('Note');
    expect(link?.subpath).toBeUndefined();
    expect(link?.alias).toBeUndefined();
    expect(link?.embed).toBe(false);
  });

  test('alias', () => {
    const link = parseMarkdown('[[Note|My Note]]').links[0];
    expect(link?.target).toBe('Note');
    expect(link?.alias).toBe('My Note');
  });

  test('heading subpath keeps its leading #', () => {
    const link = parseMarkdown('[[Note#Section]]').links[0];
    expect(link?.target).toBe('Note');
    expect(link?.subpath).toBe('#Section');
  });

  test('block-ref subpath', () => {
    const link = parseMarkdown('[[Note#^abc-1]]').links[0];
    expect(link?.target).toBe('Note');
    expect(link?.subpath).toBe('#^abc-1');
  });

  test('target, subpath, and alias together', () => {
    const link = parseMarkdown('[[Note#Sec|Nice]]').links[0];
    expect(link?.target).toBe('Note');
    expect(link?.subpath).toBe('#Sec');
    expect(link?.alias).toBe('Nice');
  });

  test('embed', () => {
    const link = parseMarkdown('![[image.png]]').links[0];
    expect(link?.embed).toBe(true);
    expect(link?.raw).toBe('![[image.png]]');
    expect(link?.target).toBe('image.png');
    expect(link?.span.start).toEqual(pos(0, 0, 0));
  });

  test('empty target with subpath is a valid self reference', () => {
    const link = parseMarkdown('See [[#Heading]]').links[0];
    expect(link?.target).toBe('');
    expect(link?.subpath).toBe('#Heading');
  });

  test('target and alias are trimmed', () => {
    const link = parseMarkdown('[[  Spaced Note  |  alias  ]]').links[0];
    expect(link?.target).toBe('Spaced Note');
    expect(link?.alias).toBe('alias');
  });

  test('unclosed wikilink is not a link and scanning continues after [[', () => {
    const note = parseMarkdown('start [[never closed\nand #tag stays');
    expect(note.links).toEqual([]);
    expect(note.tags.map((t) => t.tag)).toEqual(['tag']);
  });

  test('wikilinks are line-confined: a stray [[ never swallows later lines', () => {
    const note = parseMarkdown('a [[first\nsecond]] b');
    expect(note.links).toEqual([]);
  });

  test('a stray [[ leaves real links on later lines intact', () => {
    const note = parseMarkdown('I use [[ to open links.\nAlso check [[Real Note]].');
    expect(note.links).toHaveLength(1);
    expect(note.links[0]?.target).toBe('Real Note');
  });

  test('completely empty [[]] is not a link', () => {
    expect(parseMarkdown('[[]]').links).toEqual([]);
  });

  test('the first ]] closes the link', () => {
    const note = parseMarkdown('[[a|b]]c]]');
    expect(note.links).toHaveLength(1);
    expect(note.links[0]?.target).toBe('a');
    expect(note.links[0]?.alias).toBe('b');
  });

  test('a # inside a wikilink is a subpath, not a tag', () => {
    const note = parseMarkdown('[[Note#tag]]');
    expect(note.tags).toEqual([]);
    expect(note.links[0]?.subpath).toBe('#tag');
  });
});

describe('markdown links', () => {
  test('relative link with alias', () => {
    const note = parseMarkdown('Read [the roadmap](projects/Roadmap.md) now');
    expect(note.links).toHaveLength(1);
    const link = note.links[0];
    expect(link?.target).toBe('projects/Roadmap.md');
    expect(link?.alias).toBe('the roadmap');
    expect(link?.embed).toBe(false);
    expect(link?.subpath).toBeUndefined();
    expect(link?.raw).toBe('[the roadmap](projects/Roadmap.md)');
  });

  test('percent-encoded target is decoded', () => {
    const link = parseMarkdown('[n](My%20Notes/Some%20Note.md)').links[0];
    expect(link?.target).toBe('My Notes/Some Note.md');
  });

  test('external targets with a URI scheme are skipped', () => {
    expect(parseMarkdown('[g](https://example.com/a)').links).toEqual([]);
    expect(parseMarkdown('[g](HTTPS://example.com/a)').links).toEqual([]);
    expect(parseMarkdown('[m](mailto:x@y.z)').links).toEqual([]);
    expect(parseMarkdown('[c](C:/x.md)').links).toEqual([]);
  });

  test('protocol-relative targets are skipped', () => {
    expect(parseMarkdown('[c](//cdn.example.com/lib.js)').links).toEqual([]);
  });

  test('image embed', () => {
    const link = parseMarkdown('![diagram](attachments/graph.png)').links[0];
    expect(link?.embed).toBe(true);
    expect(link?.alias).toBe('diagram');
    expect(link?.target).toBe('attachments/graph.png');
    expect(link?.raw).toBe('![diagram](attachments/graph.png)');
  });

  test('angle brackets around the target are stripped', () => {
    expect(parseMarkdown('[n](<My Note.md>)').links[0]?.target).toBe('My Note.md');
    expect(parseMarkdown('[n](<My Note.md> "T")').links[0]?.target).toBe('My Note.md');
  });

  test('a title after whitespace is stripped', () => {
    expect(parseMarkdown('[n](note.md "A Title")').links[0]?.target).toBe('note.md');
    expect(parseMarkdown("[n](note.md 'T')").links[0]?.target).toBe('note.md');
  });

  test('trailing #fragment becomes the subpath', () => {
    const link = parseMarkdown('[n](note.md#sec)').links[0];
    expect(link?.target).toBe('note.md');
    expect(link?.subpath).toBe('#sec');
  });

  test('a target starting with # means empty target plus subpath', () => {
    const link = parseMarkdown('[n](#heading)').links[0];
    expect(link?.target).toBe('');
    expect(link?.subpath).toBe('#heading');
  });

  test('alias may contain one level of nested brackets', () => {
    const link = parseMarkdown('[see [also] here](note.md)').links[0];
    expect(link?.alias).toBe('see [also] here');
    expect(link?.target).toBe('note.md');
  });

  test('malformed percent-escapes keep the raw target', () => {
    expect(parseMarkdown('[n](100%.md)').links[0]?.target).toBe('100%.md');
  });

  test('unclosed paren is not a link and scanning continues', () => {
    const note = parseMarkdown('[a](no close #tag');
    expect(note.links).toEqual([]);
    expect(note.tags.map((t) => t.tag)).toEqual(['tag']);
  });
});

describe('tags', () => {
  test('tag at start of line', () => {
    expect(parseMarkdown('#project rest').tags.map((t) => t.tag)).toEqual(['project']);
  });

  test('tags after every allowed punctuation boundary', () => {
    const note = parseMarkdown('(#a [#b {#c ,#d ;#e :#f !#g ?#h \'#i "#j \u2014#k');
    expect(note.tags.map((t) => t.tag)).toEqual([
      'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k',
    ]);
  });

  test('mid-word # is not a tag', () => {
    expect(parseMarkdown('abc#nope').tags).toEqual([]);
  });

  test('nested tag', () => {
    expect(parseMarkdown('#project/active').tags.map((t) => t.tag)).toEqual(['project/active']);
  });

  test('pure numeric tags are rejected', () => {
    expect(parseMarkdown('#123 #4/5').tags).toEqual([]);
  });

  test('a single non-digit non-slash character makes a tag valid', () => {
    expect(parseMarkdown('#2024-notes #_private').tags.map((t) => t.tag)).toEqual([
      '2024-notes',
      '_private',
    ]);
  });

  test('trailing slashes are stripped', () => {
    expect(parseMarkdown('#topic/ and #deep/nest//').tags.map((t) => t.tag)).toEqual([
      'topic',
      'deep/nest',
    ]);
  });

  test('tag-like text inside inline code is ignored', () => {
    expect(parseMarkdown('use `#nope` ok #yes').tags.map((t) => t.tag)).toEqual(['yes']);
  });

  test('tag-like text inside fences is ignored', () => {
    const note = parseMarkdown('#before\n```\n#inside [[nolink]]\n# No Heading\n```\n#after');
    expect(note.tags.map((t) => t.tag)).toEqual(['before', 'after']);
    expect(note.links).toEqual([]);
    expect(note.headings).toEqual([]);
  });

  test('tag-like text inside %% comments is ignored', () => {
    expect(parseMarkdown('%% #no %% #yes').tags.map((t) => t.tag)).toEqual(['yes']);
  });

  test('multi-line %% comments hide everything inside', () => {
    const note = parseMarkdown('a %% x\n#no [[no]]\nmore %% then #ok');
    expect(note.tags.map((t) => t.tag)).toEqual(['ok']);
    expect(note.links).toEqual([]);
  });

  test('an unclosed %% comment runs to end of file', () => {
    const note = parseMarkdown('text %% #never [[never]]');
    expect(note.tags).toEqual([]);
    expect(note.links).toEqual([]);
  });

  test('a heading marker is not a tag', () => {
    const note = parseMarkdown('# Heading');
    expect(note.tags).toEqual([]);
    expect(note.headings.map((h) => h.text)).toEqual(['Heading']);
  });

  test('tag at end of file without trailing newline', () => {
    expect(parseMarkdown('end #final').tags.map((t) => t.tag)).toEqual(['final']);
  });
});

describe('headings', () => {
  test('levels 1 through 6; 7 hashes is not a heading', () => {
    const note = parseMarkdown(
      '# One\n## Two\n### Three\n#### Four\n##### Five\n###### Six\n####### Seven',
    );
    expect(note.headings.map((h) => h.level)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(note.headings.map((h) => h.text)).toEqual([
      'One', 'Two', 'Three', 'Four', 'Five', 'Six',
    ]);
  });

  test('trailing closing-hash run is stripped', () => {
    expect(parseMarkdown('## Two ##').headings[0]?.text).toBe('Two');
    expect(parseMarkdown('### Spaced ###   ').headings[0]?.text).toBe('Spaced');
  });

  test('a hash without a following space is not a heading', () => {
    const note = parseMarkdown('#NoSpace');
    expect(note.headings).toEqual([]);
    expect(note.tags.map((t) => t.tag)).toEqual(['NoSpace']);
  });

  test('up to 3 leading spaces allowed, 4 is not a heading', () => {
    expect(parseMarkdown('   # Indented').headings[0]?.text).toBe('Indented');
    expect(parseMarkdown('    # NotHeading').headings).toEqual([]);
  });

  test('tab after the marker also opens a heading', () => {
    expect(parseMarkdown('#\tTabbed').headings[0]?.text).toBe('Tabbed');
  });

  test('inline markup stays in the heading text and is still indexed', () => {
    const note = parseMarkdown('## A [[Link]] and #tag');
    expect(note.headings[0]?.text).toBe('A [[Link]] and #tag');
    expect(note.links[0]?.target).toBe('Link');
    expect(note.tags.map((t) => t.tag)).toEqual(['tag']);
  });
});

describe('block ids', () => {
  test('line-final block id', () => {
    const note = parseMarkdown('Some quote ^quote-1');
    expect(note.blocks.map((b) => b.id)).toEqual(['quote-1']);
  });

  test('standalone ^id line', () => {
    expect(parseMarkdown('para\n\n^standalone').blocks.map((b) => b.id)).toEqual(['standalone']);
  });

  test('a mid-line ^id is not a block id', () => {
    expect(parseMarkdown('middle ^id more').blocks).toEqual([]);
  });

  test('invalid id characters reject the block id', () => {
    expect(parseMarkdown('text ^bad_id').blocks).toEqual([]);
  });

  test('block ids inside fences are ignored', () => {
    expect(parseMarkdown('```\ncode ^no\n```\nreal ^yes').blocks.map((b) => b.id)).toEqual([
      'yes',
    ]);
  });

  test('block ids inside %% comments are ignored', () => {
    expect(parseMarkdown('%%\nx ^no\n%%').blocks).toEqual([]);
  });

  test('requires whitespace before the caret', () => {
    expect(parseMarkdown('text^no').blocks).toEqual([]);
  });

  test('tab counts as the preceding whitespace', () => {
    expect(parseMarkdown('tabbed\t^ok').blocks.map((b) => b.id)).toEqual(['ok']);
  });

  test('block id span excludes the CR of a CRLF line ending', () => {
    const note = parseMarkdown('line one ^id1\r\nnext');
    expect(note.blocks).toEqual([{ id: 'id1', span: span(pos(0, 9, 9), pos(0, 13, 13)) }]);
  });

  test('span covers the caret through the id', () => {
    expect(parseMarkdown('quote ^q1').blocks[0]?.span).toEqual(span(pos(0, 6, 6), pos(0, 9, 9)));
  });
});

describe('spans and encodings', () => {
  test('wikilink span', () => {
    const note = parseMarkdown('abc [[Note]] def');
    expect(note.links[0]?.span).toEqual(span(pos(0, 4, 4), pos(0, 12, 12)));
  });

  test('heading span covers the whole line content', () => {
    const note = parseMarkdown('para\n\n## Section Two ##\n');
    expect(note.headings[0]?.text).toBe('Section Two');
    expect(note.headings[0]?.span).toEqual(span(pos(2, 0, 6), pos(2, 17, 23)));
  });

  test('tag span', () => {
    const note = parseMarkdown('hello #world today');
    expect(note.tags[0]?.span).toEqual(span(pos(0, 6, 6), pos(0, 12, 12)));
  });

  test('CRLF: offsets count the CR but extracted text never contains it', () => {
    const note = parseMarkdown('# Head\r\n#tag [[Note]]\r\n');
    expect(note.headings[0]?.text).toBe('Head');
    expect(note.headings[0]?.span).toEqual(span(pos(0, 0, 0), pos(0, 6, 6)));
    expect(note.tags[0]?.tag).toBe('tag');
    expect(note.tags[0]?.span).toEqual(span(pos(1, 0, 8), pos(1, 4, 12)));
    expect(note.links[0]?.raw).toBe('[[Note]]');
    expect(note.links[0]?.target).toBe('Note');
    expect(note.links[0]?.span).toEqual(span(pos(1, 5, 13), pos(1, 13, 21)));
  });

  test('astral characters count as two UTF-16 units', () => {
    const note = parseMarkdown('\u{1F600} [[Note]]');
    expect(note.links[0]?.span).toEqual(span(pos(0, 3, 3), pos(0, 11, 11)));
  });

  test('link at end of file without trailing newline', () => {
    const note = parseMarkdown('[[End]]');
    expect(note.links[0]?.target).toBe('End');
    expect(note.links[0]?.span.end).toEqual(pos(0, 7, 7));
  });

  test('empty source parses to an empty note', () => {
    expect(parseMarkdown('')).toEqual({
      frontmatter: null,
      frontmatterSpan: null,
      links: [],
      tags: [],
      headings: [],
      blocks: [],
      textSpans: [],
    });
  });

  test('links are reported in document order', () => {
    const note = parseMarkdown('a [[One]] b [[Two]] [md](three.md)');
    expect(note.links.map((l) => l.target)).toEqual(['One', 'Two', 'three.md']);
  });
});

describe('inline code and fences', () => {
  test('double-backtick spans may contain single backticks', () => {
    const note = parseMarkdown('``x [[no]] `y` z`` [[yes]]');
    expect(note.links.map((l) => l.target)).toEqual(['yes']);
  });

  test('an unclosed backtick run is literal and its content is scanned', () => {
    const note = parseMarkdown('` unclosed [[link]] #tag');
    expect(note.links.map((l) => l.target)).toEqual(['link']);
    expect(note.tags.map((t) => t.tag)).toEqual(['tag']);
  });

  test('tilde fences work like backtick fences', () => {
    expect(parseMarkdown('~~~\n#no\n~~~\n#yes').tags.map((t) => t.tag)).toEqual(['yes']);
  });

  test('the closing fence must be at least as long as the opener', () => {
    const note = parseMarkdown('````\n#no\n```\n#still\n`````\n#yes');
    expect(note.tags.map((t) => t.tag)).toEqual(['yes']);
  });

  test('an unclosed fence excludes the rest of the file', () => {
    const note = parseMarkdown('```\n#no [[no]]\n# not a heading');
    expect(note.tags).toEqual([]);
    expect(note.links).toEqual([]);
    expect(note.headings).toEqual([]);
  });

  test('fence info strings are allowed', () => {
    const note = parseMarkdown('```typescript\nconst s = "[[no]]"; // #no\n```\n[[yes]]');
    expect(note.links.map((l) => l.target)).toEqual(['yes']);
    expect(note.tags).toEqual([]);
  });

  test('fences may be indented up to 3 spaces', () => {
    expect(parseMarkdown('   ```\n#no\n   ```\n#yes').tags.map((t) => t.tag)).toEqual(['yes']);
  });

  test('closing fences may have trailing spaces', () => {
    expect(parseMarkdown('```\n#no\n```   \n#yes').tags.map((t) => t.tag)).toEqual(['yes']);
  });
});

describe('slugifyHeading', () => {
  test('lowercases and hyphenates', () => {
    expect(slugifyHeading('Hello World')).toBe('hello-world');
  });

  test('strips punctuation', () => {
    expect(slugifyHeading('Graph View: Spec!')).toBe('graph-view-spec');
  });

  test('collapses whitespace runs and trims', () => {
    expect(slugifyHeading('  Multiple   spaces  ')).toBe('multiple-spaces');
  });

  test('keeps existing hyphens', () => {
    expect(slugifyHeading('Already-Hyphenated Words')).toBe('already-hyphenated-words');
  });

  test('each whitespace run becomes its own hyphen', () => {
    expect(slugifyHeading('a - b')).toBe('a---b');
  });

  test('trims leading and trailing hyphens', () => {
    expect(slugifyHeading('--Trim--')).toBe('trim');
  });

  test('keeps unicode letters', () => {
    expect(slugifyHeading('\u00C9migr\u00E9 Caf\u00E9')).toBe('\u00E9migr\u00E9-caf\u00E9');
  });

  test('keeps digits', () => {
    expect(slugifyHeading('100% Done')).toBe('100-done');
  });

  test('removes emoji', () => {
    expect(slugifyHeading('\u{1F389} Party')).toBe('party');
  });

  test('empty and punctuation-only input', () => {
    expect(slugifyHeading('')).toBe('');
    expect(slugifyHeading('!!!')).toBe('');
  });
});

describe('byte order mark', () => {
  test('a leading UTF-8 BOM does not defeat frontmatter detection', () => {
    const note = parseMarkdown('﻿---\ntags: [alpha]\n---\n# Title\n');
    expect(note.frontmatter).toEqual({ tags: ['alpha'] });
    expect(note.headings).toHaveLength(1);
    expect(note.headings[0]?.text).toBe('Title');
  });

  test('a BOM on a file without frontmatter is harmless', () => {
    const note = parseMarkdown('﻿# Title\n[[Link]]\n');
    expect(note.frontmatter).toBeNull();
    expect(note.headings[0]?.text).toBe('Title');
    expect(note.links[0]?.target).toBe('Link');
  });
});

describe('pathological input performance', () => {
  test('unclosed [[ runs parse in near-linear time', () => {
    const singleLine = '[[ a'.repeat(512 * 1024);
    const multiLine = '[[ a\n'.repeat(400 * 1024);
    const started = performance.now();
    const first = parseMarkdown(singleLine);
    const second = parseMarkdown(multiLine);
    const elapsedMs = performance.now() - started;
    expect(first.links).toEqual([]);
    expect(second.links).toEqual([]);
    // Pre-fix these ~2MB inputs took 28s and 10s respectively; near-linear
    // scanning finishes both in well under a second even on slow CI.
    expect(elapsedMs).toBeLessThan(5000);
  });

  test('one closing ]] far down a [[-packed line still forms a single link', () => {
    const note = parseMarkdown('[[' + 'x[['.repeat(1000) + 'end]]');
    expect(note.links).toHaveLength(1);
  });
});
