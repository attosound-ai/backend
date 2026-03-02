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
