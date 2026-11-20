import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import type {
  CandidateReference,
  Contest,
  ElectionCycle,
  GeographicUnit,
  Paginated,
  PollingStation,
  TallyCentre,
} from '@ngao360/shared';
import type { AuthContext } from '../../auth/auth.types';
import { CurrentAuth } from '../../common/decorators/auth.decorators';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { ContestsService } from './contests.service';
import { ElectionCyclesService } from './election-cycles.service';
import { GeographyService } from './geography.service';
import { PollingStationsService } from './polling-stations.service';
import {
  ContestQueryDto,
  CreateCandidateDto,
  CreateContestDto,
  CreateElectionCycleDto,
  CreateGeographicUnitDto,
  CreatePollingStationDto,
  CreateTallyCentreDto,
  GeographicUnitQueryDto,
  IdParamDto,
  PaginationQueryDto,
  PollingStationQueryDto,
  TallyCentreQueryDto,
  UpdateCandidateDto,
  UpdateContestDto,
  UpdateElectionCycleDto,
  UpdateGeographicUnitDto,
  UpdatePollingStationDto,
  UpdateTallyCentreDto,
} from './reference.dto';
import { TallyCentresService } from './tally-centres.service';

/** Reference data endpoints (docs/API_CONTRACT.md §4.1, 4.2, 4.4–4.6). */
@Controller('reference')
export class ReferenceController {
  constructor(
    private readonly cycles: ElectionCyclesService,
    private readonly geography: GeographyService,
    private readonly stations: PollingStationsService,
    private readonly tallyCentres: TallyCentresService,
    private readonly contests: ContestsService,
  ) {}

  /* ----------------------------- Election cycles ---------------------------- */

  @RequirePermission('reference.view')
  @Get('election-cycles')
  listCycles(@Query() q: PaginationQueryDto): Promise<Paginated<ElectionCycle>> {
    return this.cycles.list(q);
  }

  @RequirePermission('reference.view')
  @Get('election-cycles/:id')
  getCycle(@Param() p: IdParamDto): Promise<ElectionCycle> {
    return this.cycles.get(p.id);
  }

  @RequirePermission('reference.edit')
  @Post('election-cycles')
  createCycle(@CurrentAuth() auth: AuthContext, @Body() dto: CreateElectionCycleDto): Promise<ElectionCycle> {
    return this.cycles.create(auth.tenantId, dto);
  }

  @RequirePermission('reference.edit')
  @Patch('election-cycles/:id')
  updateCycle(@CurrentAuth() auth: AuthContext, @Param() p: IdParamDto, @Body() dto: UpdateElectionCycleDto): Promise<ElectionCycle> {
    return this.cycles.update(auth.tenantId, p.id, dto);
  }

  /* -------------------------------- Geography ------------------------------- */

  @RequirePermission('reference.view')
  @Get('geographic-units')
  listUnits(@CurrentAuth() auth: AuthContext, @Query() q: GeographicUnitQueryDto): Promise<Paginated<GeographicUnit>> {
    return this.geography.list(auth, q);
  }

  @RequirePermission('reference.view', { geo: { kind: 'geographicUnit', from: 'params', key: 'id' } })
  @Get('geographic-units/:id')
  getUnit(@Param() p: IdParamDto): Promise<GeographicUnit> {
    return this.geography.get(p.id);
  }

  @RequirePermission('reference.view', { geo: { kind: 'geographicUnit', from: 'params', key: 'id' } })
  @Get('geographic-units/:id/children')
  unitChildren(@Param() p: IdParamDto): Promise<GeographicUnit[]> {
    return this.geography.children(p.id);
  }

  @RequirePermission('reference.edit')
  @Post('geographic-units')
  createUnit(@CurrentAuth() auth: AuthContext, @Body() dto: CreateGeographicUnitDto): Promise<GeographicUnit> {
    return this.geography.create(auth.tenantId, dto);
  }

  @RequirePermission('reference.edit')
  @Patch('geographic-units/:id')
  updateUnit(@CurrentAuth() auth: AuthContext, @Param() p: IdParamDto, @Body() dto: UpdateGeographicUnitDto): Promise<GeographicUnit> {
    return this.geography.update(auth.tenantId, p.id, dto);
  }

