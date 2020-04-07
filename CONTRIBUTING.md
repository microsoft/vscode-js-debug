# Contributing

This project welcomes contributions and suggestions. Most contributions require you to agree to a
Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us
the rights to use your contribution. For details, visit https://cla.opensource.microsoft.com.

When you submit a pull request, a CLA bot will automatically determine whether you need to provide
a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions
provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).
For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or
contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## Development

For basic development of the extension, you can run:

1. Clone the repo and run `npm install`
2. Run `npm run watch` in a terminal. This will compile and watch for changes in sources.
3. Run the `Extension` launch configuration.

For debugging the companion app used to launch browsers from remotes, the process is similar:

- Also clone `vscode-js-debug-companion` as a sibling directory to `vscode-js-debug`.
- Run `npm run watch` for the companion.
- Run the `Extension and Companion` launch configuration.

This will cause both js-debug and its companion to boot. It sets an environment variable that forces the companion app to be used for launching the browser.
