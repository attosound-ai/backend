import { Module } from "@nestjs/common";
import { InteractionsController } from "./interactions.controller";
import { InteractionsService } from "./interactions.service";
import { PushModule } from "../push/push.module";
import { PostSharesBackfill } from "./post-shares.backfill";

@Module({
  imports: [PushModule],
  controllers: [InteractionsController],
  providers: [InteractionsService, PostSharesBackfill],
  exports: [InteractionsService],
})
export class InteractionsModule {}
