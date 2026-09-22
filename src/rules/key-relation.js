/**
 * Key naming, enharmonic normalization and the Ground Truth <-> Winner relation.
 *
 * This module owns the pitch-class table, so key comparison has exactly one
 * source of truth. Nothing here reads the model: the relation is derived from
 * two key names only, and never from any probability.
 */


/**
 * Pitch class of every spelling we might meet, so enharmonics compare equal.
 *
 * This matters in practice: S-KEY spells one pitch class "Bb", while the
 * habitual UI spelling is "A#". Without this table a Bb/A# Ground Truth would
 * be reported as "not found in candidate list".
 */
const PITCH_CLASS = {
  'c': 0, 'b#': 0,
  'c#': 1, 'db': 1,
  'd': 2,
  'd#': 3, 'eb': 3,
  'e': 4, 'fb': 4,
  'f': 5, 'e#': 5,
  'f#': 6, 'gb': 6,
  'g': 7,
  'g#': 8, 'ab': 8,
  'a': 9,
  'a#': 10, 'bb': 10,
  'b': 11, 'cb': 11,
}


/** Semitones from a minor tonic up to its relative major (A minor -> C Major). */
const MINOR_TO_RELATIVE_MAJOR = 3


export const RELATION = Object.freeze({
  EXACT: 'EXACT',
  RELATIVE: 'RELATIVE',
  DIFFERENT: 'DIFFERENT',
})


/** Spelling, whitespace and case cleanup shared by both readers below. */
function cleanKeyText(name) {

  return String(name ?? '')
    .replace(/♯/g, '#')
    .replace(/♭/g, 'b')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}


function modeOf(modeText) {

  return /^min(or)?$|^m$/.test(modeText)
    ? 'minor'
    : /^maj(or)?$/.test(modeText)
      ? 'major'
      : null
}


/**
 * Normalize a key name for comparison only.
 *
 * Resolves ♯/♭ spelling, enharmonic equivalents, whitespace, capitalization
 * and mode abbreviations down to a canonical "<pitchClass> <mode>" token.
 * Display strings are never normalized.
 *
 * Falls back to plain lowercasing for anything that does not parse, so an
 * unexpected label degrades to the old behaviour rather than throwing.
 */
export function normalizeKeyName(name) {

  const cleaned = cleanKeyText(name)

  const match = cleaned.match(/^([a-g][#b]?)\s*(.*)$/)

  if (match === null) {
    return cleaned
  }

  const pitchClass = PITCH_CLASS[match[1]]

  if (pitchClass === undefined) {
    return cleaned
  }

  const modeText = match[2]

  const mode = modeOf(modeText) ?? modeText

  return `${pitchClass} ${mode}`.trim()
}


/**
 * Read a key name as { pitchClass, mode }, or null when it is not a plain
 * major/minor key. Enharmonic spellings collapse to the same pitch class, so
 * "Bb minor" and "A# minor" parse identically.
 */
export function parseKeyName(name) {

  const match = cleanKeyText(name).match(/^([a-g][#b]?)\s*(.*)$/)

  if (match === null) {
    return null
  }

  const pitchClass = PITCH_CLASS[match[1]]
  const mode = modeOf(match[2])

  if (pitchClass === undefined || mode === null) {
    return null
  }

  return { pitchClass, mode }
}


/**
 * Classify Engine Winner against Ground Truth.
 *
 *   EXACT      same pitch class, same mode (enharmonics count as equal)
 *   RELATIVE   relative major/minor pair, in either direction
 *              (C Major <-> A minor, D# Major <-> C minor, ...)
 *   DIFFERENT  anything else
 *
 * A key name that is not a plain major/minor label cannot have a relative, so
 * it falls back to normalized equality and is otherwise DIFFERENT — the
 * conservative side, since DIFFERENT routes to MANUAL REVIEW.
 */
export function classifyRelation(groundTruth, winner) {

  const truth = parseKeyName(groundTruth)
  const engine = parseKeyName(winner)

  if (truth === null || engine === null) {

    return normalizeKeyName(groundTruth) === normalizeKeyName(winner)
      ? RELATION.EXACT
      : RELATION.DIFFERENT
  }

  if (truth.pitchClass === engine.pitchClass && truth.mode === engine.mode) {
    return RELATION.EXACT
  }

  if (truth.mode === engine.mode) {
    return RELATION.DIFFERENT
  }

  // One of the two is the minor side; its tonic + 3 semitones is the major.
  const [minor, major] = truth.mode === 'minor'
    ? [truth, engine]
    : [engine, truth]

  const relativeMajor =
    (minor.pitchClass + MINOR_TO_RELATIVE_MAJOR) % 12

  return relativeMajor === major.pitchClass
    ? RELATION.RELATIVE
    : RELATION.DIFFERENT
}
