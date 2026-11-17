import type { Repository } from "typeorm";
import { ProjectsService } from "./projects.service";
import { timelineSummaryFromRow } from "./timeline-summary";
import type { Project } from "../entities/project.entity";
import type { TimelineClip } from "../entities/timeline-clip.entity";
import type { AudioSegment } from "../entities/audio-segment.entity";
import type { AudioStorageService } from "../media/audio-storage.service";
import type { AudioProcessorService } from "./audio-processor.service";
import type { AnalyticsService } from "../analytics/analytics.service";
import type { ProjectAccessService } from "./project-access";

describe("timelineSummaryFromRow", () => {
  it("a project without clips has one lane and lasts 0 ms, like the editor shows it", () => {
    expect(timelineSummaryFromRow(undefined)).toEqual({
      laneCount: 1,
      timelineDurationMs: 0,
    });
  });

  it("reads the bigint strings Postgres returns", () => {
    expect(
      timelineSummaryFromRow({ projectId: "p", highestLane: "4", endMs: "285312" }),
    ).toEqual({ laneCount: 5, timelineDurationMs: 285312 });
  });

  it("never returns a negative or broken number", () => {
    expect(
      timelineSummaryFromRow({ projectId: "p", highestLane: -3, endMs: "-500" }),
    ).toEqual({ laneCount: 1, timelineDurationMs: 0 });
    expect(
      timelineSummaryFromRow({ projectId: "p", highestLane: "x", endMs: null }),
    ).toEqual({ laneCount: 1, timelineDurationMs: 0 });
  });
});

/** A chainable stand in for TypeORM's query builder that returns `rows`. */
function fakeQueryBuilder(rows: unknown[]) {
  const qb: Record<string, jest.Mock> = {};
  for (const m of ["select", "addSelect", "where", "groupBy"]) {
    qb[m] = jest.fn(() => qb);
  }
  qb.getRawMany = jest.fn(async () => rows);
  return qb;
}

function serviceWith(opts: {
  projects: Partial<Project>[];
  segmentRows: unknown[];
  clipRows: unknown[];
}) {
  const segmentQb = fakeQueryBuilder(opts.segmentRows);
  const clipQb = fakeQueryBuilder(opts.clipRows);
  const projectRepo = { find: jest.fn(async () => opts.projects) };
  const segmentRepo = {
    find: jest.fn(),
    createQueryBuilder: jest.fn(() => segmentQb),
  };
  const clipRepo = {
    find: jest.fn(),
    createQueryBuilder: jest.fn(() => clipQb),
  };
  const service = new ProjectsService(
    projectRepo as unknown as Repository<Project>,
    clipRepo as unknown as Repository<TimelineClip>,
    segmentRepo as unknown as Repository<AudioSegment>,
    {} as AudioStorageService,
    {} as AudioProcessorService,
    {} as AnalyticsService,
    {} as ProjectAccessService,
  );
  return { service, segmentRepo, clipRepo, clipQb };
}

describe("ProjectsService.getProjectsForUser", () => {
  it("one grouped clip query for the whole list, never one per project", async () => {
    const projects = Array.from({ length: 25 }, (_, i) => ({
      id: `p${i}`,
      name: `Project ${i}`,
    }));
    const { service, segmentRepo, clipRepo, clipQb } = serviceWith({
      projects,
      segmentRows: [],
      clipRows: [],
    });

    const list = await service.getProjectsForUser("u1");

    expect(list).toHaveLength(25);
    expect(clipRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
    expect(segmentRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
    expect(clipRepo.find).not.toHaveBeenCalled();
    expect(segmentRepo.find).not.toHaveBeenCalled();
    expect(clipQb.where).toHaveBeenCalledWith('clip."projectId" IN (:...ids)', {
      ids: projects.map((p) => p.id),
    });
  });

  it("keeps the old fields and adds the editor's numbers to each project", async () => {
    const { service } = serviceWith({
      projects: [
        { id: "a", name: "Galaxy A16" },
        { id: "b", name: "Empty" },
      ],
      // 11 uploads, effect renders and unused takes included, summing 11:14.
      segmentRows: [{ projectId: "a", segmentCount: "11", totalDurationMs: "674000" }],
      clipRows: [{ projectId: "a", highestLane: 4, endMs: "285312" }],
    });

    const [a, b] = await service.getProjectsForUser("u1");

    expect(a).toMatchObject({
      id: "a",
      segmentCount: 11,
      totalDurationMs: 674000,
      laneCount: 5,
      timelineDurationMs: 285312,
    });
    expect(b).toMatchObject({
      id: "b",
      segmentCount: 0,
      totalDurationMs: 0,
      laneCount: 1,
      timelineDurationMs: 0,
    });
  });

  it("no projects, no count queries", async () => {
    const { service, segmentRepo, clipRepo } = serviceWith({
      projects: [],
      segmentRows: [],
      clipRows: [],
    });
    expect(await service.getProjectsForUser("u1")).toEqual([]);
    expect(segmentRepo.createQueryBuilder).not.toHaveBeenCalled();
    expect(clipRepo.createQueryBuilder).not.toHaveBeenCalled();
  });
});
