import { open, realpath, stat, mkdir, rename, unlink } from "node:fs/promises";
import { dirname, relative, isAbsolute, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export async function boundedRead(file: string, limit: number): Promise<Buffer> {
  const handle = await open(file, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) throw new Error("File exceeds its size limit");
    const bytes = Buffer.alloc(limit + 1);
    let count = 0;
    while (count < bytes.length) {
      const result = await handle.read(bytes, count, bytes.length - count, count);
      if (!result.bytesRead) break;
      count += result.bytesRead;
    }
    if (count > limit) throw new Error("File exceeds its size limit");
    return bytes.subarray(0, count);
  } finally { await handle.close(); }
}
export async function atomicJson(file: string, value: unknown, signal?: AbortSignal): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(value), "utf8"); await handle.sync(); } finally { await handle.close(); }
    if (signal?.aborted) throw new Error("Write cancelled");
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(() => {}); }
}
export interface VerifiedRoot { selected: string; canonical: string; dev: number; ino: number }
export async function verifyRoot(selected: string): Promise<VerifiedRoot> {
  const canonical = await realpath(selected);
  const info = await stat(canonical);
  if (!info.isDirectory()) throw new Error("Extension root is not a directory");
  return { selected: resolve(selected), canonical, dev: info.dev, ino: info.ino };
}
/** Check the selected root, file identity and confinement before and after reading the open descriptor. */
export async function confinedRead(root: VerifiedRoot, asset: string, limit: number): Promise<Buffer> {
  const currentRoot = await verifyRoot(root.selected);
  if (currentRoot.canonical !== root.canonical || currentRoot.dev !== root.dev || currentRoot.ino !== root.ino) throw new Error("Extension root changed");
  const candidate = await realpath(resolve(root.canonical, asset));
  const inside = relative(root.canonical, candidate);
  if (!inside || inside === ".." || inside.startsWith("../") || inside.startsWith("..\\") || isAbsolute(inside)) throw new Error("Asset escapes extension root");
  const before = await stat(candidate);
  if (!before.isFile() || before.size > limit) throw new Error("Invalid extension asset");
  const handle = await open(candidate, "r");
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new Error("Extension asset changed");
    const bytes = Buffer.alloc(limit + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = await handle.read(bytes, count, bytes.length - count, count);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    const afterRoot = await verifyRoot(root.selected);
    if (count > limit || afterRoot.canonical !== root.canonical || afterRoot.dev !== root.dev || afterRoot.ino !== root.ino || await realpath(resolve(root.canonical, asset)) !== candidate) throw new Error("Extension asset changed");
    return bytes.subarray(0, count);
  } finally { await handle.close(); }
}
