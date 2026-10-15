import { promises as fs } from 'node:fs';
import path from 'node:path';
import archiver from 'archiver';
import type { StoredFile } from '../services/artifacts.js';
import { isProtectedPath, isSafeRelativePath } from '@wolf-forge/shared-types';

export interface ExportOptions {
  project: { name: string; description: string };
  files: StoredFile[];
  framework: string;
  /** UID of the exporting user, for the README. */
  ownerLabel: string;
  generatedAt: string;
}

const README_TEMPLATE = (opts: {
  projectName: string;
  description: string;
  framework: string;
  generatedAt: string;
}) => `# ${opts.projectName}

${opts.description}

> Generated with **Wolf Forge** on ${opts.generatedAt}. Sample content included by the
> generator is intended to be replaced before publishing.

## Stack

- Framework: ${opts.framework}

## Getting started

\`\`\`bash
# Install dependencies
npm install

# Run a local development server
npm run dev

# Create a production build
npm run build

# Preview the production build
npm run preview
\`\`\`

## Configuration

Copy \`.env.example\` to \`.env\` and fill in any values you need. No secrets are required
for local development. **No API keys, service-account credentials or deployment tokens
are ever included in an export.**

## Structure

- \`src/\` — application source.
- \`src/pages/\` — page components, one per route.
- \`src/components/\` — reusable components.
- \`src/styles/\` — global styles and design tokens.
`;

/**
 * Builds a ZIP archive of the project source in memory.
 *
 * The archive contains only the versioned source files plus a generated README
 * and an `.env.example` with placeholder values. Generated `package.json` is
 * exported exactly as built (dependencies pinned by the sandbox allowlist), and
 * a lockfile is included when present.
 */
export async function buildZipArchive(options: ExportOptions): Promise<Buffer> {
  const files = options.files.filter((f) => isSafeRelativePath(f.path) && !isProtectedPath(f.path));

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const archive = archiver('zip', { zlib: { level: 9 } });

    archive.on('error', (err) => reject(err));
    archive.on('data', (chunk: Buffer) => chunks.push(chunk));
    archive.on('end', () => resolve(Buffer.concat(chunks as Buffer[])));

    for (const file of files) {
      archive.append(file.content, { name: file.path });
    }

    // Zero-length marker that only appears when there is nothing to export.
    if (files.length === 0) {
      archive.append('This export is empty.\n', { name: 'EMPTY.txt' });
    }

    archive.append(
      README_TEMPLATE({
        projectName: options.project.name,
        description: options.project.description,
        framework: options.framework,
        generatedAt: options.generatedAt,
      }),
      { name: 'README.md' },
    );

    archive.append(`# Copy to .env and fill in placeholders only.
# Wolf Forge exports never contain real secrets.
SOME_VARIABLE=
ANOTHER_VARIABLE=change-me
`, { name: '.env.example' });

    void archive.finalize();
  });
}

/** Writes the archive to a temporary path for response streaming. */
export async function writeArchiveTemp(buffer: Buffer): Promise<string> {
  const dir = path.join(process.cwd(), '.tmp', 'exports');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `export-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`);
  await fs.writeFile(file, buffer);
  return file;
}