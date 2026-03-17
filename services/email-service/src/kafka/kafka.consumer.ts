import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { EmailService } from '../email/email.service';

interface UserCreatedEvent {
  id: string;
  username: string;
  email: string;
  displayName: string;
  role: 'artist' | 'representative' | 'listener';
}

@Controller()
export class KafkaConsumer {
  private readonly logger = new Logger(KafkaConsumer.name);

  constructor(private readonly emailService: EmailService) {}

  @EventPattern('user.created')
  async handleUserCreated(@Payload() data: UserCreatedEvent): Promise<void> {
    this.logger.log(
      `Received user.created event for ${data.email} (role: ${data.role})`,
    );

    // Welcome email for all roles
    await this.emailService.queueEmail('welcome', data.email, {
      name: data.displayName || data.username,
      role: data.role,
    });

    // Instructions email only for representatives
    if (data.role === 'representative') {
      await this.emailService.queueEmail(
        'instructions',
        data.email,
        { name: data.displayName || data.username },
        2,
      );
    }
  }
}
