import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { EmailService } from './email.service';

@Processor('email')
export class EmailProcessor extends WorkerHost {
  private readonly logger = new Logger(EmailProcessor.name);

  constructor(private readonly emailService: EmailService) {
    super();
  }

  async process(job: Job): Promise<void> {
    this.logger.log(`Processing job ${job.id} — type: ${job.data.type}, to: ${job.data.to}`);
    try {
      await this.emailService.processJob(job.data);
    } catch (error) {
      this.logger.error(`Job ${job.id} failed: ${error}`);
      throw error; // Let BullMQ handle retries
    }
  }
}
