import type { ComposerAttachment } from "../shared/contracts";

export const MAX_COMPOSER_ATTACHMENTS = 32;
export const MAX_PREVIEW_CACHE_CHARACTERS = 22 * 1024 * 1024;

interface AttachmentDraft {
  attachments: ComposerAttachment[];
  attachmentLimitExceeded?: boolean;
}

export function boundedAttachments(
  current: ComposerAttachment[],
  additions: ComposerAttachment[],
  previewCharacterBudget = MAX_PREVIEW_CACHE_CHARACTERS,
) {
  const seen = new Set<string>();
  const merged = [...current, ...additions].filter((attachment) => {
    if (seen.has(attachment.path)) return false;
    seen.add(attachment.path);
    return true;
  });
  let previewCharacters = 0;
  const attachments = merged.slice(0, MAX_COMPOSER_ATTACHMENTS).map((attachment) => {
    if (!attachment.previewUrl) return attachment;
    previewCharacters += attachment.previewUrl.length;
    return previewCharacters <= previewCharacterBudget ? attachment : { ...attachment, previewUrl: null };
  });
  return { attachments, overflow: merged.length > MAX_COMPOSER_ATTACHMENTS };
}

export function previewMap(attachments: ComposerAttachment[]): Record<string, string> {
  return Object.fromEntries(attachments.flatMap((attachment) => attachment.previewUrl ? [[attachment.path, attachment.previewUrl]] : []));
}

export function appendAttachmentsToDraft<T extends AttachmentDraft>(draft: T, additions: ComposerAttachment[]): T & { attachmentLimitExceeded: boolean } {
  const bounded = boundedAttachments(draft.attachments, additions);
  return { ...draft, attachments: bounded.attachments, attachmentLimitExceeded: bounded.overflow };
}

export function retainPreviewPayloadsForDraft<T extends AttachmentDraft>(drafts: Record<string, T>, activeId: string | null): Record<string, T> {
  return Object.fromEntries(Object.entries(drafts).map(([id, draft]) => {
    if (id === activeId || !draft.attachments.some((attachment) => attachment.previewUrl)) return [id, draft];
    return [id, {
      ...draft,
      attachments: draft.attachments.map((attachment) => attachment.previewUrl ? { ...attachment, previewUrl: null } : attachment),
    }];
  }));
}
