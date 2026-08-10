import tsParser from "@typescript-eslint/parser"

// Keep the repository on ESLint's flat-config format (ESLint 9).  The
// recovered workspace previously lacked this file, which made `pnpm lint`
// fail before parsing a single source file.  TypeScript/TSX files use the
// project-independent parser so linting also works during clean installs.
export default [
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      ".next-*/**",
      ".open-next/**",
      ".wrangler/**",
      "coverage/**",
      "dist/**",
    ],
  },
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parser: tsParser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
  },
]
