console.error({foo: {bar: 'worker start'}});

self.addEventListener('message', e => {
  console.error(e.data);
  postMessage({foo: {bar: 'to page'}});
});
