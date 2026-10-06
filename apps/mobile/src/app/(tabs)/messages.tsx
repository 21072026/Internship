import { WebScreen } from '../../components/WebScreen';

// Web for now; native inbox + thread is the next slice of #2775.
export default function MessagesTab() {
  return <WebScreen path="/messages" />;
}
