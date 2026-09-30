module.exports = {
  env: {
    es6:  true,
    node: true,
  },
  parserOptions: {
    ecmaVersion: 2020,
  },
  extends: [
    "eslint:recommended",
    "google",
  ],
  rules: {
    "no-restricted-globals": ["error", "name", "length"],
    "prefer-arrow-callback":  "error",
    "quotes":   ["error", "double", { "avoidEscape": true }],
    "max-len":  ["warn",  { "code": 100 }],
    "indent":   ["error", 2],
    "object-curly-spacing": ["error", "always"],
    "require-jsdoc": "off",
    "valid-jsdoc":   "off",
  },
  globals: {},
};
