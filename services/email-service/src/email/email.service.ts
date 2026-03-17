import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { Resend } from "resend";
import * as nodemailer from "nodemailer";
import { render } from "@react-email/render";
import { createElement } from "react";
import { OtpEmail } from "../templates/otp.email";
import { WelcomeEmail } from "../templates/welcome.email";
import { PasswordResetEmail } from "../templates/password-reset.email";
import { InstructionsEmail } from "../templates/instructions.email";

type EmailTemplate = "otp" | "welcome" | "password-reset" | "instructions";

interface EmailPayload {
  type: EmailTemplate;
  to: string;
  data: Record<string, unknown>;
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly provider: string;
  private readonly from: string;
  private readonly fromName: string;
  private readonly fromMap: ReadonlyMap<EmailTemplate, string>;
  private resend?: Resend;
  private transporter?: nodemailer.Transporter;

  constructor(
    private readonly configService: ConfigService,
    @InjectQueue("email") private readonly emailQueue: Queue,
  ) {
    this.provider = this.configService.get<string>("email.provider", "mailpit");
    this.from = this.configService.get<string>("email.from", "dev@atto.local");
    this.fromName = this.configService.get<string>(
      "email.fromName",
      "Atto Dev",
    );

    const fromAuth = this.configService.get<string>(
      "email.fromAuth",
      this.from,
    );
    const fromWelcome = this.configService.get<string>(
      "email.fromWelcome",
      this.from,
    );
    this.fromMap = new Map<EmailTemplate, string>([
      ["otp", fromAuth],
      ["password-reset", fromAuth],
      ["welcome", fromWelcome],
      ["instructions", fromWelcome],
    ]);

    if (this.provider === "resend") {
      const apiKey = this.configService.get<string>("email.resendApiKey", "");
      this.resend = new Resend(apiKey);
      this.logger.log("Using Resend email provider");
    } else {
      const host = this.configService.get<string>(
        "email.mailpitHost",
        "mailpit",
      );
      const port = this.configService.get<number>("email.mailpitPort", 1025);
      this.transporter = nodemailer.createTransport({
        host,
        port,
        secure: false,
      });
      this.logger.log(`Using Mailpit email provider (${host}:${port})`);
    }
  }

  /**
   * Send email directly (synchronous) — for OTP and password-reset (latency-critical).
   */
  async sendDirect(
    type: EmailTemplate,
    to: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const { subject, html } = await this.renderTemplate(type, data);
    const from = this.fromMap.get(type) ?? this.from;

    if (this.provider === "resend" && this.resend) {
      const result = await this.resend.emails.send({
        from: `${this.fromName} <${from}>`,
        to,
        subject,
        html,
      });
      if (result.error) {
        throw new Error(`Resend error: ${result.error.message}`);
      }
      this.logger.log(
        `[DIRECT] Sent ${type} email to ${to} from ${from} via Resend`,
      );
    } else if (this.transporter) {
      await this.transporter.sendMail({
        from: `${this.fromName} <${from}>`,
        to,
        subject,
        html,
      });
      this.logger.log(
        `[DIRECT] Sent ${type} email to ${to} from ${from} via Mailpit`,
      );
    }
  }

  /**
   * Queue email for async delivery via BullMQ — for welcome, instructions (tolerant of latency).
   */
  async queueEmail(
    type: EmailTemplate,
    to: string,
    data: Record<string, unknown>,
    priority = 3,
  ): Promise<void> {
    const payload: EmailPayload = { type, to, data };
    await this.emailQueue.add(type, payload, {
      priority,
      attempts: 3,
      backoff: { type: "exponential", delay: 2000 },
      removeOnComplete: 100,
      removeOnFail: 50,
    });
    this.logger.log(`[QUEUE] Enqueued ${type} email to ${to}`);
  }

  /**
   * Process a queued email job — called by the BullMQ processor.
   */
  async processJob(payload: EmailPayload): Promise<void> {
    await this.sendDirect(payload.type, payload.to, payload.data);
  }

  private async renderTemplate(
    type: EmailTemplate,
    data: Record<string, unknown>,
  ): Promise<{ subject: string; html: string }> {
    const appDeeplink = this.configService.get<string>(
      "email.appDeeplink",
      "atto://",
    );

    switch (type) {
      case "otp": {
        const locale = (data.locale as string) || "en";
        const html = await render(
          createElement(OtpEmail, {
            code: data.code as string,
            expiresMinutes: data.expiresMinutes as number,
            locale,
          }),
        );
        const subjects: Record<string, string> = {
          en: "Your Atto verification code",
          es: "Tu código de verificación de Atto",
          "pt-BR": "Seu código de verificação do Atto",
        };
        const subject =
          subjects[locale] ??
          (locale.startsWith("pt") ? subjects["pt-BR"] : subjects.en);
        return { subject, html };
      }
      case "welcome": {
        const html = await render(
          createElement(WelcomeEmail, {
            name: data.name as string,
            role: data.role as "artist" | "representative" | "listener",
            appDeeplink,
          }),
        );
        return { subject: "¡Bienvenido a Atto!", html };
      }
      case "password-reset": {
        const prLocale = (data.locale as string) || "en";
        const html = await render(
          createElement(PasswordResetEmail, {
            code: data.code as string,
            expiresMinutes: data.expiresMinutes as number,
            locale: prLocale,
          }),
        );
        const prSubjects: Record<string, string> = {
          en: "Reset your Atto password",
          es: "Código para restablecer tu contraseña — Atto",
          "pt-BR": "Código para redefinir sua senha — Atto",
        };
        const prSubject =
          prSubjects[prLocale] ??
          (prLocale.startsWith("pt") ? prSubjects["pt-BR"] : prSubjects.en);
        return { subject: prSubject, html };
      }
      case "instructions": {
        const html = await render(
          createElement(InstructionsEmail, {
            name: data.name as string,
            bridgeNumber: data.bridgeNumber as string | undefined,
          }),
        );
        return { subject: "Instrucciones para representantes — Atto", html };
      }
    }
  }
}
