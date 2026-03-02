import { Module } from "@nestjs/common";
import { WebhooksController } from "./webhooks.controller";
import { CallsModule } from "../calls/calls.module";
import { KafkaModule } from "../kafka/kafka.module";

@Module({
  imports: [CallsModule, KafkaModule],
  controllers: [WebhooksController],
})
export class WebhooksModule {}
