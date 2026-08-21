import { parseMarkdown } from './markdown/parser';
import type { FileMetadata } from '../shared/types';

/** One link occurrence in a source file; `text` is the raw target as typed. */
export interface LinkOccurrence {
  text: string;
  subpath: string | undefined;
  embed: boolean;
  resolvedPath: string | null;
}

function lastSegmentOf(path: string): string {
  const slashIndex = path.lastIndexOf('/');
  return slashIndex === -1 ? path : path.slice(slashIndex + 1);
}

function folderOf(path: string): string {
  const slashIndex = path.lastIndexOf('/');
  return slashIndex === -1 ? '' : path.slice(0, slashIndex);
}

function splitName(path: string): { basename: string; extension: string } {
  const segment = lastSegmentOf(path);
  const dotIndex = segment.lastIndexOf('.');
  if (dotIndex <= 0) {
    return { basename: segment, extension: '' };
  }
  return {
    basename: segment.slice(0, dotIndex),
    extension: segment.slice(dotIndex + 1).toLowerCase(),
  };
}

function coerceToStringList(value: unknown): string[] {
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '');
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return [String(value)];
  }
  if (Array.isArray(value)) {
    const result: string[] = [];
    for (const item of value) {
      if (typeof item === 'string') {
        const trimmed = item.trim();
        if (trimmed !== '') {
          result.push(trimmed);
        }
      } else if (typeof item === 'number' && Number.isFinite(item)) {
        result.push(String(item));
      }
    }
    return result;
  }
  return [];
}

function appendUniqueCaseInsensitive(list: string[], seenLower: Set<string>, value: string): void {
  const lower = value.toLowerCase();
  if (seenLower.has(lower)) {
    return;
  }
  seenLower.add(lower);
  list.push(value);
}

export function makeFileMetadata(
  path: string,
  source: string | null,
  stats: { mtimeMs: number; size: number },
): FileMetadata {
  const { basename, extension } = splitName(path);
  const isMarkdown = extension === 'md';
  const parsed = source !== null && isMarkdown ? parseMarkdown(source) : null;

  const tags: string[] = [];
  const aliases: string[] = [];
  if (parsed !== null) {
    const seenTags = new Set<string>();
    for (const tagRef of parsed.tags) {
      appendUniqueCaseInsensitive(tags, seenTags, tagRef.tag);
    }
    if (parsed.frontmatter !== null) {
      for (const key of ['tags', 'tag'] as const) {
        for (const rawTag of coerceToStringList(parsed.frontmatter[key])) {
          const tag = rawTag.startsWith('#') ? rawTag.slice(1) : rawTag;
          if (tag !== '') {
            appendUniqueCaseInsensitive(tags, seenTags, tag);
          }
        }
      }
      const seenAliases = new Set<string>();
      for (const key of ['aliases', 'alias'] as const) {
        for (const alias of coerceToStringList(parsed.frontmatter[key])) {
          appendUniqueCaseInsensitive(aliases, seenAliases, alias);
        }
      }
    }
  }

  return {
    path,
    basename,
    extension,
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    isMarkdown,
    parsed,
    tags,
    aliases,
  };
}

function addToSetMap(map: Map<string, Set<string>>, key: string, value: string): void {
  const existing = map.get(key);
  if (existing === undefined) {
    map.set(key, new Set([value]));
  } else {
    existing.add(value);
  }
}

function removeFromSetMap(map: Map<string, Set<string>>, key: string, value: string): void {
  const existing = map.get(key);
  if (existing === undefined) {
    return;
  }
  existing.delete(value);
  if (existing.size === 0) {
    map.delete(key);
  }
}

function pickBestPath(candidates: Iterable<string>): string | null {
  let best: string | null = null;
  for (const candidate of candidates) {
    if (
      best === null ||
      candidate.length < best.length ||
      (candidate.length === best.length && candidate < best)
    ) {
      best = candidate;
    }
  }
  return best;
}

