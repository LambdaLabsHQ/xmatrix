import { BrandMark } from "@/components/shared/brand-mark";
import { WoodPanel } from "@/components/ui/material-surfaces";

const links = {
  Product: [
    { label: "Online App", href: "/app" },
    { label: "Download", href: "/download" },
    { label: "Setup", href: "/#how-it-works" },
    { label: "Pricing", href: "/#pricing" },
    { label: "Docs", href: "/docs" },
    { label: "Console", href: "/console" },
    { label: "Sign In", href: "/login" },
  ],
  Legal: [
    { label: "Privacy Policy", href: "/privacy" },
    { label: "Terms of Service", href: "/terms" },
    { label: "Cookies and Storage", href: "/cookies" },
    { label: "Subprocessors", href: "/subprocessors" },
  ],
};

export function Footer() {
  return (
    <WoodPanel as="footer" className="site-footer pt-16 pb-8">

      <div className="relative z-10 mx-auto max-w-6xl px-6">
        <div className="grid gap-12 border-b border-border pb-16 md:grid-cols-[1.5fr_1fr]">
          <div className="space-y-4">
            <BrandMark iconClassName="size-10" wordmarkClassName="text-xl" />
            <p className="max-w-xs text-sm leading-relaxed text-muted-foreground/80">
              The shared workspace where people and AI agents coordinate real engineering work
              across tools, machines, and repositories.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-8 sm:grid-cols-3">
            {Object.entries(links).map(([category, items]) => (
              <div key={category} className="space-y-4">
                <h4 className="text-sm font-bold text-foreground">{category}</h4>
                <ul className="space-y-3">
                  {items.map((item) => (
                    <li key={item.label}>
                      <a
                        href={item.href}
                        className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                      >
                        {item.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-8 flex flex-col items-center justify-between gap-4 sm:flex-row">
          <p className="text-xs text-muted-foreground/60">
            &copy; {new Date().getFullYear()} MadeByRobot, LLC. xMatrix and its related marks are reserved.
          </p>
          <div className="flex items-center gap-4">
             {/* Optional: Add social links here in the future */}
             <div className="size-1.5 rounded-full bg-primary/50 shadow-[0_0_18px_rgba(255,255,255,0.35)]" />
             <span className="text-xs font-medium text-muted-foreground/40">Built for coordinated agent work</span>
          </div>
        </div>
      </div>
    </WoodPanel>
  );
}
