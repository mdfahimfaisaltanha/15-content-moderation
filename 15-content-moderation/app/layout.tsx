import type { Metadata } from "next"
import "./globals.css"

export const metadata: Metadata = {
  title: "Sentinel — Content Moderation Pipeline",
  description:
    "Two-stage content moderation: deterministic rules + LLM classifier, threshold routing, and a human review queue with a full audit trail.",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
