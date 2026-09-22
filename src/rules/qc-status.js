/**
 * QC decision rules.
 *
 * Production QC has exactly three outcomes: PASS, QUICK REVIEW, MANUAL REVIEW.
 * A status is decided by three inputs only:
 *
 *   1. the Ground Truth <-> Winner relation (EXACT / RELATIVE / DIFFERENT)
 *   2. Winner Probability
 *   3. Winner Margin
 *
 * Gap pp is deliberately NOT an input. It stays a research/display number: it
 * measures distance to a key we only know in benchmark mode, so it cannot
 * carry over to production, where there is no Ground Truth to measure against.
 */

import { RELATION } from './key-relation.js'


/** Confidence guard. Both must hold for an EXACT match to PASS. */
export const MIN_WINNER_PROBABILITY = 0.45
export const MIN_WINNER_MARGIN_PP = 25


export const QC_STATUS = Object.freeze({
  PASS: 'PASS',
  QUICK_REVIEW: 'QUICK REVIEW',
  MANUAL_REVIEW: 'MANUAL REVIEW',
})


/** Does the winner clear the confidence guard? */
export function passesConfidenceGuard({ winnerProbability, winnerMarginPp }) {

  return typeof winnerProbability === 'number'
    && Number.isFinite(winnerProbability)
    && winnerProbability >= MIN_WINNER_PROBABILITY
    && typeof winnerMarginPp === 'number'
    && Number.isFinite(winnerMarginPp)
    && winnerMarginPp >= MIN_WINNER_MARGIN_PP
}


/**
 * Decide the QC status of one analysis.
 *
 *   PASS           EXACT and past the confidence guard
 *   QUICK REVIEW   EXACT but under the guard, or RELATIVE (any confidence)
 *   MANUAL REVIEW  DIFFERENT
 *
 * A missing Winner Margin (an engine that returned a single candidate) fails
 * the guard rather than being assumed good.
 */
export function qcStatusFor({ relation, winnerProbability, winnerMarginPp }) {

  if (relation === RELATION.DIFFERENT) {
    return QC_STATUS.MANUAL_REVIEW
  }

  if (relation === RELATION.RELATIVE) {
    return QC_STATUS.QUICK_REVIEW
  }

  return passesConfidenceGuard({ winnerProbability, winnerMarginPp })
    ? QC_STATUS.PASS
    : QC_STATUS.QUICK_REVIEW
}
