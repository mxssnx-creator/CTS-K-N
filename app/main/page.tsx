import { redirect } from "next/navigation"

// The Command Center lives at "/"; keep the documented /main route reachable.
export default function MainPage() {
  redirect("/")
}
