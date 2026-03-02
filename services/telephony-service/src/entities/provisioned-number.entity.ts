import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

@Entity("provisioned_numbers")
@Index("IDX_prov_number_user_status", ["userId", "status"])
@Index("IDX_prov_number_status_created", ["status", "createdAt"])
export class ProvisionedNumber {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  /** Twilio IncomingPhoneNumber SID (e.g. PN...) */
  @Column({ type: "varchar", length: 34, unique: true })
  twilioNumberSid: string;

  /** E.164 phone number (e.g. +12025551234) */
  @Column({ type: "varchar", length: 20, unique: true })
  phoneNumber: string;

  /** User this number is assigned to (null = available in pool) */
  @Column({ type: "varchar", length: 64, nullable: true })
  userId: string | null;

  /** Subscription that owns this number */
  @Column({ type: "varchar", length: 64, nullable: true })
  subscriptionId: string | null;

  @Column({ type: "varchar", length: 20, default: "available" })
  status: "available" | "assigned" | "releasing";

  @Column({ type: "timestamptz", nullable: true })
  assignedAt: Date | null;

  @Column({ type: "timestamptz", nullable: true })
  releasedAt: Date | null;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt: Date;
}
