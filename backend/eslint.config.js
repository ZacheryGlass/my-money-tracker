'use strict';

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ...js.configs.recommended,
    files: ['src/**/*.js', 'scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
  },
];
