// Quick manual test (node >= 18): node _test_fetch.mjs
const url = 'https://en.sge.com.cn/graph/quotations';
const body = new URLSearchParams({ instid: 'Au99.99' });
const res = await fetch(url, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    Accept: 'application/json, text/javascript, */*; q=0.01',
  },
  body,
});
console.log('status', res.status);
console.log((await res.text()).slice(0, 200));
