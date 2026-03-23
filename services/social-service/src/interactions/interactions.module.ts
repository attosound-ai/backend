import { Module } from "@nestjs/common";
import { InteractionsController } from "./interactions.controller";
import { InteractionsService } from "./interactions.service";
import { PushModule } from "../push/push.module";

@Module({
  imports: [PushModule],
  controllers: [InteractionsController],
  providers: [InteractionsService],
  exports: [InteractionsService],
})
export class InteractionsModule {}
