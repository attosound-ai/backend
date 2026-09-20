import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import type {
  ExportOptions,
  ProjectSettings,
} from "./project-settings";
import { QueryDeepPartialEntity } from "typeorm/query-builder/QueryPartialEntity";
import { Project } from "../entities/project.entity";
import { TimelineClip } from "../entities/timeline-clip.entity";
import { AudioSegment } from "../entities/audio-segment.entity";
import { AudioStorageService } from "../media/audio-storage.service";
import { AudioProcessorService } from "./audio-processor.service";
import { AnalyticsService } from "../analytics/analytics.service";

/**
 * Mirror of the app's lane mixer rules (front laneMixer.computeLaneEffectiveVolume)
 * so the exported WAV matches the editor preview:
 *   1. muted lane        -> 0
 *   2. any lane soloed and this one is not -> 0
 *   3. otherwise         -> clipVolume * 10^(gainDb / 20), floored to 0 below -60 dB
 */
type LaneMix = { gainDb?: number; muted?: boolean; solo?: boolean };
const DB_MIN = -60;
const dbToLinear = (db: number): number => Math.pow(10, db / 20);
function mixVolume(
  clipVolume: number,
  lane: LaneMix | undefined,
  anySolo: boolean,
): number {
  if (lane?.muted) return 0;
  if (anySolo && !lane?.solo) return 0;
  const gainDb =
    typeof lane?.gainDb === "number" && Number.isFinite(lane.gainDb)
      ? lane.gainDb
      : 0;
  const effective = Math.max(0, clipVolume) * dbToLinear(gainDb);
  return effective < dbToLinear(DB_MIN) ? 0 : effective;
}
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";

/**
 * The project pipeline's real audio contract: 8 kHz mono PCM WAV. Twilio call
 * recordings arrive at this rate, `convertToWav` forces it, the waveform reader
 * assumes mono int16, and `concatFiles` exports with `-c copy`, which requires
 * every clip on a lane to share it. Imports MUST be normalised to it or exports
 * break. Named here so the contract is stated once instead of hardcoded.
 */
const TARGET_SAMPLE_RATE = 8000;

@Injectable()
export class ProjectsService {
  private readonly logger = new Logger(ProjectsService.name);

  constructor(
    @InjectRepository(Project)
    private readonly projectRepo: Repository<Project>,
    @InjectRepository(TimelineClip)
    private readonly clipRepo: Repository<TimelineClip>,
    @InjectRepository(AudioSegment)
    private readonly segmentRepo: Repository<AudioSegment>,
    private readonly storageService: AudioStorageService,
    private readonly audioProcessor: AudioProcessorService,
    private readonly analytics: AnalyticsService,
  ) {}

  async createProject(
    userId: string,
    name: string,
    description?: string,
  ): Promise<Project> {
    const project = this.projectRepo.create({
      userId,
      name,
      description: description ?? null,
    });
    const saved = await this.projectRepo.save(project);
    this.logger.log("Project created: id=%s user=%s", saved.id, userId);
    return saved;
  }

  async getProjectsForUser(
    userId: string,
  ): Promise<(Project & { segmentCount: number; totalDurationMs: number })[]> {
    const projects = await this.projectRepo.find({
      where: { userId },
      order: { updatedAt: "DESC" },
    });

    const results = await Promise.all(
      projects.map(async (project) => {
        const segments = await this.segmentRepo.find({
          where: { projectId: project.id },
          select: ["id", "durationMs"],
        });
        return {
          ...project,
          segmentCount: segments.length,
          totalDurationMs: segments.reduce(
            (sum, s) => sum + (s.durationMs || 0),
            0,
          ),
        };
      }),
    );

    return results;
  }

  async getProjectById(
    projectId: string,
    userId: string,
  ): Promise<{
    project: Project;
    segments: (AudioSegment & { downloadUrl: string })[];
    clips: TimelineClip[];
  }> {
    const project = await this.projectRepo.findOne({
      where: { id: projectId, userId },
    });
    if (!project) throw new NotFoundException("Project not found");

    const segments = await this.segmentRepo.find({
      where: { projectId },
      order: { createdAt: "ASC" },
    });

    const segmentsWithUrls = await Promise.all(
      segments.map(async (seg) => ({
        ...seg,
        downloadUrl: await this.storageService.getPresignedUrl(
          seg.storageBucket,
          seg.storageKey,
        ),
      })),
    );

    const clips = await this.clipRepo.find({
      where: { projectId },
      order: { order: "ASC" },
    });

    return { project, segments: segmentsWithUrls, clips };
  }

