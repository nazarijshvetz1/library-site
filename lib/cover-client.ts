const MAX_CLIENT_NORMALIZATION_SOURCE_BYTES = 24 * 1024 * 1024;
const MAX_NORMALIZED_BYTES = 900 * 1024;
const MAX_NORMALIZED_WIDTH = 600;
const MAX_NORMALIZED_HEIGHT = 900;

export type CoverDimensions = { width: number; height: number };

export function fittedCoverDimensions(
  width: number,
  height: number,
  maximumWidth = MAX_NORMALIZED_WIDTH,
  maximumHeight = MAX_NORMALIZED_HEIGHT,
): CoverDimensions {
  if (
    !Number.isFinite(width)
    || !Number.isFinite(height)
    || !Number.isFinite(maximumWidth)
    || !Number.isFinite(maximumHeight)
    || width <= 0
    || height <= 0
    || maximumWidth <= 0
    || maximumHeight <= 0
  ) {
    throw new Error("Некоректний розмір фотографії.");
  }
  const scale = Math.min(1, maximumWidth / width, maximumHeight / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export function normalizedCoverFileName(name: string): string {
  const rawBase = name.trim().replace(/\.[^.]+$/u, "").slice(0, 150) || "cover";
  const base = /^[=+\-@]/u.test(rawBase) ? `cover-${rawBase.slice(1) || "photo"}` : rawBase;
  return `${base}.jpg`;
}

/**
 * Camera photos are normalized in the browser before the private R2 upload.
 * The server still rechecks size, ownership, signature bytes, and MIME type.
 */
export async function normalizeCoverPhotoForUpload(file: File): Promise<File> {
  if (file.size < 1 || file.size > MAX_CLIENT_NORMALIZATION_SOURCE_BYTES) {
    throw new Error("Початкове фото має бути не більше 24 МБ.");
  }
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    throw new Error("Підтримуються фотографії JPG, PNG або WEBP.");
  }
  if (
    typeof globalThis.createImageBitmap !== "function"
    || typeof document === "undefined"
    || typeof HTMLCanvasElement === "undefined"
  ) {
    throw new Error(
      "Цей браузер не може підготувати безпечний JPEG. Оновіть браузер або скористайтеся іншим пристроєм.",
    );
  }

  const capabilityCanvas = document.createElement("canvas");
  if (
    typeof capabilityCanvas.toBlob !== "function"
    || !capabilityCanvas.getContext("2d", { alpha: false })
  ) {
    throw new Error(
      "Цей браузер не може підготувати безпечний JPEG. Оновіть браузер або скористайтеся іншим пристроєм.",
    );
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await globalThis.createImageBitmap(file, {
      imageOrientation: "from-image",
    });
  } catch (error) {
    if (!(error instanceof TypeError)) {
      throw new Error("Не вдалося прочитати фотографію. Спробуйте інший файл.");
    }
    try {
      bitmap = await globalThis.createImageBitmap(file);
    } catch {
      throw new Error("Не вдалося прочитати фотографію. Спробуйте інший файл.");
    }
  }

  try {
    let dimensions = fittedCoverDimensions(bitmap.width, bitmap.height);
    const attempts = [0.82, 0.76, 0.68, 0.6];
    let lastBlob: Blob | null = null;

    for (const quality of attempts) {
      const canvas = document.createElement("canvas");
      canvas.width = dimensions.width;
      canvas.height = dimensions.height;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("Браузер не підтримує підготовку фотографії.");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, dimensions.width, dimensions.height);
      context.drawImage(bitmap, 0, 0, dimensions.width, dimensions.height);
      lastBlob = await canvasToBlob(canvas, "image/jpeg", quality);
      canvas.width = 1;
      canvas.height = 1;
      if (lastBlob.size < 1) {
        throw new Error("Браузер створив порожній файл фотографії.");
      }
      if (lastBlob.size <= MAX_NORMALIZED_BYTES) {
        return new File([lastBlob], normalizedCoverFileName(file.name), {
          type: "image/jpeg",
          lastModified: file.lastModified,
        });
      }

      const reduction = Math.min(
        0.88,
        Math.sqrt(MAX_NORMALIZED_BYTES / lastBlob.size) * 0.94,
      );
      dimensions = fittedCoverDimensions(
        Math.max(1, Math.floor(dimensions.width * reduction)),
        Math.max(1, Math.floor(dimensions.height * reduction)),
      );
    }

    if (!lastBlob || lastBlob.size > MAX_NORMALIZED_BYTES) {
      throw new Error("Не вдалося підготувати фотографію до безпечного розміру.");
    }
    return new File([lastBlob], normalizedCoverFileName(file.name), {
      type: "image/jpeg",
      lastModified: file.lastModified,
    });
  } finally {
    bitmap.close();
  }
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Браузер не зміг підготувати JPEG-файл."));
    }, type, quality);
  });
}
