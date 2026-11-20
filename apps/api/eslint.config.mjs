import base from '@ngao360/config/eslint/base';

export default [
  ...base,
  {
    rules: {
      // Nest uses classes with decorators and empty modules as extension points.
      '@typescript-eslint/no-extraneous-class': 'off',
    },
  },
];
