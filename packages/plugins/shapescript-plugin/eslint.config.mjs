import eslint from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import vuePlugin from "eslint-plugin-vue";
import vueParser from "vue-eslint-parser";
import globals from "globals";

export default [
  eslint.configs.recommended,
  // Spread at the top level: `configs["flat/recommended"]` is an ARRAY of flat
  // config objects in eslint-plugin-vue 10.x, so its `.rules` is undefined and
  // spreading it into a `rules` block below would silently enable nothing.
  ...vuePlugin.configs["flat/recommended"],
  {
    files: ["**/*.ts", "**/*.vue"],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tsparser,
        ecmaVersion: "latest",
        sourceType: "module",
      },
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
      vue: vuePlugin,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      "vue/multi-word-component-names": "off",
      // Prettier owns template formatting in this repo and wraps attributes by
      // print width; this rule wants one per line the moment there are two, so
      // the two rewrite each other's output forever. Off, not appeased.
      "vue/max-attributes-per-line": "off",
    },
  },
  {
    ignores: ["dist/**", "node_modules/**"],
  },
];
