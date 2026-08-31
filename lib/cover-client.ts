const MAX_CLIENT_NORMALIZATION_SOURCE_BYTES = 24 * 1024 * 1024;
const MAX_NORMALIZED_BYTES = 900 * 1024;
const MAX_NORMALIZED_WIDTH = 600;
const MAX_NORMALIZED_HEIGHT = 900;

export type CoverDimensions = { width: number; height: number };
export type CoverPhotoEdit = {
  rotation: 0 | 90 | 180 | 270;
  zoom: number;
  offsetX: number;
  offsetY: number;
};

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

/**
 * Produces the exact 2:3 crop chosen in the cover editor before the normal
 * private upload. Offsets are normalized to -1..1 and zoom is 1..2.5.
 */
export async function editCoverPhotoForUpload(
  file: File,
  edit: CoverPhotoEdit,
): Promise<File> {
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
    throw new Error("Цей браузер не підтримує редактор фото. Оновіть браузер або скористайтеся іншим пристроєм.");
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await globalThis.createImageBitmap(file, { imageOrientation: "from-image" });
  } catch (error) {
    if (!(error instanceof TypeError)) throw new Error("Не вдалося прочитати фотографію. Спробуйте інший файл.");
    try {
      bitmap = await globalThis.createImageBitmap(file);
    } catch {
      throw new Error("Не вдалося прочитати фотографію. Спробуйте інший файл.");
    }
  }

  try {
    const canvas = document.createElement("canvas");
    canvas.width = MAX_NORMALIZED_WIDTH;
    canvas.height = MAX_NORMALIZED_HEIGHT;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context || typeof canvas.toBlob !== "function") {
      throw new Error("Цей браузер не підтримує редактор фото.");
    }
    const rotation = [0, 90, 180, 270].includes(edit.rotation) ? edit.rotation : 0;
    const zoom = Math.min(2.5, Math.max(1, Number(edit.zoom) || 1));
    const offsetX = Math.min(1, Math.max(-1, Number(edit.offsetX) || 0));
    const offsetY = Math.min(1, Math.max(-1, Number(edit.offsetY) || 0));
    const quarterTurn = rotation === 90 || rotation === 270;
    const rotatedWidth = quarterTurn ? bitmap.height : bitmap.width;
    const rotatedHeight = quarterTurn ? bitmap.width : bitmap.height;
    const scale = Math.max(canvas.width / rotatedWidth, canvas.height / rotatedHeight) * zoom;
    const renderedWidth = rotatedWidth * scale;
    const renderedHeight = rotatedHeight * scale;
    const shiftX = offsetX * Math.max(0, (renderedWidth - canvas.width) / 2);
    const shiftY = offsetY * Math.max(0, (renderedHeight - canvas.height) / 2);

    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.save();
    context.translate(canvas.width / 2 + shiftX, canvas.height / 2 + shiftY);
    context.rotate(rotation * Math.PI / 180);
    context.drawImage(
      bitmap,
      -bitmap.width * scale / 2,
      -bitmap.height * scale / 2,
      bitmap.width * scale,
      bitmap.height * scale,
    );
    context.restore();

    let blob: Blob | null = null;
    for (const quality of [0.86, 0.8, 0.74, 0.68, 0.6]) {
      blob = await canvasToBlob(canvas, "image/jpeg", quality);
      if (blob.size <= MAX_NORMALIZED_BYTES) break;
    }
    canvas.width = 1;
    canvas.height = 1;
    if (!blob || blob.size < 1 || blob.size > MAX_NORMALIZED_BYTES) {
      throw new Error("Не вдалося підготувати фотографію до безпечного розміру.");
    }
    return new File([blob], normalizedCoverFileName(file.name), {
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
