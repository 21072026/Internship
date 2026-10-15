import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INTERNSHIP_PRODUCT, parseExtraProducts, productById, productsFrom } from './products.ts';

// All values are synthetic (#2926): the repository carries no deployment's
// product names, colours or hosts.
const ACME = { id: 'acme', name: 'Acme Sales', color: '#0F766E', hosts: { production: 'marketing.example.test', preview: 'marketing.preview.example.test' } };

test('without EXPO_PUBLIC_EXTRA_PRODUCTS the app serves the internship product alone', () => {
  for (const raw of [undefined, '', '  ']) {
    assert.deepEqual(productsFrom(raw), [INTERNSHIP_PRODUCT], JSON.stringify(raw));
    assert.deepEqual(parseExtraProducts(raw), { products: [], rejected: [] });
  }
  assert.equal(INTERNSHIP_PRODUCT.id, 'internship');
  assert.equal(INTERNSHIP_PRODUCT.hosts.production, 'interncrm.com');
});

test('configured products follow the built-in one, in their order', () => {
  const beta = { ...ACME, id: 'beta', name: '  Beta CRM ', hosts: { production: 'crm.beta.example', preview: 'preview.crm.beta.example' } };
  const all = productsFrom(JSON.stringify([ACME, beta]));
  assert.deepEqual(all.map((p) => p.id), ['internship', 'acme', 'beta']);
  assert.equal(all[2].name, 'Beta CRM', 'the name is trimmed');
  assert.deepEqual(productById('acme', all), ACME);
});

test('a value that is not a JSON list adds nothing', () => {
  for (const raw of ['{not json', '{}', '"acme"', 'null']) {
    assert.deepEqual(parseExtraProducts(raw), { products: [], rejected: [-1] }, raw);
    assert.deepEqual(productsFrom(raw), [INTERNSHIP_PRODUCT]);
  }
});

test('a malformed entry is left out, the others still load', () => {
  const bad = [
    { ...ACME, id: 'internship' }, // cannot replace the built-in product
    { ...ACME, id: 'Has Space' },
    { ...ACME, name: '   ' },
    { ...ACME, color: 'magenta' },
    { ...ACME, hosts: { production: 'https://marketing.example.test', preview: 'marketing.preview.example.test' } },
    { ...ACME, hosts: { production: 'marketing.example.test:443', preview: 'marketing.preview.example.test' } },
    { ...ACME, hosts: { production: 'Marketing.Example.Test', preview: 'marketing.preview.example.test' } },
    { ...ACME, hosts: { production: 'marketing.example.test' } },
    null,
  ];
  const { products, rejected } = parseExtraProducts(JSON.stringify([...bad, ACME, { ...ACME, name: 'Duplicate' }]));
  assert.deepEqual(products, [ACME]);
  assert.deepEqual(rejected, [0, 1, 2, 3, 4, 5, 6, 7, 8, 10], 'the second "acme" is a duplicate id');
});
