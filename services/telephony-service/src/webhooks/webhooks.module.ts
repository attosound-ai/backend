import { Module } from "@nestjs/common";
import { WebhooksController } from "./webhooks.controller";
import { CallsModule } from "../calls/calls.module";
import { KafkaModule } from "../kafka/kafka.module";
import { UsersClientModule } from "../users-client/users-client.module";
import { PushModule } from "../push/push.module";

@Module({
  imports: [CallsModule, KafkaModule, UsersClientModule, PushModule],
  controllers: [WebhooksController],
})
export class WebhooksModule {}