  async updateProject(
    projectId: string,
    userId: string,
    data: {
      name?: string;
      description?: string;
      status?: string;
      lanes?: Record<
        string,
        {
          name: string;
          color: string;
          muted?: boolean;
          solo?: boolean;
          gainDb?: number;
          pan?: number;
        }
      >;
      settings?: ProjectSettings;
    },
  ): Promise<Project> {
    // Ownership check first.
    const existing = await this.projectRepo.findOne({
      where: { id: projectId, userId },
    });
    if (!existing) throw new NotFoundException("Project not found");

    // Build the partial update payload. We go via `update()` (direct
    // UPDATE SQL) instead of `save()` because TypeORM's dirty tracking
    // for JSONB columns is unreliable — it sometimes fails to detect
    // mutations of an existing column value even when a fresh reference
    // is assigned. `update()` unconditionally emits the SQL.
    const patch: QueryDeepPartialEntity<Project> = {};
    if (data.name !== undefined) patch.name = data.name;
    if (data.description !== undefined) patch.description = data.description;
    if (data.status !== undefined) patch.status = data.status;
    if (data.lanes !== undefined) {
      patch.lanes = { ...data.lanes };
    }
    if (data.settings !== undefined) {
      // Merge so the app can send one section (master, exportPrefs) at a time.
      patch.settings = { ...(existing.settings ?? {}), ...data.settings };
    }

    if (Object.keys(patch).length > 0) {
      await this.projectRepo.update({ id: projectId, userId }, patch);
    }

    // Re-read to return the canonical persisted state.
    const fresh = await this.projectRepo.findOne({
      where: { id: projectId, userId },
    });
    return fresh!;
  }

  async deleteProject(projectId: string, userId: string): Promise<void> {
    const project = await this.projectRepo.findOne({
      where: { id: projectId, userId },
    });
    if (!project) throw new NotFoundException("Project not found");

    await this.projectRepo.remove(project);
    this.logger.log("Project deleted: id=%s user=%s", projectId, userId);
  }

  async assignSegmentToProject(
    segmentId: string,
    projectId: string,
    userId: string,
    laneIndex: number = 0,
    /**
     * Explicit timeline position for the auto-created clip, in ms. When the
     * client knows where the clip belongs (in-call recording: the playhead the
     * user was listening at), it sends this so the take lands where it was
     * performed. Undefined keeps the historical append-after-last-clip
     * behaviour, so older app builds are unaffected.
     */
    positionInTimeline?: number,
  ): Promise<AudioSegment> {
    const project = await this.projectRepo.findOne({
      where: { id: projectId, userId },
    });
    if (!project) throw new NotFoundException("Project not found");

    const segment = await this.segmentRepo.findOne({
      where: { id: segmentId },
    });
    if (!segment) throw new NotFoundException("Segment not found");

    segment.projectId = projectId;
    const saved = await this.segmentRepo.save(segment);

    // Dedup guard: only auto-create a timeline clip if no clip in this
    // project already references this segment. Without this guard,
    // repeated calls to addSegment (e.g. from the frontend's orphan
    // resolver after a cold start) would each append a duplicate clip,
    // and parallel calls would all see an empty lane and stack
    // duplicates at positionInTimeline=0.
    const existingForSegment = await this.clipRepo.count({
      where: { projectId, segmentId: segment.id },
    });
    if (existingForSegment > 0) {
      this.logger.log(
        "Segment %s already has a clip in project %s (count=%d); skipping auto-create",
        segmentId,
        projectId,
        existingForSegment,
      );
      return saved;
    }

    // Auto-create a timeline clip spanning the full segment on the
    // requested lane (default: lane 0).
    const existingClips = await this.clipRepo.find({
      where: { projectId },
      order: { order: "ASC" },
    });
    const laneClips = existingClips.filter(
      (c) => (c.laneIndex ?? 0) === laneIndex,
    );
    const lastLaneClip = laneClips[laneClips.length - 1];
    const nextOrder = existingClips.length;
    // Honour an explicit position when the client sent one (in-call recording
    // lands at the playhead it was performed over); otherwise append after the
    // last clip on this lane, as before.
    const appendPosition = lastLaneClip
      ? lastLaneClip.positionInTimeline +
        (lastLaneClip.endInSegment - lastLaneClip.startInSegment)
      : 0;
    const nextPosition =
      typeof positionInTimeline === "number" && positionInTimeline >= 0
        ? positionInTimeline
        : appendPosition;

    const clip = this.clipRepo.create({
      projectId,
      segmentId: segment.id,
      startInSegment: 0,
      endInSegment: segment.durationMs || 0,
      positionInTimeline: nextPosition,
      order: nextOrder,
      volume: 1.0,
      laneIndex,
    });
    await this.clipRepo.save(clip);

    this.logger.log(
      "Auto-created timeline clip for segment %s in project %s on lane %d",
      segmentId,
      projectId,
      laneIndex,
    );

    return saved;
  }

