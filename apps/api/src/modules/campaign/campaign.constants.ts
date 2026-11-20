/**
 * Campaign and organisation: geo resolver kinds registered by CampaignModule,
 * audit entity type names and storage purposes.
 */

/**
 * GeoScopeService kinds. Campaign records are visible by the department-scope
 * rule (involvement OR department AND geography; common/campaign-scope.ts),
 * which the guard cannot express, so record routes use these kinds only where
 * involvement does not apply (team management, event logistics), e.g.
 * `@RequirePermission('org.teams.manage', { geo: { kind: CAMPAIGN_GEO_KIND.TEAM, from: 'params', key: 'id' } })`.
 * Records without geography resolve to no units (only ORGANISATION-wide grants pass).
 */
export const CAMPAIGN_GEO_KIND = {
  TEAM: 'campaignTeam',
  TASK: 'campaignTask',
  EVENT: 'campaignEvent',
} as const;

/** `entityType` values for audit events. */
export const CAMPAIGN_ENTITY = {
  DEPARTMENT: 'Department',
  TEAM: 'Team',
  TEAM_MEMBER: 'TeamMember',
  TASK: 'Task',
  EVENT: 'CampaignEvent',
  EVENT_LOGISTICS: 'EventLogisticsItem',
  EVENT_ATTENDANCE: 'EventAttendance',
  AFTER_ACTION: 'EventAfterActionReport',
  CONTENT: 'ContentItem',
  FINANCE_ACCOUNT: 'FinanceAccount',
  FINANCE_CATEGORY: 'FinanceCategory',
  FINANCE_PAYEE: 'FinancePayee',
  CONTRIBUTION_SOURCE: 'ContributionSource',
  BUDGET_LINE: 'FinanceBudgetLine',
  FINANCE_TRANSACTION: 'FinanceTransaction',
  FINANCE_LIMIT_SETTING: 'FinanceLimitSetting',
  REPORT_TEMPLATE: 'ReportTemplate',
  REPORT_EXPORT: 'ReportExport',
  NOTIFICATION: 'Notification',
  NOTIFICATION_PREFERENCES: 'NotificationPreferences',
  BREACH: 'BreachRecord',
} as const;

/** `StorageService.storeImmutable` purposes (kept apart per data family, blueprint 15.2). */
export const CAMPAIGN_STORAGE_PURPOSE = {
  TASK: 'TASK_ATTACHMENT',
  EVENT: 'EVENT_DOCUMENT',
  FINANCE: 'FINANCE_DOCUMENT',
  BREACH: 'BREACH_EVIDENCE',
  EXPORT: 'EXPORT',
} as const;
