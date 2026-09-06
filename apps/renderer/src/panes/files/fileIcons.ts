/**
 * Extension → icon, matching the reference `FolderTree`'s per-type glyphs
 * closely enough to read at a glance without porting its full icon map.
 */
import type { ComponentType } from "react";
import { FileCodeIcon, FileIcon, FileImageIcon, FileJsonIcon, FileTextIcon } from "lucide-react";

type IconComponent = ComponentType<{ className?: string }>;

const CODE_EXTS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "rs",
  "go",
  "java",
  "c",
  "cc",
  "cpp",
  "h",
  "hpp",
  "cs",
  "rb",
  "php",
  "sh",
  "ps1",
  "css",
  "scss",
  "html",
  "sql",
]);
const TEXT_EXTS = new Set(["md", "mdx", "txt", "yaml", "yml", "toml", "ini", "cfg", "log"]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico"]);

export function fileIconFor(name: string): IconComponent {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  if (ext === "json") return FileJsonIcon;
  if (IMAGE_EXTS.has(ext)) return FileImageIcon;
  if (CODE_EXTS.has(ext)) return FileCodeIcon;
  if (TEXT_EXTS.has(ext)) return FileTextIcon;
  return FileIcon;
}
