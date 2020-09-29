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

## My app doesn't run, and I have an antivirus/firewall running

### Symptoms

You launch your app and VS Code enters debug mode, but it doesn't attach to the application and the "Pause" and "Step" buttons in the debug toolbar are disabled, and you're running an antivirus/firewall.

### Solution

We've seen some cases where an antivirus or firewall prevents VS Code from attaching to the process. To fix this, in order of preference:

- You can allow local/'loopback' connections
- By default, we use a random free port. You can pass an `--inspect` flag to your `runtimeArgs` to use the default port 9229, however we will still be unable to debug child processes.
- You can disable your firewall, or allowlist VS Code/Node.js.

## My app doesn't run using a Node 10 release before around 10.18.0

### Symptoms

You launch your app, but the debugger doesn't connect to it. You're using an older Node 10 release.

### Solution

We've seen some transient issues with early Node 10 point releases. To fix this we, recommend updating to a later Node 10 release (10.22.1 being the most recent at the time of writing), or to a newer version of Node altogether if nothing is keeping you on 10.
