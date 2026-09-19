import fs from 'fs';
import path from 'path';
import { SUPPORTED_FORMATS } from './protocol';

export type ArchiveEntryLike = {
  entryName: string;
  isDirectory: boolean;
};

export function sanitizeBaseName(fileName: string): string {
  const raw = path.parse(fileName || 'model').name || 'model';
  const safe = raw
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return safe || 'model';
}

export function ensureUniqueDirectory(parentDir: string, baseName: string): string {
  let candidate = baseName;
  let index = 1;
  while (fs.existsSync(path.join(parentDir, candidate))) {
    candidate = `${baseName}_${index++}`;
  }
  return candidate;
}

export function sanitizeArchiveEntry(entryName: string): string {
  const normalized = path.posix.normalize(String(entryName || ''));
  if (!normalized || normalized === '.' || normalized.startsWith('..') || path.isAbsolute(normalized)) {
    return '';
  }
  return normalized;
}

export function getArchiveCommonRoot(entries: ArchiveEntryLike[]): string {
  const topLevelSegments = new Set<string>();

  for (const entry of entries) {
    const safe = sanitizeArchiveEntry(entry.entryName);
    if (!safe) continue;
    const segments = safe.split('/').filter(Boolean);
    if (segments.length === 0) continue;
    if (segments.length === 1 && !entry.isDirectory) return '';
    topLevelSegments.add(segments[0]);
    if (topLevelSegments.size > 1) return '';
  }

  const [root] = topLevelSegments;
  return root || '';
}

export function stripArchiveCommonRoot(entryName: string, commonRoot: string): string {
  if (!commonRoot) return entryName;
  const prefix = `${commonRoot}/`;
  if (entryName === commonRoot) return '';
  if (entryName.startsWith(prefix)) return entryName.slice(prefix.length);
  return entryName;
}

export function normalizeIncomingFileType(fileName: string, fileType: string): string {
  const type = String(fileType || '').trim().toLowerCase().replace(/^\./, '');
  if (SUPPORTED_FORMATS.has(type)) return type;
  const ext = path.extname(fileName || '').trim().toLowerCase().replace(/^\./, '');
  if (SUPPORTED_FORMATS.has(ext)) return ext;
  return type || ext;
}

export function findPrimaryModelFile(rootDir: string): string {
  const preferred = ['.fbx', '.glb', '.gltf', '.obj'];
  const queue = [rootDir];
  const matches: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) { queue.push(fullPath); continue; }
      if (preferred.includes(path.extname(entry.name).toLowerCase())) matches.push(fullPath);
    }
  }

  for (const ext of preferred) {
    const match = matches.find((f) => path.extname(f).toLowerCase() === ext);
    if (match) return match;
  }
  return '';
}
