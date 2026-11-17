import { randomUUID } from "crypto";
import { DataSource, type Repository } from "typeorm";
import { ProjectsService, type ProjectListItem } from "./projects.service";
import { Project } from "../entities/project.entity";
import { TimelineClip } from "../entities/timeline-clip.entity";
import { AudioSegment } from "../entities/audio-segment.entity";
import { Call } from "../entities/call.entity";
import type { AudioStorageService } from "../media/audio-storage.service";
import type { AudioProcessorService } from "./audio-processor.service";
import type { AnalyticsService } from "../analytics/analytics.service";
import type { ProjectAccessService } from "./project-access";

/**
 * The project list against a real Postgres, so the grouped SQL itself is
 * checked with the same cases as the app's timelineSummary tests (front
 * src/features/timeline/utils/__tests__/timelineSummary.test.ts). Runs where
 * the test machine provides Postgres (PRUEBAS_CON_POSTGRES=1, PG* variables)
 * in a throwaway schema; skipped elsewhere.
 */
const withPostgres = process.env.PRUEBAS_CON_POSTGRES === "1";
const describeDb = withPostgres ? describe : describe.skip;

/** [lane, atMs, lengthMs, fromMs?]: a clip of lengthMs on `lane` starting at atMs. */
type ClipSpec = [number, number, number, number?];

