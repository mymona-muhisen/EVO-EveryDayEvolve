import sharp, { type Metadata } from "sharp";
import { ObjectStorageService } from "./objectStorage";

export const MEMORY_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const MEMORY_IMAGE_MAX_PIXELS = 40_000_000;
const MEMORY_IMAGE_MAX_EDGE = 1920;

export class MemoryImageError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 413 | 415,
  ) {
    super(message);
    this.name = "MemoryImageError";
  }
}

function declaredFormat(contentType: string | undefined): "jpeg" | "png" | "webp" | null {
  switch (contentType?.toLowerCase().split(";")[0].trim()) {
    case "image/jpeg":
    case "image/jpg":
      return "jpeg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    default:
      return null;
  }
}

function signatureFormat(contents: Buffer): "jpeg" | "png" | "webp" | null {
  if (contents.length >= 3
    && contents[0] === 0xff
    && contents[1] === 0xd8
    && contents[2] === 0xff) return "jpeg";
  if (contents.length >= 8
    && contents.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "png";
  }
  if (contents.length >= 12
    && contents.toString("ascii", 0, 4) === "RIFF"
    && contents.toString("ascii", 8, 12) === "WEBP") return "webp";
  return null;
}

function isPixelLimitError(error: unknown): boolean {
  return error instanceof Error && /pixel limit/i.test(error.message);
}

async function readObjectBytes(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const value of stream as AsyncIterable<Buffer | Uint8Array | string>) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    length += chunk.length;
    if (length > MEMORY_IMAGE_MAX_BYTES) {
      (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
      throw new MemoryImageError("Photo exceeds the 10 MiB memory image limit", 413);
    }
    chunks.push(chunk);
  }
  if (length === 0) throw new MemoryImageError("Photo file is empty", 400);
  return Buffer.concat(chunks, length);
}

export class MemoryImageService {
  constructor(private readonly objectStorageService = new ObjectStorageService()) {}

  async createOptimizedPrivatePhoto(
    sourceObjectPath: string,
    authenticatedUserId: string,
  ): Promise<string> {
    const authorized = await this.objectStorageService.getOwnedPrivateObjectEntity(
      sourceObjectPath,
      authenticatedUserId,
    );

    const actualSize = Number(authorized.metadata.size);
    if (Number.isFinite(actualSize) && actualSize > MEMORY_IMAGE_MAX_BYTES) {
      throw new MemoryImageError("Photo exceeds the 10 MiB memory image limit", 413);
    }
    if (Number.isFinite(actualSize) && actualSize <= 0) {
      throw new MemoryImageError("Photo file is empty", 400);
    }

    const contentType = typeof authorized.metadata.contentType === "string"
      ? authorized.metadata.contentType
      : undefined;
    const mimeFormat = declaredFormat(contentType);
    if (!mimeFormat) {
      throw new MemoryImageError("Photo must be a JPEG, PNG, or WebP image", 415);
    }

    const source = await readObjectBytes(authorized.objectFile.createReadStream());
    const signature = signatureFormat(source);
    if (!signature || signature !== mimeFormat) {
      throw new MemoryImageError("Photo content does not match its declared image MIME type", 415);
    }

    let metadata: Metadata;
    try {
      metadata = await sharp(source, {
        failOn: "error",
        limitInputPixels: MEMORY_IMAGE_MAX_PIXELS,
        animated: false,
      }).metadata();
    } catch (error) {
      if (isPixelLimitError(error)) {
        throw new MemoryImageError("Photo exceeds the 40 megapixel memory image limit", 413);
      }
      throw new MemoryImageError("Photo image is corrupt or cannot be decoded", 400);
    }
    if (metadata.format !== signature) {
      throw new MemoryImageError("Decoded photo format does not match its content signature", 415);
    }
    if (!metadata.width || !metadata.height) {
      throw new MemoryImageError("Photo dimensions could not be decoded", 400);
    }
    if (metadata.width * metadata.height > MEMORY_IMAGE_MAX_PIXELS) {
      throw new MemoryImageError("Photo exceeds the 40 megapixel memory image limit", 413);
    }

    let optimized: Buffer;
    try {
      optimized = await sharp(source, {
        failOn: "error",
        limitInputPixels: MEMORY_IMAGE_MAX_PIXELS,
        animated: false,
      })
        .rotate()
        .resize({
          width: MEMORY_IMAGE_MAX_EDGE,
          height: MEMORY_IMAGE_MAX_EDGE,
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp({ quality: 80, effort: 4 })
        .toBuffer();
    } catch {
      throw new MemoryImageError("Photo image is corrupt or cannot be decoded", 400);
    }
    if (optimized.length > MEMORY_IMAGE_MAX_BYTES) {
      throw new MemoryImageError("Optimized photo exceeds the 10 MiB memory image limit", 413);
    }

    return this.objectStorageService.writePrivateDerivedObject(
      authenticatedUserId,
      optimized,
      "image/webp",
    );
  }
}