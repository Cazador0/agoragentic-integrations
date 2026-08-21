import { load } from 'js-yaml';
import type {
  LinkRef,
  ParsedNote,
  Pos,
  Span,
} from '../../shared/types';

const CHAR_TAB = 9;
const CHAR_NEWLINE = 10;
const CHAR_CARRIAGE_RETURN = 13;
const CHAR_SPACE = 32;
const CHAR_BANG = 33;
const CHAR_DOUBLE_QUOTE = 34;
const CHAR_HASH = 35;
const CHAR_PERCENT = 37;
const CHAR_SINGLE_QUOTE = 39;
const CHAR_OPEN_PAREN = 40;
const CHAR_CLOSE_PAREN = 41;
const CHAR_COMMA = 44;
const CHAR_HYPHEN = 45;
const CHAR_SLASH = 47;
const CHAR_COLON = 58;
const CHAR_SEMICOLON = 59;
const CHAR_QUESTION = 63;
const CHAR_OPEN_BRACKET = 91;
const CHAR_CLOSE_BRACKET = 93;
const CHAR_CARET = 94;
const CHAR_UNDERSCORE = 95;
const CHAR_BACKTICK = 96;
const CHAR_OPEN_BRACE = 123;
const CHAR_TILDE = 126;
const CHAR_EM_DASH = 0x2014;

const URI_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;
const TRAILING_CLOSING_HASHES_PATTERN = /[ \t]+#+[ \t]*$/;

