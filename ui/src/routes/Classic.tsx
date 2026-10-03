import { Navigate, useParams, useSearch } from "@tanstack/react-router";
import { Card } from "@/components/ui/card";
import { screenById } from "@/nav";

/** Preserve bookmarked hand-off URLs without leaving the native application. */
export function ClassicPage() {
  const { screen } = useParams({ from: "/classic/$screen" });
  const target = screenById(screen);
  const search = useSearch({ from: "__root__" });
  if (target) return <Navigate to={target.to} search={search} replace />;

  return (
    <Card className="mx-auto mt-10 max-w-xl p-8 text-center">
      <h2 className="text-lg font-semibold">Unknown screen</h2>
      <p className="mt-2 text-sm text-muted">Choose a screen from the navigation.</p>
    </Card>
  );
}