  /* ----------------------------- Polling stations --------------------------- */

  @RequirePermission('reference.view')
  @Get('polling-stations')
  listStations(@CurrentAuth() auth: AuthContext, @Query() q: PollingStationQueryDto): Promise<Paginated<PollingStation>> {
    return this.stations.list(auth, q);
  }

  @RequirePermission('reference.view', { geo: { kind: 'pollingStation', from: 'params', key: 'id' } })
  @Get('polling-stations/:id')
  getStation(@Param() p: IdParamDto): Promise<PollingStation> {
    return this.stations.get(p.id);
  }

  @RequirePermission('reference.edit')
  @Post('polling-stations')
  createStation(@CurrentAuth() auth: AuthContext, @Body() dto: CreatePollingStationDto): Promise<PollingStation> {
    return this.stations.create(auth.tenantId, dto);
  }

  @RequirePermission('reference.edit')
  @Patch('polling-stations/:id')
  updateStation(@CurrentAuth() auth: AuthContext, @Param() p: IdParamDto, @Body() dto: UpdatePollingStationDto): Promise<PollingStation> {
    return this.stations.update(auth.tenantId, p.id, dto);
  }

  /* ------------------------------ Tally centres ----------------------------- */

  @RequirePermission('reference.view')
  @Get('tally-centres')
  listTallyCentres(@Query() q: TallyCentreQueryDto): Promise<Paginated<TallyCentre>> {
    return this.tallyCentres.list(q);
  }

  @RequirePermission('reference.edit')
  @Post('tally-centres')
  createTallyCentre(@CurrentAuth() auth: AuthContext, @Body() dto: CreateTallyCentreDto): Promise<TallyCentre> {
    return this.tallyCentres.create(auth.tenantId, dto);
  }

  @RequirePermission('reference.edit')
  @Patch('tally-centres/:id')
  updateTallyCentre(@CurrentAuth() auth: AuthContext, @Param() p: IdParamDto, @Body() dto: UpdateTallyCentreDto): Promise<TallyCentre> {
    return this.tallyCentres.update(auth.tenantId, p.id, dto);
  }

  /* -------------------------- Contests and candidates ----------------------- */

  @RequirePermission('reference.view')
  @Get('contests')
  listContests(@Query() q: ContestQueryDto): Promise<Paginated<Contest>> {
    return this.contests.list(q);
  }

  @RequirePermission('reference.view')
  @Get('contests/:id')
  getContest(@Param() p: IdParamDto): Promise<Contest & { candidates: CandidateReference[] }> {
    return this.contests.get(p.id);
  }

  @RequirePermission('reference.edit')
  @Post('contests')
  createContest(@CurrentAuth() auth: AuthContext, @Body() dto: CreateContestDto): Promise<Contest> {
    return this.contests.create(auth.tenantId, dto);
  }

  @RequirePermission('reference.edit')
  @Patch('contests/:id')
  updateContest(@CurrentAuth() auth: AuthContext, @Param() p: IdParamDto, @Body() dto: UpdateContestDto): Promise<Contest> {
    return this.contests.update(auth.tenantId, p.id, dto);
  }

  @RequirePermission('reference.view')
  @Get('contests/:id/candidates')
  listCandidates(@Param() p: IdParamDto): Promise<CandidateReference[]> {
    return this.contests.candidates(p.id);
  }

  @RequirePermission('reference.edit')
  @Post('contests/:id/candidates')
  addCandidate(@CurrentAuth() auth: AuthContext, @Param() p: IdParamDto, @Body() dto: CreateCandidateDto): Promise<CandidateReference> {
    return this.contests.addCandidate(auth.tenantId, p.id, dto);
  }

  @RequirePermission('reference.edit')
  @Patch('candidates/:id')
  updateCandidate(@CurrentAuth() auth: AuthContext, @Param() p: IdParamDto, @Body() dto: UpdateCandidateDto): Promise<CandidateReference> {
    return this.contests.updateCandidate(auth.tenantId, p.id, dto);
  }
}
