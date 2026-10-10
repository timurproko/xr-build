// Built packages in builds/ (design D8). The identity is read from each zip's package.json with
// Windows' own tar (bsdtar): .NET's ZipArchive rejects the DotNetZip zips, bsdtar reads them.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface BuiltPackage {
  file: string;
  path: string;
  id: string | null;
  title: string | null;
  version: string | null;
  sizeBytes: number;
  builtMs: number;
  error: string | null;
}

const TAR = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');

/** package.json of a zip, as text. */
export function readZipEntry(zip: string, entry: string, tar = TAR): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(tar, ['-xOf', zip, entry], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

export class PackageList {
  private readonly cache = new Map<string, { key: string; pkg: BuiltPackage }>();
  private readonly outDir: string;
  private readonly read: typeof readZipEntry;

  constructor(outDir: string, read = readZipEntry) {
    this.outDir = outDir;
    this.read = read;
  }

  async list(): Promise<BuiltPackage[]> {
    let names: string[] = [];
    try {
      names = (await fs.readdir(this.outDir)).filter((n) => n.toLowerCase().endsWith('.zip'));
    } catch {
      return [];
    }
    const out: BuiltPackage[] = [];
    for (const name of names) {
      const file = path.join(this.outDir, name);
      const st = await fs.stat(file).catch(() => null);
      if (!st?.isFile()) continue;
      const key = `${st.size}:${st.mtimeMs}`;
      const hit = this.cache.get(file);
      if (hit?.key === key) {
        out.push(hit.pkg);
        continue;
      }
      const pkg: BuiltPackage = { file: name, path: file, id: null, title: null, version: null, sizeBytes: st.size, builtMs: st.mtimeMs, error: null };
      try {
        const j = JSON.parse(await this.read(file, 'package.json')) as { id?: string; title?: string; version?: string };
        pkg.id = j.id ?? null;
        pkg.title = j.title ?? null;
        pkg.version = j.version ?? null;
      } catch (e) {
        pkg.error = `cannot read package.json: ${(e as Error).message.split('\n')[0]}`;
      }
      this.cache.set(file, { key, pkg });
      out.push(pkg);
    }
    return out.sort((a, b) => b.builtMs - a.builtMs);
  }

  /** Version of builds/<id>.zip, if one exists. */
  async versionOf(id: string): Promise<string | null> {
    return (await this.list()).find((p) => p.id === id)?.version ?? null;
  }
}
