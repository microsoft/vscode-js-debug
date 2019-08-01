const first = document.querySelector('#first');
const second = document.querySelector('#second');
const result = document.querySelector('#result');

const worker = new Worker("worker.js");

first.onchange = function() {
  debugger; // Step _into_ the next line
  worker.postMessage([first.value, second.value]);
}

second.onchange = function() {
  debugger; // Step _into_ the next line
  worker.postMessage([first.value, second.value]);
}

worker.onmessage = function(e) {
  // You are back in main! Check out the CALL STACK.
  // Try selecting threads in the THREADS view.
  result.textContent = e.data;
}
