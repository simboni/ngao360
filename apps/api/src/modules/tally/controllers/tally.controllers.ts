import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import type {
  DiscrepancyCaseAction,
  DiscrepancyCaseDetail,
  DiscrepancyCaseSummary,
  GeographyBreakdown,
  LiveAggregate,
  Paginated,
  SignedUrlResponse,
  TallyExport,
  TallySnapshot,
  Verification,
} from '@ngao360/shared';
import type { AuthContext } from '../../../auth/auth.types';
import { CurrentAuth } from '../../../common/decorators/auth.decorators';
import { RequirePermission, RequireReauth } from '../../../rbac/require-permission.decorator';
import {
  AggregateQueryDto,
  AssignDiscrepancyDto,
  BreakdownQueryDto,
  CloseDiscrepancyDto,
  CreateDiscrepancyDto,
  CreateExportDto,
  CreateSnapshotDto,
  DiscrepancyCommentDto,
  DiscrepancyQueryDto,
  DiscrepancyTransitionDto,
  ExportQueryDto,
  IdParamDto,
  ReleaseSnapshotDto,
  ResolveDiscrepancyDto,
  SnapshotQueryDto,
  StationsQueryDto,
  SupervisorActionDto,
} from '../dto';
import { DiscrepancyService } from '../services/discrepancy.service';
import { ExportsService } from '../services/exports.service';
import { ResultsService, type StationCoverageRow } from '../services/results.service';
import { VerificationService } from '../services/verification.service';

/** Supervisor action on a verification round (API contract §5.4). */
@Controller('tally/verifications')
export class VerificationsController {
  constructor(private readonly verification: VerificationService) {}

  @Post(':id/supervisor-action')
  @HttpCode(200)
  @RequirePermission('tally.approve')
  @RequireReauth()
  supervisorAction(@CurrentAuth() auth: AuthContext, @Param() p: IdParamDto, @Body() body: SupervisorActionDto): Promise<Verification> {
    return this.verification.supervisorAction(auth, p.id, body);
  }
}

/** Discrepancy cases (API contract §5.5). Geography for mutations is checked in the service. */
@Controller('tally/discrepancies')
export class DiscrepanciesController {
  constructor(private readonly cases: DiscrepancyService) {}

  @Get()
  @RequirePermission('tally.discrepancy.view')
  list(@CurrentAuth() auth: AuthContext, @Query() q: DiscrepancyQueryDto): Promise<Paginated<DiscrepancyCaseSummary>> {
    return this.cases.list(auth, q);
  }

  @Get(':id')
  @RequirePermission('tally.discrepancy.view', { geo: { kind: 'discrepancy', from: 'params', key: 'id' } })
  get(@Param() p: IdParamDto): Promise<DiscrepancyCaseDetail> {
    return this.cases.get(p.id);
  }

  @Post()
  @RequirePermission('tally.discrepancy.manage')
  create(@CurrentAuth() auth: AuthContext, @Body() body: CreateDiscrepancyDto): Promise<DiscrepancyCaseDetail> {
    return this.cases.create(auth, body);
  }

  @Post(':id/assign')
  @HttpCode(200)
  @RequirePermission('tally.discrepancy.manage')
  assign(@CurrentAuth() auth: AuthContext, @Param() p: IdParamDto, @Body() body: AssignDiscrepancyDto): Promise<DiscrepancyCaseDetail> {
    return this.cases.assign(auth, p.id, body);
  }

  @Post(':id/comments')
  @RequirePermission('tally.discrepancy.manage')
  comment(@CurrentAuth() auth: AuthContext, @Param() p: IdParamDto, @Body() body: DiscrepancyCommentDto): Promise<DiscrepancyCaseAction> {
    return this.cases.comment(auth, p.id, body);
  }

  @Post(':id/transition')
  @HttpCode(200)
  @RequirePermission('tally.discrepancy.manage')
  transition(@CurrentAuth() auth: AuthContext, @Param() p: IdParamDto, @Body() body: DiscrepancyTransitionDto): Promise<DiscrepancyCaseDetail> {
    return this.cases.transition(auth, p.id, body);
  }

