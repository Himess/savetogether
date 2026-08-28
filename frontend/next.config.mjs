/** @type {import('next').NextConfig} */
const nextConfig = {
  turbopack: { root: import.meta.dirname },
  reactStrictMode: false, // FHE SDK/worker init is not double-invoke friendly in dev // lint config noise (tsconfig include) — types are checked separately
};
export default nextConfig;
