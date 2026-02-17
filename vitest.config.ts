import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: [
			{
				find: "@cramkit/shared",
				replacement: path.resolve(__dirname, "packages/shared/src/index.ts"),
			},
		],
	},
	test: {
		globals: true,
		include: ["tests/**/*.test.ts"],
		setupFiles: ["tests/setup.ts"],
		fileParallelism: false,
		testTimeout: 30000,
	},
});
