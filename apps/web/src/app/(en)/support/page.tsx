import Link from "next/link";

import { Footer } from "@/components/landing/footer";
import { Navbar } from "@/components/shared/navbar";
import { sitePageMetadata } from "@/lib/site-metadata";

export const metadata = sitePageMetadata(
  "/support",
  "Support — xMatrix",
  "Ask a question, report a problem, or get help with your xMatrix account, subscription, apps and connected agents.",
);

export default function SupportPage() {
  return (
    <div className="site-page">
      <Navbar />
      <main className="mx-auto max-w-3xl px-6 pb-20 pt-32">
        <article className="page-document" data-editable="false">
          <h1>Support</h1>
          <p>
            Need help with xMatrix? Contact the team at MadeByRobot, LLC for questions,
            account or subscription help, or to report a problem with the app.
          </p>
          <h2>Contact us</h2>
          <p>
            Email <a href="mailto:hello@xmatrix.sh?subject=xMatrix%20support">hello@xmatrix.sh</a>.
            You can contact us without signing in to xMatrix.
          </p>
          <p>
            For a problem with the app, include your device, operating system and
            xMatrix version, what you were trying to do, and what happened. A screenshot
            or the steps to reproduce the problem can help. Leave passwords, verification
            codes and private workspace content out of your message.
          </p>
          <h2>Setup and everyday use</h2>
          <p>
            The <Link href="/docs">user guide</Link> explains how to set up xMatrix,
            connect agents and apps, and work with Conversations and Pages. If the guide
            does not answer your question, email us using the address above.
          </p>
          <h2>Subscriptions and purchases</h2>
          <p>
            For a purchase made through Apple, manage or cancel it in your device’s
            Settings under your Apple Account’s Subscriptions. In xMatrix, use Restore
            purchases on the Billing settings screen to check an existing purchase.
            Email us if your plan or access still looks wrong.
          </p>
        </article>
      </main>
      <Footer />
    </div>
  );
}
