import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../common/guards/auth.guard';
import { CurrentUserId } from '../common/decorators/current-user.decorator';
import { CreatorLogosService } from './creator-logos.service';
import { VoteDto } from './dto/creator-logo.dto';

@Controller('api/v1/creator-logos')
@UseGuards(AuthGuard)
export class CreatorLogosController {
  constructor(private readonly service: CreatorLogosService) {}

  @Get()
  async getLogos(@CurrentUserId() userId: string) {
    const logos = await this.service.getActiveLogos(userId);
    return { success: true, data: logos, error: null };
  }

  @Post(':id/vote')
  @HttpCode(HttpStatus.OK)
  async vote(
    @CurrentUserId() userId: string,
    @Param('id') logoId: string,
    @Body() dto: VoteDto,
  ) {
    await this.service.vote(userId, logoId, dto.vote);
    const logos = await this.service.getActiveLogos(userId);
    return { success: true, data: logos, error: null };
  }

  @Get(':id/voters/:type')
  async getVoters(
    @Param('id') logoId: string,
    @Param('type') type: string,
  ) {
    const voteType = type === 'likes' ? 1 : -1;
    const result = await this.service.getVoters(logoId, voteType, 1, 50);
    return { success: true, data: result.users, error: null, meta: { total: result.total } };
  }

  @Delete(':id/vote')
  @HttpCode(HttpStatus.OK)
  async removeVote(
    @CurrentUserId() userId: string,
    @Param('id') logoId: string,
  ) {
    await this.service.removeVote(userId, logoId);
    return { success: true, data: null, error: null };
  }
}
