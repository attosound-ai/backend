import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CallsController } from './calls.controller';
import { CallsService } from './calls.service';
import { PhoneNumberAssignment } from '../entities/phone-number-assignment.entity';
import { Call } from '../entities/call.entity';
import { AudioSegment } from '../entities/audio-segment.entity';
import { MediaModule } from '../media/media.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([PhoneNumberAssignment, Call, AudioSegment]),
    MediaModule,
  ],
  controllers: [CallsController],
  providers: [CallsService],
  exports: [CallsService],
})
export class CallsModule {}
