import { BreachRegister } from '@/components/security/breach-register';
import { RequirePagePermission } from '@/components/ui/permission-gate';

export const metadata = { title: 'Breach register' };

/** Data breach register: breaches and drills (blueprint 15.4). API §30. */
export default function BreachRegisterPage() {
  return (
    <RequirePagePermission anyOf={['security.breach.view']}>
      <BreachRegister />
    </RequirePagePermission>
  );
}
