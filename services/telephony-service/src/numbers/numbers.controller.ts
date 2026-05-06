import {
  Controller,
  Get,
  Headers,
  Logger,
  NotFoundException,
  Query,
  UnauthorizedException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { PhoneNumberAssignment } from "../entities/phone-number-assignment.entity";

@Controller("telephony/numbers")
export class NumbersController {
  private readonly logger = new Logger(NumbersController.name);

  constructor(
    @InjectRepository(PhoneNumberAssignment)
    private readonly assignmentRepo: Repository<PhoneNumberAssignment>,
  ) {}

  /**
   * Reverse-lookup an assigned phone number → owning user.
   * Used by the app's incoming-call screen to render `@username` instead
   * of a raw E.164 when the caller's identity is a registered bridge number.
   * Returns 404 when the number is not actively assigned.
   */
  @Get("lookup")
  async lookupByPhoneNumber(
    @Query("phoneNumber") phoneNumber: string,
    @Headers("x-user-id") userId: string,
    @Headers("authorization") authHeader: string,
  ) {
    this.resolveUserId(userId, authHeader);

    if (!phoneNumber) {
      throw new NotFoundException("phoneNumber query param is required");
    }

    const assignment = await this.assignmentRepo.findOne({
      where: { phoneNumber, status: "active" },
    });

    if (!assignment) {
      throw new NotFoundException("No active assignment for this number");
    }

    return {
      success: true,
      data: {
        userId: assignment.userId,
        phoneNumber: assignment.phoneNumber,
        creatorName: assignment.creatorName,
      },
    };
  }

  private resolveUserId(headerUserId: string, authHeader: string): string {
    if (headerUserId) return headerUserId;

    if (authHeader?.startsWith("Bearer ")) {
      try {
        const payload = JSON.parse(
          Buffer.from(authHeader.slice(7).split(".")[1], "base64").toString(),
        );
        const uid = payload.sub || payload.user_id;
        if (uid) return String(uid);
      } catch {
        // fall through
      }
    }

    throw new UnauthorizedException("User ID not found");
  }
}
