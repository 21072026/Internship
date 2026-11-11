'use strict';
// Every request carries the key as a Bearer token and asks for JSON.
const addAuth = (request, z, bundle) => {
  request.headers = request.headers || {};
  if (bundle.authData && bundle.authData.apiKey) request.headers.Authorization = `Bearer ${bundle.authData.apiKey}`;
  request.headers.Accept = 'application/json';
  return request;
};

module.exports = { befores: [addAuth], afters: [] };
