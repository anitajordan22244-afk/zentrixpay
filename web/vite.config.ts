import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { visualizer } from "rollup-plugin-visualizer";
import { buildContentSecurityPolicy } from "./src/lib/contentSecurityPolicy";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiBase = env.VITE_API_URL ?? "";

  // Issue #213: ship a CSP with production builds. Dev mode is left out because
  // Vite's dev client relies on inline scripts that this policy forbids.
  const cspPlugin = {
    name: "zentrixpay-csp",
    apply: "build" as const,
    transformIndexHtml(html: string) {
      const policy = buildContentSecurityPolicy({
        apiBase,
        sentryDsn: env.VITE_SENTRY_DSN,
      });
      return html.replace(
        "<!-- Primary Meta Tags -->",
        `<meta http-equiv="Content-Security-Policy" content="${policy}" />\n    <!-- Primary Meta Tags -->`,
      );
    },
  };

  let catalogUrlPattern: RegExp;
  try {
    if (apiBase) {
      const apiOrigin = new URL(apiBase).origin;
      catalogUrlPattern = new RegExp(
        `^${apiOrigin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/resources`,
      );
    } else {
      catalogUrlPattern = /^\/resources/;
    }
  } catch {
    catalogUrlPattern = /^\/resources/;
  }

  return {
    build: {
      chunkSizeWarningLimit: 800, // Budget baseline
    },
    plugins: [
      cspPlugin,
      react(),
      visualizer({
        filename: "stats.html",
        brotliSize: true,
        gzipSize: true,
      }),
      VitePWA({
        registerType: "autoUpdate",
        includeAssets: ["icon.svg"],
        manifest: {
          name: "ZentrixPay",
          short_name: "ZentrixPay",
          description: "Pay-per-call APIs on Stellar using HTTP 402 and x402.",
          theme_color: "#4f46e5",
          background_color: "#ffffff",
          display: "standalone",
          start_url: "/",
          icons: [
            {
              src: "icon.svg",
              sizes: "any",
              type: "image/svg+xml",
              purpose: "any maskable",
            },
          ],
        },
        workbox: {
          globPatterns: ["**/*.{js,css,html,ico,svg,woff2}"],
          maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
          navigateFallback: "index.html",
          cleanupOutdatedCaches: true,
          clientsClaim: true,
          skipWaiting: true,
          runtimeCaching: [
            {
              urlPattern: catalogUrlPattern,
              handler: "NetworkFirst",
              options: {
                cacheName: "zentrixpay-catalog",
                networkTimeoutSeconds: 10,
                expiration: {
                  maxEntries: 32,
                  maxAgeSeconds: 60 * 60 * 24,
                },
                cacheableResponse: {
                  statuses: [0, 200],
                },
              },
            },
          ],
        },
      }),
    ],
    server: {
      port: 5173,
      proxy: {
        "/resources": "http://localhost:4021",
      },
    },
  };
});
