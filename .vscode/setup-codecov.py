Azure Pipelines | Azure DevOps Server 2020 | Azure DevOps Server 2019 | TFS 2018 | TFS 2017

Use a pipeline to build and test JavaScript and Node.js apps, and then deploy or publish to targets. Learn how to:

Set up your build environment with Microsoft-hosted or self-hosted agents.
Use the npm task or a script to download packages for your build.
Implement JavaScript frameworks: Angular, React, or Vue.
Run unit tests and publish them with the publish test results task.
Use the publish code coverage task to publish code coverage results.
Publish npm packages with Azure Artifacts.
Create a .zip file archive that is ready for publishing to a web app with the Archive Files task and deploy to Azure.
Create your first pipeline
Are you new to Azure Pipelines? If so, then we recommend you try this section to create before moving on to other sections.

Get the code
See an example
Fork this repo in GitHub:


Copy
https://github.com/MicrosoftDocs/pipelines-javascript
Sign in to Azure Pipelines
Sign in to Azure Pipelines. After you sign in, your browser goes to https://dev.azure.com/my-organization-name and displays your Azure DevOps dashboard.

Within your selected organization, create a project. If you don't have any projects in your organization, you see a Create a project to get started screen. Otherwise, select the Create Project button in the upper-right corner of the dashboard.

Create the pipeline
The following code is a simple Node server implemented with the Express.js framework. Tests for the app are written through the Mocha framework. To get started, fork this repo in GitHub.


Copy
https://github.com/MicrosoftDocs/pipelines-javascript
Sign in to your Azure DevOps organization and navigate to your project.

In your project, navigate to the Pipelines page. Then choose the action to create a new pipeline.

Walk through the steps of the wizard by first selecting GitHub as the location of your source code.

You might be redirected to GitHub to sign in. If so, enter your GitHub credentials.

When the list of repositories appears, select your Node.js sample repository.

Azure Pipelines will analyze the code in your repository and recommend Node.js template for your pipeline. Select that template.

Azure Pipelines will generate a YAML file for your pipeline. Select Save and run, then select Commit directly to the main branch, and then choose Save and run again.

A new run is started. Wait for the run to finish.

When you're done, you'll have a working YAML file (azure-pipelines.yml) in your repository that's ready for you to customize.

 Tip

To make changes to the YAML file as described in this topic, select the pipeline in the Pipelines page, and then Edit the azure-pipelines.yml file.

Learn some of the common ways to customize your JavaScript build process.

Build environment
You can use Azure Pipelines to build your JavaScript apps without needing to set up any infrastructure of your own. You can use either Windows or Linux agents to run your builds.

Update the following snippet in your azure-pipelines.yml file to select the appropriate image.

YAML

Copy
pool:
  vmImage: 'ubuntu-latest' # examples of other options: 'macOS-10.15', 'vs2017-win2016'
Tools that you commonly use to build, test, and run JavaScript apps - like npm, Node, Yarn, and Gulp - are pre-installed on Microsoft-hosted agents in Azure Pipelines. For the exact version of Node.js and npm that is preinstalled, refer to Microsoft-hosted agents. To install a specific version of these tools on Microsoft-hosted agents, add the Node Tool Installer task to the beginning of your process.

You can also use a self-hosted agent.

Use a specific version of Node.js
If you need a version of Node.js and npm that is not already installed on the Microsoft-hosted agent, use the Node tool installer task. Add the following snippet to your azure-pipelines.yml file.

 Note

The hosted agents are regularly updated, and setting up this task will result in spending significant time updating to a newer minor version every time the pipeline is run. Use this task only when you need a specific Node version in your pipeline.

YAML

Copy
- task: NodeTool@0 
  inputs:
    versionSpec: '12.x' # replace this value with the version that you need for your project
To update just the npm tool, run the npm i -g npm@version-number command in your build process.

Use multiple node versions
You can build and test your app on multiple versions of Node by using a strategy and the Node tool installer task.

YAML

Copy
pool:
  vmImage: 'ubuntu-latest'
strategy:
  matrix:
    node_12_x:
      node_version: 12.x
    node_13_x:
      node_version: 13.x

steps:
- task: NodeTool@0 
  inputs:
    versionSpec: $(node_version)

- script: npm install
Install tools on your build agent
If you have defined tools needed for your build as development dependencies in your project's package.json or package-lock.json file, install these tools along with the rest of your project dependencies through npm. This will install the exact version of the tools defined in the project, isolated from other versions that exist on the build agent.

