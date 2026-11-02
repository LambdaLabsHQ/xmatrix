import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function DeletionConfirmationForm({
  email, confirmation, acknowledge, accountEmail, retry, busy, onSubmit,
  onEmailChange, onConfirmationChange, onAcknowledgeChange,
}: {
  email: string;
  confirmation: string;
  acknowledge: boolean;
  accountEmail: string;
  retry: boolean;
  busy: boolean;
  onSubmit: () => Promise<void>;
  onEmailChange: (value: string) => void;
  onConfirmationChange: (value: string) => void;
  onAcknowledgeChange: (value: boolean) => void;
}) {
  const confirmed = acknowledge && confirmation === "DELETE" && email.trim().toLowerCase() === accountEmail.toLowerCase();
  return <form className="space-y-4" onSubmit={event=>{event.preventDefault();void onSubmit();}}>
    {retry && <p>If delivery failed, confirm again to retry the same request. This retains your existing receipt.</p>}
    <label className="block">Account email<Input className="mt-1" type="email" autoComplete="off" value={email} onChange={event=>onEmailChange(event.target.value)} /></label>
    <label className="block">Type DELETE<Input className="mt-1" autoComplete="off" value={confirmation} onChange={event=>onConfirmationChange(event.target.value)} /></label>
    <label className="flex items-start gap-3"><input type="checkbox" checked={acknowledge} onChange={event=>onAcknowledgeChange(event.target.checked)} /><span>{retry ? "I confirm permanent account deletion." : "I understand this is permanent and does not cancel subscription renewal. I will lose access on every device and cannot restore scheduled Spaces or move a subscription by creating another account."}</span></label>
    <Button variant="destructive" disabled={busy || !confirmed} type="submit">{retry ? "Retry same deletion request" : busy ? "Submitting…" : "Permanently delete account"}</Button>
  </form>;
}
