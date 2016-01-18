require('gnode');
exports.handler = function (event, context) {
    console.log('started app.js');

    var confirm = require('./bill.js');
    confirm.handler(event, context);
};
