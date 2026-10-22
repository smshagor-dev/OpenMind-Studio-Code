'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { createApi, createEventHub } = require('../../host/vscode.js');

function fixture(permissions = []) {
  const host = {
    state: {
      extensions: new Map(), running: new Map(), commands: new Map(), providers: new Map(),
      documents: new Map(), workspaceFolders: [], configuration: {}, activeEditor: null,
    },
    events: createEventHub(), als: new AsyncLocalStorage(),
    request: async () => undefined, notify() {},
  };
  const api = createApi(host, { id: 'test.api', path: process.cwd(), permissions });
  return { host, api };
}

module.exports = { fixture };