You can use a script or the npm task.

Using a script to install with package.json
YAML

Copy
- script: npm install --only=dev
Using the npm task to install with package.json
YAML

Copy
- task: Npm@1
  inputs:
     command: 'install'
Run tools installed this way by using npm's npx package runner, which will first look for tools installed this way in its path resolution. The following example calls the mocha test runner but will look for the version installed as a dev dependency before using a globally installed (through npm install -g) version.

YAML

Copy
- script: npx mocha
To install tools that your project needs but that are not set as dev dependencies in package.json, call npm install -g from a script stage in your pipeline.

The following example installs the latest version of the Angular CLI by using npm. The rest of the pipeline can then use the ng tool from other script stages.

 Note

On Microsoft-hosted Linux agents, preface the command with sudo, like sudo npm install -g.

YAML

Copy
- script: npm install -g @angular/cli
These tasks will run every time your pipeline runs, so be mindful of the impact that installing tools has on build times. Consider configuring self-hosted agents with the version of the tools you need if overhead becomes a serious impact to your build performance.

Dependency management
In your build, use Yarn or Azure Artifacts/TFS to download packages from the public npm registry, which is a type of private npm registry that you specify in the .npmrc file.

npm
You can use NPM in a few ways to download packages for your build:

Directly run npm install in your pipeline. This is the simplest way to download packages from a registry that does not need any authentication. If your build doesn't need development dependencies on the agent to run, you can speed up build times with the --only=prod option to npm install.
Use an npm task. This is useful when you're using an authenticated registry.
Use an npm Authenticate task. This is useful when you run npm install from inside your task runners - Gulp, Grunt, or Maven.
If you want to specify an npm registry, put the URLs in an .npmrc file in your repository. If your feed is authenticated, manage its credentials by creating an npm service connection on the Services tab under Project Settings.

To install npm packages by using a script in your pipeline, add the following snippet to azure-pipelines.yml.

YAML

Copy
- script: npm install
To use a private registry specified in your .npmrc file, add the following snippet to azure-pipelines.yml.

YAML

Copy
- task: Npm@1
  inputs:
    customEndpoint: <Name of npm service connection>
To pass registry credentials to npm commands via task runners such as Gulp, add the following task to azure-pipelines.yml before you call the task runner.

YAML

Copy
- task: npmAuthenticate@0
  inputs:
    customEndpoint: <Name of npm service connection>
If your builds occasionally fail because of connection issues when you're restoring packages from the npm registry, you can use Azure Artifacts in conjunction with upstream sources, and cache the packages. The credentials of the pipeline are automatically used when you're connecting to Azure Artifacts. These credentials are typically derived from the Project Collection Build Service account.

If you're using Microsoft-hosted agents, you get a new machine every time you run a build - which means restoring the dependencies every time.

This can take a significant amount of time. To mitigate this, you can use Azure Artifacts or a self-hosted agent. You'll then get the benefit of using the package cache.

Yarn
Use a script stage to invoke Yarn to restore dependencies. Yarn is available preinstalled on some Microsoft-hosted agents. You can install and configure it on self-hosted agents like any other tool.

YAML

Copy
- script: yarn install
Run JavaScript compilers
Use compilers such as Babel and the TypeScript tsc compiler to convert your source code into versions that are usable by the Node.js runtime or in web browsers.

If you have a script object set up in your project's package.json file that runs your compiler, invoke it in your pipeline by using a script task.

YAML

Copy
- script: npm run compile
You can call compilers directly from the pipeline by using the script task. These commands will run from the root of the cloned source-code repository.

YAML

Copy
- script: tsc --target ES6 --strict true --project tsconfigs/production.json
Run unit tests
Configure your pipelines to run your JavaScript tests so that they produce results formatted in the JUnit XML format. You can then publish the results using the built-in publish test results task.

If your test framework doesn't support JUnit output, you'll need to add support through a partner reporting module, such as mocha-junit-reporter. You can either update your test script to use the JUnit reporter, or if the reporter supports command-line options, pass those into the task definition.

The following table lists the most commonly used test runners and the reporters that can be used to produce XML results:

TABLE 1
Test runner	Reporters to produce XML reports
mocha	mocha-junit-reporter
cypress-multi-reporters
jasmine	jasmine-reporters
jest	jest-junit
jest-junit-reporter
karma	karma-junit-reporter
Ava	tap-xunit
This example uses the mocha-junit-reporter and invokes mocha test directly by using a script. This produces the JUnit XML output at the default location of ./test-results.xml.

