import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  type CampaignFile,
  MAX_CAMPAIGN_FILE_BYTES,
  type Paginated,
  type SignedUrlResponse,
  type TaskAttachment,
  type TaskBoard,
  type TaskComment,
  type TaskDetail,
  type TaskSummary,
  type TaskWorkload,
} from '@ngao360/shared';
import type { AuthContext } from '../../../auth/auth.types';
import { CurrentAuth } from '../../../common/decorators/auth.decorators';
import { RequirePermission } from '../../../rbac/require-permission.decorator';
import { RequireModule } from '../../../tenant-modules/require-module.decorator';
import {
  AddTaskAttachmentDto,
  AddTaskCommentDto,
  AddTaskDependencyDto,
  AssignTaskDto,
  AttachmentParamDto,
  CampaignIdParamDto,
  ChangeTaskStatusDto,
  CreateTaskDto,
  ReviewTaskDto,
  SaveTaskChecklistDto,
  TaskCalendarQueryDto,
  TaskDependencyParamDto,
  TaskQueryDto,
  UpdateTaskDto,
} from '../campaign.dto';
import type { CampaignUpload } from '../common';
import { TasksService } from './tasks.service';

/**
 * S08 tasks (docs/API_CONTRACT.md §24): list / board / calendar / workload, detail, create, update, assign,
 * status, review, dependencies, checklist, comments and attachments. Records follow the department scope
 * (404 outside); writes check the read scope first, then the write permission and involvement.
 */
@RequireModule('campaign')
@Controller('tasks')
export class TasksController {
  constructor(private readonly service: TasksService) {}

  @RequirePermission('tasks.create')
  @Post('files')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_CAMPAIGN_FILE_BYTES, files: 1 } }))
  upload(@CurrentAuth() auth: AuthContext, @UploadedFile() file: CampaignUpload | undefined): Promise<CampaignFile> {
    return this.service.upload(auth, file);
  }

  @RequirePermission('tasks.view')
  @Get()
  list(@CurrentAuth() auth: AuthContext, @Query() q: TaskQueryDto): Promise<Paginated<TaskSummary>> {
    return this.service.list(auth, q);
  }

  @RequirePermission('tasks.view')
  @Get('board')
  board(@CurrentAuth() auth: AuthContext, @Query() q: TaskQueryDto): Promise<TaskBoard> {
    return this.service.board(auth, q);
  }

  @RequirePermission('tasks.view')
  @Get('calendar')
  calendar(@CurrentAuth() auth: AuthContext, @Query() q: TaskCalendarQueryDto): Promise<TaskSummary[]> {
    return this.service.calendar(auth, q);
  }

  @RequirePermission('tasks.view')
  @Get('workload')
  workload(@CurrentAuth() auth: AuthContext, @Query() q: TaskQueryDto): Promise<TaskWorkload> {
    return this.service.workload(auth, q);
  }

  @RequirePermission('tasks.view')
  @Get(':id')
  get(@CurrentAuth() auth: AuthContext, @Param() p: CampaignIdParamDto): Promise<TaskDetail> {
    return this.service.get(auth, p.id);
  }

  @RequirePermission(['tasks.create', 'tasks.view'])
  @Post()
  create(@CurrentAuth() auth: AuthContext, @Body() body: CreateTaskDto): Promise<TaskDetail> {
    return this.service.create(auth, body);
  }

  @RequirePermission(['tasks.create', 'tasks.view'])
  @Patch(':id')
  update(@CurrentAuth() auth: AuthContext, @Param() p: CampaignIdParamDto, @Body() body: UpdateTaskDto): Promise<TaskDetail> {
    return this.service.update(auth, p.id, body);
  }

  @RequirePermission(['tasks.assign', 'tasks.manage_all'], { anyOf: true })
  @HttpCode(200)
  @Post(':id/assign')
  assign(@CurrentAuth() auth: AuthContext, @Param() p: CampaignIdParamDto, @Body() body: AssignTaskDto): Promise<TaskDetail> {
    return this.service.assign(auth, p.id, body);
  }

  @RequirePermission(['tasks.create', 'tasks.manage_all'], { anyOf: true })
  @HttpCode(200)
  @Post(':id/status')
  status(@CurrentAuth() auth: AuthContext, @Param() p: CampaignIdParamDto, @Body() body: ChangeTaskStatusDto): Promise<TaskDetail> {
    return this.service.changeStatus(auth, p.id, body);
  }

  @RequirePermission('tasks.review')
  @HttpCode(200)
  @Post(':id/review')
  review(@CurrentAuth() auth: AuthContext, @Param() p: CampaignIdParamDto, @Body() body: ReviewTaskDto): Promise<TaskDetail> {
    return this.service.review(auth, p.id, body);
  }

  @RequirePermission(['tasks.create', 'tasks.view'])
  @HttpCode(200)
  @Post(':id/dependencies')
  addDependency(@CurrentAuth() auth: AuthContext, @Param() p: CampaignIdParamDto, @Body() body: AddTaskDependencyDto): Promise<TaskDetail> {
    return this.service.addDependency(auth, p.id, body.dependsOnTaskId);
  }

  @RequirePermission(['tasks.create', 'tasks.view'])
  @Delete(':id/dependencies/:dependsOnTaskId')
  removeDependency(@CurrentAuth() auth: AuthContext, @Param() p: TaskDependencyParamDto): Promise<TaskDetail> {
    return this.service.removeDependency(auth, p.id, p.dependsOnTaskId);
  }

  @RequirePermission(['tasks.create', 'tasks.manage_all'], { anyOf: true })
  @Put(':id/checklist')
  checklist(@CurrentAuth() auth: AuthContext, @Param() p: CampaignIdParamDto, @Body() body: SaveTaskChecklistDto): Promise<TaskDetail> {
    return this.service.saveChecklist(auth, p.id, body);
  }

  @RequirePermission('tasks.view')
  @Post(':id/comments')
  comment(@CurrentAuth() auth: AuthContext, @Param() p: CampaignIdParamDto, @Body() body: AddTaskCommentDto): Promise<TaskComment> {
    return this.service.addComment(auth, p.id, body);
  }

  @RequirePermission(['tasks.create', 'tasks.view'])
  @Post(':id/attachments')
  attach(@CurrentAuth() auth: AuthContext, @Param() p: CampaignIdParamDto, @Body() body: AddTaskAttachmentDto): Promise<TaskAttachment> {
    return this.service.addAttachment(auth, p.id, body);
  }

  @RequirePermission('tasks.view')
  @Get(':id/attachments/:attachmentId/url')
  attachmentUrl(@CurrentAuth() auth: AuthContext, @Param() p: AttachmentParamDto): Promise<SignedUrlResponse> {
    return this.service.attachmentUrl(auth, p.id, p.attachmentId);
  }
}
