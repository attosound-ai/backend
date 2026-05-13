import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from './config/configuration';
import { DatabaseModule } from './database/database.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { TokensModule } from './tokens/tokens.module';
import { CallsModule } from './calls/calls.module';
import { MediaModule } from './media/media.module';
import { KafkaModule } from './kafka/kafka.module';
import { NumbersModule } from './numbers/numbers.module';
import { ProjectsModule } from './projects/projects.module';
import { CacheModule } from './cache/cache.module';
import { OutboxModule } from './outbox/outbox.module';
import { SignupScopeMiddleware } from './common/signup-scope.middleware';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
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
    // Reject signup_pending tokens on every route. Twilio webhooks don't
    // carry Authorization headers so they pass through untouched.
    consumer
      .apply(SignupScopeMiddleware)
      .forRoutes({ path: '*', method: RequestMethod.ALL });
  }
}