YAML

Copy
- script: mocha test --reporter mocha-junit-reporter
If you have defined a test script in your project's package.json file, you can invoke it by using npm test.

YAML

Copy
- script: npm test


Publish test results
To publish the results, use the Publish Test Results task.

YAML

Copy
- task: PublishTestResults@2
  condition: succeededOrFailed()
  inputs:
    testRunner: JUnit
    testResultsFiles: '**/TEST-RESULTS.xml'
Publish code coverage results
If your test scripts run a code coverage tool such as Istanbul, add the Publish Code Coverage Results task to publish code coverage results along with your test results. When you do this, you can find coverage metrics in the build summary and download HTML reports for further analysis. The task expects Cobertura or JaCoCo reporting output, so ensure that your code coverage tool runs with the necessary options to generate the right output. (For example, --report cobertura.)

YAML

Copy
- task: PublishCodeCoverageResults@1
  inputs: 
    codeCoverageTool: Cobertura # or JaCoCo
    summaryFileLocation: '$(System.DefaultWorkingDirectory)/**/*coverage.xml'
    reportDirectory: '$(System.DefaultWorkingDirectory)/**/coverage'
End-to-end browser testing
Run tests in headless browsers as part of your pipeline with tools like Protractor or Karma. Then publish the results for the build to VSTS with these steps:

Install a headless browser testing driver such as headless Chrome or Firefox, or a browser mocking tool such as PhantomJS, on the build agent.
Configure your test framework to use the headless browser/driver option of your choice according to the tool's documentation.
Configure your test framework (usually with a reporter plug-in or configuration) to output JUnit-formatted test results.
Set up a script task to run any CLI commands needed to start the headless browser instances.
Run the end-to-end tests in the pipeline stages along with your unit tests.
Publish the results by using the same Publish Test Results task alongside your unit tests.
Package web apps
Package applications to bundle all your application modules with intermediate outputs and dependencies into static assets ready for deployment. Add a pipeline stage after your compilation and tests to run a tool like Webpack or ng build by using the Angular CLI.

The first example calls webpack. To have this work, make sure that webpack is configured as a development dependency in your package.json project file. This will run webpack with the default configuration unless you have a webpack.config.js file in the root folder of your project.

YAML

Copy
- script: webpack
The next example uses the npm task to call npm run build to call the build script object defined in the project package.json. Using script objects in your project moves the logic for the build into the source code and out of the pipeline.

YAML

Copy
- script: npm run build
JavaScript frameworks
Angular
For Angular apps, you can include Angular-specific commands such as ng test, ng build, and ng e2e. To use Angular CLI commands in your pipeline, you need to install the angular/cli npm package on the build agent.

 Note

On Microsoft-hosted Linux agents, preface the command with sudo, like sudo npm install -g.

YAML

Copy
- script: |
    npm install -g @angular/cli
    npm install
    ng build --prod
For tests in your pipeline that require a browser to run (such as the ng test command in the starter app, which runs Karma), you need to use a headless browser instead of a standard browser. In the Angular starter app:

Change the browsers entry in your karma.conf.js project file from browsers: ['Chrome'] to browsers: ['ChromeHeadless'].

Change the singleRun entry in your karma.conf.js project file from a value of false to true. This helps make sure that the Karma process stops after it runs.

React and Vue
All the dependencies for your React and Vue apps are captured in your package.json file. Your azure-pipelines.yml file contains the standard Node.js script:

YAML

Copy
- script: |
    npm install
    npm run build
 displayName: 'npm install and build'
The build files are in a new folder, dist (for Vue) or build (for React). This snippet builds an artifact, www, that is ready for release. It uses the Node Installer, Copy Files, and Publish Build Artifacts tasks.

YAML

Copy
trigger:
- main

pool:
  vmImage: 'ubuntu-latest'

steps:
- task: NodeTool@0
  inputs:
    versionSpec: '10.x'
  displayName: 'Install Node.js'

- script: |
    npm install
    npm run build
  displayName: 'npm install and build'

- task: CopyFiles@2
  inputs:
    Contents: 'build/**' # Pull the build directory (React)
    TargetFolder: '$(Build.ArtifactStagingDirectory)'

- task: PublishBuildArtifacts@1
  inputs: 
    PathtoPublish: $(Build.ArtifactStagingDirectory) # dist or build files
    ArtifactName: 'www' # output artifact named www
To release, point your release task to the dist or build artifact and use the Azure Web App Deploy task.

