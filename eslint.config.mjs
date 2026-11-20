import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

const config = [
  { ignores: [".next/**", "node_modules/**", "social/**", "next-env.d.ts"] },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  { rules: { "@typescript-eslint/no-unused-vars": ["error", { varsIgnorePattern: "^_", argsIgnorePattern: "^_" }] } },
  // Tests and evals read free-form JSON-RPC results.
  { files: ["test/**", "eval/**"], rules: { "@typescript-eslint/no-explicit-any": "off" } },
];

export default config;
