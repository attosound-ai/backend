import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Kafka, Consumer, EachMessagePayload } from 'kafkajs';
import { RedisService } from '../redis/redis.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class KafkaConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KafkaConsumer.name);
  private kafka: Kafka;
  private consumer: Consumer;

  constructor(
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit(): Promise<void> {
    const brokers = (process.env.KAFKA_BROKERS || 'localhost:9092').split(',');
    const useTls = process.env.KAFKA_USE_TLS === 'true';
    this.kafka = new Kafka({
      clientId: 'social-service',
      brokers,
      retry: {
        initialRetryTime: 300,
        retries: 5,
      },
      ...(useTls && {
        ssl: true,
        sasl: {
          mechanism: 'scram-sha-256' as const,
          username: process.env.KAFKA_SASL_USERNAME || '',
          password: process.env.KAFKA_SASL_PASSWORD || '',
        },
      }),
    });

    this.consumer = this.kafka.consumer({
      groupId: 'social-service-group',
    });

    await this.connect();
  }

  private async connect(): Promise<void> {
    try {
      await this.consumer.connect();
      this.logger.log('Kafka consumer connected');

      await this.consumer.subscribe({
        topics: ['user.created', 'content.published', 'message.sent'],
        fromBeginning: false,
      });

      await this.consumer.run({
        eachMessage: async (payload: EachMessagePayload) => {
          await this.handleMessage(payload);
        },
      });

      this.logger.log(
        'Kafka consumer subscribed to: user.created, content.published, message.sent',
      );
    } catch (error) {
      this.logger.error(`Failed to connect Kafka consumer: ${error.message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.consumer) {
      await this.consumer.disconnect();
      this.logger.log('Kafka consumer disconnected');
    }
  }

  private async handleMessage(payload: EachMessagePayload): Promise<void> {
    const { topic, message } = payload;

    if (!message.value) return;

    try {
      const data = JSON.parse(message.value.toString());
      this.logger.debug(`Received message on topic ${topic}`);

      switch (topic) {
        case 'user.created':
          await this.handleUserCreated(data);
          break;
        case 'content.published':
          await this.handleContentPublished(data);
          break;
        case 'message.sent':
          await this.handleMessageSent(data);
          break;
        default:
          this.logger.warn(`Unhandled topic: ${topic}`);
      }
    } catch (error) {
      this.logger.error(
        `Error processing message from ${topic}: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * user.created -> create default notification preferences (welcome notification)
   */
  private async handleUserCreated(data: {
    id?: string;
    user_id?: string;
    username: string;
  }): Promise<void> {
    const userId = data.id ?? data.user_id;
    this.logger.log(`Processing user.created for user ${userId}`);

    await this.prisma.notification.create({
      data: {
        recipientId: userId,
        type: 'welcome',
        actorId: 'system',
        referenceId: null,
        isRead: false,
      },
    });

    this.logger.log(`Welcome notification created for user ${data.user_id}`);
  }

  /**
   * content.published -> fan out to followers' feed caches
   */
  private async handleContentPublished(data: {
    content_id: string;
    author_id: string;
    created_at: string;
  }): Promise<void> {
    this.logger.log(
      `Processing content.published for content ${data.content_id} by ${data.author_id}`,
    );

    const timestamp = data.created_at
      ? new Date(data.created_at).getTime()
      : Date.now();

    // Get all followers of the author
    let followerIds = await this.redis.getFollowerIds(data.author_id);

    // If Redis cache is empty, fall back to DB
    if (followerIds.length === 0) {
      const follows = await this.prisma.follow.findMany({
        where: { followingId: data.author_id },
        select: { followerId: true },
      });
      followerIds = follows.map((f) => f.followerId);

      // Re-populate Redis cache
      for (const fid of followerIds) {
        await this.redis.addFollow(fid, data.author_id);
      }
    }

    // Also add to the author's own feed
    await this.redis.addToFeed(data.author_id, data.content_id, timestamp);

    // Fan out to all followers
    await this.redis.addToFeedBulk(followerIds, data.content_id, timestamp);

    this.logger.log(
      `Content ${data.content_id} fanned out to ${followerIds.length} followers`,
    );
  }

  /**
   * message.sent -> create notification for the recipient
   */
  private async handleMessageSent(data: {
    sender_id: string;
    recipient_id: string;
    message_id: string;
  }): Promise<void> {
    this.logger.log(
      `Processing message.sent from ${data.sender_id} to ${data.recipient_id}`,
    );

    await this.prisma.notification.create({
      data: {
        recipientId: data.recipient_id,
        type: 'message',
        actorId: data.sender_id,
        referenceId: data.message_id,
        isRead: false,
      },
    });

    this.logger.log(
      `Message notification created for user ${data.recipient_id}`,
    );
  }
}
