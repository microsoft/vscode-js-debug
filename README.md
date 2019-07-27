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
