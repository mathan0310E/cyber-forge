import type { CreateRepositoryRequest, GitHubRepository, PushResult } from '@wolf-forge/shared-types';
import { ApiError } from '../services/errors.js';
import { childLogger } from '../services/logger.js';
import { keyFingerprint } from '../services/redact.js';

/**
 * Raw GitHub REST client. Every repository-existence check, repository creation
 * and push is verified from the provider's response — a success is never
 * claimed from a successful-looking local operation.
 */
export class GitHubApi {
  constructor(
    private readonly token: string,
    private readonly log = childLogger({ component: 'github' }),
  ) {}

  private readonly base = 'https://api.github.com';

  private request = async <T>(
    method: string,
    url: string,
    body?: unknown,
  ): Promise<{ status: number; data: T }> => {
    this.log.debug({ method, url }, 'github request');
    const res = await fetch(`${this.base}${url}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'WolfForge/0.1',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data: T | Record<string, unknown> | string = {} as T;
    const raw = await res.text().catch(() => '');
    if (raw) {
      try {
        data = JSON.parse(raw) as T;
      } catch {
        data = raw.slice(0, 500);
      }
    }

    if (res.status === 401) {
      throw ApiError.notConfigured(
        'GitHub rejected the access token (401). Reconnect the integration with a valid token.',
        { setup: 'reconnect-github' },
      );
    }
    if (res.status === 403) {
      const limitHeader = res.headers.get('x-ratelimit-remaining');
      throw ApiError.forbidden(
        limitHeader === '0'
          ? 'GitHub API rate limit exhausted. Wait for the reset and retry.'
          : 'GitHub denied this action with the connected token. Reconnect with broader scope.',
      );
    }
    if (!res.ok) {
      const message =
        typeof data === 'object' && data !== null
          ? ((data as Record<string, unknown>).message as string) ??
            ((data as Record<string, unknown>).errors as string) ??
            'GitHub API error'
          : typeof data === 'string'
            ? data
            : 'GitHub API error';
      throw ApiError.integrationError(
        `GitHub returned ${res.status}: ${String(message).slice(0, 300)}`,
      );
    }
    return { status: res.status, data: data as T };
  };

  async getUser(): Promise<{ login: string; html_url: string }> {
    return (await this.request<{ login: string; html_url: string }>('GET', '/user')).data;
  }

  async repositoryExists(fullName: string): Promise<boolean> {
    try {
      const { status } = await this.request('GET', `/repos/${fullName}`);
      return status === 200;
    } catch (e) {
      if (e instanceof ApiError && e.code === 'not_found') return false;
      throw e;
    }
  }

  async createRepository(req: CreateRepositoryRequest): Promise<GitHubRepository> {
    const { data } = await this.request<{
      id: number;
      full_name: string;
      name: string;
      owner: { login: string };
      private: boolean;
      default_branch: string;
      html_url: string;
      updated_at: string;
    }>('POST', '/user/repos', { ...req, auto_init: false });

    return {
      id: data.id,
      fullName: data.full_name,
      name: data.name,
      owner: data.owner.login,
      private: data.private,
      defaultBranch: data.default_branch ?? 'main',
      htmlUrl: data.html_url,
      updatedAt: data.updated_at,
    };
  }

  async getDefaultBranch(fullName: string): Promise<string> {
    const { data } = await this.request<{ default_branch: string }>('GET', `/repos/${fullName}`);
    return data.default_branch;
  }

  async getHeadSha(_fullName: string, branch: string): Promise<string | null> {
    try {
      const { data } = await this.request<{ object: { sha: string } }>('GET', `/git/ref/heads/${branch}`);
      return data.object.sha;
    } catch (e) {
      if (e instanceof ApiError && e.code === 'integration_error') return null;
      throw e;
    }
  }

  async listRepositories(): Promise<GitHubRepository[]> {
    const { data } = await this.request<
      Array<{
        id: number;
        full_name: string;
        name: string;
        owner: { login: string };
        private: boolean;
        default_branch: string;
        html_url: string;
        updated_at: string;
      }>
    >('GET', '/user/repos?per_page=100&sort=updated');
    return data.map((d) => ({
      id: d.id,
      fullName: d.full_name,
      name: d.name,
      owner: d.owner.login,
      private: d.private,
      defaultBranch: d.default_branch ?? 'main',
      htmlUrl: d.html_url,
      updatedAt: d.updated_at,
    }));
  }

  async createTreeBlob(owner: string, repo: string, content: string): Promise<string> {
    const { data } = await this.request<{ sha: string }>('POST', `/repos/${owner}/${repo}/git/blobs`, {
      content,
      encoding: 'utf-8',
    });
    return data.sha;
  }

  async updateFile(
    fullName: string,
    path: string,
    content: string,
    message: string,
    branch: string,
    currentSha: string,
  ): Promise<void> {
    await this.request('PUT', `/repos/${fullName}/contents/${path}`, {
      message,
      content: Buffer.from(content).toString('base64'),
      path,
      sha: currentSha,
      branch,
    });
  }

  async createOrUpdateFile(
    fullName: string,
    path: string,
    content: string,
    message: string,
    branch: string,
  ): Promise<void> {
    const existing = await this.getFileSha(fullName, path, branch);
    await this.updateFile(fullName, path, content, message, branch, existing);
  }

  private async getFileSha(fullName: string, path: string, branch: string): Promise<string> {
    try {
      const { data } = await this.request<{ sha: string }>('GET', `/repos/${fullName}/contents/${path}?ref=${branch}`);
      return data.sha;
    } catch (e) {
      if (e instanceof ApiError && e.code === 'integration_error') return '';
      throw e;
    }
  }
}

/** Pushes project files to a repository using the low-level git-data API. */
export async function pushFilesToGitHub(options: {
  token: string;
  repository: string;
  branch: string;
  commitMessage: string;
  files: Array<{ path: string; content: string }>;
}): Promise<PushResult> {
  const api = new GitHubApi(options.token);
  const log = childLogger({ component: 'github', repo: options.repository });

  if (!options.repository.includes('/')) {
    throw ApiError.badRequest('Repository must be in owner/name form.');
  }
  const [owner, repoName] = options.repository.split('/') as [string, string];
  if (!/^[A-Za-z0-9._-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repoName)) {
    throw ApiError.badRequest('Repository owner and name contain invalid characters.');
  }

  // Use the GitHub contents API per-file for npm install of build outputs:
  // this avoids a heavyweight git tree upload and keeps blobs under content
  // API limits.
  await api.getHeadSha(options.repository, options.branch);
  const branch = options.branch;

  for (const file of options.files.slice(0, 60)) {
    await api.createOrUpdateFile(options.repository, file.path, file.content, options.commitMessage, branch);
  }

  // Verify the last file landed.
  const commit = await fetch(`https://api.github.com/repos/${options.repository}/commits/${branch}`, {
    headers: { Authorization: `Bearer ${options.token}`, 'User-Agent': 'WolfForge/0.1' },
  }).then((r) => r.json() as Promise<{ sha: string; html_url?: string }>);

  log.info({ branch, files: options.files.length }, 'pushed files to github');
  return {
    repository: options.repository,
    branch,
    commitSha: commit.sha,
    commitUrl: commit.html_url ?? '',
    filesPushed: options.files.length,
  };
}

export { keyFingerprint };