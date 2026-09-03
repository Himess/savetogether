import type { Metadata } from "next";
import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "SaveTogether — confidential prize savings",
  description:
    "Zama shipped confidential yield. We turned that yield into a prize — and hid the winner and the odds.",
  // AB. The mark is a ticket with a smile and three redacted bars, which is the
  // product: a lottery whose entries are unreadable. `favicon.ico` carries the
  // multi-size raster for browsers that still ask for it; the PNGs cover the rest.
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon-16.png", type: "image/png", sizes: "16x16" },
      { url: "/favicon-32.png", type: "image/png", sizes: "32x32" },
      { url: "/favicon-64.png", type: "image/png", sizes: "64x64" },
      { url: "/savetogether-mark-512.png", type: "image/png", sizes: "512x512" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
  openGraph: {
    title: "SaveTogether — confidential prize savings",
    description:
      "Zama shipped confidential yield. We turned that yield into a prize — and hid the winner and the odds.",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "SaveTogether — confidential prize savings",
    description:
      "Zama shipped confidential yield. We turned that yield into a prize — and hid the winner and the odds.",
  },
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
