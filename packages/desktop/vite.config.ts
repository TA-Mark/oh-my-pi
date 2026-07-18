import { defineConfig } from "vite";

// React JSX is handled by esbuild via tsconfig `"jsx": "react-jsx"` — no plugin
// needed for Phase 0 (Fast Refresh can be added with @vitejs/plugin-react later).
export default defineConfig({
	// Electron loads the renderer with file:// via BrowserWindow.loadFile().
	// Relative asset URLs are required; absolute /assets URLs resolve to the
	// filesystem root and produce a blank window in the packaged app.
	base: "./",
	clearScreen: false,
	server: {
		port: 1420,
		strictPort: true,
		watch: { ignored: ["**/dist-electron/**", "**/resources/**"] },
	},
	build: {
		outDir: "dist",
		target: "esnext",
		emptyOutDir: true,
	},
});
