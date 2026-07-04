import { redirect } from "next/navigation";

// Merged into the combined page — keep old links working.
export default function OutcomeMathRedirect() {
  redirect("/exit-reference");
}
