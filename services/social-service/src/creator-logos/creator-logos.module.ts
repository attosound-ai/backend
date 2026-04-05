import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { RedisModule } from '../redis/redis.module';
import { CreatorLogosService } from './creator-logos.service';
import { CreatorLogosController } from './creator-logos.controller';

@Module({
  imports: [PrismaModule, RedisModule],
  controllers: [CreatorLogosController],
  providers: [CreatorLogosService],
})
export class CreatorLogosModule {}
