import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import configuration from "./config/configuration";
import { DatabaseModule } from "./database/database.module";
import { WebhooksModule } from "./webhooks/webhooks.module";
import { TokensModule } from "./tokens/tokens.module";
import { CallsModule } from "./calls/calls.module";
import { MediaModule } from "./media/media.module";
import { KafkaModule } from "./kafka/kafka.module";
import { NumbersModule } from "./numbers/numbers.module";
import { ProjectsModule } from "./projects/projects.module";
import { CacheModule } from "./cache/cache.module";
import { OutboxModule } from "./outbox/outbox.module";
import { AnalyticsModule } from "./analytics/analytics.module";
import { SignupScopeMiddleware } from "./common/signup-scope.middleware";
import { JwtUserIdMiddleware } from "./common/jwt-user-id.middleware";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    AnalyticsModule,
    CacheModule,
    DatabaseModule,
    WebhooksModule,
    TokensModule,
    CallsModule,
    MediaModule,
    KafkaModule,
    OutboxModule,
    NumbersModule,
    ProjectsModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // ORDER MATTERS: JwtUserIdMiddleware runs FIRST so it can drop any
    // client-supplied X-User-ID before SignupScopeMiddleware (which only
    // checks scope) or any downstream controller can read it. Closes the
    // Bug #6 impersonation vector at the in-service edge — Kong also
    // strips inbound X-User-ID, so this is defense in depth.
    consumer
      .apply(JwtUserIdMiddleware)
      .forRoutes({ path: "*", method: RequestMethod.ALL })
      .apply(SignupScopeMiddleware)
      .forRoutes({ path: "*", method: RequestMethod.ALL });
  }
}
