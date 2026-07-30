import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { computeResizeTarget } from '../utils/imageResize';

/**
 * AI Product Quality Scanner (Feature 1) upload optimization — the fix for
 * a real, confirmed 413 "payload too large" bug. `takePictureAsync`'s own
 * `quality` option only controls JPEG *compression*, never pixel
 * dimensions: a modern phone's camera still captures at full sensor
 * resolution (often 3000×4000+) regardless of that setting, and a photo
 * that large — even compressed — can still be several MB, comfortably
 * over what this app's backend (or any reverse proxy in front of it)
 * should reasonably accept as a JSON body. The AI vision model doesn't
 * need the original resolution to judge freshness/spot defects/read a
 * printed expiration date — a modest, capped long-edge resize plus JPEG
 * recompression is enough for all three, and (as a side effect of the
 * image being fully re-encoded rather than copied) also strips any EXIF
 * metadata the original capture carried, with no separate step needed.
 */

const JPEG_COMPRESSION = 0.6;

/**
 * Resizes (if needed) and recompresses a captured photo, returning a
 * base64 JPEG string ready for `productQualityService.assessQuality` —
 * no data-URL prefix, matching the backend's contract. Never throws for
 * an already-small photo (the resize step is simply skipped); a real
 * manipulation failure propagates to the caller, which already has its
 * own "couldn't analyze this photo" fallback (see ProductQualityScreen).
 */
export async function compressPhotoForUpload(uri: string, width: number, height: number): Promise<string> {
  const target = computeResizeTarget(width, height);
  const context = ImageManipulator.manipulate(uri);
  if (target) context.resize(target);

  const rendered = await context.renderAsync();
  const result = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: JPEG_COMPRESSION, base64: true });

  if (!result.base64) throw new Error('Image compression did not produce a usable photo.');
  return result.base64;
}
