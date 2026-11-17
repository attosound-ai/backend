/**
 * Tracks and length of a project as the editor shows them, for the project
 * list (Nov 17 2026).
 *
 * The list only had `segmentCount` (every uploaded recording, including the
 * effect renders and the ones no clip uses any more) and `totalDurationMs`
 * (the SUM of those recordings). A Samsung showed a 6 track, 4:45 project as
 * "11 tracks, 11:14". The app fixed it on its side by fetching every project's
 * detail (front src/features/timeline/utils/timelineSummary.ts); these are the
 * same numbers, computed here from the clips so the list carries them.
 *
 * Same rules as the app, keep them in sync:
 *   - laneCount: lane 0 up to the highest lane with a clip, the empty lanes in
 *     between included (the editor draws them), at least 1 (an empty project
 *     opens with one lane). A missing or negative lane reads as lane 0.
 *   - timelineDurationMs: the latest clip end, positionInTimeline +
 *     (endInSegment - startInSegment), never the sum (parallel or overlapping
 *     clips play at the same time). 0 without clips, never negative.
 *
 * Both are aggregated in ONE grouped query over the clips of all the listed
 * projects (no query per project). `segmentCount` and `totalDurationMs` stay
 * as they were so the app versions already published keep working.
 */

/** One row of the grouped clip query (Postgres returns bigint as a string). */
export interface ClipAggregateRow {
  projectId: string;
  highestLane: string | number | null;
  endMs: string | number | null;
}

export interface TimelineSummary {
  laneCount: number;
  timelineDurationMs: number;
}

/** Highest lane with a clip; a null or negative lane is lane 0. */
export const HIGHEST_LANE_SQL = `MAX(GREATEST(COALESCE(clip."laneIndex", 0), 0))`;

/** Latest clip end in the timeline, in bigint so long projects cannot overflow int. */
export const LATEST_END_SQL = `MAX(clip."positionInTimeline"::bigint + clip."endInSegment" - clip."startInSegment")`;

function toFiniteNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Summary of one project from its aggregate row; no row means no clips. */
export function timelineSummaryFromRow(
  row: ClipAggregateRow | undefined,
): TimelineSummary {
  const highestLane = Math.max(0, Math.floor(toFiniteNumber(row?.highestLane)));
  const endMs = Math.max(0, toFiniteNumber(row?.endMs));
  return { laneCount: highestLane + 1, timelineDurationMs: endMs };
}
