import { Mail } from "lucide-react";
import { cn } from "@/lib/utils";

export function PrivateSignInEmail({ email, className, labelClassName, emailClassName }: {
  email: string;
  className: string;
  labelClassName?: string;
  emailClassName: string;
}) {
  return (
    <div className={className}>
      <Mail className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs font-bold text-foreground">Sign-in email</p>
          <span className={cn(labelClassName, "app-paper-tag px-1.5 py-0.5 text-[11px] font-semibold text-muted-foreground")}>
            Private
          </span>
        </div>
        <p className={emailClassName}>{email}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Used for sign-in and account security. Not visible to collaborators.
        </p>
      </div>
    </div>
  );
}
