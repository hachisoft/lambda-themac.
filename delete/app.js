require('gnode');
exports.handler = function (event, context) {
    console.log('started delete:app.js');

    var notify = require('./delete.js');
    notify.handler(event, context);

};
