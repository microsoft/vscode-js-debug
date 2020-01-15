console.error({foo: {bar: 'worker start'}});

self.addEventListener('message', e => {
  console.error(e.data);
  if (e.data === 'pause')
    postMessage('pause');
  else if (e.data === 'pauseWorker')
    debugger;
  else
    postMessage({foo: {bar: 'to page'}});
});
self.isWorker = true;