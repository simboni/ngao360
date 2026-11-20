import { Suspense } from 'react';
import { AppointmentsDiary } from '@/components/office/appointments/appointments-diary';
import { RequirePagePermission } from '@/components/ui/permission-gate';

export const metadata = { title: 'Appointments' };

/** Appointments diary and meetings (blueprint 9.1). API §10. */
export default function AppointmentsPage() {
  return (
    <RequirePagePermission anyOf={['office.appointments.view', 'office.meetings.view']}>
      <Suspense>
        <AppointmentsDiary />
      </Suspense>
    </RequirePagePermission>
  );
}
