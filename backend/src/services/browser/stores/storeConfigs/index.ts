/**
 * The full onboarding-candidate list. Adding a new store: write one small
 * config file next to these, then add one import + one array entry here —
 * that's the entire "repeatable process," per this framework's design
 * goal. See each file's own header for what's actually been verified vs.
 * still just a config waiting to be tested.
 */
import { harrisTeeter } from './harrisTeeter.ts';
import { wincoFoods } from './wincoFoods.ts';
import { foodLion } from './foodLion.ts';
import { giantFood } from './giantFood.ts';
import { wegmans } from './wegmans.ts';
import { foodBazaar } from './foodBazaar.ts';
import { pigglyWiggly } from './pigglyWiggly.ts';
import { hMart } from './hMart.ts';
import { lidl } from './lidl.ts';
import { saveMart } from './saveMart.ts';
import { groceryOutlet } from './groceryOutlet.ts';
import { raleys } from './raleys.ts';
import { bashas } from './bashas.ts';
import { freshThyme } from './freshThyme.ts';
import { naturalGrocers } from './naturalGrocers.ts';
import { staterBros } from './staterBros.ts';
import { centralMarket } from './centralMarket.ts';
import { sproutsValidation, traderJoesValidation, aldiValidation } from './validationControls.ts';
import { walmart } from './walmart.ts';
import { hebGrocery } from './hebGrocery.ts';
import { target } from './target.ts';
import { wholeFoods } from './wholeFoods.ts';
import type { StoreOnboardingConfig } from './types.ts';

export const STORE_CONFIGS: StoreOnboardingConfig[] = [
  harrisTeeter,
  wincoFoods,
  foodLion,
  giantFood,
  wegmans,
  foodBazaar,
  pigglyWiggly,
  hMart,
  lidl,
  saveMart,
  groceryOutlet,
  raleys,
  bashas,
  freshThyme,
  naturalGrocers,
  staterBros,
  centralMarket,
  sproutsValidation,
  traderJoesValidation,
  aldiValidation,
  walmart,
  hebGrocery,
  target,
  wholeFoods,
];

export type { StoreOnboardingConfig };
