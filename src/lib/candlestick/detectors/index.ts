import { PATTERN_TAXONOMY } from "../classify";
import type { PatternDescriptor } from "../types";

import {
  cdlBeltHold,
  cdlClosingMarubozu,
  cdlDoji,
  cdlDragonflyDoji,
  cdlGravestoneDoji,
  cdlHammer,
  cdlHangingMan,
  cdlHighWave,
  cdlInvertedHammer,
  cdlLongLeggedDoji,
  cdlLongLine,
  cdlMarubozu,
  cdlRickshawMan,
  cdlShootingStar,
  cdlShortLine,
  cdlSpinningTop,
  cdlTakuri,
} from "./single-bar";

import {
  cdlCounterattack,
  cdlDarkCloudCover,
  cdlEngulfing,
  cdlHarami,
  cdlHaramiCross,
  cdlHomingPigeon,
  cdlInNeck,
  cdlKicking,
  cdlKickingByLength,
  cdlMatchingLow,
  cdlOnNeck,
  cdlPiercing,
  cdlSeparatingLines,
  cdlThrusting,
} from "./two-bar";

import {
  cdl2Crows,
  cdl3BlackCrows,
  cdl3Inside,
  cdl3LineStrike,
  cdl3Outside,
  cdl3StarsInSouth,
  cdl3WhiteSoldiers,
  cdlAbandonedBaby,
  cdlAdvanceBlock,
  cdlDojiStar,
  cdlEveningDojiStar,
  cdlEveningStar,
  cdlGapSideSideWhite,
  cdlIdentical3Crows,
  cdlMorningDojiStar,
  cdlMorningStar,
  cdlStalledPattern,
  cdlStickSandwich,
  cdlTasukiGap,
  cdlTristar,
  cdlUnique3River,
  cdlUpsideGap2Crows,
} from "./three-bar";

import {
  cdlBreakaway,
  cdlConcealBabySwall,
  cdlHikkake,
  cdlHikkakeMod,
  cdlLadderBottom,
  cdlMatHold,
  cdlRiseFall3Methods,
  cdlXSideGap3Methods,
} from "./multi-bar";

/**
 * Wire every detector to its classification entry. The order of this list
 * doubles as the engine's deterministic iteration order, so re-ordering
 * should be done carefully — chart overlays and snapshot serialisation
 * assume insertion order matches detection precedence.
 */
const DETECTOR_FUNCS: Record<string, PatternDescriptor["detect"]> = {
  // single-bar
  CDLDOJI: cdlDoji,
  CDLDRAGONFLYDOJI: cdlDragonflyDoji,
  CDLGRAVESTONEDOJI: cdlGravestoneDoji,
  CDLLONGLEGGEDDOJI: cdlLongLeggedDoji,
  CDLRICKSHAWMAN: cdlRickshawMan,
  CDLHAMMER: cdlHammer,
  CDLHANGINGMAN: cdlHangingMan,
  CDLINVERTEDHAMMER: cdlInvertedHammer,
  CDLSHOOTINGSTAR: cdlShootingStar,
  CDLTAKURI: cdlTakuri,
  CDLMARUBOZU: cdlMarubozu,
  CDLCLOSINGMARUBOZU: cdlClosingMarubozu,
  CDLLONGLINE: cdlLongLine,
  CDLSHORTLINE: cdlShortLine,
  CDLSPINNINGTOP: cdlSpinningTop,
  CDLHIGHWAVE: cdlHighWave,
  CDLBELTHOLD: cdlBeltHold,

  // two-bar
  CDLENGULFING: cdlEngulfing,
  CDLHARAMI: cdlHarami,
  CDLHARAMICROSS: cdlHaramiCross,
  CDLPIERCING: cdlPiercing,
  CDLDARKCLOUDCOVER: cdlDarkCloudCover,
  CDLCOUNTERATTACK: cdlCounterattack,
  CDLHOMINGPIGEON: cdlHomingPigeon,
  CDLINNECK: cdlInNeck,
  CDLONNECK: cdlOnNeck,
  CDLTHRUSTING: cdlThrusting,
  CDLKICKING: cdlKicking,
  CDLKICKINGBYLENGTH: cdlKickingByLength,
  CDLMATCHINGLOW: cdlMatchingLow,
  CDLSEPARATINGLINES: cdlSeparatingLines,

  // three-bar
  CDLDOJISTAR: cdlDojiStar,
  CDLMORNINGSTAR: cdlMorningStar,
  CDLMORNINGDOJISTAR: cdlMorningDojiStar,
  CDLEVENINGSTAR: cdlEveningStar,
  CDLEVENINGDOJISTAR: cdlEveningDojiStar,
  CDL3WHITESOLDIERS: cdl3WhiteSoldiers,
  CDL3BLACKCROWS: cdl3BlackCrows,
  CDL3INSIDE: cdl3Inside,
  CDL3OUTSIDE: cdl3Outside,
  CDL3LINESTRIKE: cdl3LineStrike,
  CDLTRISTAR: cdlTristar,
  CDL2CROWS: cdl2Crows,
  CDLUPSIDEGAP2CROWS: cdlUpsideGap2Crows,
  CDLABANDONEDBABY: cdlAbandonedBaby,
  CDLADVANCEBLOCK: cdlAdvanceBlock,
  CDLSTALLEDPATTERN: cdlStalledPattern,
  CDLIDENTICAL3CROWS: cdlIdentical3Crows,
  CDL3STARSINSOUTH: cdl3StarsInSouth,
  CDLSTICKSANDWICH: cdlStickSandwich,
  CDLTASUKIGAP: cdlTasukiGap,
  CDLGAPSIDESIDEWHITE: cdlGapSideSideWhite,
  CDLUNIQUE3RIVER: cdlUnique3River,

  // multi-bar
  CDLHIKKAKE: cdlHikkake,
  CDLHIKKAKEMOD: cdlHikkakeMod,
  CDLMATHOLD: cdlMatHold,
  CDLRISEFALL3METHODS: cdlRiseFall3Methods,
  CDLXSIDEGAP3METHODS: cdlXSideGap3Methods,
  CDLCONCEALBABYSWALL: cdlConcealBabySwall,
  CDLLADDERBOTTOM: cdlLadderBottom,
  CDLBREAKAWAY: cdlBreakaway,
};

/**
 * Frozen list of `PatternDescriptor` objects — one per supported pattern.
 * Built from `PATTERN_TAXONOMY` × `DETECTOR_FUNCS` so adding a new pattern
 * only requires touching `classify.ts` + the relevant detector file.
 */
export const DETECTORS: readonly PatternDescriptor[] = Object.freeze(
  Object.entries(PATTERN_TAXONOMY)
    .map(([id, meta]) => {
      const fn = DETECTOR_FUNCS[id];
      if (!fn) {
        // Surface drift between the taxonomy and the implementations early.
        console.warn(`[candlestick] no detector registered for ${id}`);
        return null;
      }
      const descriptor: PatternDescriptor = {
        id,
        name: meta.name,
        category: meta.category,
        lookback: meta.lookback,
        reliability: meta.reliability,
        detect: fn,
      };
      return descriptor;
    })
    .filter((d): d is PatternDescriptor => d !== null),
);

export const DETECTOR_COUNT = DETECTORS.length;
