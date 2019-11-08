import * as path from 'path';
import * as os from 'os';

const deadline = Date.now() + 100;
while (Date.now() < deadline) {}
console.log(path.join(os.homedir(), 'dir') + 'foo');
console.log('bar');
