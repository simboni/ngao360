/**
 * Notification centre API client (API §7 extended by §29). Notifications go
 * to signed-in users about their own work; there is no public or bulk channel.
 */
import type {
  AcknowledgeNotification,
  NotificationAcknowledgement,
  NotificationCenterItem,
  NotificationCenterQuery,
  NotificationCounts,
  NotificationDelivery,
  NotificationPreferences,
  OkResponse,
  Paginated,
  UpdateNotificationPreferences,
} from '@ngao360/shared';
import { api } from '@/lib/api-client';

type Q = Record<string, string | number | boolean | string[] | undefined>;

export const notificationsApi = {
  list: (q: Partial<NotificationCenterQuery>) => api.get<Paginated<NotificationCenterItem>>('/notifications', { query: q as Q }),
  counts: () => api.get<NotificationCounts>('/notifications/counts'),
  markRead: (id: string) => api.post<OkResponse>(`/notifications/${id}/read`),
  markAllRead: () => api.post<OkResponse>('/notifications/read-all'),
  acknowledge: (id: string, body: AcknowledgeNotification) => api.post<NotificationCenterItem>(`/notifications/${id}/acknowledge`, body),
  acknowledgements: (id: string) => api.get<NotificationAcknowledgement[]>(`/notifications/${id}/acknowledgements`),
  preferences: () => api.get<NotificationPreferences>('/notifications/preferences'),
  savePreferences: (body: UpdateNotificationPreferences) => api.put<NotificationPreferences>('/notifications/preferences', body),
  deliveries: (q: { page?: number; pageSize?: number } = {}) => api.get<Paginated<NotificationDelivery>>('/notifications/deliveries', { query: q }),
};
