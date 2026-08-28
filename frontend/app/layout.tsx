import type { Metadata } from "next";
import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "GhostPool — confidential prize savings",
  description: "No-loss prize savings where balances, weights and outcomes stay encrypted.",
};

// Fully client-rendered: wallet plus FHE SDK. Render on demand rather than
// prerendering at build time.
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
