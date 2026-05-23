import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { EmailService } from '../email/email.service';

interface UserCreatedPayload {
  id: string;
  username: string;
  email: string;
  displayName: string;
  role: 'creator' | 'representative' | 'listener';
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

    this.logger.log(
      `Received user.created event for ${data.email} (role: ${data.role})`,
    );

    // Welcome email for all roles — address the user by bare username
    await this.emailService.queueEmail('welcome', data.email, {
      name: data.username,
      role: data.role,
    });

    // Instructions email only for representatives
    if (data.role === 'representative') {
      await this.emailService.queueEmail(
        'instructions',
        data.email,
        { name: data.username },
        2,
      );
    }
  }
}
