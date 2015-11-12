var thunkify = require('thunkify');
var aws = require('aws-sdk');

/*
 * Expose `Client`
 */

module.exports = Client;

/*
 * AWS S3 client.
 *
 * @param {Object} [opts]
 * @return {Object}
 * @api public
 */

function Client(opts) {
    return wrap(new aws.S3(opts));
}

/*
 * Wrap `obj`
 */

function wrap(obj) {
    Object.keys(obj.__proto__).forEach(function (key) {
        if ('function' != typeof obj.__proto__[key]) return;
        obj[key] = thunkify(obj[key]);
    });
    return obj;
}