Webpack
You can use a webpack configuration file to specify a compiler (such as Babel or TypeScript) to transpile JSX or TypeScript to plain JavaScript, and to bundle your app.

YAML

Copy
- script: |
    npm install webpack webpack-cli --save-dev
    npx webpack --config webpack.config.js
Build task runners
It's common to use Gulp or Grunt as a task runner to build and test a JavaScript app.

Gulp
Gulp is preinstalled on Microsoft-hosted agents. To run the gulp command in the YAML file:

YAML

Copy
- script: gulp                       # include any additional options that are needed
If the steps in your gulpfile.js file require authentication with an npm registry:

YAML

Copy
- task: npmAuthenticate@0
  inputs:
    customEndpoint: <Name of npm service connection>

- script: gulp                       # include any additional options that are needed
Add the Publish Test Results task to publish JUnit or xUnit test results to the server.

YAML

Copy
- task: PublishTestResults@2
  inputs:
    testResultsFiles: '**/TEST-RESULTS.xml'
    testRunTitle: 'Test results for JavaScript using gulp'
Add the Publish Code Coverage Results task to publish code coverage results to the server. You can find coverage metrics in the build summary, and you can download HTML reports for further analysis.

YAML

Copy
- task: PublishCodeCoverageResults@1
  inputs: 
    codeCoverageTool: Cobertura
    summaryFileLocation: '$(System.DefaultWorkingDirectory)/**/*coverage.xml'
    reportDirectory: '$(System.DefaultWorkingDirectory)/**/coverage'
Grunt
Grunt is preinstalled on Microsoft-hosted agents. To run the grunt command in the YAML file:

YAML

Copy
- script: grunt                      # include any additional options that are needed
If the steps in your Gruntfile.js file require authentication with a npm registry:

YAML

Copy
- task: npmAuthenticate@0
  inputs:
    customEndpoint: <Name of npm service connection>

- script: grunt                      # include any additional options that are needed
Package and deliver your code
After you have built and tested your app, you can upload the build output to Azure Pipelines, create and publish an npm or Maven package, or package the build output into a .zip file to be deployed to a web application.

Publish files to Azure Pipelines
To simply upload the entire working directory of files, use the Publish Build Artifacts task and add the following to your azure-pipelines.yml file.

YAML

Copy
- task: PublishBuildArtifacts@1
  inputs:
    PathtoPublish: '$(System.DefaultWorkingDirectory)'
To upload a subset of files, first copy the necessary files from the working directory to a staging directory with the Copy Files task, and then use the Publish Build Artifacts task.

YAML

Copy
- task: CopyFiles@2
  inputs:
    SourceFolder: '$(System.DefaultWorkingDirectory)'
    Contents: |
      **\*.js
      package.json
    TargetFolder: '$(Build.ArtifactStagingDirectory)'

- task: PublishBuildArtifacts@1
Publish a module to a npm registry
If your project's output is an npm module for use by other projects and not a web application, use the npm task to publish the module to a local registry or to the public npm registry. You must provide a unique name/version combination each time you publish, so keep this in mind when configuring publishing steps as part of a release or development pipeline.

The first example assumes that you manage version information (such as through an npm version) through changes to your package.json file in version control. This example uses the script task to publish to the public registry.

YAML

Copy
- script: npm publish
The next example publishes to a custom registry defined in your repo's .npmrc file. You'll need to set up an npm service connection to inject authentication credentials into the connection as the build runs.

YAML

Copy
- task: Npm@1
  inputs:
     command: publish
     publishRegistry: useExternalRegistry
     publishEndpoint: https://my.npmregistry.com
The final example publishes the module to an Azure DevOps Services package management feed.

YAML

Copy
- task: Npm@1
  inputs:
     command: publish
     publishRegistry: useFeed
     publishFeed: https://my.npmregistry.com
For more information about versioning and publishing npm packages, see Publish npm packages and How can I version my npm packages as part of the build process?.

Deploy a web app
To create a .zip file archive that is ready for publishing to a web app, use the Archive Files task:

YAML

Copy
- task: ArchiveFiles@2
  inputs:
    rootFolderOrFile: '$(System.DefaultWorkingDirectory)'
    includeRootFolder: false
To publish this archive to a web app, see Azure web app deployment.

Build and push image to container registry
Once your source code is building successfully and your unit tests are in place and successful, you can also build an image and push it to a container registry.


Troubleshooting
If you can build your project on your development machine but are having trouble building it on Azure Pipelines or TFS, explore the following potential causes and corrective actions:

