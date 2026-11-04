import Image from "next/image";

/** DONADS brand mark: the approved mascot tile, followed by the wordmark. */
export function DonadsLogo({ markSize = 24, textClassName = "text-foreground" }: { markSize?: number; textClassName?: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <Image src="/brand/donads-mascot-tile.png" alt="" width={markSize} height={markSize} className="rounded-md" priority />
      <span className={`font-sans text-sm font-semibold tracking-[0.06em] ${textClassName}`}>DONADS</span>
    </span>
  );
}
