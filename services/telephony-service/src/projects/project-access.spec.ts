import { Logger, NotFoundException } from "@nestjs/common";
import { FindOperator } from "typeorm";
import { ProjectsService } from "./projects.service";
import { ProjectAccessService, importProjectIdFromKey } from "./project-access";
import { SegmentsController } from "./segments.controller";
import { UsersClientService } from "../users-client/users-client.service";

/**
 * Nov 12 2026: a segment (a call recording) could be pulled into anyone's
 * project by id, timelines could point at any segment, and the waveform
 * routes answered with no session. These run the real ProjectsService on an
 * in memory store, so each case fails on the code before the fix.
 */

Logger.overrideLogger(false);

type Row = Record<string, unknown>;

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v instanceof FindOperator) {
      if (v.type === "in") return (v.value as unknown[]).includes(row[k]);
      throw new Error(`operator ${v.type} not faked`);
    }
    return row[k] === v;
  });
}

class FakeRepo {
  rows: Row[] = [];
  private seq = 0;
  constructor(private readonly prefix: string) {}
  create(data: Row): Row {
    return { ...data };
  }
  async findOne(opts: { where: Row }): Promise<Row | null> {
    const r = this.rows.find((row) => matches(row, opts.where));
    return r ? { ...r } : null;
  }
  async find(opts: { where?: Row } = {}): Promise<Row[]> {
    return this.rows.filter((row) => !opts.where || matches(row, opts.where)).map((r) => ({ ...r }));
  }
  async count(opts: { where: Row }): Promise<number> {
    return (await this.find(opts)).length;
  }
  async save(data: Row | Row[]): Promise<Row | Row[]> {
    const one = (d: Row): Row => {
      if (!d.id) d.id = `${this.prefix}-${++this.seq}`;
      const i = this.rows.findIndex((r) => r.id === d.id);
      if (i >= 0) this.rows[i] = { ...this.rows[i], ...d };
      else this.rows.push({ ...d });
      return d;
    };
    return Array.isArray(data) ? data.map(one) : one(data);
  }
  async update(where: Row, patch: Row): Promise<void> {
    for (const r of this.rows) if (matches(r, where)) Object.assign(r, patch);
  }
  async delete(where: Row): Promise<void> {
    this.rows = this.rows.filter((r) => !matches(r, where));
  }
  async remove(row: Row): Promise<void> {
    this.rows = this.rows.filter((r) => r.id !== row.id);
  }
}

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// Owner 10, attacker 20, representative 30 managing creator 31.
const P_OWNER = ID(1);
const P_ATTACKER = ID(2);
const P_CREATOR = ID(3);
const P_REP = ID(4);
const CALL_OWNER = ID(11);
const CALL_CREATOR = ID(13);
const SEG_OWNER_CALL = ID(21);
const SEG_OWNER_IMPORT_DETACHED = ID(22);
const SEG_CREATOR_CALL = ID(23);
const SEG_ATTACKER_CALL = ID(24);
const CALL_ATTACKER = ID(14);

function setup() {
  const projects = new FakeRepo("p");
  const clips = new FakeRepo("c");
  const segments = new FakeRepo("s");
  const calls = new FakeRepo("call");
  projects.rows.push(
    { id: P_OWNER, userId: "10", name: "mine", lanes: {}, settings: {} },
    { id: P_ATTACKER, userId: "20", name: "theirs", lanes: {}, settings: {} },
    { id: P_CREATOR, userId: "31", name: "creator", lanes: {}, settings: {} },
    { id: P_REP, userId: "30", name: "rep", lanes: {}, settings: {} },
  );
  calls.rows.push(
    { id: CALL_OWNER, userId: "10" },
    { id: CALL_CREATOR, userId: "31" },
    { id: CALL_ATTACKER, userId: "20" },
  );
  segments.rows.push(
    { id: SEG_OWNER_CALL, callId: CALL_OWNER, projectId: P_OWNER, durationMs: 1000, storageKey: "segments/a.wav", storageBucket: "b" },
    { id: SEG_OWNER_IMPORT_DETACHED, callId: null, projectId: null, durationMs: 500, storageKey: `imports/2026-11-12/${P_OWNER}/x.wav`, storageBucket: "b" },
    { id: SEG_CREATOR_CALL, callId: CALL_CREATOR, projectId: null, durationMs: 700, storageKey: "segments/c.wav", storageBucket: "b" },
    { id: SEG_ATTACKER_CALL, callId: CALL_ATTACKER, projectId: null, durationMs: 300, storageKey: "segments/d.wav", storageBucket: "b" },
  );

  const linked: Record<string, number[]> = { "30": [30, 31], "31": [30, 31] };
  const usersClient = {
    getLinkedAccountIds: jest.fn(async (uid: string) => linked[uid] ?? [Number(uid)]),
  } as unknown as UsersClientService;

  const access = new ProjectAccessService(
    projects as never,
    segments as never,
    calls as never,
    usersClient,
  );
  const storage = { getPresignedUrl: jest.fn(async () => "https://signed"), upload: jest.fn() };
  const audio = {
    generateWaveformData: jest.fn(async () => [0.1, 0.2]),
    exportProject: jest.fn(async () => ({ downloadUrl: "u", fileSizeBytes: 1 })),
  };
  const analytics = { capture: jest.fn() };
  const svc = new ProjectsService(
    projects as never,
    clips as never,
    segments as never,
    storage as never,
    audio as never,
    analytics as never,
    access,
  );
  return { svc, projects, clips, segments, audio, usersClient };
}

