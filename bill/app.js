require('gnode');
exports.handler = function (event, context) {
    console.log('started app.js');

    var bill = require('./bill.js');
    bill.handler(event, context);
};
