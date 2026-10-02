import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Linked workspace packages must use the host's React 18 instance.
  resolve: { dedupe: ["react", "react-dom"] },
});
