import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  type BudgetLine,
  type CampaignFile,
  type ContributionSource,
  type FinanceAccount,
  type FinanceCategory,
  type FinanceDocument,
  type FinanceLedgerSummary,
  type FinancePayee,
  type FinanceTransactionDetail,
  type FinanceTransactionSummary,
  MAX_CAMPAIGN_FILE_BYTES,
  type Paginated,
  type SignedUrlResponse,
} from '@ngao360/shared';
import type { AuthContext } from '../../../auth/auth.types';
import { CurrentAuth } from '../../../common/decorators/auth.decorators';
import { PrismaService } from '../../../prisma/prisma.service';
import { RequirePermission, RequireReauth } from '../../../rbac/require-permission.decorator';
import { RequireModule } from '../../../tenant-modules/require-module.decorator';
import {
  AddFinanceDocumentDto,
  BudgetLineQueryDto,
  CampaignIdParamDto,
  ContributionSourceQueryDto,
  CreateFinanceTransactionDto,
  DocumentParamDto,
  ExpectedVersionBodyDto,
  FinanceExportRequestDto,
  FinanceLedgerQueryDto,
  FinanceTransactionQueryDto,
  FinanceTransitionDto,
  PaginationQueryDto,
  ReverseFinanceTransactionDto,
  SaveBudgetLineDto,
  SaveContributionSourceDto,
  SaveFinanceAccountDto,
  SaveFinanceCategoryDto,
  SaveFinancePayeeDto,
  UpdateFinanceAccountDto,
  UpdateFinanceTransactionDto,
  VersionReasonBodyDto,
} from '../campaign.dto';
import type { CampaignUpload } from '../common';
import { FinanceSettingsService } from './finance-settings.service';
import { FinanceService } from './finance.service';

/**
 * S10 finance ledger (docs/API_CONTRACT.md §27.1–27.5): ledger summary, transactions with
 * request → approve → pay and reversals, documents, exports, accounts, categories, payees,
 * contribution sources and budget lines. Own permission family (`finance.*`), organisation-level.
 */
@RequireModule('campaign')
@Controller('finance')
export class FinanceController {
  constructor(
    private readonly service: FinanceService,
    private readonly settings: FinanceSettingsService,
    private readonly prisma: PrismaService,
  ) {}

  @RequirePermission('finance.view')
  @Get('ledger')
  ledger(@CurrentAuth() auth: AuthContext, @Query() q: FinanceLedgerQueryDto): Promise<FinanceLedgerSummary> {
    return this.service.ledger(auth, q);
  }

