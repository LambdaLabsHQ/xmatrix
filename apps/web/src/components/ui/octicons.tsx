import type { SVGProps } from "react";

import { cn } from "@/lib/utils";

/**
 * GitHub's own marks, vendored from primer/octicons (MIT) rather than
 * approximated from the icon set the rest of the UI uses: these are the glyphs
 * developers already read as "branch" and "repository", and a near-miss outline
 * reads as a generic curve or a plain folder at 16px.
 *
 * Source: https://github.com/primer/octicons
 */
function Octicon({ name, path, className, ...props }: SVGProps<SVGSVGElement> & {
  /** Octicon file name, minus the size suffix. */
  name: string;
  path: string;
}) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className={cn(`octicon-${name}`, className)}
      {...props}
    >
      <path d={path} />
    </svg>
  );
}

/** icons/repo-16.svg — a repository is not a folder, so it does not get a folder. */
export function RepoOcticon(props: SVGProps<SVGSVGElement>) {
  return (
    <Octicon
      name="repo"
      path="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z"
      {...props}
    />
  );
}
