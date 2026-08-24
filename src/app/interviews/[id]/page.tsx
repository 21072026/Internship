import { InterviewPanelView } from '@/components/InterviewPanelView';

export default async function InterviewPanelPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <InterviewPanelView panelId={id} />;
}
