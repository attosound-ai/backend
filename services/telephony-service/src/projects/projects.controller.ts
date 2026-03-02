import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Param,
  Body,
  Headers,
  Logger,
  UnauthorizedException,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ProjectsService } from "./projects.service";
import { CreateProjectDto } from "./dto/create-project.dto";
import { UpdateProjectDto } from "./dto/update-project.dto";
import { SaveTimelineDto } from "./dto/save-timeline.dto";

@Controller("telephony/projects")
export class ProjectsController {
  private readonly logger = new Logger(ProjectsController.name);

  constructor(private readonly projectsService: ProjectsService) {}

  @Post()
  async createProject(
    @Body() dto: CreateProjectDto,
    @Headers("x-user-id") userId: string,
    @Headers("authorization") authHeader: string,
  ) {
    const uid = this.resolveUserId(userId, authHeader);
    const project = await this.projectsService.createProject(
      uid,
      dto.name,
      dto.description,
    );
    return { success: true, data: project };
  }

  @Get()
  async listProjects(
    @Headers("x-user-id") userId: string,
    @Headers("authorization") authHeader: string,
  ) {
    const uid = this.resolveUserId(userId, authHeader);
    const projects = await this.projectsService.getProjectsForUser(uid);
    return { success: true, data: projects };
  }

  @Get(":id")
  async getProject(
    @Param("id") id: string,
    @Headers("x-user-id") userId: string,
    @Headers("authorization") authHeader: string,
  ) {
    const uid = this.resolveUserId(userId, authHeader);
    const result = await this.projectsService.getProjectById(id, uid);
    return { success: true, data: result };
  }

  @Patch(":id")
  async updateProject(
    @Param("id") id: string,
    @Body() dto: UpdateProjectDto,
    @Headers("x-user-id") userId: string,
    @Headers("authorization") authHeader: string,
  ) {
    const uid = this.resolveUserId(userId, authHeader);
    const project = await this.projectsService.updateProject(id, uid, dto);
    return { success: true, data: project };
  }

  @Delete(":id")
  async deleteProject(
    @Param("id") id: string,
    @Headers("x-user-id") userId: string,
    @Headers("authorization") authHeader: string,
  ) {
    const uid = this.resolveUserId(userId, authHeader);
    await this.projectsService.deleteProject(id, uid);
    return { success: true };
  }

  @Post(":id/segments")
  async addSegment(
    @Param("id") id: string,
    @Body("segmentId") segmentId: string,
    @Headers("x-user-id") userId: string,
    @Headers("authorization") authHeader: string,
  ) {
    const uid = this.resolveUserId(userId, authHeader);
    const segment = await this.projectsService.assignSegmentToProject(
      segmentId,
      id,
      uid,
    );
    return { success: true, data: segment };
  }

  @Delete(":id/segments/:segmentId")
  async removeSegment(
    @Param("id") id: string,
    @Param("segmentId") segmentId: string,
    @Headers("x-user-id") userId: string,
    @Headers("authorization") authHeader: string,
  ) {
    const uid = this.resolveUserId(userId, authHeader);
    await this.projectsService.removeSegmentFromProject(segmentId, id, uid);
    return { success: true };
  }

  @Get(":id/timeline")
  async getTimeline(
    @Param("id") id: string,
    @Headers("x-user-id") userId: string,
    @Headers("authorization") authHeader: string,
  ) {
    const uid = this.resolveUserId(userId, authHeader);
    const clips = await this.projectsService.getTimelineClips(id, uid);
    return { success: true, data: clips };
  }

  @Put(":id/timeline")
  async saveTimeline(
    @Param("id") id: string,
    @Body() dto: SaveTimelineDto,
    @Headers("x-user-id") userId: string,
    @Headers("authorization") authHeader: string,
  ) {
    const uid = this.resolveUserId(userId, authHeader);
    const clips = await this.projectsService.saveTimelineClips(
      id,
      uid,
      dto.clips,
    );
    return { success: true, data: clips };
  }

  @Post(":id/export")
  async exportProject(
    @Param("id") id: string,
    @Headers("x-user-id") userId: string,
    @Headers("authorization") authHeader: string,
  ) {
    const uid = this.resolveUserId(userId, authHeader);
    const result = await this.projectsService.exportProject(id, uid);
    return { success: true, data: result };
  }

  @Post(":id/upload-audio")
  @UseInterceptors(
    FileInterceptor("file", {
      limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
      fileFilter: (_req, file, cb) => {
        const allowed = [
          "audio/wav",
          "audio/x-wav",
          "audio/mpeg",
          "audio/mp3",
          "audio/mp4",
          "audio/m4a",
          "audio/x-m4a",
          "audio/aac",
        ];
        if (allowed.includes(file.mimetype)) {
          cb(null, true);
        } else {
          cb(
            new BadRequestException(
              `Unsupported audio format: ${file.mimetype}`,
            ),
            false,
          );
        }
      },
    }),
  )
  async uploadAudio(
    @Param("id") id: string,
    @UploadedFile() file: Express.Multer.File,
    @Body("laneIndex") laneIndex: string,
    @Headers("x-user-id") userId: string,
    @Headers("authorization") authHeader: string,
  ) {
    const uid = this.resolveUserId(userId, authHeader);
    if (!file) {
      throw new BadRequestException("No file uploaded");
    }
    const lane = laneIndex ? parseInt(laneIndex, 10) : 0;
    const result = await this.projectsService.importAudioFile(
      id,
      uid,
      file,
      lane,
    );
    return { success: true, data: result };
  }

  private resolveUserId(headerUserId: string, authHeader: string): string {
    if (headerUserId) return headerUserId;

    if (authHeader?.startsWith("Bearer ")) {
      try {
        const payload = JSON.parse(
          Buffer.from(authHeader.slice(7).split(".")[1], "base64").toString(),
        );
        const uid = payload.sub || payload.user_id;
        if (uid) return String(uid);
      } catch {
        // fall through
      }
    }

    throw new UnauthorizedException("User ID not found");
  }
}
