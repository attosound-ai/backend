import { Module } from "@nestjs/common";
import { UsersClientService } from "./users-client.service";

@Module({
  providers: [UsersClientService],
  exports: [UsersClientService],
})
export class UsersClientModule {}
