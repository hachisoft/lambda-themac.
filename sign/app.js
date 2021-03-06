﻿var crypto = require('crypto');
var config = require('./config.js');

console.log('Loading Sign');

exports.handler = function (params, context) {
    var stage = params.stage || 'dev';
    
    if (config.verbose) {
        console.log(config);
        console.log('stage:' + stage);
        if (params != null) {
            console.log('params = ' + JSON.stringify(params));
        }
        else {
            console.log('No params object');
        }
    }
    var acl = "public-read";
    var bucket = '';
    var secret = '';
    var key = '';
    var contentType = params.type || 'image/png';
    var contentDisposition = params.contentDisposition || '';
    
    var templateBucket = '';
    if (stage === 'v0') {

        bucket = config.prodContentBucket;
        secret = config.prodS3Secret;
        firebaseUrl = config.prodFirebaseUrl;
        fromAddress = config.prodFromAddress;
        key = "AKIAIO73W65TDFYUPSLQ";
    }
    else if (stage === 'v0_2') {
        bucket = config.prod2ContentBucket;
        secret = config.prod2S3Secret;
        firebaseUrl = config.prod2FirebaseUrl;
        fromAddress = config.prodFromAddress;
        key = "AKIAIO73W65TDFYUPSLQ";
    }
    else {
        bucket = config.devContentBucket;
        secret = config.devS3Secret;
        firebaseUrl = config.devFirebaseUrl;
        fromAddress = config.fromAddress;
        key = "AKIAJJWTOTVFHP2VKYVQ"; 
    }
    
    var bucketPrefix = '';
    if (params.bucketPrefix) {
        bucketPrefix = params.bucketPrefix;
        if (bucketPrefix.indexOf('/', params.bucketPrefix.length - 1) === -1) {
            bucketPrefix += '/';
        }
    }
    var endpoint = "https://s3-us-west-2.amazonaws.com/" + bucket;
    
    if (config.verbose) {
        console.log(bucket);
        console.log(bucketPrefix);
        console.log(endpoint);
    }

    var expires = new Date(Date.now() + 120000);
    
    var policy = {
        expiration: expires,
        conditions: [
            { bucket: bucket },
            { acl: acl },
            { expires: expires },
            { success_action_status: '201' },
            ['starts-with', '$key', bucketPrefix],
            ['starts-with', '$Content-Type', ''],
            ['starts-with', '$Cache-Control', ''],
            ['starts-with', '$Content-Disposition', ''],
            ['content-length-range', 0, 524288000]
        ]
    };
    
    var stringPolicy = JSON.stringify(policy);
    var base64Policy = Buffer(stringPolicy, "utf-8").toString("base64");
    var uniqueId = '_' + Math.random().toString(36).substr(2, 16);
    var signature = crypto.createHmac("sha1", secret).update(new Buffer(base64Policy, "utf-8")).digest("base64");
    var response = {
        'acl': 'public-read',
        'endpoint': endpoint,
        'awsaccesskeyid': key,
        'bucket': bucket,
        'Cache-Control': 'max-age=630720000, public',
        'Content-Type': contentType,
        'Content-Disposition': contentDisposition,
        'expires': expires,
        'key': bucketPrefix + uniqueId,
        'policy': base64Policy,
        'signature': signature,
        'success_action_status': '201'
    };

    context.succeed(response);  // SUCCESS with message
};
