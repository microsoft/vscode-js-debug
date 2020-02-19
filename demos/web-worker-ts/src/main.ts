const first = document.querySelector('#first') as any;
const second = document.querySelector('#second') as any;
const result = document.querySelector('#result') as any;

const worker = new Worker("worker.js");

first.onchange = function() {
  console.log('hello');
  debugger; // Step _into_ the next line
  worker.postMessage([first.value, second.value]);
}

second.onchange = function() {
  debugger; // Step _into_ the next line
  worker.postMessage([first.value, second.value]);
}

worker.onmessage = function(e) {
  // You are back in main! Check out the CALL STACK.
  result.textContent = e.data;
}
