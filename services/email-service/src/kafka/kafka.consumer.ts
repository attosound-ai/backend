import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { EmailService } from '../email/email.service';

interface UserCreatedPayload {
  id: string;
  username: string;
  email: string;
  displayName: string;
  role: 'creator' | 'representative' | 'listener';
  /** BCP-47 locale captured at signup_start. May be missing on legacy events. */
  locale?: string;
}

// user-service (Go) publishes every event wrapped in this envelope —
// see backend/services/user-service/internal/kafka/producer.go::Event.
// Other consumers (social-service, telephony-service) explicitly unwrap
// via `raw.data ?? raw`; this consumer was reading the envelope directly
// and getting `undefined` for every field, which is why no welcome emails
// were sent since the envelope was introduced.
interface UserCreatedEnvelope {
  type: 'user.created';
  timestamp: string;
  data: UserCreatedPayload;
}

@Controller()
export class KafkaConsumer {
  private readonly logger = new Logger(KafkaConsumer.name);

  constructor(private readonly emailService: EmailService) {}

  @EventPattern('user.created')
  async handleUserCreated(
    @Payload() raw: UserCreatedEnvelope | UserCreatedPayload,
  ): Promise<void> {
    // Tolerate both wrapped and flat payloads (some test fixtures publish flat).
    const data: UserCreatedPayload =
      'data' in raw && raw.data ? raw.data : (raw as UserCreatedPayload);

    if (!data?.email) {
      this.logger.warn(
        `user.created event missing email — payload: ${JSON.stringify(raw)}`,
      );
      return;
    }

    // Normalize locale: BCP-47 may arrive as "en-US"/"pt-BR" but our
    // templates branch on the language part ("en"/"es"/"pt"). Default to
    // "en" when missing so legacy/test events don't fall into the old
    // hard-coded Spanish path.
    const locale = (data.locale ?? 'en').toLowerCase();
    this.logger.log(
      `Received user.created event for ${data.email} (role: ${data.role}, locale: ${locale})`,
    );

    // Welcome email for all roles — address the user by bare username
    await this.emailService.queueEmail('welcome', data.email, {
      name: data.username,
      role: data.role,
      locale,
    });

    // Instructions email only for representatives
    if (data.role === 'representative') {
      await this.emailService.queueEmail(
        'instructions',
        data.email,
        { name: data.username, locale },
        2,
      );
    }
  }
}