function joinRelative(baseFolder: string, linkPath: string): string | null {
  const segments = baseFolder === '' ? [] : baseFolder.split('/');
  for (const part of linkPath.split('/')) {
    if (part === '' || part === '.') {
      continue;
    }
    if (part === '..') {
      if (segments.length === 0) {
        // '..' past the vault root cannot name a vault file.
        return null;
      }
      segments.pop();
    } else {
      segments.push(part);
    }
  }
  if (segments.length === 0) {
    return null;
  }
  return segments.join('/');
}

export class MetadataCache {
  readonly resolvedLinks = new Map<string, Map<string, number>>();
  readonly unresolvedLinks = new Map<string, Map<string, number>>();

  private readonly filesByPath = new Map<string, FileMetadata>();
  private readonly refsByPath = new Map<string, LinkOccurrence[]>();
  private readonly pathsByLowerPath = new Map<string, Set<string>>();
  private readonly pathsByLowerBasename = new Map<string, Set<string>>();
  private readonly pathsByLowerName = new Map<string, Set<string>>();
  private readonly pathsByLowerAlias = new Map<string, Set<string>>();
  private readonly unresolvedSourcesByLowerText = new Map<string, Set<string>>();
  // Unresolved slash-containing texts indexed by their source-folder-joined
  // path, so a new file promotes exactly the refs that could name it instead
  // of a blanket retry (which made initial scans quadratic in broken links).
  private readonly unresolvedSourcesByLowerJoinedPath = new Map<string, Set<string>>();
  private readonly inboundSourcesByTarget = new Map<string, Set<string>>();
  private readonly changeListeners = new Set<() => void>();

  get size(): number {
    return this.filesByPath.size;
  }

  getFile(path: string): FileMetadata | undefined {
    return this.filesByPath.get(path);
  }

  files(): FileMetadata[] {
    return [...this.filesByPath.values()];
  }

  getRefs(path: string): ReadonlyArray<LinkOccurrence> {
    return this.refsByPath.get(path) ?? [];
  }

  getBacklinks(path: string): Map<string, number> {
    const backlinks = new Map<string, number>();
    const sources = this.inboundSourcesByTarget.get(path);
    if (sources === undefined) {
      return backlinks;
    }
    for (const source of sources) {
      const count = this.resolvedLinks.get(source)?.get(path);
      if (count !== undefined) {
        backlinks.set(source, count);
      }
    }
    return backlinks;
  }

  onChange(callback: () => void): () => void {
    this.changeListeners.add(callback);
    return () => {
      this.changeListeners.delete(callback);
    };
  }

  setFile(meta: FileMetadata): void {
    const existing = this.filesByPath.get(meta.path);
    let lostAlias = false;
    if (existing !== undefined) {
      const newAliasLowers = new Set(meta.aliases.map((alias) => alias.toLowerCase()));
      lostAlias = existing.aliases.some((alias) => !newAliasLowers.has(alias.toLowerCase()));
      this.removeFileEntry(meta.path);
    }
    this.insertFileEntry(meta);
    if (lostAlias) {
      // Inbound refs may have resolved through a now-removed alias.
      this.reresolveInboundSources(meta.path);
    }
    this.reresolveShadowedCompetitors(meta);
    this.promoteMatchingUnresolved(meta);
    this.notifyChange();
  }

  deleteFile(path: string): void {
    const inbound = this.inboundSourcesByTarget.get(path);
    const affectedSources = inbound === undefined ? [] : [...inbound].filter((s) => s !== path);
    const removed = this.removeFileEntry(path);
    if (removed === undefined) {
      return;
    }
    for (const source of affectedSources) {
      this.reresolveSource(source);
    }
    this.notifyChange();
  }