  async removeSegmentFromProject(
    segmentId: string,
    projectId: string,
    userId: string,
  ): Promise<void> {
    const project = await this.projectRepo.findOne({
      where: { id: projectId, userId },
    });
    if (!project) throw new NotFoundException("Project not found");

    const segment = await this.segmentRepo.findOne({
      where: { id: segmentId, projectId },
    });
    if (!segment) throw new NotFoundException("Segment not found in project");

    segment.projectId = null;
    await this.segmentRepo.save(segment);

    // Also remove any clips that reference this segment in this project
    await this.clipRepo.delete({ projectId, segmentId });
  }

  async getTimelineClips(
    projectId: string,
    userId: string,
  ): Promise<TimelineClip[]> {
    const project = await this.projectRepo.findOne({
      where: { id: projectId, userId },
    });
    if (!project) throw new NotFoundException("Project not found");

    return this.clipRepo.find({
      where: { projectId },
      order: { order: "ASC" },
    });
  }

  async saveTimelineClips(
    projectId: string,
    userId: string,
    clips: {
      segmentId: string;
      startInSegment: number;
      endInSegment: number;
      positionInTimeline: number;
      order: number;
      volume?: number;
      laneIndex?: number;
      sourceSegmentId?: string | null;
      effects?: Record<string, unknown> | null;
    }[],
  ): Promise<TimelineClip[]> {
    const project = await this.projectRepo.findOne({
      where: { id: projectId, userId },
    });
    if (!project) throw new NotFoundException("Project not found");

    // Replace all clips: delete existing, insert new
    await this.clipRepo.delete({ projectId });

    const entities = clips.map((clip) =>
      this.clipRepo.create({
        projectId,
        segmentId: clip.segmentId,
        startInSegment: clip.startInSegment,
        endInSegment: clip.endInSegment,
        positionInTimeline: clip.positionInTimeline,
        order: clip.order,
        volume: clip.volume ?? 1.0,
        laneIndex: clip.laneIndex ?? 0,
        sourceSegmentId: clip.sourceSegmentId ?? null,
        effects: clip.effects ?? null,
      }),
    );

    const saved = await this.clipRepo.save(entities);

    // Clean up orphaned segments: segments in this project with no remaining clips
    // A clip references TWO segments once effects are applied: `segmentId`
    // (the render it plays) and `sourceSegmentId` (the dry original it can be
    // reverted to / re-rendered from). Detaching the original here broke
    // "Remove effects" on the very next autosave.
    const referencedSegmentIds = [
      ...new Set(
        clips.flatMap((c) =>
          [c.segmentId, c.sourceSegmentId].filter(
            (id): id is string => typeof id === "string" && id.length > 0,
          ),
        ),
      ),
    ];
    const allSegments = await this.segmentRepo.find({
      where: { projectId },
      select: ["id"],
    });
    const orphanedIds = allSegments
      .filter((s) => !referencedSegmentIds.includes(s.id))
      .map((s) => s.id);

    if (orphanedIds.length > 0) {
      await this.segmentRepo
        .createQueryBuilder()
        .update()
        .set({ projectId: null })
        .whereInIds(orphanedIds)
        .execute();
      this.logger.log(
        "Orphaned segments detached: project=%s count=%d",
        projectId,
        orphanedIds.length,
      );
    }

    this.logger.log(
      "Timeline saved: project=%s clips=%d",
      projectId,
      saved.length,
    );
    return saved;
  }

  async getWaveformData(segmentId: string, samples: number): Promise<number[]> {
    return this.audioProcessor.generateWaveformData(segmentId, samples);
  }

