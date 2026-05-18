/**
 * Live Photo / Motion Photo pair detection.
 *
 * An iPhone Live Photo is a `.heic` (or `.jpg`) + a sibling `.mov`
 * with the same stem (`IMG_8163.heic` + `IMG_8163.mov`). Android's
 * Motion Photos embed the MP4 inside the JPEG (we don't extract
 * those yet — pure-pair detection only for now).
 *
 * This service only does the matching half: given a list of files
 * in a folder, return the pair map. The ingest pipeline + meta
 * store track the pairing on each file so the timeline can play
 * the motion on hover.
 */
import path from 'node:path'

const STILL_EXTS = new Set(['.heic', '.heif', '.jpg', '.jpeg'])
const MOTION_EXTS = new Set(['.mov', '.mp4', '.m4v'])

/** Returns true if `filename` could be the still half of a pair. */
export function couldBeLiveStill(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase()
  return STILL_EXTS.has(ext)
}

/** Returns true if `filename` could be the motion half of a pair. */
export function couldBeLiveMotion(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase()
  return MOTION_EXTS.has(ext)
}

/**
 * Find a sibling motion file for the given still in the same dir.
 * `siblings` is the list of *other* filenames in the same folder.
 * Returns the matching sibling filename (e.g. `IMG_8163.mov`) or
 * null if there isn't one.
 *
 * Matching rule: same stem (case-insensitive), opposite extension
 * type. `IMG_8163.HEIC` matches `IMG_8163.mov` matches `IMG_8163.MOV`.
 */
export function findMotionFor(
  stillFilename: string,
  siblings: string[],
): string | null {
  if (!couldBeLiveStill(stillFilename)) return null
  const stem = path.basename(stillFilename, path.extname(stillFilename)).toLowerCase()
  for (const sib of siblings) {
    if (!couldBeLiveMotion(sib)) continue
    const sibStem = path.basename(sib, path.extname(sib)).toLowerCase()
    if (sibStem === stem) return sib
  }
  return null
}

/** Inverse — find the still for a motion file. */
export function findStillFor(
  motionFilename: string,
  siblings: string[],
): string | null {
  if (!couldBeLiveMotion(motionFilename)) return null
  const stem = path.basename(motionFilename, path.extname(motionFilename)).toLowerCase()
  for (const sib of siblings) {
    if (!couldBeLiveStill(sib)) continue
    const sibStem = path.basename(sib, path.extname(sib)).toLowerCase()
    if (sibStem === stem) return sib
  }
  return null
}
