/**
 * Client-side image processing utility.
 * Handles EXIF orientation, face detection, and standardized square cropping.
 */

const OUTPUT_SIZE = 512; // Final square image dimension in px

/**
 * Read EXIF orientation tag from a JPEG file.
 * Returns orientation value (1-8) or 1 if not found.
 */
function readExifOrientation(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  if (view.byteLength < 2 || view.getUint16(0, false) !== 0xffd8) return 1; // not JPEG

  let offset = 2;
  while (offset < view.byteLength - 1) {
    const marker = view.getUint16(offset, false);
    offset += 2;
    if (marker === 0xffe1) {
      // APP1 (EXIF)
      const length = view.getUint16(offset, false);
      const exifStart = offset + 2;
      // Check for "Exif\0\0"
      if (
        view.getUint32(exifStart, false) === 0x45786966 &&
        view.getUint16(exifStart + 4, false) === 0x0000
      ) {
        const tiffStart = exifStart + 6;
        const littleEndian = view.getUint16(tiffStart, false) === 0x4949;
        const ifdOffset = view.getUint32(tiffStart + 4, littleEndian);
        const numEntries = view.getUint16(tiffStart + ifdOffset, littleEndian);
        for (let i = 0; i < numEntries; i++) {
          const entryOffset = tiffStart + ifdOffset + 2 + i * 12;
          if (entryOffset + 12 > view.byteLength) break;
          const tag = view.getUint16(entryOffset, littleEndian);
          if (tag === 0x0112) {
            // Orientation tag
            return view.getUint16(entryOffset + 8, littleEndian);
          }
        }
      }
      offset += length - 2;
    } else if ((marker & 0xff00) === 0xff00) {
      const length = view.getUint16(offset, false);
      offset += length;
    } else {
      break;
    }
  }
  return 1;
}

/**
 * Apply EXIF orientation transform to a canvas context.
 * Returns { width, height } of the correctly oriented image.
 */
function applyOrientation(ctx, orientation, width, height) {
  switch (orientation) {
    case 2: ctx.transform(-1, 0, 0, 1, width, 0); break;
    case 3: ctx.transform(-1, 0, 0, -1, width, height); break;
    case 4: ctx.transform(1, 0, 0, -1, 0, height); break;
    case 5: ctx.transform(0, 1, 1, 0, 0, 0); break;
    case 6: ctx.transform(0, 1, -1, 0, height, 0); break;
    case 7: ctx.transform(0, -1, -1, 0, height, width); break;
    case 8: ctx.transform(0, -1, 1, 0, 0, width); break;
    default: break;
  }
  const swapped = orientation >= 5 && orientation <= 8;
  return { width: swapped ? height : width, height: swapped ? width : height };
}

/**
 * Attempt face detection using the browser's FaceDetector API.
 * Returns the bounding box of the first detected face, or null.
 */
async function detectFace(imageBitmap) {
  if (typeof window.FaceDetector === "undefined") return null;
  try {
    const detector = new window.FaceDetector({ fastMode: true, maxDetectedFaces: 1 });
    const faces = await detector.detect(imageBitmap);
    if (faces.length > 0) {
      return faces[0].boundingBox;
    }
  } catch {
    // FaceDetector not supported or failed
  }
  return null;
}

/**
 * Process an image file: fix EXIF rotation, detect face, crop to square centered on face.
 * Returns a Promise<Blob> of the processed JPEG image.
 */
export async function processProfilePhoto(file) {
  // Read file as ArrayBuffer for EXIF parsing
  const arrayBuffer = await file.arrayBuffer();
  const orientation = readExifOrientation(arrayBuffer);

  // Load image
  const blob = new Blob([arrayBuffer], { type: file.type });
  const imageBitmap = await createImageBitmap(blob);
  const { width: rawW, height: rawH } = imageBitmap;

  // Step 1: Draw with correct orientation
  const swapped = orientation >= 5 && orientation <= 8;
  const canvasW = swapped ? rawH : rawW;
  const canvasH = swapped ? rawW : rawH;
  const oriented = new OffscreenCanvas(canvasW, canvasH);
  const octx = oriented.getContext("2d");
  applyOrientation(octx, orientation, rawW, rawH);
  octx.drawImage(imageBitmap, 0, 0);

  // Step 2: Detect face for smart cropping
  const orientedBitmap = await createImageBitmap(oriented);
  const faceBox = await detectFace(orientedBitmap);

  // Step 3: Determine crop region (square, centered on face or image center)
  const side = Math.min(canvasW, canvasH);
  let cx, cy;
  if (faceBox) {
    // Center on the face
    cx = faceBox.x + faceBox.width / 2;
    cy = faceBox.y + faceBox.height / 2;
    // Expand crop to include some margin around the face
  } else {
    // Center crop
    cx = canvasW / 2;
    cy = canvasH / 2;
  }

  // Clamp crop to stay within image bounds
  let cropX = Math.round(cx - side / 2);
  let cropY = Math.round(cy - side / 2);
  cropX = Math.max(0, Math.min(cropX, canvasW - side));
  cropY = Math.max(0, Math.min(cropY, canvasH - side));

  // Step 4: Final output canvas at standardized size
  const output = new OffscreenCanvas(OUTPUT_SIZE, OUTPUT_SIZE);
  const outCtx = output.getContext("2d");
  outCtx.drawImage(
    orientedBitmap,
    cropX, cropY, side, side,    // source crop
    0, 0, OUTPUT_SIZE, OUTPUT_SIZE // destination
  );

  // Convert to JPEG blob
  const resultBlob = await output.convertToBlob({ type: "image/jpeg", quality: 0.85 });
  return new File([resultBlob], file.name.replace(/\.[^.]+$/, ".jpg"), {
    type: "image/jpeg",
  });
}
