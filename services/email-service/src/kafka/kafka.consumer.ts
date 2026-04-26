import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { EmailService } from '../email/email.service';

interface UserCreatedEvent {
  id: string;
  username: string;
  email: string;
  displayName: string;
  role: 'creator' | 'representative' | 'listener';
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