describeDb("project list counts against Postgres", () => {
  const schema = `conteo_pistas_${process.pid}_${Date.now()}`;
  let ds: DataSource;
  let projects: Repository<Project>;
  let segments: Repository<AudioSegment>;
  let clips: Repository<TimelineClip>;
  let service: ProjectsService;

  beforeAll(async () => {
    ds = new DataSource({
      type: "postgres",
      host: process.env.PGHOST,
      port: Number(process.env.PGPORT || 5432),
      username: process.env.PGUSER,
      password: process.env.PGPASSWORD,
      database: process.env.PGDATABASE,
      schema,
      entities: [Project, TimelineClip, AudioSegment, Call],
      synchronize: false,
    });
    await ds.initialize();
    await ds.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await ds.synchronize();
    projects = ds.getRepository(Project);
    segments = ds.getRepository(AudioSegment);
    clips = ds.getRepository(TimelineClip);
    service = new ProjectsService(
      projects,
      clips,
      segments,
      {} as AudioStorageService,
      {} as AudioProcessorService,
      {} as AnalyticsService,
      {} as ProjectAccessService,
    );
  }, 60_000);

  afterAll(async () => {
    if (!ds?.isInitialized) return;
    await ds.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await ds.destroy();
  });

  /**
   * A project of a fresh user with one recording per clip, plus `extraSegments`
   * recordings no clip uses (effect renders, discarded takes).
   */
  async function listOne(
    specs: ClipSpec[],
    extraSegments: number[] = [],
  ): Promise<ProjectListItem> {
    const userId = randomUUID();
    const project = await projects.save(projects.create({ userId, name: "P" }));
    let index = 0;
    const addSegment = (durationMs: number) =>
      segments.save(
        segments.create({
          projectId: project.id,
          segmentIndex: index++,
          startMs: 0,
          endMs: durationMs,
          durationMs,
          storageBucket: "test",
          storageKey: `test/${project.id}/${index}`,
        }),
      );
    for (const [i, [lane, atMs, lengthMs, fromMs = 0]] of specs.entries()) {
      const segment = await addSegment(fromMs + lengthMs);
      await clips.save(
        clips.create({
          projectId: project.id,
          segmentId: segment.id,
          startInSegment: fromMs,
          endInSegment: fromMs + lengthMs,
          positionInTimeline: atMs,
          order: i,
          laneIndex: lane,
        }),
      );
    }
    for (const durationMs of extraSegments) await addSegment(durationMs);

    const list = await service.getProjectsForUser(userId);
    expect(list).toHaveLength(1);
    return list[0];
  }

  const summary = (p: ProjectListItem) => ({
    laneCount: p.laneCount,
    timelineDurationMs: p.timelineDurationMs,
  });

  it("empty project: one lane, like the editor shows it, and 0 ms", async () => {
    const p = await listOne([]);
    expect(summary(p)).toEqual({ laneCount: 1, timelineDurationMs: 0 });
    expect(p.segmentCount).toBe(0);
    expect(p.totalDurationMs).toBe(0);
  });

  it("several clips on one lane count as one lane", async () => {
    const p = await listOne([
      [0, 0, 10_000],
      [0, 10_000, 5_000],
      [0, 20_000, 1_000],
    ]);
    expect(summary(p)).toEqual({ laneCount: 1, timelineDurationMs: 21_000 });
  });

  it("the length is the latest end, not the sum of the clips", async () => {
    const p = await listOne([
      [0, 0, 60_000],
      [1, 0, 60_000],
      [2, 0, 60_000],
    ]);
    expect(summary(p)).toEqual({ laneCount: 3, timelineDurationMs: 60_000 });
  });

  it("overlapping clips: the one that ends last wins even if it starts earlier", async () => {
    const p = await listOne([
      [0, 0, 30_000],
      [0, 5_000, 10_000],
      [1, 2_000, 40_000],
    ]);
    expect(p.timelineDurationMs).toBe(42_000);
    const q = await listOne([
      [0, 0, 100_000],
      [1, 50_000, 10_000],
    ]);
    expect(q.timelineDurationMs).toBe(100_000);
  });

  it("an empty lane in between counts, because the editor draws it", async () => {
    const p = await listOne([
      [0, 0, 1_000],
      [2, 0, 1_000],
    ]);
    expect(p.laneCount).toBe(3);
    const q = await listOne([[3, 0, 1_000]]);
    expect(q.laneCount).toBe(4);
  });

  it("offset in the timeline and trim inside the recording", async () => {
    // Starts at 2:00 and uses 0:10 to 0:40 of its recording: ends at 2:30.
    const p = await listOne([[0, 120_000, 30_000, 10_000]]);
    expect(p.timelineDurationMs).toBe(150_000);
  });

  it("a negative lane reads as lane 0, like the editor", async () => {
    const p = await listOne([
      [0, 0, 1_000],
      [-1, 0, 1_000],
    ]);
    expect(p.laneCount).toBe(1);
  });

  it("the Galaxy A16 case: 11 clips on 5 lanes lasting 4:45 give 5 lanes and 4:45", async () => {
    const p = await listOne(
      [
        [0, 0, 60_000],
        [0, 60_000, 60_000],
        [0, 120_000, 60_000],
        [1, 0, 90_000],
        [1, 100_000, 90_000],
        [2, 0, 285_312],
        [3, 30_000, 45_000],
        [3, 80_000, 45_000],
        [3, 130_000, 45_000],
        [4, 10_000, 20_000],
        [4, 200_000, 50_000],
      ],
      // An effect render and a discarded take nobody uses any more.
      [285_312, 40_000],
    );
    expect(summary(p)).toEqual({ laneCount: 5, timelineDurationMs: 285_312 });
    // The old fields keep their old meaning for the app versions out there.
    expect(p.segmentCount).toBe(13);
    expect(p.totalDurationMs).toBe(
      3 * 60_000 + 2 * 90_000 + 285_312 + 3 * 45_000 + 20_000 + 50_000 + 285_312 + 40_000,
    );
  });

  it("each project gets its own counts in a list of several", async () => {
    const userId = randomUUID();
    const make = async (name: string, specs: ClipSpec[]) => {
      const project = await projects.save(projects.create({ userId, name }));
      for (const [i, [lane, atMs, lengthMs]] of specs.entries()) {
        const segment = await segments.save(
          segments.create({
            projectId: project.id,
            segmentIndex: i,
            startMs: 0,
            endMs: lengthMs,
            durationMs: lengthMs,
            storageBucket: "test",
            storageKey: `test/${project.id}/${i}`,
          }),
        );
        await clips.save(
          clips.create({
            projectId: project.id,
            segmentId: segment.id,
            startInSegment: 0,
            endInSegment: lengthMs,
            positionInTimeline: atMs,
            order: i,
            laneIndex: lane,
          }),
        );
      }
      return project.id;
    };
    const a = await make("A", [[0, 0, 5_000]]);
    const b = await make("B", [
      [0, 0, 1_000],
      [3, 7_000, 2_000],
    ]);
    const c = await make("C", []);

    const byId = new Map(
      (await service.getProjectsForUser(userId)).map((p) => [p.id, summary(p)]),
    );
    expect(byId.get(a)).toEqual({ laneCount: 1, timelineDurationMs: 5_000 });
    expect(byId.get(b)).toEqual({ laneCount: 4, timelineDurationMs: 9_000 });
    expect(byId.get(c)).toEqual({ laneCount: 1, timelineDurationMs: 0 });
  });
});
