import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jupiterHeaders } from './provider-headers.ts';
test('Jupiter key is not sent to fallback or lookalike origins',()=>{
 assert.equal(jupiterHeaders('https://api.jup.ag/swap/v1/quote','test')['x-api-key'],'test');
 for(const endpoint of ['https://public.jupiterapi.com/quote','https://lite-api.jup.ag/swap/v1/quote',
  'https://api.jup.ag.attacker.test/quote','http://api.jup.ag/quote','https://api.jup.ag:8443/quote'])
  assert.equal(jupiterHeaders(endpoint,'test')['x-api-key'],undefined);
});
