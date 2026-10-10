import { Input } from "@/components/ui/input";

export function DeletionConfirmationFields({
  email, confirmation, acknowledge, acknowledgement,
  onEmailChange, onConfirmationChange, onAcknowledgeChange,
}: {
  email: string;
  confirmation: string;
  acknowledge: boolean;
  acknowledgement: string;
  onEmailChange: (value: string) => void;
  onConfirmationChange: (value: string) => void;
  onAcknowledgeChange: (value: boolean) => void;
}) {
  return <>
    <label className="block">Account email<Input className="mt-1" type="email" autoComplete="off" value={email} onChange={event=>onEmailChange(event.target.value)} /></label>
    <label className="block">Type DELETE<Input className="mt-1" autoComplete="off" value={confirmation} onChange={event=>onConfirmationChange(event.target.value)} /></label>
    <label className="flex items-start gap-3"><input type="checkbox" checked={acknowledge} onChange={event=>onAcknowledgeChange(event.target.checked)} /><span>{acknowledgement}</span></label>
  </>;
}
