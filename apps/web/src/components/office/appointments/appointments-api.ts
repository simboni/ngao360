/**
 * Appointments and meetings API calls (docs/API_CONTRACT.md §10). Types come
 * from @ngao360/shared; the API enforces permissions and transitions.
 */
import type {
  AppointmentDetail,
  AppointmentQuery,
  AppointmentSummary,
  AppointmentTransition,
  CreateAppointment,
  CreateMeeting,
  MeetingActionItem,
  MeetingDecision,
  MeetingDetail,
  MeetingQuery,
  MeetingSummary,
  Paginated,
  RecordMeetingDecision,
  SaveMeetingActionItem,
  UpdateAppointment,
  UpdateMeeting,
} from '@ngao360/shared';
import { api } from '@/lib/api-client';

const a = (id: string) => `/office/appointments/${encodeURIComponent(id)}`;
const m = (id: string) => `/office/meetings/${encodeURIComponent(id)}`;

type Q<T> = Partial<Omit<T, 'page' | 'pageSize'>> & { page?: number; pageSize?: number };

export const appointmentsApi = {
  list: (query: Q<AppointmentQuery>) => api.get<Paginated<AppointmentSummary>>('/office/appointments', { query: query as Record<string, string | number | undefined> }),
  get: (id: string) => api.get<AppointmentDetail>(a(id)),
  create: (body: CreateAppointment) => api.post<AppointmentDetail>('/office/appointments', body),
  update: (id: string, body: UpdateAppointment) => api.patch<AppointmentDetail>(a(id), body),
  transition: (id: string, body: AppointmentTransition) => api.post<AppointmentDetail>(`${a(id)}/transition`, body),
};

export const meetingsApi = {
  list: (query: Q<MeetingQuery>) => api.get<Paginated<MeetingSummary>>('/office/meetings', { query: query as Record<string, string | number | undefined> }),
  get: (id: string) => api.get<MeetingDetail>(m(id)),
  create: (body: CreateMeeting) => api.post<MeetingDetail>('/office/meetings', body),
  update: (id: string, body: UpdateMeeting) => api.patch<MeetingDetail>(m(id), body),
  addActionItem: (id: string, body: SaveMeetingActionItem) => api.post<MeetingActionItem>(`${m(id)}/action-items`, body),
  updateActionItem: (id: string, itemId: string, body: SaveMeetingActionItem) =>
    api.patch<MeetingActionItem>(`${m(id)}/action-items/${encodeURIComponent(itemId)}`, body),
  recordDecision: (id: string, body: RecordMeetingDecision) => api.post<MeetingDecision>(`${m(id)}/decisions`, body),
};
