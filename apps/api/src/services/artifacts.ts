import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isProtectedPath, isSafeRelativePath } from '@wolf-forge/shared-types';
import { ApiError } from '../services/errors.js';

export interface StoredFile {
  path: string;
  content: string;
  size: number;
}

export interface FileManifestEntry {
  path: string;
  size: number;
  /** sha256 of the file content, used for change detection and diffing. */
  hash: string;
}

/**
 * Versioned artifact store.
 *
 * Source trees live on disk (or any mounted volume) keyed by
 * `<projectId>/<versionId>/`, never inside a database document. Every write
 * path is validated against the project root, and protected filenames are
 * rejected outright so a generated patch can never touch secrets or VCS data.
 */
export class ArtifactStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async init(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
  }

  private versionDir(projectId: string, versionId: string): string {
    assertId(projectId, 'projectId');
    assertId(versionId, 'versionId');
    return path.join(this.root, projectId, versionId);
  }

  /**
   * Resolves a project-relative path to an absolute path inside `baseDir`,
   * rejecting traversal, absolute paths and protected filenames.
   */
  private resolveInside(baseDir: string, relative: string): string {
    if (!isSafeRelativePath(relative)) {
      throw ApiError.badRequest(`Unsafe file path: ${JSON.stringify(relative).slice(0, 120)}`);
    }
    if (isProtectedPath(relative)) {
      throw ApiError.badRequest(`Refusing to touch protected path: ${relative}`);
    }
    const absolute = path.resolve(baseDir, relative);
    const prefix = path.resolve(baseDir) + path.sep;
    if (absolute !== path.resolve(baseDir) && !absolute.startsWith(prefix)) {
      throw ApiError.badRequest('Resolved path escapes the project root');
    }
    return absolute;
  }

  async writeFiles(
    projectId: string,
    versionId: string,
    files: Array<{ path: string; content: string }>,
  ): Promise<FileManifestEntry[]> {
    const dir = this.versionDir(projectId, versionId);
    await fs.mkdir(dir, { recursive: true });
    const manifest: FileManifestEntry[] = [];
    for (const file of files) {
      const target = this.resolveInside(dir, file.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, file.content, 'utf8');
      manifest.push({
        path: file.path,
        size: Buffer.byteLength(file.content, 'utf8'),
        hash: sha256(file.content),
      });
    }
    return manifest;
  }

  /** Copies an existing version tree to a new version id. */
  async copyVersion(projectId: string, fromVersionId: string, toVersionId: string): Promise<void> {
    const from = this.versionDir(projectId, fromVersionId);
    const to = this.versionDir(projectId, toVersionId);
    await fs.mkdir(path.dirname(to), { recursive: true });
    try {
      await fs.cp(from, to, { recursive: true, errorOnExist: false });
    } catch (e) {
      throw ApiError.internal('Failed to copy project version', { err: String(e) });
    }
  }

  async readFile(projectId: string, versionId: string, relative: string): Promise<string> {
    const dir = this.versionDir(projectId, versionId);
    const target = this.resolveInside(dir, relative);
    try {
      return await fs.readFile(target, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        throw ApiError.notFound(`File not found: ${relative}`);
      }
      throw ApiError.internal('Failed to read file', { err: String(e) });
    }
  }

  async fileExists(projectId: string, versionId: string, relative: string): Promise<boolean> {
    try {
      const dir = this.versionDir(projectId, versionId);
      await fs.access(this.resolveInside(dir, relative));
      return true;
    } catch {
      return false;
    }
  }

  async listFiles(projectId: string, versionId: string): Promise<FileManifestEntry[]> {
    const dir = this.versionDir(projectId, versionId);
    const out: FileManifestEntry[] = [];
    await walk(dir, dir, out, 0);
    out.sort((a, b) => a.path.localeCompare(b.path));
    return out;
  }

  async deleteVersion(projectId: string, versionId: string): Promise<void> {
    const dir = this.versionDir(projectId, versionId);
    await fs.rm(dir, { recursive: true, force: true });
  }

  async deleteProject(projectId: string): Promise<void> {
    assertId(projectId, 'projectId');
    await fs.rm(path.join(this.root, projectId), { recursive: true, force: true });
  }

  async readAllFiles(projectId: string, versionId: string): Promise<StoredFile[]> {
    const manifest = await this.listFiles(projectId, versionId);
    const dir = this.versionDir(projectId, versionId);
    const out: StoredFile[] = [];
    for (const entry of manifest) {
      const content = await fs.readFile(path.join(dir, entry.path), 'utf8');
      out.push({ path: entry.path, content, size: entry.size });
    }
    return out;
  }

  /**
   * Materialises a version into an arbitrary working directory (used to stage a
   * sandbox build). Returns the list of written paths.
   */
  async materialize(
    projectId: string,
    versionId: string,
    destination: string,
  ): Promise<FileManifestEntry[]> {
    const manifest = await this.listFiles(projectId, versionId);
    const dir = this.versionDir(projectId, versionId);
    await fs.mkdir(destination, { recursive: true });
    for (const entry of manifest) {
      const target = path.join(destination, entry.path);
      const resolved = path.resolve(target);
      if (!resolved.startsWith(path.resolve(destination) + path.sep)) {
        throw ApiError.badRequest('Manifest contains a path outside the destination');
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(path.join(dir, entry.path), target);
    }
    return manifest;
  }

  versionPath(projectId: string, versionId: string): string {
    return this.versionDir(projectId, versionId);
  }

  get rootPath(): string {
    return this.root;
  }
}

async function walk(
  base: string,
  current: string,
  out: FileManifestEntry[],
  depth: number,
): Promise<void> {
  if (depth > 12) return;
  const entries = await fs.readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await walk(base, full, out, depth + 1);
    } else if (entry.isFile()) {
      const relative = path.relative(base, full).split(path.sep).join('/');
      const stat = await fs.stat(full);
      out.push({ path: relative, size: stat.size, hash: '' });
    }
  }
}

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

function assertId(value: string, label: string): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
    throw ApiError.badRequest(`Invalid ${label}`);
  }
}
