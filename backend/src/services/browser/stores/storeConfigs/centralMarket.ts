/**
 * Central Market — NOT run through the full discovery pipeline.
 *
 * Live reconnaissance returned a near-empty (212-byte) response carrying
 * an Imperva Incapsula challenge marker — consistent with H-E-B, Central
 * Market's parent banner, which this app already found to be
 * Incapsula-protected (see docs/store_api_audit.md). The two banners
 * appear to share protected infrastructure. Kept here as a record only.
 */
import type { StoreOnboardingConfig } from './types.ts';

export const centralMarket: StoreOnboardingConfig = {
  storeName: 'Central Market',
  homepage: 'https://www.centralmarket.com/',
};
