# Features

## Multiple threads

- Attaching to relevant browser threads: page, out of process iframes, web workers, related service workers

    <img width="359" alt="Screen Shot 2019-07-25 at 9 27 36 AM" src="https://user-images.githubusercontent.com/883973/61891435-803cd380-aebe-11e9-8c27-1af5d1fdab43.png">

- Node debugging attaches to all sub-processes

    <img width="322" alt="Screen Shot 2019-07-25 at 9 31 34 AM" src="https://user-images.githubusercontent.com/883973/61891688-140e9f80-aebf-11e9-9f56-c9fa9bf47c46.png">

## Console

- Evaluate in selected execution context

    <img width="652" alt="Screen Shot 2019-07-25 at 9 29 47 AM" src="https://user-images.githubusercontent.com/883973/61891554-c2feab80-aebe-11e9-9f30-38f057c7f722.png">

- Unified console for everything: service workers, page, workers

    <img width="504" alt="Screen Shot 2019-07-22 at 9 54 30 PM" src="https://user-images.githubusercontent.com/883973/61683685-4d7eb980-accb-11e9-959a-cc33eff6f9c6.png">

- Top-level await in console

    <img width="743" alt="Screen Shot 2019-07-22 at 9 40 36 PM" src="https://user-images.githubusercontent.com/883973/61683166-61292080-acc9-11e9-8416-e997d8ed3afc.png">

- Serialized console output

    <img width="245" alt="Screen Shot 2019-07-22 at 9 42 03 PM" src="https://user-images.githubusercontent.com/883973/61683220-97ff3680-acc9-11e9-98db-e6d199023647.png">

- Console message formatting improvements from CDT

    <img width="612" alt="Screen Shot 2019-07-22 at 10 01 08 PM" src="https://user-images.githubusercontent.com/883973/61683910-3be9e180-accc-11e9-9a48-8930f0db3f9b.png">

- Per-thread Output with timestamps available post-session

    <img width="324" alt="Screen Shot 2019-07-24 at 10 28 05 PM" src="https://user-images.githubusercontent.com/883973/61848257-5ce43b00-ae62-11e9-922c-a93073c0266b.png">

    <img width="751" alt="Screen Shot 2019-07-24 at 10 29 43 PM" src="https://user-images.githubusercontent.com/883973/61848317-8e5d0680-ae62-11e9-88db-5017ed58a430.png">

- Command line API: inspect(function), copy(value), queryObjects(prototype)

    <img width="259" alt="Screen Shot 2019-07-22 at 10 32 03 PM" src="https://user-images.githubusercontent.com/883973/61685138-8bcaa780-acd0-11e9-99d9-151c2839b5f6.png">

## Debugging

- Instrumentation breakpoints

    <img width="285" alt="Screen Shot 2019-07-22 at 9 50 35 PM" src="https://user-images.githubusercontent.com/883973/61683560-c16c9200-acca-11e9-9d63-483b9c3d48ee.png">

    <img width="604" alt="Screen Shot 2019-07-22 at 9 50 10 PM" src="https://user-images.githubusercontent.com/883973/61683564-c4678280-acca-11e9-959a-dbeb49fc8716.png">

- Pretty print minified source with complete debugging support

    <!--img width="464" alt="Screen Shot 2019-07-22 at 9 55 22 PM" src="https://user-images.githubusercontent.com/883973/61683714-6c7d4b80-accb-11e9-92ae-084e3b4f36e7.png"-->
    ![pretty_print](https://user-images.githubusercontent.com/883973/61990381-71f0d380-aff4-11e9-95ae-10f2b1a732ec.gif)


    <img width="553" alt="Screen Shot 2019-07-22 at 9 56 12 PM" src="https://user-images.githubusercontent.com/883973/61683776-a9e1d900-accb-11e9-9884-f7494b1d8fc4.png">

- Step into async, step into Worker, etc

    ![step_into](https://user-images.githubusercontent.com/883973/61990326-2c7fd680-aff3-11e9-9602-ba4b25c7f138.gif)

- All locations go through source maps: stack trace on pause, console methods, exceptions, function locations
- Breakpoints set in source maps are guranteed to be resolved in time (in newer V8 versions).


# Features

- Multiple execution contexts support. Execution context is similar to a Scope, which is available when not on pause. Repl evaluation should be attributed to an execution context.

- Inline breakpoints
  - It is possible to implement inline breakpoints using `TextEditor.setDecorations`, but they lack custom `onclick` handler.

  - Breakpoints which resolve somewhere in the middle of a line are hard to use. For example, `await foo.bar()` is resolved to "before `await`, but after `foo.bar()`", which is not obvious and can be communicated by placing inline breakpoints.

- No checkboxes in the tree view, useful for e.g. browser breakpoints where each can be toggled, similar to regular breakpoints.


# Bugs

- It is impossible to construct a "debug:...." uri and open a text document in the UI. This prevents revealing any source coming from the debugger.

- Child debugger sessions: cannot have both child sessions and threads, no way to rearrange sessions when parent process terminates, but child processes survive.

- Debug console does not linkify many string properties. It seems to do so only for the property with an empty name.

- Output stream does not respect control sequences.

- No way to implement `console.group`.

- Exception state has 3 options: 'always', 'never', 'unhandled', but has to be modeled with checkboxes.

# Questions

- Global scope pollution.

- A notion of "target" which is a program user can attach to and debug. It is convenient to see them in a tree and pick the correct one. For example, when running `npm start` user can see a tree of spawned processes, and pick the main one to attach to.

# Contributing

This project welcomes contributions and suggestions. See [CONTRIBUTING.md](CONTRIBUTING.md) for details.
