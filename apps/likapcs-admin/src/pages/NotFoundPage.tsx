import { Link } from 'react-router-dom';
import { Compass } from 'lucide-react';
import { useI18n } from '../i18n';
import { Card, EmptyState } from '../components/ui/primitives';

export function NotFoundPage() {
  const { t } = useI18n();
  return (
    <Card>
      <EmptyState
        icon={<Compass size={24} />}
        title="404"
        hint={t('common.noResults')}
        action={
          <Link to="/" className="btn btn--primary">
            {t('nav.dashboard')}
          </Link>
        }
      />
    </Card>
  );
}
