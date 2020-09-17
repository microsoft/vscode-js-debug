# Common Problems

## My app doesn't start run, and I use `--inspect-brk` to load it

### Symptoms

The app doesn't run, breakpoints don't bind. It "hangs" indefinitely, and either directly or indirectly you use `--inspect-brk` to set it up.

### Solution

In most cases, `--inspect-brk` is not needed. You can remove it entirely, or use only `--inspect`.

### Reason

This debugger attaches to scripts by using `NODE_OPTIONS` to tell Node.js to `--require` a bootloader script before running your program. This bootloader sets up the communication between VS Code and your application, and doing it in this way lets us do a whole lot of really neat things (like implement the Debug Terminal and debug child processes automatically.)

However, `--inspect-brk` will cause Node.js to pause on the first line of the executed script and wait for a debugger to attach. Unfortunately, this pauses at the first line of the _bootloader_, so it never tells VS Code that there's something to debug.

In most cases, `--inspect-brk` was used to make sure the VS Code attached completely before running your program. The bootloader does the same thing, so this is no longer necessary.