  renameFile(oldPath: string, newPath: string): void {
    if (oldPath === newPath) {
      return;
    }
    const meta = this.filesByPath.get(oldPath);
    if (meta === undefined) {
      return;
    }
    const affected = new Set(this.inboundSourcesByTarget.get(oldPath) ?? []);
    if (this.filesByPath.has(newPath)) {
      // The overwritten file's inbound links (possibly alias-resolved) must be
      // re-resolved too, or they keep pointing at metadata that no longer exists.
      for (const source of this.inboundSourcesByTarget.get(newPath) ?? []) {
        affected.add(source);
      }
      this.removeFileEntry(newPath);
    }
    affected.delete(oldPath);
    affected.delete(newPath);
    const affectedSources = [...affected];
    this.removeFileEntry(oldPath);

    const { basename, extension } = splitName(newPath);
    const isMarkdown = extension === 'md';
    const movedMeta: FileMetadata = {
      ...meta,
      path: newPath,
      basename,
      extension,
      isMarkdown,
      parsed: isMarkdown ? meta.parsed : null,
      tags: isMarkdown ? meta.tags : [],
      aliases: isMarkdown ? meta.aliases : [],
    };
    this.insertFileEntry(movedMeta);
    for (const source of affectedSources) {
      this.reresolveSource(source);
    }
    this.reresolveShadowedCompetitors(movedMeta);
    this.promoteMatchingUnresolved(movedMeta);
    this.notifyChange();
  }

  resolveLink(linkText: string, sourcePath: string): string | null {
    if (linkText === '') {
      return sourcePath;
    }
    if (linkText.includes('/')) {
      const vaultAbsolute = this.resolvePathForm(linkText);
      if (vaultAbsolute !== null) {
        return vaultAbsolute;
      }
      const relative = joinRelative(folderOf(sourcePath), linkText);
      if (relative !== null && relative !== linkText) {
        return this.resolvePathForm(relative);
      }
      return null;
    }

    const lower = linkText.toLowerCase();
    const basenameCandidates = this.pathsByLowerBasename.get(lower);
    const nameCandidates = this.pathsByLowerName.get(lower);

    const exactMatches = new Set<string>();
    if (basenameCandidates !== undefined) {
      for (const candidate of basenameCandidates) {
        if (this.filesByPath.get(candidate)?.basename === linkText) {
          exactMatches.add(candidate);
        }
      }
    }
    if (nameCandidates !== undefined) {
      for (const candidate of nameCandidates) {
        // FileMetadata lowercases the extension, so the exact name check must
        // use the path's final segment, which keeps the on-disk casing.
        if (lastSegmentOf(candidate) === linkText) {
          exactMatches.add(candidate);
        }
      }
    }
    if (exactMatches.size > 0) {
      return pickBestPath(exactMatches);
    }

    const insensitiveMatches = new Set<string>();
    if (basenameCandidates !== undefined) {
      for (const candidate of basenameCandidates) {
        insensitiveMatches.add(candidate);
      }
    }
    if (nameCandidates !== undefined) {
      for (const candidate of nameCandidates) {
        insensitiveMatches.add(candidate);
      }
    }
    if (insensitiveMatches.size > 0) {
      return pickBestPath(insensitiveMatches);
    }

    const aliasCandidates = this.pathsByLowerAlias.get(lower);
    if (aliasCandidates !== undefined && aliasCandidates.size > 0) {
      return pickBestPath(aliasCandidates);
    }
    return null;
  }

  private resolvePathForm(pathText: string): string | null {
    if (this.filesByPath.has(pathText)) {
      return pathText;
    }
    const withExtension = pathText + '.md';
    if (this.filesByPath.has(withExtension)) {
      return withExtension;
    }
    const lower = pathText.toLowerCase();
    const insensitive = this.pathsByLowerPath.get(lower);
    if (insensitive !== undefined && insensitive.size > 0) {
      return pickBestPath(insensitive);
    }
    const insensitiveWithExtension = this.pathsByLowerPath.get(lower + '.md');
    if (insensitiveWithExtension !== undefined && insensitiveWithExtension.size > 0) {
      return pickBestPath(insensitiveWithExtension);
    }
    return null;
  }