function isDigitCode(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isAsciiLetterCode(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isTagCharCode(code: number): boolean {
  return (
    isAsciiLetterCode(code) ||
    isDigitCode(code) ||
    code === CHAR_UNDERSCORE ||
    code === CHAR_SLASH ||
    code === CHAR_HYPHEN
  );
}

function isBlockIdCharCode(code: number): boolean {
  return isAsciiLetterCode(code) || isDigitCode(code) || code === CHAR_HYPHEN;
}

function isTagBoundaryCode(code: number): boolean {
  switch (code) {
    case CHAR_SPACE:
    case CHAR_TAB:
    case CHAR_NEWLINE:
    case CHAR_CARRIAGE_RETURN:
    case CHAR_OPEN_PAREN:
    case CHAR_OPEN_BRACKET:
    case CHAR_OPEN_BRACE:
    case CHAR_COMMA:
    case CHAR_SEMICOLON:
    case CHAR_COLON:
    case CHAR_BANG:
    case CHAR_QUESTION:
    case CHAR_SINGLE_QUOTE:
    case CHAR_DOUBLE_QUOTE:
    case CHAR_EM_DASH:
      return true;
    default:
      return false;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]';
}

// Multi-line constructs can capture CRLF breaks; a CR must never leak into
// extracted text even though offsets/cols count it in the raw source.
function stripCarriageReturns(text: string): string {
  return text.includes('\r') ? text.replace(/\r/g, '') : text;
}

export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]+/gu, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

export function parseMarkdown(source: string): ParsedNote {
  const length = source.length;

  const lineStarts: number[] = [0];
  for (let scan = 0; scan < length; scan++) {
    if (source.charCodeAt(scan) === CHAR_NEWLINE) {
      lineStarts.push(scan + 1);
    }
  }

  function positionAt(offset: number): Pos {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      const middleStart = lineStarts[middle];
      if (middleStart !== undefined && middleStart <= offset) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    const lineStart = lineStarts[low] ?? 0;
    return { line: low, col: offset - lineStart, offset };
  }

  function spanOf(startOffset: number, endOffset: number): Span {
    return { start: positionAt(startOffset), end: positionAt(endOffset) };
  }

  function lineInfoAt(offset: number): { contentEnd: number; nextLineStart: number } {
    const newlineIndex = source.indexOf('\n', offset);
    const lineEnd = newlineIndex === -1 ? length : newlineIndex;
    const contentEnd =
      lineEnd > offset && source.charCodeAt(lineEnd - 1) === CHAR_CARRIAGE_RETURN
        ? lineEnd - 1
        : lineEnd;
    return { contentEnd, nextLineStart: newlineIndex === -1 ? length : newlineIndex + 1 };
  }

  const note: ParsedNote = {
    frontmatter: null,
    frontmatterSpan: null,
    links: [],
    tags: [],
    headings: [],
    blocks: [],
  };

  // A leading UTF-8 BOM (common in Windows-authored notes) must not defeat
  // frontmatter detection; spans stay relative to the raw source.
  const contentStart = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  let bodyStart = contentStart;
  const firstLine = lineInfoAt(0);
  if (firstLine.contentEnd - contentStart === 3 && source.startsWith('---', contentStart)) {
    for (let lineIndex = 1; lineIndex < lineStarts.length; lineIndex++) {
      const closingStart = lineStarts[lineIndex];
      if (closingStart === undefined) {
        break;
      }
      const closingLine = lineInfoAt(closingStart);
      const closingContent = source.slice(closingStart, closingLine.contentEnd);
      if (closingContent !== '---' && closingContent !== '...') {
        continue;
      }
      const yamlStart = lineStarts[1];
      const yamlText =
        yamlStart === undefined ? '' : stripCarriageReturns(source.slice(yamlStart, closingStart));
      try {
        const parsed = load(yamlText);
        if (isPlainObject(parsed)) {
          note.frontmatter = parsed;
        }
      } catch {
        // Contract: malformed YAML yields frontmatter=null while the block is
        // still excluded from body scanning, so the error is fully handled here.
      }
      note.frontmatterSpan = spanOf(0, closingLine.contentEnd);
      bodyStart = closingLine.nextLineStart;
      break;
    }
  }

  function matchFenceOpening(
    lineStart: number,
    contentEnd: number,
  ): { character: number; length: number } | null {
    let cursor = lineStart;
    let leadingSpaces = 0;
    while (cursor < contentEnd && source.charCodeAt(cursor) === CHAR_SPACE && leadingSpaces < 3) {
      cursor++;
      leadingSpaces++;
    }
    const character = source.charCodeAt(cursor);
    if (character !== CHAR_BACKTICK && character !== CHAR_TILDE) {
      return null;
    }
    let runEnd = cursor;
    while (runEnd < contentEnd && source.charCodeAt(runEnd) === character) {
      runEnd++;
    }
    if (runEnd - cursor < 3) {
      return null;
    }
    return { character, length: runEnd - cursor };
  }

  function skipFencedBlock(searchStart: number, fenceCharacter: number, openLength: number): number {
    let lineStart = searchStart;
    while (lineStart < length) {
      const { contentEnd, nextLineStart } = lineInfoAt(lineStart);
      let cursor = lineStart;
      let leadingSpaces = 0;
      while (cursor < contentEnd && source.charCodeAt(cursor) === CHAR_SPACE && leadingSpaces < 3) {
        cursor++;
        leadingSpaces++;
      }
      let runEnd = cursor;
      while (runEnd < contentEnd && source.charCodeAt(runEnd) === fenceCharacter) {
        runEnd++;
      }
      if (runEnd - cursor >= openLength) {
        let rest = runEnd;
        while (
          rest < contentEnd &&
          (source.charCodeAt(rest) === CHAR_SPACE || source.charCodeAt(rest) === CHAR_TAB)
        ) {
          rest++;
        }
        if (rest === contentEnd) {
          return nextLineStart;
        }
      }
      lineStart = nextLineStart;
    }
    return length;
  }

  function recordHeading(lineStart: number, contentEnd: number): void {
    let cursor = lineStart;
    let leadingSpaces = 0;
    while (cursor < contentEnd && source.charCodeAt(cursor) === CHAR_SPACE && leadingSpaces < 3) {
      cursor++;
      leadingSpaces++;
    }
    let markerEnd = cursor;
    while (markerEnd < contentEnd && source.charCodeAt(markerEnd) === CHAR_HASH) {
      markerEnd++;
    }
    const level = markerEnd - cursor;
    if (level < 1 || level > 6 || markerEnd >= contentEnd) {
      return;
    }
    const afterMarker = source.charCodeAt(markerEnd);
    if (afterMarker !== CHAR_SPACE && afterMarker !== CHAR_TAB) {
      return;
    }
    const text = source
      .slice(markerEnd, contentEnd)
      .replace(TRAILING_CLOSING_HASHES_PATTERN, '')
      .trim();
    note.headings.push({ level, text, span: spanOf(lineStart, contentEnd) });
  }

  function skipInlineCode(start: number): number {
    let runEnd = start;
    while (runEnd < length && source.charCodeAt(runEnd) === CHAR_BACKTICK) {
      runEnd++;
    }
    const runLength = runEnd - start;
    // Code spans are confined to a single line (unlike CommonMark's
    // paragraph-wide spans) so one stray backtick cannot swallow the file.
    const { contentEnd } = lineInfoAt(start);
    let cursor = runEnd;
    while (cursor < contentEnd) {
      if (source.charCodeAt(cursor) === CHAR_BACKTICK) {
        let closingEnd = cursor;
        while (closingEnd < contentEnd && source.charCodeAt(closingEnd) === CHAR_BACKTICK) {
          closingEnd++;
        }
        if (closingEnd - cursor === runLength) {
          return closingEnd;
        }
        cursor = closingEnd;
      } else {
        cursor++;
      }
    }
    return runEnd;
  }

  function scanWikilink(start: number, embed: boolean, rawStart: number): number {
    // Line-confined like Obsidian, so a stray '[[' in prose cannot swallow
    // real links on later lines.
    const { contentEnd } = lineInfoAt(start);
    const closing = source.indexOf(']]', start + 2);
    if (closing === -1 || closing + 2 > contentEnd) {
      return start + 2;
    }
    const inner = source.slice(start + 2, closing);
    const hashIndex = inner.indexOf('#');
    const pipeIndex = inner.indexOf('|');
    const targetEnd = Math.min(
      hashIndex === -1 ? inner.length : hashIndex,
      pipeIndex === -1 ? inner.length : pipeIndex,
    );
    const target = stripCarriageReturns(inner.slice(0, targetEnd)).trim();
    let subpath: string | undefined;
    if (hashIndex !== -1 && (pipeIndex === -1 || hashIndex < pipeIndex)) {
      const subpathEnd = pipeIndex === -1 ? inner.length : pipeIndex;
      subpath = stripCarriageReturns(inner.slice(hashIndex, subpathEnd)).trim();
    }
    let alias: string | undefined;
    if (pipeIndex !== -1) {
      const aliasText = stripCarriageReturns(inner.slice(pipeIndex + 1)).trim();
      if (aliasText !== '') {
        alias = aliasText;
      }
    }
    if (target === '' && subpath === undefined) {
      return start + 2;
    }
    const end = closing + 2;
    const link: LinkRef = {
      raw: source.slice(rawStart, end),
      target,
      embed,
      span: spanOf(rawStart, end),
    };
    if (subpath !== undefined) {
      link.subpath = subpath;
    }
    if (alias !== undefined) {
      link.alias = alias;
    }
    note.links.push(link);
    return end;
  }

  function scanMarkdownLink(start: number, embed: boolean, rawStart: number): number {
    const { contentEnd } = lineInfoAt(start);
    // Naive label matching: a depth counter confined to one line, with no
    // escape or code-span awareness — enough for the one-level nesting the
    // contract requires.
    let labelEnd = start + 1;
    let bracketDepth = 1;
    while (labelEnd < contentEnd) {
      const code = source.charCodeAt(labelEnd);
      if (code === CHAR_OPEN_BRACKET) {
        bracketDepth++;
      } else if (code === CHAR_CLOSE_BRACKET) {
        bracketDepth--;
        if (bracketDepth === 0) {
          break;
        }
      }
      labelEnd++;
    }
    if (bracketDepth !== 0 || source.charCodeAt(labelEnd + 1) !== CHAR_OPEN_PAREN) {
      return start + 1;
    }
    let destinationEnd = labelEnd + 2;
    let parenDepth = 1;
    while (destinationEnd < contentEnd) {
      const code = source.charCodeAt(destinationEnd);
      if (code === CHAR_OPEN_PAREN) {
        parenDepth++;
      } else if (code === CHAR_CLOSE_PAREN) {
        parenDepth--;
        if (parenDepth === 0) {
          break;
        }
      }
      destinationEnd++;
    }
    if (parenDepth !== 0) {
      return start + 1;
    }
    const end = destinationEnd + 1;
    const rawDestination = source.slice(labelEnd + 2, destinationEnd).trim();
    let destination: string;
    if (rawDestination.startsWith('<')) {
      const angleEnd = rawDestination.indexOf('>');
      destination = angleEnd === -1 ? rawDestination : rawDestination.slice(1, angleEnd);
    } else {
      const titleIndex = rawDestination.search(/\s/);
      destination = titleIndex === -1 ? rawDestination : rawDestination.slice(0, titleIndex);
    }
    if (URI_SCHEME_PATTERN.test(destination) || destination.startsWith('//')) {
      return end;
    }
    const hashIndex = destination.indexOf('#');
    const pathPortion = hashIndex === -1 ? destination : destination.slice(0, hashIndex);
    const fragment = hashIndex === -1 ? undefined : destination.slice(hashIndex);
    let target: string;
    try {
      target = decodeURIComponent(pathPortion);
    } catch {
      // Malformed percent-escapes (e.g. "100%.md") keep the raw path instead
      // of failing the whole parse.
      target = pathPortion;
    }
    if (target === '' && fragment === undefined) {
      return end;
    }
    const label = source.slice(start + 1, labelEnd).trim();
    const link: LinkRef = {
      raw: source.slice(rawStart, end),
      target,
      embed,
      span: spanOf(rawStart, end),
    };
    if (fragment !== undefined) {
      link.subpath = fragment;
    }
    if (label !== '') {
      link.alias = label;
    }
    note.links.push(link);
    return end;
  }

  function scanBracket(start: number): number {
    const embed = start > 0 && source.charCodeAt(start - 1) === CHAR_BANG;
    const rawStart = embed ? start - 1 : start;
    if (source.charCodeAt(start + 1) === CHAR_OPEN_BRACKET) {
      return scanWikilink(start, embed, rawStart);
    }
    return scanMarkdownLink(start, embed, rawStart);
  }

  function scanTag(start: number): number {
    if (start > 0 && !isTagBoundaryCode(source.charCodeAt(start - 1))) {
      return start + 1;
    }
    let runEnd = start + 1;
    while (runEnd < length && isTagCharCode(source.charCodeAt(runEnd))) {
      runEnd++;
    }
    if (runEnd === start + 1) {
      return start + 1;
    }
    let hasSignificantCharacter = false;
    for (let cursor = start + 1; cursor < runEnd; cursor++) {
      const code = source.charCodeAt(cursor);
      if (!isDigitCode(code) && code !== CHAR_SLASH) {
        hasSignificantCharacter = true;
        break;
      }
    }
    if (!hasSignificantCharacter) {
      return runEnd;
    }
    let tagEnd = runEnd;
    while (tagEnd > start + 1 && source.charCodeAt(tagEnd - 1) === CHAR_SLASH) {
      tagEnd--;
    }
    note.tags.push({ tag: source.slice(start + 1, tagEnd), span: spanOf(start, runEnd) });
    return runEnd;
  }

  function scanBlockId(start: number): number {
    const previousCode = start > 0 ? source.charCodeAt(start - 1) : CHAR_NEWLINE;
    const atBoundary =
      previousCode === CHAR_NEWLINE ||
      previousCode === CHAR_CARRIAGE_RETURN ||
      previousCode === CHAR_SPACE ||
      previousCode === CHAR_TAB;
    if (!atBoundary) {
      return start + 1;
    }
    let runEnd = start + 1;
    while (runEnd < length && isBlockIdCharCode(source.charCodeAt(runEnd))) {
      runEnd++;
    }
    if (runEnd === start + 1) {
      return start + 1;
    }
    const nextCode = runEnd < length ? source.charCodeAt(runEnd) : CHAR_NEWLINE;
    if (nextCode !== CHAR_NEWLINE && nextCode !== CHAR_CARRIAGE_RETURN) {
      return start + 1;
    }
    note.blocks.push({ id: source.slice(start + 1, runEnd), span: spanOf(start, runEnd) });
    return runEnd;
  }

  let index = bodyStart;
  let atLineStart = true;
  while (index < length) {
    if (atLineStart) {
      atLineStart = false;
      const { contentEnd, nextLineStart } = lineInfoAt(index);
      const fence = matchFenceOpening(index, contentEnd);
      if (fence !== null) {
        index = skipFencedBlock(nextLineStart, fence.character, fence.length);
        atLineStart = true;
        continue;
      }
      recordHeading(index, contentEnd);
    }
    const code = source.charCodeAt(index);
    if (code === CHAR_NEWLINE) {
      index++;
      atLineStart = true;
      continue;
    }
    if (code === CHAR_BACKTICK) {
      index = skipInlineCode(index);
      continue;
    }
    if (code === CHAR_PERCENT && source.charCodeAt(index + 1) === CHAR_PERCENT) {
      const commentClose = source.indexOf('%%', index + 2);
      index = commentClose === -1 ? length : commentClose + 2;
      continue;
    }
    if (code === CHAR_OPEN_BRACKET) {
      index = scanBracket(index);
      continue;
    }
    if (code === CHAR_HASH) {
      index = scanTag(index);
      continue;
    }
    if (code === CHAR_CARET) {
      index = scanBlockId(index);
      continue;
    }
    index++;
  }

  return note;
}
