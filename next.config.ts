import type { NextConfig } from "next";

// When deploying to a GitHub Pages project page (username.github.io/repo-name)
// set BASE_PATH=/repo-name in the build environment.
// Leave it unset (or empty) for Cloudflare Pages, Vercel, or a custom domain.
const basePath = process.env.BASE_PATH || "";

const nextConfig: NextConfig = {
  output: "export",
  basePath,
  assetPrefix: basePath,
  images: { unoptimized: true },
  // NOTE: headers() is ignored in static export mode — HTTP security headers
  // (CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy)
  // MUST be set at the hosting layer (Cloudflare, Vercel, nginx, etc.).
  // For the embed iframe use case, set "X-Frame-Options: ALLOWALL" or
  // "Content-Security-Policy: frame-ancestors *" at the CDN/host level.
};

export default nextConfig;
