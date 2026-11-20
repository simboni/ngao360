import { IncidentList } from '@/components/field/incidents/incident-list';
import { RequirePagePermission } from '@/components/ui/permission-gate';

export const metadata = { title: 'Incidents' };

/** Incident desk. API §20. */
export default function IncidentsPage() {
  return (
    <RequirePagePermission anyOf={['field.incidents.view']}>
      <IncidentList />
    </RequirePagePermission>
  );
}
