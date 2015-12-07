var fs = require('fs');
var request = require('request');

var http = require('http');
var https = require('https');
var fs = require('fs');

var url = require('url');

var download = function (_url, dest, cb) {
    var file = fs.createWriteStream(dest);
    var options = url.parse(_url);
    if (options.protocol === 'https:') {
        var request = https.get(_url, function (response) {
            response.pipe(file);
            file.on('finish', function () {
                file.close(cb);  // close() is async, call cb after close completes.
            });
        }).on('error', function (err) { // Handle errors
            fs.unlink(dest); // Delete the file async. (But we don't check the result)
            if (cb) cb(err.message);
        });
    }
    else {
        var request = http.get(_url, function (response) {
            response.pipe(file);
            file.on('finish', function () {
                file.close(cb);  // close() is async, call cb after close completes.
            });
        }).on('error', function (err) { // Handle errors
            fs.unlink(dest); // Delete the file async. (But we don't check the result)
            if (cb) cb(err.message);
        });
    }
};

module.exports = download;