import { Global, Module } from '@nestjs/common';
import { GrpcClientsService } from './grpc-clients.service';
import { GrpcServerService } from './grpc-server.service';

@Global()
@Module({
  providers: [GrpcClientsService, GrpcServerService],
  exports: [GrpcClientsService],
})
export class GrpcModule {}
