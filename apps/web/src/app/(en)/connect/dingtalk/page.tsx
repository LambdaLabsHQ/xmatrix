import type { Metadata } from 'next';
import { DingTalkInstallationConfirmation } from '@/components/connect/dingtalk-installation-confirmation';
export const dynamic = 'force-dynamic';
export const metadata: Metadata = {title:'Connect DingTalk · xMatrix',referrer:'no-referrer'};
export default function DingTalkInstallationPage() {return <DingTalkInstallationConfirmation />;}
