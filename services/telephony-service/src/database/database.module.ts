import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PhoneNumberAssignment } from '../entities/phone-number-assignment.entity';
import { Call } from '../entities/call.entity';
import { AudioSegment } from '../entities/audio-segment.entity';
import { ProvisionedNumber } from '../entities/provisioned-number.entity';
import { Project } from '../entities/project.entity';
import { TimelineClip } from '../entities/timeline-clip.entity';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        url: config.get<string>('database.url'),
        entities: [PhoneNumberAssignment, Call, AudioSegment, ProvisionedNumber, Project, TimelineClip],
        synchronize: true,
        logging: process.env.NODE_ENV !== 'production',
      }),
    }),
    TypeOrmModule.forFeature([PhoneNumberAssignment, Call, AudioSegment]),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}
