import { redirect } from "next/navigation";

export default function AgentsPage() {
  redirect("/app?view=agents");
}
