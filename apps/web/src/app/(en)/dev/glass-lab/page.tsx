import { notFound } from "next/navigation";
import { Suspense } from "react";

import GlassLab from "./lab";

/* A design bench for the liquid-glass parameters, never served in production. */
export default function GlassLabPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <Suspense>
      <GlassLab />
    </Suspense>
  );
}