  private insertFileEntry(meta: FileMetadata): void {
    this.filesByPath.set(meta.path, meta);
    addToSetMap(this.pathsByLowerPath, meta.path.toLowerCase(), meta.path);
    addToSetMap(this.pathsByLowerBasename, meta.basename.toLowerCase(), meta.path);
    if (meta.extension !== '') {
      addToSetMap(this.pathsByLowerName, lastSegmentOf(meta.path).toLowerCase(), meta.path);
    }
    for (const alias of meta.aliases) {
      addToSetMap(this.pathsByLowerAlias, alias.toLowerCase(), meta.path);
    }
    if (meta.parsed !== null) {
      const refs: LinkOccurrence[] = meta.parsed.links.map((link) => ({
        text: link.target,
        subpath: link.subpath,
        embed: link.embed,
        resolvedPath: this.resolveLink(link.target, meta.path),
      }));
      this.refsByPath.set(meta.path, refs);
      this.addLinkContributions(meta.path, refs);
    }
  }

  private removeFileEntry(path: string): FileMetadata | undefined {
    const meta = this.filesByPath.get(path);
    if (meta === undefined) {
      return undefined;
    }
    const refs = this.refsByPath.get(path);
    if (refs !== undefined) {
      this.removeLinkContributions(path, refs);
      this.refsByPath.delete(path);
    }
    this.filesByPath.delete(path);
    removeFromSetMap(this.pathsByLowerPath, path.toLowerCase(), path);
    removeFromSetMap(this.pathsByLowerBasename, meta.basename.toLowerCase(), path);
    if (meta.extension !== '') {
      removeFromSetMap(this.pathsByLowerName, lastSegmentOf(path).toLowerCase(), path);
    }
    for (const alias of meta.aliases) {
      removeFromSetMap(this.pathsByLowerAlias, alias.toLowerCase(), path);
    }
    return meta;
  }

  private addLinkContributions(sourcePath: string, refs: LinkOccurrence[]): void {
    let resolvedCounts: Map<string, number> | undefined;
    let unresolvedCounts: Map<string, number> | undefined;
    for (const ref of refs) {
      if (ref.resolvedPath !== null) {
        resolvedCounts ??= new Map();
        resolvedCounts.set(ref.resolvedPath, (resolvedCounts.get(ref.resolvedPath) ?? 0) + 1);
        addToSetMap(this.inboundSourcesByTarget, ref.resolvedPath, sourcePath);
      } else {
        unresolvedCounts ??= new Map();
        unresolvedCounts.set(ref.text, (unresolvedCounts.get(ref.text) ?? 0) + 1);
        addToSetMap(this.unresolvedSourcesByLowerText, ref.text.toLowerCase(), sourcePath);
        if (ref.text.includes('/')) {
          const joined = joinRelative(folderOf(sourcePath), ref.text);
          if (joined !== null) {
            addToSetMap(this.unresolvedSourcesByLowerJoinedPath, joined.toLowerCase(), sourcePath);
          }
        }
      }
    }
    if (resolvedCounts !== undefined) {
      this.resolvedLinks.set(sourcePath, resolvedCounts);
    }
    if (unresolvedCounts !== undefined) {
      this.unresolvedLinks.set(sourcePath, unresolvedCounts);
    }
  }

  private removeLinkContributions(sourcePath: string, refs: LinkOccurrence[]): void {
    this.resolvedLinks.delete(sourcePath);
    this.unresolvedLinks.delete(sourcePath);
    for (const ref of refs) {
      if (ref.resolvedPath !== null) {
        removeFromSetMap(this.inboundSourcesByTarget, ref.resolvedPath, sourcePath);
      } else {
        removeFromSetMap(this.unresolvedSourcesByLowerText, ref.text.toLowerCase(), sourcePath);
        if (ref.text.includes('/')) {
          const joined = joinRelative(folderOf(sourcePath), ref.text);
          if (joined !== null) {
            removeFromSetMap(this.unresolvedSourcesByLowerJoinedPath, joined.toLowerCase(), sourcePath);
          }
        }
      }
    }
  }

