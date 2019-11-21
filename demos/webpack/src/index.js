import { EventEmitter } from 'events';

const e = new EventEmitter();

e.on('data', data => {
  console.log('I got data!', data);
});

debugger;
e.emit('data', 1);
e.emit('data', 2);
