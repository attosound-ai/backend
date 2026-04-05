import { Global, Module } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module';
import { GrpcClientsService } from './grpc-clients.service';
import { GrpcServerService } from './grpc-server.service';

@Global()
@Module({
  imports: [RedisModule],
  providers: [GrpcClientsService, GrpcServerService],
  exports: [GrpcClientsService],
})
export class GrpcModule {}
