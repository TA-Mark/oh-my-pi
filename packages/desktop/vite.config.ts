import { defineConfig } from "vite";

// React JSX is handled by esbuild via tsconfig `"jsx": "react-jsx"` — no plugin
// needed for Phase 0 (Fast Refresh can be added with @vitejs/plugin-react later).
export default defineConfig({
	clearScreen: false,
	server: {
		port: 1420,
		strictPort: true,
	},
	build: {
		outDir: "dist",
		target: "esnext",
		emptyOutDir: true,
	},
});