  @RequirePermission('finance.request')
  @Post('files')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_CAMPAIGN_FILE_BYTES, files: 1 } }))
  upload(@CurrentAuth() auth: AuthContext, @UploadedFile() file: CampaignUpload | undefined): Promise<CampaignFile> {
    return this.service.upload(auth, file);
  }

  @RequirePermission('finance.view')
  @Get('transactions')
  list(@CurrentAuth() auth: AuthContext, @Query() q: FinanceTransactionQueryDto): Promise<Paginated<FinanceTransactionSummary>> {
    return this.service.list(auth, q);
  }

  @RequirePermission('finance.view')
  @Get('transactions/:id')
  get(@CurrentAuth() auth: AuthContext, @Param() p: CampaignIdParamDto): Promise<FinanceTransactionDetail> {
    return this.service.get(auth, p.id);
  }

  @RequirePermission('finance.request')
  @Post('transactions')
  create(@CurrentAuth() auth: AuthContext, @Body() body: CreateFinanceTransactionDto): Promise<FinanceTransactionDetail> {
    return this.service.create(auth, body);
  }

  @RequirePermission('finance.request')
  @Patch('transactions/:id')
  update(@CurrentAuth() auth: AuthContext, @Param() p: CampaignIdParamDto, @Body() body: UpdateFinanceTransactionDto): Promise<FinanceTransactionDetail> {
    return this.service.update(auth, p.id, body);
  }

  @RequirePermission('finance.request')
  @Post('transactions/:id/documents')
  addDocument(@CurrentAuth() auth: AuthContext, @Param() p: CampaignIdParamDto, @Body() body: AddFinanceDocumentDto): Promise<FinanceDocument> {
    return this.service.addDocument(auth, p.id, body);
  }

  @RequirePermission('finance.view')
  @Get('transactions/:id/documents/:documentId/url')
  documentUrl(@CurrentAuth() auth: AuthContext, @Param() p: DocumentParamDto): Promise<SignedUrlResponse> {
    return this.service.documentUrl(auth, p.id, p.documentId);
  }

  /** Per action (service): SUBMIT finance.request; APPROVE / REJECT finance.approve; PAY finance.pay; APPROVE and PAY re-authenticated. */
  @RequirePermission(['finance.request', 'finance.approve', 'finance.pay'], { anyOf: true })
  @HttpCode(200)
  @Post('transactions/:id/transition')
  transition(@CurrentAuth() auth: AuthContext, @Param() p: CampaignIdParamDto, @Body() body: FinanceTransitionDto): Promise<FinanceTransactionDetail> {
    return this.service.transition(auth, p.id, body);
  }

  @RequirePermission('finance.reverse')
  @RequireReauth()
  @Post('transactions/:id/reverse')
  reverse(@CurrentAuth() auth: AuthContext, @Param() p: CampaignIdParamDto, @Body() body: ReverseFinanceTransactionDto): Promise<FinanceTransactionDetail> {
    return this.service.reverse(auth, p.id, body);
  }

  @RequirePermission(['finance.export', 'reports.export_sensitive'])
  @RequireReauth()
  @HttpCode(200)
  @Post('exports')
  exportRegister(@CurrentAuth() auth: AuthContext, @Body() body: FinanceExportRequestDto): Promise<SignedUrlResponse> {
    return this.service.exportRegister(auth, body);
  }

  /* ------------------------------------------------------------ accounts */

  @RequirePermission('finance.view')
  @Get('accounts')
  accounts(): Promise<FinanceAccount[]> {
    return this.prisma.tenantTx((tx) => this.service.accounts(tx));
  }

  @RequirePermission('finance.settings.manage')
  @RequireReauth()
  @Post('accounts')
  createAccount(@CurrentAuth() auth: AuthContext, @Body() body: SaveFinanceAccountDto): Promise<FinanceAccount> {
    return this.settings.createAccount(auth, body);
  }

  @RequirePermission('finance.settings.manage')
  @RequireReauth()
  @Patch('accounts/:id')
  updateAccount(@CurrentAuth() auth: AuthContext, @Param() p: CampaignIdParamDto, @Body() body: UpdateFinanceAccountDto): Promise<FinanceAccount> {
    return this.settings.updateAccount(auth, p.id, body);
  }

  /* ---------------------------------------------------------- categories */

  @RequirePermission('finance.view')
  @Get('categories')
  categories(): Promise<FinanceCategory[]> {
    return this.settings.listCategories();
  }

  @RequirePermission('finance.settings.manage')
  @Post('categories')
  createCategory(@CurrentAuth() auth: AuthContext, @Body() body: SaveFinanceCategoryDto): Promise<FinanceCategory> {
    return this.settings.saveCategory(auth, body);
  }

  @RequirePermission('finance.settings.manage')
  @Patch('categories/:id')
  updateCategory(@CurrentAuth() auth: AuthContext, @Param() p: CampaignIdParamDto, @Body() body: SaveFinanceCategoryDto): Promise<FinanceCategory> {
    return this.settings.saveCategory(auth, body, p.id);
  }

  /* -------------------------------------------------------------- payees */

  @RequirePermission('finance.view')
  @Get('payees')
  payees(@Query() q: PaginationQueryDto): Promise<Paginated<FinancePayee>> {
    return this.settings.listPayees(q);
  }

  @RequirePermission('finance.request')
  @Post('payees')
  createPayee(@CurrentAuth() auth: AuthContext, @Body() body: SaveFinancePayeeDto): Promise<FinancePayee> {
    return this.settings.savePayee(auth, body);
  }

  @RequirePermission('finance.request')
  @Patch('payees/:id')
  updatePayee(@CurrentAuth() auth: AuthContext, @Param() p: CampaignIdParamDto, @Body() body: SaveFinancePayeeDto): Promise<FinancePayee> {
    return this.settings.savePayee(auth, body, p.id);
  }

  /* ------------------------------------------------- contribution sources */

  @RequirePermission('finance.view')
  @Get('contribution-sources')
  sources(@Query() q: ContributionSourceQueryDto): Promise<Paginated<ContributionSource>> {
    return this.settings.listSources(q);
  }

  @RequirePermission('finance.request')
  @Post('contribution-sources')
  createSource(@CurrentAuth() auth: AuthContext, @Body() body: SaveContributionSourceDto): Promise<ContributionSource> {
    return this.settings.saveSource(auth, body);
  }

  @RequirePermission('finance.request')
  @Patch('contribution-sources/:id')
  updateSource(@CurrentAuth() auth: AuthContext, @Param() p: CampaignIdParamDto, @Body() body: SaveContributionSourceDto): Promise<ContributionSource> {
    return this.settings.saveSource(auth, body, p.id);
  }

  /* --------------------------------------------------------- budget lines */

  @RequirePermission('finance.view')
  @Get('budget-lines')
  budgetLines(@Query() q: BudgetLineQueryDto): Promise<BudgetLine[]> {
    return this.settings.listBudgetLines(q);
  }

  @RequirePermission('finance.request')
  @Post('budget-lines')
  createBudgetLine(@CurrentAuth() auth: AuthContext, @Body() body: SaveBudgetLineDto): Promise<BudgetLine> {
    return this.settings.saveBudgetLine(auth, body);
  }

  @RequirePermission('finance.request')
  @Patch('budget-lines/:id')
  updateBudgetLine(@CurrentAuth() auth: AuthContext, @Param() p: CampaignIdParamDto, @Body() body: SaveBudgetLineDto): Promise<BudgetLine> {
    return this.settings.saveBudgetLine(auth, body, p.id);
  }

  @RequirePermission('finance.approve')
  @RequireReauth()
  @HttpCode(200)
  @Post('budget-lines/:id/approve')
  approveBudgetLine(@CurrentAuth() auth: AuthContext, @Param() p: CampaignIdParamDto, @Body() body: ExpectedVersionBodyDto): Promise<BudgetLine> {
    return this.settings.approveBudgetLine(auth, p.id, body.expectedVersion);
  }

  @RequirePermission('finance.approve')
  @HttpCode(200)
  @Post('budget-lines/:id/close')
  closeBudgetLine(@CurrentAuth() auth: AuthContext, @Param() p: CampaignIdParamDto, @Body() body: VersionReasonBodyDto): Promise<BudgetLine> {
    return this.settings.closeBudgetLine(auth, p.id, body.expectedVersion, body.reason);
  }
}
