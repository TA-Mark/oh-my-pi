import { defineConfig } from "vite";

// React JSX is handled by esbuild via tsconfig `"jsx": "react-jsx"` — no plugin
// needed for Phase 0 (Fast Refresh can be added with @vitejs/plugin-react later).
export default defineConfig({
	clearScreen: false,
	server: {
		port: 1420,
		strictPort: true,
		// Tauri compiles Rust into src-tauri/target; watching it races the linker
		// and crashes the dev server with EBUSY on the locked output DLL.
		watch: { ignored: ["**/src-tauri/**"] },
	},
	build: {
		outDir: "dist",
		target: "esnext",
		emptyOutDir: true,
	},
});
