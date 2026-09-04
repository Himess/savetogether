/** @type {import('next').NextConfig} */
const nextConfig = {
  turbopack: { root: import.meta.dirname },
  reactStrictMode: false, // FHE SDK/worker init is not double-invoke friendly in dev // lint config noise (tsconfig include) — types are checked separately

  /**
   * The deck gets its own domain.
   *
   * `savetogether-deck.vercel.app` and the app share one deployment — a second
   * Vercel project for one static file would be a second thing to deploy, and it
   * would drift. A host condition is enough: on that hostname `/` serves the deck,
   * everywhere else `/` serves the app, and `/deck.html` keeps working on both so
   * no existing link breaks.
   *
   * This lives here rather than in vercel.json because for a Next.js project the
   * framework's rewrites are the ones that run; a vercel.json copy was silently
   * ignored and the deck domain served the app.
   */
  async rewrites() {
    // `beforeFiles`, NOT a bare array. A bare array is `afterFiles`, which runs
    // after filesystem routes — and `/` already matches app/page.tsx, so the
    // rewrite never fired and the deck domain quietly served the app. This runs
    // first. Cost an extra deploy to find, because both pages return 200.
    return {
      beforeFiles: [
        {
          source: "/",
          has: [{ type: "host", value: "savetogether-deck.vercel.app" }],
          destination: "/deck.html",
        },
      ],
    };
  },
};
export default nextConfig;
