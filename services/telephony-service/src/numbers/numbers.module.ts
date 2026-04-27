import { Module, forwardRef } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ProvisionedNumber } from "../entities/provisioned-number.entity";
import { PhoneNumberAssignment } from "../entities/phone-number-assignment.entity";
import { TwilioNumberService } from "./twilio-number.service";
import { NumberProvisioningService } from "./number-provisioning.service";
import { KafkaModule } from "../kafka/kafka.module";
import { OutboxModule } from "../outbox/outbox.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([ProvisionedNumber, PhoneNumberAssignment]),
    forwardRef(() => KafkaModule),
    OutboxModule,
  ],
  providers: [TwilioNumberService, NumberProvisioningService],
  exports: [TwilioNumberService, NumberProvisioningService],
})
export class NumbersModule {}
