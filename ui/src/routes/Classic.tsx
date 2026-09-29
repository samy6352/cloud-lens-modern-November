import { useParams } from "@tanstack/react-router";
import { ArrowUpRight, Hammer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { screenById } from "@/nav";

/** Screens not yet rebuilt in React open in the classic interface, on the same tab. */
export function ClassicPage() {
  const { screen } = useParams({ from: "/classic/$screen" });
  const target = screenById(screen);
  const href = `/?tab=${encodeURIComponent(screen)}`;

  return (
    <Card className="mx-auto mt-10 max-w-xl p-8 text-center">
      <div className="mx-auto grid size-12 place-items-center rounded-2xl bg-surface-2">
        <Hammer className="size-6 text-muted" />
      </div>
      <h2 className="mt-4 text-lg font-semibold tracking-tight">{target?.label ?? "This screen"} is still in the classic interface</h2>
      <p className="mt-2 text-sm text-muted">
        It is being rebuilt for v3. Until then it opens in the classic CloudLens interface, with the same sign-in and the same data.
      </p>
      <Button asChild variant="primary" className="mt-6">
        <a href={href}>
          Open {target?.label ?? "screen"} <ArrowUpRight />
        </a>
      </Button>
    </Card>
  );
}
