import Image from "next/image";
import Link from "next/link";
import { cn } from "@/lib/utils";

type BrandMarkProps = {
  href?: string;
  showWordmark?: boolean;
  className?: string;
  iconClassName?: string;
  iconSrc?: string;
  wordmarkClassName?: string;
};

export function BrandMark({
  href,
  showWordmark = true,
  className,
  iconClassName,
  iconSrc = "/brand/xmatrix-icon.png",
  wordmarkClassName,
}: BrandMarkProps) {
  const content = (
    <>
      <span
        className={cn(
          "relative flex size-9 shrink-0 items-center justify-center overflow-hidden",
          iconClassName
        )}
      >
        <Image
          src={iconSrc}
          alt=""
          width={96}
          height={96}
          sizes="40px"
          className="size-full object-cover"
          priority
        />
      </span>
      {showWordmark && (
        <span
          className={cn(
            "text-lg font-semibold tracking-tight text-foreground",
            wordmarkClassName
          )}
        >
          xMatrix
        </span>
      )}
    </>
  );

  const classes = cn("inline-flex items-center gap-2.5", className);

  if (href) {
    return (
      <Link href={href} className={classes} aria-label="xMatrix home">
        {content}
      </Link>
    );
  }

  return <div className={classes}>{content}</div>;
}
