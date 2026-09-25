import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import type { ComposerAttachment } from "../shared/contracts";

const MAX_ATTACHMENTS = 32;
const MAX_PREVIEW_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_PREVIEW_BYTES = 16 * 1024 * 1024;

const IMAGE_TYPES: Record<string, string> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

const AUDIO_TYPES: Record<string, string> = {
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".webm": "audio/webm",
};

export function recentUniquePaths(paths: readonly string[], limit = MAX_ATTACHMENTS): string[] {
  const seen = new Set<string>();
  const recent: string[] = [];
  for (let index = paths.length - 1; index >= 0 && recent.length < limit; index -= 1) {
    const path = paths[index];
    if (seen.has(path)) continue;
    seen.add(path);
    recent.push(path);
  }
  return recent.reverse();
}

export async function describeAttachments(paths: readonly string[]): Promise<ComposerAttachment[]> {
  const uniquePaths = [...new Set(paths.filter((path) => typeof path === "string" && isAbsolute(path)))].slice(0, MAX_ATTACHMENTS);
  const described: ComposerAttachment[] = [];
  let previewBudget = MAX_TOTAL_PREVIEW_BYTES;
  for (const path of uniquePaths) {
    try {
      const attachment = await describeAttachment(path, previewBudget);
      described.push(attachment);
      if (attachment.previewUrl) previewBudget -= attachment.size ?? 0;
    } catch {
      // A stale path should not prevent the remaining dropped items from being attached.
    }
  }
  return described;
}

async function describeAttachment(path: string, previewBudget: number): Promise<ComposerAttachment> {
  const info = await stat(path);
  if (info.isDirectory()) {
    return { id: randomUUID(), path, name: basename(path) || path, kind: "folder", mimeType: null, size: null, previewUrl: null };
  }
  if (!info.isFile()) throw new Error("Only files and folders can be attached");

  const extension = extname(path).toLowerCase();
  const imageType = IMAGE_TYPES[extension];
  const audioType = AUDIO_TYPES[extension];
  const previewUrl = imageType && info.size <= MAX_PREVIEW_BYTES && info.size <= previewBudget
    ? `data:${imageType};base64,${(await readFile(path)).toString("base64")}`
    : null;
  return {
    id: randomUUID(),
    path,
    name: basename(path),
    kind: imageType ? "image" : audioType ? "audio" : "file",
    mimeType: imageType ?? audioType ?? null,
    size: info.size,
    previewUrl,
  };
}
