import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Kafka, Producer, Partitioners } from 'kafkajs';

@Injectable()
export class KafkaProducer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KafkaProducer.name);
  private kafka: Kafka;
  private producer: Producer;

  onModuleInit(): void {
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

    this.producer = this.kafka.producer({
      createPartitioner: Partitioners.DefaultPartitioner,
    });

    this.connect();
  }

  private async connect(): Promise<void> {
    try {
      await this.producer.connect();
      this.logger.log('Kafka producer connected');
    } catch (error) {
      this.logger.error(`Failed to connect Kafka producer: ${error.message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.producer) {
      await this.producer.disconnect();
      this.logger.log('Kafka producer disconnected');
    }
  }

  async send(topic: string, message: Record<string, any>): Promise<void> {
    try {
      await this.producer.send({
        topic,
        messages: [
          {
            key: message.id || undefined,
            value: JSON.stringify(message),
            timestamp: Date.now().toString(),
          },
        ],
      });
      this.logger.debug(`Message sent to topic ${topic}`);
    } catch (error) {
      this.logger.error(
        `Failed to send message to ${topic}: ${error.message}`,
      );
    }
  }

  async sendBatch(
    topic: string,
    messages: Record<string, any>[],
  ): Promise<void> {
    try {
      await this.producer.send({
        topic,
        messages: messages.map((msg) => ({
          key: msg.id || undefined,
          value: JSON.stringify(msg),
          timestamp: Date.now().toString(),
        })),
      });
      this.logger.debug(
        `Batch of ${messages.length} messages sent to topic ${topic}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to send batch to ${topic}: ${error.message}`,
      );
    }
  }
}
