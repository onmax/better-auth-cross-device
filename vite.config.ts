import { defineConfig } from "vite-plus";

export default defineConfig({
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  pack: {
    entry: ["src/index.ts", "src/client.ts"],
    dts: true,
    format: ["esm"],
    platform: "neutral",
  },
});
