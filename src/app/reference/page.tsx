import { redirect } from "next/navigation";

// Merged into the combined page — keep old links working.
export default function ReferenceRedirect() {
  redirect("/exit-reference");
}
