import { WebScreen } from '../../components/WebScreen';
import { strings } from '../../lib/i18n';
import { useWebHeader } from '../../lib/useWebHeader';

// Web for now; native to-dos are a later slice of #2775. The tab header takes
// the page's colours so a dark page never sits under a white bar.
export default function TodosTab() {
  const onMeta = useWebHeader(strings().tabs.todos);
  return <WebScreen path="/todos" onMeta={onMeta} />;
}
