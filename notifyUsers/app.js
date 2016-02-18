require('gnode');
exports.handler = function (event, context) {
    console.log('started notifyUsers:app.js');

    var notify = require('./notifyUsers.js');
    notify.handler(event, context);

   /* var spawn = require("child_process").spawn;
    var child = spawn('node', ["--harmony", "driver.js"], {
        cwd: __dirname,
        stdio: ['pipe', process.stdout, process.stderr]
    });
    
    child.on('exit', function (code) {
        if (code !== 0) {
            return context.done(new Error("Process exited with non-zero status code"));
        }
        context.done(null);
    });
    child.on('error', function (err) {
        console.log('Failed to start child process.');
    });
    
    child.stdio[0].write(JSON.stringify(event));*/
};
