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
        /**
         * The MCP endpoint, served from this product's own domain.
         *
         * A rewrite and not a redirect: the chat client sees one URL and never
         * learns the origin. Nothing about the server moves — no DNS record, no
         * certificate, no nginx change — and the old
         * `survivorsbyashborn.com/ghostpool/mcp/…` path keeps working, so every
         * URL already pasted into a chat client survives this. Only newly issued
         * ones carry the new host.
         *
         * WHY IT IS SAFE HERE AND NOT ELSEWHERE. The MCP route carries no CORS
         * by design — it is fetched by a chat client's servers rather than by a
         * browser — so proxying it adds no header surface. It is bearer-token
         * authenticated in the path, and the token is sealed server-side; this
         * hop reads none of it.
         *
         * THE COST, STATED: one more hop in front of a call that can take a
         * minute. nginx already carries `proxy_read_timeout 300s` for exactly
         * that reason. If a long deposit is ever cut off here and not there,
         * this rewrite is the difference — and the fix is a subdomain pointed at
         * the origin, which removes the hop entirely.
         */
        {
          source: "/mcp/:path*",
          destination: "https://survivorsbyashborn.com/ghostpool/mcp/:path*",
        },
      ],
    };
  },
};
export default nextConfig;
