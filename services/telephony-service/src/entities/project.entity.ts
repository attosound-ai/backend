import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
} from "typeorm";
import { AudioSegment } from "./audio-segment.entity";
import { TimelineClip } from "./timeline-clip.entity";

@Entity("projects")
export class Project {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "varchar", length: 64 })
  userId: string;

  @Column({ type: "varchar", length: 200 })
  name: string;

  @Column({ type: "text", nullable: true })
  description: string | null;

  @Column({ type: "varchar", length: 20, default: "active" })
  status: string; // 'active' | 'archived' | 'exported'

  @Column({ type: "jsonb", default: {} })
  lanes: Record<string, { name: string; color: string }>;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt: Date;

  @OneToMany(() => AudioSegment, (segment) => segment.project)
  segments: AudioSegment[];

  @OneToMany(() => TimelineClip, (clip) => clip.project)
  clips: TimelineClip[];
}
