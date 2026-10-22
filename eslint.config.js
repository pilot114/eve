// check: eslint + prettier --check, fix: eslint --fix + prettier --write — как composer check/fix в pretty-php.
// Найденное на момент заведения — в eslint-suppressions.json (eslint --suppress-all), новое не пройдёт.
import js from "@eslint/js";
import globals from "globals";
import prettier from "eslint-config-prettier";

export default [
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: "latest", sourceType: "module", globals: { ...globals.browser } },
    rules: {},
  },
  // форматирование — дело prettier: правила eslint о стиле выключены
  prettier,
  {
    ignores: ["toolchain/", "dist/", "static/report/data/", "static/eve-online-static-data-3421648-jsonl/", "crawler/"],
  },
];
