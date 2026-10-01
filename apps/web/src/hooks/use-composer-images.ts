"use client";

import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { toast } from "sonner";
import type { ImageUpload } from "@factory/core/api";
import { imageFileError, readImage } from "@/lib/composer-images";

export interface DraftImage {
  id: string;
  name: string;
  url: string;
  upload?: ImageUpload;
}

/** Shared by the new-run and follow-up composers. Files remain local until send succeeds. */
export function useComposerImages(disabled: boolean) {
  const [images, setImages] = useState<DraftImage[]>([]);
  const current = useRef(images);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const mounted = useRef(true);
  const inputRef = useRef<HTMLInputElement>(null);

  const update = (next: DraftImage[]) => {
    current.current = next;
    setImages(next);
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      current.current.forEach((image) => URL.revokeObjectURL(image.url));
    };
  }, []);

  const remove = (id: string) => {
    const image = current.current.find((item) => item.id === id);
    if (image) URL.revokeObjectURL(image.url);
    update(current.current.filter((item) => item.id !== id));
  };

  const clear = () => {
    current.current.forEach((image) => URL.revokeObjectURL(image.url));
    update([]);
  };

  const add = (files: Iterable<File>) => {
    if (disabled) return;
    for (const file of files) {
      const error = imageFileError(file, current.current.length);
      if (error) {
        toast.error(error);
        continue;
      }
      const image: DraftImage = { id: crypto.randomUUID(), name: file.name || "image", url: URL.createObjectURL(file) };
      update([...current.current, image]);
      void readImage(file).then((upload) => {
        if (mounted.current) update(current.current.map((item) => item.id === image.id ? { ...item, upload } : item));
      }).catch((error: unknown) => {
        if (!mounted.current || !current.current.some((item) => item.id === image.id)) return;
        remove(image.id);
        toast.error(error instanceof Error ? error.message : "Could not read the image. Try attaching it again.");
      });
    }
  };

  const isFileDrag = (event: DragEvent) => event.dataTransfer.types.includes("Files");
  return {
    images,
    inputRef,
    add,
    remove,
    clear,
    reading: images.some((image) => !image.upload),
    uploads: images.flatMap((image) => image.upload ? [image.upload] : []),
    dragging: dragging && !disabled,
    onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const files = Array.from(event.clipboardData.files);
      if (!files.length) return;
      event.preventDefault();
      add(files);
    },
    dragHandlers: {
      onDragEnter: (event: DragEvent<HTMLFormElement>) => {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        dragDepth.current++;
        if (!disabled) setDragging(true);
      },
      onDragOver: (event: DragEvent<HTMLFormElement>) => {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = disabled ? "none" : "copy";
      },
      onDragLeave: (event: DragEvent<HTMLFormElement>) => {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDragging(false);
      },
      onDrop: (event: DragEvent<HTMLFormElement>) => {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        add(Array.from(event.dataTransfer.files));
      },
    },
  };
}
