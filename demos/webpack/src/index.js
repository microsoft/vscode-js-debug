import { EventEmitter } from 'events';

const e = new EventEmitter();

e.on('data', data => {
  console.log('I got data!', data);
});

debugger;
e.emit(1);
e.emit(2);
