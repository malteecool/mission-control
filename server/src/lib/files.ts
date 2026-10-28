import fs from "node:fs/promises";
import path from "node:path";
import type { DirListing, FileContent, FileEntry } from "../types.ts";

// The Files tab: read-only browsing of a project's folder. Every path comes from the request, so it's resolved
// (symlinks and junctions included) and must stay inside the project folder.

const MAX_ENTRIES = 5000;
const STAT_BATCH = 256;
const MAX_TEXT = 512 * 1024;
const MAX_IMAGE = 20 * 1024 * 1024;

// Raster formats only: an SVG served from our own origin could run script, so those show as text.
export const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
};

export class FileError extends Error {
  constructor(
    public status: 400 | 404,
    message: string,
  ) {
    super(message);
  }
}

function inside(root: string, target: string) {
  const rel = path.relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** The real absolute path of `rel` within the project, or a FileError. */
async function resolve(projectPath: string, rel: string): Promise<{ abs: string; rel: string }> {
  if (rel.includes("\0") || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) throw new FileError(400, "Invalid path");
  const root = await fs.realpath(projectPath);
  const joined = path.resolve(root, rel);
  if (!inside(root, joined)) throw new FileError(400, "That path is outside the project");
  let abs: string;
  try {
    abs = await fs.realpath(joined);
  } catch {
    throw new FileError(404, "Not found");
  }
  if (!inside(root, abs)) throw new FileError(400, "That path leads outside the project");
  return { abs, rel: path.relative(root, joined).split(path.sep).join("/") };
}

export async function listDir(projectPath: string, relPath: string): Promise<DirListing> {
  const { abs, rel } = await resolve(projectPath, relPath);
  if (!(await fs.stat(abs)).isDirectory()) throw new FileError(400, "Not a folder");
  const dirents = await fs.readdir(abs, { withFileTypes: true });
  const entries: FileEntry[] = [];
  // Everything is statted (in batches, to bound open handles) before sorting, so a big folder's cut-off keeps
  // the first entries in display order rather than whatever readdir returned first.
  for (let i = 0; i < dirents.length; i += STAT_BATCH) {
    const batch = dirents.slice(i, i + STAT_BATCH);
    // stat follows symlinks, so a link to a folder lists as one; broken links are skipped.
    const stats = await Promise.all(batch.map((d) => fs.stat(path.join(abs, d.name)).catch(() => undefined)));
    batch.forEach((d, j) => {
      const st = stats[j];
      if (!st) return;
      entries.push({
        name: d.name,
        path: rel ? `${rel}/${d.name}` : d.name,
        type: st.isDirectory() ? "dir" : "file",
        size: st.isDirectory() ? 0 : st.size,
        modifiedAt: st.mtime.toISOString(),
      });
    });
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) : a.type === "dir" ? -1 : 1));
  return { path: rel, entries: entries.slice(0, MAX_ENTRIES), truncated: entries.length > MAX_ENTRIES || undefined };
}

export async function readFileContent(projectPath: string, relPath: string): Promise<FileContent> {
  const { abs, rel } = await resolve(projectPath, relPath);
  const st = await fs.stat(abs);
  if (!st.isFile()) throw new FileError(400, "Not a file");
  const base = { path: rel, size: st.size, modifiedAt: st.mtime.toISOString() };
  const image = path.extname(abs).toLowerCase() in IMAGE_TYPES && st.size <= MAX_IMAGE;
  if (image) return { ...base, binary: true, image };

  const fh = await fs.open(abs, "r");
  try {
    const buf = Buffer.alloc(Math.min(st.size, MAX_TEXT));
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const bytes = buf.subarray(0, bytesRead);
    // Same rule git uses: a NUL byte near the start means binary.
    if (bytes.subarray(0, 8000).includes(0)) return { ...base, binary: true, image: false };
    return { ...base, binary: false, image: false, text: bytes.toString("utf8"), truncated: st.size > bytesRead || undefined };
  } finally {
    await fh.close();
  }
}

/** An image's bytes and type, for the Files tab's preview. */
export async function readImage(projectPath: string, relPath: string): Promise<{ data: Buffer; type: string }> {
  const { abs } = await resolve(projectPath, relPath);
  const type = IMAGE_TYPES[path.extname(abs).toLowerCase()];
  if (!type) throw new FileError(400, "Not an image");
  const st = await fs.stat(abs);
  if (!st.isFile() || st.size > MAX_IMAGE) throw new FileError(400, "Not an image that can be previewed");
  return { data: await fs.readFile(abs), type };
}
