require('gnode');
exports.handler = function (event, context) {
    console.log('started notify:app.js');

    var notify = require('./delete.js');
    notify.handler(event, context);

};
