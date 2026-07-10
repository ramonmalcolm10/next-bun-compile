import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://ramonmalcolm10.github.io",
  base: "/next-bun-compile",
  integrations: [
    starlight({
      title: "next-bun-compile",
      description:
        "Compile Next.js apps into single-file Bun executables. One command. One binary. No runtime dependencies.",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/ramonmalcolm10/next-bun-compile",
        },
      ],
      components: {
        SocialIcons: "./src/components/SocialIcons.astro",
        Head: "./src/components/Head.astro",
      },
      editLink: {
        baseUrl:
          "https://github.com/ramonmalcolm10/next-bun-compile/edit/main/docs/",
      },
      sidebar: [
        {
          label: "Start Here",
          items: [
            { slug: "getting-started" },
            { slug: "configuration" },
            { slug: "how-it-works" },
            { slug: "troubleshooting" },
          ],
        },
        {
          label: "Guides",
          items: [{ autogenerate: { directory: "guides" } }],
        },
        {
          label: "Recipes",
          items: [{ autogenerate: { directory: "recipes" } }],
        },
      ],
    }),
  ],
});
