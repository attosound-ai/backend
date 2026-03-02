import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Kafka, Producer } from "kafkajs";

@Injectable()
export class KafkaProducer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KafkaProducer.name);
  private producer: Producer;

  constructor(private readonly config: ConfigService) {
    const brokers =
      this.config.get<string[]>("kafka.brokers") ?? ["localhost:9092"];
    const useTls = this.config.get<boolean>("kafka.useTls") ?? false;
    const kafka = new Kafka({
      clientId: "telephony-service",
      brokers,
      ...(useTls && {
        ssl: true,
        sasl: {
          mechanism: "scram-sha-256" as const,
          username: this.config.get<string>("kafka.saslUsername") ?? "",
          password: this.config.get<string>("kafka.saslPassword") ?? "",
        },
      }),
    });
    this.producer = kafka.producer();
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.producer.connect();
      this.logger.log("Kafka producer connected");
    } catch (err) {
      this.logger.error("Kafka producer failed to connect: %s", err);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.producer.disconnect();
    this.logger.log("Kafka producer disconnected");
  }

  async publish(
    topic: string,
    payload: Record<string, unknown>,
    key?: string,
  ): Promise<void> {
    try {
      const messageKey =
        key ?? String(payload.callSid || payload.segmentId || "");
      await this.producer.send({
        topic,
        messages: [
          {
            key: messageKey,
            value: JSON.stringify({
              ...payload,
              eventType: topic,
              timestamp: new Date().toISOString(),
            }),
          },
        ],
      });
      this.logger.log("Published event to %s", topic);
    } catch (err) {
      this.logger.error("Failed to publish to %s: %s", topic, err);
      throw err;
    }
  }
}
