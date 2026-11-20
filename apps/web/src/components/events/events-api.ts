/**
 * Events API client (API §25). Types come from @ngao360/shared.
 */
import type {
  AddEventDocument,
  AttendanceSummary,
  BudgetLine,
  CampaignEventDetail,
  CampaignEventQuery,
  CampaignEventSummary,
  ChangeCampaignEventStatus,
  CreateCampaignEvent,
  CreateLogisticsItem,
  EventAfterActionReport,
  EventAttendance,
  EventAttendanceContact,
  EventDocument,
  EventLogisticsItem,
  OkResponse,
  Paginated,
  RecordAttendance,
  ReviewAfterActionReport,
  SaveAfterActionReport,
  SaveEventAgenda,
  SignedUrlResponse,
  UpdateCampaignEvent,
  UpdateLogisticsItem,
} from '@ngao360/shared';
import { api } from '@/lib/api-client';

type Q = Record<string, string | number | boolean | string[] | undefined>;

/**
 * GET /events/:id/attendance answers `Paginated<EventAttendance>` plus the
 * `AttendanceSummary` (API §25). `summary` is read defensively.
 */
export type AttendancePage = Paginated<EventAttendance> & { summary?: AttendanceSummary };

export const eventsApi = {
  list: (q: Partial<CampaignEventQuery>) => api.get<Paginated<CampaignEventSummary>>('/events', { query: q as Q }),
  get: (id: string) => api.get<CampaignEventDetail>(`/events/${id}`),
  create: (body: CreateCampaignEvent) => api.post<CampaignEventDetail>('/events', body),
  update: (id: string, body: UpdateCampaignEvent) => api.patch<CampaignEventDetail>(`/events/${id}`, body),
  status: (id: string, body: ChangeCampaignEventStatus) => api.post<CampaignEventDetail>(`/events/${id}/status`, body),
  saveAgenda: (id: string, body: SaveEventAgenda) => api.put<CampaignEventDetail>(`/events/${id}/agenda`, body),
  addLogistics: (id: string, body: CreateLogisticsItem) => api.post<EventLogisticsItem>(`/events/${id}/logistics`, body),
  updateLogistics: (id: string, itemId: string, body: UpdateLogisticsItem) => api.patch<EventLogisticsItem>(`/events/${id}/logistics/${itemId}`, body),
  attendance: (id: string, page = 1, pageSize = 50) => api.get<AttendancePage>(`/events/${id}/attendance`, { query: { page, pageSize } }),
  recordAttendance: (id: string, body: RecordAttendance) => api.post<EventAttendance>(`/events/${id}/attendance`, body),
  revealContact: (id: string, attendanceId: string, reason: string) =>
    api.post<EventAttendanceContact>(`/events/${id}/attendance/${attendanceId}/contact`, { reason }),
  eraseContact: (id: string, attendanceId: string, reason: string) => api.post<OkResponse>(`/events/${id}/attendance/${attendanceId}/contact/erase`, { reason }),
  exportAttendance: (id: string, format: 'CSV' | 'PDF', reason: string) => api.post<SignedUrlResponse>(`/events/${id}/attendance/export`, { format, reason }),
  addDocument: (id: string, body: AddEventDocument) => api.post<EventDocument>(`/events/${id}/documents`, body),
  documentUrl: (id: string, documentId: string) => api.get<SignedUrlResponse>(`/events/${id}/documents/${documentId}/url`),
  saveAfterAction: (id: string, body: SaveAfterActionReport, submit: boolean) =>
    api.put<EventAfterActionReport>(`/events/${id}/after-action`, body, { query: submit ? { submit: true } : undefined }),
  reviewAfterAction: (id: string, body: ReviewAfterActionReport) => api.post<EventAfterActionReport>(`/events/${id}/after-action/review`, body),
  /** Finance budget lines of the event (only for holders of `finance.view`). */
  budgetLines: (eventId: string) => api.get<BudgetLine[]>('/finance/budget-lines', { query: { eventId } }),
};