  async exportProject(
    projectId: string,
    userId: string,
    options?: ExportOptions,
  ): Promise<{ downloadUrl: string; fileSizeBytes: number }> {
    const project = await this.projectRepo.findOne({
      where: { id: projectId, userId },
    });
    if (!project) throw new NotFoundException("Project not found");

    const clips = await this.clipRepo.find({
      where: { projectId },
      order: { order: "ASC" },
    });

    // Fold each lane's mixer state (gain dB, mute, solo) into the per clip
    // volume the ffmpeg graph applies. The editor preview already does exactly
    // this; before, the export only used the raw clip volume, so lowering a
    // lane's gain changed what the user heard while editing but not what got
    // posted ("still loud after I turned it down", Sep 2026).
    const lanes = (project.lanes ?? {}) as Record<string, LaneMix | undefined>;
    const anySolo = Object.values(lanes).some((l) => l?.solo === true);
    const mixed = clips.map((clip) => ({
      ...clip,
      volume: mixVolume(
        typeof clip.volume === "number" ? clip.volume : 1,
        lanes[String(clip.laneIndex ?? 0)],
        anySolo,
      ),
    }));

    const laneSummary = Object.entries(lanes).map(([idx, l]) => ({
      lane: Number(idx),
      gain_db: l?.gainDb ?? 0,
      muted: l?.muted === true,
      solo: l?.solo === true,
      clips: clips.filter((c) => String(c.laneIndex ?? 0) === idx).length,
    }));
    const silenced = mixed.filter((c) => c.volume === 0).length;
    this.logger.log(
      `Export mix ${projectId}: clips=${clips.length} anySolo=${anySolo} silenced=${silenced} lanes=${JSON.stringify(laneSummary)}`,
    );
    // Same shape as the app's project_export_mix_snapshot so intent (client)
    // and render (server) diff in one PostHog query by project_id.
    this.analytics.capture(userId, "backend_project_export_mix", {
      project_id: projectId,
      clip_count: clips.length,
      lanes: laneSummary,
      any_solo: anySolo,
      lanes_with_gain: laneSummary.filter((l) => l.gain_db !== 0).length,
      clips_non_unity_volume: clips.filter(
        (c) => typeof c.volume === "number" && c.volume !== 1,
      ).length,
      clips_silenced: silenced,
      effective_volumes: mixed.map((c) => Number(c.volume.toFixed(4))),
    });

    const settings = (project.settings ?? {}) as ProjectSettings;
    const exportOptions: ExportOptions = {
      ...(settings.exportPrefs ?? {}),
      ...(options ?? {}),
    };
    if (options && Object.keys(options).length > 0) {
      // Remember the exporter's picks for the next mixdown.
      await this.projectRepo.update(
        { id: projectId, userId },
        { settings: { ...settings, exportPrefs: exportOptions } },
      );
    }
    const result = await this.audioProcessor.exportProject(
      mixed,
      projectId,
      settings.master,
      exportOptions,
      settings.automation,
    );

    // Update project status
    project.status = "exported";
    await this.projectRepo.save(project);

    return result;
  }

  async uploadCover(
    projectId: string,
    userId: string,
    file: Express.Multer.File,
  ): Promise<{ coverKey: string }> {
    const project = await this.projectRepo.findOne({
      where: { id: projectId, userId },
    });
    if (!project) throw new NotFoundException("Project not found");
    const ext = file.mimetype === "image/png" ? "png" : "jpg";
    const coverKey = `exports/covers/${projectId}/${randomUUID()}.${ext}`;
    await this.storageService.upload(coverKey, file.buffer, file.mimetype);
    const settings = (project.settings ?? {}) as ProjectSettings;
    await this.projectRepo.update(
      { id: projectId, userId },
      {
        settings: {
          ...settings,
          exportPrefs: { ...(settings.exportPrefs ?? {}), coverKey },
        },
      },
    );
    return { coverKey };
  }

