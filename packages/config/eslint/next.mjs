// Flat ESLint config for the Next.js web app.
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import { base } from './base.mjs';

export const next = [
  ...base,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
];

export default next;
