import nextPlugin from "@next/eslint-plugin-next"
import tsParser from "@typescript-eslint/parser"

export default [
  {
    ignores: [
      ".next/**",
      ".next-*/**",
      "node_modules/**",
      "dist/**",
      "build/**",
      "coverage/**",
      "backups/**",
      "**/*.tmp",
      "**/*_backup*",
      "**/*.backup-experimental",
      ".turbopack-cache-bust.ts",
      "next-env.d.ts",
    ],
  },
  {
    files: ["**/*.{js,jsx,mjs,cjs,ts,tsx}"],
    ...nextPlugin.flatConfig.recommended,
    ...nextPlugin.flatConfig.coreWebVitals,
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
        project: false,
      },
    },
    settings: {
      next: {
        rootDir: ["./"],
      },
    },
  },
]
