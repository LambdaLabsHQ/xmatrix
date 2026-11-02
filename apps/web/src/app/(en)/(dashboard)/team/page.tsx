import { redirect } from "next/navigation";

export default function TeamPage() {
  redirect("/app?view=team");
}