Check that the versions of Node.js and the task runner on your development machine match those on the agent. You can include command-line scripts such as node --version in your pipeline to check what is installed on the agent. Either use the Node Tool Installer (as explained in this guidance) to deploy the same version on the agent, or run npm install commands to update the tools to desired versions.

If your builds fail intermittently while you're restoring packages, either the npm registry is having issues or there are networking problems between the Azure datacenter and the registry. These factors are not under our control, and you might need to explore whether using Azure Artifacts with an npm registry as an upstream source improves the reliability of your builds.

If you're using nvm to manage different versions of Node.js, consider switching to the Node Tool Installer task instead. (nvm is installed for historical reasons on the macOS image.) nvm manages multiple Node.js versions by adding shell aliases and altering PATH, which interacts poorly with the way Azure Pipelines runs each task in a new process.

The Node Tool Installer task handles this model correctly. However, if your work requires the use of nvm, you can add the following script to the beginning of each pipeline:

YAML

Copy
steps:
- bash: |
    NODE_VERSION=12  # or whatever your preferred version is
    npm config delete prefix  # avoid a warning
    . ${NVM_DIR}/nvm.sh
    nvm use ${NODE_VERSION}
    nvm alias default ${NODE_VERSION}
    VERSION_PATH="$(nvm_version_path ${NODE_VERSION})"
    echo "##vso[task.prependPath]$VERSION_PATH"
Then, node and other command-line tools will work for the rest of the pipeline job. In each step where you need to use the nvm command, you'll need to start the script with:

YAML

Copy
- bash: |
    . ${NVM_DIR}/nvm.sh
    nvm <command>
FAQ
Where can I learn more about Azure Artifacts and the Package Management service?
Package Management in Azure Artifacts and TFS

Where can I learn more about tasks?
Build, release, and test tasks

How do I fix a pipeline failure with the message 'FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed - JavaScript heap out of memory'
This happens when the Node.js package has exceeded the memory usage limit. To resolve the issue, add a variable like NODE_OPTIONS and assign it a value of --max_old_space_size=16384.

How can I version my npm packages as part of the build process?
One option is to use a combination of version control and npm version. At the end of a pipeline run, you can update your repo with the new version. In this YAML, there is a GitHub repo and the package gets deployed to npmjs. Note that your build will fail if there is a mismatch between your package version on npmjs and your package.json file.

YAML

Copy
variables:
    MAP_NPMTOKEN: $(NPMTOKEN) # Mapping secret var

trigger:
- none

pool:
  vmImage: 'ubuntu-latest'

steps: # Checking out connected repo
- checkout: self
  persistCredentials: true
  clean: true
    
- task: npmAuthenticate@0
  inputs:
    workingFile: .npmrc
    customEndpoint: 'my-npm-connection'
    
- task: NodeTool@0
  inputs:
    versionSpec: '12.x'
  displayName: 'Install Node.js'

- script: |
    npm install
  displayName: 'npm install'

- script: |
    npm pack
  displayName: 'Package for release'

- bash: | # Grab the package version
    v=`node -p "const p = require('./package.json'); p.version;"`
    echo "##vso[task.setvariable variable=packageVersion]$v"

- task: CopyFiles@2
  inputs:
      contents: '*.tgz'
      targetFolder: $(Build.ArtifactStagingDirectory)/npm
  displayName: 'Copy archives to artifacts staging directory'

- task: CopyFiles@2
  inputs:
    sourceFolder: '$(Build.SourcesDirectory)'
    contents: 'package.json' 
    targetFolder: $(Build.ArtifactStagingDirectory)/npm
  displayName: 'Copy package.json'

- task: PublishBuildArtifacts@1 
  inputs:
    PathtoPublish: '$(Build.ArtifactStagingDirectory)/npm'
    artifactName: npm
  displayName: 'Publish npm artifact'

- script: |  # Config can be set in .npmrc
    npm config set //registry.npmjs.org/:_authToken=$(MAP_NPMTOKEN) 
    npm config set scope "@myscope"
    # npm config list
    # npm --version
    npm version patch --force
    npm publish --access public

- task: CmdLine@2 # Push changes to GitHub (substitute your repo)
  inputs:
    script: |
      git config --global user.email "username@contoso.com"
      git config --global user.name "Azure Pipeline"
      git add package.json
      git commit -a -m "Test Commit from Azure DevOps"
      git push -u origin HEAD:main
