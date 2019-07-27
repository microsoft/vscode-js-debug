console.error({ foo: { bar: 'worker start' } });
self.addEventListener('message', function (e) {
    console.error(e.data);
    if (e.data === 'pause')
        postMessage('pause');
    else
        postMessage({ foo: { bar: 'to page' } });
});
//# sourceMappingURL=workerSourceMap.js.map