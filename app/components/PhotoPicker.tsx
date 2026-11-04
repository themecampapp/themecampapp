// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useRef, useState } from "react";
import { Form, useNavigation } from "react-router";
import { btn, fileInput } from "./ui";

// Shrinks a photo in the browser (longest side <= 1600px, JPEG) before upload. It's a
// convenience only; the server still checks and re-encodes everything it receives.
async function downscale(file: File): Promise<File> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.9),
    );
    return blob ? new File([blob], "photo.jpg", { type: "image/jpeg" }) : file;
  } catch {
    return file; // e.g. a browser that can't decode HEIC: send the original
  }
}

export function PhotoPicker({ hasPhoto }: { hasPhoto: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const busy = useNavigation().state === "submitting";

  return (
    <Form method="post" encType="multipart/form-data" className="space-y-3">
      <input type="hidden" name="intent" value="photo_upload" />
      <input
        ref={inputRef}
        type="file"
        name="photo"
        accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
        required
        className={fileInput}
        onChange={async (e) => {
          const original = e.currentTarget.files?.[0];
          if (!original) return;
          setPreparing(true);
          const small = await downscale(original);
          if (small !== original && inputRef.current) {
            const dt = new DataTransfer();
            dt.items.add(small);
            inputRef.current.files = dt.files;
          }
          setPreview(URL.createObjectURL(small));
          setPreparing(false);
        }}
      />
      {preview && (
        <img
          src={preview}
          alt="Your new headshot, before cropping"
          className="h-32 w-32 rounded-xl object-cover ring-1 ring-dust"
        />
      )}
      <button type="submit" className={btn.primary} disabled={busy || preparing}>
        {busy
          ? "Uploading…"
          : preparing
            ? "Preparing…"
            : hasPhoto
              ? "Replace photo"
              : "Upload photo"}
      </button>
    </Form>
  );
}
