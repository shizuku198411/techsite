import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

const repositoryName = process.env.GITHUB_REPOSITORY?.split("/")[1] ?? "techsite";
const base = process.env.GITHUB_ACTIONS === "true" ? `/${repositoryName}/` : "/";

export default defineConfig({
  plugins: [vue()],
  base,
});
