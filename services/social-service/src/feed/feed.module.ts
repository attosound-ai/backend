import { Module } from '@nestjs/common';
import { FeedController } from './feed.controller';
import { FeedService } from './feed.service';
import { FollowsModule } from '../follows/follows.module';
import { InteractionsModule } from '../interactions/interactions.module';

@Module({
  imports: [FollowsModule, InteractionsModule],
  controllers: [FeedController],
  providers: [FeedService],
  exports: [FeedService],
})
export class FeedModule {}
