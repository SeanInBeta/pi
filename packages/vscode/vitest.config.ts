import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "../../vitest.base.ts";

// Tests drive the coding-agent faux-provider harness, so they share its offline setup.
export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			env: { PI_OFFLINE: "1" },
			reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
			server: {
				deps: {
					external: [/@silvia-odwyer\/photon-node/],
				},
			},
		},
	}),
);
