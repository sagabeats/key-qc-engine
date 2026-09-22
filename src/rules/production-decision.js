/**
 * Production QC — the staff-facing reading of one analysis.
 *
 * This module owns no rules of its own. The decision is qcStatusFor() from
 * qc-status.js, unchanged: the thresholds Benchmark V1 produced, applied to
 * the Producer Key instead of a Ground Truth. All this file adds is the
 * wording, so that an operator who does not read music theory still gets an
 * unambiguous instruction.
 *
 * The staff verdict is deliberately binary:
 *
 *   PASS   continue processing the track
 *   HOLD   do not continue until a reviewer has looked at it
 *
 * The HOLD kind (Quick / Manual) tells the reviewer how much work it is, not
 * the operator what to decide.
 */

import { RELATION, classifyRelation } from './key-relation.js'
import { QC_STATUS, qcStatusFor } from './qc-status.js'


export const VERDICT = Object.freeze({
  PASS: 'PASS',
  HOLD: 'HOLD',
})


/**
 * Why a track landed where it did, in one line an operator can act on.
 *
 * "confidence" is used here and only here. In every technical readout the
 * numbers keep their own names — Winner Probability and Winner Margin — and
 * are never relabelled as a single invented confidence score.
 */
const REASON = Object.freeze({
  EXACT_PASS: 'Producer Key matches the detected key',
  BELOW_THRESHOLD: 'Detection confidence is below QC threshold',
  RELATIVE: 'Relative key detected',
  DIFFERENT: 'Different key detected',
})


/** The action line under the verdict. */
const ACTION = Object.freeze({
  [QC_STATUS.PASS]: 'Key Verified',
  [QC_STATUS.QUICK_REVIEW]: 'Quick Review Required',
  [QC_STATUS.MANUAL_REVIEW]: 'Manual Review Required',
})


/**
 * Pick the reason sentence for a decided status.
 *
 * RELATIVE is reported as a relative key, never as a wrong key: the producer
 * and the engine named the same set of notes from two different tonics, which
 * is a thing a reviewer resolves in seconds.
 *
 * DIFFERENT says the two disagree. It does NOT say the producer is wrong —
 * the engine is the side under test, and only a human can settle it.
 */
function reasonFor(status, relation) {

  if (status === QC_STATUS.MANUAL_REVIEW) {
    return REASON.DIFFERENT
  }

  if (status === QC_STATUS.PASS) {
    return REASON.EXACT_PASS
  }

  // Quick Review: either a relative answer, or an exact one under the guard.
  return relation === RELATION.RELATIVE
    ? REASON.RELATIVE
    : REASON.BELOW_THRESHOLD
}


/**
 * Decide one production scan.
 *
 * Takes the Producer Key and the adapter's own analysis payload — the same
 * payload Benchmark Mode receives, read the same way — and returns everything
 * the production view puts on screen.
 *
 * Nothing here is persisted: a production scan lives in the page and nowhere
 * else. Benchmark data is research data and is written only by Benchmark Mode.
 */
export function decideProduction({ producerKey, analysis }) {

  const candidates = analysis?.candidates

  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error('Analysis failed')
  }

  const winner = candidates[0]
  const runnerUp = candidates[1] ?? null

  // Winner probability minus rank #2, in points — the same number the
  // benchmark record stores under winnerMarginPp.
  const winnerMarginPp = runnerUp === null
    ? null
    : (winner.probability - runnerUp.probability) * 100

  const relation = classifyRelation(producerKey, winner.key)

  const status = qcStatusFor({
    relation,
    winnerProbability: winner.probability,
    winnerMarginPp,
  })

  return {
    producerKey,
    detectedKey: winner.key,
    relation,
    status,
    verdict: status === QC_STATUS.PASS ? VERDICT.PASS : VERDICT.HOLD,
    action: ACTION[status],
    reason: reasonFor(status, relation),
    winnerProbability: winner.probability,
    winnerMarginPp,
    candidates,
  }
}
