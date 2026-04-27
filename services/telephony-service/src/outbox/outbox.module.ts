import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ConfigModule } from "@nestjs/config";
import { OutboxEvent } from "../entities/outbox-event.entity";
import { OutboxService } from "./outbox.service";
import { OutboxPublisherService } from "./outbox-publisher.service";

@Module({
  imports: [TypeOrmModule.forFeature([OutboxEvent]), ConfigModule],
  providers: [OutboxService, OutboxPublisherService],
  exports: [OutboxService],
})
export class OutboxModule {}
