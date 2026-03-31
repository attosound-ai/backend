import { Controller, Post, Body, Get } from "@nestjs/common";
import { EmailService } from "./email.service";
import {
  SendOtpDto,
  SendPasswordResetDto,
  SendInstructionsDto,
} from "./dto/send-email.dto";

@Controller("internal/email")
export class EmailController {
  constructor(private readonly emailService: EmailService) {}

  @Get("/health")
  health() {
    return { status: "ok", service: "email-service" };
  }

  /**
   * Direct send — no queue, synchronous response (< 500ms target).
   */
  @Post("/otp")
  async sendOtp(@Body() dto: SendOtpDto) {
    await this.emailService.sendDirect("otp", dto.to, {
      code: dto.code,
      expiresMinutes: dto.expiresMinutes,
      locale: dto.locale || "en",
      purpose: dto.purpose,
    });
    return { success: true };
  }

  /**
   * Direct send — no queue, synchronous response.
   */
  @Post("/password-reset")
  async sendPasswordReset(@Body() dto: SendPasswordResetDto) {
    await this.emailService.sendDirect("password-reset", dto.to, {
      code: dto.code,
      expiresMinutes: dto.expiresMinutes,
      locale: dto.locale || "en",
    });
    return { success: true };
  }

  /**
   * Queued send — BullMQ async delivery.
   */
  @Post("/instructions")
  async sendInstructions(@Body() dto: SendInstructionsDto) {
    await this.emailService.queueEmail(
      "instructions",
      dto.to,
      {
        name: dto.name,
        bridgeNumber: dto.bridgeNumber,
      },
      2,
    );
    return { success: true, queued: true };
  }
}
