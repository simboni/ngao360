import { ModulePlaceholder } from '@/components/layout/module-placeholder';

export const metadata = { title: 'Appointments' };

/** Appointments diary and meetings (blueprint 9.1). API §10. Owner: correspondence/appointments agent. */
export default function AppointmentsPage() {
  return (
    <ModulePlaceholder
      title="Appointments and meetings"
      screen="Office diary"
      description="Appointment requests, confirmations and outcomes; meetings with agenda, minutes, action items and decisions."
      breadcrumbs={[{ label: 'Office' }, { label: 'Appointments' }]}
      anyOf={['office.appointments.view', 'office.meetings.view']}
    />
  );
}
