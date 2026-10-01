"use client";

import { ImagePlusIcon, XIcon } from "lucide-react";
import type { ImageAttachment } from "@factory/core/api";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { useComposerImages } from "@/hooks/use-composer-images";
import { IMAGE_ACCEPT } from "@/lib/composer-images";

type Images = ReturnType<typeof useComposerImages>;

export function ImagePicker({ images, disabled }: { images: Images; disabled: boolean }) {
  return (
    <>
      <input
        ref={images.inputRef}
        type="file"
        accept={IMAGE_ACCEPT}
        multiple
        hidden
        aria-label="Choose images"
        disabled={disabled}
        onChange={(event) => {
          images.add(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />
      <Button type="button" variant="ghost" size="icon-sm" disabled={disabled} aria-label="Attach images" title="Attach images" onClick={() => images.inputRef.current?.click()}>
        <ImagePlusIcon className="size-4" />
      </Button>
    </>
  );
}

export function ImageDrafts({ images, disabled }: { images: Images; disabled: boolean }) {
  if (!images.images.length && !images.dragging) return null;
  return (
    <div className="px-4 pt-3">
      {images.dragging && <p role="status" className="mb-2 text-xs text-muted-foreground">Drop images here</p>}
      <div className="flex flex-wrap gap-2">
        {images.images.map((image) => (
          <div key={image.id} className="relative size-20 rounded-md border bg-muted">
            <img src={image.url} alt={image.name} className="size-full rounded-md object-cover" />
            {!image.upload && <span role="status" aria-label="Reading image" className="absolute inset-0 flex items-center justify-center rounded-md bg-background/60"><Spinner /></span>}
            <button type="button" onClick={() => images.remove(image.id)} disabled={disabled} aria-label={`Remove ${image.name}`} className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-sm hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed">
              <XIcon className="size-3" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

export function AttachedImages({ runId, images }: { runId: string; images: readonly ImageAttachment[] }) {
  if (!images.length) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {images.map((image) => {
        const url = `/api/runs/${encodeURIComponent(runId)}/images/${encodeURIComponent(image.id)}`;
        return (
          <a key={image.id} href={url} target="_blank" rel="noreferrer" aria-label={`Open ${image.name}`} className="block max-w-full overflow-hidden rounded-md border focus-visible:outline-2 focus-visible:outline-ring">
            <img src={url} alt={image.name} loading="lazy" className="max-h-48 max-w-[min(15rem,100%)] object-contain" />
          </a>
        );
      })}
    </div>
  );
}
