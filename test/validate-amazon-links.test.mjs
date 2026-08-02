import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyAmazonPage, findAmazonLinks } from '../scripts/validate-amazon-links.mjs';

const response = (url = 'https://www.amazon.com/dp/B000000000', status = 200) => ({
  url,
  status,
  ok: status >= 200 && status < 300,
});

test('findAmazonLinks recursively finds Amazon URLs and records duplicate locations', () => {
  const links = findAmazonLinks({ a: 'https://amzn.to/example', nested: [{ url: 'https://amzn.to/example' }], other: 'https://example.com' });
  assert.deepEqual([...links], [['https://amzn.to/example', ['$.a', '$.nested[0].url']]]);
});

test('classifies a page with Add to Cart as purchasable', () => {
  assert.equal(classifyAmazonPage(response(), '<input id="add-to-cart-button">').status, 'purchasable');
});

test('classifies rendered product availability as unavailable', () => {
  const result = classifyAmazonPage(response(), '<div id="availability">Currently unavailable.</div>');
  assert.equal(result.status, 'unavailable');
});

test('ignores generic unavailable strings embedded outside the availability area', () => {
  const result = classifyAmazonPage(response(), '<script>const label = "Currently unavailable."</script><input id="add-to-cart-button">');
  assert.equal(result.status, 'purchasable');
});

test('does not treat CAPTCHA, HTTP errors, or non-Amazon redirects as availability', () => {
  assert.equal(classifyAmazonPage(response(), '<title>Robot Check</title> Enter the characters you see below').status, 'unverifiable');
  assert.equal(classifyAmazonPage(response('https://amazon.com', 503), '').status, 'unverifiable');
  assert.equal(classifyAmazonPage(response('https://example.com'), '<input id="buy-now-button">').status, 'unverifiable');
});
