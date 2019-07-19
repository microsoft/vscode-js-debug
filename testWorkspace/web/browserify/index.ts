import * as m1 from './module1';
import * as m2 from './module2';

window['throwError'] = m1.throwError;
window['throwValue'] = m1.throwValue;
window['pause'] = m1.foo;
window['callBack'] = m2.bar;
window['logSome'] = function logSome() {
  console.log(m1.kModule1 + m2.kModule2);
}
