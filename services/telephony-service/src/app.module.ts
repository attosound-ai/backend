import { Module } from '@nestjs/common';
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
    NumbersModule,
    ProjectsModule,
  ],
})
export class AppModule {}