  @Post(':id/resolve')
  @HttpCode(200)
  @RequirePermission('tally.discrepancy.resolve')
  @RequireReauth()
  resolve(@CurrentAuth() auth: AuthContext, @Param() p: IdParamDto, @Body() body: ResolveDiscrepancyDto): Promise<DiscrepancyCaseDetail> {
    return this.cases.resolve(auth, p.id, body);
  }

  @Post(':id/close')
  @HttpCode(200)
  @RequirePermission('tally.discrepancy.resolve')
  close(@CurrentAuth() auth: AuthContext, @Param() p: IdParamDto, @Body() body: CloseDiscrepancyDto): Promise<DiscrepancyCaseDetail> {
    return this.cases.close(auth, p.id, body);
  }
}

/** Internal parallel aggregate (API contract §5.6). Never official; responses carry the disclaimer. */
@Controller('tally/results')
export class ResultsController {
  constructor(private readonly results: ResultsService) {}

  @Get('live')
  @RequirePermission('tally.results.view')
  live(@CurrentAuth() auth: AuthContext, @Query() q: AggregateQueryDto): Promise<LiveAggregate> {
    return this.results.live(auth, q);
  }

  @Get('breakdown')
  @RequirePermission('tally.results.view')
  breakdown(@CurrentAuth() auth: AuthContext, @Query() q: BreakdownQueryDto): Promise<GeographyBreakdown> {
    return this.results.breakdown(auth, q);
  }

  @Get('stations')
  @RequirePermission('tally.results.view')
  stations(@CurrentAuth() auth: AuthContext, @Query() q: StationsQueryDto): Promise<Paginated<StationCoverageRow>> {
    return this.results.stations(auth, q);
  }
}

@Controller('tally/snapshots')
export class SnapshotsController {
  constructor(private readonly results: ResultsService) {}

  @Post()
  @RequirePermission('tally.snapshot.create')
  create(@CurrentAuth() auth: AuthContext, @Body() body: CreateSnapshotDto): Promise<TallySnapshot> {
    return this.results.createSnapshot(auth, body);
  }

  @Get()
  @RequirePermission('tally.results.view')
  list(@CurrentAuth() auth: AuthContext, @Query() q: SnapshotQueryDto): Promise<Paginated<TallySnapshot>> {
    return this.results.listSnapshots(auth, q);
  }

  @Get(':id')
  @RequirePermission('tally.results.view')
  get(@CurrentAuth() auth: AuthContext, @Param() p: IdParamDto): Promise<TallySnapshot> {
    return this.results.getSnapshot(auth, p.id);
  }

  /** "Release" is internal release to authorised viewers, never a public declaration. */
  @Post(':id/release')
  @HttpCode(200)
  @RequirePermission('tally.release')
  @RequireReauth()
  release(@CurrentAuth() auth: AuthContext, @Param() p: IdParamDto, @Body() body: ReleaseSnapshotDto): Promise<TallySnapshot> {
    return this.results.releaseSnapshot(auth, p.id, body);
  }
}

/** Exports with the non-official disclaimer, methodology, denominator and audit manifest (API contract §5.7). */
@Controller('tally/exports')
export class ExportsController {
  constructor(private readonly exportsService: ExportsService) {}

  @Post()
  @RequirePermission('tally.export')
  @RequireReauth()
  create(@CurrentAuth() auth: AuthContext, @Body() body: CreateExportDto): Promise<TallyExport> {
    return this.exportsService.create(auth, body);
  }

  @Get()
  @RequirePermission('tally.export')
  list(@CurrentAuth() auth: AuthContext, @Query() q: ExportQueryDto): Promise<Paginated<TallyExport>> {
    return this.exportsService.list(auth, q);
  }

  @Get(':id/download-url')
  @RequirePermission('tally.export')
  downloadUrl(@CurrentAuth() auth: AuthContext, @Param() p: IdParamDto): Promise<SignedUrlResponse> {
    return this.exportsService.downloadUrl(auth, p.id);
  }
}
