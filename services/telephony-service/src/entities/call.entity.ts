import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  Index,
} from 'typeorm';
import { AudioSegment } from './audio-segment.entity';

/**
 * A call record. Note the composite unique index on
 * (twilioCallSid, userId): a single Twilio call SID can be referenced
 * by multiple rows — one per participant (the caller and the
 * recipient for a VoIP call) — so each user-side of the call has its
 * own row, can own its own audio segments, and can be updated
 * independently. Uniqueness on twilioCallSid alone would be wrong
 * (only one side could exist), and no uniqueness at all allows
 * Twilio webhook retries to insert duplicate rows for the same
 * (call, user) pair.
 */
@Entity('calls')
@Index('UQ_calls_twilioCallSid_userId', ['twilioCallSid', 'userId'], {
  unique: true,
})
export class Call {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 34 })
  twilioCallSid: string;

  @Column({ type: 'varchar', length: 20 })
  fromNumber: string;

  @Column({ type: 'varchar', length: 20 })
  toNumber: string;

  @Column({ type: 'varchar', length: 64 })
  userId: string;

  @Column({ type: 'varchar', length: 10, default: 'inbound' })
  direction: string;

  @Column({ type: 'varchar', length: 20, default: 'ringing' })
  status: string;

  @Column({ type: 'timestamptz' })
  startedAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  answeredAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  endedAt: Date | null;

  @Column({ type: 'int', nullable: true })
  durationSeconds: number | null;

  @Column({ type: 'jsonb', default: '{}' })
  metadata: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @OneToMany(() => AudioSegment, (segment) => segment.call)
  segments: AudioSegment[];
}
