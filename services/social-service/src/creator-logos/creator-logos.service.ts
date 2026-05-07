import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisClientProvider } from '../redis/redis-client.provider';
import { JsonCache } from '../redis/caches/json-cache';
import { GrpcClientsService } from '../grpc/grpc-clients.service';
import type { CreatorLogoDto } from './dto/creator-logo.dto';

interface CachedLogos {
  logos: Array<{
    id: string;
    imageUrl: string;
    sortOrder: number;
    creatorId: string | null;
  }>;
}

const CACHE_TTL = 300; // 5 minutes
const CACHE_ID = "active"; // singleton list — single id under the prefix

@Injectable()
export class CreatorLogosService {
  private readonly logger = new Logger(CreatorLogosService.name);
  private readonly logosCache: JsonCache<CachedLogos>;

  constructor(
    private readonly prisma: PrismaService,
    redis: RedisClientProvider,
    private readonly grpcClients: GrpcClientsService,
  ) {
    this.logosCache = new JsonCache<CachedLogos>(redis, {
      keyPrefix: "social:creator-logos",
      ttlSeconds: CACHE_TTL,
    });
  }

  async getActiveLogos(userId: string): Promise<CreatorLogoDto[]> {
    const wrapper = await this.logosCache.getOrCompute(CACHE_ID, async () => ({
      logos: await this.prisma.creatorLogo.findMany({
        where: { active: true },
        orderBy: { sortOrder: "asc" },
        select: { id: true, imageUrl: true, sortOrder: true, creatorId: true },
      }),
    }));
    const logos = wrapper?.logos ?? [];

    if (logos.length === 0) return [];

    // Batch fetch rating aggregates + user's ratings + creator profiles
    const logoIds = logos.map((l) => l.id);
    const creatorIds = logos.map((l) => l.creatorId).filter((id): id is string => !!id);

    const [ratingAggs, userVotes, creatorProfiles] = await Promise.all([
      this.prisma.creatorLogoVote.groupBy({
        by: ['logoId'],
        where: { logoId: { in: logoIds } },
        _avg: { vote: true },
        _count: { id: true },
      }),
      this.prisma.creatorLogoVote.findMany({
        where: { userId, logoId: { in: logoIds } },
        select: { logoId: true, vote: true },
      }),
      creatorIds.length > 0
        ? this.grpcClients.getUsersBatch(creatorIds)
        : Promise.resolve([]),
    ]);

    // Build maps
    const ratingMap = new Map<string, { avg: number; count: number }>();
    for (const g of ratingAggs) {
      ratingMap.set(g.logoId, {
        avg: g._avg.vote ?? 0,
        count: g._count.id,
      });
    }
    const userVoteMap = new Map(userVotes.map((v) => [v.logoId, v.vote]));
    const creatorMap = new Map(
      creatorProfiles.map((u) => [
        u.id,
        {
          id: u.id,
          username: u.username,
          displayName: u.display_name || u.username,
          avatar: u.avatar || null,
        },
      ]),
    );

    return logos.map((logo) => {
      const agg = ratingMap.get(logo.id);
      return {
        id: logo.id,
        imageUrl: logo.imageUrl,
        sortOrder: logo.sortOrder,
        rating: agg ? Math.round(agg.avg * 10) / 10 : 0,
        ratingCount: agg?.count ?? 0,
        userRating: userVoteMap.get(logo.id) ?? null,
        creator: logo.creatorId ? creatorMap.get(logo.creatorId) ?? null : null,
      };
    });
  }

  async vote(userId: string, logoId: string, rating: number): Promise<void> {
    // Verify logo exists
    const logo = await this.prisma.creatorLogo.findUnique({
      where: { id: logoId },
    });
    if (!logo) throw new NotFoundException('Logo not found');

    await this.prisma.creatorLogoVote.upsert({
      where: { userId_logoId: { userId, logoId } },
      update: { vote: rating },
      create: { userId, logoId, vote: rating },
    });

    this.logger.log(`User ${userId} rated logo ${logoId} with ${rating}`);
  }

  async removeVote(userId: string, logoId: string): Promise<void> {
    await this.prisma.creatorLogoVote.deleteMany({
      where: { userId, logoId },
    });
  }

  async getVoters(
    logoId: string,
    voteType: number,
    page: number,
    limit: number,
  ): Promise<{ users: { id: string; username: string; displayName: string; avatar: string | null }[]; total: number }> {
    const [votes, total] = await Promise.all([
      this.prisma.creatorLogoVote.findMany({
        where: { logoId, vote: voteType },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: { userId: true },
      }),
      this.prisma.creatorLogoVote.count({
        where: { logoId, vote: voteType },
      }),
    ]);

    if (votes.length === 0) return { users: [], total };

    const userIds = votes.map((v) => v.userId);
    const grpcUsers = await this.grpcClients.getUsersBatch(userIds);

    return {
      users: grpcUsers.map((u) => ({
        id: u.id,
        username: u.username,
        displayName: u.display_name || u.username,
        avatar: u.avatar || null,
      })),
      total,
    };
  }
}
