/**
 * Preload polyfill for CI environments where jsdom doesn't properly
 * expose the URL constructor. This file is loaded via NODE_OPTIONS=--require
 * BEFORE vitest and jsdom initialize.
 */
'use strict';

const { URL, URLSearchParams } = require('node:url');

if (typeof globalThis.URL === 'undefined') {
  globalThis.URL = URL;
}
if (typeof globalThis.URLSearchParams === 'undefined') {
  globalThis.URLSearchParams = URLSearchParams;
}
