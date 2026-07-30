import { apiClient } from './apiClient';
import type { VisionQualityResult } from '../models/types';

/**
 * AI Product Quality Scanner (Feature 1) + optional expiration-date
 * detection (Feature 2) — deliberately thin, same layering convention as
 * searchRepository.ts: all real logic (the vision-LLM call, hedged-
 * language enforcement, safe/unsafe-claim rejection) lives server-side in
 * backend/src/services/visionQualityService.ts. This exists only so
 * screens never call fetch()/apiClient directly.
 */
export const productQualityService = {
  assessQuality(imageBase64: string, productNameHint?: string): Promise<VisionQualityResult> {
    return apiClient.assessProductQuality(imageBase64, productNameHint);
  },
};
