// Type declarations agar TypeScript mengenali Node.js globals
// di Netlify Functions runtime (Deno-like / Node-compatible).
declare const process: {
  env: Record<string, string | undefined>;
};
