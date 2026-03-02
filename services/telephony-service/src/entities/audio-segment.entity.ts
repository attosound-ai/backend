import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from "typeorm";
import { Call } from "./call.entity";
import { Project } from "./project.entity";

@Entity("audio_segments")
export class AudioSegment {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid", nullable: true })
  callId: string | null;

  @Column({ type: "varchar", length: 34, nullable: true })
  twilioStreamSid: string | null;

  @Column({ type: "int" })
  segmentIndex: number;

  @Column({ type: "varchar", length: 20, default: "both" })
  track: string;

  @Column({ type: "int" })
  startMs: number;

  @Column({ type: "int" })
  endMs: number;

  @Column({ type: "int" })
  durationMs: number;

  @Column({ type: "varchar", length: 10, default: "wav" })
  format: string;

  @Column({ type: "int", default: 8000 })
  sampleRate: number;

  @Column({ type: "bigint", nullable: true })
  fileSizeBytes: number | null;

  @Column({ type: "varchar", length: 100 })
  storageBucket: string;

  @Column({ type: "varchar", length: 500 })
  storageKey: string;

  @Column({ type: "varchar", length: 100, nullable: true })
  label: string | null;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date;

  @Column({ type: "uuid", nullable: true })
  projectId: string | null;

  @ManyToOne(() => Call, (call) => call.segments, {
    onDelete: "CASCADE",
    nullable: true,
  })
  @JoinColumn({ name: "callId" })
  call: Call | null;

  @ManyToOne(() => Project, (project) => project.segments, {
    onDelete: "SET NULL",
    nullable: true,
  })
  @JoinColumn({ name: "projectId" })
  project: Project;
}