const clip = (segmentId: string, extra: Record<string, unknown> = {}) => ({
  segmentId,
  startInSegment: 0,
  endInSegment: 100,
  positionInTimeline: 0,
  order: 0,
  ...extra,
});

describe("segments of recording projects: owner checks", () => {
  it("adding someone else's segment to my project answers 404 and moves nothing", async () => {
    const { svc, segments, clips } = setup();
    await expect(svc.assignSegmentToProject(SEG_OWNER_CALL, P_ATTACKER, "20")).rejects.toBeInstanceOf(NotFoundException);
    expect(segments.rows.find((s) => s.id === SEG_OWNER_CALL)!.projectId).toBe(P_OWNER);
    expect(clips.rows).toHaveLength(0);
  });

  it("a foreign segment and a missing one give the same answer", async () => {
    const { svc } = setup();
    const foreign = await svc.assignSegmentToProject(SEG_OWNER_CALL, P_ATTACKER, "20").catch((e: Error) => e);
    const missing = await svc.assignSegmentToProject(ID(999), P_ATTACKER, "20").catch((e: Error) => e);
    expect(foreign).toBeInstanceOf(NotFoundException);
    expect(missing).toBeInstanceOf(NotFoundException);
    expect((foreign as NotFoundException).message).toBe((missing as NotFoundException).message);
  });

  it("a recording pulled into a foreign project earlier is still not theirs", async () => {
    const { svc, segments } = setup();
    // State the old hole left behind: the owner's call recording sits in the attacker's project.
    segments.rows.find((s) => s.id === SEG_OWNER_CALL)!.projectId = P_ATTACKER;
    await expect(svc.getWaveformData(SEG_OWNER_CALL, "20", 100)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.saveTimelineClips(P_ATTACKER, "20", [clip(SEG_OWNER_CALL)])).rejects.toBeInstanceOf(NotFoundException);
  });

  it("the owner can still add their own call recording", async () => {
    const { svc, clips } = setup();
    const seg = await svc.assignSegmentToProject(SEG_OWNER_CALL, P_OWNER, "10", 1, 250);
    expect(seg.projectId).toBe(P_OWNER);
    expect(clips.rows).toHaveLength(1);
    expect(clips.rows[0]).toMatchObject({ laneIndex: 1, positionInTimeline: 250 });
  });

  it("saving a timeline that points at a foreign segment answers 404 and keeps the old clips", async () => {
    const { svc, clips } = setup();
    clips.rows.push({ id: "old", projectId: P_ATTACKER, segmentId: SEG_ATTACKER_CALL });
    await expect(svc.saveTimelineClips(P_ATTACKER, "20", [clip(SEG_OWNER_CALL)])).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      svc.saveTimelineClips(P_ATTACKER, "20", [clip(SEG_ATTACKER_CALL, { sourceSegmentId: SEG_OWNER_CALL })]),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(clips.rows.map((c) => c.id)).toEqual(["old"]);
  });

  it("the owner's timeline may use a detached import (undo after autosave) and a missing id", async () => {
    const { svc } = setup();
    const saved = (await svc.saveTimelineClips(P_OWNER, "10", [
      clip(SEG_OWNER_CALL),
      clip(SEG_OWNER_IMPORT_DETACHED, { order: 1 }),
      clip(ID(998), { order: 2 }),
    ])) as unknown[];
    expect(saved).toHaveLength(3);
  });

  it("the waveform of a foreign segment answers 404 before the renderer runs", async () => {
    const { svc, audio } = setup();
    await expect(svc.getWaveformData(SEG_OWNER_CALL, "20", 100)).rejects.toBeInstanceOf(NotFoundException);
    expect(audio.generateWaveformData).not.toHaveBeenCalled();
    await expect(svc.getWaveformData(SEG_OWNER_CALL, "10", 100)).resolves.toEqual([0.1, 0.2]);
  });

  it("every project route answers 404 to a stranger", async () => {
    const { svc, projects, segments } = setup();
    const file = { buffer: Buffer.from("x"), mimetype: "image/png", originalname: "a.png" } as Express.Multer.File;
    const attempts: Array<() => Promise<unknown>> = [
      () => svc.getProjectById(P_OWNER, "20"),
      () => svc.updateProject(P_OWNER, "20", { name: "pwned" }),
      () => svc.deleteProject(P_OWNER, "20"),
      () => svc.removeSegmentFromProject(SEG_OWNER_CALL, P_OWNER, "20"),
      () => svc.getTimelineClips(P_OWNER, "20"),
      () => svc.saveTimelineClips(P_OWNER, "20", []),
      () => svc.exportProject(P_OWNER, "20"),
      () => svc.uploadCover(P_OWNER, "20", file),
      () => svc.importAudioFile(P_OWNER, "20", file, 0),
      () => svc.assignSegmentToProject(SEG_ATTACKER_CALL, P_OWNER, "20"),
    ];
    for (const attempt of attempts) {
      await expect(attempt()).rejects.toBeInstanceOf(NotFoundException);
    }
    expect(projects.rows.find((p) => p.id === P_OWNER)!.name).toBe("mine");
    expect(segments.rows.find((s) => s.id === SEG_OWNER_CALL)!.projectId).toBe(P_OWNER);
    // The list never shows other people's projects.
    expect((await svc.getProjectsForUser("20")).map((p) => p.id)).toEqual([P_ATTACKER]);
  });

  it("a malformed id answers 404, not a database error", async () => {
    const { svc } = setup();
    await expect(svc.getProjectById("not-a-uuid", "10")).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.getWaveformData("not-a-uuid", "10", 10)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("the representative can work on the creator's project with the creator's recording", async () => {
    const { svc, projects } = setup();
    await expect(svc.getProjectById(P_CREATOR, "30")).resolves.toMatchObject({ project: { id: P_CREATOR } });
    await svc.updateProject(P_CREATOR, "30", { name: "renamed by rep" });
    expect(projects.rows.find((p) => p.id === P_CREATOR)!.name).toBe("renamed by rep");
    await expect(svc.assignSegmentToProject(SEG_CREATOR_CALL, P_REP, "30")).resolves.toMatchObject({ projectId: P_REP });
  });

  it("the linked group is only asked for when the direct owner check fails", async () => {
    const { svc, usersClient } = setup();
    await svc.getProjectById(P_OWNER, "10");
    await svc.assignSegmentToProject(SEG_OWNER_CALL, P_OWNER, "10");
    expect(usersClient.getLinkedAccountIds).not.toHaveBeenCalled();
  });
});

describe("waveform routes need a session", () => {
  it("rejects a request with no verified user before touching the segment", async () => {
    const getWaveformData = jest.fn(async () => [1]);
    const ctrl = new SegmentsController({ getWaveformData } as never);
    await expect(ctrl.getWaveform(SEG_OWNER_CALL, 100, undefined, undefined, "", "")).rejects.toThrow("User ID not found");
    await expect(ctrl.getWaveformsBatch({ segmentIds: [SEG_OWNER_CALL] }, "", "")).rejects.toThrow("User ID not found");
    expect(getWaveformData).not.toHaveBeenCalled();
    await ctrl.getWaveform(SEG_OWNER_CALL, 100, undefined, undefined, "10", "");
    expect(getWaveformData).toHaveBeenCalledWith(SEG_OWNER_CALL, "10", 100, 0, 1);
  });
});

describe("importProjectIdFromKey", () => {
  it("reads the project of an import key and nothing else", () => {
    expect(importProjectIdFromKey(`imports/2026-11-12/${P_OWNER}/x.wav`)).toBe(P_OWNER);
    expect(importProjectIdFromKey("segments/2026/abc.wav")).toBeNull();
    expect(importProjectIdFromKey("imports/2026-11-12/not-a-uuid/x.wav")).toBeNull();
    expect(importProjectIdFromKey(null)).toBeNull();
  });
});
