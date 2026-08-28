import { test } from 'node:test';
import assert from 'node:assert/strict';

test('CI sanity: basic math runs', () => {
    assert.strictEqual(1 + 1, 2);
});

test('CI sanity: string ops run', () => {
    assert.strictEqual('nexus'.toUpperCase(), 'NEXUS');
});

test('CI sanity: async test runs', async () => {
    const result = await Promise.resolve('ok');
    assert.strictEqual(result, 'ok');
});