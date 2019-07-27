console.error({foo: {bar: 'worker start'}});

self.addEventListener('message', e => {
  console.error(e.data);
  if (e.data === 'pause')
    (postMessage as any)('pause');
  else
    (postMessage as any)({foo: {bar: 'to page'}});
});
