import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { validateRequest } from 'twilio';
import { Request } from 'express';

@Injectable()
export class TwilioSignatureGuard implements CanActivate {
  private readonly logger = new Logger(TwilioSignatureGuard.name);

  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const authToken = this.config.get<string>('twilio.authToken');

    // Skip validation in development if no auth token configured
    if (!authToken) {
      this.logger.warn('Twilio auth token not configured — skipping signature validation');
      return true;
    }

    const signature = request.headers['x-twilio-signature'] as string;
    if (!signature) {
      this.logger.warn('Missing X-Twilio-Signature header');
      return false;
    }

    // Reconstruct the full URL that Twilio signed
    const webhookBaseUrl = this.config.get<string>('webhookBaseUrl');
    const url = `${webhookBaseUrl}${request.originalUrl}`;

    const isValid = validateRequest(authToken, signature, url, request.body || {});

    if (!isValid) {
      this.logger.warn('Invalid Twilio signature for URL: %s', url);
    }

    return isValid;
  }
}
