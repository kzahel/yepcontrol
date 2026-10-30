import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@remote\/client\/(.+)$/,
        replacement: new URL("./client/src/$1.ts", import.meta.url).pathname,
      },
    ],
  },
  test: {
    include: [
      "protocol/test/**/*.test.ts",
      "client/test/**/*.test.ts",
      "relay/test/**/*.test.ts",
      "web/test/**/*.test.ts",
      "scripts/**/*.test.ts",
    ],
  },
});