  private reresolveSource(sourcePath: string): void {
    const refs = this.refsByPath.get(sourcePath);
    if (refs === undefined) {
      return;
    }
    this.removeLinkContributions(sourcePath, refs);
    for (const ref of refs) {
      ref.resolvedPath = this.resolveLink(ref.text, sourcePath);
    }
    this.addLinkContributions(sourcePath, refs);
  }

  private reresolveInboundSources(targetPath: string): void {
    const inbound = this.inboundSourcesByTarget.get(targetPath);
    if (inbound === undefined) {
      return;
    }
    for (const source of [...inbound]) {
      if (source !== targetPath) {
        this.reresolveSource(source);
      }
    }
  }

  private promoteMatchingUnresolved(meta: FileMetadata): void {
    const lowerPath = meta.path.toLowerCase();
    const directKeys = new Set<string>();
    directKeys.add(meta.basename.toLowerCase());
    directKeys.add(lastSegmentOf(meta.path).toLowerCase());
    for (const alias of meta.aliases) {
      directKeys.add(alias.toLowerCase());
    }
    directKeys.add(lowerPath);
    if (lowerPath.endsWith('.md')) {
      directKeys.add(lowerPath.slice(0, -'.md'.length));
    }

    const affectedSources = new Set<string>();
    for (const key of directKeys) {
      const sources = this.unresolvedSourcesByLowerText.get(key);
      if (sources !== undefined) {
        for (const source of sources) {
          affectedSources.add(source);
        }
      }
    }
    // Folder-qualified texts ('sub/x', './x', '../x') are indexed by their
    // source-folder-joined path, so only refs whose relative form could name
    // this file are retried; vault-absolute forms are covered by directKeys.
    for (const key of [lowerPath, ...(lowerPath.endsWith('.md') ? [lowerPath.slice(0, -'.md'.length)] : [])]) {
      const sources = this.unresolvedSourcesByLowerJoinedPath.get(key);
      if (sources !== undefined) {
        for (const source of sources) {
          affectedSources.add(source);
        }
      }
    }
    for (const source of affectedSources) {
      this.reresolveSource(source);
    }
  }

  /** A newly indexed or renamed file may out-rank the current target of links
   * that resolve through a basename, name, alias, or case-insensitive path it
   * now shares; re-resolve the inbound links of those competitor files so
   * resolution stays a function of vault content, not mutation order. */
  private reresolveShadowedCompetitors(meta: FileMetadata): void {
    const lowerPath = meta.path.toLowerCase();
    const keys = new Set<string>();
    keys.add(meta.basename.toLowerCase());
    keys.add(lastSegmentOf(meta.path).toLowerCase());
    for (const alias of meta.aliases) {
      keys.add(alias.toLowerCase());
    }
    keys.add(lowerPath);
    if (lowerPath.endsWith('.md')) {
      keys.add(lowerPath.slice(0, -'.md'.length));
    }
    const competitors = new Set<string>();
    const indexes = [
      this.pathsByLowerBasename,
      this.pathsByLowerName,
      this.pathsByLowerAlias,
      this.pathsByLowerPath,
    ];
    for (const key of keys) {
      for (const index of indexes) {
        const candidates = index.get(key);
        if (candidates === undefined) {
          continue;
        }
        for (const candidate of candidates) {
          if (candidate !== meta.path) {
            competitors.add(candidate);
          }
        }
      }
    }
    for (const competitor of competitors) {
      this.reresolveInboundSources(competitor);
    }
  }

  private notifyChange(): void {
    for (const listener of [...this.changeListeners]) {
      listener();
    }
  }
}
