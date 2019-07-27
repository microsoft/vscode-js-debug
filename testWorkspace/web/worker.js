console.error({foo: {bar: 'worker start'}});

self.addEventListener('message', e => {
  console.error(e.data);
  if (e.data === 'pause')
    postMessage('pause');
  else
    postMessage({foo: {bar: 'to page'}});
});
