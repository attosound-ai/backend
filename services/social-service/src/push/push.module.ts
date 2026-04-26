import { Module } from "@nestjs/common";
import { BadgeCalculator } from "./badge-calculator.service";
import { PushService } from "./push.service";

@Module({
  providers: [BadgeCalculator, PushService],
  exports: [BadgeCalculator, PushService],
})
export class PushModule {}
