/** True when running inside the Tauri desktop shell (vs. a plain browser). */
export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
