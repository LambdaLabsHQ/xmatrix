/** A homepage section's heading and the paragraph under it. */
export function SectionIntro({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex flex-col gap-4 lg:max-w-3xl">
      <h2 className="site-display text-3xl font-semibold text-foreground sm:text-5xl lg:text-4xl xl:text-5xl">
        {title}
      </h2>
      <p className="max-w-2xl text-base leading-7 text-muted-foreground">
        {body}
      </p>
    </div>
  );
}
