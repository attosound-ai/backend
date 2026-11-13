import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { In, Repository } from "typeorm";
import { Project } from "../entities/project.entity";
import { AudioSegment } from "../entities/audio-segment.entity";
import { Call } from "../entities/call.entity";
import { UsersClientService } from "../users-client/users-client.service";

/**
 * Who may touch a recording project and its audio segments.
 *
 * Nov 12 2026: adding a segment to a project only checked that the PROJECT
 * was the caller's; the segment was looked up by id alone and moved into the
 * caller's project, so anyone with a segment id could pull another user's
 * call recording into their own project and export it. Saving the timeline
 * accepted clips pointing at any segment id (the export then mixed that
 * audio), and the waveform routes answered for any segment with no session.
 *
 * The rule now:
 *  - a project is reachable by its owner, or by an account in the owner's
 *    linked group (the representative and the managed creators they run,
 *    the same group telephony already rings together, from user-service
 *    /users/:id/linked-account-ids);
 *  - a call recording (segment with a callId) is reachable when the call
 *    belongs to a reachable owner, wherever the segment sits now;
 *  - an import or effects render (no callId) is reachable when the project
 *    it sits in, or the project its storage key was uploaded under, is
 *    reachable. The storage key matters because saving the
 *    timeline detaches segments no clip uses (projectId null); an undo that
 *    brings the clip back must still be allowed.
 *  - anything else answers exactly like a missing row: 404, so a foreign id
 *    never reveals that it exists.
 *
 * The linked group is only fetched when the direct owner check fails, so the
 * normal path costs no call to user-service. That lookup is fail soft (it
 * returns just the caller), which can only deny, never grant.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/**
 * Project id an import or effects render was uploaded under, read from its
 * storage key `imports/<date>/<projectId>/<uuid>.wav` (see importAudioFile).
 */
export function importProjectIdFromKey(storageKey: string | null | undefined): string | null {
  if (typeof storageKey !== "string") return null;
  const parts = storageKey.split("/");
  if (parts.length < 4 || parts[0] !== "imports") return null;
  return isUuid(parts[2]) ? parts[2] : null;
}

@Injectable()
export class ProjectAccessService {
  constructor(
    @InjectRepository(Project)
    private readonly projectRepo: Repository<Project>,
    @InjectRepository(AudioSegment)
    private readonly segmentRepo: Repository<AudioSegment>,
    @InjectRepository(Call)
    private readonly callRepo: Repository<Call>,
    private readonly usersClient: UsersClientService,
  ) {}

  /** The caller plus every account in their linked group. */
  private async linkedOwners(userId: string): Promise<Set<string>> {
    const ids = await this.usersClient.getLinkedAccountIds(userId);
    const set = new Set(ids.map((id) => String(id)));
    set.add(String(userId));
    return set;
  }

  /** Lazily built owner check: direct match first, linked group only if needed. */
  private ownerCheck(userId: string): (ownerId: string | null | undefined) => Promise<boolean> {
    let linked: Promise<Set<string>> | null = null;
    return async (ownerId) => {
      if (ownerId === null || ownerId === undefined || ownerId === "") return false;
      if (String(ownerId) === String(userId)) return true;
      linked ??= this.linkedOwners(userId);
      return (await linked).has(String(ownerId));
    };
  }

  /** The project, or 404 when it does not exist or the caller may not reach it. */
  async requireProject(projectId: string, userId: string): Promise<Project> {
    if (!isUuid(projectId)) throw new NotFoundException("Project not found");
    const project = await this.projectRepo.findOne({ where: { id: projectId } });
    if (!project) throw new NotFoundException("Project not found");
    if (!(await this.ownerCheck(userId)(project.userId))) {
      throw new NotFoundException("Project not found");
    }
    return project;
  }

  /**
   * Of the given segments, the ids the caller may NOT reach. Missing ids are
   * left out (the caller decides how to treat them).
   */
  async foreignSegmentIds(segments: AudioSegment[], userId: string): Promise<string[]> {
    if (segments.length === 0) return [];
    const isOwner = this.ownerCheck(userId);

    const projectIds = new Set<string>();
    const callIds = new Set<string>();
    for (const s of segments) {
      if (s.projectId) projectIds.add(s.projectId);
      const fromKey = importProjectIdFromKey(s.storageKey);
      if (fromKey) projectIds.add(fromKey);
      if (s.callId) callIds.add(s.callId);
    }

    const projectOwner = new Map<string, string>();
    if (projectIds.size > 0) {
      const rows = await this.projectRepo.find({
        where: { id: In([...projectIds]) },
        select: ["id", "userId"],
      });
      for (const p of rows) projectOwner.set(p.id, p.userId);
    }
    const callOwner = new Map<string, string>();
    if (callIds.size > 0) {
      const rows = await this.callRepo.find({
        where: { id: In([...callIds]) },
        select: ["id", "userId"],
      });
      for (const c of rows) callOwner.set(c.id, c.userId);
    }

    const foreign: string[] = [];
    for (const s of segments) {
      // A call recording belongs to whoever owns the call, wherever it sits
      // now: that also cuts off recordings pulled into a foreign project
      // through the old hole. Imports and renders have no call; they belong
      // to the project they sit in or were uploaded under.
      const owners = s.callId
        ? [callOwner.get(s.callId)]
        : [
            s.projectId ? projectOwner.get(s.projectId) : undefined,
            (() => {
              const k = importProjectIdFromKey(s.storageKey);
              return k ? projectOwner.get(k) : undefined;
            })(),
          ];
      let ok = false;
      for (const o of owners) {
        if (await isOwner(o)) {
          ok = true;
          break;
        }
      }
      if (!ok) foreign.push(s.id);
    }
    return foreign;
  }

  /** The segment, or 404 when it does not exist or the caller may not reach it. */
  async requireSegment(segmentId: string, userId: string): Promise<AudioSegment> {
    if (!isUuid(segmentId)) throw new NotFoundException("Segment not found");
    const segment = await this.segmentRepo.findOne({ where: { id: segmentId } });
    if (!segment) throw new NotFoundException("Segment not found");
    const foreign = await this.foreignSegmentIds([segment], userId);
    if (foreign.length > 0) throw new NotFoundException("Segment not found");
    return segment;
  }

  /**
   * Every id must be either missing (kept as before: a clip pointing at a
   * row that no longer exists leaks nothing and must not wedge autosave) or
   * reachable. One foreign id fails the whole request with 404.
   */
  async assertSegmentsReachable(segmentIds: string[], userId: string): Promise<void> {
    const ids = [...new Set(segmentIds.filter((id) => typeof id === "string" && id.length > 0))];
    if (ids.length === 0) return;
    // A non uuid id cannot be stored in the uuid columns anyway.
    if (ids.some((id) => !isUuid(id))) throw new NotFoundException("Segment not found");
    const rows = await this.segmentRepo.find({ where: { id: In(ids) } });
    const foreign = await this.foreignSegmentIds(rows, userId);
    if (foreign.length > 0) throw new NotFoundException("Segment not found");
  }
}
