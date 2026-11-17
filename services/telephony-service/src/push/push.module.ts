import { Module } from "@nestjs/common";
import { PushService } from "./push.service";
import { UsersClientModule } from "../users-client/users-client.module";

@Module({
  imports: [UsersClientModule],
  providers: [PushService],
  exports: [PushService],
})
export class PushModule {}
