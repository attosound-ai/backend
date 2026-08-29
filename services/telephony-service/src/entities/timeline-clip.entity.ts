import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from "typeorm";
import { Project } from "./project.entity";
import { AudioSegment } from "./audio-segment.entity";

@Entity("timeline_clips")
export class TimelineClip {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid" })
  projectId: string;

  @Column({ type: "uuid" })
  segmentId: string;

  @Column({ type: "int" })
  startInSegment: number; // ms offset within original segment

  @Column({ type: "int" })
  endInSegment: number; // ms offset within original segment

  @Column({ type: "int" })
  positionInTimeline: number; // ms position in assembled timeline

  @Column({ type: "int" })
  order: number; // display/sequence order

  @Column({ type: "float", default: 1.0 })
  volume: number;

  @Column({ type: "int", default: 0 })
  laneIndex: number;

  // Non-destructive effects (rendered-segment model). When an effect chain is
  // applied, the client renders the effected audio on-device, uploads it as a
  // NEW segment and points `segmentId` at it; the DRY original is kept here so
  // the effect can be removed or re-tweaked later. `effects` is the chain that
  // produced the rendered segment (opaque JSON, defined by the client). Both
  // null = plain dry clip. The export mixes `segmentId` as-is, so the server
  // needs no DSP and preview == export by construction.
  @Column({ type: "uuid", nullable: true })
  sourceSegmentId: string | null;

  @Column({ type: "jsonb", nullable: true })
  effects: Record<string, unknown> | null;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt: Date;

  @ManyToOne(() => Project, (project) => project.clips, { onDelete: "CASCADE" })
  @JoinColumn({ name: "projectId" })
  project: Project;

  @ManyToOne(() => AudioSegment, { onDelete: "CASCADE" })
  @JoinColumn({ name: "segmentId" })
  segment: AudioSegment;
}
