import { redirect } from "next/navigation";

export default function LogsPage() {
  redirect("/app?view=activity");
}
