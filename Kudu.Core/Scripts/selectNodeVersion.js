var path = require('path'),
    fs = require('fs'),
    semver = require('./semver.js');

var existsSync = fs.existsSync || path.existsSync;

function flushAndExit(code) {
    var exiting;
    process.on('exit', function () {
        if (exiting) {
            return;
        }
        exiting = true;
        process.exit(code);
    });
}

function resolveNpmPath(npmRootPath, npmVersion) {
    if (!npmVersion) {
        return;
    }

    var npmPath = path.resolve(npmRootPath, npmVersion, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (!existsSync(npmPath)) {
        // Try resolving it using the old npm layout
        npmPath = path.resolve(npmRootPath, npmVersion, 'bin', 'npm-cli.js');
        if (!existsSync(npmPath)) {
            throw new Error('Unable to locate npm version ' + npmVersion);
        }
    }

    return npmPath;
}


function getDefaultNpmVersion(nodeVersionPath) {
    var npmLinkPath = path.resolve(nodeVersionPath, 'npm.txt');
    // Determine if there's a link to npm at the node path
    if (!existsSync(npmLinkPath)) {
        return;
    }
    var npmVersion = fs.readFileSync(npmLinkPath, 'utf8').trim();
    return npmVersion;
}

function getNpmVersionFromJson(npmRootPath, json) {
    if (typeof json.engines.npm !== 'string') {
        return;
    }

    var versions = [];
    fs.readdirSync(npmRootPath).forEach(function (dir) {
        versions.push(dir);
    });

    var npmVersion = semver.maxSatisfying(versions, json.engines.npm);
    if (!npmVersion) {
        var errorMsg = 'No available npm version matches application\'s version constraint of \''
                        + json.engines.npm + '\'. Use package.json to choose one of the following versions: '
                        + versions.join(', ') + '.';
        throw new Error(errorMsg);
    }
    return npmVersion;
}

function saveNodePaths(tempDir, nodeExePath, npmPath) {
    if (!tempDir) {
        return;
    }
    var nodeTmpFile = path.resolve(tempDir, '__nodeVersion.tmp'),
        npmTempFile = path.resolve(tempDir, '__npmVersion.tmp');

    fs.writeFileSync(nodeTmpFile, nodeExePath);
    if (npmPath) {
        fs.writeFileSync(npmTempFile, npmPath);
    }
}

function getNodeStartFile(sitePath) {
    var nodeStartFiles = ['server.js', 'app.js'];

    for (var i = 0; i < nodeStartFiles.length; i++) {
        var nodeStartFilePath = path.join(sitePath, nodeStartFiles[i]);
        if (existsSync(nodeStartFilePath)) {
            return nodeStartFiles[i];
        }
    }

    return null;
}

// Determine the installation location of node.js and iisnode
var programFilesDir = process.env['programfiles(x86)'] || process.env.programfiles,
    nodejsDir = path.resolve(programFilesDir, 'nodejs'),
    npmRootPath = path.resolve(programFilesDir, 'npm');

if (!existsSync(nodejsDir)) {
    throw new Error('Unable to locate node.js installation directory at ' + nodejsDir);
}

var interceptorJs = path.resolve(process.env['programfiles(x86)'], 'iisnode', 'interceptor.js');
if (!existsSync(interceptorJs)) {
    interceptorJs = path.resolve(process.env.programfiles, 'iisnode', 'interceptor.js');
    if (!existsSync(interceptorJs)) {
        throw new Error('Unable to locate iisnode installation directory with interceptor.js file');
    }
}

// Validate input parameters

var repo = process.argv[2];
var wwwroot = process.argv[3];
var tempDir = process.argv[4];
if (!existsSync(wwwroot) || !existsSync(repo) || (tempDir && !existsSync(tempDir))) {
    throw new Error('Usage: node.exe selectNodeVersion.js <path_to_repo> <path_to_wwwroot> [path_to_temp]');
}

var packageJson = path.resolve(repo, 'package.json'),
    json = existsSync(packageJson) && JSON.parse(fs.readFileSync(packageJson, 'utf8'));

// If the web.config file does not exit in the repo, use a default one that is specific for node on IIS in Azure, 
// and generate it in 'wwwroot'
(function createIisNodeWebConfigIfNeeded() {
    var webConfigRepoPath = path.join(repo, 'web.config'),
        webConfigWwwRootPath = path.join(wwwroot, 'web.config'),
        nodeStartFilePath;

    if (!existsSync(webConfigRepoPath)) {
        if (typeof json !== 'object' || typeof json.scripts !== 'object' || typeof json.scripts.start !== 'string') {
            nodeStartFilePath = getNodeStartFile(repo);
            if (!nodeStartFilePath) {
                console.log('Missing server.js/app.js files, web.config is not generated');
                return;
            }
            console.log('Using start-up script ' + nodeStartFilePath + ' found under site root.');
        } else {
            var startupCommand = json.scripts.start;
            var defaultNode = "node ";
            if (startupCommand.length <= defaultNode.length || startupCommand.slice(0, defaultNode.length) !== defaultNode) {
                console.log('Invalid start-up command in package.json. Please use the format "node <script path>".');
                console.log('web.config is not generated');
                return;
            }
            nodeStartFilePath = startupCommand.slice(defaultNode.length);
            // For iisnode handler
            if (nodeStartFilePath.slice(0, 2) === "./") {
                nodeStartFilePath = nodeStartFilePath.slice(2);
            }
            console.log('Using start-up script ' + nodeStartFilePath + ' specified in package.json.');
        }

        var iisNodeConfigTemplatePath = path.join(__dirname, 'iisnode.config.template');
        var webConfigContent = fs.readFileSync(iisNodeConfigTemplatePath, 'utf8');
        webConfigContent = webConfigContent.replace(/\{NodeStartFile\}/g, nodeStartFilePath);

        //<remove segment='bin'/>
        //<remove segment='www'/>
        var segments = nodeStartFilePath.split("/");
        var removeHiddenSegment = "";
        segments.forEach(function(segment) {
            removeHiddenSegment += "<remove segment='" + segment + "'/>";
        });
        webConfigContent = webConfigContent.replace(/\{REMOVE_HIDDEN_SEGMENT\}/g, removeHiddenSegment);

        fs.writeFileSync(webConfigWwwRootPath, webConfigContent, 'utf8');

        console.log('Generated web.config.');
    }
})();


// If the iinode.yml file does not exit in the repo but exists in wwwroot, remove it from wwwroot 
// to prevent side-effects of previous deployments
var iisnodeYml = path.resolve(repo, 'iisnode.yml');
var wwwrootIisnodeYml = path.resolve(wwwroot, 'iisnode.yml');
if (!existsSync(iisnodeYml) && existsSync(wwwrootIisnodeYml)) {
    fs.unlinkSync(wwwrootIisnodeYml);
}

try {
    var nodeVersion = process.env.WEBSITE_NODE_DEFAULT_VERSION || process.versions.node,
        npmVersion = null,
        yml = existsSync(iisnodeYml) ? fs.readFileSync(iisnodeYml, 'utf8') : '',
        shouldUpdateIisNodeYml = false;

    if (yml.match(/^ *nodeProcessCommandLine *:/m)) {
        // If the iisnode.yml included with the application explicitly specifies the
        // nodeProcessCommandLine, exit this script. The presence of nodeProcessCommandLine
        // deactivates automatic version selection.

        console.log('The iisnode.yml file explicitly sets nodeProcessCommandLine. ' +
                    'Automatic node.js version selection is turned off.');
    } else {
        // If the package.json file is not included with the application 
        // or if it does not specify node.js version constraints, use WEBSITE_NODE_DEFAULT_VERSION. 
        if (typeof json !== 'object' || typeof json.engines !== 'object' || typeof json.engines.node !== 'string') {
            // Attempt to read the pinned node version or fallback to the version of the executing node.exe.
            console.log('The package.json file does not specify node.js engine version constraints.');
            console.log('The node.js application will run with the default node.js version '
                + nodeVersion + '.');
        } else {
            // Determine the set of node.js versions available on the platform
            var versions = [];
            fs.readdirSync(nodejsDir).forEach(function (dir) {
                if (dir.match(/^\d+\.\d+\.\d+$/) && existsSync(path.resolve(nodejsDir, dir, 'node.exe'))) {
                    versions.push(dir);
                }
            });

            console.log('Node.js versions available on the platform are: ' + versions.sort(semver.compare).join(', ') + '.');

            // Calculate actual node.js version to use for the application as the maximum available version
            // that satisfies the version constraints from package.json.
            nodeVersion = semver.maxSatisfying(versions, json.engines.node);
            if (!nodeVersion) {
                throw new Error('No available node.js version matches application\'s version constraint of \''
                    + json.engines.node + '\'. Use package.json to choose one of the available versions.');
            }

            console.log('Selected node.js version ' + nodeVersion + '. Use package.json file to choose a different version.');
            npmVersion = getNpmVersionFromJson(npmRootPath, json);
            shouldUpdateIisNodeYml = true;
        }
    }
    
    var nodeVersionPath = path.resolve(nodejsDir, nodeVersion),
        nodeExePath = path.resolve(nodeVersionPath, 'node.exe'),
        npmPath = resolveNpmPath(npmRootPath, npmVersion || getDefaultNpmVersion(nodeVersionPath));

    // Save the node version in a temporary path for kudu service usage
    saveNodePaths(tempDir, nodeExePath, npmPath);

    if (shouldUpdateIisNodeYml) {
        // Save the version information to iisnode.yml in the wwwroot directory

        if (yml !== '') {
            yml += '\r\n';
        }

        yml += 'nodeProcessCommandLine: "' + nodeExePath + '"';
        fs.writeFileSync(wwwrootIisnodeYml, yml);
    }

} catch (ex) {
    console.error(ex.message);
    flushAndExit(-1);
}
