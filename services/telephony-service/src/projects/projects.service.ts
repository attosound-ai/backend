import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Project } from "../entities/project.entity";
import { TimelineClip } from "../entities/timeline-clip.entity";
import { AudioSegment } from "../entities/audio-segment.entity";
import { AudioStorageService } from "../media/audio-storage.service";
import { AudioProcessorService } from "./audio-processor.service";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";

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
    data: { name?: string; description?: string; status?: string },
  ): Promise<Project> {
    const project = await this.projectRepo.findOne({
      where: { id: projectId, userId },
    });
    if (!project) throw new NotFoundException("Project not found");

    Object.assign(project, data);
    return this.projectRepo.save(project);
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

    // Auto-create a timeline clip spanning the full segment
    const existingClips = await this.clipRepo.find({
      where: { projectId },
      order: { order: "ASC" },
    });
    const lastClip = existingClips[existingClips.length - 1];
    const nextOrder = lastClip ? lastClip.order + 1 : 0;
    const nextPosition = lastClip
      ? lastClip.positionInTimeline +
        (lastClip.endInSegment - lastClip.startInSegment)
      : 0;

    const clip = this.clipRepo.create({
      projectId,
      segmentId: segment.id,
      startInSegment: 0,
      endInSegment: segment.durationMs || 0,
      positionInTimeline: nextPosition,
      order: nextOrder,
      volume: 1.0,
      laneIndex: 0,
    });
    await this.clipRepo.save(clip);

    this.logger.log(
      "Auto-created timeline clip for segment %s in project %s",
      segmentId,
      projectId,
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
      }),
    );

    const saved = await this.clipRepo.save(entities);

    // Clean up orphaned segments: segments in this project with no remaining clips
    const referencedSegmentIds = [
      ...new Set(clips.map((c) => c.segmentId)),
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
  ): Promise<{ downloadUrl: string; fileSizeBytes: number }> {
    const project = await this.projectRepo.findOne({
      where: { id: projectId, userId },
    });
    if (!project) throw new NotFoundException("Project not found");

    const clips = await this.clipRepo.find({
      where: { projectId },
      order: { order: "ASC" },
    });

    const result = await this.audioProcessor.exportProject(clips, projectId);

    // Update project status
    project.status = "exported";
    await this.projectRepo.save(project);

    return result;
  }

  async importAudioFile(
    projectId: string,
    userId: string,
    file: Express.Multer.File,
    laneIndex: number,
  ): Promise<TimelineClip> {
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
      // Convert to WAV if not already
      const isWav =
        file.mimetype === "audio/wav" || file.mimetype === "audio/x-wav";
      const wavPath = isWav
        ? tmpInput
        : await this.audioProcessor.convertToWav(tmpInput);

      // Get duration
      const durationMs = await this.audioProcessor.getDurationMs(wavPath);

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
        sampleRate: 8000,
        fileSizeBytes: wavBuffer.length,
        storageBucket: bucket,
        storageKey,
        label: file.originalname.slice(0, 100),
        projectId,
      });
      const savedSegment = await this.segmentRepo.save(segment);

      // Create TimelineClip on specified lane
      const existingClips = await this.clipRepo.find({
        where: { projectId },
        order: { order: "ASC" },
      });

      // Find position on the target lane
      const laneClips = existingClips.filter((c) => c.laneIndex === laneIndex);
      const lastLaneClip = laneClips[laneClips.length - 1];
      const nextOrder = lastLaneClip ? lastLaneClip.order + 1 : 0;
      const nextPosition = lastLaneClip
        ? lastLaneClip.positionInTimeline +
          (lastLaneClip.endInSegment - lastLaneClip.startInSegment)
        : 0;

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
