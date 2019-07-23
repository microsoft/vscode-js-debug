# Features

- Attaching to all threads: page, out of process iframes, web workers, related service workers.

    <img width="283" alt="Screen Shot 2019-07-22 at 9 23 37 PM" src="https://user-images.githubusercontent.com/883973/61682644-4b1a6080-acc7-11e9-8e05-dd6863987930.png">

- Evaluate in selected execution context.

    <img width="286" alt="Screen Shot 2019-07-22 at 9 25 26 PM" src="https://user-images.githubusercontent.com/883973/61682673-6a18f280-acc7-11e9-812b-65032d7fedba.png">

- Node debugging attaches to all processes.

    <img width="286" alt="Screen Shot 2019-07-22 at 9 35 58 PM" src="https://user-images.githubusercontent.com/883973/61682997-ba448480-acc8-11e9-824c-64c424752a1f.png">

- Top-level await in console.

    <img width="743" alt="Screen Shot 2019-07-22 at 9 40 36 PM" src="https://user-images.githubusercontent.com/883973/61683166-61292080-acc9-11e9-8416-e997d8ed3afc.png">

- Serialized console output.

    <img width="245" alt="Screen Shot 2019-07-22 at 9 42 03 PM" src="https://user-images.githubusercontent.com/883973/61683220-97ff3680-acc9-11e9-98db-e6d199023647.png">

- Instrumentation breakpoints (e.g. setTimeout fired).
- Pretty print minified source.
- Console message formatting improvements from CDT.
- All locations go through source maps: stack trace on pause, console methods, exceptions, function locations.
- Command line API: inspect(function), copy(value), queryObjects(prototype).
- Breakpoints set in source maps are guranteed to be resolved in time (in newer V8 versions).

# Architecture Overview

There are two entry points: `ChromeAdapter` and `NodeAdapter`. Each of them listens to DAP, collects configuration DAP requests using `Configurator`, implements `url <-> path` mapping strategy, launches the corresponding debuggee (Chrome or Node) and instantiates `Adapter`, which takes over after launch.

`Adapter` operates on multiple `Threads`, which are created with independent CDP sessions. Each `Thread` assumes a JavaScript environment, and handles debugging: execution contexts, scripts, stepping, breakpoints, console logging, exceptions, object inspection.

All scripts reported by `Thread` are added to `SourceContainer` and deduplicated by url. If script has a `sourceMapUrl`, container proceeds to load the source map (again, deduped by url) and generates source map sources from the source map. It then establishes mapping between original compiled source and created source map sources, and later uses the mapping to resolve `Locations` to preferred or all available ones. Since all `Locations` go through `SourceContainer`, we guarantee user-friendly locations being reported everywhere: in console messages, exceptions, stack traces on pause, etc.

`VariableStore` maps CDP's `RemoteObject` to DAP's `Variable`. Each `Thread` maintains two separate stores: one for variables accessed on pause, and one for the `repl`. These stores have different lifetimes, with repl store being cleared when console is cleared, and paused store survining until next resume.

`ChromeAdapter` manages `Targets` which may or may not contain a `Thread` each. These are targets from CDP, representing pages, iframes, service workers, etc. `FrameModel` constructs a full-page tree of frames from multiple targets, to allow user evaluate in any context.

`NodeAdapter` manages launching node processes and connecting to them. It pushes one `Thread` per node process to `Adapter`.

# Contributing

This project welcomes contributions and suggestions.  Most contributions require you to agree to a
Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us
the rights to use your contribution. For details, visit https://cla.opensource.microsoft.com.

When you submit a pull request, a CLA bot will automatically determine whether you need to provide
a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions
provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).
For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or
contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.
