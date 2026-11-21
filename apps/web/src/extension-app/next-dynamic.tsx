/** `next/dynamic` for the bundled app: the same split, loaded from the extension's own files on first use. */
import { Suspense, lazy, type ComponentType } from "react";

type Loaded<Props> = ComponentType<Props> | { default: ComponentType<Props> };

export default function dynamic<Props extends object>(
  load: () => Promise<Loaded<Props>>,
  options: { ssr?: boolean; loading?: () => React.ReactNode } = {},
): ComponentType<Props> {
  const Lazy = lazy(async () => {
    const loaded = await load();
    // A module, or the component a loader picked out of one (which may be a memo object, not a function).
    return { default: typeof loaded === "object" && "default" in loaded ? loaded.default : loaded as ComponentType<Props> };
  });
  const Loading = options.loading;
  return function Dynamic(props: Props) {
    return <Suspense fallback={Loading ? <Loading /> : null}><Lazy {...(props as Props & React.JSX.IntrinsicAttributes)} /></Suspense>;
  };
}
