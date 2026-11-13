import { Global, Module } from "@nestjs/common";
import { AnalyticsService } from "./analytics.service";

/**
 * Global so any controller/service can inject AnalyticsService without per-module
 * wiring. See analytics.service.ts for the call-path telemetry rationale.
 */
@Global()
@Module({
  providers: [AnalyticsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
