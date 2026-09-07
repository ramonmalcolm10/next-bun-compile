import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import nimbus, {
  defineConfig as defineNimbusConfig,
} from "@cloudflare/nimbus-docs";
import { tableScroll } from "@cloudflare/nimbus-docs/markdown";

const nimbusConfig = defineNimbusConfig({
  // Canonical origin. This is a GitHub Pages *project* site, so the origin
  // carries the repo path — it drives canonical URLs, absolute OG image
  // URLs, robots.txt, the sitemap and the links in /llms.txt, all of which
  // must resolve under /next-bun-compile.
  site: "https://ramonmalcolm10.github.io/next-bun-compile",
  title: "next-bun-compile",
  description:
    "Compile Next.js apps into single-file Bun executables. One command. One binary. No runtime dependencies.",
  locale: "en",
  github: "https://github.com/ramonmalcolm10/next-bun-compile",
  socialImageAlt: "next-bun-compile documentation",
  sidebar: {
    items: [
      { label: "Getting started", link: "/getting-started" },
      { label: "Configuration", link: "/configuration" },
      { label: "How it works", link: "/how-it-works" },
      { label: "Troubleshooting", link: "/troubleshooting" },
      { label: "Guides", autogenerate: { directory: "guides" } },
      { label: "Recipes", autogenerate: { directory: "recipes" } },
    ],
  },
});

export default defineConfig({
  // nimbus:adapter
  output: "static",
  // Split across site + base because this is a project site: Astro needs the
  // bare origin plus the sub-path, while Nimbus wants the full canonical
  // origin above. Sub-path support is what kept these docs on Starlight —
  // nimbus-docs <=0.11 dropped `base` from sidebar links, the favicon and
  // shiki.css (cloudflare/nimbus#105, fixed in #112/#114).
  site: "https://ramonmalcolm10.github.io",
  base: "/next-bun-compile",
  // Tailwind v4 via its Vite plugin (the integration Astro recommends for
  // Tailwind v4 — replaces the PostCSS plugin, which doesn't build under
  // Astro 7's Vite 8 bundler).
  vite: {
    plugins: [tailwindcss()],
  },
  // Replaces the ClientRouter the Starlight build injected through a custom
  // Head override: hover-prefetch makes full-page navigation feel instant
  // without shipping a client-side router.
  prefetch: {
    prefetchAll: true,
    defaultStrategy: "hover",
  },
  integrations: [
    nimbus(nimbusConfig, {
      rules: {
        "nimbus/frontmatter-shape": "error",
        "nimbus/internal-link": "error",
      },
      // Wrap wide tables so they scroll instead of overflowing the page —
      // configuration.mdx's env-var table is the widest thing here.
      markdown: {
        hastPlugins: [tableScroll()],
      },
    }),
  ],
});