  async importAudioFile(
    projectId: string,
    userId: string,
    file: Express.Multer.File,
    laneIndex: number,
    /**
     * Explicit timeline position for the created clip, in ms. An in-call take
     * belongs at the playhead it was performed over; without this the clip is
     * appended after the last clip on the lane and the performance reads as
     * detached from the track it was sung against. Undefined keeps the append
     * behaviour, so older app builds are unaffected.
     */
    positionInTimeline?: number,
    /**
     * false = store the audio as a segment ONLY, no clip. Used by the
     * non-destructive effects flow: the client renders an effected copy of a
     * clip's audio and needs it as a segment it can point the EXISTING clip at,
     * not a second clip on the lane. Default true keeps the import behaviour.
     */
    createClip = true,
  ): Promise<TimelineClip | AudioSegment> {
    const project = await this.projectRepo.findOne({
      where: { id: projectId, userId },
    });
    if (!project) throw new NotFoundException("Project not found");

    // Write uploaded file to temp
    const tmpInput = join(
      tmpdir(),
      `import-${randomUUID()}-${file.originalname}`,
    );
    await fs.writeFile(tmpInput, file.buffer);

    try {
      // Normalise by PROBING THE BYTES, never by trusting the client's mime.
      // The old check (`mimetype === audio/wav`) let a 44.1 kHz stereo WAV through
      // untouched while the row below recorded sampleRate 8000. Since `concatFiles`
      // exports with `-c copy` (identical formats required across a lane), such an
      // import silently corrupted exports when mixed with 8 kHz mono call
      // recordings. It also meant `audio/vnd.wave` — the mime iOS actually sent for
      // a real user import — fell through to a full ffmpeg resample by accident
      // rather than by decision.
      const probe = await this.audioProcessor
        .probeAudio(tmpInput)
        .catch(() => null);
      const alreadyNormalised =
        probe !== null &&
        probe.sampleRate === TARGET_SAMPLE_RATE &&
        probe.channels === 1 &&
        probe.codecName.startsWith("pcm_");
      const wavPath = alreadyNormalised
        ? tmpInput
        : await this.audioProcessor.convertToWav(tmpInput);

      this.logger.log(
        "Import normalise: project=%s mime=%s probed=%s skipped_ffmpeg=%s",
        projectId,
        file.mimetype,
        probe
          ? `${probe.sampleRate}Hz/${probe.channels}ch/${probe.codecName}`
          : "probe_failed",
        alreadyNormalised,
      );

      // Duration from the NORMALISED file (what we actually store). Reuse the
      // probe we already ran when the file needed no conversion — ffprobe is a
      // PROCESS SPAWN, and on a cold container each one costs a meaningful slice
      // of the request. Measured Aug 3: with the client now sending an
      // already-normalised 1.2 MB file, the upload took 1.1 s and the SERVER took
      // 5.3 s, so the tail is the bottleneck and every avoidable spawn counts.
      const durationMs =
        alreadyNormalised && probe && probe.durationMs > 0
          ? probe.durationMs
          : await this.audioProcessor.getDurationMs(wavPath);

      // Upload to S3
      const wavBuffer = await fs.readFile(wavPath);
      const date = new Date().toISOString().slice(0, 10);
      const storageKey = `imports/${date}/${projectId}/${randomUUID()}.wav`;
      const bucket = "atto-audio-segments";

      await this.storageService.upload(storageKey, wavBuffer);

      // Create AudioSegment (no callId for imported audio)
      const segment = this.segmentRepo.create({
        callId: null,
        twilioStreamSid: null,
        segmentIndex: 0,
        track: "import",
        startMs: 0,
        endMs: durationMs,
        durationMs,
        format: "wav",
        // Record what was ACTUALLY stored. After the probe-then-convert above this
        // is always the target rate, but hardcoding it was how the mismatch that
        // corrupted exports stayed invisible.
        sampleRate: alreadyNormalised
          ? (probe?.sampleRate ?? TARGET_SAMPLE_RATE)
          : TARGET_SAMPLE_RATE,
        fileSizeBytes: wavBuffer.length,
        storageBucket: bucket,
        storageKey,
        label: file.originalname.slice(0, 100),
        projectId,
      });
      const savedSegment = await this.segmentRepo.save(segment);

      if (!createClip) {
        this.logger.log(
          "Segment stored (no clip): project=%s segment=%s duration=%dms",
          projectId,
          savedSegment.id,
          durationMs,
        );
        return savedSegment;
      }

      // Create TimelineClip on specified lane
      const existingClips = await this.clipRepo.find({
        where: { projectId },
        order: { order: "ASC" },
      });

      // Find position on the target lane. An explicit client position wins: an
      // in-call take belongs at the playhead it was performed over, not appended
      // after whatever else is on the lane.
      const laneClips = existingClips.filter((c) => c.laneIndex === laneIndex);
      const lastLaneClip = laneClips[laneClips.length - 1];
      const nextOrder = lastLaneClip ? lastLaneClip.order + 1 : 0;
      const appendPosition = lastLaneClip
        ? lastLaneClip.positionInTimeline +
          (lastLaneClip.endInSegment - lastLaneClip.startInSegment)
        : 0;
      const nextPosition =
        typeof positionInTimeline === "number" && positionInTimeline >= 0
          ? positionInTimeline
          : appendPosition;

      const clip = this.clipRepo.create({
        projectId,
        segmentId: savedSegment.id,
        startInSegment: 0,
        endInSegment: durationMs,
        positionInTimeline: nextPosition,
        order: nextOrder,
        volume: 1.0,
        laneIndex,
      });
      const savedClip = await this.clipRepo.save(clip);

      this.logger.log(
        "Audio imported: project=%s segment=%s lane=%d duration=%dms",
        projectId,
        savedSegment.id,
        laneIndex,
        durationMs,
      );

      return savedClip;
    } finally {
      await fs.unlink(tmpInput).catch(() => {});
    }
  }
}
