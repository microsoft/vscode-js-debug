onmessage = function(e) {
  // You are now in the worker. Check out CALL STACK
  // Step over evaluation.
  let result = e.data[0] * e.data[1];
  // Step into postMessage.
  postMessage(result);
}
