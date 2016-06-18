var request = require('request');
var async = require('async');
var btoa = require('btoa');
var acorn = require('acorn');
var fs = require('fs');
var credentials = require('./credentials.json');

var githubCredentials = btoa(credentials.githubUser + ':' + credentials.githubPassword);


function fetchLoop(modules, fetchFunc, doneFunc) {
    var modulesCounter = 0;
    async.whilst(
        function() {
            return modulesCounter < modules.length;
        },
        function(next) {
            var module = modules[modulesCounter];
            fetchFunc(module, next);
            modulesCounter += 1;
        },
        function(error, results) {
            if (error) {
                callback(error);
            }
            doneFunc(results);
        }
    );
}

function getNonEmptyModules(callback, page) {
    page = page | 0;

    request({
            url: 'https://api.github.com/users/d3/repos?page=' + page,
            json: true,
            headers: {
                'Authorization': 'Basic ' + githubCredentials,
                'User-Agent': credentials.githubUser
            }
        },
        function(error, response) {
            if (error) {
                callback(error);
                return;
            }

            var json = response.toJSON();

            var nextPage = json.headers.link.match(/page=(.*)>; rel="next"/) || false;
            if (nextPage) {
                nextPage = nextPage[1];
            }

            var modules = json.body.map(function(d, i) {
                return d.full_name;
            });

            fetchLoop(modules, getRepo, function(results) {
                var validModules = results
                    .filter(function(d) {
                        return d.size > 0;
                    })
                    .map(function(d, i) {
                        return d.full_name;
                    });
                if (nextPage) {
                    getNonEmptyModules(callback, nextPage);
                } else {
                    callback(null, validModules);
                }
            });
        }
    );
}

var repos = [];

function getRepo(module, cb) {
    console.log('fetching repo', module);
    request({
            url: 'https://api.github.com/repos/' + module,
            json: true,
            headers: {
                'Authorization': 'Basic ' + githubCredentials,
                'User-Agent': credentials.githubUser
            }
        },
        function(error, json) {
            repos.push(json.body)
            cb(error, repos)
        }
    );
}

function getModulesWithValidPackage(modules, callback) {
    fetchLoop(modules, getContent, function(results) {
        var validModules = [];
        results.forEach(function(d, i) {
            var hasPackageFile = d.filter(function(dB) {
                return dB.name === 'package.json' || dB.name === 'index.js';
            }).length > 1;
            if (hasPackageFile) {
                validModules.push(modules[i]);
            }
        });

        callback(null, validModules);
    });
}

var contents = [];

function getContent(module, cb) {
    console.log('fetching content', module);
    request({
            url: 'https://api.github.com/repos/' + module + '/contents',
            json: true,
            headers: {
                'Accept': 'application/vnd.github.v3.raw',
                'Authorization': 'Basic ' + githubCredentials,
                'User-Agent': credentials.githubUser
            }
        },
        function(error, json) {
            contents.push(json.body)
            cb(error, contents)
        }
    );
}

function getPackageFiles(modules, callback) {
    fetchLoop(modules, getPackage, function(results) {
        results.forEach(function(d, i) {
            dependencies[d.name] = {
                dependencies: d.dependencies ? Object.keys(d.dependencies) : null,
                description: d.description
            };
        });

        callback(null, modules);
    });
}

var packages = [];

function getPackage(module, cb) {
    console.log('fetching package.json', module);
    request({
            url: 'https://api.github.com/repos/' + module + '/contents/package.json',
            json: true,
            headers: {
                'Accept': 'application/vnd.github.v3.raw',
                'Authorization': 'Basic ' + githubCredentials,
                'User-Agent': credentials.githubUser
            }
        },
        function(error, json) {
            packages.push(json.body)
            cb(error, packages)
        }
    );
}


function getIndexFiles(modules, callback) {
    fetchLoop(modules, getIndex, function(results) {
        var resultFiltered = [];
        results.forEach(function(d, i) {
            resultFiltered.push({
                name: modules[i],
                content: d
            })
        });
        callback(null, resultFiltered);
    });
}

var indexes = [];

function getIndex(module, cb) {
    console.log('fetching index.js', module);
    request({
            url: 'https://api.github.com/repos/' + module + '/contents/index.js',
            json: true,
            headers: {
                'Accept': 'application/vnd.github.v3.raw',
                'Authorization': 'Basic ' + githubCredentials,
                'User-Agent': credentials.githubUser
            }
        },
        function(error, json) {
            indexes.push(json.body)
            cb(error, indexes)
        }
    );
}


function getSubModules(modules, callback) {
    console.log('Extracting dependencies');
    var exportedSubmodules = {};
    modules.forEach(function(d) {
        "use strict"
        var str = d.content;
        var ast = acorn.parse(str, {
            ecmaVersion: 6,
            sourceType: 'module'
        });

        var exportedNames = [];

        visitAllNodes(ast, function(node) {
            if (node.type === 'ExportSpecifier') {
                exportedNames.push(node.exported.name);
            }
        });

        function visitAllNodes(topNode, handler) {
            var visited = [];
            visit(topNode);

            function visit(node) {
                if (visited.indexOf(node) >= 0) {
                    return;
                }
                visited.push(node);
                handler(node);

                for (var key in node) {
                    if (node.hasOwnProperty(key)) {
                        var value = node[key];
                        if (value instanceof acorn.Node) {
                            visit(value);
                        } else if (Array.isArray(value) && value.length && value[0] instanceof acorn.Node) {
                            for (var i = 0; i < value.length; i++) {
                                visit(value[i]);
                            }
                        }
                    }
                }
            }
        }

        exportedSubmodules[d.name.slice(3)] = exportedNames;
    });

    for (var submodule in exportedSubmodules) {
        dependencies[submodule]['exported'] = exportedSubmodules[submodule];
    }

    callback(null, dependencies);
}

var dependencies = {};

async.waterfall([
    getNonEmptyModules,
    getModulesWithValidPackage,
    getPackageFiles,
    getIndexFiles,
    getSubModules
], function(err, result) {
    console.log('Writing file');
    fs.writeFile("d3-dependencies.json", JSON.stringify(result, null, 4), function(err) {
        if (err) {
            return console.log(err);
        }
        console.log('All done');
    });
});
