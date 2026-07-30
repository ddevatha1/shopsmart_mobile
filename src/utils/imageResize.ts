/**
 * Pure resize-target math for the AI Product Quality Scanner's upload
 * compression (see services/imageCompressionService.ts) — kept in its own
 * zero-dependency file specifically so it can be unit tested: the service
 * file that actually calls expo-image-manipulator can't be imported from
 * Jest at all in this project (no React Native preset — see
 * jest.config.js; the native module's own ESM source fails to parse under
 * plain ts-jest).
 *
 * Resizes by whichever dimension is actually the long edge — capping only
 * `width` would do nothing useful for a portrait photo whose width is
 * already the SHORT edge. Returns `undefined` (no resize needed) when the
 * image is already within bounds, never upscales.
 */
// Matches imageCompressionService.ts's own MAX_DIMENSION constant — kept
// here too since this is the module that owns the resize decision, and a
// caller (or a test) shouldn't have to pass it every time.
const DEFAULT_MAX_DIMENSION = 1024;

export function computeResizeTarget(
  width: number,
  height: number,
  maxDimension: number = DEFAULT_MAX_DIMENSION,
): { width: number } | { height: number } | undefined {
  const longEdge = Math.max(width, height);
  if (longEdge <= maxDimension) return undefined;
  return width >= height ? { width: maxDimension } : { height: maxDimension };
}
